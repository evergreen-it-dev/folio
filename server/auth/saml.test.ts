/**
 * Single sign-on through SAML 2.0 end to end, without a real IdP: samlTestIdp.ts makes a key + self-signed
 * certificate and signs Responses the way Entra ID / Okta / Keycloak do. The Fastify app runs the real routes
 * against a real (per-run schema) PostgreSQL: start -> the IdP's SSO URL with a deflated AuthnRequest (its ID and
 * the RelayState read back from it) -> a signed Response POSTed to the ACS with the flow cookie.
 */
import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setUpTestSchema, deleteTestSpace } from '../db/testSchema.js';
import { query } from '../db/pool.js';
import { HttpError } from '../errors.js';
import * as storage from '../storage.js';
import * as groupStore from '../groups/store.js';
import { hashPassword } from './passwords.js';
import * as store from './store.js';
import * as session from './session.js';
import * as providers from './providers.js';
import { registerOidcRoutes } from './oidc.js';
import { __setSamlFetchForTests, mapSamlProfile, registerSamlRoutes, samlSpFor, signSamlFlow, verifySamlFlow } from './saml.js';
import { parseCertificates, parseIdpMetadata } from './samlConfig.js';
import { registerProtectedAuthRoutes, registerPublicAuthRoutes } from './routes.js';
import { registerAuthProviderRoutes } from './providerRoutes.js';
import { buildSamlResponse, decodeRedirectRequest, encodeResponse, idpMetadataXml, makeTestKey, type ResponseOptions, type TestKey } from './samlTestIdp.js';

const IDP = 'https://idp.test/saml';
const SSO_URL = 'https://idp.test/sso';
const ORIGIN = 'http://localhost';
const EMAIL_URI = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress';
const GROUPS_URI = 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups';

function cookieFrom(setCookie: string | string[] | undefined, name: string): string | undefined {
  const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const hit = all.find((c) => c.startsWith(`${name}=`));
  if (!hit) return undefined;
  const value = hit.split(';')[0].slice(name.length + 1);
  return value ? `${name}=${value}` : undefined;
}

