/**
 * "Connect Folio" — linking a chat user to a Folio user. Two identities have to be proven in ONE
 * browser, or a link could be planted on someone else:
 *
 *   Slack:  GET /api/integrations/slack/connect           (the button of the unfurl-auth prompt)
 *             → Sign in with Slack (OpenID Connect, scope openid profile): proves the Slack user
 *           GET /api/integrations/slack/oidc/callback
 *             → Folio's own OAuth (/oauth/authorize, client folio_chat_slack, PKCE, scope read):
 *               the Folio login and consent screen prove the Folio user
 *           GET /api/integrations/chat/callback            → link stored, the waiting messages unfurled
 *
 *   Teams:  GET /api/integrations/teams/connect?ticket=…  (the sign-in URL of the auth response;
 *               the ticket names the Teams user the bot saw, signed — ticket.ts)
 *             → Folio's own OAuth (client folio_chat_teams)
 *           GET /api/integrations/chat/callback            → tokens parked, the page hands Teams a
 *               one-time code (TeamsJS authentication.notifySuccess); the link is completed only
 *               when Teams sends that code back in an invoke of the SAME Teams user (teams.ts).
 *
 * The browser is bound by a short-lived HttpOnly cookie holding the attempt's nonce, which is
 * also the OAuth `state` of both legs; the server keeps only its sha256 (links.ts). A callback
 * without the matching cookie is refused, so a code or state handed to another browser is
 * useless. Nothing here logs a code, a token, a nonce or a ticket.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { cookiesSecure } from '../../auth/session.js';
import { escapeHtml } from '../../oauth/consentPage.js';
import { exchangeAuthorizationCode } from '../../oauth/exchange.js';
import { issuerFor, mcpResourceFor } from '../../oauth/routes.js';
import { resolveTextLanguage, serverText, type ServerTextKey } from '../../serverText.js';
import { PLATFORM_LABEL, slackConfig, teamsConfig, type ChatPlatform } from './config.js';
import { chatFetch } from './http.js';
import {
  INTERNAL_CLIENTS,
  PENDING_TTL_SECONDS,
  chatCallbackUrl,
  createPending,
  deletePending,
  ensureInternalClient,
  getPending,
  parkTeamsTokens,
  randomSecret,
  saveLink,
  setPendingIdentity,
} from './links.js';
import { replayPendingUnfurls, runInBackground } from './slack.js';
import { verifyTicket } from './ticket.js';

export const CONNECT_COOKIE = 'folio_chat_connect';
const COOKIE_PATH = '/api/integrations';
export const SLACK_OIDC_AUTHORIZE = 'https://slack.com/openid/connect/authorize';
export const SLACK_OIDC_TOKEN = 'https://slack.com/api/openid.connect.token';
/** TeamsJS on Microsoft's CDN, pinned with Subresource Integrity. */
export const TEAMS_JS_URL = 'https://res.cdn.office.net/teams-js/2.34.0/js/MicrosoftTeams.min.js';
const TEAMS_JS_SRI = 'sha384-brW9AazbKR2dYw2DucGgWCCcmrm2oBFV4HQidyuyZRI/TnAkmOOnTARSTdps3Hwt';

export function slackOidcCallbackUrl(base: string): string {
  return `${base}/api/integrations/slack/oidc/callback`;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

type ChatTextKey = Extract<ServerTextKey, `chat.${string}`>;

function text(lang: string, key: ChatTextKey, vars: Record<string, string> = {}): string {
  return escapeHtml(serverText(key, lang)).replace(/\{(\w+)\}/g, (_, name: string) => escapeHtml(vars[name] ?? ''));
}

const STYLE = `
:root{color-scheme:light dark}
body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f5f4;color:#1c1917;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
main{background:#fff;max-width:480px;width:100%;border-radius:12px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.15)}
h1{font-size:20px;margin:0 0 8px}p{margin:8px 0}.muted{color:#57534e;font-size:14px}
@media (prefers-color-scheme:dark){body{background:#0c0a09;color:#e7e5e4}main{background:#1c1917}.muted{color:#a8a29e}}
`;

function page(lang: string, heading: string, body: string, head = ''): string {
  return `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>${text(lang, 'chat.title')}</title><style>${STYLE}</style>${head}</head><body><main><h1>${heading}</h1>${body}</main></body></html>`;
}

const BASE_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};
const STATIC_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'";

function langOf(request: FastifyRequest): string {
  return resolveTextLanguage(null, request.headers['accept-language']);
}

function sendPage(reply: FastifyReply, status: number, html: string, csp = STATIC_CSP): FastifyReply {
  return reply.status(status).headers({ ...BASE_HEADERS, 'x-frame-options': 'DENY', 'content-security-policy': csp }).send(html);
}

function failPage(request: FastifyRequest, reply: FastifyReply, status: number, key: ChatTextKey, platform?: ChatPlatform): FastifyReply {
  const lang = langOf(request);
  clearConnectCookie(reply);
  return sendPage(reply, status, page(lang, text(lang, 'chat.failedHeading'), `<p>${text(lang, key, { platform: platform ? PLATFORM_LABEL[platform] : '' })}</p>`));
}

