/**
 * "Connect with GitHub": links a github.com account to the CURRENTLY signed-in
 * Folio user through a GitHub OAuth App (authorization code + PKCE) and saves
 * the resulting token as that user's github.com git credential — the same row
 * a pasted PAT would occupy (server/userGitCredentials.ts, one per user+host,
 * so connecting replaces an earlier github.com PAT). It is NOT a way to sign
 * in to Folio: both routes require an existing cookie session.
 *
 *   GET /api/auth/github-connect/start    — redirects to GitHub's consent screen.
 *   GET /api/auth/github-connect/callback — exchanges the code, saves the token,
 *                                           redirects back into the app.
 *
 * Both are registered in the PUBLIC scope next to the Google routes (see
 * index.ts) and do their own cookie-session check: a PAT (Bearer) must never be
 * able to start or finish this flow, and an absent session ends in a redirect
 * the SPA can explain, not a JSON 401 shown as a raw page.
 *
 * Why an OAuth App and not a GitHub App: OAuth App user tokens do not expire,
 * so a connected space keeps syncing without a refresh-token dance; a GitHub
 * App's user tokens expire after 8 hours.
 *
 * Scope: only `repo` (full control of private repositories, which includes
 * reading and pushing). `read:org` is NOT requested: GET /user/repos already
 * returns every repository the user can reach, organization repositories
 * included, with just `repo`. `read:org` only adds reading org/team
 * membership, which Folio never does. What does gate organization repositories
 * is the organization's "third-party application access" policy — if it is
 * restricted, an org owner must approve this OAuth App once; until then the
 * org's private repositories are simply missing from the list.
 *
 * Every outcome redirects to `<app><returnTo>?gitConnect=<code>` (`ok` or an
 * error code below) so the SPA can reopen "Git access" and show a toast. The
 * one-time code, the token and the state value are never logged.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as session from './session.js';
import { publicUrlOrOrigin } from '../publicUrl.js';
import { decryptSecret, encryptSecret, hasSecretConfigured } from '../secretCrypto.js';
import * as userGitCredentials from '../userGitCredentials.js';
import { recordAudit } from '../audit.js';
import { isDemoMode } from '../demo.js';
import { safeReturnPath } from './returnPath.js';

export const GITHUB_CONNECT_START_PATH = '/api/auth/github-connect/start';
export const GITHUB_CONNECT_CALLBACK_PATH = '/api/auth/github-connect/callback';
const STATE_COOKIE_NAME = 'folio_github_connect';
const STATE_COOKIE_TTL_SECONDS = 10 * 60;
const GITHUB_HOST = 'github.com';
const SCOPE = 'repo';
const PROVIDER_TIMEOUT_MS = 15_000;

/** Query value of `?gitConnect=` on the way back into the app. */
export type GitHubConnectResult = 'ok' | 'denied' | 'state' | 'exchange' | 'scope' | 'save' | 'session' | 'disabled' | 'demo';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GitHubEndpoints {
  /** Consent screen, e.g. https://github.com/login/oauth/authorize */
  authorizeUrl: string;
  /** Code-for-token exchange, e.g. https://github.com/login/oauth/access_token */
  tokenUrl: string;
  /** REST API base (no trailing slash), e.g. https://api.github.com */
  apiBaseUrl: string;
}

const DEFAULT_ENDPOINTS: GitHubEndpoints = {
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  apiBaseUrl: 'https://api.github.com',
};

let endpointOverrides: Partial<GitHubEndpoints> | null = null;

/** Tests point the flow at a local mock server; null restores the real github.com endpoints. */
export function __setGitHubEndpointsForTests(overrides: Partial<GitHubEndpoints> | null): void {
  endpointOverrides = overrides;
}

function endpoints(): GitHubEndpoints {
  return { ...DEFAULT_ENDPOINTS, ...(endpointOverrides ?? {}) };
}

function clientCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET both set, FOLIO_SECRET set (the
 * token is stored encrypted with it, and the state cookie is sealed with it),
 * and not the public demo. Drives FolioConfig.githubOAuth, so the button only
 * appears where the flow can actually finish.
 */
export function isGitHubConnectEnabled(): boolean {
  return clientCredentials() !== null && hasSecretConfigured() && !isDemoMode();
}

// ---------------------------------------------------------------------------
// State cookie: state + PKCE verifier + the user it was started for, sealed
// with AES-GCM (secretCrypto) so it can be neither read nor forged.
// ---------------------------------------------------------------------------

interface StatePayload {
  state: string;
  codeVerifier: string;
  userId: string;
  returnTo: string;
}

function randomUrlSafeToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function codeChallengeFor(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function setStateCookie(reply: FastifyReply, payload: StatePayload): void {
  reply.setCookie(STATE_COOKIE_NAME, encryptSecret(JSON.stringify(payload)).toString('base64url'), {
    httpOnly: true,
    sameSite: 'lax',
    secure: session.cookiesSecure(),
    maxAge: STATE_COOKIE_TTL_SECONDS,
    path: GITHUB_CONNECT_CALLBACK_PATH,
  });
}

function readStateCookie(request: FastifyRequest): StatePayload | null {
  const raw = request.cookies?.[STATE_COOKIE_NAME];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decryptSecret(Buffer.from(raw, 'base64url'))) as Partial<StatePayload>;
    if (
      typeof parsed.state === 'string' &&
      typeof parsed.codeVerifier === 'string' &&
      typeof parsed.userId === 'string' &&
      typeof parsed.returnTo === 'string'
    ) {
      return parsed as StatePayload;
    }
    return null;
  } catch {
    return null;
  }
}

function clearStateCookie(reply: FastifyReply): void {
  reply.clearCookie(STATE_COOKIE_NAME, { path: GITHUB_CONNECT_CALLBACK_PATH });
}

