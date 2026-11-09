/**
 * The tools of ONE Codex run, offered to the CLI as an MCP server over
 * Streamable HTTP on this very server. The CLI is a separate process, so unlike
 * the other providers it cannot call the in-process tool functions directly.
 *
 * What the model may call is exactly the record the run was given by
 * buildAssistantTools (the same factory every provider uses, so Ask/Agent
 * access is unchanged); this module adds no tool and checks nothing about the
 * user. Its own boundary is the endpoint:
 *  - a random per-run id in the path and a random per-run bearer token, compared
 *    in constant time;
 *  - loopback connections only (the socket's peer address, never a header a
 *    proxy or a client can set; requests that carry proxy headers are refused);
 *  - it exists only between openCodexRunMcp and close(), i.e. for one run.
 *
 * The route is registered outside the session scope on purpose: it must not
 * depend on, or accept, a browser cookie.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SDKCustomTool, SDKJsonValue } from '@cursor/sdk';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { codexEnabled } from './providerFlags.js';
import { TOOL_RESULT_MAX_CHARS, capText, chatToolDefinitions, normalizeToolOutput, validateToolInput } from './runtime/agentLoop.js';

const ROUTE_PREFIX = '/internal/assistant-run';
/** Name of the server in the CLI's config; tool calls arrive as `mcp_tool_call` items with this `server`. */
export const RUN_MCP_SERVER_NAME = 'folio';

interface RunEndpoint {
  tokenHash: Buffer;
  tools: Record<string, SDKCustomTool>;
}

const endpoints = new Map<string, RunEndpoint>();
let localPort: number | null = null;

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();
/** Hash of a token nobody has: compared when the run id is unknown, so the answer and its timing do not tell a real id from a made-up one. */
const NO_TOKEN_HASH = sha256(randomBytes(32).toString('hex'));

/** Called once the server is listening: the CLI connects to 127.0.0.1 on this port. */
export function setCodexRunMcpPort(port: number): void {
  localPort = port;
}

export interface CodexRunMcpHandle {
  /** Where the CLI connects. */
  url: string;
  /** The bearer token; goes to the CLI through an environment variable, never the command line. */
  token: string;
  close: () => void;
}

export function openCodexRunMcp(tools: Record<string, SDKCustomTool>): CodexRunMcpHandle {
  if (localPort === null) throw new Error('The run MCP endpoint is not ready: the server is not listening yet');
  const id = randomBytes(16).toString('hex');
  const token = randomBytes(32).toString('hex');
  endpoints.set(id, { tokenHash: sha256(token), tools });
  return { url: `http://127.0.0.1:${localPort}${ROUTE_PREFIX}/${id}/mcp`, token, close: () => { endpoints.delete(id); } };
}

export function openCodexRunEndpointCount(): number {
  return endpoints.size;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopbackRequest(request: FastifyRequest): boolean {
  const headers = request.headers;
  if (headers['x-forwarded-for'] || headers.forwarded || headers['x-real-ip']) return false;
  return LOOPBACK.has(request.raw.socket.remoteAddress ?? '');
}

function toCallToolResult(output: unknown): CallToolResult {
  const { content, isError } = normalizeToolOutput(output);
  const text = capText(content || '(no output)', TOOL_RESULT_MAX_CHARS, `a single result is limited to ${TOOL_RESULT_MAX_CHARS} characters`);
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function buildRunServer(tools: Record<string, SDKCustomTool>): Server {
  const server = new Server({ name: 'folio-assistant-run', version: '1.0.0' }, { capabilities: { tools: {} } });
  const definitions = chatToolDefinitions(tools);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: definitions.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as { type: 'object' } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const tool = Object.hasOwn(tools, name) ? tools[name] : undefined;
    const fail = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true });
    if (!tool) return fail(`Unknown tool: ${name}`);
    const args = request.params.arguments ?? {};
    const problem = validateToolInput(tool.inputSchema, args);
    if (problem) return fail(JSON.stringify({ INVALID_INPUT: problem, received: args }));
    try {
      return toCallToolResult(await tool.execute(args as Record<string, SDKJsonValue>, { toolCallId: String(extra.requestId) }));
    } catch (error) {
      return fail(error instanceof Error ? error.message : 'tool call failed');
    }
  });
  return server;
}

function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

export function registerCodexRunMcpRoutes(app: FastifyInstance): void {
  app.post(`${ROUTE_PREFIX}/:id/mcp`, { bodyLimit: 8 * 1024 * 1024 }, async (request, reply) => {
    // Not loopback, or Codex off: the same answer as a path that does not exist.
    if (!codexEnabled() || !isLoopbackRequest(request)) return reply.callNotFound();
    const endpoint = endpoints.get((request.params as { id: string }).id);
    const presented = sha256(bearerToken(request));
    const valid = timingSafeEqual(presented, endpoint?.tokenHash ?? NO_TOKEN_HASH);
    if (!endpoint || !valid) return reply.status(401).send({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null });

    reply.hijack();
    const server = buildRunServer(endpoint.tools);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      app.log.error({ err: error instanceof Error ? error.message : error }, 'assistant run MCP request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'internal server error' }, id: null }));
      }
    }
  });

  // The stateless transport has no server-to-client stream and no session to end.
  const notAllowed = async (request: FastifyRequest, reply: import('fastify').FastifyReply) => {
    if (!codexEnabled() || !isLoopbackRequest(request)) return reply.callNotFound();
    return reply.status(405).header('allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'method not allowed' }, id: null });
  };
  app.get(`${ROUTE_PREFIX}/:id/mcp`, notAllowed);
  app.delete(`${ROUTE_PREFIX}/:id/mcp`, notAllowed);
}
