/**
 * Single sign-on through OpenID Connect (docs/AUTH.md) — the authorization
 * code flow with PKCE, state and nonce, validated by openid-client (panva):
 * the ID token's signature against the provider's JWKS, `iss`, `aud`, `exp`
 * and the nonce. Public routes (registered next to /api/auth/login):
 *
 *   GET  /api/auth/oidc/:slug/start      ?invite=<token> | ?test=1 | ?login_hint=<email> | ?returnTo=<app path to come back to>
 *   GET  /api/auth/oidc/:slug/callback
 *   GET  /api/auth/google/start|callback  — the `google` provider built from GOOGLE_*,
 *                                          on the callback URL Google clients already registered
 *   POST /api/auth/sso/discover {email}  — which provider the login page routes an email to
 *
 * Who gets in, the audit trail and the session are shared with SAML (sso.ts, resolveSsoSignIn).
 *
 * Every refusal redirects to `/?authError=<code>` (never a raw 500); the reason goes to the server log and the audit log.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import * as client from 'openid-client';
import type { SsoDiscoverResult } from '../../shared/contracts.js';
import { ssoDiscoverBodySchema } from '../../shared/contracts.js';
import { parseBody } from '../validate.js';
import { recordAudit } from '../audit.js';
import { publicUrlOrOrigin } from '../publicUrl.js';
import * as session from './session.js';
import * as providers from './providers.js';
import type { AuthProvider } from './providers.js';
import { normalizeGroupsClaim } from './groupSyncConfig.js';
import {
  describeError,
  finishSsoSignIn,
  redirectToLoginError,
  renderTestResult,
  requestOrigin,
  signPayload,
  startReturnTo,
  testPopupLanguage,
  toPublicProvider,
  verifyPayload,
  type MappedClaims,
  type SsoErrorCode,
} from './sso.js';

export { resolveSsoSignIn, ssoRequired, toPublicProvider, publicProviders } from './sso.js';
export type { MappedClaims, SsoErrorCode, SsoOutcome } from './sso.js';

const FLOW_COOKIE = 'folio_oidc';
const FLOW_COOKIE_PATH = '/api/auth';
const FLOW_TTL_SECONDS = 10 * 60;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// openid-client configuration (discovery cached per provider version)
// ---------------------------------------------------------------------------

let testFetch: client.CustomFetch | undefined;
const discoveryCache = new Map<string, { key: string; at: number; config: client.Configuration }>();

/** Test-only: route every request openid-client makes (discovery, JWKS, token, userinfo) through `fetchImpl`. */
export function __setOidcFetchForTests(fetchImpl: client.CustomFetch | undefined): void {
  testFetch = fetchImpl;
  discoveryCache.clear();
}

function insecureAllowed(issuer: URL): boolean {
  if (issuer.protocol !== 'http:') return false;
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(issuer.hostname) || issuer.hostname.endsWith('.localhost')) return true;
  return /^(1|true|yes)$/i.test(process.env.FOLIO_OIDC_ALLOW_HTTP ?? '');
}

