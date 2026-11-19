import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildFolioMcpServer } from './mcp.js';
import { mcpEndpoint, startBridge, type Bridge } from './mcpStdio.js';

const TOKEN = 'folio_pat_test_token';
const REMOTE_INSTRUCTIONS = 'Remote instructions: be careful.';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

/** Starts the bridge on an in-memory transport and returns an SDK client talking to it. */
async function connectToBridge(options: { url?: string; token?: string }): Promise<{ client: Client; bridge: Bridge; logs: string[] }> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const logs: string[] = [];
  const bridge = await startBridge({ ...options, transport: serverSide, connectTimeoutMs: 3000, log: (m) => logs.push(m) });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientSide);
  cleanup.push(async () => {
    await client.close();
    await bridge.close();
  });
  return { client, bridge, logs };
}

/** A stateless fake Folio: one tool, one prompt, Bearer token required, like /mcp. */
async function startFakeRemote(): Promise<string> {
  const httpServer = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'authentication required' }, id: null }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const server = new McpServer({ name: 'fake-folio', version: '9.9.9' }, { instructions: REMOTE_INSTRUCTIONS });
      server.registerTool(
        'echo_remote',
        { description: 'Echoes a message from the fake remote.', inputSchema: { message: z.string() } },
        async ({ message }) => ({ content: [{ type: 'text' as const, text: `remote:${message}` }] }),
      );
      server.registerPrompt('fake-skill', { description: 'A fake skill.' }, async () => ({
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: 'skill body' } }],
      }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      void server.connect(transport).then(() => transport.handleRequest(req, res, body));
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));
  return `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
}

function referenceToolNames(): Promise<string[]> {
  const server = buildFolioMcpServer({
    user: { id: 'ref', email: 'ref@invalid', name: 'Ref', isAdmin: false, createdAt: new Date(0).toISOString() },
    scopes: ['read', 'write'],
    tokenId: 'ref',
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ref-client', version: '1.0.0' });
  return Promise.all([server.connect(serverSide), client.connect(clientSide)])
    .then(() => client.listTools())
    .then(async (r) => {
      await client.close();
      await server.close();
      return r.tools.map((t) => t.name).sort();
    });
}

describe('mcpEndpoint', () => {
  it('appends /mcp once and ignores trailing slashes', () => {
    expect(mcpEndpoint('https://wiki.example.com').href).toBe('https://wiki.example.com/mcp');
    expect(mcpEndpoint('https://wiki.example.com/').href).toBe('https://wiki.example.com/mcp');
    expect(mcpEndpoint('https://wiki.example.com/mcp').href).toBe('https://wiki.example.com/mcp');
  });
});

describe('stdio bridge, catalog mode', () => {
  it('lists the real Folio tools and instructions without any configuration', async () => {
    const { client, bridge } = await connectToBridge({});
    expect(bridge.mode).toBe('catalog');
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names.length).toBeGreaterThan(40);
    expect(names).toEqual(await referenceToolNames());
    expect(names).toContain('list_spaces');
    expect(tools.tools.every((t) => t.description && t.inputSchema)).toBe(true);
    expect(client.getInstructions()).toBeTruthy();
    expect((await client.listPrompts()).prompts).toEqual([]);
  });

  it('answers tools/call with an error that says what to configure', async () => {
    const { client } = await connectToBridge({});
    const result = await client.callTool({ name: 'list_spaces', arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('FOLIO_URL');
    expect(text).toContain('FOLIO_TOKEN');
  });
});

describe('stdio bridge, proxy mode', () => {
  it('forwards tools, prompts and instructions to the remote', async () => {
    const url = await startFakeRemote();
    const { client, bridge } = await connectToBridge({ url, token: TOKEN });
    expect(bridge.mode).toBe('proxy');
    expect(client.getInstructions()).toBe(REMOTE_INSTRUCTIONS);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['echo_remote']);
    const result = await client.callTool({ name: 'echo_remote', arguments: { message: 'hi' } });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'remote:hi' }]);
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(['fake-skill']);
    const prompt = await client.getPrompt({ name: 'fake-skill' });
    expect(prompt.messages[0].content).toEqual({ type: 'text', text: 'skill body' });
  });

  it('falls back to catalog mode on a wrong token without logging it', async () => {
    const url = await startFakeRemote();
    const { client, bridge, logs } = await connectToBridge({ url, token: 'folio_pat_wrong_secret' });
    expect(bridge.mode).toBe('catalog');
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('list_spaces');
    expect(logs.join('\n')).toContain('catalog mode');
    expect(logs.join('\n')).not.toContain('folio_pat_wrong_secret');
    const result = await client.callTool({ name: 'list_spaces', arguments: {} });
    expect(result.isError).toBe(true);
  });

  it('falls back to catalog mode when the instance is unreachable', async () => {
    const { bridge } = await connectToBridge({ url: 'http://127.0.0.1:9', token: TOKEN });
    expect(bridge.mode).toBe('catalog');
  });
});
