/**
 * Single sign-on (OpenID Connect) end to end, without a real identity provider:
 * a mock OP (discovery document, JWKS, token endpoint) answers every request
 * openid-client makes, through its customFetch hook, and signs ID tokens with
 * a local RSA key. The Fastify app runs the real routes against a real
 * (per-run schema) PostgreSQL: start -> the provider's authorize URL (state,
 * nonce, PKCE challenge read back from it) -> callback with a code whose
 * token response the test chose.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setUpTestSchema, deleteTestSpace } from '../db/testSchema.js';
import { query, queryOne } from '../db/pool.js';
import { HttpError } from '../errors.js';
import * as storage from '../storage.js';
import * as groupStore from '../groups/store.js';
import * as invites from '../invites.js';
import { registerPublicInviteRoutes } from '../routes.js';
import { hashPassword } from './passwords.js';
import * as store from './store.js';
import * as session from './session.js';
import * as providers from './providers.js';
import { __setOidcFetchForTests, mapClaims, signFlow, verifyFlow, registerOidcRoutes } from './oidc.js';
import { registerProtectedAuthRoutes, registerPublicAuthRoutes } from './routes.js';
import { registerAuthProviderRoutes } from './providerRoutes.js';

const ISSUER = 'https://op.test';
const GOOGLE = 'https://accounts.google.com';

interface MockOp {
  issuer: string;
  key: CryptoKey;
  jwk: JWK;
  /** code -> what the token endpoint answers, plus the PKCE challenge it must match. */
  codes: Map<string, { idToken: string; challenge: string; redirectUri: string }>;
}

const ops = new Map<string, MockOp>();
let foreignKey: CryptoKey;

async function makeOp(issuer: string): Promise<MockOp> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: `k-${randomBytes(4).toString('hex')}`, alg: 'RS256', use: 'sig' };
  const op = { issuer, key: privateKey, jwk, codes: new Map() };
  ops.set(issuer, op);
  return op;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** The provider side of every request openid-client makes. */
