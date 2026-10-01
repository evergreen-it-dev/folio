/**
 * "Sign in with Google" (OAuth 2.0 authorization code + PKCE): only the
 * domains in GOOGLE_ALLOWED_DOMAINS, an account is created automatically
 * without access to any space, and is linked to an existing account by email
 * (citext). Two routes,
 * both public (registered alongside /api/auth/login — see index.ts):
 *
 *   GET /api/auth/google/start    — redirects to Google's consent screen.
 *   GET /api/auth/google/callback — exchanges the code, resolves the user,
 *                                   sets the normal session cookie.
 *
 * Every refusal here redirects to `/?authError=<code>` — never a raw 500 —
 * so the SPA (still on the login screen) can show a translated message.
 * The real reason always goes to the server log first.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as store from './store.js';
import * as session from './session.js';
import { publicUrlOrOrigin } from '../publicUrl.js';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const OAUTH_COOKIE_NAME = 'folio_google_oauth';
const OAUTH_COOKIE_TTL_SECONDS = 10 * 60; // the consent round-trip is a couple of clicks, not a session

export type GoogleAuthErrorCode = 'domain' | 'unverified' | 'disabled' | 'state' | 'exchange';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GoogleOAuthConfig {
  clientId: string | undefined;
  clientSecret: string | undefined;
  allowedDomains: string[];
}

/**
 * Comma-separated list from GOOGLE_ALLOWED_DOMAINS, trimmed/lower-cased/
 * de-duplicated. Unset or empty means an EMPTY allowlist: no domain is baked
 * into the code, so Google sign-in lets nobody in until the operator names
 * the domains explicitly (closed by default).
 */
export function parseAllowedDomains(raw: string | undefined): string[] {
  const domains = (raw ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(domains));
}

export function getGoogleConfig(): GoogleOAuthConfig {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    allowedDomains: parseAllowedDomains(process.env.GOOGLE_ALLOWED_DOMAINS),
  };
}

/** Both a client id and secret must be set — the login screen only shows the button, and only these two routes only do real work, when this is true. */
export function isGoogleEnabled(): boolean {
  const { clientId, clientSecret } = getGoogleConfig();
  return Boolean(clientId && clientSecret);
}

/**
 * Pure allowlist check: the email's own domain must be listed, AND — when
 * Google sent a `hd` (hosted-domain) claim — that must be listed too. `hd` is
 * absent for a personal @gmail.com account and present for any Google
 * Workspace account, so checking it in addition to the email domain closes
 * the (unlikely but real) case of a Workspace admin adding an alias email in
 * an allowed domain while the account itself belongs to a different org.
 */
export function isAllowedGoogleDomain(email: string, hd: string | undefined, allowedDomains: string[]): boolean {
  const domain = email.split('@')[1]?.trim().toLowerCase();
  if (!domain || !allowedDomains.includes(domain)) return false;
  if (hd && !allowedDomains.includes(hd.trim().toLowerCase())) return false;
  return true;
}

// ---------------------------------------------------------------------------
// "find by google_sub -> else by email (link) -> else create" — pure over an
// injected lookup (no Postgres, no Google) so it's directly unit-testable.
// ---------------------------------------------------------------------------

export type GoogleUserResolution<U> = { kind: 'existing'; user: U } | { kind: 'link'; user: U } | { kind: 'create' };

export interface GoogleUserLookup<U> {
  findByGoogleSub: (googleSub: string) => Promise<U | undefined>;
  findByEmail: (email: string) => Promise<U | undefined>;
}

export async function resolveGoogleUser<U>(
  profile: { sub: string; email: string },
  lookup: GoogleUserLookup<U>,
): Promise<GoogleUserResolution<U>> {
  const bySub = await lookup.findByGoogleSub(profile.sub);
  if (bySub) return { kind: 'existing', user: bySub };
  const byEmail = await lookup.findByEmail(profile.email);
  if (byEmail) return { kind: 'link', user: byEmail };
  return { kind: 'create' };
}

