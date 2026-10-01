/**
 * Trash round (DEV-PLAN "Round 27 — trash: restoring what was deleted") —
 * the business half of the trash API: list, restore, permanent delete,
 * "empty the trash", and the retention setting with its LAZY purge.
 *
 * Same layering as server/access/routes.ts: every function here takes the
 * acting User and does its own authorization, so the whole surface is
 * directly unit-testable against a real PG schema + real fs (this codebase
 * has no HTTP-level test harness); server/trash/routes.ts is only thin
 * Fastify plumbing over these.
 *
 * Visibility/authorization (spec item 4): a space's own admin sees that
 * space's items; an INSTANCE admin sees everything. The latter is a
 * deliberate, explicit exception to the access round's "no instance-admin
 * content bypass" rule: emptying/restoring the instance's trash is
 * ADMINISTRATION of the instance (like managing memberships), not silent
 * reading of a living space's content — and for a deleted SPACE there is no
 * space_members row left to hold any narrower right (the cascade destroyed
 * them; that destruction is exactly what restore undoes). A deleted space
 * additionally stays visible to whoever was its admin per the snapshot in
 * `payload`, so the admin who deleted their own space can bring it back
 * without escalating to an instance admin.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PageKind, TrashItemInfo, TrashKind, TrashListResponse, TrashRestoreResponse, User } from '../../shared/contracts.js';
import { officeFormat } from '../../shared/contracts.js';
import * as storage from '../storage.js';
import type { TrashSpaceSnapshot } from '../storage.js';
import * as store from '../auth/store.js';
import * as git from '../git.js';
import * as gitSync from '../gitSync.js';
import * as collab from '../collab.js';
import { decodeScenePayload, extractScenePayload } from '../confluenceWhiteboard.js';
import { query, queryOne } from '../db/pool.js';
import { withSpaceLock } from '../db/redis.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { getTrashRoot } from './paths.js';

const TRASH_KINDS: TrashKind[] = ['doc', 'board', 'table', 'pdf', 'office', 'form', 'folder', 'space'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TrashRow {
  id: string;
  space_slug: string;
  page_id: string;
  kind: TrashKind;
  orig_path: string;
  title: string;
  deleted_by: string | null;
  deleted_at: string;
  trash_path: string;
  children_count: number;
  payload: TrashSpaceSnapshot | null;
}

interface TrashRowJoined extends TrashRow {
  deleted_by_name: string | null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** The leaf page kinds a shape-(2) sibling children directory can ride along with (see restorePageItem) — never 'folder' (that's the whole-directory shape, handled as a single unit already) or 'space'. */
const LEAF_TRASH_KINDS = new Set<TrashKind>(['doc', 'board', 'table', 'pdf', 'office', 'form']);

// ---------------------------------------------------------------------------
// Visibility scope
// ---------------------------------------------------------------------------

type TrashScope = 'all' | Set<string>;

async function trashScopeFor(user: User): Promise<TrashScope> {
  if (user.isAdmin) return 'all';
  const memberships = await store.spacesForUser(user.id);
  return new Set(
    Object.entries(memberships)
      .filter(([, role]) => role === 'admin')
      .map(([slug]) => slug),
  );
}

function rowVisible(row: TrashRow, user: User, scope: TrashScope): boolean {
  if (scope === 'all') return true;
  if (scope.has(row.space_slug)) return true;
  // A deleted SPACE has no space_members rows left to check against — the
  // snapshot is the only surviving record of who administered it.
  if (row.kind === 'space') {
    return (row.payload?.members ?? []).some((m) => m.userId === user.id && m.role === 'admin');
  }
  return false;
}

async function requireVisibleRow(actor: User, id: string): Promise<TrashRow> {
  if (!UUID_RE.test(id)) throw notFound('trash item');
  const row = await queryOne<TrashRow>('SELECT * FROM trash_items WHERE id = $1', [id]);
  if (!row) throw notFound('trash item');
  const scope = await trashScopeFor(actor);
  if (!rowVisible(row, actor, scope)) throw forbidden('requires admin role in this space, or instance admin');
  return row;
}

