import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as git from './git.js';
import * as gitSync from './gitSync.js';
import * as collab from './collab.js';
import * as Y from 'yjs';
import { query } from './db/pool.js';
import * as os from 'node:os';

// Every "remote" in this file is a plain local bare repo. git.ts's clone
// family rejects those by default (QA-3 P0: a schemeless local path is a
// clone of any directory on the server), so this file opts in explicitly —
// see git.ts's __allowLocalRepoPathsForTests. It never relaxes the
// ROUTE-level guard, which is what an HTTP request actually hits.
git.__allowLocalRepoPathsForTests();

describe('git-native spaces (round 3, real git + real PG)', () => {
  let teardownSchema: () => Promise<void>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  it('a new empty space is git-initialized with a translit-slugged directory name and one commit', async () => {
    const space = await storage.createSpace('Test Space Round 3', null);
    expect(space.slug).toBe('test-space-round-3');
    const dir = storage.getRepoDir(space.slug);
    expect(await git.isGitRepo(dir)).toBe(true);
    const history = await git.fileHistory(dir, 'index.md');
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].message).toContain('init');

    await deleteTestSpace(space.slug);
  });

  it('tree: index/README dirs, same-named page parents, and genuine synthetic folders', async () => {
    const space = await storage.createSpace(`Tree Shapes ${Date.now()}`, null);
    const dir = storage.getSpaceDir(space.slug);

    await fs.mkdir(path.join(dir, 'has-index'), { recursive: true });
    await fs.writeFile(path.join(dir, 'has-index', 'index.md'), '# Has Index\n\nContent.\n', 'utf8');

    await fs.mkdir(path.join(dir, 'has-readme'), { recursive: true });
    await fs.writeFile(path.join(dir, 'has-readme', 'README.md'), '# Has Readme\n\nContent.\n', 'utf8');
    await fs.writeFile(path.join(dir, 'has-readme', 'sibling.md'), '# Sibling\n', 'utf8');

    await fs.mkdir(path.join(dir, 'has-neither', 'nested'), { recursive: true });
    await fs.writeFile(path.join(dir, 'has-neither', 'nested', 'deep.md'), '# Deep\n', 'utf8');

    await fs.writeFile(path.join(dir, 'parent.md'), '# Parent Page\n', 'utf8');
    await fs.mkdir(path.join(dir, 'parent'), { recursive: true });
    await fs.writeFile(path.join(dir, 'parent', 'child.md'), '# Child Page\n', 'utf8');

    await storage.scanSpace(space.slug);
    const tree = await storage.getTree(space.slug);
    const root = tree[0];
    const byPath = new Map(root.children.map((c) => [c.path, c]));

    const hasIndexNode = byPath.get('has-index/index.md');
    expect(hasIndexNode?.kind).toBe('doc');
    expect(hasIndexNode?.title).toBe('Has Index');

    const hasReadmeNode = byPath.get('has-readme/README.md');
    expect(hasReadmeNode?.kind).toBe('doc');
    expect(hasReadmeNode?.title).toBe('Has Readme');
    expect(hasReadmeNode?.children.map((c) => c.path)).toEqual(['has-readme/sibling.md']);

    const folderNode = root.children.find((c) => c.kind === 'folder' && c.path === 'has-neither');
    expect(folderNode).toBeDefined();
    expect(folderNode!.id).toBe('dir:has-neither');
    expect(folderNode!.title).toBe('Has Neither');
    // the nested/ directory under it ALSO has neither index nor README -> another folder node
    const nestedFolder = folderNode!.children.find((c) => c.kind === 'folder');
    expect(nestedFolder?.path).toBe('has-neither/nested');
    expect(nestedFolder?.children.map((c) => c.path)).toEqual(['has-neither/nested/deep.md']);

    // X.md + X/ is one real, navigable parent page — never a sibling page
    // plus a fake folder with the same title/icon.
    const parentNode = byPath.get('parent.md');
    expect(parentNode?.kind).toBe('doc');
    expect(parentNode?.title).toBe('Parent Page');
    expect(parentNode?.children.map((c) => c.path)).toEqual(['parent/child.md']);
    expect(root.children.some((c) => c.kind === 'folder' && c.path === 'parent')).toBe(false);
    expect((await storage.resolve(space.slug, 'parent')).id).toBe(parentNode?.id);

    // a synthetic folder id is never a valid page id
    await expect(storage.requireEntry('dir:has-neither')).rejects.toThrow();

    await deleteTestSpace(space.slug);
  });

  it('_templates/ is hidden from the tree but reachable via listTemplates', async () => {
    const space = await storage.createSpace(`Templates ${Date.now()}`, null);
    await storage.createPage({ space: space.slug, parentPath: '_templates', title: 'Weekly Update', kind: 'doc' });

    const tree = await storage.getTree(space.slug);
    expect(tree[0].children.some((c) => c.path.startsWith('_templates'))).toBe(false);

    const templates = await storage.listTemplates(space.slug);
    expect(templates.some((t) => t.title === 'Weekly Update')).toBe(true);

    await deleteTestSpace(space.slug);
  });

  it('scanSpace skips unchanged files on a re-scan (mtime+size staleness)', async () => {
    // createSpace() already runs one scanSpace() internally (reading the fresh index.md
    // it just wrote), so the next call here is already the SECOND scan of that file.
    const space = await storage.createSpace(`Staleness ${Date.now()}`, null);
    const rescan = await storage.scanSpace(space.slug);
    expect(rescan.filesRead).toBe(0);
    expect(rescan.filesSkipped).toBeGreaterThanOrEqual(1); // index.md, unchanged since creation

    await storage.createPage({ space: space.slug, parentPath: '', title: 'New Page', kind: 'doc' });
    const afterNewPage = await storage.scanSpace(space.slug);
    expect(afterNewPage.filesRead).toBe(0); // createPage's own internal scan already indexed it
    expect(afterNewPage.filesSkipped).toBe(2); // index.md + new-page.md, both now unchanged

    await deleteTestSpace(space.slug);
  });

  it('history + restore against a real repo with several commits', async () => {
    const space = await storage.createSpace(`History ${Date.now()}`, null);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Versioned', kind: 'doc' });

    await storage.writeDocBody(page.id, '# Versioned\n\nFirst body.\n');
    await git.commitAll(storage.getRepoDir(space.slug), 'docs: v1', { name: 'Tester', email: 't@example.test' });
    await storage.writeDocBody(page.id, '# Versioned\n\nSecond body.\n');
    await git.commitAll(storage.getRepoDir(space.slug), 'docs: v2', { name: 'Tester', email: 't@example.test' });

    const history = await gitSync.getPageHistory(page.id);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0].message).toBe('docs: v2'); // newest first

    const olderSha = history[history.length - 1].sha;
    const atOldSha = await gitSync.getPageAtSha(page.id, olderSha);
    expect(atOldSha.markdown).not.toMatch(/^---/); // frontmatter stripped, same as a live GET

    await deleteTestSpace(space.slug);
  });

  it('conflict detection: a diverged merge lands with markers and status=conflict, clearing once resolved', async () => {
    const bareDir = path.join(os.tmpdir(), `folio-test-bare-${Date.now()}.git`);
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bareDir]);

    // git can't clone a specific branch that doesn't exist yet — seed the bare repo with
    // one commit via a throwaway local clone before createSpaceFromRepo touches it.
    const seedDir = path.join(os.tmpdir(), `folio-test-seed-${Date.now()}`);
    await fs.mkdir(seedDir, { recursive: true });
    await git.initWithCommit(seedDir, 'seed placeholder'); // `git init -b main`; nothing to commit yet so this is a no-op commit
    await fs.writeFile(path.join(seedDir, 'index.md'), '---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n---\n# Conflict Space\n\noriginal\n', 'utf8');
    await git.commitAll(seedDir, 'seed', { name: 'Tester', email: 't@example.test' });
    await execFileAsync('git', ['remote', 'add', 'origin', bareDir], { cwd: seedDir });
    await git.push(seedDir, 'main');
    await fs.rm(seedDir, { recursive: true, force: true });

    const space = await storage.createSpaceFromRepo({ name: `Conflict ${Date.now()}`, repoUrl: bareDir, branch: 'main', rootPath: '', createdBy: null });
    const dir = storage.getRepoDir(space.slug);
    await storage.scanSpace(space.slug);

    // A second independent clone diverges on the same file.
    const dir2 = path.join(os.tmpdir(), `folio-test-clone2-${Date.now()}`);
    await git.clone(bareDir, dir2, 'main');
    await fs.writeFile(path.join(dir2, 'index.md'), '---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n---\n# Conflict Space\n\nchange from clone2\n', 'utf8');
    await git.commitAll(dir2, 'change from clone2', { name: 'Other', email: 'o@example.test' });
    await git.push(dir2, 'main');

    // Space 1 also changes the same line differently, then syncs -> should conflict.
    await fs.writeFile(path.join(dir, 'index.md'), '---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n---\n# Conflict Space\n\nchange from space1\n', 'utf8');
    const result = await gitSync.performSync(space.slug);
    expect(result.status).toBe('conflict');
    const infoConflict = await storage.getSpaceInfo(space.slug);
    expect(infoConflict?.git?.status).toBe('conflict');
    expect(await git.hasConflictMarkers(dir, '')).toBe(true);

    // Resolve by writing clean content and syncing again -> status clears.
    await fs.writeFile(path.join(dir, 'index.md'), '---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n---\n# Conflict Space\n\nresolved\n', 'utf8');
    const resolved = await gitSync.performSync(space.slug);
    expect(resolved.status).not.toBe('conflict');
    expect(await git.hasConflictMarkers(dir, '')).toBe(false);

    await deleteTestSpace(space.slug);
    await fs.rm(bareDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(dir2, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  it('round 22: a clean (non-conflicting) merge during sync — local AND remote edits both survive, merged together, and the merge is genuinely PUSHED to the remote (not just merged locally)', async () => {
    const bareDir = path.join(os.tmpdir(), `folio-test-bare-clean-${Date.now()}.git`);
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bareDir]);

    const seedDir = path.join(os.tmpdir(), `folio-test-seed-clean-${Date.now()}`);
    await fs.mkdir(seedDir, { recursive: true });
    await git.initWithCommit(seedDir, 'seed placeholder');
    await fs.writeFile(path.join(seedDir, 'index.md'), '---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAX\n---\n# Clean Merge Space\n\noriginal\n', 'utf8');
    await git.commitAll(seedDir, 'seed', { name: 'Tester', email: 't@example.test' });
    await execFileAsync('git', ['remote', 'add', 'origin', bareDir], { cwd: seedDir });
    await git.push(seedDir, 'main');
    await fs.rm(seedDir, { recursive: true, force: true });

    const space = await storage.createSpaceFromRepo({ name: `Clean Merge ${Date.now()}`, repoUrl: bareDir, branch: 'main', rootPath: '', createdBy: null });
    const dir = storage.getRepoDir(space.slug);
    await storage.scanSpace(space.slug);

    // Someone else pushes a NEW, unrelated file straight to the remote — simulating a
    // teammate's own sync (or a direct git push) that landed while we were also editing.
    const dir2 = path.join(os.tmpdir(), `folio-test-clone2-clean-${Date.now()}`);
    await git.clone(bareDir, dir2, 'main');
    await fs.writeFile(path.join(dir2, 'from-remote.md'), '# From Remote\n\nAdded on the remote side.\n', 'utf8');
    await git.commitAll(dir2, 'add from-remote.md', { name: 'Other', email: 'o@example.test' });
    await git.push(dir2, 'main');

    // Meanwhile THIS space gets its own new, non-overlapping local file — deliberately
    // left UNCOMMITTED here, since commitAll-ing it is exactly what performSync itself
    // is supposed to do as the first step of its cycle.
    await fs.writeFile(path.join(dir, 'from-local.md'), '# From Local\n\nAdded locally, not yet synced.\n', 'utf8');

    const result = await gitSync.performSync(space.slug);
    expect(result.status).not.toBe('conflict');
    expect(result.status).not.toBe('error');
    expect(result.lastError).toBeNull();

    // Both edits survive LOCALLY, merged together (neither one clobbered the other).
    expect(await fs.readFile(path.join(dir, 'from-local.md'), 'utf8')).toContain('Added locally');
    expect(await fs.readFile(path.join(dir, 'from-remote.md'), 'utf8')).toContain('Added on the remote side');

    // And the push genuinely reached the remote: a THIRD, independent fresh clone —
    // never touched by either side above — proves it, not just this process's own view.
    const dir3 = path.join(os.tmpdir(), `folio-test-clone3-clean-${Date.now()}`);
    await git.clone(bareDir, dir3, 'main');
    expect(await fs.readFile(path.join(dir3, 'from-local.md'), 'utf8')).toContain('Added locally');
    expect(await fs.readFile(path.join(dir3, 'from-remote.md'), 'utf8')).toContain('Added on the remote side');

    const info = await storage.getSpaceInfo(space.slug);
    expect(info?.git?.status).toBe('clean');
    expect(info?.git?.ahead).toBe(0);
    expect(info?.git?.behind).toBe(0);

    await deleteTestSpace(space.slug);
    await fs.rm(bareDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(dir2, { recursive: true, force: true }).catch(() => {});
    await fs.rm(dir3, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  it('round 22: a conflicting sync commits the conflict-marker state LOCALLY but never pushes it — the remote tip is unaffected, and BOTH sides\' text survive inside the markers (no silent data loss/pick-one-side resolution)', async () => {
    const bareDir = path.join(os.tmpdir(), `folio-test-bare-nopush-${Date.now()}.git`);
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bareDir]);

    const seedDir = path.join(os.tmpdir(), `folio-test-seed-nopush-${Date.now()}`);
    await fs.mkdir(seedDir, { recursive: true });
    await git.initWithCommit(seedDir, 'seed placeholder');
    await fs.writeFile(path.join(seedDir, 'index.md'), '---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAW\n---\n# Conflict No Push\n\noriginal\n', 'utf8');
    await git.commitAll(seedDir, 'seed', { name: 'Tester', email: 't@example.test' });
    await execFileAsync('git', ['remote', 'add', 'origin', bareDir], { cwd: seedDir });
    await git.push(seedDir, 'main');
    await fs.rm(seedDir, { recursive: true, force: true });

    const space = await storage.createSpaceFromRepo({ name: `Conflict No Push ${Date.now()}`, repoUrl: bareDir, branch: 'main', rootPath: '', createdBy: null });
    const dir = storage.getRepoDir(space.slug);
    await storage.scanSpace(space.slug);

    const dir2 = path.join(os.tmpdir(), `folio-test-clone2-nopush-${Date.now()}`);
    await git.clone(bareDir, dir2, 'main');
    await fs.writeFile(path.join(dir2, 'index.md'), '---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAW\n---\n# Conflict No Push\n\nchange from REMOTE side\n', 'utf8');
    await git.commitAll(dir2, 'change from clone2', { name: 'Other', email: 'o@example.test' });
    await git.push(dir2, 'main');
    const remoteTipAfterOtherPush = (await execFileAsync('git', ['rev-parse', 'main'], { cwd: bareDir })).stdout.trim();

    await fs.writeFile(path.join(dir, 'index.md'), '---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAW\n---\n# Conflict No Push\n\nchange from LOCAL side\n', 'utf8');
    const result = await gitSync.performSync(space.slug);
    expect(result.status).toBe('conflict');

    // The remote's tip must be EXACTLY what clone2 pushed — our conflicted merge commit
    // never reached it (no partial/half push of broken content onto the shared remote).
    const remoteTipAfterConflictedSync = (await execFileAsync('git', ['rev-parse', 'main'], { cwd: bareDir })).stdout.trim();
    expect(remoteTipAfterConflictedSync).toBe(remoteTipAfterOtherPush);

    // Both sides' actual text must be recoverable from the marker-laden file.
    const markedContent = await fs.readFile(path.join(dir, 'index.md'), 'utf8');
    expect(markedContent).toContain('change from LOCAL side');
    expect(markedContent).toContain('change from REMOTE side');
    expect(markedContent).toContain('<<<<<<<');
    expect(markedContent).toContain('=======');
    expect(markedContent).toContain('>>>>>>>');

    await deleteTestSpace(space.slug);
    await fs.rm(bareDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(dir2, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  it('createSpaceFromRepo against a genuinely empty remote bootstraps main + a README instead of failing', async () => {
    const bareDir = path.join(os.tmpdir(), `folio-test-empty-remote-${Date.now()}.git`);
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    // Bare, zero commits, zero refs — a --branch-scoped clone would fail outright
    // against this ("fatal: Remote branch main not found in upstream origin").
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bareDir]);

    const space = await storage.createSpaceFromRepo({
      name: `Empty Remote ${Date.now()}`,
      repoUrl: bareDir,
      branch: 'main',
      rootPath: '',
      createdBy: null,
    });
    const dir = storage.getRepoDir(space.slug);

    expect(await git.currentBranch(dir)).toBe('main');
    const log = await git.fileHistory(dir, 'README.md');
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(await fs.readFile(path.join(dir, 'README.md'), 'utf8')).toContain('Folio content repo');

    // pushed, not just committed locally — the bare "remote" now has main + the commit too.
    const remoteBranches = await execFileAsync('git', ['branch', '-a'], { cwd: bareDir });
    expect(remoteBranches.stdout).toMatch(/\bmain\b/);
    const remoteLog = await execFileAsync('git', ['log', '--oneline', 'main'], { cwd: bareDir });
    expect(remoteLog.stdout.trim().length).toBeGreaterThan(0);

    // README.md becomes the root page (no index.md) — the space isn't empty of content.
    expect(space.pageCount).toBeGreaterThanOrEqual(1);

    await deleteTestSpace(space.slug);
    await fs.rm(bareDir, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  it('createSpaceFromRepo auto-creates a rootPath that does not exist yet in the cloned repo, and still rejects ".."', async () => {
    const bareDir = path.join(os.tmpdir(), `folio-test-rootpath-${Date.now()}.git`);
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bareDir]);

    // Seed the bare repo with SOME content at the root, but nothing under the folder
    // this test is about to request as rootPath — same "seed via a throwaway clone"
    // approach as the conflict-detection test above (can't clone a branch that has no
    // commits yet).
    const seedDir = path.join(os.tmpdir(), `folio-test-rootpath-seed-${Date.now()}`);
    await fs.mkdir(seedDir, { recursive: true });
    await git.initWithCommit(seedDir, 'seed placeholder');
    await fs.writeFile(path.join(seedDir, 'existing.md'), '# Existing\n', 'utf8');
    await git.commitAll(seedDir, 'seed', { name: 'Tester', email: 't@example.test' });
    await execFileAsync('git', ['remote', 'add', 'origin', bareDir], { cwd: seedDir });
    await git.push(seedDir, 'main');
    await fs.rm(seedDir, { recursive: true, force: true });

    const spaceName = `Root Path Auto Create ${Date.now()}`;
    const space = await storage.createSpaceFromRepo({
      name: spaceName,
      repoUrl: bareDir,
      branch: 'main',
      rootPath: 'a-new-space-folder',
      createdBy: null,
    });
    const dir = storage.getRepoDir(space.slug);

    const indexPath = path.join(dir, 'a-new-space-folder', 'index.md');
    expect(await fs.readFile(indexPath, 'utf8')).toContain(`# ${spaceName}`);

    const log = await git.fileHistory(dir, 'a-new-space-folder/index.md');
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[0].message).toBe(`docs(${space.slug}): init space`);

    // pushed too, not just local.
    const remoteLog = await execFileAsync('git', ['log', '--oneline', '--', 'a-new-space-folder/index.md'], { cwd: bareDir });
    expect(remoteLog.stdout.trim().length).toBeGreaterThan(0);

    await deleteTestSpace(space.slug);
    await fs.rm(bareDir, { recursive: true, force: true }).catch(() => {});

    // ".." must still be rejected outright — no clone, no directory, no space row.
    await expect(
      storage.createSpaceFromRepo({ name: 'Escape Attempt', repoUrl: bareDir, branch: 'main', rootPath: '../escape', createdBy: null }),
    ).rejects.toThrow(/invalid path/);
  }, 30_000);

  it('connectSpaceToRepo: an empty remote connects — origin added, local content pushed, space becomes remote/clean', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const space = await storage.createSpace(`Connect Empty ${Date.now()}`, null);
    await storage.createPage({ space: space.slug, parentPath: '', title: 'Local Only Page', kind: 'doc' });
    const dir = storage.getRepoDir(space.slug);
    const localHeadBefore = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();

    const bareDir = path.join(os.tmpdir(), `folio-test-connect-empty-${Date.now()}.git`);
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bareDir]);

    const info = await storage.connectSpaceToRepo(space.slug, { repoUrl: bareDir, branch: 'main' });

    expect(info.git?.repoUrl).toBe(bareDir);
    expect(info.git?.branch).toBe('main');
    expect(info.git?.status).toBe('clean');

    // origin was actually added, and the LOCAL commit history (not a fresh
    // clone-and-replace) is what ended up on the remote. HEAD moved forward
    // from before connecting — createPage above never commits by itself (it
    // relies on gitSync's own debounced auto-commit), so connecting had a
    // genuinely uncommitted page to fold in — but the ORIGINAL init commit is
    // still its ancestor (exit code 0 from `merge-base --is-ancestor`):
    // nothing about the pre-existing history was rewritten, only extended.
    expect(await git.hasRemote(dir)).toBe(true);
    const localHeadAfter = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    expect(localHeadAfter).not.toBe(localHeadBefore);
    await expect(execFileAsync('git', ['merge-base', '--is-ancestor', localHeadBefore, localHeadAfter], { cwd: dir })).resolves.toBeTruthy();
    const remoteHead = (await execFileAsync('git', ['rev-parse', 'main'], { cwd: bareDir })).stdout.trim();
    expect(remoteHead).toBe(localHeadAfter);

    // the space's own pre-existing content is exactly what's on the remote now.
    const remoteLog = await execFileAsync('git', ['log', '--oneline', '--', 'local-only-page.md'], { cwd: bareDir });
    expect(remoteLog.stdout.trim().length).toBeGreaterThan(0);

    // local content is untouched on disk too.
    expect(await fs.readFile(path.join(dir, 'index.md'), 'utf8')).toContain(`# Connect Empty`);

    await deleteTestSpace(space.slug);
    await fs.rm(bareDir, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  it('connectSpaceToRepo: a NON-empty remote is refused (409-style conflict) — no origin added, no push, local content and history untouched', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const space = await storage.createSpace(`Connect NonEmpty ${Date.now()}`, null);
    await storage.createPage({ space: space.slug, parentPath: '', title: 'Precious Local Page', kind: 'doc' });
    const dir = storage.getRepoDir(space.slug);
    const localHeadBefore = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    const remoteBefore = await git.hasRemote(dir);
    expect(remoteBefore).toBe(false);

    // A non-empty remote: seed it with its OWN unrelated history via a throwaway clone.
    const bareDir = path.join(os.tmpdir(), `folio-test-connect-nonempty-${Date.now()}.git`);
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bareDir]);
    const seedDir = path.join(os.tmpdir(), `folio-test-connect-nonempty-seed-${Date.now()}`);
    await fs.mkdir(seedDir, { recursive: true });
    await git.initWithCommit(seedDir, 'seed: unrelated history');
    await fs.writeFile(path.join(seedDir, 'stranger.md'), '# Stranger repo\n', 'utf8');
    await git.commitAll(seedDir, 'seed content', { name: 'Tester', email: 't@example.test' });
    await execFileAsync('git', ['remote', 'add', 'origin', bareDir], { cwd: seedDir });
    await git.push(seedDir, 'main');
    await fs.rm(seedDir, { recursive: true, force: true });

    await expect(storage.connectSpaceToRepo(space.slug, { repoUrl: bareDir, branch: 'main' })).rejects.toThrow(/repository is not empty/);

    // Nothing about the local space changed: no origin, HEAD unmoved, file still there,
    // and the DB row still reports it as local (no repoUrl).
    expect(await git.hasRemote(dir)).toBe(false);
    const localHeadAfter = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    expect(localHeadAfter).toBe(localHeadBefore);
    expect(await fs.readFile(path.join(dir, 'index.md'), 'utf8')).toContain('# Connect NonEmpty');
    const infoAfter = await storage.getSpaceInfo(space.slug);
    expect(infoAfter?.git?.repoUrl).toBeNull();
    expect(infoAfter?.git?.status).toBe('local');

    // the "stranger" remote itself is untouched too — refusing never force-pushes over it.
    const remoteLog = await execFileAsync('git', ['log', '--oneline', 'main'], { cwd: bareDir });
    expect(remoteLog.stdout).toContain('seed content');
    expect(remoteLog.stdout).not.toContain('Precious Local Page');

    await deleteTestSpace(space.slug);
    await fs.rm(bareDir, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  it('connectSpaceToRepo: refuses a space that already has a repoUrl (already connected), leaving the existing connection untouched', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const originBareDir = path.join(os.tmpdir(), `folio-test-connect-already-origin-${Date.now()}.git`);
    await execFileAsync('git', ['init', '--bare', '-b', 'main', originBareDir]);
    const space = await storage.createSpaceFromRepo({
      name: `Already Connected ${Date.now()}`,
      repoUrl: originBareDir,
      branch: 'main',
      rootPath: '',
      createdBy: null,
    });

    const otherBareDir = path.join(os.tmpdir(), `folio-test-connect-already-other-${Date.now()}.git`);
    await execFileAsync('git', ['init', '--bare', '-b', 'main', otherBareDir]);

    await expect(storage.connectSpaceToRepo(space.slug, { repoUrl: otherBareDir, branch: 'main' })).rejects.toThrow(/already connected/);

    const infoAfter = await storage.getSpaceInfo(space.slug);
    expect(infoAfter?.git?.repoUrl).toBe(originBareDir); // unchanged — still pointed at the original repo

    await deleteTestSpace(space.slug);
    await fs.rm(originBareDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(otherBareDir, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  it('board history: getPageAtSha returns { svg } (not markdown) for a board page, and restore applies it through writeBoardSvg', async () => {
    const space = await storage.createSpace(`Board History ${Date.now()}`, null);
    const board = await storage.createPage({ space: space.slug, parentPath: '', title: 'Diagram', kind: 'board' });
    const dir = storage.getRepoDir(space.slug);

    const svgV1 = boardSvgWithPayload('v1-payload');
    await storage.writeBoardSvg(board.id, svgV1);
    await git.commitAll(dir, 'docs: board v1', { name: 'Tester', email: 't@example.test' });

    const svgV2 = boardSvgWithPayload('v2-payload');
    await storage.writeBoardSvg(board.id, svgV2);
    await git.commitAll(dir, 'docs: board v2', { name: 'Tester', email: 't@example.test' });

    const history = await gitSync.getPageHistory(board.id);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0].message).toBe('docs: board v2');

    const olderSha = history[history.length - 1].sha;
    const atOldSha = await gitSync.getPageAtSha(board.id, olderSha);
    expect(atOldSha.markdown).toBeUndefined();
    expect(atOldSha.svg).toBeDefined();
    expect(atOldSha.svg).toContain('folio-id'); // raw file, id comment included as it was at that sha

    await deleteTestSpace(space.slug);
  });

  /**
   * Round 26 (DATA TABLES), MANDATORY per the round's brief: gitSync.getPageAtSha
   * strips frontmatter for every non-board kind (`stripFrontmatterBody`) — correct
   * for a doc (frontmatter is just id/order/status), but for a table the
   * "frontmatter" IS the schema (columns/views/options). Stripping it on a
   * historical read would silently return a revision with no column schema, and
   * POST /:id/restore/:sha round-trips this response straight back through the
   * write path — so restoring an old table revision would previously have
   * destroyed its columns. This proves getPageAtSha returns the RAW file for a
   * table (so the columns survive), by parsing the response back into a full
   * TableDoc via the same shared/tables codec the write path itself uses.
   */
  it('table history: getPageAtSha returns the RAW file (schema intact) for a table page, not frontmatter-stripped', async () => {
    const space = await storage.createSpace(`Table History ${Date.now()}`, null);
    const table = await storage.createPage({
      space: space.slug,
      parentPath: '',
      title: 'Weekly Plan',
      kind: 'table',
      columns: [{ id: 'owner', name: 'Owner', type: 'text' }],
    });
    const dir = storage.getRepoDir(space.slug);

    // v1: one row, committed.
    const v1 = await storage.readFreshTableDoc(table.id);
    await storage.writeTableDoc(table.id, { ...v1, rows: [{ id: 'r0000001', values: { owner: 'alice' } }] });
    await git.commitAll(dir, 'docs: table v1', { name: 'Tester', email: 't@example.test' });

    // v2: a SECOND column added (the schema itself changes, not just row data) and a
    // second row — this is what would be silently destroyed on restore if getPageAtSha
    // stripped the frontmatter back down to nothing.
    const v2 = await storage.readFreshTableDoc(table.id);
    await storage.writeTableDoc(table.id, {
      ...v2,
      columns: [...v2.columns, { id: 'status', name: 'Status', type: 'status', options: [{ value: 'DONE', color: 'green' }] }],
      rows: [{ id: 'r0000001', values: { owner: 'alice', status: 'DONE' } }, { id: 'r0000002', values: { owner: 'bob', status: null } }],
    });
    await git.commitAll(dir, 'docs: table v2', { name: 'Tester', email: 't@example.test' });

    const history = await gitSync.getPageHistory(table.id);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0].message).toBe('docs: table v2');

    const olderSha = history[history.length - 1].sha;
    const atOldSha = await gitSync.getPageAtSha(table.id, olderSha);
    expect(atOldSha.svg).toBeUndefined();
    expect(atOldSha.markdown).toBeDefined();
    expect(atOldSha.markdown).toMatch(/^---/); // RAW file: frontmatter present, NOT stripped
    expect(atOldSha.markdown).toContain('folio: table');

    // The full round-trip the restore path depends on: the raw text at the old sha
    // parses back into a TableDoc whose column schema (v1: just "owner") is intact.
    const { parseTableFile, isTableParseError } = await import('../shared/tables/index.js');
    const parsedOld = parseTableFile(atOldSha.markdown!);
    expect(isTableParseError(parsedOld)).toBe(false);
    if (!isTableParseError(parsedOld)) {
      expect(parsedOld.columns.map((c) => c.id)).toEqual(['owner']); // v1 schema, NOT v2's ["owner","status"]
      expect(parsedOld.rows).toEqual([{ id: 'r0000001', values: { owner: 'alice' } }]);
    }

    // And the CURRENT (v2) file, read fresh, has the v2 schema — confirms the old-sha
    // read above genuinely reflects history, not just always echoing the latest file.
    const current = await storage.readFreshTableDoc(table.id);
    expect(current.columns.map((c) => c.id)).toEqual(['owner', 'status']);

    await deleteTestSpace(space.slug);
  });
});

/** A minimal but structurally real excalidraw SVG export: the leading folio-id
 * comment plus a non-empty <!-- payload-start -->...<!-- payload-end --> block,
 * matching what excalidraw itself embeds (server/storage.ts's
 * hasExcalidrawScenePayload() only cares that this block is non-empty, not that
 * it's valid excalidraw JSON). */
function boardSvgWithPayload(payload: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><metadata><!-- payload-type:application/vnd.excalidraw+json --><!-- payload-start -->${payload}<!-- payload-end --></metadata></svg>\n`;
}

describe('git.listRemoteBranches / git.validateRepoUrl (round: create-space branch picker)', () => {
  // listRemoteBranches rejects anything but http(s)/ssh/git@ (validateRepoUrl,
  // by design) — so exercising its REAL success path (not just the parser in
  // isolation) needs an actual reachable http:// URL, not a bare local path
  // the way every other fixture in this file uses. git's "dumb http" protocol
  // makes that cheap: `git update-server-info` on a bare repo produces static
  // files (info/refs, HEAD, objects/*) that any plain static file server can
  // serve — no real network, no smart-http backend, just Node's http module
  // pointed at the bare repo's own directory.
  async function serveDumbHttp(bareDir: string): Promise<{ url: string; close: () => Promise<void> }> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('git', ['update-server-info'], { cwd: bareDir });

    const http = await import('node:http');
    const server = http.createServer((req, res) => {
      void (async () => {
        try {
          const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
          const abs = path.join(bareDir, urlPath);
          if (!abs.startsWith(bareDir)) {
            res.writeHead(403).end();
            return;
          }
          const data = await fs.readFile(abs);
          res.writeHead(200).end(data);
        } catch {
          res.writeHead(404).end();
        }
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return {
      url: `http://127.0.0.1:${port}/`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it('lists branches sorted with the default branch first, detected via the symref line', async () => {
    const bareDir = path.join(os.tmpdir(), `folio-test-branches-${Date.now()}.git`);
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bareDir]);

    const seedDir = path.join(os.tmpdir(), `folio-test-branches-seed-${Date.now()}`);
    await fs.mkdir(seedDir, { recursive: true });
    await git.initWithCommit(seedDir, 'seed placeholder');
    await fs.writeFile(path.join(seedDir, 'f.md'), 'main\n', 'utf8');
    await git.commitAll(seedDir, 'main commit', { name: 'Tester', email: 't@example.test' });
    await execFileAsync('git', ['remote', 'add', 'origin', bareDir], { cwd: seedDir });
    await git.push(seedDir, 'main');
    await execFileAsync('git', ['checkout', '-b', 'zzz-branch'], { cwd: seedDir });
    await git.push(seedDir, 'zzz-branch');
    await execFileAsync('git', ['checkout', '-b', 'aaa-branch'], { cwd: seedDir });
    await git.push(seedDir, 'aaa-branch');
    await fs.rm(seedDir, { recursive: true, force: true });

    const server = await serveDumbHttp(bareDir);
    try {
      const result = await git.listRemoteBranches(server.url);
      expect(result.defaultBranch).toBe('main');
      expect(result.branches).toEqual(['main', 'aaa-branch', 'zzz-branch']); // default first, rest alphabetical
    } finally {
      await server.close();
    }

    await fs.rm(bareDir, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  it('a genuinely empty remote reports zero branches and no default', async () => {
    const bareDir = path.join(os.tmpdir(), `folio-test-branches-empty-${Date.now()}.git`);
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bareDir]);

    const server = await serveDumbHttp(bareDir);
    try {
      const result = await git.listRemoteBranches(server.url);
      expect(result.branches).toEqual([]);
      expect(result.defaultBranch).toBeNull();
    } finally {
      await server.close();
    }

    await fs.rm(bareDir, { recursive: true, force: true }).catch(() => {});
  });

  it('validateRepoUrl accepts https/ssh/git@ and rejects file://, ext::, dash-prefixed, and empty', () => {
    expect(() => git.validateRepoUrl('https://gitlab.example.com/org/repo.git')).not.toThrow();
    expect(() => git.validateRepoUrl('http://gitlab.example.com/org/repo.git')).not.toThrow();
    expect(() => git.validateRepoUrl('ssh://git@example.com/org/repo.git')).not.toThrow();
    expect(() => git.validateRepoUrl('git@example.com:org/repo.git')).not.toThrow();

    expect(() => git.validateRepoUrl('file:///etc/passwd')).toThrow(/invalid repository URL/);
    expect(() => git.validateRepoUrl('ext::sh -c touch /tmp/pwned')).toThrow(/invalid repository URL/);
    expect(() => git.validateRepoUrl('--upload-pack=/bin/sh')).toThrow(/invalid repository URL/);
    expect(() => git.validateRepoUrl('-x')).toThrow(/invalid repository URL/);
    expect(() => git.validateRepoUrl('')).toThrow(/invalid repository URL/);
  });

  it('listRemoteBranches itself rejects a disallowed scheme before ever shelling out to git', async () => {
    await expect(git.listRemoteBranches('file:///etc')).rejects.toThrow(/invalid repository URL/);
    await expect(git.listRemoteBranches('ext::sh -c "echo pwned"')).rejects.toThrow(/invalid repository URL/);
  });
});

