/**
 * Git sync loop (round 3): auto-commit on a quiet period after write-backs,
 * manual sync (POST /api/spaces/:space/sync), periodic background fetch,
 * conflict detection, and page history/restore. All mutating git ops run
 * under the space's Redis advisory lock (server/db/redis.ts) — a killed
 * process can't leave the lock stuck since it's a TTL'd key, not a local
 * file lock.
 *
 * Author attribution: DEV-PLAN wants the commit's --author to be "whoever
 * edited in this window, last editor if mixed, others as Co-authored-by".
 * Collab write-backs are debounced/async and not tied 1:1 to an HTTP
 * request, so exact per-edit attribution isn't observable here — this
 * module tracks the most recent identified editor per space (recordEditor,
 * called from routes.ts wherever a request's session user is doing a
 * write) and uses THAT as --author, falling back to Folio's own identity
 * when nothing was recorded (a system-driven change, or the very first
 * commit). Full multi-editor Co-authored-by trailers are not implemented —
 * documented simplification, not silently dropped.
 */
import path from 'node:path';
import { query } from './db/pool.js';
import { withSpaceLock } from './db/redis.js';
import * as storageMod from './storage.js';
import * as git from './git.js';
import { GitError, type GitIdentity } from './git.js';
import { ensureAskpassScript, hasSpaceToken } from './gitCredentials.js';
import { badRequest, notFound } from './errors.js';
import type { PageAtShaResponse, PageHistoryEntry, SpaceGitConflict } from '../shared/contracts.js';
// Circular import with collab.ts, which itself imports `* as gitSync from
// './gitSync.js'` (for noteActivity). Safe here because every use below is
// inside a function body, called long after both modules have finished
// loading — never at this module's own top level.
import * as collab from './collab.js';

const FOLIO_IDENTITY: GitIdentity = { name: 'Folio', email: 'folio@instance' };
const QUIET_PERIOD_MS = 90_000;
const FETCH_INTERVAL_MS = 3 * 60_000;

// --- last-known editor per space (best-effort commit author) -------------

const lastEditor = new Map<string, GitIdentity>();

export function recordEditor(space: string, identity: GitIdentity): void {
  lastEditor.set(space, identity);
}
/** Best-effort commit author for a space: the last known editor, else the instance identity. */
export function authorFor(space: string): GitIdentity {
  return lastEditor.get(space) ?? FOLIO_IDENTITY;
}

// --- quiet-period auto-commit --------------------------------------------

const quietTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Called after every write-back (collab debounce flush, direct PUT, structural mutation). Resets the space's ~90s quiet timer. */
export function noteActivity(space: string): void {
  const existing = quietTimers.get(space);
  if (existing) clearTimeout(existing);
  quietTimers.set(
    space,
    setTimeout(() => {
      quietTimers.delete(space);
      performSync(space).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[git-sync] auto-commit failed for "${space}":`, err);
      });
    }, QUIET_PERIOD_MS),
  );
}

/** Cancels every pending quiet timer and runs its sync immediately — used on graceful shutdown so a killed process doesn't lose an in-flight edit's commit. */
export async function flushAllPendingSyncs(): Promise<void> {
  const spaces = [...quietTimers.keys()];
  for (const space of spaces) {
    const t = quietTimers.get(space);
    if (t) clearTimeout(t);
    quietTimers.delete(space);
  }
  await Promise.all(spaces.map((space) => performSync(space).catch(() => {})));
}

// --- core sync -------------------------------------------------------------

async function setSpaceStatus(
  space: string,
  fields: { status: string; lastSyncAt?: boolean; lastError?: string | null },
  actor: GitIdentity,
): Promise<void> {
  await query(
    `UPDATE spaces
        SET status = $2,
            last_sync_at = CASE WHEN $6 THEN now() ELSE last_sync_at END,
            last_sync_by_name = CASE WHEN $6 THEN $4 ELSE last_sync_by_name END,
            last_sync_by_email = CASE WHEN $6 THEN $5 ELSE last_sync_by_email END,
            last_error = $3
      WHERE slug = $1`,
    [space, fields.status, fields.lastError ?? null, actor.name, actor.email, Boolean(fields.lastSyncAt)],
  );
}

export interface SyncResult {
  status: string;
  ahead: number;
  behind: number;
  lastError: string | null;
}

/**
 * Commit any local changes, then (if a remote is configured) fetch, merge
 * (not rebase), push, and refresh ahead/behind. Never throws for an
 * ordinary git failure (network down, diverged history it can't fast
 * merge, etc.) — it's recorded as status='error'/lastError and returned;
 * callers (the sync route) surface that in the response body.
 */
export async function performSync(space: string, requestedBy?: GitIdentity): Promise<SyncResult> {
  return withSpaceLock(space, async () => {
    const actor = requestedBy ?? authorFor(space);
    const dir = storageMod.getRepoDir(space);
    const branch = await storageMod.getSpaceInfo(space).then((s) => s?.git?.branch ?? 'main');

    await setSpaceStatus(space, { status: 'syncing' }, actor);
    try {
      // Open rooms first: whatever they still hold unwritten goes into this
      // commit, so git merges it with the remote (three-way, on files) rather
      // than the room writing it over the merge result later. See
      // reconcileMergedRooms for the other half.
      const roomBases = await collab.settleRoomsForSync(space);
      await git.commitAll(dir, 'folio:update', actor);

      const remote = await git.hasRemote(dir);
      if (remote) {
        const askpass = (await hasSpaceToken(space)) ? await ensureAskpassScript() : undefined;
        await git.fetch(dir, askpass, space);
        const preMerge = await git.headSha(dir);
        const { conflict } = await git.mergeFetchedRemote(dir, branch, askpass, space);
        if (conflict) {
          await git.commitConflictState(dir);
          await storageMod.scanSpace(space);
          await reconcileMergedRooms(space, dir, preMerge, roomBases, askpass);
          await setSpaceStatus(space, { status: 'conflict', lastSyncAt: true, lastError: 'merge produced conflict markers' }, actor);
          const ab = await git.aheadBehind(dir, branch);
          return { status: 'conflict', ahead: ab.ahead, behind: ab.behind, lastError: 'merge produced conflict markers' };
        }
        await storageMod.scanSpace(space);
        await reconcileMergedRooms(space, dir, preMerge, roomBases, askpass);

        // Whole-tree check (listConflictedFiles), not the rootPath-scoped
        // hasConflictMarkers(dir, rootPath) this used to call: a conflict
        // left in a file OUTSIDE this space's own rootPath — reachable
        // whenever multiple spaces share one repo — used to read as clean
        // here and get pushed straight past the conflict.
        // Only markers this clone would ADD to the remote block the push. A
        // file that already carries them identically on origin (pushed
        // earlier, e.g. by another space on a shared repo) can't be fixed by
        // not pushing, and would otherwise lock every space on that repo in
        // `conflict` for good — "Take the version from Git" included.
        const conflicted = await git.listConflictedFiles(dir);
        const differing = conflicted.length > 0 ? new Set(await git.filesDifferingFromRemote(dir, branch, askpass, space)) : new Set<string>();
        const stillConflicted = conflicted.some((p) => differing.has(p));
        if (!stillConflicted) {
          await git.push(dir, branch, askpass, space);
        }
        const ab = await git.aheadBehind(dir, branch);
        const status = stillConflicted ? 'conflict' : ab.ahead > 0 ? 'ahead' : ab.behind > 0 ? 'behind' : 'clean';
        await setSpaceStatus(space, { status, lastSyncAt: true, lastError: stillConflicted ? 'unresolved conflict markers remain in *.md' : null }, actor);
        return { status, ahead: ab.ahead, behind: ab.behind, lastError: stillConflicted ? 'unresolved conflict markers remain in *.md' : null };
      }

      await setSpaceStatus(space, { status: 'local', lastSyncAt: true, lastError: null }, actor);
      return { status: 'local', ahead: 0, behind: 0, lastError: null };
    } catch (err) {
      const message = err instanceof GitError ? err.message : err instanceof Error ? err.message : String(err);
      await setSpaceStatus(space, { status: 'error', lastSyncAt: true, lastError: message }, actor);
      return { status: 'error', ahead: 0, behind: 0, lastError: message };
    }
  });
}

/**
 * The other half of performSync's room handling (01.10.2026): a merge rewrites
 * files on disk, outside any Y.Doc, and an open room would otherwise keep the
 * pre-merge content and write it straight back. Every open room of `space`
 * whose file the merge changed (preMerge..HEAD) gets the merged file through
 * collab.reconcileLiveRoomAfterMerge. Runs after scanSpace, so a page the remote
 * renamed is found under its new path. Content comes from the merge commit, not
 * the working tree: a room write that slipped in right after the merge cannot
 * pass for the merge result, and the reconcile's own write repairs the file.
 */
async function reconcileMergedRooms(
  space: string,
  dir: string,
  preMerge: string,
  roomBases: Map<string, Uint8Array>,
  askpass: string | undefined,
): Promise<void> {
  const live = collab.liveRoomIds();
  if (live.length === 0) return;
  const changed = new Set(await git.filesChangedBetween(dir, preMerge, 'HEAD', askpass, space));
  if (changed.size === 0) return;
  const rootPath = storageMod.getRootPath(space);
  for (const id of live) {
    const entry = await storageMod.getEntry(id);
    if (!entry || entry.space !== space) continue;
    const repoRelPath = rootPath ? `${rootPath}/${entry.relPath}` : entry.relPath;
    if (!changed.has(repoRelPath)) continue;
    try {
      const merged = await git.showFileAt(dir, 'HEAD', repoRelPath, askpass, space);
      collab.reconcileLiveRoomAfterMerge(entry, merged, roomBases.get(id));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[git-sync] failed to bring live room ${id} up to the merge in "${space}":`, err);
    }
  }
}

