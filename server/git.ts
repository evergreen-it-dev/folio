/**
 * Git operations (round 3 "git-native spaces"). Every call shells out to the
 * system `git` via execFile with an args ARRAY — never a shell string, so
 * nothing a user supplies (branch name, path, message) can be interpreted
 * by a shell. All ops that touch a space's working tree are expected to be
 * called from inside that space's Redis advisory lock (server/db/redis.ts's
 * withSpaceLock) by the caller (server/storage.ts / server/gitSync.ts).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Never staged: server/storage.ts writeFileAtomic's temp files
 * (`.<file>.<pid>.<random>.tmp`). One only outlives its write when the process
 * died mid-write, and must not reach a commit then; the next space scan removes it.
 */
export const ATOMIC_TEMP_PATHSPEC = ':(exclude,glob)**/.*.tmp';
// After `add -A` everything else is staged, so "anything to commit" is asked
// with --untracked-files=no: an excluded temp file alone must not start a
// commit with nothing in it.
import type { PageHistoryEntry } from '../shared/contracts.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;

/** Committer identity is always Folio's own — DEV-PLAN: never write a real user's identity into the clone's config. Author (a real person) is passed per-call via `--author`/`GIT_AUTHOR_*`. */
const FOLIO_COMMITTER = { name: 'Folio', email: 'folio@instance' };

export interface GitIdentity {
  name: string;
  email: string;
}

export class GitError extends Error {
  constructor(
    public args: string[],
    public stderr: string,
  ) {
    super(`git ${args.join(' ')} failed: ${stderr.trim() || '(no stderr)'}`);
    this.name = 'GitError';
  }
}

async function execGit(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, ...env },
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new GitError(args, e.stderr?.trim() ? e.stderr : e.message);
  }
}