describe('icon/cover in PageMeta/TreeNode (round 5, fixed: was silently dropped on the live-doc PUT path)', () => {
  let teardownSchema: () => Promise<void>;
  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  it('writeDocBody with icon+cover -> toPageMeta and a fresh GET-equivalent both carry them', async () => {
    const space = await storage.createSpace(`Icon Meta ${Date.now()}`, null);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Iconed', kind: 'doc' });

    const meta = await storage.writeDocBody(page.id, '# Iconed\n\nBody.\n', '🚀', 'https://example.com/cover.png');
    expect(meta.icon).toBe('🚀');
    expect(meta.cover).toBe('https://example.com/cover.png');

    const reread = storage.toPageMeta(await storage.requireEntry(page.id));
    expect(reread.icon).toBe('🚀');
    expect(reread.cover).toBe('https://example.com/cover.png');

    await deleteTestSpace(space.slug);
  });

  it('a tree node for a page with an icon carries it', async () => {
    const space = await storage.createSpace(`Icon Tree ${Date.now()}`, null);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Tree Iconed', kind: 'doc' });
    await storage.writeDocBody(page.id, '# Tree Iconed\n\nBody.\n', '📌', undefined);

    const tree = await storage.getTree(space.slug);
    function find(nodes: typeof tree, id: string): (typeof tree)[number] | undefined {
      for (const n of nodes) {
        if (n.id === id) return n;
        const inner = find(n.children, id);
        if (inner) return inner;
      }
      return undefined;
    }
    const node = find(tree, page.id);
    expect(node?.icon).toBe('📌');

    await deleteTestSpace(space.slug);
  });

  it('removing the icon/cover frontmatter keys from the file and rescanning clears them from the index', async () => {
    const space = await storage.createSpace(`Icon Rescan Clear ${Date.now()}`, null);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Will Clear', kind: 'doc' });
    await storage.writeDocBody(page.id, '# Will Clear\n\nBody.\n', '🎯', 'https://example.com/c.png');
    expect((await storage.requireEntry(page.id)).icon).toBe('🎯');

    // Simulate an external edit (e.g. a git pull/merge) that drops the icon/cover keys
    // entirely, bypassing the app's own override-merge semantics.
    const entry = await storage.requireEntry(page.id);
    await fs.writeFile(entry.absPath, '---\nid: ' + page.id + '\n---\n# Will Clear\n\nBody.\n', 'utf8');

    await storage.scanSpace(space.slug);
    const afterRescan = await storage.requireEntry(page.id);
    expect(afterRescan.icon).toBeUndefined();
    expect(afterRescan.cover).toBeUndefined();
    expect(storage.toPageMeta(afterRescan).icon).toBeUndefined();

    await deleteTestSpace(space.slug);
  });

  it('a PUT-equivalent (applyMarkdownUpdate) on a LIVE doc persists icon/cover to file+DB immediately, not deferred to a later body-change debounce', async () => {
    const space = await storage.createSpace(`Icon Live ${Date.now()}`, null);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Live Doc', kind: 'doc' });
    const bodyText = '# Live Doc\n\nOriginal body, unchanged by this test.\n';
    await storage.writeDocBody(page.id, bodyText);

    // Register a Y.Doc directly in y-websocket's own shared `docs` map — the SAME
    // singleton (require() caching) that collab.ts's isDocLive/applyMarkdownUpdate
    // read from — simulating "this page has an active WS connection open" without
    // spinning up a real WebSocket server for the test.
    const { createRequire } = await import('node:module');
    const nodeRequire = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ywsUtils = nodeRequire('y-websocket/bin/utils') as { docs: Map<string, import('yjs').Doc> };
    const Y = await import('yjs');
    const ydoc = new Y.Doc();
    ydoc.getText('content').insert(0, bodyText);
    ywsUtils.docs.set(page.id, ydoc);

    try {
      const collab = await import('./collab.js');
      expect(collab.isDocLive(page.id)).toBe(true);

      // Body text passed is IDENTICAL to what's already there — an icon-only change,
      // exactly the case that previously never reached the debounced write-back at all.
      await collab.applyMarkdownUpdate(page.id, bodyText, '🛰️', 'https://example.com/live.png');

      const afterEntry = await storage.requireEntry(page.id);
      expect(afterEntry.icon).toBe('🛰️');
      expect(afterEntry.cover).toBe('https://example.com/live.png');

      // gray-matter's YAML serializer may quote values containing "://" (valid YAML,
      // not a bug) and may escape non-ASCII characters — check presence, not exact
      // formatting.
      const raw = await fs.readFile(afterEntry.absPath, 'utf8');
      expect(raw).toContain('icon:');
      expect(raw).toContain('cover:');
      expect(raw).toContain('https://example.com/live.png');
    } finally {
      ywsUtils.docs.delete(page.id);
    }

    await deleteTestSpace(space.slug);
  });
});

