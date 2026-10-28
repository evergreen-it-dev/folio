/**
 * Single sign-on through SAML 2.0 (docs/AUTH.md): SP-initiated Web Browser SSO, the AuthnRequest over HTTP-Redirect
 * (or HTTP-POST when that is all the IdP offers), the Response over HTTP-POST, validated by @node-saml/node-saml.
 * Public routes (registered next to the OIDC ones):
 *
 *   GET  /api/auth/saml/:slug/start      ?invite=<token> | ?test=1 | ?returnTo=<app path to come back to>
 *   POST /api/auth/saml/:slug/acs        the Assertion Consumer Service (SAMLResponse, RelayState)
 *   GET  /api/auth/saml/:slug/metadata   Folio's SP metadata (entity ID, ACS URL, NameID format)
 *
 * What a response must pass before anyone signs in:
 *  - the assertion is signed by one of the IdP's certificates (wantAssertionsSigned; a signed Response around an
 *    unsigned assertion is not enough), exactly one assertion, no encrypted ones (Folio holds no SP key);
 *  - the assertion's Issuer is the IdP entity ID; the Audience is Folio's SP entity ID;
 *  - NotBefore / NotOnOrAfter (Conditions and SubjectConfirmationData) hold, with at most 120 s of clock skew;
 *  - InResponseTo is the ID of the AuthnRequest this browser started — kept, with the RelayState, in a signed
 *    10-minute cookie (folio_saml). Unsolicited (IdP-initiated) responses are refused unless the provider allows
 *    them (allowIdpInitiated, off by default);
 *  - the assertion ID was never accepted before (saml_assertion_ids, migration 056, until it expires): no replay;
 *  - no DOCTYPE / ENTITY declaration anywhere in the document (samlConfig.ts rejectDoctype);
 *  - the NameID is not transient (it could never find the account again).
 * The identity is (issuer = IdP entity ID, subject = NameID). The email comes from the mapped attribute or an
 * email-shaped NameID. SAML has no `email_verified`: the email counts as verified only when the provider is marked
 * authoritative for its allowed domains (emailAuthoritative) — which is what linking an existing account needs.
 * From there on the decision is OIDC's (sso.ts resolveSsoSignIn): same linking, JIT, invite, enforced-SSO rules.
 *
 * The flow cookie is SameSite=None (with Secure) in production: the IdP POSTs the response cross-site and a Lax
 * cookie would not come along. On plain http (dev) it is Lax — fine for an IdP on the same site (localhost).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { SAML, ValidateInResponseTo, generateServiceProviderMetadata } from '@node-saml/node-saml';
import type { CacheProvider, Profile } from '@node-saml/node-saml';
import { query, queryOne } from '../db/pool.js';
import { recordAudit } from '../audit.js';
import { publicUrlOrOrigin } from '../publicUrl.js';
import * as store from './store.js';
import * as session from './session.js';
import * as providers from './providers.js';
import type { AuthProvider } from './providers.js';
import { normalizeGroupsClaim } from './groupSyncConfig.js';
import { NAMEID_FORMAT_URNS, NAMEID_TRANSIENT, parseCertificates, parseIdpMetadata, rejectDoctype, type IdpMetadata } from './samlConfig.js';
import {
  describeError,
  finishSsoSignIn,
  redirectToLoginError,
  startReturnTo,
  renderTestResult,
  requestOrigin,
  signPayload,
  testPopupLanguage,
  verifyPayload,
  type MappedClaims,
  type SsoErrorCode,
} from './sso.js';

const FLOW_COOKIE = 'folio_saml';
const FLOW_COOKIE_PATH = '/api/auth/saml';
const FLOW_PURPOSE = 'folio-saml-flow';
const FLOW_TTL_SECONDS = 10 * 60;
export const CLOCK_SKEW_MS = 120_000;
const METADATA_TTL_MS = 60 * 60 * 1000;
const METADATA_MAX_BYTES = 1024 * 1024;
const RESPONSE_MAX_BYTES = 512 * 1024;
/** How long an assertion ID is kept when the assertion names no NotOnOrAfter at all. */
const REPLAY_FALLBACK_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// The IdP: explicit settings over its metadata (URL fetched and cached, or pasted XML)
// ---------------------------------------------------------------------------