async function mockFetch(url: string, options: { body?: unknown; method?: string }): Promise<Response> {
  const u = new URL(url);
  const op = ops.get(u.origin);
  if (!op) return new Response('unknown host', { status: 404 });
  if (u.pathname === '/.well-known/openid-configuration') {
    return json({
      issuer: op.issuer,
      authorization_endpoint: `${op.issuer}/authorize`,
      token_endpoint: `${op.issuer}/token`,
      jwks_uri: `${op.issuer}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
    });
  }
  if (u.pathname === '/jwks') return json({ keys: [op.jwk] });
  if (u.pathname === '/token' && options.method === 'POST') {
    const params = new URLSearchParams(String(options.body));
    const entry = op.codes.get(params.get('code') ?? '');
    if (!entry) return json({ error: 'invalid_grant' }, 400);
    const verifier = params.get('code_verifier') ?? '';
    if (createHash('sha256').update(verifier).digest('base64url') !== entry.challenge) return json({ error: 'invalid_grant', error_description: 'pkce' }, 400);
    if (params.get('redirect_uri') !== entry.redirectUri) return json({ error: 'invalid_grant', error_description: 'redirect_uri' }, 400);
    op.codes.delete(params.get('code')!);
    return json({ access_token: 'at-' + randomBytes(8).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: entry.idToken });
  }
  return new Response('not found', { status: 404 });
}

function cookieFrom(setCookie: string | string[] | undefined, name: string): string | undefined {
  const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const hit = all.find((c) => c.startsWith(`${name}=`));
  if (!hit) return undefined;
  const value = hit.split(';')[0].slice(name.length + 1);
  return value ? `${name}=${value}` : undefined;
}

describe('single sign-on through OpenID Connect (mock provider, real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let space: string;
  const spaces: string[] = [];
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    process.env.FOLIO_SECRET = 'oidc-test-secret';
    await makeOp(ISSUER);
    await makeOp(GOOGLE);
    foreignKey = (await generateKeyPair('RS256')).privateKey;
    __setOidcFetchForTests(mockFetch as never);

    space = (await storage.createSpace(`SSO Test ${Date.now()}`, null)).slug;
    spaces.push(space);

    const a = Fastify();
    a.decorateRequest('authUser', null);
    a.setErrorHandler((err, _request, reply) => {
      if (err instanceof HttpError) return reply.status(err.status).send(err.code ? { error: err.message, code: err.code } : { error: err.message });
      return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
    });
    await a.register(fastifyCookieModule.default);
    registerPublicAuthRoutes(a);
    registerOidcRoutes(a);
    registerPublicInviteRoutes(a);
    await a.register(async (scope) => {
      scope.addHook('onRequest', session.requireSession);
      registerProtectedAuthRoutes(scope);
      registerAuthProviderRoutes(scope);
    });
    await a.ready();
    app = a;
  });

  afterAll(async () => {
    __setOidcFetchForTests(undefined);
    await app?.close();
    for (const s of spaces) await deleteTestSpace(s).catch(() => {});
    await teardownSchema();
    for (const k of ['FOLIO_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_ALLOWED_DOMAINS']) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  beforeEach(() => {
    session.__resetLoginRateLimitForTests();
  });

  let counter = 0;
  async function provider(overrides: Partial<providers.ProviderInput> = {}): Promise<providers.AuthProvider> {
    counter += 1;
    return providers.createProvider({
      slug: `kc${counter}`,
      displayName: `Keycloak ${counter}`,
      issuer: ISSUER,
      clientId: 'folio',
      clientSecret: 'shh',
      allowedDomains: ['acme.test'],
      jitEnabled: true,
      ...overrides,
    });
  }

  interface SignInOptions {
    claims?: Record<string, unknown>;
    signWith?: CryptoKey;
    aud?: string;
    nonce?: string;
    issuer?: string;
    startUrl?: string;
    cookie?: string;
  }

  /** start -> (the provider) -> callback. Returns the callback's response and the session cookie it set, if any. */
  async function signIn(slug: string, opts: SignInOptions = {}) {
    const issuer = opts.issuer ?? ISSUER;
    const op = ops.get(issuer)!;
    const start = await app.inject({ method: 'GET', url: opts.startUrl ?? `/api/auth/oidc/${slug}/start`, headers: opts.cookie ? { cookie: opts.cookie } : {} });
    expect(start.statusCode).toBe(302);
    const authorize = new URL(start.headers.location as string);
    expect(authorize.origin + authorize.pathname).toBe(`${issuer}/authorize`);
    const flowCookie = cookieFrom(start.headers['set-cookie'], 'folio_oidc')!;
    const state = authorize.searchParams.get('state')!;
    const code = randomBytes(8).toString('hex');
    const idToken = await new SignJWT({
      email_verified: true,
      nonce: opts.nonce ?? authorize.searchParams.get('nonce')!,
      ...opts.claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: op.jwk.kid })
      .setIssuer(issuer)
      .setAudience(opts.aud ?? authorize.searchParams.get('client_id')!)
      .setSubject(String(opts.claims?.sub ?? 'sub-default'))
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(opts.signWith ?? op.key);
    op.codes.set(code, { idToken, challenge: authorize.searchParams.get('code_challenge')!, redirectUri: authorize.searchParams.get('redirect_uri')! });
    const callbackPath = new URL(authorize.searchParams.get('redirect_uri')!).pathname;
    const res = await app.inject({
      method: 'GET',
      url: `${callbackPath}?code=${code}&state=${encodeURIComponent(state)}`,
      headers: { cookie: [flowCookie, opts.cookie].filter(Boolean).join('; ') },
    });
    const location = String(res.headers.location ?? '');
    const authError = location ? new URL(location).searchParams.get('authError') : null;
    return { res, authError, sessionCookie: cookieFrom(res.headers['set-cookie'], session.SESSION_COOKIE_NAME) };
  }

  async function whoAmI(cookie: string | undefined) {
    const res = await app.inject({ method: 'GET', url: '/api/auth/state', headers: cookie ? { cookie } : {} });
    return res.json().user as { id: string; email: string; isAdmin: boolean } | null;
  }

  async function auditActions(target: string): Promise<string[]> {
    await new Promise((r) => setTimeout(r, 30)); // recordAudit is fire-and-forget
    const rows = await query<{ action: string }>('SELECT action FROM audit_log WHERE target = $1 ORDER BY id', [target]);
    return rows.map((r) => r.action);
  }

  /** The failed check openid-client reported, as audited (auth.sso_refused meta.detail). */
  async function refusalDetails(target: string): Promise<string[]> {
    await new Promise((r) => setTimeout(r, 30));
    const rows = await query<{ meta: { detail?: string } }>("SELECT meta FROM audit_log WHERE target = $1 AND action = 'auth.sso_refused' ORDER BY id", [target]);
    return rows.map((r) => r.meta.detail ?? '');
  }

  async function adminCookie(email = `admin-${randomBytes(3).toString('hex')}@admins.test`) {
    const admin = await store.createUser({ email, name: 'Admin', isAdmin: true, passwordHash: await hashPassword('admin-password') });
    return { admin, cookie: `${session.SESSION_COOKIE_NAME}=${(await store.createSession(admin.id)).token}` };
  }

  // -------------------------------------------------------------------------

  it('JIT: a new person signs in, gets an account (no password, not admin), the default spaces and the raw groups claim', async () => {
    const p = await provider({ jitDefaultSpaces: { [space]: 'editor', 'no-such-space': 'viewer' } });
    const out = await signIn(p.slug, { claims: { sub: 'u-jit', email: 'new.person@acme.test', name: 'New Person', groups: ['/eng', '/all'] } });
    expect(out.authError).toBeNull();
    expect(out.res.statusCode).toBe(302);
    const me = await whoAmI(out.sessionCookie);
    expect(me?.email).toBe('new.person@acme.test');
    expect(me?.isAdmin).toBe(false);
    const stored = await store.findStoredUserByEmail('new.person@acme.test');
    expect(stored?.passwordHash).toBeNull();
    expect(stored?.name).toBe('New Person');
    expect(await store.getMembershipRole(space, me!.id)).toBe('editor');
    const identity = await providers.findIdentity(ISSUER, 'u-jit');
    expect(identity?.userId).toBe(me!.id);
    expect(identity?.groups).toEqual(['/eng', '/all']);
    expect(await auditActions(p.slug)).toContain('auth.sso_jit_create');

    // Second sign-in: the identity, not the email, finds the account; groups are refreshed.
    const again = await signIn(p.slug, { claims: { sub: 'u-jit', email: 'new.person@acme.test', groups: ['/eng'] } });
    expect((await whoAmI(again.sessionCookie))?.id).toBe(me!.id);
    expect((await providers.findIdentity(ISSUER, 'u-jit'))?.groups).toEqual(['/eng']);
    expect(await auditActions(p.slug)).toContain('auth.sso_login');
  });

  it('group sync: the groups claim becomes Folio group memberships at every sign-in (JIT included), and overage removes nothing', async () => {
    const eng = await groupStore.createGroup({ slug: `sso-eng-${counter}`, name: `SSO Eng ${counter}`, description: '' }, (await adminCookie()).admin.id);
    const ops = await groupStore.createGroup({ slug: `sso-ops-${counter}`, name: `SSO Ops ${counter}`, description: '' }, (await adminCookie()).admin.id);
    const p = await provider({
      claimMapping: { groups: 'roles' },
      groupSync: { enabled: true, mode: 'name', mapping: {}, createMissing: false, allow: '' },
    });
    const memberSlugs = async (userId: string) =>
      (await query<{ slug: string; source: string }>('SELECT g.slug, gm.source FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = $1 ORDER BY g.slug', [userId])).map((r) => `${r.slug}:${r.source}`);

    // First sign-in creates the account (JIT) and syncs the custom claim "roles".
    const first = await signIn(p.slug, { claims: { sub: 'u-gs', email: 'group.sync@acme.test', roles: [eng.name, ops.name, 'not-a-folio-group'] } });
    expect(first.authError).toBeNull();
    const me = (await whoAmI(first.sessionCookie))!;
    expect(await memberSlugs(me.id)).toEqual([`${eng.slug}:oidc`, `${ops.slug}:oidc`].sort());

    // Second sign-in: one group fewer.
    await signIn(p.slug, { claims: { sub: 'u-gs', email: 'group.sync@acme.test', roles: [eng.name] } });
    expect(await memberSlugs(me.id)).toEqual([`${eng.slug}:oidc`]);

    // Entra overage: the list is unknown, so nothing is removed and the skip is audited.
    await signIn(p.slug, { claims: { sub: 'u-gs', email: 'group.sync@acme.test', _claim_names: { roles: 'src1' }, _claim_sources: { src1: { endpoint: 'https://graph.example/x' } } } });
    expect(await memberSlugs(me.id)).toEqual([`${eng.slug}:oidc`]);
    await new Promise((r) => setTimeout(r, 40));
    const skipped = await query<{ meta: { reason?: string } }>("SELECT meta FROM audit_log WHERE target = $1 AND action = 'auth.group_sync_skipped'", [p.slug]);
    expect(skipped.map((r) => r.meta.reason)).toEqual(['overage']);
    const synced = await auditActions(p.slug);
    expect(synced.filter((a) => a === 'auth.group_sync')).toHaveLength(2);

    // A provider with sync off never touches memberships.
    const off = await provider();
    const other = await signIn(off.slug, { claims: { sub: 'u-gs-off', email: 'group.off@acme.test', groups: [eng.name] } });
    expect(await memberSlugs((await whoAmI(other.sessionCookie))!.id)).toEqual([]);
  });

  it('refuses an ID token signed by a key that is not in the provider JWKS', async () => {
    const p = await provider();
    const out = await signIn(p.slug, { claims: { sub: 'u-forged', email: 'forged@acme.test' }, signWith: foreignKey });
    expect(out.authError).toBe('exchange');
    expect(out.sessionCookie).toBeUndefined();
    expect(await store.findStoredUserByEmail('forged@acme.test')).toBeUndefined();
    expect((await refusalDetails(p.slug))[0]).toMatch(/signature verification failed/);
  });

  it('refuses a nonce mismatch and a token minted for another client (aud)', async () => {
    const p = await provider();
    const badNonce = await signIn(p.slug, { claims: { sub: 'u-nonce', email: 'nonce@acme.test' }, nonce: 'replayed-nonce' });
    expect(badNonce.authError).toBe('exchange');
    const badAud = await signIn(p.slug, { claims: { sub: 'u-aud', email: 'aud@acme.test' }, aud: 'some-other-client' });
    expect(badAud.authError).toBe('exchange');
    expect(await store.findStoredUserByEmail('nonce@acme.test')).toBeUndefined();
    expect(await store.findStoredUserByEmail('aud@acme.test')).toBeUndefined();
    expect(await auditActions(p.slug)).toEqual(['auth.sso_refused', 'auth.sso_refused']);
    const [nonceDetail, audDetail] = await refusalDetails(p.slug);
    expect(nonceDetail).toMatch(/"nonce"/);
    expect(audDetail).toMatch(/"aud"/);
  });

  describe('returnTo: the page the person opened before signing in', () => {
    const DEEP = '/s/sk-space/p/artifact-34ac74359430e23bd9abd100';

    it('a successful sign-in lands on the exact page, query and fragment included', async () => {
      const p = await provider();
      const returnTo = `${DEEP}?tab=history#section-2`;
      const out = await signIn(p.slug, { startUrl: `/api/auth/oidc/${p.slug}/start?returnTo=${encodeURIComponent(returnTo)}`, claims: { sub: 'u-rt', email: 'rt@acme.test' } });
      expect(out.res.statusCode).toBe(302);
      expect(out.sessionCookie).toBeDefined();
      const location = new URL(String(out.res.headers.location));
      expect(`${location.pathname}${location.search}${location.hash}`).toBe(returnTo);
    });

    it('no returnTo keeps the default landing; it travels next to login_hint', async () => {
      const p = await provider();
      const plain = await signIn(p.slug, { claims: { sub: 'u-rt-plain', email: 'rt-plain@acme.test' } });
      expect(new URL(String(plain.res.headers.location)).pathname).toBe('/');
      const withHint = await signIn(p.slug, { startUrl: `/api/auth/oidc/${p.slug}/start?login_hint=a%40acme.test&returnTo=${encodeURIComponent(DEEP)}`, claims: { sub: 'u-rt-plain', email: 'rt-plain@acme.test' } });
      expect(new URL(String(withHint.res.headers.location)).pathname).toBe(DEEP);
    });

    it('a refusal returns to the same page with authError, so a retry still lands there', async () => {
      const p = await provider({ jitEnabled: false });
      const out = await signIn(p.slug, { startUrl: `/api/auth/oidc/${p.slug}/start?returnTo=${encodeURIComponent(`${DEEP}?tab=history#x`)}`, claims: { sub: 'u-rt-no', email: 'rt-no@acme.test' } });
      const location = new URL(String(out.res.headers.location));
      expect(location.pathname).toBe(DEEP);
      expect(location.searchParams.get('authError')).toBe('no_account');
      expect(location.searchParams.get('tab')).toBe('history');
      expect(location.hash).toBe('#x');
    });

    it.each(['//evil.com', '/\\evil.com', '/\\/evil.com', 'https://evil.com', 'javascript:alert(1)', '/api/auth/state', '/api', '/\t/evil.com', '/\r\nSet-Cookie:x=1', '/login', '/'])(
      'rejects %j: the sign-in works and lands on the default page',
      async (bad) => {
        const p = await provider();
        const out = await signIn(p.slug, { startUrl: `/api/auth/oidc/${p.slug}/start?returnTo=${encodeURIComponent(bad)}`, claims: { sub: `u-bad-${counter}`, email: `bad${counter}@acme.test` } });
        expect(out.res.statusCode).toBe(302);
        const location = new URL(String(out.res.headers.location), 'http://localhost');
        expect(location.hostname).toBe('localhost');
        expect(location.pathname).toBe('/');
        expect(out.sessionCookie).toBeDefined();
      },
    );

    it('a returnTo smuggled into a forged flow cookie is not trusted without the signature', async () => {
      const flow = signFlow({ slug: 'x', state: 's', nonce: 'n', verifier: 'v', mode: 'login', returnTo: '/s/a', exp: Math.floor(Date.now() / 1000) + 60 });
      expect(verifyFlow(flow)?.returnTo).toBe('/s/a');
      const [body, mac] = flow.split('.');
      const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), returnTo: '//evil.com' })).toString('base64url');
      expect(verifyFlow(`${forged}.${mac}`)).toBeNull();
    });
  });

  it('refuses a callback without the flow cookie, or with a tampered one', async () => {
    const p = await provider();
    const noCookie = await app.inject({ method: 'GET', url: `/api/auth/oidc/${p.slug}/callback?code=x&state=y` });
    expect(new URL(noCookie.headers.location as string).searchParams.get('authError')).toBe('state');
    const flow = signFlow({ slug: p.slug, state: 's', nonce: 'n', verifier: 'v', mode: 'login', exp: Math.floor(Date.now() / 1000) + 60 });
    expect(verifyFlow(flow)?.state).toBe('s');
    expect(verifyFlow(flow.replace(/^./, (c) => (c === 'e' ? 'f' : 'e')))).toBeNull();
  });

  it('JIT off: an unknown person is refused ("ask an admin to invite you")', async () => {
    const p = await provider({ jitEnabled: false });
    const out = await signIn(p.slug, { claims: { sub: 'u-nojit', email: 'nojit@acme.test' } });
    expect(out.authError).toBe('no_account');
    expect(await store.findStoredUserByEmail('nojit@acme.test')).toBeUndefined();
  });

  it('links an existing account only with a verified email in an allowed domain', async () => {
    const p = await provider({ jitEnabled: false });
    const existing = await store.createUser({ email: 'linkme@acme.test', name: 'Link Me', isAdmin: false, passwordHash: 'x' });

    const unverified = await signIn(p.slug, { claims: { sub: 'u-link', email: 'linkme@acme.test', email_verified: false } });
    expect(unverified.authError).toBe('link_unverified');
    expect(await providers.findIdentity(ISSUER, 'u-link')).toBeUndefined();

    const verified = await signIn(p.slug, { claims: { sub: 'u-link', email: 'LinkMe@acme.test' } });
    expect(verified.authError).toBeNull();
    expect((await whoAmI(verified.sessionCookie))?.id).toBe(existing.id);
    expect((await providers.findIdentity(ISSUER, 'u-link'))?.userId).toBe(existing.id);
    expect(await auditActions(p.slug)).toEqual(['auth.sso_refused', 'auth.sso_link']);

    // A different subject at the same provider claiming the same email: the account already has an identity there.
    const second = await signIn(p.slug, { claims: { sub: 'u-link-2', email: 'linkme@acme.test' } });
    expect(second.authError).toBe('already_linked');
  });

  it('never links when the email domain is not in the allowed domains (an open JIT provider)', async () => {
    const p = await provider({ allowedDomains: [], jitEnabled: true });
    await store.createUser({ email: 'victim@elsewhere.test', name: 'Victim', isAdmin: false, passwordHash: 'x' });
    const out = await signIn(p.slug, { claims: { sub: 'u-takeover', email: 'victim@elsewhere.test' } });
    expect(out.authError).toBe('link_domain');
    expect(await providers.findIdentity(ISSUER, 'u-takeover')).toBeUndefined();

    // ...while a brand-new email is created (the list is empty, so no domain gate).
    const fresh = await signIn(p.slug, { claims: { sub: 'u-open', email: 'someone@elsewhere.test' } });
    expect(fresh.authError).toBeNull();
  });

  it('a non-empty allowed-domains list gates every sign-in', async () => {
    const p = await provider();
    const out = await signIn(p.slug, { claims: { sub: 'u-out', email: 'outsider@gmail.test' } });
    expect(out.authError).toBe('domain');
  });

  it('refuses a disabled account', async () => {
    const p = await provider();
    const first = await signIn(p.slug, { claims: { sub: 'u-dis', email: 'disabled@acme.test' } });
    const me = await whoAmI(first.sessionCookie);
    await store.updateUser(me!.id, { disabled: true });
    const out = await signIn(p.slug, { claims: { sub: 'u-dis', email: 'disabled@acme.test' } });
    expect(out.authError).toBe('disabled');
    expect(out.sessionCookie).toBeUndefined();
  });

  describe('enforced single sign-on', () => {
    let enforced: providers.AuthProvider;

    beforeAll(async () => {
      enforced = await provider({ slug: 'corp', allowedDomains: ['corp.test'], jitEnabled: false, enforceSso: true });
    });

    it('the login page learns where an email goes', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/sso/discover', payload: { email: 'anyone@CORP.test' } });
      expect(res.json()).toEqual({ provider: { slug: 'corp', name: enforced.displayName, kind: 'oidc' }, enforced: true });
      const none = await app.inject({ method: 'POST', url: '/api/auth/sso/discover', payload: { email: 'x@nowhere.test' } });
      expect(none.json()).toEqual({ provider: null, enforced: false });
    });

    it('refuses a password sign-in for the domain, even with the right password', async () => {
      await store.createUser({ email: 'pw@corp.test', name: 'PW', isAdmin: false, passwordHash: await hashPassword('right-password') });
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'pw@corp.test', password: 'right-password' } });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('sso_required');
      const local = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'pw@corp.test', password: 'right-password', local: true } });
      expect(local.statusCode).toBe(403);
    });

    it('break-glass: an instance admin signs in with a password only from /login?local, audited', async () => {
      await store.createUser({ email: 'boss@corp.test', name: 'Boss', isAdmin: true, passwordHash: await hashPassword('boss-password') });
      const plain = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'boss@corp.test', password: 'boss-password' } });
      expect(plain.statusCode).toBe(403);
      const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'boss@corp.test', password: 'nope', local: true } });
      expect(wrong.statusCode).toBe(401);
      const local = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'boss@corp.test', password: 'boss-password', local: true } });
      expect(local.statusCode).toBe(200);
      expect(local.json().user.email).toBe('boss@corp.test');
      expect(await auditActions('corp')).toContain('auth.break_glass_login');
    });

    it('refuses setting a password (admin PATCH) and creating a password account for the domain', async () => {
      const { cookie } = await adminCookie();
      const person = await store.createUser({ email: 'nopw@corp.test', name: 'No PW', isAdmin: false, passwordHash: null });
      const patch = await app.inject({ method: 'PATCH', url: `/api/users/${person.id}`, headers: { cookie }, payload: { password: 'a-new-password' } });
      expect(patch.statusCode).toBe(403);
      expect(patch.json().code).toBe('sso_required');
      const create = await app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { email: 'fresh@corp.test', name: 'Fresh', password: 'a-password!' } });
      expect(create.statusCode).toBe(403);
    });

    it('an invite pinned to the domain is accepted through the provider, not with a password', async () => {
      const { admin } = await adminCookie();
      const invite = await invites.createInvite({ memberships: [{ space, role: 'viewer' }], isAdmin: false, expiresInDays: 7, maxUses: 1, email: 'invited@corp.test' }, admin.id, 'http://localhost');
      const token = invite.url.split('/').pop()!;

      const info = await app.inject({ method: 'GET', url: `/api/invite/${token}` });
      expect(info.json().sso).toEqual({ slug: 'corp', name: enforced.displayName, kind: 'oidc', enforced: true });

      const withPassword = await app.inject({
        method: 'POST',
        url: `/api/invite/${token}/accept`,
        payload: { name: 'Invited', email: 'invited@corp.test', password: 'a-password!', username: 'invited' },
      });
      expect(withPassword.statusCode).toBe(403);
      expect(withPassword.json().code).toBe('sso_required');

      // JIT is off for this provider, so without the invite the same person is refused...
      const noInvite = await signIn('corp', { claims: { sub: 'u-inv', email: 'invited@corp.test' } });
      expect(noInvite.authError).toBe('no_account');
      // ...and with it, the account is created with the invite's access, and the invite is used up.
      const viaInvite = await signIn('corp', { startUrl: `/api/auth/oidc/corp/start?invite=${token}`, claims: { sub: 'u-inv', email: 'invited@corp.test' } });
      expect(viaInvite.authError).toBeNull();
      const me = await whoAmI(viaInvite.sessionCookie);
      expect(me?.email).toBe('invited@corp.test');
      expect(await store.getMembershipRole(space, me!.id)).toBe('viewer');
      expect(invites.invalidReason(await invites.getInviteByToken(token))).toBe('exhausted');
      expect((await store.findStoredUserByEmail('invited@corp.test'))?.passwordHash).toBeNull();
    });

    it('an invite pinned to another email cannot be used by a different SSO account', async () => {
      const { admin } = await adminCookie();
      const invite = await invites.createInvite({ memberships: [], isAdmin: false, expiresInDays: 7, maxUses: 1, email: 'pinned@corp.test' }, admin.id, 'http://localhost');
      const token = invite.url.split('/').pop()!;
      const out = await signIn('corp', { startUrl: `/api/auth/oidc/corp/start?invite=${token}`, claims: { sub: 'u-other', email: 'other@corp.test' } });
      expect(out.authError).toBe('invite_email');
    });
  });

  it('"Test connection": an admin gets the claims back, nothing is created or linked', async () => {
    const p = await provider({ enabled: false });
    const { cookie } = await adminCookie();
    const anonymous = await app.inject({ method: 'GET', url: `/api/auth/oidc/${p.slug}/start?test=1` });
    expect(anonymous.statusCode).toBe(403);

    const out = await signIn(p.slug, { startUrl: `/api/auth/oidc/${p.slug}/start?test=1`, cookie, claims: { sub: 'u-test', email: 'tester@acme.test', groups: ['g1'] } });
    expect(out.res.statusCode).toBe(200);
    expect(out.res.headers['content-type']).toContain('text/html');
    expect(out.res.body).toContain('tester@acme.test');
    expect(out.res.body).toContain('folio-sso-test');
    expect(out.sessionCookie).toBeUndefined();
    expect(await store.findStoredUserByEmail('tester@acme.test')).toBeUndefined();
    expect(await providers.findIdentity(ISSUER, 'u-test')).toBeUndefined();
  });

  it('"Test connection" popup speaks the admin\'s language (Ukrainian), and a single-string groups claim is shown as a list', async () => {
    const p = await provider({ enabled: false });
    const { admin, cookie } = await adminCookie();
    await store.updateUserLang(admin.id, 'uk');
    const out = await signIn(p.slug, { startUrl: `/api/auth/oidc/${p.slug}/start?test=1`, cookie, claims: { sub: 'u-test-uk', email: 'tester-uk@acme.test', groups: 'sales' } });
    expect(out.res.statusCode).toBe(200);
    expect(out.res.body).toContain('\u041f\u0456\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u043d\u044f \u043f\u0440\u0430\u0446\u044e\u0454' /* Ukrainian: the test popup is localized */);
    expect(out.res.body).not.toContain('Connection works');
    expect(out.res.body).toMatch(/&quot;groups&quot;: \[\s*&quot;sales&quot;\s*\]/);
  });

  it('admin API: the client secret is stored encrypted and never returned', async () => {
    const { cookie } = await adminCookie();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/providers',
      headers: { cookie },
      payload: { slug: 'authentik', displayName: 'Authentik', issuer: 'https://op.test', clientId: 'folio', clientSecret: 'top-secret-value', allowedDomains: ['Example.TEST'] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain('top-secret-value');
    expect(res.json()).toMatchObject({ slug: 'authentik', hasClientSecret: true, allowedDomains: ['example.test'], source: 'db' });
    expect(res.json().redirectUri).toMatch(/\/api\/auth\/oidc\/authentik\/callback$/);
    const row = await queryOne<{ client_secret_enc: Buffer }>('SELECT client_secret_enc FROM auth_providers WHERE slug = $1', ['authentik']);
    expect(row!.client_secret_enc.toString('utf8')).not.toContain('top-secret-value');
    const list = await app.inject({ method: 'GET', url: '/api/admin/auth/providers', headers: { cookie } });
    expect(list.body).not.toContain('top-secret-value');

    const cleared = await app.inject({ method: 'PATCH', url: `/api/admin/auth/providers/${res.json().id}`, headers: { cookie }, payload: { clientSecret: '', enabled: false } });
    expect(cleared.json()).toMatchObject({ hasClientSecret: false, enabled: false });
    const del = await app.inject({ method: 'DELETE', url: `/api/admin/auth/providers/${res.json().id}`, headers: { cookie } });
    expect(del.statusCode).toBe(200);

    const nonAdmin = await store.createUser({ email: 'plain@acme.test', name: 'Plain', isAdmin: false, passwordHash: 'x' });
    const plainCookie = `${session.SESSION_COOKIE_NAME}=${(await store.createSession(nonAdmin.id)).token}`;
    expect((await app.inject({ method: 'GET', url: '/api/admin/auth/providers', headers: { cookie: plainCookie } })).statusCode).toBe(403);
  });

  it('Google from GOOGLE_* env: existing google_sub accounts (migration 054) keep signing in, now with a verified id_token', async () => {
    // An account from before SSO: users.google_sub set, no identity yet — then migration 054's data step.
    const legacy = await store.createUser({ email: 'old.google@acme.test', name: 'Old Google', isAdmin: false, passwordHash: null });
    await query('UPDATE users SET google_sub = $1 WHERE id = $2', ['g-legacy-sub', legacy.id]);
    const sql = await readFile(path.join(import.meta.dirname, '../../db/migrations/054_auth_providers.sql'), 'utf8');
    await query(sql.slice(sql.indexOf('INSERT INTO auth_providers')));
    expect((await providers.findIdentity(GOOGLE, 'g-legacy-sub'))?.userId).toBe(legacy.id);

    process.env.GOOGLE_CLIENT_ID = 'google-client';
    process.env.GOOGLE_CLIENT_SECRET = 'google-secret';
    process.env.GOOGLE_ALLOWED_DOMAINS = 'acme.test';
    providers.__resetProviderSyncForTests();
    await providers.syncEnvProviders();
    const google = await providers.getProviderBySlug('google');
    expect(google).toMatchObject({ source: 'env', enabled: true, legacyGoogle: true, jitEnabled: true, allowedDomains: ['acme.test'] });

    const out = await signIn('google', {
      issuer: GOOGLE,
      startUrl: '/api/auth/google/start',
      claims: { sub: 'g-legacy-sub', email: 'old.google@acme.test', hd: 'acme.test' },
    });
    expect(out.authError).toBeNull();
    expect((await whoAmI(out.sessionCookie))?.id).toBe(legacy.id);

    const state = await app.inject({ method: 'GET', url: '/api/auth/state' });
    expect(state.json().google).toBe(true);
    expect(state.json().ssoProviders).toEqual(expect.arrayContaining([{ slug: 'google', name: 'Google', kind: 'oidc' }]));

    // The variables gone: the provider is disabled (its identities stay).
    delete process.env.GOOGLE_CLIENT_ID;
    providers.__resetProviderSyncForTests();
    await providers.syncEnvProviders();
    expect((await providers.getProviderBySlug('google'))?.enabled).toBe(false);
    expect(await providers.findIdentity(GOOGLE, 'g-legacy-sub')).toBeDefined();
  });
});

