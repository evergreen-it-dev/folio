/**
 * Security review F-03: a share link is a credential. Its URL embeds the
 * token, and an `edit` token lets anyone holding it write the page as a
 * "Guest via share" — outside the PAT's own scope and outside its audit
 * attribution. So a personal access token must not list, mint, widen or
 * revoke share links, whatever its scope: a read-only PAT of a page editor
 * used to receive every live edit URL from GET /api/pages/:id/shares.
 *
 * Same Fastify-inject harness as server/adminPatGuard.test.ts (the invites
 * precedent this follows). Every refused call is checked on the response
 * BODY — no token, no /share/ URL — not only on its status code, and the
 * mutating ones additionally assert that nothing changed.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiTokenScope, ShareLinkInfo } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import { HttpError } from './errors.js';
import * as session from './auth/session.js';
import * as shares from './shares.js';
import * as storage from './storage.js';
import { registerRoutes } from './routes.js';

describe('F-03: share links are cookie-only — a PAT never sees or mints a share token', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let space: string;
  let pageId: string;
  let editorCookie: string;
  let readPat: string;
  let writePat: string;
  let editLink: ShareLinkInfo;
  let editToken: string;

  function auth(kind: 'read' | 'write' | 'cookie'): Record<string, string> {
    if (kind === 'cookie') return { cookie: editorCookie };
    return { authorization: `Bearer ${kind === 'read' ? readPat : writePat}` };
  }

  async function liveShares(): Promise<ShareLinkInfo[]> {
    return shares.listSharesForPage(pageId, 'http://acme.example.com');
  }

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();

    const stamp = Date.now();
    const owner = await authStore.createUser({ email: `share-pat-owner-${stamp}@example.com`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    // A plain space EDITOR (not an admin) — the finding's exact precondition.
    const editor = await authStore.createUser({ email: `share-pat-editor-${stamp}@example.com`, name: 'Editor', passwordHash: 'x', isAdmin: false });
    const created = await storage.createSpace(`Share PAT ${stamp}`, owner.id);
    space = created.slug;
    await authStore.setMembership(space, owner.id, 'admin');
    await authStore.setMembership(space, editor.id, 'editor');

    const page = await storage.createPage({ space, parentPath: '', title: 'Roadmap', kind: 'doc' });
    pageId = page.id;

    editorCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(editor.id)).token}`;
    readPat = (await authStore.createApiToken(editor.id, 'read only', ['read'] as ApiTokenScope[])).token;
    writePat = (await authStore.createApiToken(editor.id, 'read write', ['read', 'write'] as ApiTokenScope[])).token;

    // An already-existing EDIT link — what the read PAT used to be able to fish out.
    editLink = await shares.createShareLink(pageId, owner.id, 'edit', 'http://acme.example.com');
    editToken = editLink.url.split('/share/')[1];

    const app_ = Fastify();
    app_.decorateRequest('authUser', null);
    app_.setErrorHandler((err, _request, reply) => {
      if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
      return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
    });
    await app_.register(fastifyCookieModule.default);
    await app_.register(async (protectedScope) => {
      protectedScope.addHook('onRequest', session.requireSession);
      registerRoutes(protectedScope);
    });
    await app_.ready();
    app = app_;
  });

  afterAll(async () => {
    await app?.close();
    await deleteTestSpace(space).catch(() => {});
    await teardownSchema();
  });

  it('GET /api/pages/:id/shares with a READ PAT of an editor: 403, and the body carries no token and no share URL', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/pages/${pageId}/shares`, headers: auth('read') });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/not available via API token/i);
    expect(res.body).not.toContain(editToken);
    expect(res.body).not.toContain('/share/');
  });

  it('GET /api/pages/:id/shares with a WRITE PAT: refused the same way — the rule does not depend on scope', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/pages/${pageId}/shares`, headers: auth('write') });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(editToken);
    expect(res.body).not.toContain('/share/');
  });

  it('POST /api/pages/:id/shares with a PAT (read or write): 403, no token in the body, and no link is minted', async () => {
    for (const kind of ['read', 'write'] as const) {
      const res = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/shares`, headers: auth(kind), payload: { mode: 'edit' } });
      expect(res.statusCode, `POST via ${kind} PAT`).toBe(403);
      expect(res.body).not.toContain('/share/');
    }
    expect((await liveShares()).map((s) => s.id)).toEqual([editLink.id]);
  });

  it('PATCH /api/shares/:id with a PAT: 403, the token is not echoed back, and includeChildren stays unchanged', async () => {
    for (const kind of ['read', 'write'] as const) {
      const res = await app.inject({ method: 'PATCH', url: `/api/shares/${editLink.id}`, headers: auth(kind), payload: { includeChildren: true } });
      expect(res.statusCode, `PATCH via ${kind} PAT`).toBe(403);
      expect(res.body).not.toContain(editToken);
    }
    expect((await shares.resolveShareToken(editToken))?.includeChildren).toBe(false);
  });

  it('DELETE /api/shares/:id with a PAT: 403 and the link keeps working', async () => {
    for (const kind of ['read', 'write'] as const) {
      const res = await app.inject({ method: 'DELETE', url: `/api/shares/${editLink.id}`, headers: auth(kind) });
      expect(res.statusCode, `DELETE via ${kind} PAT`).toBe(403);
    }
    expect(await shares.resolveShareToken(editToken)).toBeDefined();
  });

  it('the browser session of the same editor still lists, creates, changes and revokes links (the guard is targeted)', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/pages/${pageId}/shares`, headers: auth('cookie') });
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain(editToken);

    const created = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/shares`, headers: auth('cookie'), payload: { mode: 'view' } });
    expect(created.statusCode).toBe(201);
    const createdId = (created.json() as ShareLinkInfo).id;

    const patched = await app.inject({ method: 'PATCH', url: `/api/shares/${createdId}`, headers: auth('cookie'), payload: { includeChildren: true } });
    expect(patched.statusCode).toBe(200);

    const revoked = await app.inject({ method: 'DELETE', url: `/api/shares/${createdId}`, headers: auth('cookie') });
    expect(revoked.statusCode).toBe(200);
    expect((await liveShares()).map((s) => s.id)).toEqual([editLink.id]);
  });

  it('a read PAT still reads the page itself — only the share-management surface is closed', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/pages/${pageId}`, headers: auth('read') });
    expect(res.statusCode).toBe(200);
  });
});
