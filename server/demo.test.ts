/**
 * Public-demo mode: the config is served only while FOLIO_DEMO_MODE is on, and
 * a demo account cannot mint API tokens or change passwords (so one visitor
 * can't lock the next one out of a shared login).
 */
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { hashPassword } from './auth/passwords.js';
import { registerProtectedAuthRoutes, registerPublicAuthRoutes } from './auth/routes.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import * as invites from './invites.js';
import * as storage from './storage.js';
import { HttpError } from './errors.js';
import { registerRoutes } from './routes.js';
import { registerAssistantRoutes } from './assistant/routes.js';
import { registerAccessRoutes } from './access/routes.js';
import { registerTrashRoutes } from './trash/routes.js';
import { __setTrashRootForTests } from './trash/paths.js';
import { registerMcpRoutes } from './mcpRoutes.js';
import { __resetOAuthRateLimitsForTests, registerOAuthRoutes } from './oauth/routes.js';
import { DEMO_MCP_MAX_WRITE_ARGS_BYTES, DEMO_OAUTH_PER_MINUTE, __resetDemoLimitsForTests, demoMcpRpm, demoMcpWritesPerHour } from './demoLimits.js';
import { __resetDemoConfigForTests, assertDemoAgentRootIntact, assertNotDemo, assertNotDemoAccount, demoInfoFor, demoMaxUploadBytes, getDemoAccounts, isDemoAccountEmail } from './demo.js';
import { parseTrustProxy } from './trustProxy.js';

const ACCOUNTS = [
  { email: 'Editor@Demo.test', password: 'demo-secret-1', name: 'Dana Editor', role: 'Editor', description: 'Editor in Engineering and Product' },
  { email: 'admin@demo.test', password: 'demo-secret-2', name: 'Alex Admin', role: 'Admin', description: 'Instance admin' },
];

function setDemoEnv(env: { mode?: string; accounts?: string; hours?: string; maxUploadMb?: string; mcpRpm?: string; mcpWrites?: string }) {
  const set = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  set('FOLIO_DEMO_MODE', env.mode);
  set('FOLIO_DEMO_ACCOUNTS', env.accounts);
  set('FOLIO_DEMO_RESET_HOURS', env.hours);
  set('FOLIO_DEMO_MAX_UPLOAD_MB', env.maxUploadMb);
  set('FOLIO_DEMO_MCP_RPM', env.mcpRpm);
  set('FOLIO_DEMO_MCP_WRITES_PER_HOUR', env.mcpWrites);
  __resetDemoConfigForTests();
  __resetDemoLimitsForTests();
}

afterEach(() => {
  setDemoEnv({});
  vi.restoreAllMocks();
});

describe('demo config', () => {
  it('is off by default: no accounts, no info, no demo account emails', () => {
    setDemoEnv({ accounts: JSON.stringify(ACCOUNTS) }); // accounts alone do nothing without the flag
    expect(getDemoAccounts()).toEqual([]);
    expect(demoInfoFor(false)).toBeUndefined();
    expect(isDemoAccountEmail('admin@demo.test')).toBe(false);
  });

  it.each(['0', 'false', '', 'off'])('FOLIO_DEMO_MODE=%j does not switch it on', (mode) => {
    setDemoEnv({ mode, accounts: JSON.stringify(ACCOUNTS) });
    expect(demoInfoFor(false)).toBeUndefined();
  });

  it('serves the accounts and the reset interval to a visitor who is not signed in', () => {
    setDemoEnv({ mode: '1', accounts: JSON.stringify(ACCOUNTS), hours: '6' });
    const info = demoInfoFor(false);
    expect(info?.resetHours).toBe(6);
    expect(info?.accounts.map((a) => a.email)).toEqual(['Editor@Demo.test', 'admin@demo.test']);
    expect(info?.accounts[0].password).toBe('demo-secret-1');
  });

  it('keeps the account list (passwords) away from a signed-in session', () => {
    setDemoEnv({ mode: '1', accounts: JSON.stringify(ACCOUNTS), hours: '6' });
    expect(demoInfoFor(true)).toEqual({ accounts: [], resetHours: 6 });
  });

  it('reset interval: null when unset or not a positive number', () => {
    setDemoEnv({ mode: 'true', accounts: JSON.stringify(ACCOUNTS) });
    expect(demoInfoFor(false)?.resetHours).toBeNull();
    setDemoEnv({ mode: 'true', hours: 'abc' });
    expect(demoInfoFor(false)?.resetHours).toBeNull();
    setDemoEnv({ mode: 'true', hours: '-3' });
    expect(demoInfoFor(false)?.resetHours).toBeNull();
  });

  it('reads the accounts from a file path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-demo-'));
    const file = path.join(dir, 'accounts.json');
    fs.writeFileSync(file, JSON.stringify(ACCOUNTS));
    try {
      setDemoEnv({ mode: '1', accounts: file });
      expect(getDemoAccounts()).toHaveLength(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a broken config yields no accounts and never logs the passwords', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setDemoEnv({ mode: '1', accounts: JSON.stringify([{ email: 'a@b.test', password: 'leaky-password', name: '' }]) });
    expect(getDemoAccounts()).toEqual([]);
    setDemoEnv({ mode: '1', accounts: '[not json' });
    expect(getDemoAccounts()).toEqual([]);
    setDemoEnv({ mode: '1', accounts: '/nonexistent/folio-demo.json' });
    expect(getDemoAccounts()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('leaky-password');
  });

  it('assertNotDemoAccount: 403 for a demo account (case-insensitive email), a no-op for anyone else and outside demo mode', () => {
    setDemoEnv({ mode: '1', accounts: JSON.stringify(ACCOUNTS) });
    expect(() => assertNotDemoAccount({ email: 'editor@demo.test' }, 'x')).toThrow(HttpError);
    expect(() => assertNotDemoAccount({ email: 'someone@real.test' }, 'x')).not.toThrow();
    setDemoEnv({ accounts: JSON.stringify(ACCOUNTS) });
    expect(() => assertNotDemoAccount({ email: 'editor@demo.test' }, 'x')).not.toThrow();
  });

  it('assertNotDemo: 403 "<what> is disabled in the public demo" in demo mode, a no-op otherwise', () => {
    setDemoEnv({});
    expect(() => assertNotDemo('Creating API tokens')).not.toThrow();
    setDemoEnv({ mode: '1' });
    expect(() => assertNotDemo('Creating API tokens')).toThrow('Creating API tokens is disabled in the public demo');
    try {
      assertNotDemo('x');
    } catch (err) {
      expect((err as HttpError).status).toBe(403);
    }
  });

  it('upload cap: none outside demo mode, 5 MB by default in demo mode, FOLIO_DEMO_MAX_UPLOAD_MB overrides, junk falls back to 5', () => {
    setDemoEnv({ maxUploadMb: '2' });
    expect(demoMaxUploadBytes()).toBeNull();
    setDemoEnv({ mode: '1' });
    expect(demoMaxUploadBytes()).toBe(5 * 1024 * 1024);
    setDemoEnv({ mode: '1', maxUploadMb: '2' });
    expect(demoMaxUploadBytes()).toBe(2 * 1024 * 1024);
    setDemoEnv({ mode: '1', maxUploadMb: 'lots' });
    expect(demoMaxUploadBytes()).toBe(5 * 1024 * 1024);
  });
});

