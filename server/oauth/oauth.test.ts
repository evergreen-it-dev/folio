/**
 * OAuth 2.1 for MCP, end to end: a real Fastify instance on an ephemeral port, a real PG test
 * schema, real HTTP. The happy path is driven by the MCP SDK's own OAuth client (`auth()`), i.e. by
 * the same code a real MCP client runs for discovery, registration, PKCE and the token exchange;
 * the "browser" steps (login cookie, consent form) are played by plain fetch calls.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { setUpTestSchema } from '../db/testSchema.js';
import { query } from '../db/pool.js';
import { HttpError } from '../errors.js';
import * as authStore from '../auth/store.js';
import * as session from '../auth/session.js';
import { registerMcpRoutes } from '../mcpRoutes.js';
import { __resetOAuthRateLimitsForTests, registerOAuthRoutes } from './routes.js';
import { __setClientMetadataFetcherForTests, isMetadataClientId, isPublicAddress } from './cimd.js';
import { pkceMatches, redirectUriError, redirectUriMatches } from './validate.js';

const fastifyCookie = fastifyCookieModule.default;

let app: FastifyInstance;
let base: string;
let teardownSchema: () => Promise<void>;
let alice: { id: string; cookie: string };
let bob: { id: string; cookie: string };

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function registerClient(overrides: Record<string, unknown> = {}): Promise<{ client_id: string }> {
  const res = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test Connector', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', ...overrides }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { client_id: string };
}

function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string> = {}): string {
  const u = new URL(`${base}/oauth/authorize`);
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    resource: `${base}/mcp`,
    ...extra,
  };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/** Opens the consent screen as `who` and returns its request id. */
async function openConsent(url: string, who = alice): Promise<{ requestId: string; html: string; headers: Headers }> {
  const res = await fetch(url, { headers: { cookie: who.cookie }, redirect: 'manual' });
  expect(res.status).toBe(200);
  const html = await res.text();
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
  expect(requestId, 'consent page carries a request id').toBeTruthy();
  return { requestId: requestId!, html, headers: res.headers };
}

async function decide(requestId: string, fields: Record<string, string>, who = alice): Promise<Response> {
  return fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { cookie: who.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request_id: requestId, ...fields }).toString(),
    redirect: 'manual',
  });
}

/** Full consent: returns the authorization code the client's redirect would receive. */
async function consentAndGetCode(clientId: string, challenge: string, fields: Record<string, string> = { decision: 'allow', write: '1' }, extra: Record<string, string> = {}): Promise<string> {
  const { requestId } = await openConsent(authorizeUrl(clientId, challenge, extra));
  const res = await decide(requestId, fields);
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get('location')!);
  expect(loc.origin + loc.pathname).toBe(REDIRECT);
  expect(loc.searchParams.get('state')).toBe('xyz');
  expect(loc.searchParams.get('iss')).toBe(base);
  return loc.searchParams.get('code')!;
}

async function tokenRequest(fields: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function exchange(clientId: string, code: string, verifier: string, redirectUri = REDIRECT) {
  return tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: `${base}/mcp` });
}

async function issueTokens(scopeFields: Record<string, string> = { decision: 'allow', write: '1' }) {
  const { client_id } = await registerClient();
  const { verifier, challenge } = pkce();
  const code = await consentAndGetCode(client_id, challenge, scopeFields);
  const out = await exchange(client_id, code, verifier);
  expect(out.status).toBe(200);
  return { clientId: client_id, ...(out.body as { access_token: string; refresh_token: string; scope: string; expires_in: number }) };
}

async function mcpStatus(token: string | null, method: 'POST' | 'GET' = 'POST'): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) : undefined,
  });
}

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'oauth-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