describe('icon/cover explicit set/clear/preserve via PUT body fields (round 5.1)', () => {
  let teardownSchema: () => Promise<void>;
  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  /** Registers a Y.Doc in y-websocket's own shared `docs` map — same singleton
   * collab.ts's isDocLive/applyMarkdownUpdate read from (require() caching) — so
   * a page can be made "live" for a test without a real WebSocket connection. */
  async function registerLiveDoc(id: string, bodyText: string): Promise<{ docs: Map<string, import('yjs').Doc>; cleanup: () => void }> {
    const { createRequire } = await import('node:module');
    const nodeRequire = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ywsUtils = nodeRequire('y-websocket/bin/utils') as { docs: Map<string, import('yjs').Doc> };
    const Y = await import('yjs');
    const ydoc = new Y.Doc();
    ydoc.getText('content').insert(0, bodyText);
    ywsUtils.docs.set(id, ydoc);
    return { docs: ywsUtils.docs, cleanup: () => ywsUtils.docs.delete(id) };
  }

  async function makePage(nameHint: string): Promise<{ spaceSlug: string; pageId: string }> {
    const space = await storage.createSpace(`${nameHint} ${Date.now()}`, null);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: nameHint, kind: 'doc' });
    return { spaceSlug: space.slug, pageId: page.id };
  }

  // --- non-live (storage.writeDocBody) -------------------------------------

  it('non-live: set (undefined -> string)', async () => {
    const { spaceSlug, pageId } = await makePage('NL Set');
    await storage.writeDocBody(pageId, '# NL Set\n\nBody.\n', '🎯', undefined);
    expect((await storage.requireEntry(pageId)).icon).toBe('🎯');
    await deleteTestSpace(spaceSlug);
  });

  it('non-live: clear (string -> null)', async () => {
    const { spaceSlug, pageId } = await makePage('NL Clear');
    await storage.writeDocBody(pageId, '# NL Clear\n\nBody.\n', '🎯', undefined);
    expect((await storage.requireEntry(pageId)).icon).toBe('🎯');

    await storage.writeDocBody(pageId, '# NL Clear\n\nBody.\n', null, undefined);
    const entry = await storage.requireEntry(pageId);
    expect(entry.icon).toBeUndefined();
    const raw = await fs.readFile(entry.absPath, 'utf8');
    expect(raw).not.toContain('icon:');

    await deleteTestSpace(spaceSlug);
  });

  it('non-live: preserve (field absent leaves an existing value untouched)', async () => {
    const { spaceSlug, pageId } = await makePage('NL Preserve');
    await storage.writeDocBody(pageId, '# NL Preserve\n\nBody.\n', '🎯', undefined);

    // A plain body-only edit, exactly like normal typing — no icon override passed at all.
    await storage.writeDocBody(pageId, '# NL Preserve\n\nEdited body.\n');
    expect((await storage.requireEntry(pageId)).icon).toBe('🎯');

    await deleteTestSpace(spaceSlug);
  });

  // --- live (collab.applyMarkdownUpdate) ------------------------------------

  it('live: set (undefined -> string), persisted immediately to file+DB', async () => {
    const { spaceSlug, pageId } = await makePage('Live Set');
    const bodyText = '# Live Set\n\nBody.\n';
    await storage.writeDocBody(pageId, bodyText);
    const live = await registerLiveDoc(pageId, bodyText);
    try {
      const collab = await import('./collab.js');
      await collab.applyMarkdownUpdate(pageId, bodyText, '🎯', undefined);
      const entry = await storage.requireEntry(pageId);
      expect(entry.icon).toBe('🎯');
      expect((await fs.readFile(entry.absPath, 'utf8'))).toContain('icon:');
    } finally {
      live.cleanup();
    }
    await deleteTestSpace(spaceSlug);
  });

  it('live: clear (string -> null), persisted immediately even though the body text does not change', async () => {
    const { spaceSlug, pageId } = await makePage('Live Clear');
    const bodyText = '# Live Clear\n\nBody.\n';
    await storage.writeDocBody(pageId, bodyText, '🎯', undefined);
    expect((await storage.requireEntry(pageId)).icon).toBe('🎯');

    const live = await registerLiveDoc(pageId, bodyText);
    try {
      const collab = await import('./collab.js');
      // Same body text as what's already on disk — an icon-only clear, the exact case
      // that would never reach the debounced write-back on its own.
      await collab.applyMarkdownUpdate(pageId, bodyText, null, undefined);
      const entry = await storage.requireEntry(pageId);
      expect(entry.icon).toBeUndefined();
      const raw = await fs.readFile(entry.absPath, 'utf8');
      expect(raw).not.toContain('icon:');
    } finally {
      live.cleanup();
    }
    await deleteTestSpace(spaceSlug);
  });

  it('live: preserve (field absent leaves an existing value untouched)', async () => {
    const { spaceSlug, pageId } = await makePage('Live Preserve');
    const bodyText = '# Live Preserve\n\nBody.\n';
    await storage.writeDocBody(pageId, bodyText, '🎯', undefined);

    const live = await registerLiveDoc(pageId, bodyText);
    try {
      const collab = await import('./collab.js');
      const editedBody = '# Live Preserve\n\nEdited body, no icon override at all.\n';
      await collab.applyMarkdownUpdate(pageId, editedBody); // overrideIcon/overrideCover both omitted
      const entry = await storage.requireEntry(pageId);
      expect(entry.icon).toBe('🎯'); // untouched by the body-only edit
    } finally {
      live.cleanup();
    }
    await deleteTestSpace(spaceSlug);
  });

  it('resolveIconCoverOverride: the three-way truth table directly', () => {
    expect(storage.resolveIconCoverOverride(undefined, '🎯')).toBe('🎯'); // preserve
    expect(storage.resolveIconCoverOverride(undefined, undefined)).toBeUndefined(); // preserve, nothing to preserve
    expect(storage.resolveIconCoverOverride(null, '🎯')).toBeUndefined(); // clear
    expect(storage.resolveIconCoverOverride(null, undefined)).toBeUndefined(); // clear, already clear
    expect(storage.resolveIconCoverOverride('🚀', '🎯')).toBe('🚀'); // set, overwriting
    expect(storage.resolveIconCoverOverride('🚀', undefined)).toBe('🚀'); // set, from nothing
  });
});