describe('mapClaims / env parsing (pure)', () => {
  it('maps custom and dotted claim paths, and falls back to given/family name', () => {
    const m = mapClaims(
      { sub: 's', upn: 'Person@Corp.Test', given_name: 'Ann', family_name: 'Lee', realm_access: { roles: ['a', 'b'] }, email_verified: 'true' },
      { email: 'upn', name: 'name', groups: 'realm_access.roles' },
    );
    expect(m).toMatchObject({ subject: 's', email: 'person@corp.test', name: 'Ann Lee', groups: ['a', 'b'], emailVerified: true, emailUnverifiedExplicitly: false });
  });

  it('reads FOLIO_OIDC_<SLUG>_* and the legacy GOOGLE_* pair', () => {
    const env = {
      FOLIO_OIDC_MY_IDP_ISSUER: 'https://idp.test/realms/x',
      FOLIO_OIDC_MY_IDP_CLIENT_ID: 'folio',
      FOLIO_OIDC_MY_IDP_CLIENT_SECRET: 'sec',
      FOLIO_OIDC_MY_IDP_NAME: 'My IdP',
      FOLIO_OIDC_MY_IDP_DOMAINS: 'A.test, @b.test',
      FOLIO_OIDC_MY_IDP_JIT: 'true',
      FOLIO_OIDC_MY_IDP_JIT_SPACES: 'docs:editor,eng',
      FOLIO_OIDC_MY_IDP_ENFORCE: '1',
      FOLIO_OIDC_BROKEN_ISSUER: 'https://no-client-id.test',
      GOOGLE_CLIENT_ID: 'gid',
      GOOGLE_CLIENT_SECRET: 'gsec',
      GOOGLE_ALLOWED_DOMAINS: '',
    };
    const out = providers.readEnvProviders(env);
    expect(out.get('my-idp')).toMatchObject({
      displayName: 'My IdP',
      allowedDomains: ['a.test', 'b.test'],
      jitEnabled: true,
      enforceSso: true,
      jitDefaultSpaces: { docs: 'editor', eng: 'viewer' },
      legacyGoogle: false,
    });
    expect(out.has('broken')).toBe(false);
    // An empty GOOGLE_ALLOWED_DOMAINS lets nobody new in, as before.
    expect(out.get('google')).toMatchObject({ legacyGoogle: true, jitEnabled: false, allowedDomains: [] });
  });
});