beforeAll(async () => {
  teardownSchema = await setUpTestSchema();
  const stamp = Date.now();
  const mk = async (name: string) => {
    const user = await authStore.createUser({ email: `oauth-${name}-${stamp}@test.local`, name, passwordHash: 'x', isAdmin: false });
    const { token } = await authStore.createSession(user.id);
    return { id: user.id, cookie: `${session.SESSION_COOKIE_NAME}=${token}` };
  };
  alice = await mk('alice');
  bob = await mk('bob');

  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) reply.status(err.status).send({ error: err.message });
    else reply.status(500).send({ error: String(err) });
  });
  await app.register(fastifyCookie);
  registerMcpRoutes(app);
  await registerOAuthRoutes(app, { serveSpa: (_req, reply) => void reply.type('text/html').send('SPA-LOGIN') });
  // A stand-in for the whole REST API, behind the same guard as every real /api route.
  app.get('/api/probe', { onRequest: session.requireSession }, async () => ({ ok: true }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  process.env.PUBLIC_URL = base;
});

afterAll(async () => {
  delete process.env.PUBLIC_URL;
  await app.close();
  await teardownSchema();
});

beforeEach(() => {
  __resetOAuthRateLimitsForTests();
  __setClientMetadataFetcherForTests(null);
});

describe('discovery', () => {
  it('serves RFC 9728 protected-resource metadata (plain and path-inserted)', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const body = (await (await fetch(`${base}${path}`)).json()) as Record<string, unknown>;
      expect(body.resource).toBe(`${base}/mcp`);
      expect(body.authorization_servers).toEqual([base]);
      expect(body.scopes_supported).toEqual(['read', 'write']);
    }
  });

  it('serves RFC 8414 authorization-server metadata: S256 only, DCR + CIMD, public clients', async () => {
    const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const m = (await res.json()) as Record<string, unknown>;
    expect(m.issuer).toBe(base);
    expect(m.authorization_endpoint).toBe(`${base}/oauth/authorize`);
    expect(m.token_endpoint).toBe(`${base}/oauth/token`);
    expect(m.registration_endpoint).toBe(`${base}/oauth/register`);
    expect(m.revocation_endpoint).toBe(`${base}/oauth/revoke`);
    expect(m.code_challenge_methods_supported).toEqual(['S256']);
    expect(m.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(m.client_id_metadata_document_supported).toBe(true);
    expect(m.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(m.response_types_supported).toEqual(['code']);
  });

  it('answers /mcp without credentials with 401 and a WWW-Authenticate pointing at the resource metadata', async () => {
    for (const method of ['POST', 'GET'] as const) {
      const res = await mcpStatus(null, method);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    }
    const bad = await mcpStatus('folio_oat_nope');
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });
});

describe('full flow with the MCP SDK OAuth client', () => {
  it('discovers, registers (DCR), authorizes with PKCE, exchanges the code, calls /mcp, refreshes and is cut off after revocation', async () => {
    let tokens: OAuthTokens | undefined;
    let clientInfo: OAuthClientInformationMixed | undefined;
    let verifier = '';
    let authUrl: URL | undefined;
    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return REDIRECT;
      },
      get clientMetadata(): OAuthClientMetadata {
        return { client_name: 'SDK Client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
      },
      clientInformation: () => clientInfo,
      saveClientInformation: (i) => void (clientInfo = i),
      tokens: () => tokens,
      saveTokens: (t) => void (tokens = t),
      redirectToAuthorization: (u) => void (authUrl = u),
      saveCodeVerifier: (v) => void (verifier = v),
      codeVerifier: () => verifier,
    };

    // A bare request: 401 + metadata, as the SDK transport does it.
    const first = await mcpStatus(null);
    const resourceMetadataUrl = /resource_metadata="([^"]+)"/.exec(first.headers.get('www-authenticate')!)![1];
    expect(await auth(provider, { serverUrl: `${base}/mcp`, resourceMetadataUrl: new URL(resourceMetadataUrl) })).toBe('REDIRECT');
    expect(clientInfo?.client_id).toBeTruthy();
    expect(authUrl!.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl!.searchParams.get('resource')).toBe(`${base}/mcp`);

    // Not logged in: the SPA (login) is served at the authorize URL.
    const anon = await fetch(authUrl!.toString(), { redirect: 'manual' });
    expect(await anon.text()).toBe('SPA-LOGIN');

    // Logged in: consent page, then Allow.
    const { requestId, html, headers } = await openConsent(authUrl!.toString());
    expect(html).toContain('SDK Client');
    expect(html).toContain('claude.ai');
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const allowed = await decide(requestId, { decision: 'allow', write: '1' });
    const code = new URL(allowed.headers.get('location')!).searchParams.get('code')!;

    expect(await auth(provider, { serverUrl: `${base}/mcp`, authorizationCode: code })).toBe('AUTHORIZED');
    expect(tokens!.access_token).toMatch(/^folio_oat_/);
    expect(tokens!.refresh_token).toMatch(/^folio_ort_/);
    expect(tokens!.expires_in).toBe(3600);

    // The access token works on /mcp, through a real MCP client.
    const client = await mcpClient(tokens!.access_token);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(23);
    expect(client.getInstructions()).toMatch(/Folio is a team wiki/);
    await client.close();

    // Refresh through the SDK: new pair, old refresh dead (rotation).
    const oldRefresh = tokens!.refresh_token!;
    const oldAccess = tokens!.access_token;
    expect(await auth(provider, { serverUrl: `${base}/mcp` })).toBe('AUTHORIZED');
    expect(tokens!.access_token).not.toBe(oldAccess);
    expect(tokens!.refresh_token).not.toBe(oldRefresh);
    expect((await mcpStatus(tokens!.access_token)).status).toBe(200);

    // Replaying the rotated-out refresh token is treated as theft: the whole grant dies.
    const replay = await tokenRequest({ grant_type: 'refresh_token', client_id: clientInfo!.client_id, refresh_token: oldRefresh });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
    expect((await mcpStatus(tokens!.access_token)).status).toBe(401);
  });
});

