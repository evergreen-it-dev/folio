/**
 * OAuth 2.1 authorization server endpoints (RFC 6749 + PKCE RFC 7636, RFC 8414 metadata, RFC 7591
 * dynamic registration, Client ID Metadata Documents, RFC 7009 revocation, RFC 8707 resource
 * indicators, RFC 9207 `iss`) plus RFC 9728 protected-resource metadata for /mcp.
 *
 * Folio is both the authorization server and the only resource server. Design rules:
 *   - Public clients only (token_endpoint_auth_method "none"); PKCE S256 is mandatory, "plain" does not exist.
 *   - redirect_uri: https or loopback, EXACT match against what the client registered. Errors found
 *     before the redirect_uri is trusted are shown on an HTML page; afterwards they go to the client.
 *   - The consent decision is a POST whose single-use request id (bound to the logged-in user in
 *     the DB) is the CSRF token. Only the COOKIE session counts here: a PAT or an OAuth token can
 *     never approve a new connection.
 *   - Access tokens are audience-bound to the /mcp URL and are NOT accepted on the REST API.
 *   - Nothing here logs a token, code, verifier or request id.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiTokenScope, User } from '../../shared/contracts.js';
import { captureServerEvent, clientNameProp } from '../analytics.js';
import { recordAudit } from '../audit.js';
import * as authStore from '../auth/store.js';
import * as session from '../auth/session.js';
import { publicUrlOrOrigin } from '../publicUrl.js';
import { isDemoMode } from '../demo.js';
import { DEMO_OAUTH_PER_MINUTE } from '../demoLimits.js';
import { notFound } from '../errors.js';
import { ClientMetadataError, fetchClientMetadata, isMetadataClientId } from './cimd.js';
import { CONSENT_HEADERS, pickLang, renderConsentPage, renderErrorPage } from './consentPage.js';
import * as store from './store.js';
import {
  MAX_REDIRECT_URIS,
  SUPPORTED_SCOPES,
  isValidCodeChallenge,
  isValidCodeVerifier,
  parseRequestedScopes,
  pkceMatches,
  redirectHost,
  redirectUriError,
  redirectUriMatches,
  sanitizeDisplayName,
} from './validate.js';

const CIMD_CACHE_SECONDS = 60 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OAuthRouteOptions {
  /** Shows the SPA (its login screen) at the current URL; the SPA resumes the flow by reloading once logged in. */
  serveSpa: (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Origin / metadata
// ---------------------------------------------------------------------------

/** PUBLIC_URL wins; the request's own Host (WITH port: Fastify's `hostname` drops it) is only the fallback for an instance that never set one. */
export function issuerFor(request: FastifyRequest): string {
  return publicUrlOrOrigin(`${request.protocol}://${request.host}`);
}
export function mcpResourceFor(issuer: string): string {
  return `${issuer}/mcp`;
}
/** What a 401 from /mcp points clients at (RFC 9728 §3.1: the path-inserted well-known URL of the resource). */
export function protectedResourceMetadataUrl(request: FastifyRequest): string {
  return `${issuerFor(request)}/.well-known/oauth-protected-resource/mcp`;
}

export function buildProtectedResourceMetadata(issuer: string): Record<string, unknown> {
  return {
    resource: mcpResourceFor(issuer),
    authorization_servers: [issuer],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Folio MCP',
  };
}

export function buildAuthorizationServerMetadata(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    scopes_supported: [...SUPPORTED_SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

// ---------------------------------------------------------------------------
// Rate limiting (in memory, per IP and bucket: these endpoints are unauthenticated)
// ---------------------------------------------------------------------------

const hits = new Map<string, number[]>();
function rateLimited(bucket: string, ip: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const key = `${bucket}|${ip}`;
  const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.every((t) => t <= now - 3_600_000)) hits.delete(k);
  }
  return false;
}
/** Public demo only: the extra per-IP cap on the two endpoints that mint credentials (POST /oauth/authorize, POST /oauth/token). */
function demoOAuthLimited(bucket: string, ip: string): boolean {
  return isDemoMode() && rateLimited(`demo-${bucket}`, ip, DEMO_OAUTH_PER_MINUTE, 60 * 1000);
}
export function __resetOAuthRateLimitsForTests(): void {
  hits.clear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Params = Record<string, string | undefined>;

/** First value of each query/body key as a plain string map (an array or object value, as `a[]=1` would give, is treated as absent). */
function asParams(raw: unknown): Params {
  const out: Params = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
  return out;
}

function oauthError(reply: FastifyReply, status: number, error: string, description: string): FastifyReply {
  reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
  return reply.status(status).send({ error, error_description: description });
}

function htmlError(reply: FastifyReply, status: number, message: string, lang: ReturnType<typeof pickLang> = 'en'): FastifyReply {
  return reply.status(status).headers(CONSENT_HEADERS).send(renderErrorPage(lang, message));
}

function redirectToClient(reply: FastifyReply, redirectUri: string, issuer: string, params: Record<string, string | null | undefined>): FastifyReply {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  url.searchParams.set('iss', issuer);
  reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
  return reply.redirect(url.toString(), 302);
}

/** The user behind the browser COOKIE session only: a PAT or OAuth token must never approve a new connection. */
async function cookieUser(request: FastifyRequest): Promise<User | null> {
  return session.userForToken(request.cookies?.[session.SESSION_COOKIE_NAME]);
}

/** DCR clients come from the DB; a CIMD client_id (https URL) is fetched, validated and cached for an hour. */
async function resolveClient(clientId: string): Promise<store.OAuthClient> {
  const cached = await store.getClient(clientId);
  if (!isMetadataClientId(clientId)) {
    if (!cached || cached.source !== 'dcr') throw new ClientMetadataError('unknown client_id');
    return cached;
  }
  if (cached?.fetchedAt && Date.now() - cached.fetchedAt.getTime() < CIMD_CACHE_SECONDS * 1000) return cached;
  try {
    return await store.upsertCimdClient(await fetchClientMetadata(clientId));
  } catch (err) {
    // A transient network failure must not lock out a client that was fine a moment ago; a document that is now INVALID must.
    if (cached && err instanceof ClientMetadataError && /fetch|timed out|answered HTTP|resolves to|could not/.test(err.message)) return cached;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function registerOAuthRoutes(app: FastifyInstance, opts: OAuthRouteOptions): Promise<void> {
  // Discovery documents are public and cacheable. Both the plain and the path-inserted form of
  // the protected-resource URL are served: clients try either, depending on their version.
  const discovery = (build: (issuer: string) => Record<string, unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'public, max-age=300');
    return build(issuerFor(request));
  };
  app.get('/.well-known/oauth-protected-resource', discovery(buildProtectedResourceMetadata));
  app.get('/.well-known/oauth-protected-resource/mcp', discovery(buildProtectedResourceMetadata));
  app.get('/.well-known/oauth-authorization-server', discovery(buildAuthorizationServerMetadata));

  // OAuth endpoints take application/x-www-form-urlencoded (token, revoke, the consent form), which Fastify does not parse by itself.
  await app.register(async (oauth) => {
    oauth.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error);
      }
    });

    // --- Dynamic Client Registration (RFC 7591) ---------------------------
    oauth.post('/oauth/register', async (request, reply) => {
      if (rateLimited('register', request.ip, 20, 60 * 60 * 1000)) return oauthError(reply, 429, 'temporarily_unavailable', 'too many registrations, try again later');
      const body = typeof request.body === 'object' && request.body !== null ? (request.body as Record<string, unknown>) : null;
      if (!body) return oauthError(reply, 400, 'invalid_client_metadata', 'request body must be a JSON object');
      const uris = body.redirect_uris;
      if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
        return oauthError(reply, 400, 'invalid_redirect_uri', `redirect_uris must be an array of 1-${MAX_REDIRECT_URIS} URLs`);
      }
      for (const uri of uris) {
        const problem = redirectUriError(uri);
        if (problem) return oauthError(reply, 400, 'invalid_redirect_uri', problem);
      }
      if (body.grant_types !== undefined) {
        const gts = body.grant_types;
        if (!Array.isArray(gts) || gts.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
          return oauthError(reply, 400, 'invalid_client_metadata', 'grant_types may only contain authorization_code and refresh_token');
        }
      }
      if (body.response_types !== undefined && (!Array.isArray(body.response_types) || body.response_types.some((r) => r !== 'code'))) {
        return oauthError(reply, 400, 'invalid_client_metadata', 'response_types may only contain code');
      }
      // Folio only has public clients: whatever auth method was asked for, the registered one is "none" (RFC 7591 §3.2.1 lets the server substitute).
      const clientUri = typeof body.client_uri === 'string' && redirectUriError(body.client_uri) === null ? body.client_uri : null;
      const client = await store.createDcrClient({
        clientName: sanitizeDisplayName(body.client_name, 'Unnamed app'),
        redirectUris: [...new Set(uris as string[])],
        clientUri,
      });
      void store.pruneStale().catch(() => {});
      recordAudit(null, 'oauth.client_registered', client.clientId, { name: client.clientName, source: 'dcr' });
      reply.header('cache-control', 'no-store');
      reply.status(201);
      return {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: SUPPORTED_SCOPES.join(' '),
      };
    });

    // --- Authorization endpoint -------------------------------------------
    oauth.get('/oauth/authorize', async (request, reply) => {
      if (rateLimited('authorize', request.ip, 60, 60 * 1000)) return htmlError(reply, 429, 'Too many requests. Try again in a minute.');
      const q = asParams(request.query);
      const issuer = issuerFor(request);

      // 1. Client and redirect_uri: until both are trusted, errors are shown here and never redirected.
      if (!q.client_id) return htmlError(reply, 400, 'The request is missing client_id.');
      let client: store.OAuthClient;
      try {
        client = await resolveClient(q.client_id);
      } catch (err) {
        const reason = err instanceof ClientMetadataError ? err.message : 'unknown client_id';
        return htmlError(reply, 400, `This app could not be identified: ${reason}.`);
      }
      let redirectUri = q.redirect_uri;
      if (!redirectUri) {
        if (client.redirectUris.length !== 1) return htmlError(reply, 400, 'The request is missing redirect_uri.');
        redirectUri = client.redirectUris[0];
      }
      if (!redirectUriMatches(client.redirectUris, redirectUri)) {
        return htmlError(reply, 400, 'The redirect_uri does not match what this app registered.');
      }
      const trustedRedirect = redirectUri;

      // 2. Everything else can be reported to the (now trusted) client.
      const fail = (error: string, description: string) => redirectToClient(reply, trustedRedirect, issuer, { error, error_description: description, state: q.state });
      if (q.response_type !== 'code') return fail('unsupported_response_type', 'only response_type=code is supported');
      if (!isValidCodeChallenge(q.code_challenge)) return fail('invalid_request', 'a valid S256 code_challenge is required (PKCE)');
      if (q.code_challenge_method !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256');
      if (q.state && q.state.length > 2048) return fail('invalid_request', 'state is too long');
      const resource = mcpResourceFor(issuer);
      if (q.resource !== undefined && q.resource !== resource) return fail('invalid_target', `resource must be ${resource}`);
      const scopes = parseRequestedScopes(q.scope);
      if (!scopes) return fail('invalid_scope', `supported scopes: ${SUPPORTED_SCOPES.join(' ')}`);

      // 3. Login: the SPA shows its login screen at this very URL and reloads it afterwards.
      const user = await cookieUser(request);
      if (!user) {
        reply.header('cache-control', 'no-store');
        await opts.serveSpa(request, reply);
        return reply;
      }

      const requestId = await store.createAuthzRequest({
        userId: user.id,
        clientId: client.clientId,
        redirectUri: trustedRedirect,
        state: q.state ?? null,
        codeChallenge: q.code_challenge,
        requestedScopes: scopes,
        resource,
      });
      captureServerEvent('oauth_connect_started', request.cookies?.[session.SESSION_COOKIE_NAME], { client_name: clientNameProp(client.clientName) });
      return reply.status(200).headers(CONSENT_HEADERS).send(
        renderConsentPage({
          lang: pickLang(user.lang),
          clientName: client.clientName,
          clientSource: client.source,
          clientIdHost: client.source === 'cimd' ? redirectHost(client.clientId) : '',
          redirectHost: redirectHost(trustedRedirect),
          userLabel: user.email,
          requestId,
          requestedScopes: scopes,
        }),
      );
    });

    // --- Consent decision (CSRF-protected by the single-use request id) -----
    oauth.post('/oauth/authorize', async (request, reply) => {
      if (demoOAuthLimited('authorize-post', request.ip)) return htmlError(reply.header('Retry-After', '60'), 429, 'Too many requests. Try again in a minute.');
      if (rateLimited('authorize', request.ip, 60, 60 * 1000)) return htmlError(reply, 429, 'Too many requests. Try again in a minute.');
      const body = asParams(request.body);
      const user = await cookieUser(request);
      if (!user) return htmlError(reply, 401, 'Your Folio session has ended. Sign in and start the connection again.');
      if (!body.request_id) return htmlError(reply, 400, 'This authorization request is not valid.', pickLang(user.lang));
      const pending = await store.consumeAuthzRequest(body.request_id, user.id);
      if (!pending) return htmlError(reply, 400, 'This authorization request has expired or was already used.', pickLang(user.lang));
      const issuer = issuerFor(request);

      if (body.decision !== 'allow') {
        recordAudit(user.id, 'oauth.consent_denied', pending.clientId);
        return redirectToClient(reply, pending.redirectUri, issuer, { error: 'access_denied', error_description: 'the user denied the request', state: pending.state });
      }
      // read always; write only if the app asked for it AND the user left the box ticked.
      const granted: ApiTokenScope[] = pending.requestedScopes.includes('write') && body.write === '1' ? ['read', 'write'] : ['read'];
      const code = await store.createCode({
        userId: user.id,
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        scopes: granted,
        resource: pending.resource,
      });
      recordAudit(user.id, 'oauth.consent_granted', pending.clientId, { scopes: granted });
      const approvedClient = await store.getClient(pending.clientId);
      captureServerEvent('oauth_connect_approved', request.cookies?.[session.SESSION_COOKIE_NAME], {
        client_name: clientNameProp(approvedClient?.clientName ?? 'unknown'),
        write: granted.includes('write'),
      });
      return redirectToClient(reply, pending.redirectUri, issuer, { code, state: pending.state });
    });

    // --- Token endpoint -----------------------------------------------------
    oauth.post('/oauth/token', async (request, reply) => {
      if (demoOAuthLimited('token', request.ip)) return oauthError(reply.header('Retry-After', '60'), 429, 'temporarily_unavailable', 'too many requests');
      if (rateLimited('token', request.ip, 120, 60 * 1000)) return oauthError(reply, 429, 'temporarily_unavailable', 'too many requests');
      const p = asParams(request.body);
      const issuer = issuerFor(request);
      const resource = mcpResourceFor(issuer);
      if (p.resource !== undefined && p.resource !== resource) return oauthError(reply, 400, 'invalid_target', `resource must be ${resource}`);
      if (!p.client_id) return oauthError(reply, 400, 'invalid_request', 'client_id is required (public clients only)');
      const client = await store.getClient(p.client_id);
      if (!client) return oauthError(reply, 401, 'invalid_client', 'unknown client_id');

      const respond = (tokens: store.IssuedTokens, scopes: ApiTokenScope[]) => {
        reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
        return {
          access_token: tokens.accessToken,
          token_type: 'Bearer',
          expires_in: tokens.expiresIn,
          refresh_token: tokens.refreshToken,
          scope: scopes.join(' '),
        };
      };

      if (p.grant_type === 'authorization_code') {
        if (!p.code || !p.redirect_uri || !p.code_verifier) return oauthError(reply, 400, 'invalid_request', 'code, redirect_uri and code_verifier are required');
        if (!isValidCodeVerifier(p.code_verifier)) return oauthError(reply, 400, 'invalid_grant', 'code_verifier is not valid');
        const row = await store.findCode(p.code);
        if (!row || row.clientId !== client.clientId || row.redirectUri !== p.redirect_uri || !pkceMatches(p.code_verifier, row.codeChallenge)) {
          return oauthError(reply, 400, 'invalid_grant', 'the authorization code is invalid');
        }
        // Everything the caller must prove has been proven; only now is a replay conclusive.
        if (row.usedAt) {
          if (row.grantId) await store.revokeGrant(row.grantId);
          recordAudit(row.userId, 'oauth.code_replayed', row.clientId);
          return oauthError(reply, 400, 'invalid_grant', 'the authorization code was already used');
        }
        if (row.expired) return oauthError(reply, 400, 'invalid_grant', 'the authorization code has expired');
        const owner = await authStore.findUserById(row.userId);
        if (!owner || owner.disabled) return oauthError(reply, 400, 'invalid_grant', 'the authorization code is invalid');
        const grantId = await store.createGrant({ userId: row.userId, clientId: row.clientId, scopes: row.scopes, resource: row.resource });
        if (!(await store.markCodeUsed(p.code, grantId))) {
          await store.revokeGrant(grantId);
          return oauthError(reply, 400, 'invalid_grant', 'the authorization code was already used');
        }
        const tokens = await store.issueFirstTokens(grantId);
        recordAudit(row.userId, 'oauth.connected', grantId, { client: row.clientId, scopes: row.scopes });
        return respond(tokens, row.scopes);
      }

      if (p.grant_type === 'refresh_token') {
        if (!p.refresh_token) return oauthError(reply, 400, 'invalid_request', 'refresh_token is required');
        const asked = (p.scope ?? '').split(/\s+/).filter(Boolean);
        const out = await store.rotateRefreshToken(p.refresh_token, client.clientId, asked);
        if (!out.ok) {
          if (out.reason === 'scope') return oauthError(reply, 400, 'invalid_scope', 'requested scope exceeds the granted scope');
          if (out.reason === 'reused') recordAudit(null, 'oauth.refresh_reused', client.clientId);
          return oauthError(reply, 400, 'invalid_grant', 'the refresh token is invalid, expired or already used');
        }
        const owner = await authStore.findUserById(out.grant.userId);
        if (!owner || owner.disabled) {
          await store.revokeGrant(out.tokens.grantId);
          return oauthError(reply, 400, 'invalid_grant', 'the refresh token is invalid, expired or already used');
        }
        return respond(out.tokens, out.grant.scopes);
      }

      return oauthError(reply, 400, 'unsupported_grant_type', 'supported grant types: authorization_code, refresh_token');
    });

    // --- Revocation (RFC 7009) ---------------------------------------------
    oauth.post('/oauth/revoke', async (request, reply) => {
      if (rateLimited('revoke', request.ip, 120, 60 * 1000)) return oauthError(reply, 429, 'temporarily_unavailable', 'too many requests');
      const p = asParams(request.body);
      reply.header('cache-control', 'no-store');
      if (!p.token) return oauthError(reply, 400, 'invalid_request', 'token is required');
      // Always 200, whether or not the token existed: no oracle.
      const found = await store.revokeByToken(p.token, p.client_id);
      if (found) recordAudit(null, 'oauth.revoked', undefined, { via: 'revocation_endpoint' });
      reply.status(200);
      return {};
    });
  });

  // --- "Connected apps" (cookie session only, like /api/me/tokens) -----------
  await app.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', session.requireSession);
    protectedScope.get('/api/me/oauth-connections', async (request) => {
      session.requireCookieAuth(request);
      return { connections: await store.listConnections(request.authUser!.id) };
    });
    protectedScope.delete('/api/me/oauth-connections/:id', async (request) => {
      session.requireCookieAuth(request);
      const { id } = request.params as { id: string };
      if (!UUID_RE.test(id) || !(await store.revokeConnection(request.authUser!.id, id))) throw notFound('connection');
      recordAudit(request.authUser!.id, 'oauth.disconnected', id);
      return { ok: true };
    });
  });
}
