import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as authStore from './auth/store.js';
import * as storage from './storage.js';
import * as gitSync from './gitSync.js';
import { findTrashItemId, listPageChanges, recordPageChange, snapshotPageChange, undoPageChange } from './pageChanges.js';

describe('the personal history of structural changes to pages', () => {
  let teardownSchema: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });

  afterAll(async () => {
    await teardownSchema?.();
  });

  it('shows only my actions and unwinds a move and a rename in reverse order', async () => {
    const actor = await authStore.createUser({
      email: `changes-owner-${Date.now()}@test.local`,
      name: 'Owner',
      passwordHash: 'x',
      isAdmin: false,
    });
    const other = await authStore.createUser({
      email: `changes-other-${Date.now()}@test.local`,
      name: 'Other',
      passwordHash: 'x',
      isAdmin: false,
    });
    const space = await storage.createSpace(`Undo stack ${Date.now()}`, actor.id);
    await authStore.setMembership(space.slug, actor.id, 'admin');
    await authStore.setMembership(space.slug, other.id, 'editor');

    try {
      // The destination directory exists thanks to this page; the subject of the test is another page.
      await storage.createPage({ space: space.slug, parentPath: 'destination', title: 'Holder', kind: 'doc' });
      const created = await storage.createPage({ space: space.slug, parentPath: '', title: 'Old title', kind: 'doc' });

      const beforeRename = snapshotPageChange(await storage.requireEntry(created.id));
      await storage.renameDocDirect(created.id, 'New title');
      const afterRename = snapshotPageChange(await storage.requireEntry(created.id));
      await recordPageChange(actor.id, 'page.rename', created.id, space.slug, beforeRename, afterRename);

      const beforeMove = snapshotPageChange(await storage.requireEntry(created.id));
      await storage.movePage(created.id, 'destination');
      const afterMove = snapshotPageChange(await storage.requireEntry(created.id));
      await recordPageChange(actor.id, 'page.move', created.id, space.slug, beforeMove, afterMove);

      expect(await listPageChanges(other.id, space.slug)).toEqual([]);
      const stack = await listPageChanges(actor.id, space.slug);
      expect(stack.map((item) => item.action)).toEqual(['page.move', 'page.rename']);
      expect(stack[0].before?.parentPath).toBe('');
      expect(stack[0].after.parentPath).toBe('destination');

      await undoPageChange(actor, space.slug, stack[0].id);
      expect((await storage.requireEntry(created.id)).relPath).toBe('old-title.md');
      expect((await storage.requireEntry(created.id)).title).toBe('New title');

      const remaining = await listPageChanges(actor.id, space.slug);
      expect(remaining).toHaveLength(1);
      await undoPageChange(actor, space.slug, remaining[0].id);
      expect((await storage.requireEntry(created.id)).title).toBe('Old title');
      expect(await listPageChanges(actor.id, space.slug)).toEqual([]);
    } finally {
      await gitSync.flushAllPendingSyncs();
      await deleteTestSpace(space.slug);
    }
  });

  it('undoes the deletion of a page — it comes back from the trash to its place', async () => {
    const actor = await authStore.createUser({
      email: `changes-delete-${Date.now()}@test.local`,
      name: 'Owner',
      passwordHash: 'x',
      isAdmin: false,
    });
    const space = await storage.createSpace(`Undo delete ${Date.now()}`, actor.id);
    await authStore.setMembership(space.slug, actor.id, 'admin');

    try {
      const created = await storage.createPage({ space: space.slug, parentPath: '', title: 'Deletable', kind: 'doc' });
      const before = snapshotPageChange(await storage.requireEntry(created.id));

      await storage.deletePage(created.id, actor.id);
      const trashItemId = await findTrashItemId(created.id);
      expect(trashItemId).toBeTruthy();
      await recordPageChange(actor.id, 'page.delete', created.id, space.slug, before, { ...before, trashItemId });

      const stack = await listPageChanges(actor.id, space.slug);
      expect(stack).toHaveLength(1);
      expect(stack[0].action).toBe('page.delete');

      const { page } = await undoPageChange(actor, space.slug, stack[0].id);
      expect(page?.path).toBe(before.path);
      const restored = await storage.requireEntry(created.id);
      expect(restored.relPath).toBe('deletable.md');
      expect(restored.title).toBe('Deletable');
      expect(await listPageChanges(actor.id, space.slug)).toEqual([]);
    } finally {
      await gitSync.flushAllPendingSyncs();
      await deleteTestSpace(space.slug);
    }
  });
});
