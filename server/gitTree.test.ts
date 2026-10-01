import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitError, __allowLocalRepoPathsForTests } from './git.js';
import { listRepoTreeDirs, invalidateGitTreeCache, stopGitTreeCache, GitTreePathNotFoundError } from './gitTree.js';

const execFileAsync = promisify(execFile);

// A bare dir is exactly as SSRF-capable as any other schemeless local path,
// so listRepoTreeDirs — like git.ts's clone family — now refuses one unless a
// caller that is NOT an HTTP request opts in. This file is such a caller.
__allowLocalRepoPathsForTests();

/** Real local bare repo standing in for a remote — same fixture shape gitNative.test.ts's own conflict/rootPath/empty-remote tests already use. */
async function makeBareRepoWithTree(): Promise<{ bareDir: string; sourceDir: string }> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const sourceDir = path.join(os.tmpdir(), `folio-test-tree-src-${stamp}`);
  const bareDir = path.join(os.tmpdir(), `folio-test-tree-remote-${stamp}.git`);

  await fs.mkdir(sourceDir, { recursive: true });
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: sourceDir });
  await fs.mkdir(path.join(sourceDir, 'docs', 'guide'), { recursive: true });
  await fs.mkdir(path.join(sourceDir, 'docs', 'api'), { recursive: true });
  await fs.mkdir(path.join(sourceDir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'README.md'), '# root\n', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'docs', 'guide', 'intro.md'), 'guide\n', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'docs', 'api', 'ref.md'), 'api\n', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'assets', 'logo.png'), 'not-really-a-png\n', 'utf8');
  await execFileAsync('git', ['add', '-A'], { cwd: sourceDir });
  await execFileAsync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t.test', 'commit', '-q', '-m', 'init'], { cwd: sourceDir });

  await execFileAsync('git', ['clone', '-q', '--bare', sourceDir, bareDir]);
  // `git clone <src> <dst>` only wires dst's "origin" back to src -- src itself
  // gets no remote at all. addAndPushDir (below) and the multi-branch test push
  // FROM sourceDir, so it needs its own "origin" pointed at the bare "remote".
  await execFileAsync('git', ['remote', 'add', 'origin', bareDir], { cwd: sourceDir });
  return { bareDir, sourceDir };
}

async function addAndPushDir(sourceDir: string, bareDir: string, dirName: string): Promise<void> {
  await fs.mkdir(path.join(sourceDir, dirName), { recursive: true });
  await fs.writeFile(path.join(sourceDir, dirName, 'new.md'), 'new\n', 'utf8');
  await execFileAsync('git', ['add', '-A'], { cwd: sourceDir });
  await execFileAsync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t.test', 'commit', '-q', '-m', `add ${dirName}`], { cwd: sourceDir });
  await execFileAsync('git', ['push', '-q', 'origin', 'main'], { cwd: sourceDir });
  void bareDir; // origin already points at bareDir (added in makeBareRepoWithTree)
}

async function cleanup(...dirs: string[]): Promise<void> {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})));
}

async function tmpGitTreeEntries(): Promise<Set<string>> {
  const entries = await fs.readdir(os.tmpdir()).catch(() => [] as string[]);
  return new Set(entries.filter((e) => e.startsWith('folio-git-tree-')));
}

