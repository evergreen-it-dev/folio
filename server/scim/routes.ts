/**
 * SCIM 2.0 provisioning endpoint, /scim/v2 (RFC 7643 / 7644, the subset Okta, Entra ID, Keycloak SCIM plugins,
 * OneLogin and JumpCloud use), and its admin API under /api/admin/auth/providers/:id/scim.
 *
 * /scim/v2 has its own trust boundary, outside the cookie/PAT session scope: `Authorization: Bearer <SCIM token>`
 * of one sign-in provider (tokens.ts). Every response is `application/scim+json`, errors in the SCIM format
 * (errors.ts). Discovery (ServiceProviderConfig, ResourceTypes, Schemas) is static and needs no token.
 * Rate limits: per token (FOLIO_SCIM_RATE_PER_MINUTE, default 1200 requests a minute) and, for failed
 * authentication, per client IP (30 a minute) — 429 with Retry-After.
 *
 * The admin API is instance admin on a cookie session only, like the rest of /admin/auth: generate / rotate the
 * token (shown once), revoke it, and the status shown in the provider's "SCIM provisioning" panel.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ScimStatusInfo, ScimTokenCreated } from '../../shared/contracts.js';
import { recordAudit } from '../audit.js';
import { queryOne } from '../db/pool.js';
import { assertNotDemo } from '../demo.js';
import { notFound } from '../errors.js';
import { publicUrlOrOrigin, requestOrigin } from '../publicUrl.js';
import { rateLimited, retryAfterSeconds } from '../rateLimit.js';
import * as providers from '../auth/providers.js';
import type { AuthProvider } from '../auth/providers.js';
import * as session from '../auth/session.js';
import { SCIM_CONTENT_TYPE, ScimError, scimBadRequest, scimErrorBody, scimNotFound, scimUnauthorized, toScimError } from './errors.js';
import { parseScimFilter } from './filter.js';
import { createScimGroup, deleteScimGroup, getScimGroup, listScimGroups, patchScimGroup, replaceScimGroup } from './groups.js';
import { SCIM_MAX_RESULTS, resourceTypes, schemaDocuments, serviceProviderConfig } from './schemas.js';
import * as tokens from './tokens.js';
import { createScimUser, deleteScimUser, getScimUser, listScimUsers, patchScimUser, replaceScimUser, type Page, type ScimContext } from './users.js';

const AUTH_FAIL_PER_MINUTE = 30;

function ratePerMinute(): number {
  const raw = Number(process.env.FOLIO_SCIM_RATE_PER_MINUTE);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1200;
}

export function scimBaseUrl(request: FastifyRequest): string {
  return `${publicUrlOrOrigin(requestOrigin(request))}/scim/v2`;
}

function send(reply: FastifyReply, status: number, body?: unknown): FastifyReply {
  reply.status(status).type(SCIM_CONTENT_TYPE).header('Cache-Control', 'no-store');
  return body === undefined ? reply.send() : reply.send(body);
}

function sendError(reply: FastifyReply, err: ScimError): FastifyReply {
  if (err.status === 401) reply.header('WWW-Authenticate', 'Bearer realm="folio-scim"');
  if (err.retryAfter) reply.header('Retry-After', String(err.retryAfter));
  return send(reply, err.status, scimErrorBody(err.status, err.message, err.scimType));
}

const contexts = new WeakMap<FastifyRequest, ScimContext>();

function ctxOf(request: FastifyRequest): ScimContext {
  const ctx = contexts.get(request);
  if (!ctx) throw scimUnauthorized();
  return ctx;
}

async function authenticate(request: FastifyRequest): Promise<void> {
  const fail = (detail?: string): never => {
    if (rateLimited('scim-auth-fail', request.ip, AUTH_FAIL_PER_MINUTE, 60_000)) {
      throw new ScimError(429, 'too many failed authentication attempts', undefined, retryAfterSeconds('scim-auth-fail', request.ip, 60_000));
    }
    throw scimUnauthorized(detail);
  };
  const header = request.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  if (!match) return fail();
  const token = await tokens.resolveScimToken(match[1]);
  if (!token) return fail('the SCIM token is unknown or revoked');
  const provider = await providers.getProviderById(token.providerId);
  if (!provider) return fail('the SCIM token is unknown or revoked');
  if (rateLimited('scim', token.id, ratePerMinute(), 60_000)) {
    throw new ScimError(429, 'too many requests', undefined, retryAfterSeconds('scim', token.id, 60_000));
  }
  await tokens.touchScimToken(token.id);
  contexts.set(request, { provider, tokenId: token.id, baseUrl: scimBaseUrl(request) });
}

function pageOf(request: FastifyRequest): Page {
  const q = request.query as Record<string, string | undefined>;
  const int = (raw: string | undefined, fallback: number, name: string): number => {
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n)) throw scimBadRequest(`${name} must be an integer`);
    return n;
  };
  const startIndex = Math.max(1, int(q.startIndex, 1, 'startIndex'));
  const count = Math.min(SCIM_MAX_RESULTS, Math.max(0, int(q.count, 100, 'count')));
  return { startIndex, count };
}

function excludesMembers(request: FastifyRequest): boolean {
  const q = request.query as Record<string, string | undefined>;
  const listed = (raw: string | undefined) => (raw ?? '').split(',').map((s) => s.trim().toLowerCase());
  if (listed(q.excludedAttributes).includes('members')) return true;
  // `attributes=displayName` (without members) asks for less too.
  const attrs = listed(q.attributes).filter(Boolean);
  return attrs.length > 0 && !attrs.includes('members');
}

const DISCOVERY = new Set(['/scim/v2/ServiceProviderConfig', '/scim/v2/ResourceTypes', '/scim/v2/Schemas']);

/** /scim/v2 — registered OUTSIDE the session scope (its own bearer-token auth). */
export async function registerScimRoutes(app: FastifyInstance): Promise<void> {
  await app.register(
    async (scope) => {
      scope.addContentTypeParser('application/scim+json', { parseAs: 'string', bodyLimit: 5 * 1024 * 1024 }, (_request, body, done) => {
        const text = typeof body === 'string' ? body : body.toString('utf8');
        if (text.trim() === '') return done(null, undefined);
        try {
          done(null, JSON.parse(text));
        } catch {
          done(scimBadRequest('the request body is not valid JSON', 'invalidSyntax'), undefined);
        }
      });
      scope.setErrorHandler((err, request, reply) => {
        const scimErr = toScimError(err);
        if (scimErr.status >= 500) request.log.error(err);
        return sendError(reply, scimErr);
      });
      scope.setNotFoundHandler((_request, reply) => sendError(reply, scimNotFound('resource')));
      scope.addHook('onRequest', async (request) => {
        const path = request.url.split('?')[0].replace(/\/+$/, '');
        if (request.method === 'GET' && [...DISCOVERY].some((d) => path === d || path.startsWith(`${d}/`))) return;
        await authenticate(request);
      });

      // --- discovery ---
      scope.get('/ServiceProviderConfig', async (request, reply) => send(reply, 200, serviceProviderConfig(scimBaseUrl(request))));
      scope.get('/ResourceTypes', async (request, reply) => {
        const list = resourceTypes(scimBaseUrl(request));
        return send(reply, 200, { schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: list.length, startIndex: 1, itemsPerPage: list.length, Resources: list });
      });
      scope.get('/ResourceTypes/:id', async (request, reply) => {
        const found = resourceTypes(scimBaseUrl(request)).find((r) => r.id === (request.params as { id: string }).id);
        if (!found) throw scimNotFound('resource type');
        return send(reply, 200, found);
      });
      scope.get('/Schemas', async (request, reply) => {
        const list = schemaDocuments(scimBaseUrl(request));
        return send(reply, 200, { schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: list.length, startIndex: 1, itemsPerPage: list.length, Resources: list });
      });
      scope.get('/Schemas/:id', async (request, reply) => {
        const found = schemaDocuments(scimBaseUrl(request)).find((r) => r.id === (request.params as { id: string }).id);
        if (!found) throw scimNotFound('schema');
        return send(reply, 200, found);
      });

      // --- Users ---
      scope.get('/Users', async (request, reply) => {
        const terms = parseScimFilter((request.query as { filter?: string }).filter);
        return send(reply, 200, await listScimUsers(ctxOf(request), terms, pageOf(request)));
      });
      scope.post('/Users', async (request, reply) => {
        const user = await createScimUser(ctxOf(request), request.body);
        reply.header('Location', (user.meta as { location: string }).location);
        return send(reply, 201, user);
      });
      scope.get('/Users/:id', async (request, reply) => send(reply, 200, await getScimUser(ctxOf(request), (request.params as { id: string }).id)));
      scope.put('/Users/:id', async (request, reply) => send(reply, 200, await replaceScimUser(ctxOf(request), (request.params as { id: string }).id, request.body)));
      scope.patch('/Users/:id', async (request, reply) => send(reply, 200, await patchScimUser(ctxOf(request), (request.params as { id: string }).id, request.body)));
      scope.delete('/Users/:id', async (request, reply) => {
        await deleteScimUser(ctxOf(request), (request.params as { id: string }).id);
        return send(reply, 204);
      });

      // --- Groups ---
      scope.get('/Groups', async (request, reply) => {
        const terms = parseScimFilter((request.query as { filter?: string }).filter);
        return send(reply, 200, await listScimGroups(ctxOf(request), terms, pageOf(request), { excludeMembers: excludesMembers(request) }));
      });
      scope.post('/Groups', async (request, reply) => {
        const group = await createScimGroup(ctxOf(request), request.body);
        reply.header('Location', (group.meta as { location: string }).location);
        return send(reply, 201, group);
      });
      scope.get('/Groups/:id', async (request, reply) =>
        send(reply, 200, await getScimGroup(ctxOf(request), (request.params as { id: string }).id, { excludeMembers: excludesMembers(request) })),
      );
      scope.put('/Groups/:id', async (request, reply) => send(reply, 200, await replaceScimGroup(ctxOf(request), (request.params as { id: string }).id, request.body)));
      scope.patch('/Groups/:id', async (request, reply) => {
        const group = await patchScimGroup(ctxOf(request), (request.params as { id: string }).id, request.body);
        return group ? send(reply, 200, group) : send(reply, 204);
      });
      scope.delete('/Groups/:id', async (request, reply) => {
        await deleteScimGroup(ctxOf(request), (request.params as { id: string }).id);
        return send(reply, 204);
      });
    },
    { prefix: '/scim/v2' },
  );
}