export interface ResolvedIdp {
  entityId: string;
  ssoUrl: string;
  ssoBinding: 'redirect' | 'post';
  certs: string[];
}

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;
let testFetch: FetchLike | undefined;
const metadataCache = new Map<string, { key: string; at: number; md: IdpMetadata }>();

/** Test-only: where IdP metadata URLs are fetched from. */
export function __setSamlFetchForTests(fetchImpl: FetchLike | undefined): void {
  testFetch = fetchImpl;
  metadataCache.clear();
}

function insecureAllowed(url: URL): boolean {
  if (url.protocol !== 'http:') return false;
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname) || url.hostname.endsWith('.localhost')) return true;
  return /^(1|true|yes)$/i.test(process.env.FOLIO_OIDC_ALLOW_HTTP ?? '');
}

async function fetchMetadata(provider: AuthProvider, metadataUrl: string): Promise<IdpMetadata> {
  const key = `${provider.updatedAt}|${metadataUrl}`;
  const cached = metadataCache.get(provider.id);
  if (cached && cached.key === key && Date.now() - cached.at < METADATA_TTL_MS) return cached.md;
  const url = new URL(metadataUrl);
  if (url.protocol !== 'https:' && !insecureAllowed(url)) throw new Error('the IdP metadata URL must be https');
  const res = await (testFetch ?? (fetch as FetchLike))(url.toString(), { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/samlmetadata+xml, application/xml, text/xml' } });
  if (!res.ok) throw new Error(`fetching the IdP metadata failed: HTTP ${res.status}`);
  const text = await res.text();
  if (Buffer.byteLength(text) > METADATA_MAX_BYTES) throw new Error('the IdP metadata is larger than 1 MB');
  const md = await parseIdpMetadata(text);
  metadataCache.set(provider.id, { key, at: Date.now(), md });
  return md;
}

export async function resolveIdp(provider: AuthProvider): Promise<ResolvedIdp> {
  const cfg = provider.saml;
  if (!cfg) throw new Error('not a SAML provider');
  const md = cfg.metadataXml ? await parseIdpMetadata(cfg.metadataXml) : cfg.metadataUrl ? await fetchMetadata(provider, cfg.metadataUrl) : undefined;
  const entityId = cfg.idpEntityId || md?.entityId || '';
  const ssoUrl = cfg.ssoUrl || md?.ssoUrl || '';
  const certs = cfg.idpCert ? parseCertificates(cfg.idpCert) : (md?.certs ?? []);
  const missing = [!entityId && 'IdP entity ID', !ssoUrl && 'SSO URL', !certs.length && 'IdP certificate'].filter(Boolean);
  if (missing.length) throw new Error(`the SAML provider is incomplete: no ${missing.join(', ')}`);
  return { entityId, ssoUrl, ssoBinding: cfg.ssoUrl ? 'redirect' : (md?.ssoBinding ?? 'redirect'), certs };
}

// ---------------------------------------------------------------------------
// Folio as the SP
// ---------------------------------------------------------------------------

export function samlSpFor(provider: Pick<AuthProvider, 'slug' | 'saml'>, origin: string): { entityId: string; acsUrl: string; metadataUrl: string } {
  const base = `${publicUrlOrOrigin(origin)}/api/auth/saml/${provider.slug}`;
  return { entityId: provider.saml?.spEntityId || `${base}/metadata`, acsUrl: `${base}/acs`, metadataUrl: `${base}/metadata` };
}

/**
 * node-saml checks InResponseTo against a cache of the request IDs it issued. Folio keeps that one ID in the
 * browser's signed flow cookie instead of a server-side store: at the start the cache only records the ID the
 * AuthnRequest got; at the ACS it knows exactly the one ID this browser's cookie names.
 */
class FlowRequestCache implements CacheProvider {
  issued: string | undefined;
  constructor(
    private readonly expected?: string,
    private readonly createdAt?: number,
  ) {}
  async saveAsync(key: string, value: string) {
    this.issued = key;
    return { value, createdAt: Date.now() };
  }
  async getAsync(key: string) {
    return this.expected && key === this.expected ? new Date(this.createdAt ?? Date.now()).toISOString() : null;
  }
  async removeAsync(_key: string | null) {
    return null;
  }
}

function samlClient(provider: AuthProvider, idp: ResolvedIdp, origin: string, cache: CacheProvider, opts: { forceAuthn?: boolean } = {}): SAML {
  const sp = samlSpFor(provider, origin);
  const cfg = provider.saml!;
  return new SAML({
    callbackUrl: sp.acsUrl,
    entryPoint: idp.ssoUrl,
    issuer: sp.entityId,
    audience: sp.entityId,
    idpCert: idp.certs,
    idpIssuer: idp.entityId,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    acceptedClockSkewMs: CLOCK_SKEW_MS,
    identifierFormat: NAMEID_FORMAT_URNS[cfg.nameIdFormat],
    validateInResponseTo: cfg.allowIdpInitiated ? ValidateInResponseTo.ifPresent : ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: FLOW_TTL_SECONDS * 1000,
    cacheProvider: cache,
    // A RequestedAuthnContext of "password" makes Entra ID / ADFS refuse people who signed in with MFA or Windows auth.
    disableRequestedAuthnContext: true,
    forceAuthn: opts.forceAuthn ?? false,
    signatureAlgorithm: 'sha256',
  });
}

// ---------------------------------------------------------------------------
// Flow cookie
// ---------------------------------------------------------------------------

export interface SamlFlowState {
  slug: string;
  /** Sent as RelayState and expected back with the response. */
  state: string;
  /** The AuthnRequest ID: the response's InResponseTo must be this. */
  requestId: string;
  mode: 'login' | 'test' | 'invite';
  invite?: string;
  /** The page the person opened before signing in (a validated app path). */
  returnTo?: string;
  adminId?: string;
  createdAt: number;
  exp: number;
}

export function signSamlFlow(flow: SamlFlowState): string {
  return signPayload(FLOW_PURPOSE, flow);
}

export function verifySamlFlow(raw: string | undefined): SamlFlowState | null {
  return verifyPayload<SamlFlowState>(FLOW_PURPOSE, raw);
}

function setFlowCookie(reply: FastifyReply, flow: SamlFlowState): void {
  const secure = session.cookiesSecure();
  reply.setCookie(FLOW_COOKIE, signSamlFlow(flow), {
    httpOnly: true,
    sameSite: secure ? 'none' : 'lax',
    secure,
    maxAge: FLOW_TTL_SECONDS,
    path: FLOW_COOKIE_PATH,
  });
}

function clearFlowCookie(reply: FastifyReply): void {
  const secure = session.cookiesSecure();
  reply.clearCookie(FLOW_COOKIE, { path: FLOW_COOKIE_PATH, sameSite: secure ? 'none' : 'lax', secure });
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

/** Well-known attribute names, tried when the mapping is left at its default (Entra ID, Okta, Keycloak, Google, ADFS, X.500 OIDs). */
const EMAIL_ATTRS = [
  'email',
  'mail',
  'emailAddress',
  'Email',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
  'urn:oid:1.2.840.113549.1.9.1',
  'user.email',
];
const NAME_ATTRS = ['name', 'displayName', 'http://schemas.microsoft.com/identity/claims/displayname', 'urn:oid:2.16.840.1.113730.3.1.241', 'cn', 'urn:oid:2.5.4.3', 'fullName'];
const GIVEN_ATTRS = ['givenName', 'firstName', 'given_name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname', 'urn:oid:2.5.4.42'];
const SURNAME_ATTRS = ['sn', 'surname', 'lastName', 'family_name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname', 'urn:oid:2.5.4.4'];
const GROUPS_ATTRS = [
  'groups',
  'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
  'memberOf',
  'isMemberOf',
  'urn:oid:1.3.6.1.4.1.5923.1.5.1.1',
  'Role',
  'roles',
  'http://schemas.microsoft.com/ws/2008/06/identity/claims/role',
];

function attribute(attrs: Record<string, unknown>, names: string[]): unknown {
  for (const n of names) if (attrs[n] !== undefined) return attrs[n];
  const lower = new Map(Object.keys(attrs).map((k) => [k.toLowerCase(), k]));
  for (const n of names) {
    const k = lower.get(n.toLowerCase());
    if (k !== undefined) return attrs[k];
  }
  return undefined;
}

function firstString(v: unknown): string | null {
  const one = Array.isArray(v) ? v[0] : v;
  return typeof one === 'string' && one.trim() ? one.trim() : null;
}

/** The configured attribute name; the well-known ones as well while the mapping is left at its default. */
function candidates(configured: string, fallback: string, known: string[]): string[] {
  return configured === fallback ? known : [configured];
}

export function mapSamlProfile(profile: Profile, provider: Pick<AuthProvider, 'claimMapping' | 'allowedDomains' | 'saml'>): MappedClaims {
  const attrs = (typeof profile.attributes === 'object' && profile.attributes !== null ? profile.attributes : {}) as Record<string, unknown>;
  const mapping = provider.claimMapping;
  const rawEmail = firstString(attribute(attrs, candidates(mapping.email, providers.DEFAULT_CLAIM_MAPPING.email, EMAIL_ATTRS)));
  const nameId = typeof profile.nameID === 'string' ? profile.nameID.trim() : '';
  const fromNameId = profile.nameIDFormat === NAMEID_FORMAT_URNS.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nameId) ? nameId : null;
  const emailRaw = rawEmail && rawEmail.includes('@') ? rawEmail : fromNameId;
  const email = emailRaw ? emailRaw.toLowerCase() : null;
  let name = firstString(attribute(attrs, candidates(mapping.name, providers.DEFAULT_CLAIM_MAPPING.name, NAME_ATTRS)));
  if (!name) name = [firstString(attribute(attrs, GIVEN_ATTRS)), firstString(attribute(attrs, SURNAME_ATTRS))].filter(Boolean).join(' ') || null;
  return {
    subject: nameId,
    email,
    // SAML has no email_verified: only an IdP the admin marked authoritative, and only for its allowed domains.
    emailVerified: Boolean(provider.saml?.emailAuthoritative && email && providers.domainAllowed(provider, email)),
    emailUnverifiedExplicitly: false,
    name,
    // One value arrives as a bare string; everything downstream (stored claim, group sync, Test connection) sees a list.
    groups: normalizeGroupsClaim(attribute(attrs, candidates(mapping.groups, providers.DEFAULT_CLAIM_MAPPING.groups, GROUPS_ATTRS))),
    hd: undefined,
  };
}

// ---------------------------------------------------------------------------
// One-time use of assertions
// ---------------------------------------------------------------------------

function latestNotOnOrAfter(assertion: Record<string, unknown> | undefined): number | null {
  const times: number[] = [];
  const push = (v: unknown) => {
    const t = typeof v === 'string' ? Date.parse(v) : NaN;
    if (!Number.isNaN(t)) times.push(t);
  };
  const a = assertion as {
    Conditions?: Array<{ $?: { NotOnOrAfter?: string } }>;
    Subject?: Array<{ SubjectConfirmation?: Array<{ SubjectConfirmationData?: Array<{ $?: { NotOnOrAfter?: string } }> }> }>;
  };
  for (const c of a?.Conditions ?? []) push(c.$?.NotOnOrAfter);
  for (const s of a?.Subject ?? []) for (const sc of s.SubjectConfirmation ?? []) for (const d of sc.SubjectConfirmationData ?? []) push(d.$?.NotOnOrAfter);
  return times.length ? Math.max(...times) : null;
}

/** Records the assertion ID; false when it was already used (a replay). Expired IDs are swept on the way. */
export async function consumeAssertionId(issuer: string, assertionId: string, notOnOrAfterMs: number | null): Promise<boolean> {
  const expires = new Date((notOnOrAfterMs ?? Date.now() + REPLAY_FALLBACK_MS) + CLOCK_SKEW_MS);
  await query('DELETE FROM saml_assertion_ids WHERE expires_at < now()');
  const row = await queryOne<{ assertion_id: string }>(
    `INSERT INTO saml_assertion_ids (issuer, assertion_id, expires_at) VALUES ($1, $2, $3)
     ON CONFLICT (issuer, assertion_id) DO NOTHING RETURNING assertion_id`,
    [issuer, assertionId, expires],
  );
  return row !== undefined && row !== null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function startHandler(request: FastifyRequest, reply: FastifyReply, slug: string): Promise<FastifyReply> {
  const q = request.query as { invite?: string; test?: string; returnTo?: string };
  const returnTo = startReturnTo(q);
  const origin = publicUrlOrOrigin(requestOrigin(request));
  const provider = await providers.getProviderBySlug(slug);
  const testMode = q.test === '1';
  let adminId: string | undefined;
  if (testMode) {
    const user = await session.userForToken(request.cookies?.[session.SESSION_COOKIE_NAME]);
    if (!user?.isAdmin) return reply.status(403).send({ error: 'requires instance admin' });
    adminId = user.id;
  }
  if (!provider || provider.kind !== 'saml' || (!provider.enabled && !testMode)) {
    if (testMode) return renderTestResult(reply, origin, { ok: false, error: 'provider not found or not configured' }, await testPopupLanguage(request, adminId));
    return redirectToLoginError(reply, request, 'provider', returnTo);
  }

  try {
    const idp = await resolveIdp(provider);
    const cache = new FlowRequestCache();
    const saml = samlClient(provider, idp, requestOrigin(request), cache, { forceAuthn: testMode });
    const state = randomBytes(18).toString('base64url');
    const target = idp.ssoBinding === 'post' ? await saml.getAuthorizeFormAsync(state) : await saml.getAuthorizeUrlAsync(state, undefined, {});
    if (!cache.issued) throw new Error('the AuthnRequest got no ID');
    setFlowCookie(reply, {
      slug: provider.slug,
      state,
      requestId: cache.issued,
      mode: testMode ? 'test' : q.invite ? 'invite' : 'login',
      ...(q.invite && !testMode ? { invite: String(q.invite) } : {}),
      ...(returnTo && !testMode ? { returnTo } : {}),
      ...(adminId ? { adminId } : {}),
      createdAt: Date.now(),
      exp: Math.floor(Date.now() / 1000) + FLOW_TTL_SECONDS,
    });
    reply.header('Cache-Control', 'no-store');
    if (idp.ssoBinding === 'post') return reply.type('text/html; charset=utf-8').send(target);
    return reply.redirect(target);
  } catch (err) {
    const detail = describeError(err);
    request.log.error({ err: detail, provider: slug }, 'saml: building the AuthnRequest failed');
    if (testMode) return renderTestResult(reply, origin, { ok: false, error: detail }, await testPopupLanguage(request, adminId));
    return redirectToLoginError(reply, request, 'exchange', returnTo);
  }
}

async function acsHandler(request: FastifyRequest, reply: FastifyReply, slug: string): Promise<FastifyReply> {
  const origin = publicUrlOrOrigin(requestOrigin(request));
  const flow = verifySamlFlow(request.cookies?.[FLOW_COOKIE]);
  clearFlowCookie(reply);
  const testMode = flow?.mode === 'test' && flow.slug === slug;
  const lang = testMode ? await testPopupLanguage(request, flow?.adminId) : undefined;
  const fail = (code: SsoErrorCode, detail?: string) =>
    testMode ? renderTestResult(reply, origin, { ok: false, error: detail ?? code }, lang) : redirectToLoginError(reply, request, code, flow?.returnTo);
  const refuseAudited = (code: SsoErrorCode, detail: string) => {
    request.log.warn({ provider: slug, reason: code, err: detail }, 'saml: response refused');
    if (!testMode) recordAudit(null, 'auth.sso_refused', slug, { reason: code, detail, protocol: 'saml' });
    return fail(code, detail);
  };

  const provider = await providers.getProviderBySlug(slug);
  if (!provider || provider.kind !== 'saml' || (!provider.enabled && !testMode)) return fail('provider');
  if (testMode) {
    // The IdP POSTs here cross-site, so the Lax session cookie does not come along: the signed, httpOnly flow
    // cookie names the admin who started the test, and that admin must still be one.
    const admin = flow?.adminId ? await store.findStoredUserById(flow.adminId) : undefined;
    if (!admin?.isAdmin || admin.disabled) return reply.status(403).send({ error: 'requires instance admin' });
  }

  const body = (request.body ?? {}) as { SAMLResponse?: unknown; RelayState?: unknown };
  const samlResponse = typeof body.SAMLResponse === 'string' ? body.SAMLResponse : '';
  if (!samlResponse) return refuseAudited('exchange', 'no SAMLResponse in the request');
  const relayState = typeof body.RelayState === 'string' ? body.RelayState : '';

  let usableFlow: SamlFlowState | null = null;
  if (flow && flow.slug === slug) {
    if (relayState !== flow.state) return refuseAudited('state', 'the RelayState does not match this browser’s sign-in');
    usableFlow = flow;
  } else if (!provider.saml?.allowIdpInitiated) {
    return refuseAudited('state', 'no sign-in was started from this browser (unsolicited / IdP-initiated responses are not accepted)');
  }

  let profile: Profile;
  let idp: ResolvedIdp;
  try {
    rejectDoctype(Buffer.from(samlResponse, 'base64').toString('utf8'));
    idp = await resolveIdp(provider);
    const saml = samlClient(provider, idp, requestOrigin(request), new FlowRequestCache(usableFlow?.requestId, usableFlow?.createdAt));
    const result = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse });
    if (!result.profile) throw new Error('the response carries no assertion');
    profile = result.profile;
    // node-saml checks idpIssuer only on logout messages: the (signed) assertion's Issuer is checked here.
    if (profile.issuer !== idp.entityId) throw new Error(`unexpected assertion Issuer "${profile.issuer ?? ''}" (expected the IdP entity ID "${idp.entityId}")`);
    if (profile.nameIDFormat === NAMEID_TRANSIENT) throw new Error('the NameID is transient: configure the IdP to send a persistent or email NameID');
    if (!profile.nameID) throw new Error('the assertion has no NameID');
  } catch (err) {
    return refuseAudited('exchange', describeError(err));
  }

  const assertion = (profile.getAssertion?.() as { Assertion?: Record<string, unknown> & { $?: { ID?: string } } } | undefined)?.Assertion;
  const assertionId = assertion?.$?.ID;
  if (!assertionId) return refuseAudited('exchange', 'the assertion has no ID');
  if (!(await consumeAssertionId(idp.entityId, assertionId, latestNotOnOrAfter(assertion)))) {
    return refuseAudited('replay', `assertion ${assertionId} was already used`);
  }

  const mapped = mapSamlProfile(profile, provider);
  if (testMode) {
    const attributes = (typeof profile.attributes === 'object' && profile.attributes !== null ? profile.attributes : {}) as Record<string, unknown>;
    return renderTestResult(reply, origin, {
      ok: true,
      claims: { ...attributes, nameID: profile.nameID, nameIDFormat: profile.nameIDFormat, issuer: profile.issuer, ...(profile.sessionIndex ? { sessionIndex: profile.sessionIndex } : {}) },
      mapped: { subject: mapped.subject, email: mapped.email, emailVerified: mapped.emailVerified, name: mapped.name, groups: mapped.groups ?? null },
    }, lang);
  }

  return finishSsoSignIn(request, reply, {
    provider,
    issuer: idp.entityId,
    mapped,
    inviteToken: usableFlow?.mode === 'invite' ? usableFlow.invite : undefined,
    returnTo: usableFlow?.returnTo,
    protocol: 'saml',
    fail,
  });
}

export function registerSamlRoutes(app: FastifyInstance): void {
  app.get('/api/auth/saml/:slug/start', async (request, reply) => startHandler(request, reply, (request.params as { slug: string }).slug));

  app.get('/api/auth/saml/:slug/metadata', async (request, reply) => {
    const provider = await providers.getProviderBySlug((request.params as { slug: string }).slug);
    if (!provider || provider.kind !== 'saml' || !provider.saml) return reply.status(404).send({ error: 'not found' });
    const sp = samlSpFor(provider, requestOrigin(request));
    const xml = generateServiceProviderMetadata({
      issuer: sp.entityId,
      callbackUrl: sp.acsUrl,
      identifierFormat: NAMEID_FORMAT_URNS[provider.saml.nameIdFormat],
      wantAssertionsSigned: true,
    });
    return reply.header('Cache-Control', 'no-cache').type('application/xml; charset=utf-8').send(xml);
  });

  // The ACS takes the IdP's form POST (application/x-www-form-urlencoded), which Fastify does not parse by itself.
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: RESPONSE_MAX_BYTES }, (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error);
      }
    });
    scope.post('/api/auth/saml/:slug/acs', async (request, reply) => acsHandler(request, reply, (request.params as { slug: string }).slug));
  });
}
