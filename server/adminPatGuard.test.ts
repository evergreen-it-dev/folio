/**
 * QA-3 P1 — DEV-PLAN round 7: "Admin endpoints are NOT available to a PAT
 * whatever its scope". The guard (session.requireCookieAuth) existed but was only ever
 * wired into server/auth/routes.ts, so every route added later by the access
 * round, the admin-spaces round and the invites round was reachable with a
 * plain `scopes: ['read']` token — and not just readable: POST
 * /api/access/bulk really granted a role, PATCH /api/spaces/:space really
 * opened a private space instance-wide, and GET /api/invites handed back the
 * `url` of every live invite, i.e. working access links.
 *
 * One HTTP-level table drives all of it. Each route is asserted three ways:
 * a read-scoped PAT is 403, a WRITE-scoped PAT is 403 too (the rule is
 * scope-independent — that is the whole point), and the identical request on
 * an instance-admin cookie session still succeeds, so the guard didn't just
 * break the endpoint. The mutating routes additionally assert that the
 * refused PAT call changed NOTHING.
 *
 * Same Fastify-inject harness as server/connectGit.test.ts, but mounting the
 * full protected scope server/index.ts builds (auth + main + access + trash
 * routes), since the admin surface is spread across all four files.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiTokenScope } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import { HttpError } from './errors.js';
import * as session from './auth/session.js';
import * as storage from './storage.js';
import * as invites from './invites.js';
import { registerRoutes } from './routes.js';
import { registerProtectedAuthRoutes } from './auth/routes.js';
import { registerAccessRoutes } from './access/routes.js';
import { registerTrashRoutes } from './trash/routes.js';
import { __setTrashRootForTests } from './trash/paths.js';

interface Case {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: () => string;
  payload?: () => unknown;
  /** What the SAME request returns on an instance-admin cookie session. */
  cookieStatus: number;
  /** Runs after the PAT attempts: asserts the refused call left no trace. */
  assertUnchanged?: () => Promise<void>;
}