// ---------------------------------------------------------------------------
// Admin API (/admin/auth)
// ---------------------------------------------------------------------------

async function statusFor(provider: AuthProvider, request: FastifyRequest): Promise<ScimStatusInfo> {
  const token = await tokens.activeScimToken(provider.id);
  const counts = await queryOne<{ users: string; groups: string; last_sync: string | null }>(
    `SELECT (SELECT COUNT(DISTINCT user_id) FROM user_identities WHERE provider_id = $1 AND scim_provisioned AND scim_deleted_at IS NULL) AS users,
            (SELECT COUNT(*) FROM groups WHERE source = 'scim' AND scim_provider_id = $1 AND archived_at IS NULL) AS groups,
            (SELECT MAX(last_used_at) FROM scim_tokens WHERE provider_id = $1) AS last_sync`,
    [provider.id],
  );
  return {
    enabled: token !== undefined,
    baseUrl: scimBaseUrl(request),
    token: token ? { prefix: token.prefix, createdAt: token.createdAt, lastUsedAt: token.lastUsedAt } : null,
    lastSyncAt: counts?.last_sync ? new Date(counts.last_sync).toISOString() : null,
    users: Number(counts?.users ?? 0),
    groups: Number(counts?.groups ?? 0),
    // An environment-defined provider keeps its JIT flag; while SCIM is on, sign-in ignores it.
    jitIgnored: token !== undefined && provider.jitEnabled,
  };
}