// ---------------------------------------------------------------------------
// Filesystem plumbing
// ---------------------------------------------------------------------------

/** Resolves a row's trash_path against the trash root, refusing anything that escapes it (trash_path comes from the DB, but a traversal there must still never reach the rest of the disk). */
function trashAbsPath(trashPath: string): string {
  const root = getTrashRoot();
  const abs = path.resolve(root, trashPath);
  if (abs === root || (!abs.startsWith(root + path.sep) && !abs.startsWith(root + '/'))) throw badRequest('invalid trash path');
  return abs;
}

/** After a restore/purge removed a node, prunes now-empty parent directories up to (never including) the trash root — keeps data/.trash from accumulating hollow <stamp>/<space>/ shells. */
async function cleanupEmptyTrashDirs(startDirAbs: string): Promise<void> {
  const root = getTrashRoot();
  let cur = startDirAbs;
  while (cur !== root && cur.startsWith(root + path.sep)) {
    try {
      await fs.rmdir(cur); // fails on a non-empty dir — exactly when to stop
    } catch {
      return;
    }
    cur = path.dirname(cur);
  }
}

async function removeTrashFiles(row: TrashRow): Promise<void> {
  const abs = trashAbsPath(row.trash_path);
  await fs.rm(abs, { recursive: true, force: true });
  await cleanupEmptyTrashDirs(path.dirname(abs));
}

// ---------------------------------------------------------------------------
// Retention: NO auto-purge by default (retention_days NULL); when a period
// is set, the purge is LAZY — it runs when the trash list is opened (spec
// item 6), never on a background timer.
// ---------------------------------------------------------------------------

export async function getTrashSettings(): Promise<{ retentionDays: number | null }> {
  const row = await queryOne<{ retention_days: number | null }>('SELECT retention_days FROM trash_settings WHERE id = 1');
  return { retentionDays: row?.retention_days ?? null };
}

export async function setTrashRetention(actor: User, retentionDays: number | null): Promise<{ retentionDays: number | null }> {
  if (!actor.isAdmin) throw forbidden('requires instance admin');
  await query(
    'INSERT INTO trash_settings (id, retention_days) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET retention_days = EXCLUDED.retention_days',
    [retentionDays],
  );
  return { retentionDays };
}