export { safeReturnPath };

// ---------------------------------------------------------------------------
// GitHub calls
// ---------------------------------------------------------------------------

class ConnectError extends Error {
  constructor(
    readonly result: GitHubConnectResult,
    message: string,
  ) {
    super(message);
  }
}

async function exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<string> {
  const creds = clientCredentials()!;
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  // NEVER log `body` (client secret + one-time code) or the response (token).
  const res = await fetch(endpoints().tokenUrl, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!res.ok) throw new ConnectError('exchange', `github token endpoint responded ${res.status}`);
  // GitHub answers 200 with {"error": "..."} for a bad/expired code.
  const json = (await res.json()) as { access_token?: unknown; scope?: unknown; error?: unknown };
  if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
    throw new ConnectError('exchange', `github token response had no access_token (error: ${typeof json.error === 'string' ? json.error : 'none'})`);
  }
  if (typeof json.scope === 'string') {
    const granted = json.scope.split(/[,\s]+/).filter(Boolean);
    if (!granted.includes(SCOPE)) throw new ConnectError('scope', `github granted scopes without "${SCOPE}"`);
  }
  return json.access_token;
}

async function fetchLogin(token: string): Promise<string> {
  const res = await fetch(`${endpoints().apiBaseUrl}/user`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'Folio',
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!res.ok) throw new ConnectError('exchange', `github /user responded ${res.status}`);
  const json = (await res.json()) as { login?: unknown };
  if (typeof json.login !== 'string' || json.login.length === 0) throw new ConnectError('exchange', 'github /user had no login');
  return json.login;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function appBase(request: FastifyRequest): string {
  return publicUrlOrOrigin(`${request.protocol}://${request.hostname}`);
}

function redirectUriFor(request: FastifyRequest): string {
  return `${appBase(request)}${GITHUB_CONNECT_CALLBACK_PATH}`;
}

function redirectBack(reply: FastifyReply, request: FastifyRequest, result: GitHubConnectResult, returnTo = '/'): void {
  reply.redirect(`${appBase(request)}${returnTo}?gitConnect=${result}`);
}

/** The signed-in user from the SESSION COOKIE only — a Bearer PAT is deliberately not accepted here. */
async function cookieUser(request: FastifyRequest) {
  return session.userForToken(request.cookies?.[session.SESSION_COOKIE_NAME]);
}

export function registerGitHubConnectRoutes(app: FastifyInstance): void {
  app.get(GITHUB_CONNECT_START_PATH, async (request, reply) => {
    const returnTo = safeReturnPath((request.query as { returnTo?: unknown }).returnTo);
    if (isDemoMode()) return redirectBack(reply, request, 'demo', returnTo);
    if (!isGitHubConnectEnabled()) return redirectBack(reply, request, 'disabled', returnTo);
    const user = await cookieUser(request);
    if (!user) return redirectBack(reply, request, 'session', returnTo);

    const state = randomUrlSafeToken(24);
    const codeVerifier = randomUrlSafeToken(32);
    setStateCookie(reply, { state, codeVerifier, userId: user.id, returnTo });

    const url = new URL(endpoints().authorizeUrl);
    url.searchParams.set('client_id', clientCredentials()!.clientId);
    url.searchParams.set('redirect_uri', redirectUriFor(request));
    url.searchParams.set('scope', SCOPE);
    url.searchParams.set('state', state);
    url.searchParams.set('allow_signup', 'false');
    url.searchParams.set('code_challenge', codeChallengeFor(codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');
    reply.redirect(url.toString());
  });

  app.get(GITHUB_CONNECT_CALLBACK_PATH, async (request, reply) => {
    const payload = readStateCookie(request);
    clearStateCookie(reply);
    const returnTo = payload?.returnTo ?? '/';

    if (isDemoMode()) return redirectBack(reply, request, 'demo', returnTo);
    if (!isGitHubConnectEnabled()) return redirectBack(reply, request, 'disabled', returnTo);

    const user = await cookieUser(request);
    if (!user) return redirectBack(reply, request, 'session', returnTo);

    const query = request.query as { code?: string; state?: string; error?: string };
    // The state must match AND belong to the session that started the flow —
    // a callback finished in somebody else's browser session saves nothing.
    if (!payload || !query.state || !timingSafeEqualStrings(query.state, payload.state) || payload.userId !== user.id) {
      request.log.warn('github connect callback: state missing or mismatched');
      return redirectBack(reply, request, 'state', returnTo);
    }
    if (query.error === 'access_denied') return redirectBack(reply, request, 'denied', returnTo);
    if (query.error || !query.code) {
      request.log.warn({ error: query.error }, 'github connect callback: no code');
      return redirectBack(reply, request, 'exchange', returnTo);
    }

    let token: string;
    let login: string;
    try {
      token = await exchangeCode(query.code, payload.codeVerifier, redirectUriFor(request));
      login = await fetchLogin(token);
    } catch (err) {
      const result = err instanceof ConnectError ? err.result : 'exchange';
      request.log.error({ reason: err instanceof Error ? err.message : 'unknown' }, 'github connect: token exchange failed');
      return redirectBack(reply, request, result, returnTo);
    }

    try {
      const saved = await userGitCredentials.saveCredential(user.id, GITHUB_HOST, 'github', token, `@${login}`, {
        source: 'oauth',
        accountLogin: login,
      });
      recordAudit(user.id, 'git_credential.saved', saved.id, { host: saved.host, provider: saved.provider, source: 'oauth' });
    } catch (err) {
      request.log.error({ reason: err instanceof Error ? err.message : 'unknown' }, 'github connect: saving the credential failed');
      return redirectBack(reply, request, 'save', returnTo);
    }
    redirectBack(reply, request, 'ok', returnTo);
  });
}