describe('demo /mcp limit thresholds', () => {
  it('default to 60 requests/min and 100 writes/hour; the env overrides them; junk falls back', () => {
    expect([demoMcpRpm(), demoMcpWritesPerHour()]).toEqual([60, 100]);
    setDemoEnv({ mcpRpm: '5', mcpWrites: '7' });
    expect([demoMcpRpm(), demoMcpWritesPerHour()]).toEqual([5, 7]);
    setDemoEnv({ mcpRpm: 'many', mcpWrites: '0' });
    expect([demoMcpRpm(), demoMcpWritesPerHour()]).toEqual([60, 100]);
  });
});

describe('TRUST_PROXY parsing', () => {
  it('is off by default (no way to forge X-Forwarded-For) and for explicit "off" values', () => {
    for (const raw of [undefined, '', '  ', 'false', '0', 'no', 'OFF']) expect(parseTrustProxy(raw)).toBe(false);
  });

  it('true means a proxy on a loopback/private address; a list is taken as addresses/CIDRs', () => {
    expect(parseTrustProxy('true')).toEqual(['loopback', 'linklocal', 'uniquelocal']);
    expect(parseTrustProxy('10.0.0.0/8, 172.16.0.0/12')).toEqual(['10.0.0.0/8', '172.16.0.0/12']);
  });

  it('refuses a bare hop count', () => {
    expect(() => parseTrustProxy('1')).toThrow(/hop count/);
  });

  it('with Fastify: behind a trusted proxy the client is the entry the proxy appended; a forged leading entry or a direct client changes nothing', async () => {
    const app = Fastify({ trustProxy: parseTrustProxy('true') });
    app.get('/', async (request) => request.ip);
    await app.ready();
    const ip = async (remoteAddress: string, xff: string) =>
      (await app.inject({ method: 'GET', url: '/', remoteAddress, headers: { 'x-forwarded-for': xff } })).body;

    expect(await ip('127.0.0.1', '203.0.113.9')).toBe('203.0.113.9');
    expect(await ip('172.18.0.1', '1.2.3.4, 203.0.113.9')).toBe('203.0.113.9'); // "1.2.3.4" was sent by the client
    expect(await ip('198.51.100.20', '1.2.3.4')).toBe('198.51.100.20'); // reached directly from a public address
    await app.close();
  });
});

