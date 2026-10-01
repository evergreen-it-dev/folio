import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as authStore from './auth/store.js';
import * as storage from './storage.js';
import * as session from './auth/session.js';
import * as pageAccess from './pageAccess.js';

describe('page-level rights', () => {
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    teardown = await setUpTestSchema();
  });
  afterAll(async () => teardown());

  it('hides a private page and allows separate viewer/editor grants', async () => {
    const stamp = Date.now();
    const owner = await authStore.createUser({ email: `page-owner-${stamp}@test.local`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    const viewer = await authStore.createUser({ email: `page-viewer-${stamp}@test.local`, name: 'Viewer', passwordHash: 'x', isAdmin: false });
    const editor = await authStore.createUser({ email: `page-editor-${stamp}@test.local`, name: 'Editor', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Page ACL ${stamp}`, owner.id);
    await authStore.setMembership(space.slug, owner.id, 'admin');
    await authStore.setMembership(space.slug, viewer.id, 'viewer');
    await authStore.setMembership(space.slug, editor.id, 'viewer');
    const meta = await storage.createPage({ space: space.slug, parentPath: '', title: 'Secret', kind: 'doc' });
    const entry = await storage.requireEntry(meta.id);

    expect(await session.effectivePageRole(viewer, entry)).toBe('viewer');
    await pageAccess.setAccess(owner, entry, 'restricted', [{ userId: editor.id, role: 'editor' }]);

    expect(await session.effectivePageRole(owner, entry)).toBe('editor');
    expect(await session.effectivePageRole(viewer, entry)).toBeUndefined();
    expect(await session.effectivePageRole(editor, entry)).toBe('editor');
    expect((await session.readablePageIds(viewer, space.slug)).has(entry.id)).toBe(false);
    expect((await session.readablePageIds(editor, space.slug)).has(entry.id)).toBe(true);

    await pageAccess.setAccess(owner, entry, 'space', []);
    expect(await session.effectivePageRole(viewer, entry)).toBe('viewer');
    await deleteTestSpace(space.slug);
  });
});
