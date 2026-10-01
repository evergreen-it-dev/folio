import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '../shared/contracts.js';
import { setUpTestSchema } from './db/testSchema.js';
import * as storage from './storage.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';

describe('@mentions: username preference + mentionable listing (round 15, real PG)', () => {
  let teardownSchema: () => Promise<void>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });

  afterAll(async () => {
    await teardownSchema();
  });

  describe('updateUsername (PATCH /api/me/preferences {username})', () => {
    it('a fresh user has no username set (undefined, not a stored default)', async () => {
      const user = await authStore.createUser({ email: 'fresh-username@mentions-test.local', name: 'Fresh', passwordHash: 'x', isAdmin: false });
      expect(user.username).toBeUndefined();
    });

    it('normalizes mixed-case input to lower-case before storing (defense in depth: the route already lower-cases too)', async () => {
      const user = await authStore.createUser({ email: 'mixed-case@mentions-test.local', name: 'Mixed', passwordHash: 'x', isAdmin: false });
      const updated = await authStore.updateUsername(user.id, 'JohnDoe');
      expect(updated.username).toBe('johndoe');

      // durable, and the same lower-case value comes back through every read path
      const reloaded = await authStore.findStoredUserById(user.id);
      expect(reloaded?.username).toBe('johndoe');
      expect((await authStore.listUsers()).find((u) => u.id === user.id)?.username).toBe('johndoe');
    });

    it('rejects a handle already taken by another user as a 409 conflict, case-insensitively', async () => {
      const a = await authStore.createUser({ email: 'handle-a@mentions-test.local', name: 'A', passwordHash: 'x', isAdmin: false });
      const b = await authStore.createUser({ email: 'handle-b@mentions-test.local', name: 'B', passwordHash: 'x', isAdmin: false });
      await authStore.updateUsername(a.id, 'alice');

      await expect(authStore.updateUsername(b.id, 'ALICE')).rejects.toMatchObject({ status: 409 });

      // the failed attempt left b's own row untouched
      expect((await authStore.findStoredUserById(b.id))?.username).toBeUndefined();
    });

    it('null unsets a previously-chosen handle, and the freed handle can be claimed by someone else', async () => {
      const user = await authStore.createUser({ email: 'unset@mentions-test.local', name: 'Unset', passwordHash: 'x', isAdmin: false });
      await authStore.updateUsername(user.id, 'toremove');

      const cleared = await authStore.updateUsername(user.id, null);
      expect(cleared.username).toBeUndefined();

      const other = await authStore.createUser({ email: 'reuse@mentions-test.local', name: 'Reuse', passwordHash: 'x', isAdmin: false });
      const reused = await authStore.updateUsername(other.id, 'toremove');
      expect(reused.username).toBe('toremove');
    });

    it('updateUsername for a nonexistent user throws (not found), never silently no-ops', async () => {
      await expect(authStore.updateUsername('00000000-0000-0000-0000-000000000000', 'ghost')).rejects.toThrow();
    });
  });

  describe('listMentionableUsers + the viewer+ role gate (GET /api/spaces/:space/mentionable)', () => {
    let spaceSlug: string;
    let viewer: User;
    let editorNoHandle: User;
    let instanceAdmin: User;
    let outsider: User;

    beforeAll(async () => {
      const space = await storage.createSpace(`Mentions Test ${Date.now()}`, null);
      spaceSlug = space.slug;

      viewer = await authStore.createUser({ email: 'viewer@mentions-test.local', name: 'Zed Viewer', passwordHash: 'x', isAdmin: false });
      await authStore.updateUsername(viewer.id, 'zedviewer');
      await authStore.setMembership(spaceSlug, viewer.id, 'viewer');

      // a real member of the space, but with no @mention handle chosen yet
      editorNoHandle = await authStore.createUser({ email: 'editor-no-handle@mentions-test.local', name: 'Ann NoHandle', passwordHash: 'x', isAdmin: false });
      await authStore.setMembership(spaceSlug, editorNoHandle.id, 'editor');

      // Round 27 (access and rights): an instance admin with a handle, deliberately
      // NOT added as an explicit space_members row — since the old `OR
      // u.is_admin` mentionable bypass and the old effectiveRole instance-admin
      // bypass are BOTH gone, this user is now exactly as much of an outsider
      // to this (private) space as `outsider` below, for every purpose this
      // describe block checks. See the two tests below this block was
      // rewritten for, plus server/access/accessBoundary.test.ts's "path 1"
      // and "path 6" for the full six-path acceptance version of this.
      instanceAdmin = await authStore.createUser({ email: 'instance-admin@mentions-test.local', name: 'Amy Admin', passwordHash: 'x', isAdmin: true });
      await authStore.updateUsername(instanceAdmin.id, 'amyadmin');

      // neither a member nor an instance admin
      outsider = await authStore.createUser({ email: 'outsider@mentions-test.local', name: 'Ollie Outsider', passwordHash: 'x', isAdmin: false });
    });

    afterAll(async () => {
      const root = (await storage.listEntries(spaceSlug)).find((e) => e.dirPath === '' && e.isIndex);
      if (root) await storage.deletePage(root.id).catch(() => {});
    });

    it('lists a space member who has a username, sorted by name — round 27: an instance admin with NO explicit membership is NOT listed (the old `OR u.is_admin` bypass is gone)', async () => {
      const list = await authStore.listMentionableUsers(spaceSlug);
      expect(list).toEqual([{ username: 'zedviewer', name: 'Zed Viewer' }]);
      expect(list.find((u) => u.username === 'amyadmin')).toBeUndefined();
    });

    it('round 27: a space with visibility "instance" DOES list that same instance admin (and any other active user with a handle) as an implicit viewer', async () => {
      await authStore.setSpaceVisibility(spaceSlug, 'instance');
      try {
        const list = await authStore.listMentionableUsers(spaceSlug);
        expect(list.find((u) => u.username === 'amyadmin')).toEqual({ username: 'amyadmin', name: 'Amy Admin' });
      } finally {
        await authStore.setSpaceVisibility(spaceSlug, 'private');
      }
    });

    it('excludes a space member who has not chosen a username, regardless of role', async () => {
      const list = await authStore.listMentionableUsers(spaceSlug);
      expect(list.find((u) => u.name === 'Ann NoHandle')).toBeUndefined();

      // role isn't the gate, only "has a username" -- once she sets one, she appears too
      await authStore.updateUsername(editorNoHandle.id, 'annnohandle');
      const listAfter = await authStore.listMentionableUsers(spaceSlug);
      expect(listAfter.find((u) => u.username === 'annnohandle')).toEqual({ username: 'annnohandle', name: 'Ann NoHandle' });
    });

    it('a viewer of the space passes the role gate (requireSpaceRole resolves instead of throwing)', async () => {
      const fakeRequest = { authUser: viewer } as unknown as FastifyRequest;
      await expect(session.requireSpaceRole(fakeRequest, spaceSlug, 'viewer')).resolves.toBe('viewer');
    });

    it('round 27: an instance admin with NO explicit membership row is now REJECTED by the role gate too, same as any other outsider — the old admin bypass in effectiveRole is gone', async () => {
      const fakeRequest = { authUser: instanceAdmin } as unknown as FastifyRequest;
      await expect(session.requireSpaceRole(fakeRequest, spaceSlug, 'viewer')).rejects.toMatchObject({ status: 403 });
    });

    it('an unrelated outsider is rejected with 403, not handed the list', async () => {
      const fakeRequest = { authUser: outsider } as unknown as FastifyRequest;
      await expect(session.requireSpaceRole(fakeRequest, spaceSlug, 'viewer')).rejects.toMatchObject({ status: 403 });
    });
  });
});