/**
 * True only if `dir` has its OWN `.git` entry (directory or, for a worktree/
 * submodule checkout, a file). Deliberately NOT `git rev-parse --git-dir`:
 * that command walks UP through parent directories looking for a `.git`,
 * so for any space dir nested inside a larger git working tree (this whole
 * app's own repo checkout, in dev) it would report "yes, already a repo"
 * by finding the ANCESTOR's .git — causing every git op the caller runs
 * against `dir` (add -A, commit, merge) to silently operate on that
 * ancestor repo instead. A plain fs check has no such ambient discovery.
 */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await stat(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/** `git init -b main` + a single initial commit (used for the data/spaces -> data/repos layout migration and brand-new empty spaces). No-ops the commit if there's nothing to add. */
export async function initWithCommit(dir: string, message: string): Promise<void> {
  await execGit(dir, ['init', '-b', 'main']);
  await commitAll(dir, message, FOLIO_COMMITTER);
}

/** Stages everything and commits if there are changes. Returns whether a commit was made. Committer is always Folio's fixed identity; `author` (a real person, or Folio itself for system commits) is passed via --author, never written to config. */
export async function commitAll(dir: string, message: string, author: GitIdentity): Promise<boolean> {
  await execGit(dir, ['add', '-A', '--', '.', ATOMIC_TEMP_PATHSPEC]);
  const { stdout } = await execGit(dir, ['status', '--porcelain', '--untracked-files=no']);
  if (!stdout.trim()) return false;
  await execGit(dir, [
    '-c',
    `user.name=${FOLIO_COMMITTER.name}`,
    '-c',
    `user.email=${FOLIO_COMMITTER.email}`,
    'commit',
    '--author',
    `${author.name} <${author.email}>`,
    '-m',
    message,
  ]);
  return true;
}

/**
 * URL hygiene for EVERY path that hands a user-supplied repository URL to
 * git (SSRF/RCE guards): only http(s)/ssh URLs or the scp-like git@host:path
 * form are accepted, everything else is rejected. What that allowlist keeps
 * out, and why each one matters:
 *
 *  - `file:///…` AND a schemeless local path (`/abs`, `./rel`, `../x`,
 *    `~/x`, `C:\…`, plain `foo/bar`) — git treats BOTH as "clone this local
 *    repository". An earlier version of this comment argued that, because
 *    the two are equally dangerous, rejecting one without the other would be
 *    security theatre — and then concluded that the guard therefore
 *    shouldn't be applied to the create-space path at all. That reasoning
 *    got the fix exactly backwards and was the QA-3 P0: any authenticated
 *    user could `POST /api/spaces {repoUrl: "file:///…/data/repos/<someone
 *    else's private space>"}` (or the same path with no scheme at all) and
 *    become admin of a full copy of that space's content. Both forms are
 *    rejected here now, which is what "equally dangerous" actually implies.
 *  - `ext::…` and any other `<helper>::…` remote-helper form — arbitrary
 *    command execution (`ext::sh -c …` is a real git feature, not a
 *    theoretical one). Current git refuses `ext` by default, but that's a
 *    config setting (`protocol.ext.allow`), not a guarantee.
 *  - anything starting with `-`: even inside an execFile args ARRAY (never a
 *    shell string), git's OWN argument parser doesn't know "this came from a
 *    URL field" from "this is a flag", so a leading `-` lets a crafted value
 *    become a git option like `--upload-pack=…` — its own RCE vector.
 *    Verified against the running server: `--upload-pack=/bin/sh` reached
 *    git's argv as an option.
 *
 * Applied at BOTH ends, deliberately (defense in depth):
 *  - at every route that accepts a repoUrl from a request (POST
 *    /api/spaces, POST /api/spaces/:space/connect-git, POST
 *    /api/git/branches, GET /api/git/tree) — that's the trust boundary, and
 *    there it is unconditional;
 *  - inside clone()/isEmptyRemote()/cloneEmptyAndBootstrap()/addRemote()
 *    themselves, so a future caller can't reopen the hole by forgetting the
 *    route-level call.
 *
 * The one legitimate local-path case — tests and ad hoc ops scripts using a
 * plain local bare repo as a stand-in remote — opts in via
 * __allowLocalRepoPathsForTests() below, which no HTTP request can reach.
 */
export function validateRepoUrl(url: string): void {
  if (!url || url.startsWith('-')) throw new Error('invalid repository URL');
  if (/^https?:\/\//i.test(url) || /^ssh:\/\//i.test(url) || /^git@/i.test(url)) return;
  throw new Error('invalid repository URL');
}

/** `ext::`, `transport::`, … — git's remote-helper form, which is command execution by design. */
const REMOTE_HELPER_RE = /^[a-z0-9][a-z0-9+.-]*::/i;

let localRepoPathsAllowed = false;

/**
 * Opt-in escape hatch for the ONE legitimate local-path case: a test (see
 * server/gitNative.test.ts's whole fixture set) or an ad hoc ops script
 * pointing the clone family at a plain local bare repo instead of a real
 * remote. Call it once at the top of such a file.
 *
 * Process-global and write-once-true on purpose: no per-call flag exists
 * that a route handler could accidentally wire to a request field, and no
 * HTTP request can reach this function at all. It additionally refuses to
 * arm in production, so even a stray import can't reopen the hole on a real
 * instance — and it never relaxes the ROUTE-level validateRepoUrl calls,
 * which stay unconditional.
 */
export function __allowLocalRepoPathsForTests(): void {
  if (process.env.NODE_ENV === 'production') throw new Error('local repository paths cannot be enabled in production');
  localRepoPathsAllowed = true;
}

/**
 * The guard the clone family actually calls. Note that even with local paths
 * armed, the two argv-level dangers stay closed: a `-`-prefixed value is a
 * git OPTION rather than a path, and `<helper>::` is command execution —
 * neither is ever a legitimate "local repo standing in for a remote".
 */
export function assertRemoteAllowed(repoUrl: string): void {
  if (!localRepoPathsAllowed) {
    validateRepoUrl(repoUrl);
    return;
  }
  if (!repoUrl || repoUrl.startsWith('-') || REMOTE_HELPER_RE.test(repoUrl)) throw new Error('invalid repository URL');
}

/**
 * Clones a remote into `destDir` (full history — versioning needs it, per
 * DEV-PLAN, so no --depth: page history is read from the git log, and a
 * shallow clone with a single commit would kill it for every imported
 * repository). `askpassScript` + `spaceSlug` wire up
 * GIT_ASKPASS/FOLIO_GIT_SPACE so a stored token (server/gitCredentials.ts)
 * authenticates the clone without ever appearing in argv/logs or being
 * written into the resulting clone's config.
 *
 * `--filter=blob:none` (owner: a space from a large repository "hangs" on
 * creation) — a partial clone: the whole history of COMMITS arrives at once,
 * and blobs are fetched lazily on first access (getPageAtSha and page history
 * work; the first display of an old revision just goes to the remote for the
 * blob). If the server cannot filter, git prints "filtering not recognized by
 * server, ignoring" and silently makes a FULL clone — the degradation is safe
 * by construction. GitLab has supported partial clone since 13.x.
 *
 * The timeout is its own, CLONE_TIMEOUT_MS (5 min), not the general
 * GIT_TIMEOUT_MS (60 s): cloning a large repository legitimately takes more
 * than a minute even with the filter, and it was the 60-second kill of the
 * clone that looked like an endless "Creating…" in the interface.
 */
const CLONE_TIMEOUT_MS = 300_000;

export async function clone(
  repoUrl: string,
  destDir: string,
  branch: string,
  askpassScript?: string,
  spaceSlug?: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  assertRemoteAllowed(repoUrl);
  const env = remoteAuthEnv(askpassScript, spaceSlug);
  const args = ['clone', '--progress', '--filter=blob:none', '--branch', branch, '--single-branch', repoUrl, destDir];
  if (!onProgress) {
    await execGit('.', args, env, CLONE_TIMEOUT_MS);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    const child = execFile('git', args, {
      cwd: '.',
      timeout: CLONE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, ...env },
    }, (err) => {
      if (err) reject(new GitError(args, stderr.trim() || err.message));
      else resolve();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      stderr += text;
      for (const match of text.matchAll(/(?:Receiving objects|Resolving deltas):\s*(\d+)%/g)) {
        onProgress(Math.max(1, Math.min(100, Number(match[1]))));
      }
    });
  });
}