describe('QA-3 P1: admin endpoints are unreachable via a PAT, whatever its scope', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let adminCookie: string;
  let readPat: string;
  let writePat: string;
  let adminId: string;
  let targetId: string;
  let space: string;
  let inviteId: string;
  let trashRoot: string;

  async function inject(c: Case, auth: { cookie?: string; pat?: string }) {
    return app.inject({
      method: c.method,
      url: c.url(),
      payload: c.payload?.() as Record<string, unknown> | undefined,
      headers: {
        ...(auth.cookie ? { cookie: auth.cookie } : {}),
        ...(auth.pat ? { authorization: `Bearer ${auth.pat}` } : {}),
      },
    });
  }

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();

    // Keep the trash-routes boot backfill away from the machine's real
    // data/.trash (same precedent as server/trash/backfill.test.ts).
    trashRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-test-patguard-trash-'));
    __setTrashRootForTests(trashRoot);

    const admin = await authStore.createUser({ email: `pat-admin-${Date.now()}@test.local`, name: 'PAT Admin', passwordHash: 'x', isAdmin: true });
    const target = await authStore.createUser({ email: `pat-target-${Date.now()}@test.local`, name: 'PAT Target', passwordHash: 'x', isAdmin: false });
    adminId = admin.id;
    targetId = target.id;

    adminCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(admin.id)).token}`;
    readPat = (await authStore.createApiToken(admin.id, 'read only', ['read'] as ApiTokenScope[])).token;
    writePat = (await authStore.createApiToken(admin.id, 'read write', ['read', 'write'] as ApiTokenScope[])).token;

    const created = await storage.createSpace(`PAT Guard ${Date.now()}`, admin.id);
    space = created.slug;
    await authStore.setMembership(space, admin.id, 'admin');

    const invite = await invites.createInvite(
      { memberships: [{ space, role: 'viewer' }], isAdmin: false, expiresInDays: 7, maxUses: 1 },
      admin.id,
      'http://localhost:4871',
    );
    inviteId = invite.id;

    const app_ = Fastify();
    app_.decorateRequest('authUser', null);
    app_.setErrorHandler((err, _request, reply) => {
      if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
      return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
    });
    await app_.register(fastifyCookieModule.default);
    await app_.register(async (protectedScope) => {
      protectedScope.addHook('onRequest', session.requireSession);
      registerProtectedAuthRoutes(protectedScope);
      registerRoutes(protectedScope);
      registerAccessRoutes(protectedScope);
      registerTrashRoutes(protectedScope);
    });
    await app_.ready();
    app = app_;
  });

  afterAll(async () => {
    await app?.close();
    await deleteTestSpace(space).catch(() => {});
    await teardownSchema();
    await fs.rm(trashRoot, { recursive: true, force: true }).catch(() => {});
  });

  const cases: Case[] = [
    // --- server/routes.ts -------------------------------------------------
    { name: 'GET /api/admin/spaces', method: 'GET', url: () => '/api/admin/spaces', cookieStatus: 200 },
    { name: 'GET /api/invites', method: 'GET', url: () => '/api/invites', cookieStatus: 200 },
    {
      name: 'POST /api/invites',
      method: 'POST',
      url: () => '/api/invites',
      payload: () => ({ memberships: [{ space, role: 'viewer' }], isAdmin: false, expiresInDays: 7, maxUses: 1 }),
      cookieStatus: 201,
      assertUnchanged: async () => {
        // exactly the one seeded in beforeAll — the two PAT calls minted nothing
        expect((await invites.listAllInvites('http://localhost:4871')).length).toBe(1);
      },
    },
    { name: 'DELETE /api/invites/:id', method: 'DELETE', url: () => `/api/invites/${inviteId}`, cookieStatus: 200 },

    // --- server/access/routes.ts ------------------------------------------
    { name: 'GET /api/access/matrix', method: 'GET', url: () => '/api/access/matrix', cookieStatus: 200 },
    {
      name: 'POST /api/access/bulk',
      method: 'POST',
      url: () => '/api/access/bulk',
      payload: () => ({ changes: [{ userId: targetId, space, role: 'admin' }] }),
      cookieStatus: 200,
      assertUnchanged: async () => {
        expect(await authStore.getMembershipRole(space, targetId)).toBeUndefined();
      },
    },
    {
      name: 'PATCH /api/spaces/:space',
      method: 'PATCH',
      url: () => `/api/spaces/${space}`,
      payload: () => ({ visibility: 'instance' }),
      cookieStatus: 200,
      assertUnchanged: async () => {
        expect(await authStore.getSpaceVisibility(space)).toBe('private');
      },
    },
    { name: 'GET /api/spaces/:space/access-log', method: 'GET', url: () => `/api/spaces/${space}/access-log`, cookieStatus: 200 },
    { name: 'GET /api/users/:id/access', method: 'GET', url: () => `/api/users/${targetId}/access`, cookieStatus: 200 },

    // --- server/auth/routes.ts (already guarded — regression cover) --------
    { name: 'GET /api/users', method: 'GET', url: () => '/api/users', cookieStatus: 200 },
    { name: 'GET /api/spaces/:space/members', method: 'GET', url: () => `/api/spaces/${space}/members`, cookieStatus: 200 },

    // --- server/trash/routes.ts (instance-admin setting) ------------------
    { name: 'PUT /api/trash/settings', method: 'PUT', url: () => '/api/trash/settings', payload: () => ({ retentionDays: 30 }), cookieStatus: 200 },
  ];

  for (const c of cases) {
    it(`${c.name}: 403 for a read PAT and for a write PAT, still ${c.cookieStatus} on a cookie session`, async () => {
      for (const pat of [readPat, writePat]) {
        const res = await inject(c, { pat });
        expect(res.statusCode, `${c.name} via PAT`).toBe(403);
        expect(res.json().error).toMatch(/not available via API token/i);
      }

      await c.assertUnchanged?.();

      const ok = await inject(c, { cookie: adminCookie });
      expect(ok.statusCode, `${c.name} via cookie: ${ok.body}`).toBe(c.cookieStatus);
    });
  }

  it('a refused GET /api/invites leaks no invite token in its body', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/invites', headers: { authorization: `Bearer ${readPat}` } });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('/invite/');
  });

  it('the same PAT still works on ordinary, non-admin routes — the guard is targeted, not a blanket ban', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/spaces', headers: { authorization: `Bearer ${readPat}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().spaces.map((s: { slug: string }) => s.slug)).toContain(space);
  });
});
