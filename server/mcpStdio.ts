/**
 * Folio MCP over stdio: a small bridge for clients that only speak stdio, and
 * for directories (Glama and similar) that start an MCP server from a Docker
 * image to inspect its tools.
 *
 *   FOLIO_URL=https://wiki.example.com FOLIO_TOKEN=folio_pat_... \
 *     node --import tsx server/mcpStdio.ts
 *
 * Proxy mode: FOLIO_URL and FOLIO_TOKEN point at a reachable Folio instance.
 * The bridge connects to `${FOLIO_URL}/mcp` as an MCP client with the token as
 * a Bearer header and forwards tools, prompts and resources (when the remote
 * offers them) one to one, with the remote's own instructions. Nothing is
 * re-registered, so the bridge never drifts from the server it talks to.
 *
 * Catalog mode: without the two variables, or when the instance cannot be
 * reached or rejects the token within a few seconds, the bridge still starts.
 * `tools/list` answers with Folio's real tool definitions (built by
 * buildFolioMcpServer with a placeholder actor, so names, descriptions and
 * schemas are exactly the server's) and every `tools/call` is an MCP error
 * result that says what to configure. Prompts are team skills stored in an
 * instance, so the catalog has none.
 *
 * stdout carries the protocol; everything else goes to stderr, never with the
 * token.
 */
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  GetPromptRequestSchema,
  GetPromptResultSchema,
  ListPromptsRequestSchema,
  ListPromptsResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  ListResourcesRequestSchema,
  ListResourcesResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  ReadResourceRequestSchema,
  ReadResourceResultSchema,
  type CallToolResult,
  type ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js';

/** How long startup waits for the remote instance before falling back to catalog mode. */
export const CONNECT_TIMEOUT_MS = 5000;

export type BridgeMode = 'proxy' | 'catalog';

export interface BridgeOptions {
  /** Base URL of a Folio instance (FOLIO_URL). */
  url?: string;
  /** Personal access token (FOLIO_TOKEN). */
  token?: string;
  /** Where the stdio side listens; defaults to process stdin/stdout. */
  transport?: Transport;
  connectTimeoutMs?: number;
  log?: (message: string) => void;
}

export interface Bridge {
  mode: BridgeMode;
  server: Server;
  close(): Promise<void>;
}

const CONFIG_HINT =
  'This Folio MCP bridge is running without a connected Folio instance, so it can only list tools. ' +
  'Set FOLIO_URL (the base URL of your Folio instance) and FOLIO_TOKEN (a personal access token created in Folio: user menu, API tokens) ' +
  'in the environment of this MCP server, make sure the instance is reachable, and restart it.';

/** `${FOLIO_URL}/mcp`, tolerating a trailing slash or a URL that already ends in /mcp. */
export function mcpEndpoint(base: string): URL {
  const trimmed = base.trim().replace(/\/+$/, '');
  return new URL(trimmed.endsWith('/mcp') ? trimmed : `${trimmed}/mcp`);
}

/** A message that is safe to log: never contains the token, even if an error echoes it. */
function safeMessage(err: unknown, token: string): string {
  const text = err instanceof Error ? err.message : String(err);
  return token ? text.split(token).join('***') : text;
}

async function connectRemote(url: string, token: string, timeoutMs: number): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(mcpEndpoint(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'folio-mcp-stdio-bridge', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: timeoutMs, signal: AbortSignal.timeout(timeoutMs) });
    // The server is stateless and a rejected token can surface only on the first real request, so prove the token now.
    await client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema, { timeout: timeoutMs });
  } catch (err) {
    await client.close().catch(() => undefined);
    throw err;
  }
  return client;
}

/** Folio's real tool definitions, served by an in-process buildFolioMcpServer with a placeholder actor. */
async function startCatalog(): Promise<{ client: Client; close: () => Promise<void> }> {
  // Loaded lazily: proxy mode never needs the server modules.
  const { buildFolioMcpServer } = await import('./mcp.js');
  const catalogServer = buildFolioMcpServer({
    user: { id: 'catalog', email: 'catalog@invalid', name: 'Catalog', isAdmin: false, createdAt: new Date(0).toISOString() },
    scopes: ['read', 'write'],
    tokenId: 'catalog',
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'folio-mcp-stdio-catalog', version: '1.0.0' });
  await Promise.all([catalogServer.connect(serverSide), client.connect(clientSide)]);
  return {
    client,
    close: async () => {
      await client.close().catch(() => undefined);
      await catalogServer.close().catch(() => undefined);
    },
  };
}