/**
 * True if the remote has zero refs — a brand-new empty repo. Checked via
 * `git ls-remote` BEFORE attempting a `--branch`-scoped clone: that clone
 * fails outright against an empty remote ("fatal: Remote branch main not
 * found in upstream origin", exit 128), and parsing that error text would
 * be brittle across git versions/locales. An empty `ls-remote` is a clean,
 * version-independent signal instead. A genuinely bad URL/auth failure
 * still throws GitError here exactly as it would from `clone`.
 */
export async function isEmptyRemote(repoUrl: string, askpassScript?: string, spaceSlug?: string): Promise<boolean> {
  assertRemoteAllowed(repoUrl);
  const env = remoteAuthEnv(askpassScript, spaceSlug);
  const { stdout } = await execGit('.', ['ls-remote', repoUrl], env);
  return stdout.trim() === '';
}

/**
 * Clones a remote that `isEmptyRemote()` already confirmed is empty, then
 * bootstraps it: creates `branch` (explicitly, regardless of whatever
 * default branch name the clone itself landed on), writes a root
 * README.md, commits, and pushes -u so the branch exists on the remote too.
 * Author is always Folio's own identity — same precedent as
 * `initWithCommit`: the very first scaffolding commit of a space is a
 * system action, not attributed to whichever user happened to click
 * "create".
 */