describe('single sign-on through SAML 2.0 (test IdP, real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let space: string;
  let key: TestKey;
  let foreignKey: TestKey;
  const metadataByUrl = new Map<string, string>();

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    process.env.FOLIO_SECRET = 'saml-test-secret';
    key = makeTestKey();
    foreignKey = makeTestKey('Someone Else');
    __setSamlFetchForTests(async (url) => {
      const body = metadataByUrl.get(url);
      return body ? new Response(body, { status: 200, headers: { 'content-type': 'application/samlmetadata+xml' } }) : new Response('nope', { status: 404 });
    });
    space = (await storage.createSpace(`SAML Test ${Date.now()}`, null)).slug;

    const a = Fastify();
    a.decorateRequest('authUser', null);
    a.setErrorHandler((err, _request, reply) => {
      if (err instanceof HttpError) return reply.status(err.status).send(err.code ? { error: err.message, code: err.code } : { error: err.message });
      return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
    });
    await a.register(fastifyCookieModule.default);
    registerPublicAuthRoutes(a);
    registerOidcRoutes(a);
    registerSamlRoutes(a);
    await a.register(async (scope) => {
      scope.addHook('onRequest', session.requireSession);
      registerProtectedAuthRoutes(scope);
      registerAuthProviderRoutes(scope);
    });
    await a.ready();
    app = a;
  }, 60_000); // migrations on a fresh schema + two RSA keys: slow on a busy machine

  afterAll(async () => {
    __setSamlFetchForTests(undefined);
    await app?.close();
    await deleteTestSpace(space).catch(() => {});
    await teardownSchema();
    delete process.env.FOLIO_SECRET;
  });

  beforeEach(() => {
    session.__resetLoginRateLimitForTests();
  });

  let counter = 0;
  async function provider(overrides: Partial<providers.ProviderInput> = {}, saml: providers.ProviderInput['saml'] = {}): Promise<providers.AuthProvider> {
    counter += 1;
    return providers.createProvider({
      kind: 'saml',
      slug: `saml${counter}`,
      displayName: `Corp SAML ${counter}`,
      allowedDomains: ['acme.test'],
      jitEnabled: true,
      saml: { idpEntityId: IDP, ssoUrl: SSO_URL, idpCert: key.cert, ...saml },
      ...overrides,
    });
  }

  // app.inject's origin is http://localhost (PUBLIC_URL wins when set) — the default SP entity ID / ACS URL.
  const spEntityId = (slug: string) => samlSpFor({ slug, saml: null }, ORIGIN).entityId;
  const acsUrl = (slug: string) => samlSpFor({ slug, saml: null }, ORIGIN).acsUrl;

  async function start(slug: string, opts: { query?: string; cookie?: string } = {}) {
    const res = await app.inject({ method: 'GET', url: `/api/auth/saml/${slug}/start${opts.query ?? ''}`, headers: opts.cookie ? { cookie: opts.cookie } : {} });
    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    expect(location.startsWith(SSO_URL)).toBe(true);
    const request = decodeRedirectRequest(location);
    return { request, flowCookie: cookieFrom(res.headers['set-cookie'], 'folio_saml')! };
  }

  async function postAcs(slug: string, samlResponse: string, opts: { cookie?: string; relayState?: string } = {}) {
    const form = new URLSearchParams({ SAMLResponse: samlResponse, ...(opts.relayState !== undefined ? { RelayState: opts.relayState } : {}) });
    const res = await app.inject({
      method: 'POST',
      url: `/api/auth/saml/${slug}/acs`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(opts.cookie ? { cookie: opts.cookie } : {}) },
      payload: form.toString(),
    });
    const location = String(res.headers.location ?? '');
    const authError = location ? new URL(location).searchParams.get('authError') : null;
    return { res, authError, sessionCookie: cookieFrom(res.headers['set-cookie'], session.SESSION_COOKIE_NAME) };
  }

  type SignInOptions = Partial<Omit<ResponseOptions, 'key'>> & { key?: TestKey; startQuery?: string; cookie?: string; relayState?: string };

  /** start -> (the IdP) -> ACS. */
  async function signIn(slug: string, opts: SignInOptions = {}) {
    const { request, flowCookie } = await start(slug, { query: opts.startQuery, cookie: opts.cookie });
    const xml = buildSamlResponse({
      idpEntityId: IDP,
      audience: spEntityId(slug),
      acsUrl: acsUrl(slug),
      nameId: 'nameid-default',
      inResponseTo: request.id,
      ...opts,
      key: opts.key ?? key,
    });
    const encoded = encodeResponse(xml);
    const out = await postAcs(slug, encoded, { cookie: [flowCookie, opts.cookie].filter(Boolean).join('; '), relayState: opts.relayState ?? request.relayState ?? '' });
    return { ...out, encoded, flowCookie, request };
  }

  async function whoAmI(cookie: string | undefined) {
    const res = await app.inject({ method: 'GET', url: '/api/auth/state', headers: cookie ? { cookie } : {} });
    return res.json().user as { id: string; email: string; isAdmin: boolean } | null;
  }

  async function refusals(target: string): Promise<Array<{ reason?: string; detail?: string }>> {
    await new Promise((r) => setTimeout(r, 30)); // recordAudit is fire-and-forget
    const rows = await query<{ meta: { reason?: string; detail?: string } }>("SELECT meta FROM audit_log WHERE target = $1 AND action = 'auth.sso_refused' ORDER BY id", [target]);
    return rows.map((r) => r.meta);
  }

  async function auditActions(target: string): Promise<string[]> {
    await new Promise((r) => setTimeout(r, 30));
    const rows = await query<{ action: string }>('SELECT action FROM audit_log WHERE target = $1 ORDER BY id', [target]);
    return rows.map((r) => r.action);
  }

  async function adminCookie(email = `admin-${randomBytes(3).toString('hex')}@admins.test`) {
    const admin = await store.createUser({ email, name: 'Admin', isAdmin: true, passwordHash: await hashPassword('admin-password') });
    return { admin, cookie: `${session.SESSION_COOKIE_NAME}=${(await store.createSession(admin.id)).token}` };
  }

  // -------------------------------------------------------------------------

  it('JIT: a signed assertion signs a new person in (Entra-style attributes), stores the raw groups, then finds them by NameID', async () => {
    const p = await provider({ jitDefaultSpaces: { [space]: 'editor' } });
    const out = await signIn(p.slug, {
      nameId: 'entra-object-id-1',
      attributes: { [EMAIL_URI]: 'New.Person@acme.test', 'http://schemas.microsoft.com/identity/claims/displayname': 'New Person', [GROUPS_URI]: ['g-eng', 'g-all'] },
    });
    expect(out.authError).toBeNull();
    expect(out.res.statusCode).toBe(302);
    const me = await whoAmI(out.sessionCookie);
    expect(me?.email).toBe('new.person@acme.test');
    expect(me?.isAdmin).toBe(false);
    expect((await store.findStoredUserByEmail('new.person@acme.test'))?.name).toBe('New Person');
    expect(await store.getMembershipRole(space, me!.id)).toBe('editor');
    const identity = await providers.findIdentity(IDP, 'entra-object-id-1');
    expect(identity?.userId).toBe(me!.id);
    expect(identity?.groups).toEqual(['g-eng', 'g-all']);

    const again = await signIn(p.slug, { nameId: 'entra-object-id-1', attributes: { [EMAIL_URI]: 'new.person@acme.test', [GROUPS_URI]: 'g-eng' } });
    expect((await whoAmI(again.sessionCookie))?.id).toBe(me!.id);
    // A single value arrives as a bare string; it is stored as a one-element list, like OIDC's.
    expect((await providers.findIdentity(IDP, 'entra-object-id-1'))?.groups).toEqual(['g-eng']);
    const actions = await auditActions(p.slug);
    expect(actions).toContain('auth.sso_jit_create');
    expect(actions).toContain('auth.sso_login');
  });

  describe('returnTo: the page the person opened before signing in', () => {
    const DEEP = '/s/sk-space/p/artifact-34ac74359430e23bd9abd100';
    const q = (returnTo: string) => `?returnTo=${encodeURIComponent(returnTo)}`;
    let n = 0;

    it('a successful sign-in lands on the exact page, query and fragment included; without it, on the root', async () => {
      const p = await provider();
      const returnTo = `${DEEP}?tab=history#section-2`;
      const out = await signIn(p.slug, { startQuery: q(returnTo), nameId: 'u-rt', attributes: { email: 'rt@acme.test' } });
      expect(out.authError).toBeNull();
      expect(out.sessionCookie).toBeDefined();
      const location = new URL(String(out.res.headers.location));
      expect(`${location.pathname}${location.search}${location.hash}`).toBe(returnTo);

      const plain = await signIn(p.slug, { nameId: 'u-rt', attributes: { email: 'rt@acme.test' } });
      expect(new URL(String(plain.res.headers.location)).pathname).toBe('/');
    });

    it('a refusal returns to the same page with authError, so a retry still lands there', async () => {
      const p = await provider({ jitEnabled: false });
      const out = await signIn(p.slug, { startQuery: q(`${DEEP}?tab=history#x`), nameId: 'u-rt-no', attributes: { email: 'rt-no@acme.test' } });
      expect(out.authError).toBe('no_account');
      const location = new URL(String(out.res.headers.location));
      expect(location.pathname).toBe(DEEP);
      expect(location.searchParams.get('tab')).toBe('history');
      expect(location.hash).toBe('#x');
    });

    it.each(['//evil.com', '/\\evil.com', '/\\/evil.com', 'https://evil.com', 'javascript:alert(1)', '/api/auth/state', '/api', '/\t/evil.com', '/\r\nSet-Cookie:x=1', '/login', '/'])(
      'rejects %j: the sign-in works and lands on the default page',
      async (bad) => {
        const p = await provider();
        n += 1;
        const out = await signIn(p.slug, { startQuery: q(bad), nameId: `u-bad-${n}`, attributes: { email: `bad${n}@acme.test` } });
        expect(out.res.statusCode).toBe(302);
        const location = new URL(String(out.res.headers.location), 'http://localhost');
        expect(location.hostname).toBe('localhost');
        expect(location.pathname).toBe('/');
        expect(out.sessionCookie).toBeDefined();
      },
    );
  });

  it('group sync: the SAML groups attribute becomes Folio group memberships at every sign-in, mapped through the table', async () => {
    const admin = (await adminCookie()).admin;
    const eng = await groupStore.createGroup({ slug: `saml-eng-${counter}`, name: `SAML Eng ${counter}`, description: '' }, admin.id);
    const ops = await groupStore.createGroup({ slug: `saml-ops-${counter}`, name: `SAML Ops ${counter}`, description: '' }, admin.id);
    const p = await provider({ groupSync: { enabled: true, mode: 'mapping', mapping: { 'g-eng-guid': eng.slug, 'g-ops-guid': ops.slug }, createMissing: false, allow: '' } });
    const memberSlugs = async (userId: string) =>
      (await query<{ slug: string; source: string }>('SELECT g.slug, gm.source FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = $1 ORDER BY g.slug', [userId])).map((r) => `${r.slug}:${r.source}`);

    const first = await signIn(p.slug, { nameId: 'gs-saml-1', attributes: { [EMAIL_URI]: 'saml.groups@acme.test', [GROUPS_URI]: ['g-eng-guid', 'g-ops-guid', 'g-unmapped'] } });
    expect(first.authError).toBeNull();
    const me = (await whoAmI(first.sessionCookie))!;
    expect(await memberSlugs(me.id)).toEqual([`${eng.slug}:saml`, `${ops.slug}:saml`].sort());

    // A single value (the IdP sent one attribute value) leaves only that membership.
    await signIn(p.slug, { nameId: 'gs-saml-1', attributes: { [EMAIL_URI]: 'saml.groups@acme.test', [GROUPS_URI]: 'g-ops-guid' } });
    expect(await memberSlugs(me.id)).toEqual([`${ops.slug}:saml`]);
    const actions = await auditActions(p.slug);
    expect(actions.filter((a) => a === 'auth.group_sync')).toHaveLength(2);
  });

  it('refuses an unsigned assertion, and an unsigned assertion inside a signed Response', async () => {
    const p = await provider();
    const none = await signIn(p.slug, { nameId: 'u-unsigned', sign: 'none', attributes: { email: 'unsigned@acme.test' } });
    expect(none.authError).toBe('exchange');
    const outerOnly = await signIn(p.slug, { nameId: 'u-outer', sign: 'response', attributes: { email: 'outer@acme.test' } });
    expect(outerOnly.authError).toBe('exchange');
    // Keycloak's default: the Response AND the assertion signed — accepted.
    const both = await signIn(p.slug, { nameId: 'u-both', sign: 'both', attributes: { email: 'both@acme.test' } });
    expect(both.authError).toBeNull();
    expect(await store.findStoredUserByEmail('unsigned@acme.test')).toBeUndefined();
    expect(await store.findStoredUserByEmail('outer@acme.test')).toBeUndefined();
    const details = await refusals(p.slug);
    expect(details).toHaveLength(2);
    expect(details[0].detail).toMatch(/signature/i);
    expect(details[1].detail).toMatch(/signature/i);
  });

  it('refuses an assertion signed by a key that is not the IdP certificate', async () => {
    const p = await provider();
    const out = await signIn(p.slug, { nameId: 'u-forged', key: foreignKey, attributes: { email: 'forged@acme.test' } });
    expect(out.authError).toBe('exchange');
    expect(out.sessionCookie).toBeUndefined();
    expect(await store.findStoredUserByEmail('forged@acme.test')).toBeUndefined();
  });

  it('refuses a wrong audience and a wrong assertion Issuer', async () => {
    const p = await provider();
    const aud = await signIn(p.slug, { nameId: 'u-aud', audience: 'https://other-sp.test/metadata', attributes: { email: 'aud@acme.test' } });
    expect(aud.authError).toBe('exchange');
    const iss = await signIn(p.slug, { nameId: 'u-iss', assertionIssuer: 'https://evil-idp.test', attributes: { email: 'iss@acme.test' } });
    expect(iss.authError).toBe('exchange');
    const [audDetail, issDetail] = await refusals(p.slug);
    expect(audDetail.detail).toMatch(/audience/i);
    expect(issDetail.detail).toMatch(/Issuer/);
  });

  it('enforces NotBefore / NotOnOrAfter with at most 120 s of skew', async () => {
    const p = await provider();
    const expired = await signIn(p.slug, { nameId: 'u-exp', notBeforeSec: -900, notOnOrAfterSec: -300, attributes: { email: 'exp@acme.test' } });
    expect(expired.authError).toBe('exchange');
    const early = await signIn(p.slug, { nameId: 'u-early', notBeforeSec: 300, notOnOrAfterSec: 900, attributes: { email: 'early@acme.test' } });
    expect(early.authError).toBe('exchange');
    // 60 s past NotOnOrAfter: inside the skew.
    const skewed = await signIn(p.slug, { nameId: 'u-skew', notBeforeSec: -600, notOnOrAfterSec: -60, attributes: { email: 'skew@acme.test' } });
    expect(skewed.authError).toBeNull();
  });

  it('refuses an InResponseTo that is not this browser’s request, a RelayState mismatch, and an unsolicited response', async () => {
    const p = await provider();
    const mismatch = await signIn(p.slug, { nameId: 'u-irt', inResponseTo: '_someone-elses-request', attributes: { email: 'irt@acme.test' } });
    expect(mismatch.authError).toBe('exchange');
    expect((await refusals(p.slug))[0].detail).toMatch(/InResponseTo/);

    const relay = await signIn(p.slug, { nameId: 'u-relay', relayState: 'tampered', attributes: { email: 'relay@acme.test' } });
    expect(relay.authError).toBe('state');

    // IdP-initiated: no AuthnRequest, no flow cookie, no InResponseTo.
    const xml = buildSamlResponse({ idpEntityId: IDP, audience: spEntityId(p.slug), acsUrl: acsUrl(p.slug), nameId: 'u-unsolicited', inResponseTo: null, key, attributes: { email: 'unsolicited@acme.test' } });
    const unsolicited = await postAcs(p.slug, encodeResponse(xml));
    expect(unsolicited.authError).toBe('state');
    expect(await store.findStoredUserByEmail('unsolicited@acme.test')).toBeUndefined();

    // A flow cookie with a response that omits InResponseTo (validateInResponseTo: always).
    const { request, flowCookie } = await start(p.slug);
    const noIrt = await postAcs(p.slug, encodeResponse(buildSamlResponse({ idpEntityId: IDP, audience: spEntityId(p.slug), acsUrl: acsUrl(p.slug), nameId: 'u-noirt', inResponseTo: null, key, attributes: { email: 'noirt@acme.test' } })), {
      cookie: flowCookie,
      relayState: request.relayState ?? '',
    });
    expect(noIrt.authError).toBe('exchange');
  });

  it('accepts an IdP-initiated response only when the provider allows it', async () => {
    const p = await provider({}, { allowIdpInitiated: true });
    const xml = buildSamlResponse({ idpEntityId: IDP, audience: spEntityId(p.slug), acsUrl: acsUrl(p.slug), nameId: 'u-idp-init', inResponseTo: null, key, attributes: { email: 'idpinit@acme.test' } });
    const out = await postAcs(p.slug, encodeResponse(xml), { relayState: '' });
    expect(out.authError).toBeNull();
    expect((await whoAmI(out.sessionCookie))?.email).toBe('idpinit@acme.test');
    // ...but still never an InResponseTo nobody issued.
    const forged = buildSamlResponse({ idpEntityId: IDP, audience: spEntityId(p.slug), acsUrl: acsUrl(p.slug), nameId: 'u-idp-init-2', inResponseTo: '_made-up', key, attributes: { email: 'idpinit2@acme.test' } });
    expect((await postAcs(p.slug, encodeResponse(forged))).authError).toBe('exchange');
  });

  it('refuses a replayed assertion (same assertion ID), even with the original flow cookie', async () => {
    const p = await provider();
    const first = await signIn(p.slug, { nameId: 'u-replay', attributes: { email: 'replay@acme.test' } });
    expect(first.authError).toBeNull();
    const replay = await postAcs(p.slug, first.encoded, { cookie: first.flowCookie, relayState: first.request.relayState ?? '' });
    expect(replay.authError).toBe('replay');
    expect(replay.sessionCookie).toBeUndefined();
    expect((await refusals(p.slug)).at(-1)?.reason).toBe('replay');
  });

  it('refuses a response carrying a DOCTYPE / ENTITY declaration', async () => {
    const p = await provider();
    const out = await signIn(p.slug, {
      nameId: 'u-xxe',
      attributes: { email: 'xxe@acme.test' },
      prolog: '<?xml version="1.0"?><!DOCTYPE samlp:Response [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>',
    });
    expect(out.authError).toBe('exchange');
    expect((await refusals(p.slug))[0].detail).toMatch(/DOCTYPE/);
    await expect(parseIdpMetadata('<!DOCTYPE x [<!ENTITY a "b">]>' + idpMetadataXml(IDP, SSO_URL, key.certBase64))).rejects.toThrow(/DOCTYPE/);
  });

  it('refuses a transient NameID (it could never find the account again)', async () => {
    const p = await provider();
    const out = await signIn(p.slug, { nameId: 'tmp-123', nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient', attributes: { email: 'transient@acme.test' } });
    expect(out.authError).toBe('exchange');
  });

  it('linking follows the OIDC rules: only an email the IdP is authoritative for, in an allowed domain, not yet linked', async () => {
    const plain = await provider({ jitEnabled: false });
    const existing = await store.createUser({ email: 'linkme@acme.test', name: 'Link Me', isAdmin: false, passwordHash: 'x' });
    const notAuthoritative = await signIn(plain.slug, { nameId: 'u-link', attributes: { email: 'linkme@acme.test' } });
    // SAML has no "email verified" flag: a different reason (and message) than OIDC's link_unverified.
    expect(notAuthoritative.authError).toBe('link_not_authoritative');
    await auditActions(plain.slug); // lets the fire-and-forget audit write land
    expect((await query<{ meta: { reason: string } }>("SELECT meta FROM audit_log WHERE action = 'auth.sso_refused' AND target = $1", [plain.slug])).some((r) => r.meta.reason === 'link_not_authoritative')).toBe(true);
    expect(await providers.findIdentity(IDP, 'u-link')).toBeUndefined();

    const authoritative = await provider({ jitEnabled: false }, { emailAuthoritative: true });
    // The email may also come from an email-format NameID.
    const linked = await signIn(authoritative.slug, { nameId: 'LinkMe@acme.test', nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' });
    expect(linked.authError).toBeNull();
    expect((await whoAmI(linked.sessionCookie))?.id).toBe(existing.id);
    expect(await auditActions(authoritative.slug)).toEqual(['auth.sso_link']);

    const second = await signIn(authoritative.slug, { nameId: 'u-link-other', attributes: { email: 'linkme@acme.test' } });
    expect(second.authError).toBe('already_linked');

    // Authoritative but no domain list: nothing counts as verified, so nothing is linked.
    const open = await provider({ allowedDomains: [], jitEnabled: true }, { emailAuthoritative: true });
    await store.createUser({ email: 'victim@elsewhere.test', name: 'Victim', isAdmin: false, passwordHash: 'x' });
    expect((await signIn(open.slug, { nameId: 'u-takeover', attributes: { email: 'victim@elsewhere.test' } })).authError).toBe('link_not_authoritative');

    // A non-empty allowed-domains list gates every sign-in; a disabled account is refused.
    expect((await signIn(plain.slug, { nameId: 'u-out', attributes: { email: 'outsider@gmail.test' } })).authError).toBe('domain');
    const jit = await provider();
    const created = await signIn(jit.slug, { nameId: 'u-dis', attributes: { email: 'disabled@acme.test' } });
    await query('UPDATE users SET disabled = true WHERE id = $1', [(await whoAmI(created.sessionCookie))!.id]);
    expect((await signIn(jit.slug, { nameId: 'u-dis', attributes: { email: 'disabled@acme.test' } })).authError).toBe('disabled');
  });

  describe('enforced single sign-on through a SAML provider', () => {
    let enforced: providers.AuthProvider;
    beforeAll(async () => {
      enforced = await provider({ slug: 'samlcorp', allowedDomains: ['samlcorp.test'], jitEnabled: false, enforceSso: true });
    });

    it('the login page learns where an email goes, and lists the SAML button', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/sso/discover', payload: { email: 'ann@samlcorp.test' } });
      expect(res.json()).toEqual({ provider: { slug: 'samlcorp', name: enforced.displayName, kind: 'saml' }, enforced: true });
      const state = await app.inject({ method: 'GET', url: '/api/auth/state' });
      expect(state.json().ssoProviders).toContainEqual({ slug: 'samlcorp', name: enforced.displayName, kind: 'saml' });
    });

    it('refuses a password sign-in for the domain; break-glass keeps working for an instance admin', async () => {
      await store.createUser({ email: 'pw@samlcorp.test', name: 'PW', isAdmin: false, passwordHash: await hashPassword('right-password') });
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'pw@samlcorp.test', password: 'right-password' } });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('sso_required');

      await store.createUser({ email: 'boss@samlcorp.test', name: 'Boss', isAdmin: true, passwordHash: await hashPassword('boss-password') });
      const local = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'boss@samlcorp.test', password: 'boss-password', local: true } });
      expect(local.statusCode).toBe(200);
      expect(await auditActions('samlcorp')).toContain('auth.break_glass_login');
    });
  });

  it('"Test connection": an admin gets the attributes back, nothing is created or linked', async () => {
    const p = await provider({ enabled: false });
    const anon = await app.inject({ method: 'GET', url: `/api/auth/saml/${p.slug}/start?test=1` });
    expect(anon.statusCode).toBe(403);
    const { cookie } = await adminCookie();
    const out = await signIn(p.slug, { startQuery: '?test=1', cookie, nameId: 'u-test', attributes: { email: 'tested@acme.test', groups: ['a', 'b'] } });
    expect(out.request.xml).toContain('ForceAuthn="true"');
    expect(out.res.statusCode).toBe(200);
    expect(out.res.body).toContain('Connection works');
    expect(out.res.body).toContain('tested@acme.test');
    expect(out.sessionCookie).toBeUndefined();
    expect(await store.findStoredUserByEmail('tested@acme.test')).toBeUndefined();
    expect(await providers.findIdentity(IDP, 'u-test')).toBeUndefined();
  });

  it('"Test connection" popup speaks the admin\'s language and shows a single group as a list', async () => {
    const p = await provider({ enabled: false });
    const { admin, cookie } = await adminCookie();
    await store.updateUserLang(admin.id, 'uk');
    const out = await signIn(p.slug, { startQuery: '?test=1', cookie, nameId: 'u-test-uk', attributes: { email: 'tested-uk@acme.test', groups: 'sales' } });
    expect(out.res.statusCode).toBe(200);
    expect(out.res.body).toContain('\u041f\u0456\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u043d\u044f \u043f\u0440\u0430\u0446\u044e\u0454' /* Ukrainian: the test popup is localized */);
    expect(out.res.body).not.toContain('Connection works');
    expect(out.res.body).toMatch(/&quot;groups&quot;: \[\s*&quot;sales&quot;\s*\]/); // mapped.groups, normalised (the raw attribute stays as the IdP sent it)
  });

  it('IdP metadata: from a URL (fetched, cached) or pasted XML; SP metadata names the entity ID and ACS', async () => {
    const mdUrl = `https://idp.test/metadata/${randomBytes(3).toString('hex')}`;
    metadataByUrl.set(mdUrl, idpMetadataXml(IDP, SSO_URL, key.certBase64));
    const fromUrl = await provider({}, { idpEntityId: '', ssoUrl: '', idpCert: '', metadataUrl: mdUrl });
    expect(fromUrl.issuer).toBe(mdUrl);
    expect((await signIn(fromUrl.slug, { nameId: 'u-md-url', attributes: { email: 'mdurl@acme.test' } })).authError).toBeNull();

    const fromXml = await provider({}, { idpEntityId: '', ssoUrl: '', idpCert: '', metadataXml: idpMetadataXml(IDP, SSO_URL, key.certBase64) });
    expect(fromXml.issuer).toBe(IDP);
    expect((await signIn(fromXml.slug, { nameId: 'u-md-xml', attributes: { email: 'mdxml@acme.test' } })).authError).toBeNull();

    const md = await app.inject({ method: 'GET', url: `/api/auth/saml/${fromXml.slug}/metadata` });
    expect(md.statusCode).toBe(200);
    expect(md.headers['content-type']).toMatch(/xml/);
    expect(md.body).toContain(`entityID="${spEntityId(fromXml.slug)}"`);
    expect(md.body).toContain(`Location="${acsUrl(fromXml.slug)}"`);
    expect(md.body).toContain('WantAssertionsSigned="true"');
    expect((await app.inject({ method: 'GET', url: '/api/auth/saml/no-such/metadata' })).statusCode).toBe(404);

    const parsed = await parseIdpMetadata(idpMetadataXml(IDP, SSO_URL, key.certBase64, 'post'));
    expect(parsed).toMatchObject({ entityId: IDP, ssoUrl: SSO_URL, ssoBinding: 'post' });
    expect(parseCertificates(key.certBase64)).toEqual(parsed.certs);
  });

  it('admin API: creates a SAML provider, shows what to register at the IdP, refuses unusable settings', async () => {
    const { cookie } = await adminCookie();
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/providers',
      headers: { cookie },
      payload: { kind: 'saml', slug: 'okta-saml', displayName: 'Okta', allowedDomains: ['okta.test'], saml: { idpEntityId: 'http://www.okta.com/exk1', ssoUrl: 'https://okta.test/sso/saml', idpCert: key.certBase64 } },
    });
    expect(created.statusCode).toBe(201);
    const info = created.json();
    expect(info.kind).toBe('saml');
    expect(info.issuer).toBe('http://www.okta.com/exk1');
    expect(info.redirectUri).toBe(acsUrl('okta-saml'));
    expect(info.samlSp).toEqual({ entityId: spEntityId('okta-saml'), acsUrl: acsUrl('okta-saml'), metadataUrl: spEntityId('okta-saml') });
    expect(info.saml.nameIdFormat).toBe('persistent');

    const patched = await app.inject({ method: 'PATCH', url: `/api/admin/auth/providers/${info.id}`, headers: { cookie }, payload: { saml: { spEntityId: 'urn:folio:okta', emailAuthoritative: true } } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().samlSp.entityId).toBe('urn:folio:okta');
    expect(patched.json().saml.idpEntityId).toBe('http://www.okta.com/exk1');
    expect(patched.json().saml.emailAuthoritative).toBe(true);
    const kindChange = await app.inject({ method: 'PATCH', url: `/api/admin/auth/providers/${info.id}`, headers: { cookie }, payload: { kind: 'oidc' } });
    expect(kindChange.statusCode).toBe(400);

    const badCert = await app.inject({ method: 'POST', url: '/api/admin/auth/providers', headers: { cookie }, payload: { kind: 'saml', slug: 'bad-cert', displayName: 'Bad', saml: { idpEntityId: 'x', ssoUrl: 'https://x.test/sso', idpCert: 'not a certificate' } } });
    expect(badCert.statusCode).toBe(400);
    const incomplete = await app.inject({ method: 'POST', url: '/api/admin/auth/providers', headers: { cookie }, payload: { kind: 'saml', slug: 'incomplete', displayName: 'Inc', saml: { ssoUrl: 'https://x.test/sso' } } });
    expect(incomplete.statusCode).toBe(400);
    expect(incomplete.json().error).toMatch(/IdP certificate/);
    const oidcMissing = await app.inject({ method: 'POST', url: '/api/admin/auth/providers', headers: { cookie }, payload: { slug: 'oidc-missing', displayName: 'X' } });
    expect(oidcMissing.statusCode).toBe(400);
  });

  it('a tampered flow cookie is not accepted', () => {
    const flow = signSamlFlow({ slug: 's', state: 'st', requestId: '_r', mode: 'login', createdAt: Date.now(), exp: Math.floor(Date.now() / 1000) + 60 });
    expect(verifySamlFlow(flow)?.requestId).toBe('_r');
    expect(verifySamlFlow(flow.replace(/^./, (c) => (c === 'e' ? 'f' : 'e')))).toBeNull();
  });

  it('maps attributes: custom names, the well-known fallbacks, given + surname', () => {
    const base = { allowedDomains: ['acme.test'], saml: null };
    const m1 = mapSamlProfile({ issuer: IDP, nameID: 'x', nameIDFormat: 'p', attributes: { mail: 'A@acme.test', givenName: 'Ann', sn: 'Lee', memberOf: ['cn=x'] } }, { ...base, claimMapping: providers.DEFAULT_CLAIM_MAPPING });
    expect(m1).toMatchObject({ subject: 'x', email: 'a@acme.test', name: 'Ann Lee', groups: ['cn=x'], emailVerified: false });
    const m2 = mapSamlProfile(
      { issuer: IDP, nameID: 'y', nameIDFormat: 'p', attributes: { 'user.mail': 'b@acme.test', email: 'ignored@acme.test', full: 'B', teams: 't1' } },
      { ...base, claimMapping: { email: 'user.mail', name: 'full', groups: 'teams' } },
    );
    expect(m2).toMatchObject({ email: 'b@acme.test', name: 'B', groups: ['t1'] });
  });

  it('reads FOLIO_SAML_<SLUG>_* from the environment', () => {
    const env = {
      FOLIO_SAML_ENTRA_METADATA_URL: 'https://login.microsoftonline.com/t/federationmetadata/2007-06/federationmetadata.xml',
      FOLIO_SAML_ENTRA_NAME: 'Microsoft',
      FOLIO_SAML_ENTRA_DOMAINS: 'Corp.test, @corp.org',
      FOLIO_SAML_ENTRA_JIT: 'true',
      FOLIO_SAML_ENTRA_ENFORCE: '1',
      FOLIO_SAML_ENTRA_EMAIL_AUTHORITATIVE: 'yes',
      FOLIO_SAML_ENTRA_GROUPS_ATTR: GROUPS_URI,
      FOLIO_SAML_KC_SSO_URL: 'http://localhost:8080/realms/folio/protocol/saml',
      FOLIO_SAML_KC_ENTITY_ID: 'http://localhost:8080/realms/folio',
      FOLIO_SAML_KC_CERT: 'line1\\nline2',
      FOLIO_SAML_KC_NAMEID_FORMAT: 'email',
      FOLIO_OIDC_KC_ISSUER: 'https://kc.test',
      FOLIO_OIDC_KC_CLIENT_ID: 'folio',
    } as NodeJS.ProcessEnv;
    const all = providers.readEnvProviders(env);
    const entra = all.get('entra')!;
    expect(entra).toMatchObject({ kind: 'saml', displayName: 'Microsoft', allowedDomains: ['corp.test', 'corp.org'], jitEnabled: true, enforceSso: true });
    expect(entra.saml).toMatchObject({ metadataUrl: env.FOLIO_SAML_ENTRA_METADATA_URL, emailAuthoritative: true, allowIdpInitiated: false, nameIdFormat: 'persistent' });
    expect(entra.claimMapping.groups).toBe(GROUPS_URI);
    // An OIDC provider with the same slug wins.
    expect(all.get('kc')?.kind).toBe('oidc');
    const kcOnly = providers.readEnvProviders({ ...env, FOLIO_OIDC_KC_ISSUER: undefined });
    expect(kcOnly.get('kc')?.saml).toMatchObject({ ssoUrl: env.FOLIO_SAML_KC_SSO_URL, idpCert: 'line1\nline2', nameIdFormat: 'email' });
  });
});
