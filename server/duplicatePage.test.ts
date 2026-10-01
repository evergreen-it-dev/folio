/**
 * POST /api/pages/:id/duplicate (the owner, 01.10.2026: "add duplicate, so it
 * duplicates the whole tree if there is one").
 *
 * The copying itself is storage.duplicatePage, covered in storage.test.ts.
 * What is asserted here is the route around it: who may duplicate, that the
 * request needs no destination, and that the title sent by the client lands
 * on the copy's root and nowhere else.
 *
 * Same harness as offlineCreate.test.ts: real PG (isolated schema), real
 * files, the real routes through Fastify's inject.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import { HttpError } from './errors.js';
import { registerRoutes } from './routes.js';
import * as storage from './storage.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  await app.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', session.requireSession);
    registerRoutes(protectedScope);
  });
  await app.ready();
  return app;
}

describe('POST /api/pages/:id/duplicate (real PG + real files, fastify inject)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let editorCookie: string;
  let viewerCookie: string;
  let space: string;

  function duplicate(id: string, body: Record<string, unknown> | undefined, cookie = editorCookie) {
    return app.inject({ method: 'POST', url: `/api/pages/${id}/duplicate`, payload: body, headers: { cookie } });
  }

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const editor = await authStore.createUser({ email: `dup-editor-${Date.now()}@test.local`, name: 'Editor', passwordHash: 'x', isAdmin: false });
    const viewer = await authStore.createUser({ email: `dup-viewer-${Date.now()}@test.local`, name: 'Viewer', passwordHash: 'x', isAdmin: false });
    editorCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(editor.id)).token}`;
    viewerCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(viewer.id)).token}`;

    space = (await storage.createSpace(`Duplicate Route ${Date.now()}`, editor.id)).slug;
    await authStore.setMembership(space, editor.id, 'editor');
    await authStore.setMembership(space, viewer.id, 'viewer');

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    await deleteTestSpace(space);
    await teardownSchema();
  });

  it('copies the page and its children next to the original, the sent title on the copy alone', async () => {
    const parent = await storage.createPage({ space, parentPath: 'loops', title: 'Fastline', kind: 'doc' });
    const child = await storage.createPage({ space, parentPath: 'loops/fastline', title: 'Notes', kind: 'doc' });

    const res = await duplicate(parent.id, { title: 'Fastline (copy)' });
    expect(res.statusCode).toBe(201);
    const copy = res.json() as { id: string; space: string; path: string; title: string };

    expect(copy.id).not.toBe(parent.id);
    expect(copy).toMatchObject({ space, title: 'Fastline (copy)' });
    expect(copy.path.startsWith('loops/')).toBe(true);
    expect(copy.path).not.toBe(parent.path);

    const copiedChildren = await storage.getSubtree(await storage.requireEntry(copy.id), 2);
    expect(copiedChildren.map((n) => n.title)).toEqual(['Notes']);
    expect(copiedChildren[0].id).not.toBe(child.id);

    // The original and its child are untouched.
    expect((await storage.requireEntry(parent.id)).title).toBe('Fastline');
    expect((await storage.getSubtree(await storage.requireEntry(parent.id), 2)).map((n) => n.id)).toEqual([child.id]);
  });

  it('works with no body at all — the copy then keeps the title', async () => {
    const page = await storage.createPage({ space, parentPath: '', title: 'Plain', kind: 'doc' });
    const res = await duplicate(page.id, undefined);
    expect(res.statusCode).toBe(201);
    expect((res.json() as { title: string }).title).toBe('Plain');
  });

  it('refuses a viewer: reading the page is not enough to write next to it', async () => {
    const page = await storage.createPage({ space, parentPath: '', title: 'Guarded', kind: 'doc' });
    const before = (await storage.listEntries(space)).length;
    const res = await duplicate(page.id, { title: 'Guarded (copy)' }, viewerCookie);
    expect(res.statusCode).toBe(403);
    expect((await storage.listEntries(space)).length).toBe(before);
  });

  it('refuses a blank title rather than writing a nameless page', async () => {
    const page = await storage.createPage({ space, parentPath: '', title: 'Named', kind: 'doc' });
    const res = await duplicate(page.id, { title: '   ' });
    expect(res.statusCode).toBe(400);
  });

  it('answers 404 for a page that does not exist', async () => {
    const res = await duplicate('01ARZ3NDEKTSV4RRFFQ69G5FAV', { title: 'x' });
    expect(res.statusCode).toBe(404);
  });
});