export async function cloneEmptyAndBootstrap(
  repoUrl: string,
  destDir: string,
  branch: string,
  readmeContent: string,
  askpassScript?: string,
  spaceSlug?: string,
): Promise<void> {
  assertRemoteAllowed(repoUrl);
  const env = remoteAuthEnv(askpassScript, spaceSlug);
  await execGit('.', ['clone', repoUrl, destDir], env);
  await execGit(destDir, ['checkout', '-b', branch]);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(destDir, 'README.md'), readmeContent, 'utf8');
  await commitAll(destDir, 'init: bootstrap content repo', FOLIO_COMMITTER);
  await execGit(destDir, ['push', '-u', 'origin', branch], env);
}

const BRANCHES_TIMEOUT_MS = 15_000;

export interface RemoteBranchesRaw {
  branches: string[];
  defaultBranch: string | null;
}

/**
 * Lists a remote's branches WITHOUT cloning — one `git ls-remote --symref`
 * call gets both the symref (-> default branch) and every `refs/heads/*`
 * (tags and anything else under refs/ are filtered out) in one round trip,
 * rather than two separate `ls-remote` invocations. Sorted, default branch
 * first if it's among them.
 *
 * `token`, if given, rides a GIT_ASKPASS + a FOLIO_ONEOFF_TOKEN env var
 * scoped to this ONE child process only (gitCredentials.ts's askpass
 * script checks that before its normal per-space file-based lookup) — it
 * is never written to disk, never logged, and never appears in argv.
 */
export async function listRemoteBranches(repoUrl: string, token?: string): Promise<RemoteBranchesRaw> {
  validateRepoUrl(repoUrl);
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' };
  if (token) {
    const { ensureAskpassScript } = await import('./gitCredentials.js');
    env.GIT_ASKPASS = await ensureAskpassScript();
    env.FOLIO_ONEOFF_TOKEN = token;
  }
  const { stdout } = await execGit('.', ['ls-remote', '--symref', repoUrl], env, BRANCHES_TIMEOUT_MS);

  let defaultBranch: string | null = null;
  const branches: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('ref: ')) {
      // "ref: refs/heads/<name>\tHEAD"
      const m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(line.trim());
      if (m) defaultBranch = m[1];
      continue;
    }
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const ref = line.slice(tab + 1);
    if (ref.startsWith('refs/heads/')) branches.push(ref.slice('refs/heads/'.length));
  }
  branches.sort();
  if (defaultBranch && branches.includes(defaultBranch)) {
    branches.splice(branches.indexOf(defaultBranch), 1);
    branches.unshift(defaultBranch);
  }
  return { branches, defaultBranch };
}

/**
 * Commits whatever is currently on disk under `dir` (used when
 * auto-creating a space's rootPath folder that didn't exist yet in the
 * cloned repo) and pushes if a remote is configured. Author is always
 * Folio's own identity, same precedent as `initWithCommit`/
 * `cloneEmptyAndBootstrap`. No-ops (returns false, doesn't push) if
 * there's nothing to commit.
 */
export async function commitAndPushIfRemote(
  dir: string,
  branch: string,
  message: string,
  askpassScript?: string,
  spaceSlug?: string,
): Promise<boolean> {
  const committed = await commitAll(dir, message, FOLIO_COMMITTER);
  if (committed && (await hasRemote(dir))) {
    await push(dir, branch, askpassScript, spaceSlug);
  }
  return committed;
}

/**
 * Builds the env `fetch`/`push`/clone use to authenticate against a remote:
 * `GIT_ASKPASS` (only if given) + `FOLIO_GIT_SPACE` (only alongside an
 * askpass script) on top of the always-on `GIT_TERMINAL_PROMPT=0`. Factored
 * out so every command that can reach the network — including ones that
 * only do so LAZILY, like a partial clone's `merge`/`log --follow`/`show`
 * fetching a blob from the promisor remote mid-command — builds the same
 * env instead of some getting it and others silently running unauthenticated.
 */