// ---------------------------------------------------------------------------
// PKCE + state
// ---------------------------------------------------------------------------

function randomUrlSafeToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function codeChallengeFor(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

/** Constant-time comparison of two equal-or-unequal-length strings — hash first so a length mismatch alone (which timingSafeEqual would throw on) leaks nothing either. */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

interface OAuthCookiePayload {
  state: string;
  codeVerifier: string;
}

function setOAuthCookie(reply: FastifyReply, payload: OAuthCookiePayload): void {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  reply.setCookie(OAUTH_COOKIE_NAME, encoded, {
    httpOnly: true,
    sameSite: 'lax',
    secure: session.cookiesSecure(),
    maxAge: OAUTH_COOKIE_TTL_SECONDS,
    path: '/api/auth/google',
  });
}

function readOAuthCookie(request: FastifyRequest): OAuthCookiePayload | null {
  const raw = request.cookies?.[OAUTH_COOKIE_NAME];
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as OAuthCookiePayload).state === 'string' &&
      typeof (parsed as OAuthCookiePayload).codeVerifier === 'string'
    ) {
      return parsed as OAuthCookiePayload;
    }
    return null;
  } catch {
    return null;
  }
}

function clearOAuthCookie(reply: FastifyReply): void {
  reply.clearCookie(OAUTH_COOKIE_NAME, { path: '/api/auth/google' });
}

// ---------------------------------------------------------------------------
// Google id_token: decoded, NOT signature-verified
// ---------------------------------------------------------------------------

interface GoogleIdTokenPayload {
  sub: string;
  email: string;
  email_verified: boolean;
  hd?: string;
  name?: string;
  given_name?: string;
}

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * Decodes the id_token's JWT payload without verifying its signature. This is
 * safe here specifically because the token never touches the browser or any
 * third party — it comes straight back from https://oauth2.googleapis.com in
 * the server-to-server token exchange below (TLS + our own client secret
 * authenticates that response as genuinely Google's), unlike the usual
 * "verify a JWT a client handed you" case where skipping signature
 * verification would be a real vulnerability.
 *
 * `aud`/`iss`/`exp` ARE still checked (cheap, and they catch a misconfiguration
 * rather than an attack): a token minted for another client id, or by anything
 * that isn't Google, or one already expired, is refused.
 */
function decodeIdTokenPayload(idToken: string, expectedClientId: string): GoogleIdTokenPayload | null {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(json) as Record<string, unknown>;
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') return null;
    const aud = payload.aud;
    if (typeof aud !== 'string' || aud !== expectedClientId) return null;
    if (typeof payload.iss !== 'string' || !GOOGLE_ISSUERS.includes(payload.iss)) return null;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null;
    return {
      sub: payload.sub,
      email: payload.email,
      email_verified: payload.email_verified === true,
      hd: typeof payload.hd === 'string' ? payload.hd : undefined,
      name: typeof payload.name === 'string' ? payload.name : undefined,
      given_name: typeof payload.given_name === 'string' ? payload.given_name : undefined,
    };
  } catch {
    return null;
  }
}

