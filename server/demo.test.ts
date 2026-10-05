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
import { setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import { registerRoutes } from './routes.js';
import { registerAssistantRoutes } from './assistant/routes.js';
import { registerMcpRoutes } from './mcpRoutes.js';
import { __resetOAuthRateLimitsForTests, registerOAuthRoutes } from './oauth/routes.js';
import { __resetDemoConfigForTests, assertNotDemo, assertNotDemoAccount, demoInfoFor, demoMaxUploadBytes, getDemoAccounts, isDemoAccountEmail } from './demo.js';
import { parseTrustProxy } from './trustProxy.js';

const ACCOUNTS = [
  { email: 'Editor@Demo.test', password: 'demo-secret-1', name: 'Dana Editor', role: 'Editor', description: 'Editor in Engineering and Product' },
  { email: 'admin@demo.test', password: 'demo-secret-2', name: 'Alex Admin', role: 'Admin', description: 'Instance admin' },
];

function setDemoEnv(env: { mode?: string; accounts?: string; hours?: string; maxUploadMb?: string }) {
  const set = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  set('FOLIO_DEMO_MODE', env.mode);
  set('FOLIO_DEMO_ACCOUNTS', env.accounts);
  set('FOLIO_DEMO_RESET_HOURS', env.hours);
  set('FOLIO_DEMO_MAX_UPLOAD_MB', env.maxUploadMb);
  __resetDemoConfigForTests();
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

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
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
    });
    registerMcpRoutes(app_);
    await registerOAuthRoutes(app_, { serveSpa: (_request, reply) => reply.callNotFound() });
    await app_.ready();
    app = app_;
  });

  afterAll(async () => {
    await app?.close();
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
});
