/**
 * The /mcp mount: stateless Streamable HTTP, authenticated with EITHER a personal access token
 * (`folio_pat_…`, unchanged) OR an OAuth 2.1 access token (`folio_oat_…`, issued by server/oauth).
 * Cookie sessions are never accepted here. OAuth access tokens are audience-bound to this very
 * URL (RFC 8707) and exist only for this endpoint: the REST API's own auth does not know them.
 *
 * A request without valid credentials gets 401 plus `WWW-Authenticate: Bearer resource_metadata=…`
 * (RFC 9728), which is what makes an MCP client start the OAuth flow by itself.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ApiTokenScope, User } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { buildFolioMcpServer } from './mcp.js';
import * as oauthStore from './oauth/store.js';
import { issuerFor, mcpResourceFor, protectedResourceMetadataUrl } from './oauth/routes.js';

export interface McpAuth {
  user: User;
  scopes: ApiTokenScope[];
  /** PAT id, or the OAuth grant id. */
  tokenId: string;
}

/** Resolves a PAT or an OAuth access token; null for anything else (no hint which part was wrong). */
export async function resolveMcpAuth(request: FastifyRequest): Promise<McpAuth | null> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();

  if (token.startsWith(oauthStore.ACCESS_TOKEN_PREFIX)) {
    const access = await oauthStore.resolveAccessToken(token);
    // Audience binding: a token minted for another resource (or another host of this server) is not valid here.
    if (!access || access.resource !== mcpResourceFor(issuerFor(request))) return null;
    const user = await authStore.findUserById(access.userId);
    if (!user || user.disabled) return null;
    oauthStore.touchGrantLastUsed(access.grantId);
    return { user, scopes: access.scopes, tokenId: access.grantId };
  }

  const resolved = await session.resolvePatOnly(request);
  if (!resolved) return null;
  return { user: resolved.user, scopes: resolved.tokenScopes ?? [], tokenId: resolved.tokenId! };
}

function sendUnauthorized(request: FastifyRequest, reply: FastifyReply, message: string): void {
  const presented = Boolean(request.headers.authorization);
  const challenge = `Bearer resource_metadata="${protectedResourceMetadataUrl(request)}"${presented ? ', error="invalid_token"' : ''}`;
  reply.header('WWW-Authenticate', challenge).status(401).send({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });
}

export function registerMcpRoutes(app: FastifyInstance): void {
  app.post('/mcp', async (request, reply) => {
    const auth = await resolveMcpAuth(request);
    if (!auth) {
      sendUnauthorized(request, reply, 'authentication required: Authorization: Bearer <folio_pat_… or OAuth access token>');
      return;
    }
    reply.hijack();
    const server = buildFolioMcpServer({ user: auth.user, scopes: auth.scopes, tokenId: auth.tokenId });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
      reply.raw.on('close', () => {
        void transport.close();
        void server.close();
      });
    } catch (err) {
      app.log.error(err);
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'internal server error' }, id: null }));
      }
    }
  });
  // Stateless mode has no session to stream (GET) or terminate (DELETE) — same
  // 405 the SDK's own stateless example returns for both.
  for (const method of ['get', 'delete'] as const) {
    app[method]('/mcp', async (request, reply) => {
      const auth = await resolveMcpAuth(request);
      if (!auth) {
        sendUnauthorized(request, reply, 'authentication required');
        return;
      }
      reply.status(405).send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
    });
  }
}
