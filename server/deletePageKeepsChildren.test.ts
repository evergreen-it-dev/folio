/**
 * Bugfix (mirrors moveRenameKeepsChildren.test.ts / commit 33cb9c3, which
 * fixed the same class of bug in movePage/renamePageSlug): `deletePage`
 * started with `entry.isIndex ? path.dirname(entry.absPath) : entry.absPath`
 * — for a shape-(2) page (a leaf `X.md` plus a same-named sibling children
 * directory `X/`, see storage.ts getSubtree's own doc comment) that moves
 * ONLY the leaf file to data/.trash and leaves `X/` sitting in the space.
 * Every child is orphaned: the parent page is gone, the children's files
 * remain, and the trash record's `childrenCount` was hardcoded to 0 — a lie
 * about what the user is about to lose.
 *
 * Real fs + real PG, same style as moveRenameKeepsChildren.test.ts and
 * server/trash/service.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as authStore from './auth/store.js';
import { query, queryOne } from './db/pool.js';
import type { User } from '../shared/contracts.js';
import { restoreTrashItem } from './trash/service.js';
import type { TrashRow } from './trash/service.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function rowForPage(pageId: string): Promise<TrashRow | undefined> {
  return queryOne<TrashRow>('SELECT * FROM trash_items WHERE page_id = $1', [pageId]);
}

describe('deletePage keeps a shape-(2) page\'s children attached (trash + restore)', () => {
  let teardownSchema: () => Promise<void>;
  let admin: User;
  const createdSlugs = new Set<string>();

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    admin = await authStore.createUser({ email: `dpkc-${Date.now()}@t.local`, name: 'Admin', passwordHash: 'x', isAdmin: true });
  });
  afterAll(async () => {
    for (const slug of createdSlugs) await deleteTestSpace(slug).catch(() => {});
    await teardownSchema();
  });

  async function makeSpace(name: string) {
    const info = await storage.createSpace(`DPKC ${name} ${Date.now()}`, null);
    createdSlugs.add(info.slug);
    return info;
  }

  it('deleting a shape-(2) page also removes its children from the space, with a real childrenCount', async () => {
    const sp = await makeSpace('remove');
    const dir = storage.getSpaceDir(sp.slug);
    try {
      const parent = await storage.createPage({ space: sp.slug, parentPath: '', title: 'Plan', kind: 'doc' });
      expect(parent.path).toBe('plan.md');

      // Shape (2): `plan.md` + `plan/` with a child and a nested grandchild.
      await fs.mkdir(path.join(dir, 'plan', 'sub'), { recursive: true });
      await fs.writeFile(path.join(dir, 'plan', 'child.md'), '# Child\n', 'utf8');
      await fs.writeFile(path.join(dir, 'plan', 'sub', 'grandchild.md'), '# Grandchild\n', 'utf8');
      await storage.scanSpace(sp.slug);

      const before = await storage.listEntries(sp.slug);
      const childBefore = before.find((e) => e.relPath === 'plan/child.md')!;
      const grandchildBefore = before.find((e) => e.relPath === 'plan/sub/grandchild.md')!;
      expect(childBefore).toBeDefined();
      expect(grandchildBefore).toBeDefined();

      await storage.deletePage(parent.id, admin.id);

      // Nothing left behind in the space: the whole `plan/` directory is gone.
      await expect(fs.access(path.join(dir, 'plan'))).rejects.toThrow();
      await expect(fs.access(path.join(dir, 'plan.md'))).rejects.toThrow();
      expect(await storage.getEntry(childBefore.id)).toBeUndefined();
      expect(await storage.getEntry(grandchildBefore.id)).toBeUndefined();

      const row = await rowForPage(parent.id);
      expect(row).toBeDefined();
      expect(row!.kind).toBe('doc');
      expect(row!.orig_path).toBe('plan.md');
      // Real descendant count, not the old hardcoded 0.
      expect(row!.children_count).toBe(2);
    } finally {
      await deleteTestSpace(sp.slug);
      createdSlugs.delete(sp.slug);
    }
  });

  it('restoring that deletion brings the page AND its children back at their original paths, with ids intact', async () => {
    const sp = await makeSpace('restore');
    const dir = storage.getSpaceDir(sp.slug);
    try {
      const parent = await storage.createPage({ space: sp.slug, parentPath: '', title: 'Plan', kind: 'doc' });
      await fs.mkdir(path.join(dir, 'plan', 'sub'), { recursive: true });
      await fs.writeFile(path.join(dir, 'plan', 'child.md'), '# Child\n', 'utf8');
      await fs.writeFile(path.join(dir, 'plan', 'sub', 'grandchild.md'), '# Grandchild\n', 'utf8');
      await storage.scanSpace(sp.slug);

      const before = await storage.listEntries(sp.slug);
      const childBefore = before.find((e) => e.relPath === 'plan/child.md')!;
      const grandchildBefore = before.find((e) => e.relPath === 'plan/sub/grandchild.md')!;

      await storage.deletePage(parent.id, admin.id);
      const row = await rowForPage(parent.id);
      expect(row).toBeDefined();

      const res = await restoreTrashItem(admin, row!.id);
      expect(res).toMatchObject({ restoredPath: 'plan.md', renamed: false, pageId: parent.id });

      await expect(fs.access(path.join(dir, 'plan.md'))).resolves.toBeUndefined();
      await expect(fs.access(path.join(dir, 'plan', 'child.md'))).resolves.toBeUndefined();
      await expect(fs.access(path.join(dir, 'plan', 'sub', 'grandchild.md'))).resolves.toBeUndefined();

      const after = await storage.listEntries(sp.slug);
      expect(after.find((e) => e.id === parent.id)?.relPath).toBe('plan.md');
      expect(after.find((e) => e.id === childBefore.id)?.relPath).toBe('plan/child.md');
      expect(after.find((e) => e.id === grandchildBefore.id)?.relPath).toBe('plan/sub/grandchild.md');

      // The trash row is gone once restored.
      expect(await rowForPage(parent.id)).toBeUndefined();
    } finally {
      await deleteTestSpace(sp.slug);
      createdSlugs.delete(sp.slug);
    }
  });

  it('rollback: if the children-directory move fails, nothing is left half-deleted', async () => {
    const sp = await makeSpace('rollback');
    const dir = storage.getSpaceDir(sp.slug);
    try {
      const parent = await storage.createPage({ space: sp.slug, parentPath: '', title: 'Plan', kind: 'doc' });
      await fs.mkdir(path.join(dir, 'plan'), { recursive: true });
      await fs.writeFile(path.join(dir, 'plan', 'child.md'), '# Child\n', 'utf8');
      await storage.scanSpace(sp.slug);
      const childBefore = (await storage.listEntries(sp.slug)).find((e) => e.relPath === 'plan/child.md')!;

      const childDirAbs = path.join(dir, 'plan');
      const realRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename;
      vi.mocked(fs.rename).mockImplementation(async (oldPath: unknown, newPath: unknown) => {
        if (oldPath === childDirAbs) throw new Error('injected-rename-failure');
        return realRename(oldPath as never, newPath as never);
      });

      await expect(storage.deletePage(parent.id, admin.id)).rejects.toThrow('injected-rename-failure');

      // Nothing half-deleted: the file AND the directory are both back where they started.
      expect(await pathExists(path.join(dir, 'plan.md'))).toBe(true);
      expect(await pathExists(path.join(dir, 'plan'))).toBe(true);
      expect(await pathExists(path.join(dir, 'plan', 'child.md'))).toBe(true);
      // No trash row was recorded for a deletion that never actually completed.
      expect(await rowForPage(parent.id)).toBeUndefined();
      expect(await storage.getEntry(parent.id)).toBeDefined();
      expect(await storage.getEntry(childBefore.id)).toBeDefined();
    } finally {
      vi.mocked(fs.rename).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename as never);
      await deleteTestSpace(sp.slug);
      createdSlugs.delete(sp.slug);
    }
  });

  it('regression: shape-(1) index-page delete/restore is unaffected', async () => {
    const sp = await makeSpace('index-regress');
    const dir = storage.getSpaceDir(sp.slug);
    try {
      await fs.mkdir(path.join(dir, 'notes'), { recursive: true });
      await fs.writeFile(path.join(dir, 'notes', 'index.md'), '# Notes\n', 'utf8');
      await storage.scanSpace(sp.slug);
      const child1 = await storage.createPage({ space: sp.slug, parentPath: 'notes', title: 'Child One', kind: 'doc' });
      const child2 = await storage.createPage({ space: sp.slug, parentPath: 'notes', title: 'Child Two', kind: 'doc' });
      const indexEntry = (await storage.listEntries(sp.slug)).find((e) => e.relPath === 'notes/index.md')!;

      await storage.deletePage(indexEntry.id, admin.id);
      const row = await rowForPage(indexEntry.id);
      expect(row!.kind).toBe('folder');
      expect(row!.orig_path).toBe('notes');
      expect(row!.children_count).toBe(2);
      expect(await storage.getEntry(child1.id)).toBeUndefined();

      const res = await restoreTrashItem(admin, row!.id);
      expect(res).toMatchObject({ restoredPath: 'notes', renamed: false, pageId: indexEntry.id });

      const after = await storage.listEntries(sp.slug);
      expect(after.find((e) => e.relPath === 'notes/index.md')?.id).toBe(indexEntry.id);
      expect(after.find((e) => e.relPath === child1.path)?.id).toBe(child1.id);
      expect(after.find((e) => e.relPath === child2.path)?.id).toBe(child2.id);
    } finally {
      await deleteTestSpace(sp.slug);
      createdSlugs.delete(sp.slug);
    }
  });

  it('regression: an ordinary leaf page with no sibling children directory still deletes/restores as a single file (childrenCount 0)', async () => {
    const sp = await makeSpace('plain-leaf');
    const dir = storage.getSpaceDir(sp.slug);
    try {
      const page = await storage.createPage({ space: sp.slug, parentPath: '', title: 'Lonely', kind: 'doc' });
      await storage.deletePage(page.id, admin.id);
      const row = await rowForPage(page.id);
      expect(row!.children_count).toBe(0);
      expect(row!.orig_path).toBe('lonely.md');

      const res = await restoreTrashItem(admin, row!.id);
      expect(res).toMatchObject({ restoredPath: 'lonely.md', renamed: false, pageId: page.id });
      await expect(fs.access(path.join(dir, 'lonely.md'))).resolves.toBeUndefined();
    } finally {
      await deleteTestSpace(sp.slug);
      createdSlugs.delete(sp.slug);
    }
  });
});