export async function startBridge(options: BridgeOptions = {}): Promise<Bridge> {
  const log = options.log ?? ((message: string) => process.stderr.write(`[folio-mcp-stdio] ${message}\n`));
  const url = (options.url ?? '').trim();
  const token = (options.token ?? '').trim();
  const timeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;

  let mode: BridgeMode = 'catalog';
  let upstream: Client | undefined;
  let closeUpstream: () => Promise<void> = async () => undefined;

  if (url && token) {
    try {
      upstream = await connectRemote(url, token, timeoutMs);
      closeUpstream = () => upstream!.close().catch(() => undefined);
      mode = 'proxy';
      log(`proxy mode: connected to ${mcpEndpoint(url).origin}`);
    } catch (err) {
      log(`cannot use the Folio instance (${safeMessage(err, token)}); falling back to catalog mode`);
    }
  } else {
    log('FOLIO_URL and FOLIO_TOKEN are not both set; starting in catalog mode');
  }

  let capabilities: ServerCapabilities;
  let instructions: string | undefined;
  if (mode === 'proxy' && upstream) {
    const remote = upstream.getServerCapabilities() ?? {};
    capabilities = { tools: { listChanged: false } };
    if (remote.prompts) capabilities.prompts = { listChanged: false };
    if (remote.resources) capabilities.resources = { listChanged: false };
    instructions = upstream.getInstructions();
  } else {
    const catalog = await startCatalog();
    upstream = catalog.client;
    closeUpstream = catalog.close;
    capabilities = { tools: { listChanged: false }, prompts: { listChanged: false } };
    instructions = upstream.getInstructions();
  }
  const remote = upstream;

  const server = new Server({ name: 'folio', version: remote.getServerVersion()?.version ?? '0.0.0' }, { capabilities, instructions });

  server.setRequestHandler(ListToolsRequestSchema, (request) => remote.request({ method: 'tools/list', params: request.params }, ListToolsResultSchema));

  if (mode === 'proxy') {
    // Raw request, not client.callTool: the remote's result (structuredContent included) goes back untouched.
    server.setRequestHandler(CallToolRequestSchema, (request) => remote.request({ method: 'tools/call', params: request.params }, CallToolResultSchema));
    if (capabilities.prompts) {
      server.setRequestHandler(ListPromptsRequestSchema, (request) => remote.request({ method: 'prompts/list', params: request.params }, ListPromptsResultSchema));
      server.setRequestHandler(GetPromptRequestSchema, (request) => remote.request({ method: 'prompts/get', params: request.params }, GetPromptResultSchema));
    }
    if (capabilities.resources) {
      server.setRequestHandler(ListResourcesRequestSchema, (request) => remote.request({ method: 'resources/list', params: request.params }, ListResourcesResultSchema));
      server.setRequestHandler(ListResourceTemplatesRequestSchema, (request) => remote.request({ method: 'resources/templates/list', params: request.params }, ListResourceTemplatesResultSchema));
      server.setRequestHandler(ReadResourceRequestSchema, (request) => remote.request({ method: 'resources/read', params: request.params }, ReadResourceResultSchema));
    }
  } else {
    server.setRequestHandler(CallToolRequestSchema, async (): Promise<CallToolResult> => ({ isError: true, content: [{ type: 'text', text: CONFIG_HINT }] }));
    // Prompts are team skills kept in an instance: the catalog has none.
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
    server.setRequestHandler(GetPromptRequestSchema, async () => {
      throw new Error(CONFIG_HINT);
    });
  }

  await server.connect(options.transport ?? new StdioServerTransport());
  return {
    mode,
    server,
    close: async () => {
      await server.close().catch(() => undefined);
      await closeUpstream();
    },
  };
}

async function main(): Promise<void> {
  const bridge = await startBridge({ url: process.env.FOLIO_URL, token: process.env.FOLIO_TOKEN });
  const shutdown = (): void => {
    void bridge.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  // The client closing stdin ends the session.
  process.stdin.once('end', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`[folio-mcp-stdio] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