export async function clientConfigFor(provider: AuthProvider): Promise<client.Configuration> {
  const key = `${provider.updatedAt}|${provider.issuer}|${provider.clientId}|${provider.clientSecret ? createHash('sha256').update(provider.clientSecret).digest('hex') : ''}`;
  const cached = discoveryCache.get(provider.id);
  if (cached && cached.key === key && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.config;

  const issuerUrl = new URL(provider.issuer);
  const execute: Array<(config: client.Configuration) => void> = [];
  if (insecureAllowed(issuerUrl)) execute.push(client.allowInsecureRequests);
  const discovered = await client.discovery(issuerUrl, provider.clientId, undefined, client.None(), {
    execute,
    ...(testFetch ? { [client.customFetch]: testFetch } : {}),
  });
  const server = discovered.serverMetadata();
  // OIDC's default token endpoint auth is client_secret_basic; use post only when the provider says it is the only one.
  const methods = server.token_endpoint_auth_methods_supported;
  // Google: client_secret_post, as the pre-OIDC Google sign-in sent it (proven on prod); Basic failed there with an OAuth error body.
  const auth = !provider.clientSecret
    ? client.None()
    : provider.issuer === providers.GOOGLE_ISSUER || (methods && !methods.includes('client_secret_basic') && methods.includes('client_secret_post'))
      ? client.ClientSecretPost(provider.clientSecret)
      : client.ClientSecretBasic(provider.clientSecret);
  const config = new client.Configuration(server, provider.clientId, provider.clientSecret ? { client_secret: provider.clientSecret } : {}, auth);
  if (testFetch) config[client.customFetch] = testFetch;
  for (const fn of execute) fn(config);
  // The ID token comes straight from the token endpoint over TLS — still, verify its signature against the JWKS.
  client.enableNonRepudiationChecks(config);
  discoveryCache.set(provider.id, { key, at: Date.now(), config });
  return config;
}

// ---------------------------------------------------------------------------
// Flow cookie: state, nonce, PKCE verifier, mode — HMAC-signed, httpOnly, 10 minutes
// ---------------------------------------------------------------------------

export interface FlowState {
  slug: string;
  state: string;
  nonce: string;
  verifier: string;
  mode: 'login' | 'test' | 'invite';
  invite?: string;
  /** The page the person opened before signing in (a validated app path). */
  returnTo?: string;
  /** Test mode: the admin who started it (the callback re-checks the session). */
  adminId?: string;
  exp: number;
}

const FLOW_PURPOSE = 'folio-oidc-flow';

export function signFlow(flow: FlowState): string {
  return signPayload(FLOW_PURPOSE, flow);
}

export function verifyFlow(raw: string | undefined): FlowState | null {
  return verifyPayload<FlowState>(FLOW_PURPOSE, raw);
}

function setFlowCookie(reply: FastifyReply, flow: FlowState): void {
  reply.setCookie(FLOW_COOKIE, signFlow(flow), {
    httpOnly: true,
    sameSite: 'lax',
    secure: session.cookiesSecure(),
    maxAge: FLOW_TTL_SECONDS,
    path: FLOW_COOKIE_PATH,
  });
}

function clearFlowCookie(reply: FastifyReply): void {
  reply.clearCookie(FLOW_COOKIE, { path: FLOW_COOKIE_PATH });
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/** `a.b.c` path into a claims object (Keycloak's realm_access.roles, for instance). */
function claimAt(claims: Record<string, unknown>, path: string): unknown {
  if (path in claims) return claims[path];
  let cur: unknown = claims;
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Entra ID sends `_claim_names: { groups: <source> }` (v2 tokens) or `hasgroups: true` (v1) instead of a list that would not fit. */
function isGroupsOverage(claims: Record<string, unknown>, groups: unknown, claimName: string): boolean {
  if (Array.isArray(groups)) return false;
  const names = claims._claim_names;
  if (typeof names === 'object' && names !== null && ('groups' in names || claimName in names)) return true;
  return claims.hasgroups === true || claims.hasgroups === 'true';
}

export function mapClaims(claims: Record<string, unknown>, mapping: AuthProvider['claimMapping']): MappedClaims {
  const rawEmail = claimAt(claims, mapping.email);
  const email = typeof rawEmail === 'string' && rawEmail.includes('@') ? rawEmail.trim().toLowerCase() : null;
  const verified = claims.email_verified;
  const rawName = claimAt(claims, mapping.name);
  const fallbackName = [claims.given_name, claims.family_name].filter((v) => typeof v === 'string' && v).join(' ');
  return {
    subject: String(claims.sub ?? ''),
    email,
    emailVerified: verified === true || verified === 'true',
    emailUnverifiedExplicitly: verified === false || verified === 'false',
    name: typeof rawName === 'string' && rawName.trim() ? rawName.trim() : fallbackName || null,
    groups: normalizeGroupsClaim(claimAt(claims, mapping.groups)),
    groupsOverage: isGroupsOverage(claims, normalizeGroupsClaim(claimAt(claims, mapping.groups)), mapping.groups),
    hd: typeof claims.hd === 'string' ? claims.hd : undefined,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function callbackPathFor(provider: Pick<AuthProvider, 'slug' | 'legacyGoogle'>): string {
  return provider.legacyGoogle ? '/api/auth/google/callback' : `/api/auth/oidc/${provider.slug}/callback`;
}

export function redirectUriFor(provider: Pick<AuthProvider, 'slug' | 'legacyGoogle'>, origin: string): string {
  return `${publicUrlOrOrigin(origin)}${callbackPathFor(provider)}`;
}

async function startHandler(request: FastifyRequest, reply: FastifyReply, slug: string): Promise<FastifyReply> {
  const q = request.query as { invite?: string; test?: string; login_hint?: string; returnTo?: string };
  const returnTo = startReturnTo(q);
  const provider = await providers.getProviderBySlug(slug);
  const testMode = q.test === '1';
  let adminId: string | undefined;
  if (testMode) {
    const user = await session.userForToken(request.cookies?.[session.SESSION_COOKIE_NAME]);
    if (!user?.isAdmin) return reply.status(403).send({ error: 'requires instance admin' });
    adminId = user.id;
  }
  if (!provider || provider.kind !== 'oidc' || (!provider.enabled && !testMode)) {
    if (testMode) return renderTestResult(reply, publicUrlOrOrigin(requestOrigin(request)), { ok: false, error: 'provider not found or not configured' }, await testPopupLanguage(request, adminId));
    return redirectToLoginError(reply, request, 'provider', returnTo);
  }

  let config: client.Configuration;
  try {
    config = await clientConfigFor(provider);
  } catch (err) {
    request.log.error({ err: err instanceof Error ? err.message : err, provider: slug }, 'sso: discovery failed');
    if (testMode) return renderTestResult(reply, publicUrlOrOrigin(requestOrigin(request)), { ok: false, error: `discovery failed: ${err instanceof Error ? err.message : String(err)}` }, await testPopupLanguage(request, adminId));
    return redirectToLoginError(reply, request, 'exchange', returnTo);
  }

  const verifier = client.randomPKCECodeVerifier();
  const flow: FlowState = {
    slug: provider.slug,
    state: client.randomState(),
    nonce: client.randomNonce(),
    verifier,
    mode: testMode ? 'test' : q.invite ? 'invite' : 'login',
    ...(q.invite && !testMode ? { invite: String(q.invite) } : {}),
    ...(returnTo && !testMode ? { returnTo } : {}),
    ...(adminId ? { adminId } : {}),
    exp: Math.floor(Date.now() / 1000) + FLOW_TTL_SECONDS,
  };
  setFlowCookie(reply, flow);

  const params: Record<string, string> = {
    redirect_uri: redirectUriFor(provider, requestOrigin(request)),
    scope: provider.scopes,
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
  };
  if (typeof q.login_hint === 'string' && q.login_hint.length < 320) params.login_hint = q.login_hint;
  // Google knows no prompt=login; elsewhere a test always shows the provider's sign-in, not a remembered session.
  if (provider.issuer === providers.GOOGLE_ISSUER) params.prompt = 'select_account';
  else if (testMode) params.prompt = 'login';
  return reply.redirect(client.buildAuthorizationUrl(config, params).toString());
}

async function callbackHandler(request: FastifyRequest, reply: FastifyReply, slug: string): Promise<FastifyReply> {
  const origin = publicUrlOrOrigin(requestOrigin(request));
  const flow = verifyFlow(request.cookies?.[FLOW_COOKIE]);
  clearFlowCookie(reply);
  const testMode = flow?.mode === 'test';
  const lang = testMode ? await testPopupLanguage(request, flow?.adminId) : undefined;
  const fail = (code: SsoErrorCode, detail?: string) =>
    testMode ? renderTestResult(reply, origin, { ok: false, error: detail ?? code }, lang) : redirectToLoginError(reply, request, code, flow?.returnTo);

  if (!flow || flow.slug !== slug) return fail('state', 'the sign-in state cookie is missing, expired or for another provider');
  const provider = await providers.getProviderBySlug(slug);
  if (!provider || provider.kind !== 'oidc' || (!provider.enabled && !testMode)) return fail('provider');
  if (testMode) {
    const admin = await session.userForToken(request.cookies?.[session.SESSION_COOKIE_NAME]);
    if (!admin?.isAdmin || admin.id !== flow.adminId) return reply.status(403).send({ error: 'requires instance admin' });
  }

  const query = request.query as { error?: string; error_description?: string };
  if (query.error) {
    request.log.warn({ error: query.error, provider: slug }, 'sso callback: the provider returned an error');
    return fail('denied', `${query.error}${query.error_description ? `: ${query.error_description}` : ''}`);
  }

  let config: client.Configuration;
  let claims: Record<string, unknown>;
  try {
    config = await clientConfigFor(provider);
    const search = new URL(request.raw.url ?? '', 'http://callback.invalid').search;
    const currentUrl = new URL(`${redirectUriFor(provider, requestOrigin(request))}${search}`);
    const tokens = await client.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: flow.verifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    });
    const idClaims = tokens.claims();
    if (!idClaims) throw new Error('no id_token');
    claims = { ...idClaims } as Record<string, unknown>;
    if (config.serverMetadata().userinfo_endpoint && tokens.access_token) {
      try {
        const info = await client.fetchUserInfo(config, tokens.access_token, idClaims.sub);
        // ID token claims are signature-checked: they win over userinfo on overlap.
        claims = { ...(info as Record<string, unknown>), ...claims };
      } catch (err) {
        request.log.warn({ err: err instanceof Error ? err.message : err, provider: slug }, 'sso: userinfo failed, using the ID token claims only');
      }
    }
  } catch (err) {
    // Never log the tokens; the error message carries the failed check (signature, nonce, aud, iss, exp...).
    const detail = describeError(err);
    request.log.error({ err: detail, provider: slug }, 'sso: code exchange / ID token validation failed');
    if (!testMode) recordAudit(null, 'auth.sso_refused', slug, { reason: 'exchange', detail });
    return fail('exchange', detail);
  }

  const issuer = config.serverMetadata().issuer;
  const mapped = mapClaims(claims, provider.claimMapping);
  if (testMode) return renderTestResult(reply, origin, { ok: true, claims, mapped: { subject: mapped.subject, email: mapped.email, emailVerified: mapped.emailVerified, name: mapped.name, groups: mapped.groups ?? null } }, lang);

  return finishSsoSignIn(request, reply, {
    provider,
    issuer,
    mapped,
    inviteToken: flow.mode === 'invite' ? flow.invite : undefined,
    returnTo: flow.returnTo,
    protocol: 'oidc',
    fail,
  });
}

export function registerOidcRoutes(app: FastifyInstance): void {
  app.get('/api/auth/oidc/:slug/start', async (request, reply) => startHandler(request, reply, (request.params as { slug: string }).slug));
  app.get('/api/auth/oidc/:slug/callback', async (request, reply) => callbackHandler(request, reply, (request.params as { slug: string }).slug));
  // The pre-SSO Google URLs: the button of an old cached client, and the callback registered in existing Google clients.
  app.get('/api/auth/google/start', async (request, reply) => startHandler(request, reply, 'google'));
  app.get('/api/auth/google/callback', async (request, reply) => callbackHandler(request, reply, 'google'));

  app.post('/api/auth/sso/discover', async (request): Promise<SsoDiscoverResult> => {
    const { email } = parseBody(ssoDiscoverBodySchema, request.body);
    const provider = await providers.providerForEmail(email);
    return { provider: provider ? toPublicProvider(provider) : null, enforced: Boolean(provider?.enforceSso) };
  });
}
