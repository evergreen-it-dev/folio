// Codex is off by default (providerFlags.ts); these tests are about it switched on. Read at call time.
process.env.FOLIO_CODEX_ENABLED = '1';
/** The per-run MCP endpoint of a Codex run: a real HTTP server on loopback, an MCP client, no database. */
import type { SDKCustomTool } from '@cursor/sdk';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openCodexRunEndpointCount, openCodexRunMcp, registerCodexRunMcpRoutes, setCodexRunMcpPort } from './codexRunMcp.js';

let app: FastifyInstance;
const calls: unknown[] = [];

const tools: Record<string, SDKCustomTool> = {
  echo: {
    description: 'Echoes the text.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async execute(args) {
      calls.push(args);
      return `echo: ${(args as { text: string }).text}`;
    },
  },
  broken: {
    description: 'Always fails.',
    inputSchema: { type: 'object', properties: {} },
    async execute() { throw new Error('tool exploded'); },
  },
};

beforeAll(async () => {
  app = Fastify();
  registerCodexRunMcpRoutes(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  setCodexRunMcpPort(typeof address === 'object' && address ? address.port : 0);
});
afterAll(async () => { await app.close(); });

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
const post = (url: string, headers: Record<string, string>) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(initialize) });

describe('the run MCP endpoint', () => {
  it('serves exactly the run\'s tools to a client that has the token, and only until close()', async () => {
    const run = openCodexRunMcp(tools);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(run.url), { requestInit: { headers: { authorization: `Bearer ${run.token}` } } }));
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(['broken', 'echo']);
    const ok = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(ok.content).toEqual([{ type: 'text', text: 'echo: hi' }]);
    expect(await client.callTool({ name: 'echo', arguments: {} })).toMatchObject({ isError: true });
    expect(await client.callTool({ name: 'broken', arguments: {} })).toMatchObject({ isError: true, content: [{ text: 'tool exploded' }] });
    expect(await client.callTool({ name: 'not_a_tool', arguments: {} })).toMatchObject({ isError: true });
    await client.close();

    run.close();
    expect(openCodexRunEndpointCount()).toBe(0);
    expect((await post(run.url, { authorization: `Bearer ${run.token}` })).status).toBe(401);
  });

  it('rejects a wrong, a missing and another run\'s token', async () => {
    const run = openCodexRunMcp(tools);
    const other = openCodexRunMcp(tools);
    try {
      expect((await post(run.url, { authorization: 'Bearer wrong' })).status).toBe(401);
      expect((await post(run.url, {})).status).toBe(401);
      expect((await post(run.url, { authorization: `Bearer ${other.token}` })).status).toBe(401);
      expect((await post(run.url, { authorization: `Basic ${run.token}` })).status).toBe(401);
      expect((await post(run.url.replace(/assistant-run\/[0-9a-f]+/, 'assistant-run/deadbeef'), { authorization: `Bearer ${run.token}` })).status).toBe(401);
      expect((await post(run.url, { authorization: `Bearer ${run.token}` })).status).toBe(200);
    } finally {
      run.close();
      other.close();
    }
  });

  it('is not reachable from a non-loopback peer, nor through a proxy, even with the right token', async () => {
    const run = openCodexRunMcp(tools);
    try {
      const path = new URL(run.url).pathname;
      const base = { method: 'POST' as const, url: path, payload: initialize, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${run.token}` } };
      expect((await app.inject({ ...base, remoteAddress: '203.0.113.7' })).statusCode).toBe(404);
      expect((await app.inject({ ...base, remoteAddress: '10.0.0.5' })).statusCode).toBe(404);
      expect((await app.inject({ ...base, remoteAddress: '127.0.0.1', headers: { ...base.headers, 'x-forwarded-for': '203.0.113.7' } })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: path, remoteAddress: '203.0.113.7' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: path, remoteAddress: '127.0.0.1' })).statusCode).toBe(405);
    } finally {
      run.close();
    }
  });

  it('is not reachable at all while Codex is off, even from loopback with the right token', async () => {
    const run = openCodexRunMcp(tools);
    delete process.env.FOLIO_CODEX_ENABLED;
    try {
      expect((await post(run.url, { authorization: `Bearer ${run.token}` })).status).toBe(404);
      expect((await app.inject({ method: 'GET', url: new URL(run.url).pathname, remoteAddress: '127.0.0.1' })).statusCode).toBe(404);
    } finally {
      process.env.FOLIO_CODEX_ENABLED = '1';
      run.close();
    }
  });
});