describe('demo mode over HTTP', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let demoEditorCookie: string;
  let demoAdminCookie: string;
  let realAdminCookie: string;
  let demoEditorId: string;
  let realUserId: string;
  let trashScratch: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    // The trash routes scan the trash root on registration: point it at an empty scratch dir, never the real data/.trash.
    trashScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-demo-trash-'));
    __setTrashRootForTests(trashScratch);
    const hash = await hashPassword('demo-secret-1');
    const demoEditor = await authStore.createUser({ email: 'editor@demo.test', name: 'Dana Editor', passwordHash: hash, isAdmin: false });
    const demoAdmin = await authStore.createUser({ email: 'admin@demo.test', name: 'Alex Admin', passwordHash: hash, isAdmin: true });
    const realAdmin = await authStore.createUser({ email: 'owner@real.test', name: 'Owner', passwordHash: hash, isAdmin: true });
    const realUser = await authStore.createUser({ email: 'person@real.test', name: 'Person', passwordHash: hash, isAdmin: false });
    demoEditorId = demoEditor.id;
    realUserId = realUser.id;
    const cookie = async (id: string) => `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(id)).token}`;
    demoEditorCookie = await cookie(demoEditor.id);
    demoAdminCookie = await cookie(demoAdmin.id);
    realAdminCookie = await cookie(realAdmin.id);

    const app_ = Fastify();
    app_.decorateRequest('authUser', null);
    app_.setErrorHandler((err, _request, reply) => {
      if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
      return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
    });
    await app_.register(fastifyCookieModule.default);
    registerPublicAuthRoutes(app_);
    await app_.register(async (protectedScope) => {
      protectedScope.addHook('onRequest', session.requireSession);
      registerProtectedAuthRoutes(protectedScope);
      registerRoutes(protectedScope);
      registerAssistantRoutes(protectedScope);
      registerAccessRoutes(protectedScope);
      registerTrashRoutes(protectedScope);
    });
    registerMcpRoutes(app_);
    await registerOAuthRoutes(app_, { serveSpa: (_request, reply) => reply.callNotFound() });
    await app_.ready();
    app = app_;
  });

  afterAll(async () => {
    await app?.close();
    __setTrashRootForTests(null);
    fs.rmSync(trashScratch, { recursive: true, force: true });
    await teardownSchema();
  });

  beforeEach(() => {
    setDemoEnv({ mode: '1', accounts: JSON.stringify(ACCOUNTS), hours: '6' });
  });

  async function state(cookie?: string): Promise<AuthState> {
    const res = await app.inject({ method: 'GET', url: '/api/auth/state', headers: cookie ? { cookie } : {} });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it('GET /api/auth/state carries the demo block for a signed-out visitor only in demo mode', async () => {
    const on = await state();
    expect(on.demo?.accounts.map((a) => a.name)).toEqual(['Dana Editor', 'Alex Admin']);
    expect(on.demo?.resetHours).toBe(6);

    setDemoEnv({ accounts: JSON.stringify(ACCOUNTS) });
    const raw = await app.inject({ method: 'GET', url: '/api/auth/state' });
    expect(raw.json()).not.toHaveProperty('demo');
    expect(raw.body).not.toContain('demo-secret');
  });

  it('a signed-in session gets the interval for the banner but no passwords', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/state', headers: { cookie: demoEditorCookie } });
    expect(res.json().demo).toEqual({ accounts: [], resetHours: 6 });
    expect(res.body).not.toContain('demo-secret');
  });

  // Each capability the public demo switches off, for EVERYONE (the instance admin included).
  // The guard is the first thing a handler does, so an empty payload is enough.
  const DISABLED: { name: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH'; url: string; payload?: unknown }[] = [
    { name: 'create a PAT', method: 'POST', url: '/api/me/tokens' },
    { name: 'save an AI key', method: 'PUT', url: '/api/assistant/settings/key' },
    { name: 'start an AI run', method: 'POST', url: '/api/assistant/runs' },
    { name: 'start an AI run (legacy stream)', method: 'POST', url: '/api/assistant/chat/stream' },
    { name: 'list remote branches', method: 'POST', url: '/api/git/branches' },
    { name: 'list provider repos', method: 'GET', url: '/api/git/repos' },
    { name: 'browse a remote tree', method: 'GET', url: '/api/git/tree' },
    { name: 'create a space', method: 'POST', url: '/api/spaces' },
    { name: 'connect a space to git', method: 'POST', url: '/api/spaces/any/connect-git' },
    { name: 'import from Confluence', method: 'POST', url: '/api/import/confluence' },
    { name: 'save a git credential', method: 'POST', url: '/api/me/git-credentials' },
    { name: 'save a Confluence credential', method: 'POST', url: '/api/me/confluence-credentials' },
    { name: 'create a share link', method: 'POST', url: '/api/pages/any/shares' },
    { name: 'create an invite', method: 'POST', url: '/api/invites' },
    { name: 'change the display name', method: 'PATCH', url: '/api/me/preferences', payload: { name: 'Someone Else' } },
    { name: 'change the username', method: 'PATCH', url: '/api/me/preferences', payload: { username: 'someone' } },
  ];

  it.each(DISABLED)('demo mode: cannot $name — 403 for a demo account and for the instance admin', async ({ method, url, payload }) => {
    for (const cookie of [demoEditorCookie, realAdminCookie]) {
      const res = await app.inject({ method, url, headers: { cookie }, payload: payload ?? {} });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/is disabled in the public demo$/);
    }
  });

  it.each(DISABLED)('outside demo mode: $name is not refused by the demo guard', async ({ method, url, payload }) => {
    setDemoEnv({});
    const res = await app.inject({ method, url, headers: { cookie: realAdminCookie }, payload: payload ?? {} });
    expect(res.body).not.toMatch(/disabled in the public demo/);
  });

  it('demo mode: no PAT is minted, and an ordinary preference (language) still saves', async () => {
    const refused = await app.inject({ method: 'POST', url: '/api/me/tokens', headers: { cookie: demoEditorCookie }, payload: { name: 'cli', scopes: ['read'] } });
    expect(refused.statusCode).toBe(403);
    expect((await authStore.listApiTokens(demoEditorId)).length).toBe(0);

    const lang = await app.inject({ method: 'PATCH', url: '/api/me/preferences', headers: { cookie: demoEditorCookie }, payload: { lang: 'uk' } });
    expect(lang.statusCode).toBe(200);
    expect(lang.json().lang).toBe('uk');
  });

  it('outside demo mode a PAT can be minted', async () => {
    setDemoEnv({});
    const res = await app.inject({ method: 'POST', url: '/api/me/tokens', headers: { cookie: demoEditorCookie }, payload: { name: 'cli', scopes: ['read'] } });
    expect(res.statusCode).toBe(201);
  });

  it('PATCH /api/users/:id: a demo admin cannot set a password (its own, a demo account\'s or anyone\'s)', async () => {
    const demoEditor = await authStore.findStoredUserByEmail('editor@demo.test');
    const before = demoEditor!.passwordHash;
    for (const id of [demoEditorId, realUserId]) {
      const res = await app.inject({ method: 'PATCH', url: `/api/users/${id}`, headers: { cookie: demoAdminCookie }, payload: { password: 'brand-new-password' } });
      expect(res.statusCode).toBe(403);
    }
    expect((await authStore.findStoredUserByEmail('editor@demo.test'))!.passwordHash).toBe(before);
  });

  it('PATCH /api/users/:id: a demo admin cannot disable or demote a demo account, but can rename an ordinary user', async () => {
    const disable = await app.inject({ method: 'PATCH', url: `/api/users/${demoEditorId}`, headers: { cookie: demoAdminCookie }, payload: { disabled: true } });
    expect(disable.statusCode).toBe(403);
    expect((await authStore.findStoredUserById(demoEditorId))!.disabled).toBe(false);

    const rename = await app.inject({ method: 'PATCH', url: `/api/users/${realUserId}`, headers: { cookie: demoAdminCookie }, payload: { name: 'Renamed' } });
    expect(rename.statusCode).toBe(200);
  });

  it('PATCH /api/users/:id: the real instance admin (not a demo account) is unaffected', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/users/${realUserId}`, headers: { cookie: realAdminCookie }, payload: { password: 'brand-new-password' } });
    expect(res.statusCode).toBe(200);
  });
  describe('space-admin actions (demo-admin-guards)', () => {
    // The shared demo login is a space admin (so it can edit `.agent`); a destructive space-admin action under it must be refused.
    const DEMO_MSG = /is disabled in the public demo/;
    let demoSpaceAdminCookie: string;
    let realSpaceAdminCookie: string;
    let demoSpaceAdminId: string;
    let realSpaceAdminId: string;
    const spaces: string[] = [];

    beforeAll(async () => {
      const demoEditor = await authStore.findStoredUserByEmail('editor@demo.test');
      const real = await authStore.findStoredUserByEmail('person@real.test');
      demoSpaceAdminId = demoEditor!.id;
      realSpaceAdminId = real!.id;
      const cookie = async (id: string) => `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(id)).token}`;
      demoSpaceAdminCookie = await cookie(demoSpaceAdminId);
      realSpaceAdminCookie = await cookie(realSpaceAdminId);
    });

    afterAll(async () => {
      for (const slug of spaces) await deleteTestSpace(slug);
    });

    /** A fresh space where both the demo account and the ordinary user are admins, with one other member, one invite and one `.agent` page. */
    async function freshSpace() {
      const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
      const space = await storage.createSpace(`Guards ${stamp}`, realSpaceAdminId);
      spaces.push(space.slug);
      await authStore.setMembership(space.slug, demoSpaceAdminId, 'admin');
      await authStore.setMembership(space.slug, realSpaceAdminId, 'admin');
      const other = await authStore.createUser({ email: `member-${stamp}@real.test`, name: 'Member', passwordHash: 'x', isAdmin: false });
      await authStore.setMembership(space.slug, other.id, 'viewer');
      const invite = await invites.createInvite({ memberships: [{ space: space.slug, role: 'viewer' }], isAdmin: false, expiresInDays: 7, maxUses: 1 }, realSpaceAdminId, 'http://localhost');
      const page = await storage.createPage({ space: space.slug, parentPath: '', title: `Page ${stamp}`, kind: 'doc' });
      const agent = await storage.createPage({ space: space.slug, parentPath: '.agent', title: `Rules ${stamp}`, kind: 'doc' });
      return { slug: space.slug, otherId: other.id, inviteId: invite.id, pageId: page.id, agentId: agent.id };
    }
    type Fixture = Awaited<ReturnType<typeof freshSpace>>;

    interface Case {
      name: string;
      method: 'PUT' | 'POST' | 'PATCH' | 'DELETE';
      url: (f: Fixture) => string;
      payload?: (f: Fixture) => unknown;
      /** Space admins are gated on the space; some routes (rename/delete a space, trash settings) are instance-admin only, so the allowed side needs the real instance admin. */
      instanceAdmin?: boolean;
      /** Already refused for EVERY user in demo mode (assertNotDemo), so the ordinary-admin check does not apply. */
      blockedForAll?: boolean;
    }
    const CASES: Case[] = [
      { name: 'delete a space', method: 'DELETE', url: (f) => `/api/admin/spaces/${f.slug}`, instanceAdmin: true },
      { name: 'rename a space', method: 'PATCH', url: (f) => `/api/admin/spaces/${f.slug}`, payload: () => ({ name: 'Renamed' }), instanceAdmin: true },
      { name: 'change space visibility', method: 'PATCH', url: (f) => `/api/spaces/${f.slug}`, payload: () => ({ visibility: 'instance' }) },
      { name: 'bulk access change', method: 'POST', url: () => '/api/access/bulk', payload: (f) => ({ changes: [{ userId: f.otherId, space: f.slug, role: null }] }) },
      { name: 'set a member role', method: 'PUT', url: (f) => `/api/spaces/${f.slug}/members/${f.otherId}`, payload: () => ({ role: 'editor' }) },
      { name: 'set its own role', method: 'PUT', url: (f) => `/api/spaces/${f.slug}/members/${f.otherId}`, payload: () => ({ role: 'viewer' }) },
      { name: 'remove a member', method: 'DELETE', url: (f) => `/api/spaces/${f.slug}/members/${f.otherId}` },
      { name: 'revoke an invite', method: 'DELETE', url: (f) => `/api/invites/${f.inviteId}` },
      { name: 'git sync', method: 'POST', url: (f) => `/api/spaces/${f.slug}/sync` },
      { name: 'git reset-to-remote', method: 'POST', url: (f) => `/api/spaces/${f.slug}/git/reset-to-remote` },
      { name: 'connect git', method: 'POST', url: (f) => `/api/spaces/${f.slug}/connect-git`, payload: () => ({ repoUrl: 'https://example.test/x.git' }), blockedForAll: true },
      { name: 'page permissions', method: 'PUT', url: (f) => `/api/pages/${f.pageId}/access`, payload: () => ({ visibility: 'restricted', grants: [] }) },
      { name: 'purge one trash item', method: 'DELETE', url: () => '/api/trash/00000000-0000-4000-8000-000000000000' },
      { name: 'empty the trash', method: 'DELETE', url: (f) => `/api/trash?space=${f.slug}` },
      { name: 'trash retention', method: 'PUT', url: () => '/api/trash/settings', payload: () => ({ retentionDays: 30 }), instanceAdmin: true },
    ];

    async function call(c: Case, f: Fixture, cookie: string) {
      return app.inject({ method: c.method, url: c.url(f), headers: { cookie }, payload: c.payload ? (c.payload(f) as object) : undefined });
    }

    it.each(CASES)('demo account, space admin: $name -> 403 "... is disabled in the public demo"', async (c) => {
      const f = await freshSpace();
      // The instance-admin-only routes are reached by the demo instance admin; the rest by the demo account that is a space admin.
      const res = await call(c, f, c.instanceAdmin ? demoAdminCookie : demoSpaceAdminCookie);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(DEMO_MSG);
      // Nothing changed.
      expect(await storage.spaceExists(f.slug)).toBe(true);
      expect(await authStore.getMembershipRole(f.slug, f.otherId)).toBe('viewer');
    });

    it.each(CASES.filter((c) => !c.blockedForAll))('not a demo account (demo mode on): $name is not refused by the demo guard', async (c) => {
      const f = await freshSpace();
      const cookie = c.instanceAdmin ? realAdminCookie : realSpaceAdminCookie;
      const res = await call(c, f, cookie);
      expect(res.body).not.toMatch(DEMO_MSG);
    });

    it.each(CASES)('demo mode off: $name is not refused for the demo account either', async (c) => {
      setDemoEnv({});
      const f = await freshSpace();
      const res = await call(c, f, c.instanceAdmin ? demoAdminCookie : demoSpaceAdminCookie);
      expect(res.body).not.toMatch(DEMO_MSG);
    });

    it('the destructive actions really go through for an ordinary admin (the guard is the only difference)', async () => {
      const f = await freshSpace();
      const removed = await app.inject({ method: 'DELETE', url: `/api/spaces/${f.slug}/members/${f.otherId}`, headers: { cookie: realSpaceAdminCookie } });
      expect(removed.statusCode).toBe(200);
      expect(await authStore.getMembershipRole(f.slug, f.otherId)).toBeUndefined();
      const revoked = await app.inject({ method: 'DELETE', url: `/api/invites/${f.inviteId}`, headers: { cookie: realSpaceAdminCookie } });
      expect(revoked.statusCode).toBe(200);
    });

    it('.agent stays readable and editable for the demo space admin', async () => {
      const f = await freshSpace();
      const read = await app.inject({ method: 'GET', url: `/api/pages/${f.agentId}`, headers: { cookie: demoSpaceAdminCookie } });
      expect(read.statusCode).toBe(200);
      const text = `Always answer briefly ${randomBytes(3).toString('hex')}`;
      const write = await app.inject({ method: 'PUT', url: `/api/pages/${f.agentId}`, headers: { cookie: demoSpaceAdminCookie }, payload: { markdown: `# Rules\n\n${text}\n` } });
      expect(write.statusCode).toBe(200);
      const again = await app.inject({ method: 'GET', url: `/api/pages/${f.agentId}`, headers: { cookie: demoSpaceAdminCookie } });
      expect(again.json().markdown).toContain(text);
      // A new page can be added inside .agent too.
      const created = await app.inject({ method: 'POST', url: '/api/pages', headers: { cookie: demoSpaceAdminCookie }, payload: { space: f.slug, parentPath: '.agent', title: 'More rules', kind: 'doc' } });
      expect(created.statusCode).toBe(201);
    });

    it('.agent stays hidden from a demo account that is only an editor', async () => {
      const f = await freshSpace();
      await authStore.setMembership(f.slug, demoSpaceAdminId, 'editor');
      const res = await app.inject({ method: 'GET', url: `/api/pages/${f.agentId}`, headers: { cookie: demoSpaceAdminCookie } });
      expect(res.statusCode).toBe(404);
    });

    it('the .agent folder itself cannot be deleted, moved or renamed under a demo account; its pages can', () => {
      const demoUser = { email: 'editor@demo.test' };
      const other = { email: 'person@real.test' };
      for (const rel of ['.agent', '.agent/index.md', '.agent/README.md']) {
        expect(() => assertDemoAgentRootIntact(demoUser, rel, 'Deleting the .agent folder')).toThrow(/is disabled in the public demo/);
        expect(() => assertDemoAgentRootIntact(other, rel, 'Deleting the .agent folder')).not.toThrow();
      }
      for (const rel of ['.agent/rules.md', '.agent/nested/index.md', 'notes/.agent', 'notes/index.md', '.agentx.md']) {
        expect(() => assertDemoAgentRootIntact(demoUser, rel, 'Deleting the .agent folder')).not.toThrow();
      }
      setDemoEnv({});
      expect(() => assertDemoAgentRootIntact(demoUser, '.agent', 'Deleting the .agent folder')).not.toThrow();
    });

    it('the .agent index page cannot be deleted, renamed or moved over HTTP by a demo account', async () => {
      const f = await freshSpace();
      const index = await storage.createPage({ space: f.slug, parentPath: '.agent', title: 'index', kind: 'doc' });
      const entry = await storage.requireEntry(index.id);
      expect(entry.relPath).toBe('.agent/index.md');
      const attempts = [
        { method: 'DELETE' as const, url: `/api/pages/${index.id}`, payload: undefined },
        { method: 'POST' as const, url: `/api/pages/${index.id}/rename`, payload: { title: 'x' } },
        { method: 'POST' as const, url: `/api/pages/${index.id}/slug`, payload: { slug: 'x' } },
        { method: 'POST' as const, url: `/api/pages/${index.id}/move`, payload: { toParentPath: '' } },
      ];
      for (const a of attempts) {
        const res = await app.inject({ method: a.method, url: a.url, headers: { cookie: demoSpaceAdminCookie }, payload: a.payload });
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toMatch(DEMO_MSG);
      }
    });
  });

  describe('OAuth connector flow stays available', () => {
    const PUBLIC = 'https://demo.example.test';
    const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
    const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

    beforeEach(() => {
      process.env.PUBLIC_URL = PUBLIC;
      __resetOAuthRateLimitsForTests();
    });
    afterEach(() => {
      delete process.env.PUBLIC_URL;
    });

    const register = () =>
      app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'Connector', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' } });

    it('discovery documents, /oauth/register and the /mcp 401 challenge all work in demo mode', async () => {
      for (const url of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp']) {
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
      }
      expect((await register()).statusCode).toBe(201);
      const challenge = await app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
      expect(challenge.statusCode).toBe(401);
      expect(String(challenge.headers['www-authenticate'])).toContain('resource_metadata=');
    });

    it('a demo account authorizes a connector end to end and the token reaches /mcp; the other demo guards still hold', async () => {
      const clientId = (await register()).json().client_id as string;
      const verifier = randomBytes(32).toString('base64url');
      const authorize = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        state: 's1',
        resource: `${PUBLIC}/mcp`,
      });
      const consent = await app.inject({ method: 'GET', url: `/oauth/authorize?${authorize.toString()}`, headers: { cookie: demoEditorCookie } });
      expect(consent.statusCode).toBe(200);
      const requestId = /name="request_id" value="([^"]+)"/.exec(consent.body)?.[1];
      expect(requestId).toBeTruthy();

      const decided = await app.inject({
        method: 'POST',
        url: '/oauth/authorize',
        headers: { cookie: demoEditorCookie, ...FORM },
        payload: new URLSearchParams({ request_id: requestId!, decision: 'allow', write: '1' }).toString(),
      });
      expect(decided.statusCode).toBe(302);
      const code = new URL(String(decided.headers.location)).searchParams.get('code');
      expect(code).toBeTruthy();

      const token = await app.inject({
        method: 'POST',
        url: '/oauth/token',
        headers: FORM,
        payload: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code: code!,
          code_verifier: verifier,
          redirect_uri: REDIRECT,
          resource: `${PUBLIC}/mcp`,
        }).toString(),
      });
      expect(token.statusCode).toBe(200);
      const accessToken = token.json().access_token as string;

      const mcp = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json, text/event-stream' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      });
      expect(mcp.statusCode).toBe(200);

      // An OAuth token is MCP-only: it does not open the REST API, and the connector flow
      // does not turn into a way around the demo guards (PATs stay refused for the same user).
      const rest = await app.inject({ method: 'GET', url: '/api/me/tokens', headers: { authorization: `Bearer ${accessToken}` } });
      expect(rest.statusCode).toBe(401);
      const pat = await app.inject({ method: 'POST', url: '/api/me/tokens', headers: { cookie: demoEditorCookie }, payload: { name: 'cli', scopes: ['read'] } });
      expect(pat.statusCode).toBe(403);
    });
  });
  describe('/mcp limits', () => {
    const PUBLIC = 'https://demo.example.test';
    const MCP_HEADERS = (token: string) => ({ authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' });
    let pat: string;
    let patRead: string;
    let editorUserId: string;

    beforeAll(async () => {
      // A PAT stands in for an OAuth token here (the same /mcp path); the demo refuses minting one over HTTP, so go through the store.
      editorUserId = (await authStore.findStoredUserByEmail('editor@demo.test'))!.id;
      pat = (await authStore.createApiToken(editorUserId, 'limits-write', ['read', 'write'])).token;
      patRead = (await authStore.createApiToken(editorUserId, 'limits-read', ['read'])).token;
    });
    beforeEach(() => {
      process.env.PUBLIC_URL = PUBLIC;
      __resetOAuthRateLimitsForTests();
    });
    afterEach(() => {
      delete process.env.PUBLIC_URL;
    });

    const call = (token: string, name: string, args: Record<string, unknown>, id: number | string = 1) =>
      app.inject({ method: 'POST', url: '/mcp', headers: MCP_HEADERS(token), payload: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } } });
    const list = (token: string) => app.inject({ method: 'POST', url: '/mcp', headers: MCP_HEADERS(token), payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });

    it('429 after FOLIO_DEMO_MCP_RPM requests a minute: Retry-After, a JSON-RPC error with the request id, and the next minute is not poisoned', async () => {
      setDemoEnv({ mode: '1', mcpRpm: '3' });
      for (let i = 0; i < 3; i++) expect((await list(pat)).statusCode).toBe(200);
      const limited = await app.inject({ method: 'POST', url: '/mcp', headers: MCP_HEADERS(pat), payload: { jsonrpc: '2.0', id: 'abc', method: 'tools/list' } });
      expect(limited.statusCode).toBe(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
      expect(limited.json()).toMatchObject({ jsonrpc: '2.0', id: 'abc', error: { message: expect.stringMatching(/Retry in \d+ s/) } });
      // GET and DELETE on /mcp count against the same bucket.
      expect((await app.inject({ method: 'GET', url: '/mcp', headers: MCP_HEADERS(pat) })).statusCode).toBe(429);
    });

    it('the per-minute bucket is per user and IP: another user, or the same user from another IP, is not throttled', async () => {
      setDemoEnv({ mode: '1', mcpRpm: '2' });
      const other = (await authStore.findStoredUserByEmail('person@real.test'))!;
      const otherPat = (await authStore.createApiToken(other.id, 'other', ['read'])).token;
      for (let i = 0; i < 2; i++) await list(pat);
      expect((await list(pat)).statusCode).toBe(429);
      expect((await list(otherPat)).statusCode).toBe(200);
      const fromElsewhere = await app.inject({ method: 'POST', url: '/mcp', remoteAddress: '203.0.113.50', headers: MCP_HEADERS(pat), payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
      expect(fromElsewhere.statusCode).toBe(200);
    });

    it('unauthenticated /mcp requests get 401 until the per-IP minute cap, then 429', async () => {
      setDemoEnv({ mode: '1', mcpRpm: '3' });
      const anon = () => app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
      for (let i = 0; i < 3; i++) expect((await anon()).statusCode).toBe(401);
      const limited = await anon();
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
    });

    it('outside demo mode there is no limit on /mcp', async () => {
      setDemoEnv({ mcpRpm: '1', mcpWrites: '1' });
      for (let i = 0; i < 5; i++) expect((await list(pat)).statusCode).toBe(200);
      for (let i = 0; i < 3; i++) expect((await app.inject({ method: 'POST', url: '/mcp', payload: {} })).statusCode).toBe(401);
    });

    it('the write limit counts only writing tools (readOnlyHint=false), per IP per hour; reads are not counted and a refused write records nothing', async () => {
      setDemoEnv({ mode: '1', mcpWrites: '2' });
      // Reads and tools/list never touch the write budget.
      for (let i = 0; i < 5; i++) expect((await call(pat, 'list_spaces', {})).statusCode).toBe(200);
      // Two writes (a failing one counts as an attempt: the cap is on calls, not successes).
      expect((await call(pat, 'update_page', { id: 'no-such-page', markdown: '# x' })).statusCode).toBe(200);
      expect((await call(pat, 'folio_table_insert', { id: 'no-such-table', rows: [{ a: 1 }] })).statusCode).toBe(200);
      const third = await call(pat, 'create_page', { space: 'none', parentPath: '', title: 't' }, 'w3');
      expect(third.statusCode).toBe(429);
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(60);
      expect(third.json()).toMatchObject({ id: 'w3', error: { message: expect.stringMatching(/writes per hour/) } });
      // Reads still pass while writes are refused, and the write budget is per IP, not per user.
      expect((await call(pat, 'list_spaces', {})).statusCode).toBe(200);
      expect((await call(patRead, 'create_page', { space: 'none', parentPath: '', title: 't' })).statusCode).toBe(429);
    });

    it('a batch is refused as a whole when its writes do not fit, and consumes nothing', async () => {
      setDemoEnv({ mode: '1', mcpWrites: '2' });
      const batch = (n: number) =>
        app.inject({
          method: 'POST',
          url: '/mcp',
          headers: MCP_HEADERS(pat),
          payload: Array.from({ length: n }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: 'update_page', arguments: { id: 'x', markdown: 'y' } } })),
        });
      expect((await batch(3)).statusCode).toBe(429);
      expect((await batch(2)).statusCode).toBe(200);
      expect((await batch(1)).statusCode).toBe(429);
    });

    it('size caps: a request body over 1 MB is 413 (Content-Length, before it is read); one write over 200 KB is 413, a read is not', async () => {
      setDemoEnv({ mode: '1' });
      const huge = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: MCP_HEADERS(pat),
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_page', arguments: { id: 'x', markdown: 'a'.repeat(1024 * 1024 + 10) } } },
      });
      expect(huge.statusCode).toBe(413);
      expect(huge.json().error.message).toMatch(/1 MB/);

      const big = 'a'.repeat(DEMO_MCP_MAX_WRITE_ARGS_BYTES + 1);
      for (const [name, args] of [
        ['update_page', { id: 'x', markdown: big }],
        ['create_page', { space: 's', parentPath: '', title: 't', markdown: big }],
      ] as const) {
        const res = await call(pat, name, args);
        expect(res.statusCode, name).toBe(413);
        expect(res.json().error.message).toMatch(/200 KB/);
      }
      // A write just under the cap is let through to the tool (which then reports its own error), and a read with a large argument is not a write.
      const ok = await call(pat, 'update_page', { id: 'no-such-page', markdown: 'a'.repeat(DEMO_MCP_MAX_WRITE_ARGS_BYTES - 1000) });
      expect(ok.statusCode).toBe(200);
      expect((await call(pat, 'search_pages', { query: big })).statusCode).toBe(200);
    });

    it('a refused-for-size write does not eat the write budget', async () => {
      setDemoEnv({ mode: '1', mcpWrites: '1' });
      const big = 'a'.repeat(DEMO_MCP_MAX_WRITE_ARGS_BYTES + 1);
      expect((await call(pat, 'update_page', { id: 'x', markdown: big })).statusCode).toBe(413);
      expect((await call(pat, 'update_page', { id: 'no-such-page', markdown: 'ok' })).statusCode).toBe(200);
    });

    it('outside demo mode a large write is not refused by the demo caps', async () => {
      setDemoEnv({});
      const res = await call(pat, 'update_page', { id: 'no-such-page', markdown: 'a'.repeat(DEMO_MCP_MAX_WRITE_ARGS_BYTES + 1) });
      expect(res.statusCode).toBe(200);
    });

    it(`OAuth: POST /oauth/token and POST /oauth/authorize are capped at ${DEMO_OAUTH_PER_MINUTE}/min per IP in demo mode only`, async () => {
      const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
      const token = () => app.inject({ method: 'POST', url: '/oauth/token', headers: FORM, payload: 'grant_type=authorization_code' });
      const decide = () => app.inject({ method: 'POST', url: '/oauth/authorize', headers: { cookie: demoEditorCookie, ...FORM }, payload: 'request_id=nope&decision=deny' });

      for (let i = 0; i < DEMO_OAUTH_PER_MINUTE; i++) {
        expect((await token()).statusCode).toBe(400); // client_id is required: refused for content, not for rate
        expect((await decide()).statusCode).toBe(400);
      }
      const t = await token();
      expect(t.statusCode).toBe(429);
      expect(t.headers['retry-after']).toBe('60');
      expect(t.json().error).toBe('temporarily_unavailable');
      const a = await decide();
      expect(a.statusCode).toBe(429);
      expect(a.headers['retry-after']).toBe('60');

      // The same traffic outside demo mode meets only the ordinary limits (120/min token, 60/min authorize).
      setDemoEnv({});
      __resetOAuthRateLimitsForTests();
      for (let i = 0; i < DEMO_OAUTH_PER_MINUTE + 5; i++) {
        expect((await token()).statusCode).toBe(400);
        expect((await decide()).statusCode).toBe(400);
      }
    });

    it('/oauth/register keeps its 20/hour cap in demo mode', async () => {
      const reg = () => app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'C', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] } });
      for (let i = 0; i < 20; i++) expect((await reg()).statusCode).toBe(201);
      expect((await reg()).statusCode).toBe(429);
    });
  });
});