function remoteAuthEnv(askpassScript?: string, spaceSlug?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' };
  if (askpassScript) {
    env.GIT_ASKPASS = askpassScript;
    if (spaceSlug) env.FOLIO_GIT_SPACE = spaceSlug;
  }
  return env;
}

export async function fetch(dir: string, askpassScript?: string, spaceSlug?: string): Promise<void> {
  await execGit(dir, ['fetch', 'origin'], remoteAuthEnv(askpassScript, spaceSlug));
}

export async function push(dir: string, branch: string, askpassScript?: string, spaceSlug?: string): Promise<void> {
  await execGit(dir, ['push', 'origin', `HEAD:${branch}`], remoteAuthEnv(askpassScript, spaceSlug));
}

/**
 * merge (not rebase) the already-fetched remote tracking branch into the
 * current one. Conflicts land as unresolved index entries + marker text in
 * the files; caller is responsible for `git add -A` + committing them as-is
 * (DEV-PLAN: conflict markers stay in the text, resolved like any other edit).
 *
 * `askpassScript`/`spaceSlug` (production, 15.09): clones are partial
 * (`--filter=blob:none`, clone() above), so `merge` itself goes to the
 * promisor remote for blobs as soon as it needs them for a trivial
 * diff3/rename detection. Without the same credentials that go into
 * fetch()/push() this failed with `fatal: could not read Username ... fatal:
 * could not fetch <sha> from promisor remote` — it looked like a network
 * error, while in fact merge simply never received GIT_ASKPASS/FOLIO_GIT_SPACE.
 */
export async function mergeFetchedRemote(
  dir: string,
  branch: string,
  askpassScript?: string,
  spaceSlug?: string,
): Promise<{ conflict: boolean }> {
  const env = remoteAuthEnv(askpassScript, spaceSlug);
  try {
    // `git merge` is already "merge, never rebase" — --no-rebase is a `git pull` disambiguator
    // (DEV-PLAN's "git pull --no-rebase (merge)"), not a valid `git merge` flag at all.
    // Identity passed explicitly, exactly like commitConflictState below: a
    // non-fast-forward merge WRITES a merge commit, and the container has no
    // global git identity. Without these `-c` flags every space whose local
    // and remote histories had both moved failed with "Committer identity
    // unknown" — which the old catch-all then mislabelled as a conflict (prod,
    // 15.09: 9 of 10 git spaces in `error`; the real message only became
    // visible once non-conflict failures stopped being swallowed).
    await execGit(
      dir,
      [
        '-c',
        `user.name=${FOLIO_COMMITTER.name}`,
        '-c',
        `user.email=${FOLIO_COMMITTER.email}`,
        'merge',
        '--no-edit',
        `origin/${branch}`,
      ],
      env,
    );
    return { conflict: false };
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
    // A failed `git merge` is NOT necessarily a conflict. It also fails, with a
    // perfectly clean tree and nothing merged, on "refusing to merge unrelated
    // histories", on "not something we can merge", on local changes it would
    // overwrite. Treating all of those as a conflict sent performSync into
    // commitConflictState, whose `git commit` then failed with "nothing to
    // commit" — and that message, not the real one, became every such space's
    // lastError on every tick, forever (7 of 12 git spaces on prod, 15.09).
    // A real conflict is the one that leaves unmerged paths behind; anything
    // else is re-thrown with git's own words so the status says what happened.
    const { stdout } = await execGit(dir, ['diff', '--name-only', '--diff-filter=U']).catch(() => ({ stdout: '' }));
    if (stdout.trim()) return { conflict: true };
    await execGit(dir, ['merge', '--abort'], env).catch(() => {});
    throw err;
  }
}

/** Commits whatever is currently on disk (including unresolved conflict markers) as-is — used right after a conflicted merge. */
export async function commitConflictState(dir: string): Promise<void> {
  await execGit(dir, ['add', '-A', '--', '.', ATOMIC_TEMP_PATHSPEC]);
  await execGit(dir, ['-c', `user.name=${FOLIO_COMMITTER.name}`, '-c', `user.email=${FOLIO_COMMITTER.email}`, 'commit', '-m', 'merge with conflicts']);
}