async function exchangeCodeForIdToken(code: string, codeVerifier: string, redirectUri: string, config: GoogleOAuthConfig): Promise<string> {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId!,
    client_secret: config.clientSecret!,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  // NEVER log `body` (carries the client secret + the one-time code) or the response (carries tokens).
  if (!res.ok) throw new Error(`google token endpoint responded ${res.status}`);
  const json = (await res.json()) as { id_token?: unknown };
  if (typeof json.id_token !== 'string') throw new Error('google token response had no id_token');
  return json.id_token;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function requestOrigin(request: FastifyRequest): string {
  return `${request.protocol}://${request.hostname}`;
}

function redirectUriFor(request: FastifyRequest): string {
  return `${publicUrlOrOrigin(requestOrigin(request))}/api/auth/google/callback`;
}

function redirectToLoginError(reply: FastifyReply, request: FastifyRequest, code: GoogleAuthErrorCode): void {
  const base = publicUrlOrOrigin(requestOrigin(request));
  reply.redirect(`${base}/?authError=${code}`);
}

export function registerGoogleAuthRoutes(app: FastifyInstance): void {
  app.get('/api/auth/google/start', async (request, reply) => {
    if (!isGoogleEnabled()) return redirectToLoginError(reply, request, 'exchange');

    const config = getGoogleConfig();
    const state = randomUrlSafeToken(24);
    const codeVerifier = randomUrlSafeToken(32);
    setOAuthCookie(reply, { state, codeVerifier });

    const url = new URL(GOOGLE_AUTH_ENDPOINT);
    url.searchParams.set('client_id', config.clientId!);
    url.searchParams.set('redirect_uri', redirectUriFor(request));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('access_type', 'online');
    url.searchParams.set('prompt', 'select_account');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallengeFor(codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');

    reply.redirect(url.toString());
  });

  app.get('/api/auth/google/callback', async (request, reply) => {
    const cookiePayload = readOAuthCookie(request);
    clearOAuthCookie(reply);

    if (!isGoogleEnabled()) return redirectToLoginError(reply, request, 'exchange');

    const query = request.query as { code?: string; state?: string; error?: string };

    if (!cookiePayload || !query.state || !timingSafeEqualStrings(query.state, cookiePayload.state)) {
      return redirectToLoginError(reply, request, 'state');
    }
    if (query.error || !query.code) {
      request.log.warn({ error: query.error }, 'google oauth callback: no code (denied or error param)');
      return redirectToLoginError(reply, request, 'exchange');
    }

    const config = getGoogleConfig();
    let idToken: string;
    try {
      idToken = await exchangeCodeForIdToken(query.code, cookiePayload.codeVerifier, redirectUriFor(request), config);
    } catch (err) {
      request.log.error({ err: err instanceof Error ? err.message : err }, 'google oauth token exchange failed');
      return redirectToLoginError(reply, request, 'exchange');
    }

    const payload = decodeIdTokenPayload(idToken, config.clientId!);
    if (!payload) {
      request.log.error('google oauth: id_token did not decode to the expected shape, or failed its aud/iss/exp check');
      return redirectToLoginError(reply, request, 'exchange');
    }
    if (!payload.email_verified) {
      request.log.warn({ email: payload.email }, 'google oauth: rejected, email not verified');
      return redirectToLoginError(reply, request, 'unverified');
    }
    if (!isAllowedGoogleDomain(payload.email, payload.hd, config.allowedDomains)) {
      request.log.warn({ email: payload.email, hd: payload.hd }, 'google oauth: rejected, domain not allowed');
      return redirectToLoginError(reply, request, 'domain');
    }

    const resolution = await resolveGoogleUser<store.StoredUser>(
      { sub: payload.sub, email: payload.email },
      { findByGoogleSub: store.findStoredUserByGoogleSub, findByEmail: store.findStoredUserByEmail },
    );

    let user: { id: string; disabled?: boolean };
    if (resolution.kind === 'existing') {
      user = resolution.user;
    } else if (resolution.kind === 'link') {
      user = await store.linkGoogleAccount(resolution.user.id, payload.sub);
    } else {
      user = await store.createUser({
        email: payload.email,
        name: payload.name || payload.given_name || payload.email,
        isAdmin: false,
        googleSub: payload.sub,
      });
    }

    if (user.disabled) {
      request.log.warn({ userId: user.id }, 'google oauth: rejected, account disabled');
      return redirectToLoginError(reply, request, 'disabled');
    }

    const { token } = await store.createSession(user.id);
    session.setSessionCookie(reply, token);
    reply.redirect(`${publicUrlOrOrigin(requestOrigin(request))}/`);
  });
}
