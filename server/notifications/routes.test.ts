/**
 * Round 31 (notifications and access requests) — the exported functions of
 * server/notifications/routes.ts against a real PG test schema, in the same
 * way as server/access/routes.test.ts: the repository has no HTTP-level
 * harness for Fastify, so the tests call the functions directly.
 *
 * Important about expectations: an INSTANCE administrator receives a request
 * from any space, so users with is_admin created by earlier tests of this
 * same file will also be among the recipients of later requests. So the
 * checks are addressed (`a particular person sees / does not see`), not
 * "exactly this many rows in the database".
 *
 * The `/events` socket is deliberately not checked here (the owner watches it
 * on a live stand): dispatch.deliver pushes the event only to those who are
 * online, and in a test nobody is online — the rows in the database do not
 * depend on that.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpTestSchema, deleteTestSpace } from '../db/testSchema.js';
import * as storage from '../storage.js';
import * as authStore from '../auth/store.js';
import { createAccessRequest, decideAccessRequest, listNotifications, markNotificationsRead } from './routes.js';
import * as store from './store.js';

/** The status of an HttpError, to check not just "it threw" but "it threw exactly 409/403". */
async function statusOf(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return (err as { status?: number }).status;
  }
}

let seq = 0;
function newEmail(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}@t.local`;
}

describe('notifications/routes (round 31, real PG)', () => {
  let teardownSchema: () => Promise<void>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  it('createAccessRequest: the row goes to the space admins and the instance admins; the requester and an unrelated editor get none', async () => {
    const requester = await authStore.createUser({ email: newEmail('req-requester'), name: 'Requester', passwordHash: 'x', isAdmin: false });
    const spaceAdmin = await authStore.createUser({ email: newEmail('req-spaceadmin'), name: 'SpaceAdmin', passwordHash: 'x', isAdmin: false });
    const instanceAdmin = await authStore.createUser({ email: newEmail('req-instadmin'), name: 'InstanceAdmin', passwordHash: 'x', isAdmin: true });
    const editor = await authStore.createUser({ email: newEmail('req-editor'), name: 'Editor', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Notif Request ${Date.now()}`, null);
    await authStore.setMembership(space.slug, spaceAdmin.id, 'admin');
    await authStore.setMembership(space.slug, editor.id, 'editor');

    const created = await createAccessRequest(requester, { space: space.slug });
    expect(created.status).toBe('pending');
    expect(created.space).toBe(space.slug);
    expect(created.requester.id).toBe(requester.id);
    expect(created.grantedRole).toBeNull();

    const adminFeed = await listNotifications(spaceAdmin);
    expect(adminFeed.items).toHaveLength(1);
    expect(adminFeed.items[0].kind).toBe('access_request');
    expect(adminFeed.items[0].accessRequest.id).toBe(created.id);
    expect(adminFeed.items[0].accessRequest.spaceName).toBe(space.name);
    expect(adminFeed.items[0].accessRequest.requester.name).toBe('Requester');
    expect(adminFeed.items[0].readAt).toBeNull();
    expect(adminFeed.unread).toBe(1);

    expect((await listNotifications(instanceAdmin)).items.map((i) => i.accessRequest.id)).toContain(created.id);
    expect((await listNotifications(requester)).items).toEqual([]);
    expect((await listNotifications(editor)).items).toEqual([]);

    await deleteTestSpace(space.slug);
  });

  it('createAccessRequest: a repeated request returns the same one and does not breed a second row in the feed', async () => {
    const requester = await authStore.createUser({ email: newEmail('dup-requester'), name: 'Requester', passwordHash: 'x', isAdmin: false });
    const spaceAdmin = await authStore.createUser({ email: newEmail('dup-spaceadmin'), name: 'SpaceAdmin', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Notif Dup ${Date.now()}`, null);
    await authStore.setMembership(space.slug, spaceAdmin.id, 'admin');

    const first = await createAccessRequest(requester, { space: space.slug });
    const second = await createAccessRequest(requester, { space: space.slug });
    expect(second.id).toBe(first.id);

    const feed = await listNotifications(spaceAdmin);
    expect(feed.items.filter((i) => i.accessRequest.id === first.id)).toHaveLength(1);
    expect(feed.items).toHaveLength(1);

    await deleteTestSpace(space.slug);
  });

  it('createAccessRequest: 409 when access is already there (an explicit membership or a space visible to the instance); 404 for an unknown space', async () => {
    const member = await authStore.createUser({ email: newEmail('has-member'), name: 'Member', passwordHash: 'x', isAdmin: false });
    const outsider = await authStore.createUser({ email: newEmail('has-outsider'), name: 'Outsider', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Notif HasAccess ${Date.now()}`, null);
    await authStore.setMembership(space.slug, member.id, 'viewer');

    expect(await statusOf(createAccessRequest(member, { space: space.slug }))).toBe(409);
    expect(await statusOf(createAccessRequest(outsider, { space: 'no-such-space-slug' }))).toBe(404);

    // A space visible to the whole instance — access is already there too, there is nothing to ask for.
    await authStore.setSpaceVisibility(space.slug, 'instance');
    expect(await statusOf(createAccessRequest(outsider, { space: space.slug }))).toBe(409);

    await deleteTestSpace(space.slug);
  });

  it('decideAccessRequest: a non-admin gets 403, and an already decided request — 409', async () => {
    const requester = await authStore.createUser({ email: newEmail('dec-requester'), name: 'Requester', passwordHash: 'x', isAdmin: false });
    const spaceAdmin = await authStore.createUser({ email: newEmail('dec-spaceadmin'), name: 'SpaceAdmin', passwordHash: 'x', isAdmin: false });
    const stranger = await authStore.createUser({ email: newEmail('dec-stranger'), name: 'Stranger', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Notif Decide ${Date.now()}`, null);
    await authStore.setMembership(space.slug, spaceAdmin.id, 'admin');
    await authStore.setMembership(space.slug, stranger.id, 'editor');

    const request = await createAccessRequest(requester, { space: space.slug });

    // An editor of the space is not an administrator; and the requester has no right to decide for themselves either.
    expect(await statusOf(decideAccessRequest(stranger, request.id, { decision: 'approve', role: 'editor' }))).toBe(403);
    expect(await statusOf(decideAccessRequest(requester, request.id, { decision: 'approve', role: 'editor' }))).toBe(403);

    const denied = await decideAccessRequest(spaceAdmin, request.id, { decision: 'deny' });
    expect(denied.status).toBe('denied');
    expect(denied.decidedBy?.id).toBe(spaceAdmin.id);
    expect(denied.decidedAt).toBeTruthy();
    expect(denied.grantedRole).toBeNull();
    // No access appeared after the refusal.
    expect(await authStore.getMembershipRole(space.slug, requester.id)).toBeUndefined();
    // The requester sees the decision in their feed — a silent refusal is no better than "it got lost".
    const requesterFeed = await listNotifications(requester);
    expect(requesterFeed.items[0].kind).toBe('access_decision');
    expect(requesterFeed.items[0].accessRequest.status).toBe('denied');

    // A second attempt (a second administrator with an open tab) — 409, not an overwrite.
    expect(await statusOf(decideAccessRequest(spaceAdmin, request.id, { decision: 'approve', role: 'admin' }))).toBe(409);

    await deleteTestSpace(space.slug);
  });

  it('decideAccessRequest: an approval really grants the chosen role (through applyAccessBulk) and notifies the requester', async () => {
    const requester = await authStore.createUser({ email: newEmail('appr-requester'), name: 'Requester', passwordHash: 'x', isAdmin: false });
    const spaceAdmin = await authStore.createUser({ email: newEmail('appr-spaceadmin'), name: 'SpaceAdmin', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Notif Approve ${Date.now()}`, null);
    await authStore.setMembership(space.slug, spaceAdmin.id, 'admin');

    const request = await createAccessRequest(requester, { space: space.slug });
    const approved = await decideAccessRequest(spaceAdmin, request.id, { decision: 'approve', role: 'editor' });

    expect(approved.status).toBe('approved');
    expect(approved.grantedRole).toBe('editor');
    expect(await authStore.getMembershipRole(space.slug, requester.id)).toBe('editor');

    const requesterFeed = await listNotifications(requester);
    expect(requesterFeed.items).toHaveLength(1);
    expect(requesterFeed.items[0].kind).toBe('access_decision');
    expect(requesterFeed.items[0].accessRequest.grantedRole).toBe('editor');
    expect(requesterFeed.items[0].accessRequest.decidedBy?.id).toBe(spaceAdmin.id);
    expect(requesterFeed.unread).toBe(1);

    // After the approval access is already there — a new request for the same space is pointless.
    expect(await statusOf(createAccessRequest(requester, { space: space.slug }))).toBe(409);

    await deleteTestSpace(space.slug);
  });

  it('markNotificationsRead: marks only its own rows — does not touch other people\'s even by an explicit id', async () => {
    const requester = await authStore.createUser({ email: newEmail('read-requester'), name: 'Requester', passwordHash: 'x', isAdmin: false });
    const adminA = await authStore.createUser({ email: newEmail('read-admin-a'), name: 'AdminA', passwordHash: 'x', isAdmin: false });
    const adminB = await authStore.createUser({ email: newEmail('read-admin-b'), name: 'AdminB', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Notif Read ${Date.now()}`, null);
    await authStore.setMembership(space.slug, adminA.id, 'admin');
    await authStore.setMembership(space.slug, adminB.id, 'admin');

    await createAccessRequest(requester, { space: space.slug });

    const feedB = await listNotifications(adminB);
    expect(feedB.items).toHaveLength(1);
    const foreignId = feedB.items[0].id;

    // A explicitly asks to mark SOMEBODY ELSE'S row — and gets no power over it.
    const afterForeign = await markNotificationsRead(adminA, { ids: [foreignId] });
    expect(afterForeign.unread).toBe(1);
    expect((await listNotifications(adminB)).items[0].readAt).toBeNull();
    expect((await store.listNotifications(adminA.id))[0].readAt).toBeNull();

    // One's own — without a list, "all of mine".
    const afterAll = await markNotificationsRead(adminA, {});
    expect(afterAll.unread).toBe(0);
    expect((await listNotifications(adminA)).items[0].readAt).not.toBeNull();
    // The feed of B was not affected.
    expect((await listNotifications(adminB)).unread).toBe(1);

    await deleteTestSpace(space.slug);
  });
});
