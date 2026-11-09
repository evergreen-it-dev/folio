/**
 * MCP: read_page and fetch carry `verification` (owner, dates, state) for a page that has
 * the properties owner / verified / review_by, and nothing for one that has none; the
 * server instructions tell the agent to quote a stale page with a caveat. Real PG + files.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { buildFolioMcpServer, FOLIO_MCP_INSTRUCTIONS, type McpActor } from './mcp.js';
import * as storage from './storage.js';

async function call(actor: McpActor, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const server = buildFolioMcpServer(actor);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBeFalsy();
    return result.structuredContent as Record<string, any>;
  } finally {
    await client.close();
  }
}

describe('MCP verification state (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let slug: string;
  let reader: User;
  const ids: Record<string, string> = {};
  const actor = (): McpActor => ({ user: reader, scopes: ['read'], tokenId: `mcpver-${reader.id}` });

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    reader = await authStore.createUser({ email: `mcpver-${stamp}@example.com`, name: 'Reader', passwordHash: 'x', isAdmin: false });
    slug = (await storage.createSpace(`MCP Verification ${stamp}`, reader.id)).slug;
    await authStore.setMembership(slug, reader.id, 'admin');
    const dir = storage.getSpaceDir(slug);
    await fs.writeFile(path.join(dir, 'fresh.md'), '---\nowner: ann\nverified: 2999-01-01\nreview_by: 2999-06-01\n---\n# Fresh\n\nText.\n');
    await fs.writeFile(path.join(dir, 'late.md'), '---\nowner: ann\nverified: 2020-01-01\nreview_by: 2020-04-01\n---\n# Late\n\nText.\n');
    await fs.writeFile(path.join(dir, 'stale.md'), '---\nverified: 2020-01-01\n---\n# Stale\n\nText.\n');
    await fs.writeFile(path.join(dir, 'plain.md'), '# Plain\n\nText.\n');
    await storage.scanSpace(slug);
    for (const rel of ['fresh.md', 'late.md', 'stale.md', 'plain.md']) ids[rel] = (await storage.getEntryIdByExactPath(slug, rel))!;
  });
  afterAll(async () => {
    await deleteTestSpace(slug);
    await teardownSchema();
  });

  it('read_page gives the state, the owner and the dates', async () => {
    expect((await call(actor(), 'read_page', { id: ids['late.md'] })).verification).toEqual({ state: 'overdue', owner: 'ann', verified: '2020-01-01', reviewBy: '2020-04-01', daysOverdue: expect.any(Number) });
    expect((await call(actor(), 'read_page', { id: ids['fresh.md'] })).verification).toMatchObject({ state: 'verified', owner: 'ann' });
    expect((await call(actor(), 'read_page', { id: ids['stale.md'] })).verification).toEqual({ state: 'changed', verified: '2020-01-01' });
  });

  it('fetch gives it under metadata, and a page without the properties has none', async () => {
    const fetched = await call(actor(), 'fetch', { id: ids['late.md'] });
    expect(fetched.metadata.verification).toMatchObject({ state: 'overdue', owner: 'ann' });
    expect((await call(actor(), 'fetch', { id: ids['plain.md'] })).metadata.verification).toBeUndefined();
    expect((await call(actor(), 'read_page', { id: ids['plain.md'] })).verification).toBeUndefined();
  });

  it('the instructions tell the agent to quote a stale page with a caveat, and stay within the 2048 characters', () => {
    expect(FOLIO_MCP_INSTRUCTIONS).toMatch(/verification/);
    expect(FOLIO_MCP_INSTRUCTIONS).toMatch(/changed/);
    expect(FOLIO_MCP_INSTRUCTIONS).toMatch(/overdue/);
    expect(FOLIO_MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(2048);
  });
});