/** `git rev-parse HEAD`. */
export async function headSha(dir: string): Promise<string> {
  const { stdout } = await execGit(dir, ['rev-parse', 'HEAD']);
  return stdout.trim();
}

/**
 * Repo-root-relative paths that differ between two commits — what a merge
 * from `from` to `to` changed in the working tree. `--no-renames`: a rename
 * lists both of its paths (and needs no blobs in a partial clone). `-z`: a
 * non-ASCII file name comes back as-is, not C-quoted.
 */
export async function filesChangedBetween(dir: string, from: string, to: string, askpassScript?: string, spaceSlug?: string): Promise<string[]> {
  const { stdout } = await execGit(dir, ['diff', '--name-only', '--no-renames', '-z', from, to], remoteAuthEnv(askpassScript, spaceSlug));
  return stdout.split('\0').filter(Boolean);
}

export async function hasRemote(dir: string): Promise<boolean> {
  const { stdout } = await execGit(dir, ['remote']);
  return stdout.split('\n').some((l) => l.trim() === 'origin');
}

/**
 * `git remote add origin <url>` — connects an ALREADY-EXISTING local
 * (git-initialized but remote-less) space to a repository after the fact
 * ("Connect git" on a local space). Distinct from `clone`: this space's
 * working tree and history already exist on disk; the caller is expected to
 * have already confirmed the remote is empty (`isEmptyRemote`) before
 * calling this, and to `push` right after so the two histories are
 * reconciled by "local wins, remote is empty" rather than by a merge.
 */
export async function addRemote(dir: string, repoUrl: string): Promise<void> {
  assertRemoteAllowed(repoUrl);
  await execGit(dir, ['remote', 'add', 'origin', repoUrl]);
}

/** `git remote remove <name>` — best-effort rollback of `addRemote` when the push right after it fails, so a failed "Connect git" attempt doesn't leave a dangling origin pointing at a repo the space was never actually connected to. Caller is expected to swallow the "no such remote" failure itself if it can't guarantee `addRemote` ran first. */
export async function removeRemote(dir: string, name: string): Promise<void> {
  await execGit(dir, ['remote', 'remove', name]);
}