describe('token endpoint: negative cases', () => {
  it('rejects a wrong PKCE verifier and does not burn the code', async () => {
    const { client_id } = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await consentAndGetCode(client_id, challenge);
    const wrong = await exchange(client_id, code, pkce().verifier);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('invalid_grant');
    expect((await exchange(client_id, code, verifier)).status).toBe(200);
  });

  it('codes are single use; replaying one revokes the tokens it produced', async () => {
    const { client_id } = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await consentAndGetCode(client_id, challenge);
    const ok = await exchange(client_id, code, verifier);
    expect(ok.status).toBe(200);
    const access = ok.body.access_token as string;
    expect((await mcpStatus(access)).status).toBe(200);
    const again = await exchange(client_id, code, verifier);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('invalid_grant');
    expect((await mcpStatus(access)).status).toBe(401);
  });

  it('rejects an expired code', async () => {
    const { client_id } = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await consentAndGetCode(client_id, challenge);
    await query(`UPDATE oauth_codes SET expires_at = now() - interval '1 second'`);
    const out = await exchange(client_id, code, verifier);
    expect(out.status).toBe(400);
    expect(out.body.error).toBe('invalid_grant');
  });

  it('rejects a redirect_uri that differs from the one the code was issued for, and another client', async () => {
    const { client_id } = await registerClient({ redirect_uris: [REDIRECT, 'https://claude.ai/other'] });
    const other = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await consentAndGetCode(client_id, challenge);
    expect((await exchange(client_id, code, verifier, 'https://claude.ai/other')).status).toBe(400);
    expect((await exchange(other.client_id, code, verifier)).status).toBe(400);
    expect((await exchange(client_id, code, verifier)).status).toBe(200);
  });

  it('rejects a resource that is not this MCP endpoint', async () => {
    const { client_id } = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await consentAndGetCode(client_id, challenge);
    const out = await tokenRequest({ grant_type: 'authorization_code', client_id, code, code_verifier: verifier, redirect_uri: REDIRECT, resource: 'https://evil.example/mcp' });
    expect(out.status).toBe(400);
    expect(out.body.error).toBe('invalid_target');
  });

  it('rejects unsupported grant types, unknown clients and malformed verifiers', async () => {
    const { client_id } = await registerClient();
    expect((await tokenRequest({ grant_type: 'client_credentials', client_id })).body.error).toBe('unsupported_grant_type');
    expect((await tokenRequest({ grant_type: 'password', client_id })).status).toBe(400);
    expect((await tokenRequest({ grant_type: 'authorization_code', client_id: 'folio_c_nope', code: 'x' })).status).toBe(401);
    expect((await tokenRequest({ grant_type: 'authorization_code', client_id, code: 'x', redirect_uri: REDIRECT, code_verifier: 'short' })).body.error).toBe('invalid_grant');
  });

  it('refresh: cannot widen scope, and a refused request consumes nothing', async () => {
    const t = await issueTokens({ decision: 'allow' }); // read only
    expect(t.scope).toBe('read');
    const wider = await tokenRequest({ grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refresh_token, scope: 'read write' });
    expect(wider.body.error).toBe('invalid_scope');
    const ok = await tokenRequest({ grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refresh_token, scope: 'read' });
    expect(ok.status).toBe(200);
  });

  it('refresh token of another client is refused', async () => {
    const t = await issueTokens();
    const other = await registerClient();
    expect((await tokenRequest({ grant_type: 'refresh_token', client_id: other.client_id, refresh_token: t.refresh_token })).status).toBe(400);
    expect((await tokenRequest({ grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refresh_token })).status).toBe(200);
  });
});

