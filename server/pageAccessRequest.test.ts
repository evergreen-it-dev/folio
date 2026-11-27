/**
 * Getting into a page restricted to named people (real PG + fs, through the HTTP routes where the gate lives):
 *  - POST /api/pages/:id/access/self-grant — an instance admin lets themselves in; recorded as `access.self_grant`
 *    on the space, a membership when they have no role, a viewer grant on EVERY restriction of the chain they do not pass.
 *  - POST /api/access-requests with `pageId` — a member shut out by the restriction asks its owner(s); the owner decides.
 *  - GET /api/share/:token `viewer.accessRequestPending` follows the page request.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccessLogEntry, SharedPagePayload, User } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { query } from './db/pool.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import * as pageAccess from './pageAccess.js';
import { registerPublicShareRoutes, registerRoutes } from './routes.js';
import { registerNotificationRoutes } from './notifications/routes.js';
import * as notificationsStore from './notifications/store.js';
import * as shares from './shares.js';
import * as storage from './storage.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  registerPublicShareRoutes(app);
  await app.register(async (scope) => {
    scope.addHook('onRequest', session.requireSession);
    registerRoutes(scope);
    registerNotificationRoutes(scope);
  });
  await app.ready();
  return app;
}

describe('page access: self-grant and page access requests', () => {
  let teardown: () => Promise<void>;
  let app: FastifyInstance;
  let space: string;
  const users: Record<string, User> = {};
  const cookie: Record<string, string> = {};
  const pages: Record<string, storage.PageIndexEntry> = {};

  async function page(parentPath: string, title: string): Promise<storage.PageIndexEntry> {
    const meta = await storage.createPage({ space, parentPath, title, kind: 'doc' });
    await storage.writeDocBody(meta.id, `# ${title}\n\nbody\n`);
    return storage.requireEntry(meta.id);
  }
  async function user(name: string, isAdmin = false, role?: 'viewer' | 'editor' | 'admin'): Promise<void> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    users[name] = await authStore.createUser({ email: `par-${name}-${stamp}@example.com`, name, passwordHash: 'x', isAdmin });
    cookie[name] = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(users[name].id)).token}`;
    if (role) await authStore.setMembership(space, users[name].id, role);
  }
  const post = (who: string, url: string, payload?: unknown) => app.inject({ method: 'POST', url, headers: { cookie: cookie[who] }, payload: (payload ?? {}) as object });
  const grantOf = async (pageId: string, userId: string) =>
    (await query<{ role: string }>('SELECT role FROM page_access_grants WHERE page_id = $1 AND user_id = $2', [pageId, userId]))[0]?.role;
  const roleOn = async (who: string, entry: storage.PageIndexEntry) => session.effectivePageRole(users[who], entry);
  async function accessLog(): Promise<AccessLogEntry[]> {
    return authStore.listAccessLogForSpace(space, 100);
  }

  beforeAll(async () => {
    teardown = await setUpTestSchema();
    app = await buildApp();
    space = (await storage.createSpace(`Page Request ${Date.now()}`, null)).slug;
    await user('ownerA', false, 'editor');
    await user('ownerB', false, 'editor');
    await user('member', false, 'viewer');
    await user('plain', false); // no role in the space
    await user('adminOut', true); // instance admin, no role in the space
    await user('adminIn', true, 'editor'); // instance admin who is a member

    pages.top = await page('', 'Top Secret');
    pages.child = await page('top-secret', 'Deep Secret');
    pages.lone = await page('', 'Lone Secret');
    pages.open = await page('', 'Open Page');
    // top: owned by ownerA; child below it: owned by ownerB (a chain of two restrictions); lone: ownerA.
    await pageAccess.setAccess(users.ownerA, pages.top, 'restricted', []);
    await pageAccess.setAccess(users.ownerB, pages.child, 'restricted', []);
    await pageAccess.setAccess(users.ownerA, pages.lone, 'restricted', []);
  });
  afterAll(async () => {
    await app.close();
    await deleteTestSpace(space);
    await teardown();
  });

  describe('POST /api/pages/:id/access/self-grant', () => {
    it('403 for a non-admin, even a member of the space; 404 for an unknown page', async () => {
      expect((await post('member', `/api/pages/${pages.lone.id}/access/self-grant`)).statusCode).toBe(403);
      expect((await post('ownerA', `/api/pages/${pages.lone.id}/access/self-grant`)).statusCode).toBe(403);
      expect((await post('adminOut', '/api/pages/no-such-page/access/self-grant')).statusCode).toBe(404);
      expect(await grantOf(pages.lone.id, users.member.id)).toBeUndefined();
    });

    it('an admin with no space role gets a viewer membership, a viewer grant, and two access.self_grant rows', async () => {
      expect(await roleOn('adminOut', pages.lone)).toBeUndefined();
      const res = await post('adminOut', `/api/pages/${pages.lone.id}/access/self-grant`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ space, pageId: pages.lone.id });
      expect(await authStore.getMembershipRole(space, users.adminOut.id)).toBe('viewer');
      expect(await grantOf(pages.lone.id, users.adminOut.id)).toBe('viewer');
      expect(['viewer', 'editor', 'admin']).toContain(await roleOn('adminOut', pages.lone));

      await vi.waitFor(async () => {
        const mine = (await accessLog()).filter((e) => e.action === 'access.self_grant' && e.meta.targetUserId === users.adminOut.id);
        expect(mine).toHaveLength(2);
        expect(mine.every((e) => e.target === space && e.meta.role === 'viewer' && e.meta.reason === 'page access')).toBe(true);
        expect(mine.find((e) => e.meta.pageId === pages.lone.id)).toBeTruthy();
        expect(mine.find((e) => e.meta.pageId === undefined)?.meta.previousRole).toBeNull();
      });
    });

    it('an admin who is already a member gets only the page grant — their space role is untouched', async () => {
      const res = await post('adminIn', `/api/pages/${pages.lone.id}/access/self-grant`);
      expect(res.statusCode).toBe(200);
      expect(await authStore.getMembershipRole(space, users.adminIn.id)).toBe('editor');
      expect(await grantOf(pages.lone.id, users.adminIn.id)).toBe('viewer');
      expect(await roleOn('adminIn', pages.lone)).toBe('viewer');
      await vi.waitFor(async () => {
        const mine = (await accessLog()).filter((e) => e.action === 'access.self_grant' && e.meta.targetUserId === users.adminIn.id);
        expect(mine).toHaveLength(1);
        expect(mine[0].meta.pageId).toBe(pages.lone.id);
      });
      // Asking again changes and records nothing.
      expect((await post('adminIn', `/api/pages/${pages.lone.id}/access/self-grant`)).statusCode).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await accessLog()).filter((e) => e.action === 'access.self_grant' && e.meta.targetUserId === users.adminIn.id)).toHaveLength(1);
    });

    it('a chain of two restrictions: a grant on both; an existing editor grant is never downgraded', async () => {
      await query('INSERT INTO page_access_grants (page_id, user_id, role) VALUES ($1, $2, $3)', [pages.top.id, users.adminIn.id, 'editor']);
      const res = await post('adminIn', `/api/pages/${pages.child.id}/access/self-grant`);
      expect(res.statusCode).toBe(200);
      expect(await grantOf(pages.top.id, users.adminIn.id)).toBe('editor');
      expect(await grantOf(pages.child.id, users.adminIn.id)).toBe('viewer');
      expect(await roleOn('adminIn', pages.child)).toBe('viewer');

      const res2 = await post('adminOut', `/api/pages/${pages.child.id}/access/self-grant`);
      expect(res2.statusCode).toBe(200);
      expect(await grantOf(pages.top.id, users.adminOut.id)).toBe('viewer');
      expect(await grantOf(pages.child.id, users.adminOut.id)).toBe('viewer');
      expect(await roleOn('adminOut', pages.child)).toBe('viewer');
    });
  });

  describe('page access requests', () => {
    it('a person with no space role must ask for the space first (400); an unrestricted page cannot be requested (409)', async () => {
      expect((await post('plain', '/api/access-requests', { space, pageId: pages.lone.id })).statusCode).toBe(400);
      expect((await post('member', '/api/access-requests', { space, pageId: pages.open.id })).statusCode).toBe(409);
      expect((await post('member', '/api/access-requests', { space, pageId: 'no-such-page' })).statusCode).toBe(404);
    });

    it('goes to the restriction owners (deduplicated, every restriction of the chain), is idempotent per page, and does not count as a space request', async () => {
      const res = await post('member', '/api/access-requests', { space, pageId: pages.child.id });
      expect(res.statusCode).toBe(201);
      const created = res.json().request;
      expect(created).toMatchObject({ status: 'pending', pageId: pages.child.id, pageTitle: 'Deep Secret', space });

      const feed = async (who: string) => (await notificationsStore.listNotifications(users[who].id)).filter((n) => n.accessRequest?.id === created.id);
      expect(await feed('ownerA')).toHaveLength(1); // owns the parent restriction
      expect(await feed('ownerB')).toHaveLength(1); // owns the page's own restriction
      expect(await feed('member')).toHaveLength(0);
      expect(await feed('adminOut')).toHaveLength(0); // instance admins are not addressees of a page request

      const again = await post('member', '/api/access-requests', { space, pageId: pages.child.id });
      expect(again.json().request.id).toBe(created.id);
      expect(await feed('ownerA')).toHaveLength(1);

      expect(await notificationsStore.findPendingAccessRequest(space, users.member.id)).toBeUndefined();
      expect((await notificationsStore.findPendingAccessRequest(space, users.member.id, pages.child.id))?.id).toBe(created.id);
      // The state endpoint of the "no access" screen.
      const state = await app.inject({ method: 'GET', url: `/api/pages/${pages.child.id}/access-request`, headers: { cookie: cookie.member } });
      expect(state.json()).toEqual({ pending: true });
      expect((await app.inject({ method: 'GET', url: `/api/pages/${pages.child.id}/access-request`, headers: { cookie: cookie.plain } })).statusCode).toBe(403);

      // Only people with editor rights on a restriction decide: a space viewer, an instance admin holding only a viewer grant, an outsider cannot.
      for (const who of ['member', 'adminOut', 'plain']) {
        expect((await post(who, `/api/access-requests/${created.id}/decision`, { decision: 'approve', role: 'viewer' })).statusCode).toBe(403);
      }
      // A page is opened as viewer or editor, never admin.
      expect((await post('ownerA', `/api/access-requests/${created.id}/decision`, { decision: 'approve', role: 'admin' })).statusCode).toBe(400);
      expect(await roleOn('member', pages.child)).toBeUndefined();

      // ownerA owns only the PARENT restriction: the grant goes there; the child restriction (ownerB's) still shuts the requester out.
      const decided = await post('ownerA', `/api/access-requests/${created.id}/decision`, { decision: 'approve', role: 'viewer' });
      expect(decided.statusCode).toBe(200);
      expect(decided.json().request).toMatchObject({ status: 'approved', grantedRole: 'viewer', stillRestricted: true });
      expect(await grantOf(pages.top.id, users.member.id)).toBe('viewer');
      expect(await grantOf(pages.child.id, users.member.id)).toBeUndefined();
      expect(await roleOn('member', pages.child)).toBeUndefined();
      // The decision is final. ownerB owns the child restriction but does not pass the parent's (ownerA's), so they
      // hold no editor role on the child page and cannot grant on it either — the same right as its access dialog.
      expect((await post('ownerA', `/api/access-requests/${created.id}/decision`, { decision: 'approve', role: 'viewer' })).statusCode).toBe(409);
      expect((await post('ownerB', `/api/access-requests/${created.id}/decision`, { decision: 'approve', role: 'viewer' })).statusCode).toBe(403);
      // The requester heard about it.
      expect((await notificationsStore.listNotifications(users.member.id)).some((n) => n.kind === 'access_decision' && n.accessRequest?.id === created.id)).toBe(true);
    });

    it('the single-restriction case: the owner approves and the requester can open the page; the grant is audited with pageId', async () => {
      const created = (await post('member', '/api/access-requests', { space, pageId: pages.lone.id })).json().request;
      expect(await roleOn('member', pages.lone)).toBeUndefined();
      const decided = await post('ownerA', `/api/access-requests/${created.id}/decision`, { decision: 'approve', role: 'editor' });
      expect(decided.statusCode).toBe(200);
      expect(decided.json().request.stillRestricted).toBeUndefined();
      expect(await roleOn('member', pages.lone)).toBe('editor');
      await vi.waitFor(async () => {
        const entry = (await accessLog()).find((e) => e.action === 'access.grant' && e.meta.pageId === pages.lone.id && e.meta.targetUserId === users.member.id);
        expect(entry?.meta).toMatchObject({ role: 'editor', previousRole: null });
      });
      // Now that they pass, a repeated request is refused instead of piling up.
      expect((await post('member', '/api/access-requests', { space, pageId: pages.lone.id })).statusCode).toBe(409);
    });

    it('a denied page request grants nothing; a denial is also the owners\' call only', async () => {
      await query('DELETE FROM page_access_grants WHERE page_id = $1 AND user_id = $2', [pages.lone.id, users.member.id]);
      const created = (await post('member', '/api/access-requests', { space, pageId: pages.lone.id })).json().request;
      expect((await post('adminIn', `/api/access-requests/${created.id}/decision`, { decision: 'deny' })).statusCode).toBe(403);
      const denied = await post('ownerA', `/api/access-requests/${created.id}/decision`, { decision: 'deny' });
      expect(denied.json().request).toMatchObject({ status: 'denied' });
      expect(await roleOn('member', pages.lone)).toBeUndefined();
    });

    it('with no active restriction owner the space admins hear about it', async () => {
      await user('spaceAdmin', false, 'admin');
      await user('ghostOwner', false, 'editor');
      const secret = await page('', 'Ghost Secret');
      await pageAccess.setAccess(users.ghostOwner, secret, 'restricted', []);
      await query('UPDATE users SET disabled = true WHERE id = $1', [users.ghostOwner.id]);
      expect(await notificationsStore.listPageRequestRecipients(space, secret.id, users.member.id)).toEqual([users.spaceAdmin.id]);
    });

    it('a request without pageId is the old space request, unchanged', async () => {
      const res = await post('plain', '/api/access-requests', { space });
      expect(res.statusCode).toBe(201);
      expect(res.json().request.pageId).toBeUndefined();
      expect((await post('member', '/api/access-requests', { space })).statusCode).toBe(409); // already has a role
    });
  });

  describe('share payload', () => {
    it('viewer.accessRequestPending follows the PAGE request for a member shut out of a restricted page', async () => {
      const link = await shares.createShareLink(pages.lone.id, users.ownerA.id, 'edit', 'http://acme.example.com', false);
      const token = link.url.split('/share/')[1];
      try {
        const viewerOf = async (who: string) =>
          ((await app.inject({ method: 'GET', url: `/api/share/${token}`, headers: { cookie: cookie[who] } })).json() as SharedPagePayload).viewer;

        // The member's earlier request for this page was denied: nothing live yet.
        expect(await viewerOf('member')).toMatchObject({ hasSpaceRole: true, pageRestricted: true });
        expect((await viewerOf('member'))?.accessRequestPending).toBeUndefined();

        await post('member', '/api/access-requests', { space, pageId: pages.lone.id });
        expect(await viewerOf('member')).toMatchObject({ pageRestricted: true, accessRequestPending: true });

        // A request for ANOTHER page does not make this banner "pending".
        const other = await shares.createShareLink(pages.top.id, users.ownerA.id, 'edit', 'http://acme.example.com', false);
        try {
          const topViewer = ((await app.inject({ method: 'GET', url: `/api/share/${other.url.split('/share/')[1]}`, headers: { cookie: cookie.member } })).json() as SharedPagePayload).viewer;
          expect(topViewer?.accessRequestPending).toBeUndefined();
        } finally {
          await shares.revokeShare(other.id);
        }

        // Somebody with no role in the space still sees their SPACE request, not a page one.
        await post('plain', '/api/access-requests', { space }); // idempotent (made above)
        expect(await viewerOf('plain')).toMatchObject({ hasSpaceRole: false, pageRestricted: true, accessRequestPending: true });
      } finally {
        await shares.revokeShare(link.id);
      }
    });
  });
});