/** `git rev-list --left-right --count HEAD...origin/<branch>` -> { ahead, behind }. Assumes fetch already happened. */
export async function aheadBehind(dir: string, branch: string): Promise<{ ahead: number; behind: number }> {
  try {
    const { stdout } = await execGit(dir, ['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`]);
    const [ahead, behind] = stdout
      .trim()
      .split(/\s+/)
      .map((n) => Number(n) || 0);
    return { ahead: ahead ?? 0, behind: behind ?? 0 };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

export async function currentBranch(dir: string): Promise<string> {
  const { stdout } = await execGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return stdout.trim() || 'main';
}

/**
 * `git log --follow` for one file, mapped to PageHistoryEntry. Newest first,
 * capped at `max`. `askpassScript`/`spaceSlug`: in a partial clone,
 * `--follow`'s rename detection needs the historical blobs to diff against,
 * so it can lazily fetch from the promisor remote same as `mergeFetchedRemote`
 * above — pass the same credentials or it fails the same way.
 */
export async function fileHistory(
  dir: string,
  relPath: string,
  max = 100,
  askpassScript?: string,
  spaceSlug?: string,
): Promise<PageHistoryEntry[]> {
  const sep = '\x1f'; // unit separator: won't appear in a commit subject
  const format = `%H${sep}%an${sep}%aI${sep}%s`;
  const { stdout } = await execGit(
    dir,
    ['log', `--max-count=${max}`, `--pretty=format:${format}`, '--follow', '--', relPath],
    remoteAuthEnv(askpassScript, spaceSlug),
  );
  if (!stdout.trim()) return [];
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, author, date, ...rest] = line.split(sep);
      return { sha, author, date, message: rest.join(sep) };
    });
}

/**
 * The file's content at `sha` — `git show sha:path`. Throws GitError if that
 * path didn't exist at that commit. `askpassScript`/`spaceSlug`: same partial-
 * clone lazy-fetch story as `fileHistory`/`mergeFetchedRemote` — the blob for
 * an old revision may not be local yet.
 */
export async function showFileAt(
  dir: string,
  sha: string,
  relPath: string,
  askpassScript?: string,
  spaceSlug?: string,
): Promise<string> {
  const { stdout } = await execGit(dir, ['show', `${sha}:${relPath}`], remoteAuthEnv(askpassScript, spaceSlug));
  return stdout;
}

/**
 * True if any *.md file under `root` (relative to `dir`) still has an
 * unresolved conflict marker. Plain Node fs recursion rather than `git
 * grep`'s pathspec globbing (whose "does a bare `*.md` cross directory
 * boundaries" behavior is subtle enough not to bet a status flag on).
 */
/**
 * Every tracked file across the WHOLE working tree (deliberately NOT scoped
 * to a rootPath — see hasConflictMarkers's own doc comment for the bug this
 * fixes: a conflict in a file outside the space's rootPath, in a repo shared
 * by multiple spaces, used to go unnoticed and get pushed) that still has an
 * unresolved git conflict marker at the start of a line.
 *
 * `git grep -l -E '^<<<<<<< |^>>>>>>> '` rather than hasConflictMarkers's own
 * hand-rolled fs walk: grep is git's own notion of "tracked file" (no need
 * to hand-maintain the .md/.excalidraw.svg extension list or reimplement
 * .gitignore-ish skipping), and it is git's own conflict-marker convention
 * being tested for, so the two can never drift apart. Called with cwd=dir
 * (the space's repo root), so it naturally covers the whole tree regardless
 * of the caller's own rootPath.
 *
 * Bypasses execGit deliberately: `git grep` exits 1 (not an error, no
 * stderr) when nothing matches, which execGit's wrapper would otherwise
 * report as a GitError — this treats "exit 1, no stderr" as the clean "no
 * conflicts" case and only re-throws a genuine failure.
 */
export async function listConflictedFiles(dir: string): Promise<string[]> {
  const args = ['grep', '-l', '-E', '^<<<<<<< |^>>>>>>> '];
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: dir, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    if (e.code === 1 && !e.stderr?.trim()) return []; // no matches — not a failure
    throw new GitError(args, e.stderr?.trim() || e.message || String(err));
  }
}

/**
 * "Take the version from Git" (owner ask: nobody is ever going to resolve a
 * git-native space's conflicts by hand) — throws away everything local and
 * makes HEAD match `origin/<branch>` exactly. The opposite of
 * mergeFetchedRemote/commitConflictState, which keep local conflict markers
 * as the merge's own resolution.
 *
 *  1. `fetch origin` (auth env, same as every other remote op here).
 *  2. Commit whatever is currently uncommitted first — `add -A` then a
 *     commit under FOLIO_COMMITTER, same identity/shape as
 *     commitConflictState — so the backup branch below is a COMPLETE
 *     snapshot of what's about to be discarded. If the index is mid-merge
 *     (MERGE_HEAD present), `add -A` clears every "unmerged path" from the
 *     index, so the plain `git commit` right after completes the merge (as
 *     an ordinary, if odd-shaped, commit) instead of refusing — exactly how
 *     commitConflictState already handles this same situation.
 *  3. If HEAD (after that commit, if any) differs from `origin/<branch>`,
 *     branch HEAD off as `folio-backup/<YYYYMMDD-HHMMSS>` — a real, ordinary
 *     ref this function never deletes, so recovering the discarded state
 *     later is a plain `git checkout`/`cherry-pick` away. `backupRef: null`
 *     when HEAD already matched the remote (nothing would be discarded).
 *  4. `changed` = every path `git diff --name-only HEAD origin/<branch>`
 *     reports — computed BEFORE the reset, i.e. exactly the files the reset
 *     is about to touch (added, removed, or changed).
 *  5. `git reset --hard origin/<branch>` then `git clean -fd` — working tree
 *     and index now match the remote exactly, untracked local-only files
 *     removed too.
 *
 * Every step that can lazily fetch a blob under this repo's partial clone
 * (`--filter=blob:none`, see clone()'s doc comment) — fetch, diff, reset,
 * clean — gets the auth env, not just fetch itself.
 */
