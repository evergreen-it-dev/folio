/**
 * POST /api/spaces/:space/writing-rules ("Create writing rules") and the `writingRules` flag of GET /api/spaces
 * (real PG, real page store): admins only, 409 on a second call, the flag shows for every member.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SpaceInfo, User } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import { registerRoutes } from './routes.js';
import * as storage from './storage.js';

describe('writing rules routes (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let admin: User;
  let editor: User;
  let space: string;
  let adminAuth: { cookie: string };
  let editorAuth: { cookie: string };

  const cookieOf = async (user: User) => ({ cookie: `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(user.id)).token}` });

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    app = Fastify();
    app.decorateRequest('authUser', null);
    app.setErrorHandler((err, _request, reply) => {
      if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
      return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
    });
    await app.register(fastifyCookieModule.default);
    await app.register(async (scope) => {
      scope.addHook('onRequest', session.requireSession);
      registerRoutes(scope);
    });
    await app.ready();
    const stamp = Date.now();
    const mk = (n: string) => authStore.createUser({ email: `${n}-${stamp}@wr-routes.local`, name: n, passwordHash: 'x', isAdmin: false });
    [admin, editor] = await Promise.all([mk('wradmin'), mk('wreditor')]);
    adminAuth = await cookieOf(admin);
    editorAuth = await cookieOf(editor);
    space = (await storage.createSpace(`Rules routes ${stamp}`, admin.id)).slug;
    await authStore.setMembership(space, admin.id, 'admin');
    await authStore.setMembership(space, editor.id, 'editor');
  });

  afterAll(async () => {
    await app.close();
    await deleteTestSpace(space);
    await teardownSchema();
  });

  const flagFor = async (headers: { cookie: string }) => {
    const res = await app.inject({ method: 'GET', url: '/api/spaces', headers });
    return (res.json() as { spaces: SpaceInfo[] }).spaces.find((s) => s.slug === space)?.agentRules;
  };

  it('an editor cannot create the rules; an admin can, once, in the language of the request', async () => {
    expect(await flagFor(editorAuth)).not.toHaveProperty('writingRules');

    const denied = await app.inject({ method: 'POST', url: `/api/spaces/${space}/writing-rules`, headers: editorAuth });
    expect(denied.statusCode).toBe(403);

    const created = await app.inject({ method: 'POST', url: `/api/spaces/${space}/writing-rules`, headers: { ...adminAuth, 'accept-language': 'uk' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ path: '.agent/writing-rules.md', title: 'Правила письма' });

    const again = await app.inject({ method: 'POST', url: `/api/spaces/${space}/writing-rules`, headers: adminAuth });
    expect(again.statusCode).toBe(409);
  });

  it('GET /api/spaces tells every member the space has writing rules, and only admins get the folder path', async () => {
    expect(await flagFor(editorAuth)).toMatchObject({ used: true, writingRules: true });
    expect(await flagFor(editorAuth)).not.toHaveProperty('path');
    expect(await flagFor(adminAuth)).toMatchObject({ writingRules: true, path: '.agent' });
  });
});