describe('setDocOrder (round 22, SHELL tree "Up/Down" — PUT body with ONLY order)', () => {
  let teardownSchema: () => Promise<void>;
  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  it('persists an explicit order to both the file frontmatter and pages_index.sort_order, without touching the body', async () => {
    const space = await storage.createSpace(`Set Order ${Date.now()}`, null);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Orderable', kind: 'doc' });
    const bodyBefore = await storage.readFreshDocBody(page.id);

    const entry = await storage.requireEntry(page.id);
    await storage.setDocOrder(entry, 5, bodyBefore);

    const reread = await storage.requireEntry(page.id);
    expect(reread.order).toBe(5);
    expect(reread.explicitOrder).toBe(5);
    expect(await storage.readFreshDocBody(page.id)).toBe(bodyBefore); // content untouched

    const raw = await fs.readFile(reread.absPath, 'utf8');
    expect(raw).toContain('order: 5');

    await deleteTestSpace(space.slug);
  });

  it('is a no-op when the order already matches (no gratuitous file rewrite)', async () => {
    const space = await storage.createSpace(`Set Order Noop ${Date.now()}`, null);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Already Ordered', kind: 'doc' });
    const entry = await storage.requireEntry(page.id);
    await storage.setDocOrder(entry, 3, await storage.readFreshDocBody(page.id));

    const beforeRaw = await fs.readFile((await storage.requireEntry(page.id)).absPath, 'utf8');
    await storage.setDocOrder(await storage.requireEntry(page.id), 3, await storage.readFreshDocBody(page.id));
    const afterRaw = await fs.readFile((await storage.requireEntry(page.id)).absPath, 'utf8');
    expect(afterRaw).toBe(beforeRaw);

    await deleteTestSpace(space.slug);
  });

  it('on a LIVE doc, persists immediately (not deferred to the debounced write-back) — same immediacy as icon/cover', async () => {
    const space = await storage.createSpace(`Set Order Live ${Date.now()}`, null);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Live Ordered', kind: 'doc' });
    const bodyText = await storage.readFreshDocBody(page.id);

    const { createRequire } = await import('node:module');
    const nodeRequire = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ywsUtils = nodeRequire('y-websocket/bin/utils') as { docs: Map<string, import('yjs').Doc> };
    const ydoc = new Y.Doc();
    ydoc.getText('content').insert(0, bodyText);
    ywsUtils.docs.set(page.id, ydoc);

    try {
      const collabMod = await import('./collab.js');
      expect(collabMod.isDocLive(page.id)).toBe(true);
      const liveText = collabMod.getLiveText(page.id)!;

      const entry = await storage.requireEntry(page.id);
      await storage.setDocOrder(entry, 7, liveText);

      const raw = await fs.readFile(entry.absPath, 'utf8');
      expect(raw).toContain('order: 7'); // on disk immediately, no debounce wait
      expect((await storage.requireEntry(page.id)).order).toBe(7);
    } finally {
      ywsUtils.docs.delete(page.id);
    }

    await deleteTestSpace(space.slug);
  });
});