/**
 * Commits whatever's on disk right now under `space` with a caller-chosen
 * message, under the space's own lock — used by structural operations
 * (round 22: slug rename) that want their own dedicated, immediately-visible
 * commit rather than folding into a later generic 'folio: update' from the
 * quiet-period auto-commit. Deliberately never pushes: pushing stays the
 * job of the next debounced/manual sync, exactly like every other mutation
 * in this app (move/rename/delete/PUT all just commit-eventually too) —
 * this only changes WHEN and with WHAT MESSAGE the local commit happens,
 * not the push cadence. Returns whether a commit was actually made (false
 * if there was nothing to commit).
 */
export async function commitNow(space: string, message: string, author: GitIdentity): Promise<boolean> {
  return withSpaceLock(space, () => git.commitAll(storageMod.getRepoDir(space), message, author));
}

// --- reset-to-remote ("Take the version from Git") -------------------------

export interface ResetToRemoteResult {
  status: string;
  ahead: number;
  behind: number;
  lastError: string | null;
  backupRef: string | null;
  changedCount: number;
}

/**
 * Maps a repo-root-relative path (as git.resetToRemote's `changed` and
 * git.listConflictedFiles both report) to the page it belongs to, or null
 * when the path falls outside this space's own rootPath. Shared by
 * resetSpaceToRemote (mapping changed files -> pages to invalidate) and
 * getSpaceConflicts (mapping conflicted files -> pages to surface in the
 * UI), so the two can't drift on how the prefix strip is done.
 */
function relPathUnderRoot(rootPath: string, repoRelPath: string): string | null {
  if (!rootPath) return repoRelPath;
  const prefix = `${rootPath}/`;
  return repoRelPath.startsWith(prefix) ? repoRelPath.slice(prefix.length) : null;
}