describe('authorize endpoint: negative cases', () => {
  it('shows an error page and never redirects for an unregistered redirect_uri', async () => {
    const { client_id } = await registerClient();
    const res = await fetch(authorizeUrl(client_id, pkce().challenge, { redirect_uri: 'https://evil.example/cb' }), { headers: { cookie: alice.cookie }, redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    // Even a loopback look-alike or a path variant does not match a registered https URI.
    for (const bad of [`${REDIRECT}/x`, `${REDIRECT}?a=1`, 'http://claude.ai/api/mcp/auth_callback', 'https://claude.ai.evil.example/api/mcp/auth_callback']) {
      const r = await fetch(authorizeUrl(client_id, pkce().challenge, { redirect_uri: bad }), { headers: { cookie: alice.cookie }, redirect: 'manual' });
      expect(r.status, bad).toBe(400);
    }
  });

  it('unknown client_id is an error page', async () => {
    const res = await fetch(authorizeUrl('folio_c_unknown', pkce().challenge), { headers: { cookie: alice.cookie }, redirect: 'manual' });
    expect(res.status).toBe(400);
  });

  it('requires PKCE with S256: plain, missing and malformed challenges are redirected back as invalid_request', async () => {
    const { client_id } = await registerClient();
    const { challenge } = pkce();
    const cases: Array<Record<string, string>> = [{ code_challenge_method: 'plain' }, { code_challenge: 'short' }];
    for (const extra of cases) {
      const res = await fetch(authorizeUrl(client_id, challenge, extra), { headers: { cookie: alice.cookie }, redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
    }
    const noPkce = new URL(authorizeUrl(client_id, challenge));
    noPkce.searchParams.delete('code_challenge');
    const res = await fetch(noPkce, { headers: { cookie: alice.cookie }, redirect: 'manual' });
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
  });

  it('rejects another resource, a wrong response_type and unknown-only scopes', async () => {
    const { client_id } = await registerClient();
    const { challenge } = pkce();
    const errorFor = async (extra: Record<string, string>) => {
      const res = await fetch(authorizeUrl(client_id, challenge, extra), { headers: { cookie: alice.cookie }, redirect: 'manual' });
      expect(res.status).toBe(302);
      return new URL(res.headers.get('location')!).searchParams.get('error');
    };
    expect(await errorFor({ resource: 'https://other.example/mcp' })).toBe('invalid_target');
    expect(await errorFor({ response_type: 'token' })).toBe('unsupported_response_type');
    expect(await errorFor({ scope: 'admin' })).toBe('invalid_scope');
  });

  it('Deny redirects with access_denied and issues nothing', async () => {
    const { client_id } = await registerClient();
    const { requestId } = await openConsent(authorizeUrl(client_id, pkce().challenge));
    const res = await decide(requestId, { decision: 'deny' });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('xyz');
    expect(loc.searchParams.get('code')).toBeNull();
  });

  it('the consent form is CSRF-protected: single use, bound to the user, needs the cookie session', async () => {
    const { client_id } = await registerClient();
    const { requestId } = await openConsent(authorizeUrl(client_id, pkce().challenge));
    // Another logged-in user cannot use alice's pending request.
    expect((await decide(requestId, { decision: 'allow' }, bob)).status).toBe(400);
    // No cookie at all.
    const anon = await fetch(`${base}/oauth/authorize`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `request_id=${requestId}&decision=allow` });
    expect(anon.status).toBe(401);
    // A guessed id.
    expect((await decide(randomBytes(32).toString('base64url'), { decision: 'allow' })).status).toBe(400);
    // The real one works once...
    expect((await decide(requestId, { decision: 'allow' })).status).toBe(302);
    // ...and not twice.
    expect((await decide(requestId, { decision: 'allow' })).status).toBe(400);
  });

  it('a PAT cannot stand in for the browser session on the consent screen', async () => {
    const { client_id } = await registerClient();
    const pat = await authStore.createApiToken(alice.id, 'p', ['read', 'write']);
    const res = await fetch(authorizeUrl(client_id, pkce().challenge), { headers: { authorization: `Bearer ${pat.token}` }, redirect: 'manual' });
    expect(await res.text()).toBe('SPA-LOGIN');
  });

  it('escapes the client name on the consent page', async () => {
    const { client_id } = await registerClient({ client_name: '<script>alert(1)</script>"x' });
    const { html } = await openConsent(authorizeUrl(client_id, pkce().challenge));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('write is only granted when the app asked for it and the user left it ticked', async () => {
    const { client_id } = await registerClient();
    // App asks for write, user unticks the box.
    let code = await consentAndGetCode(client_id, pkce().challenge, { decision: 'allow' });
    expect(code).toBeTruthy();
    const readOnly = await issueTokens({ decision: 'allow' });
    expect(readOnly.scope).toBe('read');
    // App asks only for read, user (or a tampered form) sends write=1: still read.
    const { verifier, challenge } = pkce();
    code = await consentAndGetCode(client_id, challenge, { decision: 'allow', write: '1' }, { scope: 'read' });
    const out = await exchange(client_id, code, verifier);
    expect(out.body.scope).toBe('read');
  });
});

describe('/mcp with OAuth tokens', () => {
  it('a read-scoped token lists tools but cannot call a write tool; a write-scoped one can', async () => {
    const read = await issueTokens({ decision: 'allow' });
    const rc = await mcpClient(read.access_token);
    const denied = await rc.callTool({ name: 'create_page', arguments: { space: 'nope', parentPath: '', title: 'x', content: 'y' } });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain('write scope');
    expect((await rc.callTool({ name: 'list_spaces', arguments: {} })).isError).toBeFalsy();
    await rc.close();

    const write = await issueTokens();
    expect(write.scope).toBe('read write');
    const wc = await mcpClient(write.access_token);
    const attempt = await wc.callTool({ name: 'create_page', arguments: { space: 'nope', parentPath: '', title: 'x', content: 'y' } });
    // Gets past the scope gate (fails later on the unknown space, not on scope).
    expect(JSON.stringify(attempt.content)).not.toContain('write scope');
    await wc.close();
  });

  it('acts with the rights of the user who consented (a user with no spaces sees none)', async () => {
    const t = await issueTokens();
    const c = await mcpClient(t.access_token);
    const res = await c.callTool({ name: 'list_spaces', arguments: {} });
    expect(JSON.parse((res.content as Array<{ text: string }>)[0].text)).toEqual([]);
    await c.close();
  });

  it('an expired access token is refused', async () => {
    const t = await issueTokens();
    expect((await mcpStatus(t.access_token)).status).toBe(200);
    await query(`UPDATE oauth_tokens SET expires_at = now() - interval '1 second' WHERE kind = 'access'`);
    expect((await mcpStatus(t.access_token)).status).toBe(401);
  });

  it('an access token whose audience is not this resource is refused', async () => {
    const t = await issueTokens();
    await query(`UPDATE oauth_grants SET resource = 'https://other.example/mcp'`);
    expect((await mcpStatus(t.access_token)).status).toBe(401);
  });

  it('an OAuth access token is not valid on the REST API; the user disabled stops it on /mcp', async () => {
    const t = await issueTokens();
    const rest = await fetch(`${base}/api/probe`, { headers: { authorization: `Bearer ${t.access_token}` } });
    expect(rest.status).toBe(401);
    // Sanity: the same probe accepts the cookie session.
    expect((await fetch(`${base}/api/probe`, { headers: { cookie: alice.cookie } })).status).toBe(200);
  });

  it('personal access tokens keep working on /mcp, unchanged', async () => {
    const pat = await authStore.createApiToken(alice.id, 'still works', ['read']);
    expect((await mcpStatus(pat.token)).status).toBe(200);
  });

  it('cookie sessions are still not accepted on /mcp', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { cookie: alice.cookie, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(res.status).toBe(401);
  });
});

describe('revocation and Connected apps', () => {
  it('/oauth/revoke with the refresh token kills both tokens; unknown tokens still answer 200', async () => {
    const t = await issueTokens();
    expect((await mcpStatus(t.access_token)).status).toBe(200);
    const res = await fetch(`${base}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t.refresh_token, client_id: t.clientId }).toString() });
    expect(res.status).toBe(200);
    expect((await mcpStatus(t.access_token)).status).toBe(401);
    expect((await tokenRequest({ grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refresh_token })).status).toBe(400);
    const unknown = await fetch(`${base}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=folio_oat_unknown' });
    expect(unknown.status).toBe(200);
  });

  it('/oauth/revoke with the access token and a different client_id does nothing', async () => {
    const t = await issueTokens();
    const other = await registerClient();
    await fetch(`${base}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t.access_token, client_id: other.client_id }).toString() });
    expect((await mcpStatus(t.access_token)).status).toBe(200);
  });

  it('lists connected apps for the cookie session and lets the user disconnect one', async () => {
    await query('DELETE FROM oauth_grants');
    const t = await issueTokens();
    const list = (await (await fetch(`${base}/api/me/oauth-connections`, { headers: { cookie: alice.cookie } })).json()) as { connections: Array<{ id: string; clientName: string; redirectHost: string; scopes: string[] }> };
    expect(list.connections).toHaveLength(1);
    expect(list.connections[0]).toMatchObject({ clientName: 'Test Connector', redirectHost: 'claude.ai', scopes: ['read', 'write'] });
    expect(JSON.stringify(list)).not.toContain(t.access_token);

    // Bob sees nothing and cannot disconnect Alice's app.
    expect(((await (await fetch(`${base}/api/me/oauth-connections`, { headers: { cookie: bob.cookie } })).json()) as { connections: unknown[] }).connections).toEqual([]);
    const forbidden = await fetch(`${base}/api/me/oauth-connections/${list.connections[0].id}`, { method: 'DELETE', headers: { cookie: bob.cookie } });
    expect(forbidden.status).toBe(404);
    expect((await mcpStatus(t.access_token)).status).toBe(200);

    // A PAT cannot manage connections.
    const pat = await authStore.createApiToken(alice.id, 'pat', ['read', 'write']);
    expect((await fetch(`${base}/api/me/oauth-connections`, { headers: { authorization: `Bearer ${pat.token}` } })).status).toBe(403);

    const del = await fetch(`${base}/api/me/oauth-connections/${list.connections[0].id}`, { method: 'DELETE', headers: { cookie: alice.cookie } });
    expect(del.status).toBe(200);
    expect((await mcpStatus(t.access_token)).status).toBe(401);
    expect((await fetch(`${base}/api/me/oauth-connections/not-a-uuid`, { method: 'DELETE', headers: { cookie: alice.cookie } })).status).toBe(404);
  });

  it('disabling the user cuts the OAuth token off', async () => {
    const victim = await authStore.createUser({ email: `oauth-victim-${Date.now()}@test.local`, name: 'Victim', passwordHash: 'x', isAdmin: false });
    const { token } = await authStore.createSession(victim.id);
    const who = { id: victim.id, cookie: `${session.SESSION_COOKIE_NAME}=${token}` };
    const { client_id } = await registerClient();
    const { verifier, challenge } = pkce();
    const { requestId } = await openConsent(authorizeUrl(client_id, challenge), who);
    const code = new URL((await decide(requestId, { decision: 'allow' }, who)).headers.get('location')!).searchParams.get('code')!;
    const out = await exchange(client_id, code, verifier);
    expect((await mcpStatus(out.body.access_token as string)).status).toBe(200);
    await query('UPDATE users SET disabled = true WHERE id = $1', [victim.id]);
    expect((await mcpStatus(out.body.access_token as string)).status).toBe(401);
  });
});

describe('dynamic client registration', () => {
  it('registers a public client and returns RFC 7591 fields', async () => {
    const res = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'X', redirect_uris: [REDIRECT, 'http://127.0.0.1/callback'], token_endpoint_auth_method: 'client_secret_basic' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.client_id).toMatch(/^folio_c_/);
    expect(body.client_secret).toBeUndefined();
    expect(body.token_endpoint_auth_method).toBe('none');
  });

  it('rejects redirect URIs that are neither https nor loopback, or carry fragments/credentials', async () => {
    for (const uri of ['http://evil.example/cb', 'javascript:alert(1)', 'myapp://cb', 'https://x.example/cb#frag', 'https://u:p@x.example/cb', 'not a url', '']) {
      const res = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [uri] }) });
      expect(res.status, uri).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_redirect_uri');
    }
    const none = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'no uris' }) });
    expect(none.status).toBe(400);
    const grant = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT], grant_types: ['password'] }) });
    expect(grant.status).toBe(400);
  });

  it('is rate limited', async () => {
    let last = 0;
    for (let i = 0; i < 22; i += 1) {
      const res = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) });
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it('loopback redirect URIs match regardless of port (RFC 8252), nothing else does', async () => {
    const { client_id } = await registerClient({ redirect_uris: ['http://localhost/callback'] });
    const { challenge } = pkce();
    const ok = await fetch(authorizeUrl(client_id, challenge, { redirect_uri: 'http://localhost:53124/callback' }), { headers: { cookie: alice.cookie }, redirect: 'manual' });
    expect(ok.status).toBe(200);
    const wrongPath = await fetch(authorizeUrl(client_id, challenge, { redirect_uri: 'http://localhost:53124/other' }), { headers: { cookie: alice.cookie }, redirect: 'manual' });
    expect(wrongPath.status).toBe(400);
    const wrongHost = await fetch(authorizeUrl(client_id, challenge, { redirect_uri: 'http://127.0.0.1:53124/callback' }), { headers: { cookie: alice.cookie }, redirect: 'manual' });
    expect(wrongHost.status).toBe(400);
  });
});

describe('Client ID Metadata Documents', () => {
  const CIMD_ID = 'https://chatgpt.example/oauth/client.json';

  it('uses a client_id that is an https URL: fetches, validates and caches the document, and shows its name', async () => {
    let fetches = 0;
    __setClientMetadataFetcherForTests(async (url) => {
      fetches += 1;
      expect(url).toBe(CIMD_ID);
      return { client_id: CIMD_ID, client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector/oauth/abc123'], token_endpoint_auth_method: 'none' };
    });
    const { verifier, challenge } = pkce();
    const redirect = 'https://chatgpt.com/connector/oauth/abc123';
    const { requestId, html } = await openConsent(authorizeUrl(CIMD_ID, challenge, { redirect_uri: redirect }));
    expect(html).toContain('ChatGPT');
    expect(html).toContain('chatgpt.example'); // who vouches for the name
    const res = await decide(requestId, { decision: 'allow', write: '1' });
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(redirect);
    const out = await tokenRequest({ grant_type: 'authorization_code', client_id: CIMD_ID, code: loc.searchParams.get('code')!, code_verifier: verifier, redirect_uri: redirect });
    expect(out.status).toBe(200);
    expect((await mcpStatus(out.body.access_token as string)).status).toBe(200);
    // Second authorize within the cache window does not fetch again.
    await openConsent(authorizeUrl(CIMD_ID, pkce().challenge, { redirect_uri: redirect }));
    expect(fetches).toBe(1);
  });

  it('refuses documents that are not what they claim to be', async () => {
    const attempt = async (doc: unknown) => {
      __setClientMetadataFetcherForTests(async () => doc);
      await query(`DELETE FROM oauth_clients WHERE client_id = $1`, [CIMD_ID]);
      return fetch(authorizeUrl(CIMD_ID, pkce().challenge, { redirect_uri: 'https://chatgpt.com/cb' }), { headers: { cookie: alice.cookie }, redirect: 'manual' });
    };
    expect((await attempt({ client_id: 'https://other.example/x.json', redirect_uris: ['https://chatgpt.com/cb'] })).status).toBe(400); // client_id mismatch
    expect((await attempt({ client_id: CIMD_ID, redirect_uris: ['https://chatgpt.com/cb'], client_secret: 's' })).status).toBe(400);
    expect((await attempt({ client_id: CIMD_ID, redirect_uris: ['https://chatgpt.com/cb'], token_endpoint_auth_method: 'client_secret_basic' })).status).toBe(400);
    expect((await attempt({ client_id: CIMD_ID, redirect_uris: ['http://evil.example/cb'] })).status).toBe(400);
    expect((await attempt({ client_id: CIMD_ID, redirect_uris: [] })).status).toBe(400);
    expect((await attempt('nope')).status).toBe(400);
    // And a redirect_uri the document does not list is refused even for a valid document.
    expect((await (async () => { __setClientMetadataFetcherForTests(async () => ({ client_id: CIMD_ID, redirect_uris: ['https://chatgpt.com/cb'] })); await query(`DELETE FROM oauth_clients WHERE client_id = $1`, [CIMD_ID]); return fetch(authorizeUrl(CIMD_ID, pkce().challenge, { redirect_uri: 'https://evil.example/cb' }), { headers: { cookie: alice.cookie }, redirect: 'manual' }); })()).status).toBe(400);
  });

  it('the real fetcher refuses non-public hosts (SSRF): loopback name, private IP literal, cloud metadata address', async () => {
    for (const id of ['https://localhost/client.json', 'https://127.0.0.1/client.json', 'https://169.254.169.254/latest/meta.json', 'https://[::1]/client.json', 'https://10.0.0.5/client.json']) {
      const res = await fetch(authorizeUrl(id, pkce().challenge, { redirect_uri: 'https://chatgpt.com/cb' }), { headers: { cookie: alice.cookie }, redirect: 'manual' });
      expect(res.status, id).toBe(400);
      expect(await res.text(), id).toMatch(/could not be identified/);
    }
  });

  it('an http client_id (or one without a path) is not treated as a metadata document', async () => {
    const res = await fetch(authorizeUrl('http://chatgpt.example/client.json', pkce().challenge), { headers: { cookie: alice.cookie }, redirect: 'manual' });
    expect(res.status).toBe(400);
  });
});

describe('pure helpers', () => {
  it('isMetadataClientId', () => {
    expect(isMetadataClientId('https://example.com/oauth/client.json')).toBe(true);
    for (const bad of ['http://example.com/x', 'https://example.com', 'https://example.com/', 'https://example.com/a/../b', 'https://u:p@example.com/x', 'https://example.com/x#f', 'folio_c_abc']) {
      expect(isMetadataClientId(bad), bad).toBe(false);
    }
  });

  it('isPublicAddress refuses loopback, private, link-local, metadata-service and mapped addresses', () => {
    for (const bad of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', 'ff02::1']) {
      expect(isPublicAddress(bad), bad).toBe(false);
    }
    for (const good of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isPublicAddress(good), good).toBe(true);
    expect(isPublicAddress('not-an-ip')).toBe(false);
  });

  it('redirect URI rules', () => {
    expect(redirectUriError('https://claude.ai/api/mcp/auth_callback')).toBeNull();
    expect(redirectUriError('http://localhost:8080/cb')).toBeNull();
    expect(redirectUriError('http://[::1]:8080/cb')).toBeNull();
    expect(redirectUriError('http://localhost.evil.example/cb')).not.toBeNull();
    expect(redirectUriMatches(['http://127.0.0.1/callback'], 'http://127.0.0.1:9999/callback')).toBe(true);
    expect(redirectUriMatches(['https://a.example/cb'], 'https://a.example:444/cb')).toBe(false);
  });

  it('pkceMatches follows RFC 7636 appendix B', () => {
    expect(pkceMatches('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true);
    expect(pkceMatches('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cX')).toBe(false);
  });
});
