/**
 * Bugfix (found while writing a test for shape-(2) pages — see getSubtree's
 * own doc comment for the two page-with-children shapes): a leaf page
 * (`X.md`) plus a same-named sibling children directory (`X/`) — the shape
 * `createPage`'s 'form' branch and every form/table pair produces — used to
 * leave `X/` behind on disk when the leaf itself was slug-renamed or moved:
 * `renamePageSlug`/`movePage` only ever relocated the single file
 * (`entry.absPath`), branching on `entry.isIndex` for the directory-index
 * shape and never checking for a plain sibling directory. Every child of
 * such a page was silently orphaned (still on disk, but detached from the
 * tree — getSubtree/getTree no longer find it under its old parent, and
 * nothing links it back to the moved/renamed page).
 *
 * Real fs + real PG, same style as slugRename.test.ts / storage.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';

describe('renamePageSlug / movePage keep a shape-(2) page\'s children attached', () => {
  let teardownSchema: () => Promise<void>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  it('slug rename of a shape-(2) page relocates its children directory too (children keep their ids)', async () => {
    const space = await storage.createSpace(`Move Rename Slug ${Date.now()}`, null);
    const dir = storage.getSpaceDir(space.slug);
    try {
      const parent = await storage.createPage({ space: space.slug, parentPath: '', title: 'Plan', kind: 'doc' });
      expect(parent.path).toBe('plan.md');

      // Shape (2): `plan.md` + `plan/` — a child and a nested grandchild, same
      // "leaf page + same-named sibling directory = children" convention every
      // form/table pair uses (see createPage's 'form' branch).
      await fs.mkdir(path.join(dir, 'plan', 'sub'), { recursive: true });
      await fs.writeFile(path.join(dir, 'plan', 'child.md'), '# Child\n', 'utf8');
      await fs.writeFile(path.join(dir, 'plan', 'sub', 'grandchild.md'), '# Grandchild\n', 'utf8');
      await storage.scanSpace(space.slug);

      const before = await storage.listEntries(space.slug);
      const childBefore = before.find((e) => e.relPath === 'plan/child.md')!;
      const grandchildBefore = before.find((e) => e.relPath === 'plan/sub/grandchild.md')!;
      expect(childBefore).toBeDefined();
      expect(grandchildBefore).toBeDefined();

      const result = await storage.renamePageSlug(parent.id, 'roadmap');
      expect(result.meta.path).toBe('roadmap.md');

      // The old directory is gone entirely — nothing left orphaned behind.
      await expect(fs.access(path.join(dir, 'plan'))).rejects.toThrow();

      // Every descendant followed, keeping its own id.
      const after = await storage.listEntries(space.slug);
      const childAfter = after.find((e) => e.id === childBefore.id);
      const grandchildAfter = after.find((e) => e.id === grandchildBefore.id);
      expect(childAfter?.relPath).toBe('roadmap/child.md');
      expect(grandchildAfter?.relPath).toBe('roadmap/sub/grandchild.md');
      await expect(fs.access(path.join(dir, 'roadmap', 'child.md'))).resolves.toBeUndefined();
      await expect(fs.access(path.join(dir, 'roadmap', 'sub', 'grandchild.md'))).resolves.toBeUndefined();
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('movePage of a shape-(2) page relocates its children directory too (children keep their ids)', async () => {
    const space = await storage.createSpace(`Move Rename Move ${Date.now()}`, null);
    const dir = storage.getSpaceDir(space.slug);
    try {
      const parent = await storage.createPage({ space: space.slug, parentPath: '', title: 'Plan', kind: 'doc' });
      expect(parent.path).toBe('plan.md');

      await fs.mkdir(path.join(dir, 'plan', 'sub'), { recursive: true });
      await fs.writeFile(path.join(dir, 'plan', 'child.md'), '# Child\n', 'utf8');
      await fs.writeFile(path.join(dir, 'plan', 'sub', 'grandchild.md'), '# Grandchild\n', 'utf8');
      await storage.scanSpace(space.slug);

      const before = await storage.listEntries(space.slug);
      const childBefore = before.find((e) => e.relPath === 'plan/child.md')!;
      const grandchildBefore = before.find((e) => e.relPath === 'plan/sub/grandchild.md')!;

      const moved = await storage.movePage(parent.id, 'archive');
      expect(moved.path).toBe('archive/plan.md');

      await expect(fs.access(path.join(dir, 'plan'))).rejects.toThrow();

      const after = await storage.listEntries(space.slug);
      const childAfter = after.find((e) => e.id === childBefore.id);
      const grandchildAfter = after.find((e) => e.id === grandchildBefore.id);
      expect(childAfter?.relPath).toBe('archive/plan/child.md');
      expect(grandchildAfter?.relPath).toBe('archive/plan/sub/grandchild.md');
      await expect(fs.access(path.join(dir, 'archive', 'plan', 'child.md'))).resolves.toBeUndefined();
      await expect(fs.access(path.join(dir, 'archive', 'plan', 'sub', 'grandchild.md'))).resolves.toBeUndefined();
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('a destination collision on the children DIRECTORY throws and leaves everything untouched (movePage)', async () => {
    const space = await storage.createSpace(`Move Rename Conflict ${Date.now()}`, null);
    const dir = storage.getSpaceDir(space.slug);
    try {
      const parent = await storage.createPage({ space: space.slug, parentPath: '', title: 'Plan', kind: 'doc' });
      await fs.mkdir(path.join(dir, 'plan'), { recursive: true });
      await fs.writeFile(path.join(dir, 'plan', 'child.md'), '# Child\n', 'utf8');
      await storage.scanSpace(space.slug);
      const childBefore = (await storage.listEntries(space.slug)).find((e) => e.relPath === 'plan/child.md')!;

      // The destination FILE (archive/plan.md) is free, but a directory
      // already sits at the destination DIRECTORY (archive/plan/) — this must
      // be caught before any write, just like the existing file-collision check.
      await fs.mkdir(path.join(dir, 'archive', 'plan'), { recursive: true });

      await expect(storage.movePage(parent.id, 'archive')).rejects.toMatchObject({ status: 409 });

      // Nothing moved: source page and its children directory are untouched,
      // and nothing landed in the pre-existing destination directory.
      expect((await storage.requireEntry(parent.id)).relPath).toBe('plan.md');
      expect((await storage.requireEntry(childBefore.id)).relPath).toBe('plan/child.md');
      await expect(fs.access(path.join(dir, 'plan.md'))).resolves.toBeUndefined();
      await expect(fs.access(path.join(dir, 'plan', 'child.md'))).resolves.toBeUndefined();
      await expect(fs.access(path.join(dir, 'archive', 'plan.md'))).rejects.toThrow();
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('renamePageSlug reports shape-(2) descendants in the returned `moved` list', async () => {
    const space = await storage.createSpace(`Move Rename Moved List ${Date.now()}`, null);
    const dir = storage.getSpaceDir(space.slug);
    try {
      const parent = await storage.createPage({ space: space.slug, parentPath: '', title: 'Plan', kind: 'doc' });
      await fs.mkdir(path.join(dir, 'plan', 'sub'), { recursive: true });
      await fs.writeFile(path.join(dir, 'plan', 'child.md'), '# Child\n', 'utf8');
      await fs.writeFile(path.join(dir, 'plan', 'sub', 'grandchild.md'), '# Grandchild\n', 'utf8');
      await storage.scanSpace(space.slug);
      const before = await storage.listEntries(space.slug);
      const childBefore = before.find((e) => e.relPath === 'plan/child.md')!;
      const grandchildBefore = before.find((e) => e.relPath === 'plan/sub/grandchild.md')!;

      const result = await storage.renamePageSlug(parent.id, 'roadmap');

      expect(result.moved).toHaveLength(3); // parent + child + grandchild
      const byId = new Map(result.moved.map((m) => [m.id, m]));
      expect(byId.get(parent.id)).toMatchObject({ oldRelPath: 'plan.md', newRelPath: 'roadmap.md' });
      expect(byId.get(childBefore.id)).toMatchObject({ oldRelPath: 'plan/child.md', newRelPath: 'roadmap/child.md' });
      expect(byId.get(grandchildBefore.id)).toMatchObject({ oldRelPath: 'plan/sub/grandchild.md', newRelPath: 'roadmap/sub/grandchild.md' });
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('regression: shape-(1) directory-index pages still rename/move their whole subtree exactly as before', async () => {
    const space = await storage.createSpace(`Move Rename Index Regression ${Date.now()}`, null);
    const dir = storage.getSpaceDir(space.slug);
    try {
      await fs.mkdir(path.join(dir, 'notes', 'sub'), { recursive: true });
      await fs.writeFile(path.join(dir, 'notes', 'index.md'), '# Notes Index\n', 'utf8');
      await fs.writeFile(path.join(dir, 'notes', 'sibling.md'), '# Sibling\n', 'utf8');
      await fs.writeFile(path.join(dir, 'notes', 'sub', 'nested.md'), '# Nested\n', 'utf8');
      await storage.scanSpace(space.slug);

      const before = await storage.listEntries(space.slug);
      const indexEntry = before.find((e) => e.relPath === 'notes/index.md')!;
      const siblingEntry = before.find((e) => e.relPath === 'notes/sibling.md')!;
      const nestedEntry = before.find((e) => e.relPath === 'notes/sub/nested.md')!;

      const renameResult = await storage.renamePageSlug(indexEntry.id, 'notes-renamed');
      expect(renameResult.meta.path).toBe('notes-renamed/index.md');
      expect(renameResult.moved).toHaveLength(3);
      let after = await storage.listEntries(space.slug);
      expect(after.find((e) => e.id === siblingEntry.id)?.relPath).toBe('notes-renamed/sibling.md');
      expect(after.find((e) => e.id === nestedEntry.id)?.relPath).toBe('notes-renamed/sub/nested.md');

      const moved = await storage.movePage(indexEntry.id, 'archive');
      expect(moved.path).toBe('archive/notes-renamed/index.md');
      after = await storage.listEntries(space.slug);
      expect(after.find((e) => e.id === siblingEntry.id)?.relPath).toBe('archive/notes-renamed/sibling.md');
      expect(after.find((e) => e.id === nestedEntry.id)?.relPath).toBe('archive/notes-renamed/sub/nested.md');

      // The classic self-nesting guard is unaffected by widening it to shape (2).
      await expect(storage.movePage(indexEntry.id, 'archive/notes-renamed/sub')).rejects.toMatchObject({ status: 400 });
    } finally {
      await deleteTestSpace(space.slug);
    }
  });
});