/**
 * "Take the version from Git" (owner ask: nobody is ever going to resolve a
 * git-native space's conflicts by hand) — throws away everything local for
 * `space` and makes it match `origin/<branch>` exactly. Mirrors performSync's
 * own shape (withSpaceLock, askpass wiring, setSpaceStatus bracketing the
 * work) but calls git.resetToRemote instead of
 * mergeFetchedRemote/commitConflictState.
 *
 * Live collab: every page whose file the reset just rewrote gets
 * collab.reconcileLiveRoomsAfterReset run on it — see that function's own doc
 * comment for the full explanation — BEFORE storage.scanSpace runs, using
 * the PRE-reset pages_index (via getEntryIdByExactPath) to resolve each
 * changed repo-relative path to a page id, since scanSpace is about to
 * replace that index with whatever the reset just put on disk.
 */
export async function resetSpaceToRemote(space: string, requestedBy?: GitIdentity): Promise<ResetToRemoteResult> {
  return withSpaceLock(space, async () => {
    const actor = requestedBy ?? authorFor(space);
    const dir = storageMod.getRepoDir(space);
    const rootPath = storageMod.getRootPath(space);
    const branch = await storageMod.getSpaceInfo(space).then((s) => s?.git?.branch ?? 'main');

    if (!(await git.hasRemote(dir))) {
      throw badRequest('space has no git remote configured');
    }

    await setSpaceStatus(space, { status: 'syncing' }, actor);
    try {
      const askpass = (await hasSpaceToken(space)) ? await ensureAskpassScript() : undefined;
      // Land every pending editor write on disk FIRST: it then goes into the
      // backup branch instead of being written over the reset file afterwards.
      await collab.flushAll();
      const { backupRef, changed } = await git.resetToRemote(dir, branch, askpass, space);

      const affectedPageIds: string[] = [];
      for (const repoRelPath of changed) {
        const relPath = relPathUnderRoot(rootPath, repoRelPath);
        if (relPath === null) continue; // outside this space's rootPath — not one of its pages
        const id = await storageMod.getEntryIdByExactPath(space, relPath);
        if (id) affectedPageIds.push(id);
      }
      if (affectedPageIds.length > 0) {
        await collab.reconcileLiveRoomsAfterReset(affectedPageIds);
      }

      await storageMod.scanSpace(space);

      const ab = await git.aheadBehind(dir, branch);
      await setSpaceStatus(space, { status: 'clean', lastSyncAt: true, lastError: null }, actor);
      return { status: 'clean', ahead: ab.ahead, behind: ab.behind, lastError: null, backupRef, changedCount: changed.length };
    } catch (err) {
      const message = err instanceof GitError ? err.message : err instanceof Error ? err.message : String(err);
      await setSpaceStatus(space, { status: 'error', lastSyncAt: true, lastError: message }, actor);
      return { status: 'error', ahead: 0, behind: 0, lastError: message, backupRef: null, changedCount: 0 };
    }
  });
}

/**
 * Every file `space`'s clone currently has unresolved git conflict markers
 * in, across the WHOLE working tree, each mapped to its page (id + title)
 * when the path falls under `space`'s own rootPath and resolves to an
 * indexed page — path-only otherwise (outside rootPath, e.g. a shared repo's
 * conflict in another space's folder, or a path this space's index doesn't
 * know, e.g. one the conflicted merge itself created).
 *
 * Deliberately left for the CALLER to gate on `status === 'conflict'`
 * (routes.ts does, on every response type that carries SpaceGitInfo) rather
 * than checking it in here itself: every caller runs this across every space
 * a request can see, often on a poll (GET /api/spaces, the admin spaces
 * list) — a `git grep` per space on every such call would be needless load
 * for the overwhelming majority of spaces, which aren't conflicted at all.
 */
export async function getSpaceConflicts(space: string): Promise<SpaceGitConflict[]> {
  const dir = storageMod.getRepoDir(space);
  const rootPath = storageMod.getRootPath(space);
  let paths: string[];
  try {
    paths = await git.listConflictedFiles(dir);
  } catch {
    return [];
  }
  const out: SpaceGitConflict[] = [];
  for (const repoRelPath of paths) {
    const relPath = relPathUnderRoot(rootPath, repoRelPath);
    if (relPath !== null) {
      const id = await storageMod.getEntryIdByExactPath(space, relPath);
      if (id) {
        const entry = await storageMod.getEntry(id);
        out.push({ path: repoRelPath, pageId: id, title: entry?.title });
        continue;
      }
    }
    out.push({ path: repoRelPath });
  }
  return out;
}

