import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as git from './git.js';
import * as gitSync from './gitSync.js';
import { query } from './db/pool.js';

/**
 * Issue #9: a deletion/modify conflict or a binary conflict is merged and
 * committed locally, which removes git's unmerged index entries and leaves no
 * text markers, so a SECOND sync (or the auto-retry, or a restart) used to read
 * the clone as clean and push the unresolved merge. These tests drive real git
 * repos (a bare remote plus an independent clone) through the real performSync.
 */
git.__allowLocalRepoPathsForTests();
const run = promisify(execFile);
const ME = { name: 'Other', email: 'o@example.test' };

const NOTE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FB1';
const note = (body: string) => `---\nid: ${NOTE_ID}\n---\n# Note\n\n${body}\n`;
const pdf = (tag: string) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from([0, 1, 2, 255, 254, 0]), Buffer.from(tag)]);

describe('unresolved git conflicts are not published (issue #9)', () => {
  let teardownSchema: () => Promise<void>;
  const cleanup: string[] = [];

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
    await Promise.all(cleanup.map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})));
  });

  async function tip(bare: string): Promise<string> {
    return (await run('git', ['rev-parse', 'main'], { cwd: bare })).stdout.trim();
  }

  /** A bare remote seeded with `files`, a Folio space cloned from it, and an independent clone of the same base. */
  async function setup(files: Record<string, string | Buffer>) {
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const bare = path.join(os.tmpdir(), `folio-conf-bare-${tag}.git`);
    const seed = path.join(os.tmpdir(), `folio-conf-seed-${tag}`);
    const other = path.join(os.tmpdir(), `folio-conf-other-${tag}`);
    cleanup.push(bare, seed, other);
    await run('git', ['init', '--bare', '-b', 'main', bare]);
    await fs.mkdir(seed, { recursive: true });
    await git.initWithCommit(seed, 'seed placeholder');
    await fs.writeFile(path.join(seed, 'index.md'), '---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FB0\n---\n# Home\n', 'utf8');
    for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(seed, name), content);
    await git.commitAll(seed, 'seed', ME);
    await run('git', ['remote', 'add', 'origin', bare], { cwd: seed });
    await git.push(seed, 'main');
    const space = await storage.createSpaceFromRepo({ name: `Conf ${tag}`, repoUrl: bare, branch: 'main', rootPath: '', createdBy: null });
    await storage.scanSpace(space.slug);
    await git.clone(bare, other, 'main');
    return { slug: space.slug, dir: storage.getRepoDir(space.slug), bare, other };
  }

  async function otherPush(other: string, bare: string, message: string, change: () => Promise<void>): Promise<string> {
    await change();
    await git.commitAll(other, message, ME);
    await git.push(other, 'main');
    return tip(bare);
  }

  async function remoteFile(bare: string, name: string): Promise<Buffer | null> {
    const { stdout } = await run('git', ['--no-pager', 'show', `main:${name}`], { cwd: bare, encoding: 'buffer' }).catch(() => ({ stdout: null }));
    return stdout;
  }

  it('Folio deletes, Git edits: Sync keeps reporting the conflict, never pushes, survives a restart, and each resolution works', async () => {
    for (const choice of ['delete-page', 'keep-page'] as const) {
      const s = await setup({ 'note.md': note('base') });
      const base = await tip(s.bare);
      // 1. delete locally (not synced)  2. Git edits and pushes
      await fs.rm(path.join(s.dir, 'note.md'));
      const upstream = await otherPush(s.other, s.bare, 'edit note', () => fs.writeFile(path.join(s.other, 'note.md'), note('edited in git'), 'utf8'));
      expect(upstream).not.toBe(base);

      // 3. first Sync: conflict, remote untouched
      expect((await gitSync.performSync(s.slug)).status).toBe('conflict');
      expect(await tip(s.bare)).toBe(upstream);
      expect(await git.readConflictLedger(s.dir)).toMatchObject([{ path: 'note.md', kind: 'deleted', deletedBy: 'folio' }]);

      // 4. second Sync and the automatic retry (same entry point): still a conflict, still unpushed
      for (let i = 0; i < 2; i++) {
        const again = await gitSync.performSync(s.slug);
        expect(again.status).toBe('conflict');
        expect(again.lastError).toBeTruthy();
        expect(await tip(s.bare)).toBe(upstream);
      }
      expect((await gitSync.getSpaceConflicts(s.slug)).find((c) => c.path === 'note.md')).toMatchObject({ kind: 'deleted', deletedBy: 'folio' });

      // Restart: fresh module instances, nothing in memory.
      vi.resetModules();
      const gitSync2 = await import('./gitSync.js');
      expect((await gitSync2.performSync(s.slug)).status).toBe('conflict');
      expect(await tip(s.bare)).toBe(upstream);

      // Wrong choice kind is refused.
      await expect(gitSync2.resolveConflict(s.slug, 'note.md', 'take-git')).rejects.toThrow();

      // Explicit choice, then the next Sync pushes.
      const resolved = await gitSync2.resolveConflict(s.slug, 'note.md', choice);
      expect(resolved.status).not.toBe('conflict');
      expect(await git.readConflictLedger(s.dir)).toEqual([]);
      expect((await gitSync2.performSync(s.slug)).status).toBe('clean');
      expect(await tip(s.bare)).not.toBe(upstream);
      if (choice === 'delete-page') {
        expect(await remoteFile(s.bare, 'note.md')).toBeNull();
        // Deleted like a normal page delete: a trash item exists and the index row is gone.
        const trash = await query(`SELECT 1 FROM trash_items WHERE space_slug = $1 AND page_id = $2`, [s.slug, NOTE_ID]);
        expect(trash.length).toBe(1);
        expect(await storage.getEntry(NOTE_ID)).toBeFalsy();
      } else {
        expect((await storage.getEntry(NOTE_ID))?.relPath).toBe('note.md');
      }
      if (choice === 'keep-page') expect((await remoteFile(s.bare, 'note.md'))!.toString()).toContain('edited in git');
      // History keeps the competing version either way.
      const { stdout } = await run('git', ['log', '--all', '--format=%s', '--', 'note.md'], { cwd: s.dir });
      expect(stdout).toContain('edit note');
      await deleteTestSpace(s.slug);
    }
  }, 60_000);

  it('Git deletes, Folio edits: stays a conflict across Syncs; "keep the page" publishes Folio\'s edit', async () => {
    const s = await setup({ 'note.md': note('base') });
    const upstream = await otherPush(s.other, s.bare, 'delete note', () => fs.rm(path.join(s.other, 'note.md')));
    await fs.writeFile(path.join(s.dir, 'note.md'), note('edited in folio'), 'utf8');

    expect((await gitSync.performSync(s.slug)).status).toBe('conflict');
    expect((await gitSync.performSync(s.slug)).status).toBe('conflict');
    expect(await tip(s.bare)).toBe(upstream);
    expect((await gitSync.getSpaceConflicts(s.slug))[0]).toMatchObject({ path: 'note.md', kind: 'deleted', deletedBy: 'git' });

    await gitSync.resolveConflict(s.slug, 'note.md', 'keep-page');
    expect((await gitSync.performSync(s.slug)).status).toBe('clean');
    expect((await remoteFile(s.bare, 'note.md'))!.toString()).toContain('edited in folio');
    await deleteTestSpace(s.slug);
  }, 60_000);

  it('both sides replace the same PDF: blocked until "keep yours" or "take the version from Git"', async () => {
    for (const choice of ['keep-mine', 'take-git'] as const) {
      const s = await setup({ 'doc.pdf': pdf('base') });
      const upstream = await otherPush(s.other, s.bare, 'new pdf upstream', () => fs.writeFile(path.join(s.other, 'doc.pdf'), pdf('GIT')));
      await fs.writeFile(path.join(s.dir, 'doc.pdf'), pdf('FOLIO'));

      expect((await gitSync.performSync(s.slug)).status).toBe('conflict');
      expect((await gitSync.performSync(s.slug)).status).toBe('conflict');
      expect(await tip(s.bare)).toBe(upstream);
      expect((await gitSync.getSpaceConflicts(s.slug))[0]).toMatchObject({ path: 'doc.pdf', kind: 'binary' });
      await expect(gitSync.resolveConflict(s.slug, 'doc.pdf', 'delete-page')).rejects.toThrow();

      await gitSync.resolveConflict(s.slug, 'doc.pdf', choice);
      expect((await gitSync.performSync(s.slug)).status).toBe('clean');
      const published = await remoteFile(s.bare, 'doc.pdf');
      expect(published!.equals(pdf(choice === 'keep-mine' ? 'FOLIO' : 'GIT'))).toBe(true);
      await deleteTestSpace(s.slug);
    }
  }, 60_000);

  it('an ordinary text conflict still blocks until its markers are resolved, then pushes; a plain sync is unaffected', async () => {
    const s = await setup({ 'note.md': note('base'), 'other.md': '# Other\n' });
    const upstream = await otherPush(s.other, s.bare, 'edit', () => fs.writeFile(path.join(s.other, 'note.md'), note('git side'), 'utf8'));
    await fs.writeFile(path.join(s.dir, 'note.md'), note('folio side'), 'utf8');
    expect((await gitSync.performSync(s.slug)).status).toBe('conflict');
    expect((await gitSync.performSync(s.slug)).status).toBe('conflict');
    expect(await tip(s.bare)).toBe(upstream);
    expect((await gitSync.getSpaceConflicts(s.slug))[0]).toMatchObject({ path: 'note.md', kind: 'text' });

    await fs.writeFile(path.join(s.dir, 'note.md'), note('both'), 'utf8');
    expect((await gitSync.performSync(s.slug)).status).toBe('clean');
    expect(await git.readConflictLedger(s.dir)).toEqual([]);
    expect((await remoteFile(s.bare, 'note.md'))!.toString()).toContain('both');

    // A non-conflicting divergence merges and pushes.
    await run('git', ['pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main'], { cwd: s.other });
    await otherPush(s.other, s.bare, 'unrelated', () => fs.writeFile(path.join(s.other, 'x.md'), '# X\n', 'utf8'));
    await fs.writeFile(path.join(s.dir, 'y.md'), '# Y\n', 'utf8');
    expect((await gitSync.performSync(s.slug)).status).toBe('clean');
    expect((await remoteFile(s.bare, 'y.md'))!.toString()).toContain('# Y');
    await deleteTestSpace(s.slug);
  }, 60_000);

  it('"Take the version from Git" for the whole space clears the recorded conflicts', async () => {
    const s = await setup({ 'note.md': note('base') });
    const upstream = await otherPush(s.other, s.bare, 'edit note', () => fs.writeFile(path.join(s.other, 'note.md'), note('git'), 'utf8'));
    await fs.rm(path.join(s.dir, 'note.md'));
    expect((await gitSync.performSync(s.slug)).status).toBe('conflict');

    const reset = await gitSync.resetSpaceToRemote(s.slug);
    expect(reset.status).toBe('clean');
    expect(await git.readConflictLedger(s.dir)).toEqual([]);
    expect((await gitSync.performSync(s.slug)).status).toBe('clean');
    expect(await tip(s.bare)).toBe(upstream);
    await deleteTestSpace(s.slug);
  }, 60_000);
});
