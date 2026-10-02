import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import * as invites from './invites.js';
import * as storage from './storage.js';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import { HttpError } from './errors.js';
import { registerRoutes } from './routes.js';

describe('accepting an invite with an existing browser session', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let cookie: string;
  let space: string;
  let inviterId: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const inviter = await authStore.createUser({
      email: `existing-invite-owner-${Date.now()}@test.local`,
      name: 'Invite owner',
      passwordHash: 'x',
      isAdmin: true,
    });
    const member = await authStore.createUser({
      email: `existing-invite-member-${Date.now()}@test.local`,
      name: 'Existing member',
      passwordHash: 'x',
      isAdmin: false,
    });
    inviterId = inviter.id;
    space = (await storage.createSpace(`Existing Invite ${Date.now()}`, inviter.id)).slug;
    await authStore.setMembership(space, inviter.id, 'admin');
    await authStore.setMembership(space, member.id, 'viewer');
    cookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(member.id)).token}`;

    app = Fastify();
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
  });

  afterAll(async () => {
    await app.close();
    await deleteTestSpace(space);
    await teardownSchema();
  });

  async function makeInvite(role: 'viewer' | 'editor', email?: string) {
    const created = await invites.createInvite(
      {
        memberships: [{ space, role }],
        isAdmin: false,
        expiresInDays: 7,
        maxUses: 1,
        ...(email ? { email } : {}),
      },
      inviterId,
      'http://localhost:4871',
    );
    return { created, token: created.url.split('/invite/')[1] };
  }

  it('uses the invite for the current user and upgrades their role', async () => {
    const { created, token } = await makeInvite('editor');
    const response = await app.inject({
      method: 'POST',
      url: `/api/invite/${token}/accept-existing`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().memberships[space]).toBe('editor');
    expect((await invites.getInviteByToken(token))?.uses).toBe(1);
    expect(created.uses).toBe(0);
  });

  it('never downgrades a stronger existing membership', async () => {
    const { token } = await makeInvite('viewer');
    const response = await app.inject({
      method: 'POST',
      url: `/api/invite/${token}/accept-existing`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().memberships[space]).toBe('editor');
  });

  it('does not consume an invite pinned to another email', async () => {
    const { token } = await makeInvite('editor', 'someone-else@test.local');
    const response = await app.inject({
      method: 'POST',
      url: `/api/invite/${token}/accept-existing`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(400);
    expect((await invites.getInviteByToken(token))?.uses).toBe(0);
  });
});