async function requireProvider(request: FastifyRequest): Promise<AuthProvider> {
  session.requireCookieAuth(request);
  session.requireInstanceAdmin(request);
  const provider = await providers.getProviderById((request.params as { id: string }).id);
  if (!provider) throw notFound('provider');
  return provider;
}

/** Inside the session scope (cookie + instance admin). */
export function registerScimAdminRoutes(app: FastifyInstance): void {
  app.get('/api/admin/auth/providers/:id/scim', async (request): Promise<ScimStatusInfo> => statusFor(await requireProvider(request), request));

  app.post('/api/admin/auth/providers/:id/scim/token', async (request): Promise<ScimTokenCreated> => {
    const provider = await requireProvider(request);
    assertNotDemo('Configuring SCIM provisioning');
    const issued = await tokens.issueScimToken(provider.id, request.authUser!.id);
    // SCIM replaces JIT: an admin-defined provider has JIT turned off with it (an env one is ignored at sign-in).
    let jitDisabled = false;
    if (provider.jitEnabled && provider.source === 'db') {
      await providers.updateProvider(provider.id, { jitEnabled: false });
      jitDisabled = true;
    }
    recordAudit(request.authUser!.id, 'scim.token_rotate', provider.slug, { rotated: issued.rotated, prefix: issued.info.prefix, ...(jitDisabled ? { jitDisabled: true } : {}) });
    const fresh = (await providers.getProviderById(provider.id)) ?? provider;
    return { token: issued.token, jitDisabled, status: await statusFor(fresh, request) };
  });

  app.delete('/api/admin/auth/providers/:id/scim/token', async (request): Promise<ScimStatusInfo> => {
    const provider = await requireProvider(request);
    assertNotDemo('Configuring SCIM provisioning');
    if (await tokens.revokeScimToken(provider.id)) recordAudit(request.authUser!.id, 'scim.token_revoke', provider.slug);
    return statusFor(provider, request);
  });
}