function connectedPage(request: FastifyRequest, reply: FastifyReply, platform: ChatPlatform): FastifyReply {
  const lang = langOf(request);
  const vars = { platform: PLATFORM_LABEL[platform] };
  return sendPage(reply, 200, page(lang, text(lang, 'chat.connectedHeading', vars), `<p>${text(lang, 'chat.connectedBody', vars)}</p>`));
}

/** Runs inside Teams' sign-in popup: hands Teams the one-time code. Shown in any other browser, it does nothing. */
function teamsFinishPage(request: FastifyRequest, reply: FastifyReply, magicCode: string): FastifyReply {
  const lang = langOf(request);
  const nonce = randomSecret(16);
  const script = `(function(){var el=document.getElementById('folio-code');var code=el&&el.getAttribute('data-code');if(!code||!window.microsoftTeams)return;microsoftTeams.app.initialize().then(function(){microsoftTeams.authentication.notifySuccess(code);}).catch(function(){});})();`;
  const body = `<p>${text(lang, 'chat.teamsFinishing')}</p><div id="folio-code" data-code="${escapeHtml(magicCode)}" hidden></div>`
    + `<script src="${TEAMS_JS_URL}" integrity="${TEAMS_JS_SRI}" crossorigin="anonymous"></script><script nonce="${nonce}">${script}</script>`;
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src https://res.cdn.office.net 'nonce-${nonce}'; connect-src 'none'; base-uri 'none'`;
  // No frame-ancestors / X-Frame-Options here: Teams opens this page in its own sign-in window.
  return reply.status(200).headers({ ...BASE_HEADERS, 'content-security-policy': csp }).send(page(lang, escapeHtml(PLATFORM_LABEL.teams), body));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setConnectCookie(reply: FastifyReply, nonce: string): void {
  reply.setCookie(CONNECT_COOKIE, nonce, { httpOnly: true, sameSite: 'lax', secure: cookiesSecure(reply.request), maxAge: PENDING_TTL_SECONDS, path: COOKIE_PATH });
}
function clearConnectCookie(reply: FastifyReply): void {
  reply.clearCookie(CONNECT_COOKIE, { path: COOKIE_PATH });
}

type Params = Record<string, string | undefined>;
function asParams(raw: unknown): Params {
  const out: Params = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
  return out;
}

/** The attempt this browser started, by its cookie, when the `state` it came back with is that attempt's. */
async function boundAttempt(request: FastifyRequest, state: string | undefined) {
  const cookie = request.cookies?.[CONNECT_COOKIE];
  if (!cookie || !state || cookie !== state) return undefined;
  const pending = await getPending(state);
  return pending ? { nonce: state, pending } : undefined;
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomSecret(48);
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** Sends the browser to Folio's consent screen for `platform`'s internal client. */
async function redirectToFolioConsent(request: FastifyRequest, reply: FastifyReply, platform: ChatPlatform, nonce: string, challenge: string): Promise<FastifyReply> {
  const base = issuerFor(request);
  await ensureInternalClient(platform, base);
  const u = new URL(`${base}/oauth/authorize`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', INTERNAL_CLIENTS[platform].clientId);
  u.searchParams.set('redirect_uri', chatCallbackUrl(base));
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('scope', 'read');
  u.searchParams.set('state', nonce);
  u.searchParams.set('resource', mcpResourceFor(base));
  reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
  return reply.redirect(u.toString(), 302);
}

/** Claims of a Slack OpenID Connect id_token received straight from Slack's token endpoint over TLS (OIDC Core §3.1.3.7). */
export function decodeSlackIdToken(idToken: string): Record<string, unknown> | null {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Routes (public scope: each does its own checks)
// ---------------------------------------------------------------------------

const hits = new Map<string, number[]>();
function limited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => t > now - 60_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > 30;
}
export function __resetConnectRateLimitForTests(): void {
  hits.clear();
}

export function registerChatConnectRoutes(app: FastifyInstance): void {
  app.get('/api/integrations/slack/connect', async (request, reply) => {
    if (limited(request.ip)) return failPage(request, reply, 429, 'chat.failed');
    const cfg = slackConfig();
    if (!cfg) return failPage(request, reply, 404, 'chat.notConfigured', 'slack');
    const oidcNonce = randomSecret(16);
    const nonce = await createPending('slack', { oidcNonce });
    setConnectCookie(reply, nonce);
    const u = new URL(SLACK_OIDC_AUTHORIZE);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'openid profile');
    u.searchParams.set('client_id', cfg.clientId);
    u.searchParams.set('state', nonce);
    u.searchParams.set('nonce', oidcNonce);
    u.searchParams.set('redirect_uri', slackOidcCallbackUrl(issuerFor(request)));
    if (cfg.teamId) u.searchParams.set('team', cfg.teamId);
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    return reply.redirect(u.toString(), 302);
  });

  app.get('/api/integrations/slack/oidc/callback', async (request, reply) => {
    const cfg = slackConfig();
    if (!cfg) return failPage(request, reply, 404, 'chat.notConfigured', 'slack');
    const q = asParams(request.query);
    const attempt = await boundAttempt(request, q.state);
    if (!attempt || attempt.pending.platform !== 'slack' || !attempt.pending.oidcNonce) return failPage(request, reply, 400, 'chat.expired');
    if (q.error || !q.code) {
      await deletePending(attempt.nonce);
      return failPage(request, reply, 400, 'chat.denied');
    }
    const base = issuerFor(request);
    let claims: Record<string, unknown> | null = null;
    try {
      const res = await chatFetch(SLACK_OIDC_TOKEN, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code: q.code, redirect_uri: slackOidcCallbackUrl(base), grant_type: 'authorization_code' }).toString(),
      });
      const json = (await res.json()) as { ok?: boolean; id_token?: unknown };
      if (json.ok === true && typeof json.id_token === 'string') claims = decodeSlackIdToken(json.id_token);
    } catch (err) {
      request.log.warn({ err: String(err) }, 'slack openid token exchange failed');
    }
    const teamId = claims?.['https://slack.com/team_id'];
    const userId = claims?.['https://slack.com/user_id'];
    const exp = claims?.exp;
    const valid =
      claims !== null &&
      claims.iss === 'https://slack.com' &&
      (claims.aud === cfg.clientId || (Array.isArray(claims.aud) && claims.aud.includes(cfg.clientId))) &&
      claims.nonce === attempt.pending.oidcNonce &&
      typeof exp === 'number' &&
      exp * 1000 > Date.now() &&
      typeof teamId === 'string' &&
      typeof userId === 'string';
    if (!valid) {
      await deletePending(attempt.nonce);
      return failPage(request, reply, 400, 'chat.failed');
    }
    if (cfg.teamId && teamId !== cfg.teamId) {
      await deletePending(attempt.nonce);
      return failPage(request, reply, 403, 'chat.wrongWorkspace', 'slack');
    }
    const name = typeof claims!.name === 'string' ? claims!.name.slice(0, 200) : null;
    const { verifier, challenge } = pkcePair();
    await setPendingIdentity(attempt.nonce, { tenantId: teamId as string, platformUserId: userId as string, platformUserName: name }, verifier);
    return redirectToFolioConsent(request, reply, 'slack', attempt.nonce, challenge);
  });

  app.get('/api/integrations/teams/connect', async (request, reply) => {
    if (limited(request.ip)) return failPage(request, reply, 429, 'chat.failed');
    if (!teamsConfig()) return failPage(request, reply, 404, 'chat.notConfigured', 'teams');
    const ticket = verifyTicket(asParams(request.query).ticket);
    if (!ticket) {
      const lang = langOf(request);
      return sendPage(reply, 400, page(lang, text(lang, 'chat.title'), `<p>${text(lang, 'chat.teamsPasteAgain')}</p>`));
    }
    const { verifier, challenge } = pkcePair();
    const nonce = await createPending('teams', { identity: ticket, codeVerifier: verifier });
    setConnectCookie(reply, nonce);
    return redirectToFolioConsent(request, reply, 'teams', nonce, challenge);
  });

  // Folio's own OAuth comes back here, for both platforms.
  app.get('/api/integrations/chat/callback', async (request, reply) => {
    const q = asParams(request.query);
    const attempt = await boundAttempt(request, q.state);
    const identity = attempt?.pending.identity;
    const codeVerifier = attempt?.pending.codeVerifier;
    if (!attempt || !identity || !codeVerifier) return failPage(request, reply, 400, 'chat.expired');
    const { nonce, pending } = attempt;
    const base = issuerFor(request);
    if (q.iss !== undefined && q.iss !== base) {
      await deletePending(nonce);
      return failPage(request, reply, 400, 'chat.failed');
    }
    if (q.error || !q.code) {
      await deletePending(nonce);
      return failPage(request, reply, 400, 'chat.denied');
    }
    const out = await exchangeAuthorizationCode({
      clientId: INTERNAL_CLIENTS[pending.platform].clientId,
      code: q.code,
      redirectUri: chatCallbackUrl(base),
      codeVerifier,
    });
    if (!out.ok || !out.scopes.includes('read')) {
      await deletePending(nonce);
      return failPage(request, reply, 400, 'chat.failed');
    }
    clearConnectCookie(reply);
    if (pending.platform === 'slack') {
      await saveLink({ platform: 'slack', identity, userId: out.userId, tokens: out.tokens });
      await deletePending(nonce);
      runInBackground(() => replayPendingUnfurls(identity.tenantId, identity.platformUserId, base, request.log), request.log);
      return connectedPage(request, reply, 'slack');
    }
    // Teams: the link waits for the popup's code to come back through Teams.
    const magic = await parkTeamsTokens(nonce, out.userId, out.tokens);
    return teamsFinishPage(request, reply, magic);
  });
}