describe('gitTree.ts (round 19 point 6-api, real local bare repo, no network)', () => {
  it('lists sorted subdirectory NAMES at the root and at a nested path', async () => {
    const { bareDir, sourceDir } = await makeBareRepoWithTree();
    try {
      const root = await listRepoTreeDirs(bareDir, 'main', '');
      expect(root).toEqual(['assets', 'docs']); // sorted; README.md (a file) excluded

      const docs = await listRepoTreeDirs(bareDir, 'main', 'docs');
      expect(docs).toEqual(['api', 'guide']);
    } finally {
      invalidateGitTreeCache(bareDir, 'main');
      await cleanup(bareDir, sourceDir);
    }
  }, 20_000);

  it('a leaf directory (no subdirectories) resolves to an empty array, not an error', async () => {
    const { bareDir, sourceDir } = await makeBareRepoWithTree();
    try {
      const leaf = await listRepoTreeDirs(bareDir, 'main', 'docs/guide');
      expect(leaf).toEqual([]);
    } finally {
      invalidateGitTreeCache(bareDir, 'main');
      await cleanup(bareDir, sourceDir);
    }
  }, 20_000);

  it('a leading/trailing slash on `path` is tolerated (normalized the same as no slash at all)', async () => {
    const { bareDir, sourceDir } = await makeBareRepoWithTree();
    try {
      expect(await listRepoTreeDirs(bareDir, 'main', '/docs/')).toEqual(['api', 'guide']);
      expect(await listRepoTreeDirs(bareDir, 'main', 'docs')).toEqual(['api', 'guide']);
    } finally {
      invalidateGitTreeCache(bareDir, 'main');
      await cleanup(bareDir, sourceDir);
    }
  }, 20_000);

  it('each branch resolves independently and correctly (proves --branch/--single-branch selection actually works, not just root-of-whatever-HEAD-is)', async () => {
    const { bareDir, sourceDir } = await makeBareRepoWithTree();
    try {
      await execFileAsync('git', ['checkout', '-q', '-b', 'other-branch'], { cwd: sourceDir });
      await fs.mkdir(path.join(sourceDir, 'other-branch-only'), { recursive: true });
      await fs.writeFile(path.join(sourceDir, 'other-branch-only', 'x.md'), 'x\n', 'utf8');
      await execFileAsync('git', ['add', '-A'], { cwd: sourceDir });
      await execFileAsync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t.test', 'commit', '-q', '-m', 'other branch commit'], { cwd: sourceDir });
      await execFileAsync('git', ['push', '-q', 'origin', 'other-branch'], { cwd: sourceDir });

      expect(await listRepoTreeDirs(bareDir, 'main', '')).toEqual(['assets', 'docs']);
      expect(await listRepoTreeDirs(bareDir, 'other-branch', '')).toEqual(['assets', 'docs', 'other-branch-only']);
    } finally {
      invalidateGitTreeCache(bareDir, 'main');
      invalidateGitTreeCache(bareDir, 'other-branch');
      await cleanup(bareDir, sourceDir);
    }
  }, 20_000);

  it('a nonexistent branch rejects with a GitError (the clone itself fails -- never silently empty)', async () => {
    const { bareDir, sourceDir } = await makeBareRepoWithTree();
    try {
      await expect(listRepoTreeDirs(bareDir, 'does-not-exist', '')).rejects.toThrow(GitError);
    } finally {
      invalidateGitTreeCache(bareDir, 'does-not-exist');
      await cleanup(bareDir, sourceDir);
    }
  }, 20_000);

  it('a nonexistent path rejects with GitTreePathNotFoundError specifically (distinct from a bad-branch/bad-repo GitError, so the route can map it to 404 instead of 400)', async () => {
    const { bareDir, sourceDir } = await makeBareRepoWithTree();
    try {
      await expect(listRepoTreeDirs(bareDir, 'main', 'does/not/exist')).rejects.toThrow(GitTreePathNotFoundError);
    } finally {
      invalidateGitTreeCache(bareDir, 'main');
      await cleanup(bareDir, sourceDir);
    }
  }, 20_000);

  it('a path that resolves to a FILE (not a directory) also rejects with GitTreePathNotFoundError', async () => {
    const { bareDir, sourceDir } = await makeBareRepoWithTree();
    try {
      await expect(listRepoTreeDirs(bareDir, 'main', 'README.md')).rejects.toThrow(GitTreePathNotFoundError);
    } finally {
      invalidateGitTreeCache(bareDir, 'main');
      await cleanup(bareDir, sourceDir);
    }
  }, 20_000);

  it('a branch name starting with "-" is rejected before ever shelling out to git (defense in depth for the ls-tree object-spec argv)', async () => {
    await expect(listRepoTreeDirs('/irrelevant', '-x', '')).rejects.toThrow(/invalid branch/);
  });

  it('a token argument is accepted and wired through without breaking a plain (unauthenticated-in-practice) local clone', async () => {
    const { bareDir, sourceDir } = await makeBareRepoWithTree();
    try {
      const dirs = await listRepoTreeDirs(bareDir, 'main', '', 'totally-fake-token-not-actually-checked-by-a-local-path-clone');
      expect(dirs).toEqual(['assets', 'docs']);
    } finally {
      invalidateGitTreeCache(bareDir, 'main');
      await cleanup(bareDir, sourceDir);
    }
  }, 20_000);

  it('CACHING: a second call for the same (repoUrl, branch) reuses the cloned clone -- a commit pushed to the remote in between is NOT reflected until invalidateGitTreeCache forces a re-clone', async () => {
    const { bareDir, sourceDir } = await makeBareRepoWithTree();
    try {
      const first = await listRepoTreeDirs(bareDir, 'main', '');
      expect(first).toEqual(['assets', 'docs']);

      await addAndPushDir(sourceDir, bareDir, 'brand-new-dir');

      // Still cached -- must NOT see brand-new-dir yet.
      const second = await listRepoTreeDirs(bareDir, 'main', '');
      expect(second).toEqual(['assets', 'docs']);

      invalidateGitTreeCache(bareDir, 'main');

      // Forced re-clone -- now it must see it.
      const third = await listRepoTreeDirs(bareDir, 'main', '');
      expect(third).toEqual(['assets', 'brand-new-dir', 'docs']);
    } finally {
      invalidateGitTreeCache(bareDir, 'main');
      await cleanup(bareDir, sourceDir);
    }
  }, 20_000);

  it('CONCURRENCY: parallel calls for the same (repoUrl, branch) all resolve correctly (share the one in-flight clone rather than racing)', async () => {
    const { bareDir, sourceDir } = await makeBareRepoWithTree();
    try {
      const [root, docs, guide] = await Promise.all([
        listRepoTreeDirs(bareDir, 'main', ''),
        listRepoTreeDirs(bareDir, 'main', 'docs'),
        listRepoTreeDirs(bareDir, 'main', 'docs/guide'),
      ]);
      expect(root).toEqual(['assets', 'docs']);
      expect(docs).toEqual(['api', 'guide']);
      expect(guide).toEqual([]);
    } finally {
      invalidateGitTreeCache(bareDir, 'main');
      await cleanup(bareDir, sourceDir);
    }
  }, 20_000);

  it('TTL: a cache entry auto-expires and its temp clone directory is actually removed from disk', async () => {
    const { bareDir, sourceDir } = await makeBareRepoWithTree();
    try {
      const before = await tmpGitTreeEntries();
      await listRepoTreeDirs(bareDir, 'main', '', undefined, 150); // 150ms TTL, test-only override
      const during = await tmpGitTreeEntries();
      const created = [...during].filter((d) => !before.has(d));
      expect(created.length).toBe(1);

      await new Promise((r) => setTimeout(r, 400)); // past the 150ms TTL
      const after = await tmpGitTreeEntries();
      expect(after.has(created[0])).toBe(false); // evicted AND its directory actually deleted
    } finally {
      await cleanup(bareDir, sourceDir);
    }
  }, 20_000);

  it('a failed clone (bad repo url) is never cached as if it had succeeded -- the very next call gets a clean retry, not a rethrown cached rejection', async () => {
    const badPath = path.join(os.tmpdir(), `folio-test-tree-nonexistent-${Date.now()}.git`);
    await expect(listRepoTreeDirs(badPath, 'main', '')).rejects.toThrow(GitError);
    // A second, identical call must fail the SAME clean way again (not a stuck/hanging cache entry).
    await expect(listRepoTreeDirs(badPath, 'main', '')).rejects.toThrow(GitError);
  }, 20_000);

  it('stopGitTreeCache removes every cached temp directory immediately, even ones far from their TTL', async () => {
    const { bareDir, sourceDir } = await makeBareRepoWithTree();
    try {
      const before = await tmpGitTreeEntries();
      await listRepoTreeDirs(bareDir, 'main', ''); // default (~10 minute) TTL -- would NOT expire on its own during this test
      const during = await tmpGitTreeEntries();
      const created = [...during].filter((d) => !before.has(d));
      expect(created.length).toBe(1);

      await stopGitTreeCache();

      const after = await tmpGitTreeEntries();
      expect(after.has(created[0])).toBe(false);
    } finally {
      await cleanup(bareDir, sourceDir);
    }
  }, 20_000);
});
