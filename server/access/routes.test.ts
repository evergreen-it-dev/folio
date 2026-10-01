/**
 * Round 27 (access and rights) — server/access/routes.ts's exported business
 * functions, unit-tested directly against a real PG test schema (same
 * pattern as server/routes.ts's buildAdminSpacesList / server/routes.test.ts
 * — this codebase has no HTTP-level Fastify test harness, see that file's
 * doc comment). recordAudit (server/audit.ts) is fire-and-forget, so tests
 * that assert on an audit row poll briefly for it instead of assuming it's
 * already landed by the time the awaited call above it returns.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpTestSchema, deleteTestSpace } from '../db/testSchema.js';
import * as storage from '../storage.js';
import * as authStore from '../auth/store.js';
import { applyAccessBulk, buildAccessMatrix, getSpaceAccessLog, getUserAccess, updateSpaceVisibility } from './routes.js';

async function pollUntil<T>(check: () => Promise<T | undefined>, timeoutMs = 5000, intervalMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) throw new Error('pollUntil: condition not met in time');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('access/routes (round 27, real PG)', () => {
  let teardownSchema: () => Promise<void>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  // ---------------------------------------------------------------------
  // buildAccessMatrix
  // ---------------------------------------------------------------------

  it('buildAccessMatrix: instance-admin only', async () => {
    const notAdmin = await authStore.createUser({ email: `mtx-notadmin-${Date.now()}@t.local`, name: 'N', passwordHash: 'x', isAdmin: false });
    await expect(buildAccessMatrix(notAdmin)).rejects.toThrow();
  });

  it('buildAccessMatrix: reports every space with its visibility, and roles ONLY from explicit membership (not the instance-visibility implicit viewer)', async () => {
    const admin = await authStore.createUser({ email: `mtx-admin-${Date.now()}@t.local`, name: 'Admin', passwordHash: 'x', isAdmin: true });
    const member = await authStore.createUser({ email: `mtx-member-${Date.now()}@t.local`, name: 'Member', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Matrix Space ${Date.now()}`, null);
    await authStore.setMembership(space.slug, member.id, 'editor');
    await authStore.setSpaceVisibility(space.slug, 'instance');

    const matrix = await buildAccessMatrix(admin);
    const spaceEntry = matrix.spaces.find((s) => s.slug === space.slug);
    expect(spaceEntry?.visibility).toBe('instance');
    expect(matrix.roles[member.id]?.[space.slug]).toBe('editor');
    // admin has no explicit row here — must not appear despite being an instance-admin
    expect(matrix.roles[admin.id]?.[space.slug]).toBeUndefined();
    expect(matrix.users.find((u) => u.id === admin.id)?.isAdmin).toBe(true);

    await deleteTestSpace(space.slug);
  });

  // ---------------------------------------------------------------------
  // applyAccessBulk
  // ---------------------------------------------------------------------

  it('applyAccessBulk: instance-admin can grant/revoke across multiple spaces in one batch; each writes access.grant/access.revoke', async () => {
    const admin = await authStore.createUser({ email: `bulk-admin-${Date.now()}@t.local`, name: 'Admin', passwordHash: 'x', isAdmin: true });
    const target = await authStore.createUser({ email: `bulk-target-${Date.now()}@t.local`, name: 'Target', passwordHash: 'x', isAdmin: false });
    const spaceA = await storage.createSpace(`Bulk A ${Date.now()}`, null);
    const spaceB = await storage.createSpace(`Bulk B ${Date.now()}`, null);
    await authStore.setMembership(spaceB.slug, target.id, 'viewer');

    const result = await applyAccessBulk(admin, {
      changes: [
        { userId: target.id, space: spaceA.slug, role: 'editor' },
        { userId: target.id, space: spaceB.slug, role: null },
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual(
      expect.arrayContaining([
        { userId: target.id, space: spaceA.slug, role: 'editor' },
        { userId: target.id, space: spaceB.slug, role: null },
      ]),
    );
    expect(await authStore.getMembershipRole(spaceA.slug, target.id)).toBe('editor');
    expect(await authStore.getMembershipRole(spaceB.slug, target.id)).toBeUndefined();

    const grantEntry = await pollUntil(async () => (await authStore.listAccessLogForSpace(spaceA.slug)).find((e) => e.action === 'access.grant'));
    expect(grantEntry.actorId).toBe(admin.id);
    expect(grantEntry.meta.targetUserId).toBe(target.id);
    expect(grantEntry.meta.role).toBe('editor');

    const revokeEntry = await pollUntil(async () => (await authStore.listAccessLogForSpace(spaceB.slug)).find((e) => e.action === 'access.revoke'));
    expect(revokeEntry.meta.targetUserId).toBe(target.id);

    await deleteTestSpace(spaceA.slug);
    await deleteTestSpace(spaceB.slug);
  });

  it('applyAccessBulk: an instance-admin granting THEMSELVES access is allowed but writes access.self_grant, carrying an optional reason', async () => {
    const admin = await authStore.createUser({ email: `bulk-selfgrant-${Date.now()}@t.local`, name: 'Admin', passwordHash: 'x', isAdmin: true });
    const space = await storage.createSpace(`Bulk SelfGrant ${Date.now()}`, null);

    const result = await applyAccessBulk(admin, {
      changes: [{ userId: admin.id, space: space.slug, role: 'admin' }],
      reason: 'need to fix a broken page',
    });

    expect(result.errors).toEqual([]);
    expect(await authStore.getMembershipRole(space.slug, admin.id)).toBe('admin');

    const entry = await pollUntil(async () => (await authStore.listAccessLogForSpace(space.slug))[0]);
    expect(entry.action).toBe('access.self_grant');
    expect(entry.actorId).toBe(admin.id);
    expect(entry.meta.reason).toBe('need to fix a broken page');

    await deleteTestSpace(space.slug);
  });

  it('applyAccessBulk: a space admin (not instance-admin) may change roles ONLY in a space they administer — other spaces in the same batch fail as row-level errors, not a whole-batch rejection', async () => {
    const spaceAdmin = await authStore.createUser({ email: `bulk-spaceadmin-${Date.now()}@t.local`, name: 'SpaceAdmin', passwordHash: 'x', isAdmin: false });
    const target = await authStore.createUser({ email: `bulk-spaceadmin-target-${Date.now()}@t.local`, name: 'Target', passwordHash: 'x', isAdmin: false });
    const ownSpace = await storage.createSpace(`Bulk Own ${Date.now()}`, null);
    const otherSpace = await storage.createSpace(`Bulk Other ${Date.now()}`, null);
    await authStore.setMembership(ownSpace.slug, spaceAdmin.id, 'admin');

    const result = await applyAccessBulk(spaceAdmin, {
      changes: [
        { userId: target.id, space: ownSpace.slug, role: 'editor' },
        { userId: target.id, space: otherSpace.slug, role: 'editor' },
      ],
    });

    expect(result.applied).toEqual([{ userId: target.id, space: ownSpace.slug, role: 'editor' }]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].space).toBe(otherSpace.slug);
    expect(await authStore.getMembershipRole(otherSpace.slug, target.id)).toBeUndefined();

    await deleteTestSpace(ownSpace.slug);
    await deleteTestSpace(otherSpace.slug);
  });

  it('applyAccessBulk: rejects (as a row error, membership untouched) revoking or demoting the last admin of a space', async () => {
    const admin = await authStore.createUser({ email: `bulk-lastadmin-${Date.now()}@t.local`, name: 'Admin', passwordHash: 'x', isAdmin: true });
    const soleSpaceAdmin = await authStore.createUser({ email: `bulk-solespaceadmin-${Date.now()}@t.local`, name: 'Sole', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Bulk LastAdmin ${Date.now()}`, null);
    await authStore.setMembership(space.slug, soleSpaceAdmin.id, 'admin');

    const revokeResult = await applyAccessBulk(admin, { changes: [{ userId: soleSpaceAdmin.id, space: space.slug, role: null }] });
    expect(revokeResult.applied).toEqual([]);
    expect(revokeResult.errors[0].error).toMatch(/last admin/i);
    expect(await authStore.getMembershipRole(space.slug, soleSpaceAdmin.id)).toBe('admin');

    const demoteResult = await applyAccessBulk(admin, { changes: [{ userId: soleSpaceAdmin.id, space: space.slug, role: 'viewer' }] });
    expect(demoteResult.applied).toEqual([]);
    expect(demoteResult.errors[0].error).toMatch(/last admin/i);
    expect(await authStore.getMembershipRole(space.slug, soleSpaceAdmin.id)).toBe('admin');

    await deleteTestSpace(space.slug);
  });

  it('applyAccessBulk: unknown space and unknown user each surface as their own row error', async () => {
    const admin = await authStore.createUser({ email: `bulk-unknown-${Date.now()}@t.local`, name: 'Admin', passwordHash: 'x', isAdmin: true });
    const target = await authStore.createUser({ email: `bulk-unknown-target-${Date.now()}@t.local`, name: 'Target', passwordHash: 'x', isAdmin: false });

    const result = await applyAccessBulk(admin, {
      changes: [
        { userId: target.id, space: 'no-such-space-slug', role: 'editor' },
        { userId: '00000000-0000-0000-0000-000000000000', space: 'no-such-space-slug', role: 'editor' },
      ],
    });

    expect(result.applied).toEqual([]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].error).toMatch(/space not found/);
  });

  // ---------------------------------------------------------------------
  // updateSpaceVisibility
  // ---------------------------------------------------------------------

  it('updateSpaceVisibility: instance-admin or the space\'s own admin may change it; an editor/outsider may not; writes a space.visibility audit event', async () => {
    const instanceAdmin = await authStore.createUser({ email: `vis-instadmin-${Date.now()}@t.local`, name: 'A', passwordHash: 'x', isAdmin: true });
    const spaceAdmin = await authStore.createUser({ email: `vis-spaceadmin-${Date.now()}@t.local`, name: 'B', passwordHash: 'x', isAdmin: false });
    const editor = await authStore.createUser({ email: `vis-editor-${Date.now()}@t.local`, name: 'C', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Visibility Space ${Date.now()}`, null);
    await authStore.setMembership(space.slug, spaceAdmin.id, 'admin');
    await authStore.setMembership(space.slug, editor.id, 'editor');

    await expect(updateSpaceVisibility(editor, space.slug, 'instance')).rejects.toThrow();

    const result = await updateSpaceVisibility(instanceAdmin, space.slug, 'instance');
    expect(result.visibility).toBe('instance');
    expect((await storage.getSpaceInfo(space.slug))?.visibility).toBe('instance');

    const entry = await pollUntil(async () => (await authStore.listAccessLogForSpace(space.slug)).find((e) => e.action === 'space.visibility'));
    expect(entry.actorId).toBe(instanceAdmin.id);
    expect(entry.meta.visibility).toBe('instance');

    const bySpaceAdmin = await updateSpaceVisibility(spaceAdmin, space.slug, 'private');
    expect(bySpaceAdmin.visibility).toBe('private');

    await deleteTestSpace(space.slug);
  });

  it('updateSpaceVisibility: 404 for a space that does not exist', async () => {
    const admin = await authStore.createUser({ email: `vis-404-${Date.now()}@t.local`, name: 'A', passwordHash: 'x', isAdmin: true });
    await expect(updateSpaceVisibility(admin, 'no-such-space-slug', 'instance')).rejects.toThrow();
  });

  // ---------------------------------------------------------------------
  // getSpaceAccessLog
  // ---------------------------------------------------------------------

  it('getSpaceAccessLog: visible to instance-admins and the space\'s own admin, not to an editor or outsider', async () => {
    const instanceAdmin = await authStore.createUser({ email: `log-instadmin-${Date.now()}@t.local`, name: 'A', passwordHash: 'x', isAdmin: true });
    const spaceAdmin = await authStore.createUser({ email: `log-spaceadmin-${Date.now()}@t.local`, name: 'B', passwordHash: 'x', isAdmin: false });
    const editor = await authStore.createUser({ email: `log-editor-${Date.now()}@t.local`, name: 'C', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Log Space ${Date.now()}`, null);
    await authStore.setMembership(space.slug, spaceAdmin.id, 'admin');
    await authStore.setMembership(space.slug, editor.id, 'editor');
    await updateSpaceVisibility(instanceAdmin, space.slug, 'instance');

    const asInstanceAdmin = await getSpaceAccessLog(instanceAdmin, space.slug);
    expect(asInstanceAdmin.length).toBeGreaterThan(0);
    const asSpaceAdmin = await getSpaceAccessLog(spaceAdmin, space.slug);
    expect(asSpaceAdmin.length).toBeGreaterThan(0);
    await expect(getSpaceAccessLog(editor, space.slug)).rejects.toThrow();

    await deleteTestSpace(space.slug);
  });

  // ---------------------------------------------------------------------
  // getUserAccess
  // ---------------------------------------------------------------------

  it('getUserAccess: instance-admin only; reports explicit memberships and that user\'s own access-change log', async () => {
    const instanceAdmin = await authStore.createUser({ email: `ua-admin-${Date.now()}@t.local`, name: 'Admin', passwordHash: 'x', isAdmin: true });
    const nonAdmin = await authStore.createUser({ email: `ua-nonadmin-${Date.now()}@t.local`, name: 'NonAdmin', passwordHash: 'x', isAdmin: false });
    const target = await authStore.createUser({ email: `ua-target-${Date.now()}@t.local`, name: 'Target', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`UserAccess Space ${Date.now()}`, null);

    await applyAccessBulk(instanceAdmin, { changes: [{ userId: target.id, space: space.slug, role: 'viewer' }] });

    const access = await pollUntil(async () => {
      const a = await getUserAccess(instanceAdmin, target.id);
      return a.log.length > 0 ? a : undefined;
    });
    expect(access.memberships[space.slug]).toBe('viewer');
    expect(access.log[0].meta.targetUserId).toBe(target.id);

    await expect(getUserAccess(nonAdmin, target.id)).rejects.toThrow();
    await expect(getUserAccess(instanceAdmin, '00000000-0000-0000-0000-000000000000')).rejects.toThrow();

    await deleteTestSpace(space.slug);
  });
});