// --- periodic background fetch (every ~3 min per space with a remote,
// staggered so N spaces don't all hit their remote in the same instant) ---

const periodicTimers = new Map<string, ReturnType<typeof setInterval>>();

export async function startPeriodicFetchForSpace(space: string): Promise<void> {
  if (periodicTimers.has(space)) return;
  const stagger = Math.floor(Math.random() * FETCH_INTERVAL_MS);
  const timer = setTimeout(() => {
    const interval = setInterval(() => {
      performSync(space).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[git-sync] periodic fetch failed for "${space}":`, err);
      });
    }, FETCH_INTERVAL_MS);
    periodicTimers.set(space, interval);
    performSync(space).catch(() => {});
  }, stagger);
  // store the stagger timer itself under the same key until it fires and replaces itself
  periodicTimers.set(space, timer as unknown as ReturnType<typeof setInterval>);
}

export function stopAllPeriodicFetch(): void {
  for (const t of periodicTimers.values()) clearTimeout(t as unknown as ReturnType<typeof setTimeout>);
  periodicTimers.clear();
}

/** Called once at boot: starts the periodic loop for every space that currently has a remote configured. */
export async function startPeriodicFetchForAllSpaces(): Promise<void> {
  const rows = await query<{ slug: string }>(`SELECT slug FROM spaces WHERE repo_url IS NOT NULL`);
  for (const row of rows) await startPeriodicFetchForSpace(row.slug);
}

// --- history / restore ------------------------------------------------------

function stripFrontmatterBody(raw: string): string {
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return raw;
  const rest = raw.slice(end + 4);
  return rest.startsWith('\n') ? rest.slice(1) : rest;
}

export async function getPageHistory(pageId: string, max = 100): Promise<PageHistoryEntry[]> {
  const entry = await storageMod.requireEntry(pageId);
  const dir = storageMod.getRepoDir(entry.space);
  const rootPath = storageMod.getRootPath(entry.space);
  const relToRepo = rootPath ? `${rootPath}/${entry.relPath}` : entry.relPath;
  // Partial clone (server/git.ts clone(): --filter=blob:none): `--follow`'s
  // rename detection may need to lazily fetch a historical blob from the
  // promisor remote, same as performSync's merge above — needs credentials.
  const askpass = (await hasSpaceToken(entry.space)) ? await ensureAskpassScript() : undefined;
  return git.fileHistory(dir, relToRepo, max, askpass, entry.space);
}

const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

export interface FilePageRevisionInfo {
  /** Space-relative path the file had at that revision (differs from today's after an extension change). */
  path: string;
  /** Lowercase extension with the dot: .pdf, .docx, .xlsx, .pptx. */
  ext: string;
  size: number;
}

/** Where a file page's revision lives in the repo: its path then (renames followed) relative to the repo root. Throws 404 when `sha` is not in the page's history. */
async function locateFilePageRevision(pageId: string, sha: string) {
  if (!SHA_PATTERN.test(sha)) throw badRequest('invalid revision');
  const entry = await storageMod.requireEntry(pageId);
  if (entry.kind !== 'pdf' && entry.kind !== 'office') throw badRequest('page is not a pdf/office file');
  const dir = storageMod.getRepoDir(entry.space);
  const rootPath = storageMod.getRootPath(entry.space);
  const toRepo = (rel: string) => (rootPath ? `${rootPath}/${rel}` : rel);
  const askpass = (await hasSpaceToken(entry.space)) ? await ensureAskpassScript() : undefined;
  const fullSha = (await git.pathAtRevisionSha(dir, toRepo(entry.relPath), sha, askpass, entry.space)) ?? null;
  if (!fullSha) throw notFound('revision');
  const repoPath = fullSha.path;
  const relPath = rootPath && repoPath.startsWith(`${rootPath}/`) ? repoPath.slice(rootPath.length + 1) : repoPath;
  return { entry, dir, askpass, repoPath, relPath, sha: fullSha.sha };
}

/** Path, extension and size of a file page at a revision, without reading the bytes. */
export async function getFilePageRevisionInfo(pageId: string, sha: string): Promise<FilePageRevisionInfo> {
  const found = await locateFilePageRevision(pageId, sha);
  let size: number;
  try {
    size = await git.fileSizeAt(found.dir, found.sha, found.repoPath, found.askpass, found.entry.space);
  } catch {
    throw notFound('revision');
  }
  return { path: found.relPath, ext: path.posix.extname(found.relPath).toLowerCase(), size };
}

/** A file page's bytes at a revision (for download and for restoring it). */
export async function getFilePageRevisionBytes(pageId: string, sha: string): Promise<FilePageRevisionInfo & { bytes: Buffer }> {
  const found = await locateFilePageRevision(pageId, sha);
  let bytes: Buffer;
  try {
    bytes = await git.showFileBytesAt(found.dir, found.sha, found.repoPath, found.askpass, found.entry.space);
  } catch {
    throw notFound('revision');
  }
  return { path: found.relPath, ext: path.posix.extname(found.relPath).toLowerCase(), size: bytes.length, bytes };
}

/**
 * Doc -> { markdown } (frontmatter stripped, same as a normal GET). Board ->
 * { svg } (the raw file at that sha — boards carry no frontmatter to strip,
 * just the leading folio-id comment, which stays as it was at that
 * revision).
 *
 * Table (round 26) -> ALSO { markdown }, but the RAW file, frontmatter
 * included — spec §12b's documented trap: for an ordinary doc, frontmatter
 * is metadata (id/order/status), so stripping it on a historical read is
 * correct and matches a normal GET. For a table, the "frontmatter" IS the
 * schema (columns/views/options) — stripFrontmatterBody-ing it here would
 * silently return a revision with its column schema cut off, and restoring
 * from that (routes.ts's POST /:id/restore/:sha, which round-trips this
 * response straight back through the same write path) would permanently
 * destroy the table's columns on restore. `PageAtShaResponse` deliberately
 * has no third content field for tables (spec §12b.3: "we do not add a third
 * content field to the contracts") — the raw table file (frontmatter + body) is
 * carried in the SAME `markdown` field a doc uses, just unstripped; a
 * consumer distinguishes the two only via the page's own `kind`, exactly as
 * every other kind-dependent response in this codebase already does.
 */
export async function getPageAtSha(pageId: string, sha: string): Promise<PageAtShaResponse> {
  const entry = await storageMod.requireEntry(pageId);
  // A pdf/office's bytes are never read as text (see server/storage.ts's
  // Binary page files module doc comment): the answer describes the file
  // (`file`) and the bytes themselves come from GET /api/pages/:id/history/:sha/file.
  if (entry.kind === 'pdf' || entry.kind === 'office') {
    const info = await getFilePageRevisionInfo(pageId, sha);
    return { file: { path: info.path, ext: info.ext, size: info.size } };
  }
  const dir = storageMod.getRepoDir(entry.space);
  const rootPath = storageMod.getRootPath(entry.space);
  const relToRepo = rootPath ? `${rootPath}/${entry.relPath}` : entry.relPath;
  // Same partial-clone lazy-fetch story as getPageHistory above: `git show
  // sha:path` for an old revision may need a blob the clone never fetched.
  const askpass = (await hasSpaceToken(entry.space)) ? await ensureAskpassScript() : undefined;
  let raw: string;
  try {
    raw = await git.showFileAt(dir, sha, relToRepo, askpass, entry.space);
  } catch {
    throw notFound('revision');
  }
  if (entry.kind === 'board') return { svg: raw };
  // Round FORMS: same "restore trap" as a table — a form's definition
  // (fields/table ref/public/…) lives in frontmatter too, so stripping it
  // here would restore a form with no fields at all.
  if (entry.kind === 'table' || entry.kind === 'form') return { markdown: raw }; // raw file — schema-in-frontmatter must survive a restore
  return { markdown: stripFrontmatterBody(raw) };
}
