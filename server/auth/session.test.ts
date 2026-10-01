/**
 * Round 27 (access and rights) — auth/session.ts's role-resolution core against
 * a real PG test schema. This is the layer everything else in the round
 * (requireSpaceRole/requirePageRole, the collab WS upgrade, MCP tool
 * checks, GET /api/spaces) is built on, per spec-access.md §12: "SHELL
 * starts after SERVER fixes the contracts" — these are the
 * contracts. See server/access/accessBoundary.test.ts for the end-to-end
 * six-path acceptance suite (spec §11.1) built on top of this module.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpTestSchema, deleteTestSpace } from '../db/testSchema.js';
import * as storage from '../storage.js';
import * as authStore from './store.js';
import * as session from './session.js';

describe('auth/session (round 27, real PG)', () => {
  let teardownSchema: () => Promise<void>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  it('effectiveRole: instance-admin with NO membership gets undefined on a private space — no bypass', async () => {
    const admin = await authStore.createUser({ email: `sess-admin-${Date.now()}@t.local`, name: 'Admin', passwordHash: 'x', isAdmin: true });
    const space = await storage.createSpace(`Session Private ${Date.now()}`, null);

    expect(await session.effectiveRole(admin, space.slug)).toBeUndefined();

    await deleteTestSpace(space.slug);
  });

  it('effectiveRole: explicit membership always wins, instance-admin or not', async () => {
    const user = await authStore.createUser({ email: `sess-member-${Date.now()}@t.local`, name: 'Member', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Session Explicit ${Date.now()}`, null);
    await authStore.setMembership(space.slug, user.id, 'editor');

    expect(await session.effectiveRole(user, space.slug)).toBe('editor');

    await deleteTestSpace(space.slug);
  });

  it('effectiveRole: visibility "instance" grants an implicit viewer to any active user with no explicit membership, but never upgrades an explicit role', async () => {
    const outsider = await authStore.createUser({ email: `sess-outsider-${Date.now()}@t.local`, name: 'Outsider', passwordHash: 'x', isAdmin: false });
    const editor = await authStore.createUser({ email: `sess-editor-${Date.now()}@t.local`, name: 'Editor', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Session Instance Vis ${Date.now()}`, null);
    await authStore.setMembership(space.slug, editor.id, 'editor');
    await authStore.setSpaceVisibility(space.slug, 'instance');

    expect(await session.effectiveRole(outsider, space.slug)).toBe('viewer');
    expect(await session.effectiveRole(editor, space.slug)).toBe('editor'); // not downgraded to the implicit viewer

    // private again: the implicit grant disappears
    await authStore.setSpaceVisibility(space.slug, 'private');
    expect(await session.effectiveRole(outsider, space.slug)).toBeUndefined();

    await deleteTestSpace(space.slug);
  });

  it('effectiveRole: a disabled user gets nothing, via either explicit membership or instance visibility', async () => {
    const user = await authStore.createUser({ email: `sess-disabled-${Date.now()}@t.local`, name: 'Disabled', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Session Disabled ${Date.now()}`, null);
    await authStore.setMembership(space.slug, user.id, 'admin');
    await authStore.setSpaceVisibility(space.slug, 'instance');
    const disabled = { ...user, disabled: true };

    expect(await session.effectiveRole(disabled, space.slug)).toBeUndefined();

    await deleteTestSpace(space.slug);
  });

  it('membershipsFor: instance-admin with no explicit rows sees ONLY instance-visibility spaces, not every space', async () => {
    const admin = await authStore.createUser({ email: `sess-msf-admin-${Date.now()}@t.local`, name: 'Admin', passwordHash: 'x', isAdmin: true });
    const privateSpace = await storage.createSpace(`Session MembershipsFor Private ${Date.now()}`, null);
    const instanceSpace = await storage.createSpace(`Session MembershipsFor Instance ${Date.now()}`, null);
    await authStore.setSpaceVisibility(instanceSpace.slug, 'instance');

    const memberships = await session.membershipsFor(admin);
    expect(memberships[privateSpace.slug]).toBeUndefined();
    expect(memberships[instanceSpace.slug]).toBe('viewer');

    await deleteTestSpace(privateSpace.slug);
    await deleteTestSpace(instanceSpace.slug);
  });

  it('membershipsFor: a disabled user sees nothing at all, even with explicit memberships', async () => {
    const user = await authStore.createUser({ email: `sess-msf-disabled-${Date.now()}@t.local`, name: 'Disabled', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Session MembershipsFor Disabled ${Date.now()}`, null);
    await authStore.setMembership(space.slug, user.id, 'admin');
    const disabled = { ...user, disabled: true };

    expect(await session.membershipsFor(disabled)).toEqual({});

    await deleteTestSpace(space.slug);
  });

  it('canAdministerSpace: true for an instance-admin even with no membership at all', async () => {
    const admin = await authStore.createUser({ email: `sess-canadmin-instance-${Date.now()}@t.local`, name: 'Admin', passwordHash: 'x', isAdmin: true });
    const space = await storage.createSpace(`Session CanAdminister Instance ${Date.now()}`, null);

    expect(await session.canAdministerSpace(admin, space.slug)).toBe(true);

    await deleteTestSpace(space.slug);
  });

  it('canAdministerSpace: true for the space\'s own explicit admin, false for editor/viewer/no-role, even non-instance-admins', async () => {
    const spaceAdmin = await authStore.createUser({ email: `sess-canadmin-space-${Date.now()}@t.local`, name: 'SpaceAdmin', passwordHash: 'x', isAdmin: false });
    const editor = await authStore.createUser({ email: `sess-canadmin-editor-${Date.now()}@t.local`, name: 'Editor', passwordHash: 'x', isAdmin: false });
    const outsider = await authStore.createUser({ email: `sess-canadmin-outsider-${Date.now()}@t.local`, name: 'Outsider', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Session CanAdminister Space ${Date.now()}`, null);
    await authStore.setMembership(space.slug, spaceAdmin.id, 'admin');
    await authStore.setMembership(space.slug, editor.id, 'editor');

    expect(await session.canAdministerSpace(spaceAdmin, space.slug)).toBe(true);
    expect(await session.canAdministerSpace(editor, space.slug)).toBe(false);
    expect(await session.canAdministerSpace(outsider, space.slug)).toBe(false);

    await deleteTestSpace(space.slug);
  });
});