describe('THE DOUBLING fix: Y.Doc identity survives a server restart via a persisted snapshot', () => {
  let teardownSchema: () => Promise<void>;
  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  it('(a) THE regression: a client holding the doc across a simulated restart does not get its text duplicated', async () => {
    const space = await storage.createSpace(`Doubling Regression ${Date.now()}`, null);
    // try/finally: a failing expect() below must not skip this test's OWN cleanup call —
    // discovered as stale `spaces` rows + data/repos dirs surviving in the REAL 'public'
    // schema (not this file's isolated one) after this suite failed on an earlier, since-
    // fixed regression; setUpTestSchema's DROP SCHEMA CASCADE only protects rows that
    // actually LANDED in the isolated schema in the first place, not a mid-test throw's
    // effect on cleanup that was never reached.
    try {
      const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Doubling', kind: 'doc' });
      await storage.writeDocBody(page.id, '# Doubling\n\nOriginal body text.\n');

      // Server boots, doc opened for the first time: no snapshot yet -> seeds from the
      // file AND stores the resulting snapshot (the "close the restart window" path).
      const serverDocBeforeRestart = new Y.Doc();
      await collab.bindState(page.id, serverDocBeforeRestart);
      const bodyOnFirstOpen = serverDocBeforeRestart.getText('content').toString();
      expect(bodyOnFirstOpen).toContain('Original body text.');

      // A client connects and syncs — its local doc now holds the SAME ops as the
      // server's (this is exactly what y-websocket's real sync protocol does).
      const clientDoc = new Y.Doc();
      Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(serverDocBeforeRestart));
      expect(clientDoc.getText('content').toString()).toBe(bodyOnFirstOpen);

      // Server restarts: brand new process, brand new empty Y.Doc for this room.
      // THE BUG (pre-fix): bindState would reseed from the file here with NEW op
      // identity. THE FIX: a snapshot exists now, so identity is restored instead.
      const serverDocAfterRestart = new Y.Doc();
      await collab.bindState(page.id, serverDocAfterRestart);

      // The client reconnects: full bidirectional sync, exactly like the real
      // y-websocket sync protocol (each side sends the other whatever it's missing).
      Y.applyUpdate(serverDocAfterRestart, Y.encodeStateAsUpdate(clientDoc));
      Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(serverDocAfterRestart));

      const finalServerText = serverDocAfterRestart.getText('content').toString();
      const finalClientText = clientDoc.getText('content').toString();
      expect(finalServerText).toBe(bodyOnFirstOpen); // NOT bodyOnFirstOpen + bodyOnFirstOpen
      expect(finalClientText).toBe(bodyOnFirstOpen);
      expect(finalServerText).not.toContain('Original body text.\n\n# Doubling'); // no doubled heading either
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('(b) a file edit made while no doc was live (server "down") is reconciled as a real edit on top of the restored snapshot', async () => {
    const space = await storage.createSpace(`Doubling External Edit ${Date.now()}`, null);
    try {
      const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'External Edit', kind: 'doc' });
      await storage.writeDocBody(page.id, '# External Edit\n\nVersion one.\n');

      const firstOpen = new Y.Doc();
      await collab.bindState(page.id, firstOpen); // no snapshot yet -> seeds + stores one

      // Server "goes down" (doc no longer live); someone edits the file directly
      // (external tool / git pull/merge), bypassing collab entirely.
      const entry = await storage.requireEntry(page.id);
      await fs.writeFile(entry.absPath, '---\nid: ' + page.id + '\n---\n# External Edit\n\nVersion TWO, changed while down.\n', 'utf8');

      // Server "comes back up": fresh Y.Doc, bindState finds the snapshot (version
      // one's identity) and must reconcile with the file (now version two).
      const afterRestart = new Y.Doc();
      await collab.bindState(page.id, afterRestart);

      expect(afterRestart.getText('content').toString()).toBe('# External Edit\n\nVersion TWO, changed while down.\n');
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('(c) the first-ever bindState (no snapshot) stores one immediately, before returning', async () => {
    const space = await storage.createSpace(`Doubling No Snapshot ${Date.now()}`, null);
    try {
      const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Fresh', kind: 'doc' });
      await storage.writeDocBody(page.id, '# Fresh\n\nBody.\n');

      expect(await collab.loadSnapshot(page.id)).toBeUndefined();

      const ydoc = new Y.Doc();
      await collab.bindState(page.id, ydoc);

      const snapshot = await collab.loadSnapshot(page.id);
      expect(snapshot).toBeDefined();
      expect(snapshot!.length).toBeGreaterThan(0);

      // The stored snapshot is actually usable to restore identical state elsewhere.
      const restored = new Y.Doc();
      Y.applyUpdate(restored, snapshot!);
      expect(restored.getText('content').toString()).toBe(ydoc.getText('content').toString());
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('(d) deleting a page cascades to remove its ydoc_state row', async () => {
    const space = await storage.createSpace(`Doubling Cascade Delete ${Date.now()}`, null);
    try {
      const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Will Be Deleted', kind: 'doc' });
      await storage.writeDocBody(page.id, '# Will Be Deleted\n\nBody.\n');

      const ydoc = new Y.Doc();
      await collab.bindState(page.id, ydoc);
      expect(await collab.loadSnapshot(page.id)).toBeDefined();

      await storage.deletePage(page.id);

      const rows = await query('SELECT 1 FROM ydoc_state WHERE page_id = $1', [page.id]);
      expect(rows.length).toBe(0);
    } finally {
      await deleteTestSpace(space.slug);
    }
  });
});

describe('.folio metadata file (round 22)', () => {
  let teardownSchema: () => Promise<void>;
  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  it("createSpace (no remote) writes <slug>.folio with the space's name, riding the SAME initial commit as index.md", async () => {
    const name = `Folio Meta Local ${Date.now()}`;
    const space = await storage.createSpace(name, null);
    const dir = storage.getRepoDir(space.slug);

    const raw = await fs.readFile(path.join(dir, `${space.slug}.folio`), 'utf8');
    const parsed = JSON.parse(raw) as { v: number; name: string };
    expect(parsed.name).toBe(name);
    expect(parsed.v).toBe(1);

    const history = await git.fileHistory(dir, `${space.slug}.folio`);
    expect(history.length).toBe(1);
    expect(history[0].message).toContain('init'); // 'init: create space' — no separate commit

    await deleteTestSpace(space.slug);
  });

  it(".folio never appears in the page tree or scanSpace's index — it is a purely servicing/metadata file", async () => {
    const name = `Folio Meta Excluded ${Date.now()}`;
    const space = await storage.createSpace(name, null);
    await storage.createPage({ space: space.slug, parentPath: '', title: 'Another Page', kind: 'doc' });

    const tree = await storage.getTree(space.slug);
    function flatten(nodes: typeof tree): string[] {
      return nodes.flatMap((n) => [n.path, ...flatten(n.children)]);
    }
    expect(flatten(tree).some((p) => p.endsWith('.folio'))).toBe(false);

    const entries = await storage.listEntries(space.slug);
    expect(entries.some((e) => e.relPath.endsWith('.folio'))).toBe(false);

    await deleteTestSpace(space.slug);
  });

  it('createSpaceFromRepo (bare repo with no prior .folio) writes its own canonical <slug>.folio, committed AND pushed', async () => {
    const bareDir = path.join(os.tmpdir(), `folio-test-meta-fresh-${Date.now()}.git`);
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bareDir]);

    const name = `Folio Meta Fresh Repo ${Date.now()}`;
    const space = await storage.createSpaceFromRepo({ name, repoUrl: bareDir, branch: 'main', rootPath: '', createdBy: null });
    const dir = storage.getRepoDir(space.slug);

    const raw = await fs.readFile(path.join(dir, `${space.slug}.folio`), 'utf8');
    expect((JSON.parse(raw) as { name: string }).name).toBe(name);

    const remoteLog = await execFileAsync('git', ['log', '--oneline', '--', `${space.slug}.folio`], { cwd: bareDir });
    expect(remoteLog.stdout.trim().length).toBeGreaterThan(0);

    await deleteTestSpace(space.slug);
    await fs.rm(bareDir, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  it("createSpaceFromRepo keeps the submitted name when a shared repo contains another space's .folio file", async () => {
    const bareDir = path.join(os.tmpdir(), `folio-test-meta-preexisting-${Date.now()}.git`);
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bareDir]);

    // Seed the bare repo with a PRE-EXISTING .folio file, as if this repo had already
    // been a Folio space (under some other slug) before being (re)connected here.
    const seedDir = path.join(os.tmpdir(), `folio-test-meta-preexisting-seed-${Date.now()}`);
    await fs.mkdir(seedDir, { recursive: true });
    await git.initWithCommit(seedDir, 'seed placeholder');
    await fs.writeFile(path.join(seedDir, 'index.md'), '# Some Content\n', 'utf8');
    await fs.writeFile(path.join(seedDir, 'old-project-slug.folio'), JSON.stringify({ v: 1, name: 'The Real Name From Before' }), 'utf8');
    await git.commitAll(seedDir, 'seed', { name: 'Tester', email: 't@example.test' });
    await execFileAsync('git', ['remote', 'add', 'origin', bareDir], { cwd: seedDir });
    await git.push(seedDir, 'main');
    await fs.rm(seedDir, { recursive: true, force: true });

    const submittedName = `Healthcheck ${Date.now()}`;
    const space = await storage.createSpaceFromRepo({
      name: submittedName,
      repoUrl: bareDir,
      branch: 'main',
      rootPath: '',
      createdBy: null,
    });

    try {
      // A different rootPath in the same repo may own that old file. The
      // submitted name must win and get its own canonical metadata file.
      const row = await query<{ name: string }>('SELECT name FROM spaces WHERE slug = $1', [space.slug]);
      expect(row[0]?.name).toBe(submittedName);
      const raw = await fs.readFile(path.join(storage.getRepoDir(space.slug), `${space.slug}.folio`), 'utf8');
      expect((JSON.parse(raw) as { name: string }).name).toBe(submittedName);

      // The root page H1 remains page content, not the space's display name.
      const info = await storage.getSpaceInfo(space.slug);
      expect(info?.name).toBe(submittedName);
    } finally {
      await deleteTestSpace(space.slug);
      await fs.rm(bareDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  it("renaming the space root page's title (non-live, renameDocDirect) updates .folio's name and the spaces.name DB column", async () => {
    const space = await storage.createSpace(`Folio Meta Rename Before ${Date.now()}`, null);
    const dir = storage.getRepoDir(space.slug);
    const root = (await storage.listEntries(space.slug)).find((e) => e.dirPath === '' && e.isIndex)!;

    await storage.renameDocDirect(root.id, 'Renamed Space Title');

    const raw = await fs.readFile(path.join(dir, `${space.slug}.folio`), 'utf8');
    expect((JSON.parse(raw) as { name: string }).name).toBe('Renamed Space Title');

    const info = await storage.getSpaceInfo(space.slug);
    expect(info?.name).toBe('Renamed Space Title');

    await deleteTestSpace(space.slug);
  });

  it("renaming the space root page's title on a LIVE doc (collab.applyH1Rename) ALSO updates .folio's name", async () => {
    const space = await storage.createSpace(`Folio Meta Rename Live ${Date.now()}`, null);
    const dir = storage.getRepoDir(space.slug);
    const root = (await storage.listEntries(space.slug)).find((e) => e.dirPath === '' && e.isIndex)!;
    const bodyText = `# ${root.title}\n\nRoot body.\n`;

    const { createRequire } = await import('node:module');
    const nodeRequire = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ywsUtils = nodeRequire('y-websocket/bin/utils') as { docs: Map<string, import('yjs').Doc> };
    const ydoc = new Y.Doc();
    ydoc.getText('content').insert(0, bodyText);
    ywsUtils.docs.set(root.id, ydoc);

    try {
      const applied = await collab.applyH1Rename(root.id, 'Live Renamed Title');
      expect(applied).toBe(true);

      const raw = await fs.readFile(path.join(dir, `${space.slug}.folio`), 'utf8');
      expect((JSON.parse(raw) as { name: string }).name).toBe('Live Renamed Title');
    } finally {
      ywsUtils.docs.delete(root.id);
    }

    await deleteTestSpace(space.slug);
  });

  it("renaming a NON-root page's title never touches .folio", async () => {
    const space = await storage.createSpace(`Folio Meta Non Root ${Date.now()}`, null);
    const dir = storage.getRepoDir(space.slug);
    const originalRaw = await fs.readFile(path.join(dir, `${space.slug}.folio`), 'utf8');

    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Child Page', kind: 'doc' });
    await storage.renameDocDirect(page.id, 'Renamed Child');

    const afterRaw = await fs.readFile(path.join(dir, `${space.slug}.folio`), 'utf8');
    expect(afterRaw).toBe(originalRaw); // untouched

    await deleteTestSpace(space.slug);
  });
});