/** Paths whose working-tree content differs from `origin/<branch>` — i.e. what a push could change on the remote. Repo-root relative, same as listConflictedFiles. */
export async function filesDifferingFromRemote(
  dir: string,
  branch: string,
  askpassScript?: string,
  spaceSlug?: string,
): Promise<string[]> {
  const { stdout } = await execGit(dir, ['diff', '--name-only', `origin/${branch}`], remoteAuthEnv(askpassScript, spaceSlug));
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function resetToRemote(
  dir: string,
  branch: string,
  askpassScript?: string,
  spaceSlug?: string,
): Promise<{ backupRef: string | null; changed: string[] }> {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' };
  if (askpassScript) {
    env.GIT_ASKPASS = askpassScript;
    if (spaceSlug) env.FOLIO_GIT_SPACE = spaceSlug;
  }

  await execGit(dir, ['fetch', 'origin'], env);

  await execGit(dir, ['add', '-A', '--', '.', ATOMIC_TEMP_PATHSPEC]);
  const { stdout: statusOut } = await execGit(dir, ['status', '--porcelain', '--untracked-files=no']);
  if (statusOut.trim()) {
    await execGit(dir, [
      '-c',
      `user.name=${FOLIO_COMMITTER.name}`,
      '-c',
      `user.email=${FOLIO_COMMITTER.email}`,
      'commit',
      '-m',
      'folio: snapshot before reset-to-remote',
    ]);
  }

  const { stdout: headOut } = await execGit(dir, ['rev-parse', 'HEAD']);
  const { stdout: remoteOut } = await execGit(dir, ['rev-parse', `origin/${branch}`]);
  let backupRef: string | null = null;
  if (headOut.trim() !== remoteOut.trim()) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp =
      `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-` +
      `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
    backupRef = `folio-backup/${stamp}`;
    await execGit(dir, ['branch', backupRef, 'HEAD']);
  }

  const { stdout: diffOut } = await execGit(dir, ['diff', '--name-only', 'HEAD', `origin/${branch}`], env);
  const changed = diffOut
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  await execGit(dir, ['reset', '--hard', `origin/${branch}`], env);
  await execGit(dir, ['clean', '-fd'], env);

  return { backupRef, changed };
}

/**
 * KNOWN BUG, left as-is (server/gitSync.ts's performSync now uses
 * listConflictedFiles instead — see that call site): this only walks
 * `rootPath`, so a conflict left in a file OUTSIDE the space's own rootPath
 * — reachable whenever multiple spaces share one repo — was invisible here
 * and got reported/pushed as clean. Kept around (and still exercised by
 * gitNative.test.ts) because it's a cheap, dependency-free rootPath-scoped
 * check that's still correct for the common case of one repo per space;
 * listConflictedFiles is the whole-tree, git-native replacement for the one
 * caller that actually needs to be right about the shared-repo case.
 */
export async function hasConflictMarkers(dir: string, rootRelPath: string): Promise<boolean> {
  const { readdir, readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const root = path.join(dir, rootRelPath || '');

  async function walk(abs: string): Promise<boolean> {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name.startsWith('.')) continue;
      const full = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        if (await walk(full)) return true;
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const content = await readFile(full, 'utf8').catch(() => '');
        if (content.includes('<<<<<<<')) return true;
      }
    }
    return false;
  }

  return walk(root);
}