async function purgeExpiredLazily(): Promise<void> {
  const { retentionDays } = await getTrashSettings();
  if (retentionDays === null) return;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const rows = await query<TrashRow>('SELECT * FROM trash_items WHERE deleted_at < $1', [cutoff]);
  for (const row of rows) {
    await removeTrashFiles(row).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[trash] lazy purge: failed to remove ${row.trash_path}:`, err);
    });
    await query('DELETE FROM trash_items WHERE id = $1', [row.id]);
  }
}

// ---------------------------------------------------------------------------
// GET /api/trash
// ---------------------------------------------------------------------------

export interface TrashListFilters {
  space?: string;
  kind?: string;
  /** yyyy-mm-dd (inclusive start-of-day, UTC). */
  from?: string;
  /** yyyy-mm-dd (inclusive whole day, UTC). */
  to?: string;
  /** 1..500, default 100 — an out-of-range or non-integer value falls back to the default. */
  limit?: number;
  /** >=0, default 0 — a negative or non-integer value falls back to the default. */
  offset?: number;
}

function rowToInfo(row: TrashRowJoined): TrashItemInfo {
  return {
    id: row.id,
    space: row.space_slug,
    pageId: row.page_id,
    kind: row.kind,
    origPath: row.orig_path,
    title: row.title,
    deletedBy: row.deleted_by ? { id: row.deleted_by, name: row.deleted_by_name ?? '' } : null,
    deletedAt: new Date(row.deleted_at).toISOString(),
    childrenCount: row.children_count,
  };
}

function clampLimit(v: number | undefined): number {
  return Number.isInteger(v) && v! >= 1 && v! <= 500 ? v! : 100;
}
function clampOffset(v: number | undefined): number {
  return Number.isInteger(v) && v! >= 0 ? v! : 0;
}

export async function listTrash(actor: User, filters: TrashListFilters = {}): Promise<TrashListResponse> {
  await purgeExpiredLazily();
  const scope = await trashScopeFor(actor);
  const rows = await query<TrashRowJoined>(
    'SELECT t.*, u.name AS deleted_by_name FROM trash_items t LEFT JOIN users u ON u.id = t.deleted_by ORDER BY t.deleted_at DESC',
  );

  // Visible to the actor, BEFORE any of the filters below — `spaces` backs
  // the filter-by-space select itself, so it must list every space the
  // actor could filter to, not just the ones on the current page.
  const visibleRows = rows.filter((row) => rowVisible(row, actor, scope));
  const spaces = Array.from(new Set(visibleRows.map((row) => row.space_slug))).sort();

  const kindFilter = TRASH_KINDS.includes(filters.kind as TrashKind) ? (filters.kind as TrashKind) : undefined;
  const fromTs = filters.from ? Date.parse(filters.from) : Number.NaN;
  const toTs = filters.to ? Date.parse(filters.to) + 24 * 60 * 60 * 1000 : Number.NaN; // inclusive whole "to" day

  const filtered = visibleRows
    .filter((row) => !filters.space || row.space_slug === filters.space)
    .filter((row) => !kindFilter || row.kind === kindFilter)
    .filter((row) => {
      const ts = new Date(row.deleted_at).getTime();
      if (!Number.isNaN(fromTs) && ts < fromTs) return false;
      if (!Number.isNaN(toTs) && ts >= toTs) return false;
      return true;
    });

  const limit = clampLimit(filters.limit);
  const offset = clampOffset(filters.offset);
  const items = filtered.slice(offset, offset + limit).map(rowToInfo);
  return { items, total: filtered.length, spaces };
}

// ---------------------------------------------------------------------------
// POST /api/trash/:id/restore
// ---------------------------------------------------------------------------

/** Page-file extensions, longest-suffix first — `.table.md` must be stripped whole before plain `.md` gets a chance (same trap storage.titleFallback documents). */
const PAGE_EXTS = ['.table.md', '.excalidraw.svg', '.pdf', '.docx', '.xlsx', '.pptx', '.md'];

function splitRelExt(rel: string): { base: string; ext: string } {
  const lower = rel.toLowerCase();
  for (const ext of PAGE_EXTS) {
    if (lower.endsWith(ext)) return { base: rel.slice(0, rel.length - ext.length), ext: rel.slice(rel.length - ext.length) };
  }
  return { base: rel, ext: '' }; // directory (kind=folder), or an exotic backfilled file
}

/** `notes/plan.md` -> `notes/plan-restored.md`, then `notes/plan-restored-2.md`, ... (spec item 5: on conflict NEVER overwrite — restore alongside and tell the truth). */
function suffixedRel(orig: string, n: number): string {
  const { base, ext } = splitRelExt(orig);
  return n === 1 ? `${base}-restored${ext}` : `${base}-restored-${n}${ext}`;
}

async function requireTrashContent(row: TrashRow): Promise<string> {
  const srcAbs = trashAbsPath(row.trash_path);
  if (!(await pathExists(srcAbs))) {
    // The files are gone (hand-cleaned trash dir, older purge crash) — a row
    // pointing at nothing only misleads; drop it and report honestly.
    await query('DELETE FROM trash_items WHERE id = $1', [row.id]);
    throw notFound('trash item content');
  }
  return srcAbs;
}

/** See its call site in restorePageItem — best-effort, never blocks the restore itself. */
async function syncLiveBoardAfterRestore(id: string): Promise<void> {
  if (!collab.isLiveBoard(id)) return; // nothing open to desync — a future open seeds itself normally from the file
  const svg = await storage.readBoardSvg(id);
  const payload = extractScenePayload(svg);
  if (!payload) return;
  const scene = decodeScenePayload(payload);
  await collab.editBoardScene(id, scene);
}

async function restorePageItem(actor: User, row: TrashRow): Promise<TrashRestoreResponse> {
  const space = row.space_slug;
  if (!(await storage.spaceExists(space))) {
    throw conflict(`space "${space}" no longer exists — restore the space itself first`);
  }
  const srcAbs = await requireTrashContent(row);

  // Shape (2) (see storage.ts getSubtree's doc comment): a leaf page can
  // have brought a same-named sibling children directory into trash along
  // with it (deletePage's own mirror of movePage/renamePageSlug's
  // relPathStem handling). If that directory rode along, it sits right next
  // to the file in trash (same parent) — restore must bring it back too, at
  // whatever name the file itself ends up restored under, so the pairing
  // never drifts apart even when a conflict forces a `-restored` suffix.
  let srcChildDirAbs: string | undefined;
  if (LEAF_TRASH_KINDS.has(row.kind)) {
    const stem = storage.relPathStem(row.orig_path, row.kind as PageKind);
    const candidate = path.join(path.dirname(srcAbs), stem);
    if (await isDirectory(candidate)) srcChildDirAbs = candidate;
  }
  const destChildDirAbsFor = (destAbs: string, rel: string): string =>
    path.join(path.dirname(destAbs), storage.relPathStem(rel, row.kind as PageKind));
  const destConflicts = async (spaceRoot: string, rel: string): Promise<boolean> => {
    const destAbs = path.join(spaceRoot, rel);
    if (await pathExists(destAbs)) return true;
    return srcChildDirAbs ? pathExists(destChildDirAbsFor(destAbs, rel)) : false;
  };

  const result = await withSpaceLock(space, async () => {
    const spaceRoot = storage.getSpaceDir(space);
    let destRel = row.orig_path;
    let renamed = false;
    if (await destConflicts(spaceRoot, destRel)) {
      renamed = true;
      let n = 1;
      do {
        destRel = suffixedRel(row.orig_path, n++);
      } while (await destConflicts(spaceRoot, destRel));
    }
    const destAbs = path.join(spaceRoot, destRel);
    await fs.mkdir(path.dirname(destAbs), { recursive: true });
    // A pdf/office file carries no id in its bytes (storage.ts "Binary page
    // files") — pin the trashed page's id to where it lands so the rescan
    // gives it back.
    const lowerDest = destAbs.toLowerCase();
    if (row.page_id && (lowerDest.endsWith('.pdf') || officeFormat(lowerDest))) storage.claimBinaryId(destAbs, row.page_id);
    await fs.rename(srcAbs, destAbs);
    if (srcChildDirAbs) {
      const destChildDirAbs = destChildDirAbsFor(destAbs, destRel);
      try {
        await fs.rename(srcChildDirAbs, destChildDirAbs);
      } catch (err) {
        // Two renames are not atomic — put the file back in trash before
        // rethrowing so a partial restore never lands on disk (same
        // rollback shape as deletePage/movePage/renamePageSlug).
        await fs.rename(destAbs, srcAbs);
        throw err;
      }
    }
    await storage.scanSpace(space);
    await query('DELETE FROM trash_items WHERE id = $1', [row.id]);
    await cleanupEmptyTrashDirs(path.dirname(srcAbs));
    // page_id survives inside the file itself (frontmatter id / board's
    // folio-id comment) or, for a PDF, via the claim above, so old links and
    // live collab rooms — both keyed by id — keep working after the rescan.
    return { restoredPath: destRel, pageId: row.page_id, space, renamed } satisfies TrashRestoreResponse;
  });

  // Round 29: a board's collab room, unlike a doc's or a table's, keeps
  // running with whatever content it already had in memory across a delete —
  // storage.getEntry(id) returns nothing for a trashed page, so persistDoc's
  // own guard just no-ops the debounced write-back rather than erroring, and
  // nothing ever re-seeds the room from the file the way a fresh bindState
  // would. Push the just-restored file's scene into any live room explicitly,
  // so a tab that stayed open across the delete+restore actually shows the
  // restored content instead of whatever it happened to be holding.
  if (row.kind === 'board') {
    await syncLiveBoardAfterRestore(result.pageId).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[trash] failed to sync live board ${result.pageId} after restore:`, err);
    });
  }

  const author = { name: actor.name, email: actor.email };
  gitSync.recordEditor(space, author);
  // Dedicated, immediately-visible commit (spec item 5), same commitNow shape
  // the slug rename uses — outside the lock above, since commitNow takes the
  // space lock itself and withSpaceLock is not reentrant.
  // No noteActivity here: the slug-rename precedent (collab.renamePageSlug) —
  // the dedicated commit IS the write-back; pushing rides the next normal
  // sync, and a 90s quiet timer from a direct service call would only leak
  // into tests.
  await gitSync.commitNow(space, `docs: restore ${result.restoredPath}`, author).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[trash] restore commit failed for "${space}":`, err);
  });
  return result;
}

function humanizeSlug(slug: string): string {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Reads only this space's canonical metadata, never a sibling `*.folio`. */
async function readFolioName(repoDirAbs: string, slug: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(repoDirAbs, `${slug}.folio`), 'utf8')) as { name?: unknown };
    return typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : undefined;
  } catch {
    return undefined;
  }
}

function validVisibility(v: unknown): 'private' | 'instance' {
  return v === 'instance' ? 'instance' : 'private';
}
function validAssetMode(v: unknown): 'store' | 'repo' {
  return v === 'repo' ? 'repo' : 'store';
}
function validRole(v: unknown): 'viewer' | 'editor' | 'admin' {
  return v === 'admin' || v === 'editor' ? v : 'viewer';
}

/**
 * kind='space': recreate the `spaces` row (name/git config from the
 * snapshot, with a matching `<slug>.folio` as a legacy fallback), put the
 * members with their roles back, move the files home, then a full
 * scanSpace. If the slug (or its on-disk directory) is taken by a NEW
 * space created since, the same never-overwrite rule applies at slug
 * level: restore as `<slug>-restored` and report it (`renamed: true`).
 *
 * Ordering here mirrors deletePage's own reasoning in reverse: files move
 * FIRST, DB rows second — a crash in between leaves an unregistered repo
 * under data/repos, which registerReposOnBoot turns back into a (bare,
 * memberless) space on the next boot rather than losing anything.
 */
async function restoreSpaceItem(actor: User, row: TrashRow): Promise<TrashRestoreResponse> {
  const srcAbs = await requireTrashContent(row);
  const snapshot = row.payload;
  const rootPath = snapshot?.rootPath ?? '';
  const origSlug = row.page_id || row.space_slug;
  const contentRootAbsFor = (slug: string) => (rootPath ? path.join(storage.REPOS_DIR, slug, rootPath) : path.join(storage.REPOS_DIR, slug));
  const restoreTargetFor = (slug: string) => (snapshot?.fullRepo ? path.join(storage.REPOS_DIR, slug) : contentRootAbsFor(slug));

  let slug = origSlug;
  let renamed = false;
  if ((await storage.spaceExists(slug)) || (await pathExists(restoreTargetFor(slug)))) {
    renamed = true;
    let n = 1;
    do {
      slug = n === 1 ? `${origSlug}-restored` : `${origSlug}-restored-${n}`;
      n++;
    } while ((await storage.spaceExists(slug)) || (await pathExists(restoreTargetFor(slug))));
  }
  const repoDirAbs = path.join(storage.REPOS_DIR, slug);
  const restoreTargetAbs = restoreTargetFor(slug);

  await withSpaceLock(slug, async () => {
    await fs.mkdir(path.dirname(restoreTargetAbs), { recursive: true });
    await fs.rename(srcAbs, restoreTargetAbs);
    // The common case (rootPath '') moved the whole repo incl. .git into the
    // trash, so it comes back a repo already; a backfilled/partial layout
    // gets a fresh git identity instead of none at all.
    if (!(await git.isGitRepo(repoDirAbs))) {
      await git.initWithCommit(repoDirAbs, `docs: restore space ${origSlug}`);
    }
    const name = snapshot?.name ?? (await readFolioName(repoDirAbs, origSlug)) ?? humanizeSlug(origSlug);
    await query(
      `INSERT INTO spaces (slug, name, repo_url, branch, root_path, status, visibility, asset_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [slug, name, snapshot?.repoUrl ?? null, snapshot?.branch ?? 'main', rootPath, snapshot?.repoUrl ? 'clean' : 'local', validVisibility(snapshot?.visibility), validAssetMode(snapshot?.assetMode)],
    );
    await storage.setSpaceRootPathCache(slug, rootPath);
    for (const member of snapshot?.members ?? []) {
      await query('INSERT INTO space_members (space_slug, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (space_slug, user_id) DO UPDATE SET role = EXCLUDED.role', [
        slug,
        member.userId,
        validRole(member.role),
      ]).catch(() => {
        // the user account no longer exists (FK) — skip that member, restore the rest
      });
    }
    // Also creates the correct metadata filename when a conflicting slug
    // forced a `-restored` suffix.
    await storage.noteSpaceNameChange(slug, name);
    await storage.scanSpace(slug);
    await query('DELETE FROM trash_items WHERE id = $1', [row.id]);
    await cleanupEmptyTrashDirs(path.dirname(srcAbs));
  });

  const author = { name: actor.name, email: actor.email };
  gitSync.recordEditor(slug, author);
  await gitSync.commitNow(slug, `docs: restore space ${origSlug}`, author).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[trash] restore commit failed for "${slug}":`, err);
  });
  // restoredPath '' = the space root; pageId carries the (possibly suffixed) slug per the contract.
  return { restoredPath: '', pageId: slug, space: slug, renamed };
}

export async function restoreTrashItem(actor: User, id: string): Promise<TrashRestoreResponse> {
  const row = await requireVisibleRow(actor, id);
  return row.kind === 'space' ? restoreSpaceItem(actor, row) : restorePageItem(actor, row);
}

// ---------------------------------------------------------------------------
// DELETE /api/trash/:id (permanently) + DELETE /api/trash ("empty the trash")
// ---------------------------------------------------------------------------

export async function purgeTrashItem(actor: User, id: string): Promise<{ ok: true }> {
  const row = await requireVisibleRow(actor, id);
  await removeTrashFiles(row);
  await query('DELETE FROM trash_items WHERE id = $1', [row.id]);
  return { ok: true };
}

/** Permanently removes every item the caller can see (optionally narrowed to one space). Files first, row second — a crash in between leaves a row whose missing files requireTrashContent later self-heals. */
export async function emptyTrash(actor: User, space?: string): Promise<{ removed: number }> {
  const scope = await trashScopeFor(actor);
  const rows = await query<TrashRow>('SELECT * FROM trash_items ORDER BY deleted_at');
  const targets = rows.filter((row) => rowVisible(row, actor, scope) && (!space || row.space_slug === space));
  for (const row of targets) {
    await removeTrashFiles(row).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[trash] empty: failed to remove ${row.trash_path}:`, err);
    });
    await query('DELETE FROM trash_items WHERE id = $1', [row.id]);
  }
  return { removed: targets.length };
}
