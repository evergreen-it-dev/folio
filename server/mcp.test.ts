/**
 * Round 26 (DATA TABLES) — end-to-end smoke test for the eight new
 * folio_table_* MCP tools (spec §9), plus create_page's/update_page's
 * table-aware extensions. There is no pre-existing MCP test harness in this
 * codebase (server/mcp.ts had zero test files before this round) — this
 * establishes one using the SDK's own InMemoryTransport (a linked
 * Client<->Server pair within one process, no HTTP/stdio involved), which
 * exercises the REAL tool registration (names, zod input schemas, JSON-RPC
 * envelope) rather than calling buildFolioMcpServer's handler closures
 * directly. Everything below routes through server/tables/service.ts
 * underneath (already covered in depth by server/tables/service.test.ts) —
 * this file's job is proving the MCP WIRING (role checks, write-scope gate,
 * schema validation, tool naming) is correct, not re-testing service.ts's
 * own logic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as authStore from './auth/store.js';
import { buildFolioMcpServer, type McpActor } from './mcp.js';
import type { User } from '../shared/contracts.js';

async function connectedClient(actor: McpActor): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = buildFolioMcpServer(actor);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, close: async () => client.close() };
}

/** Every tool result in this file is `{ content: [{ type: 'text', text }] }` (textResult/errorResult in mcp.ts) — parse it back to JSON (or return the raw string for markdown-format results). */
function resultJson(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function resultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
}

describe('server/mcp.ts — folio_table_* tools (real fs + real PG, in-memory MCP transport)', () => {
  let teardownSchema: () => Promise<void>;
  let editorUser: User;
  let viewerUser: User;
  let spaceSlug: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    editorUser = await authStore.createUser({ email: `mcp-editor-${stamp}@test.local`, name: 'Editor', passwordHash: 'x', isAdmin: false });
    viewerUser = await authStore.createUser({ email: `mcp-viewer-${stamp}@test.local`, name: 'Viewer', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`MCP Tables ${stamp}`, null);
    spaceSlug = space.slug;
    await authStore.setMembership(spaceSlug, editorUser.id, 'editor');
    await authStore.setMembership(spaceSlug, viewerUser.id, 'viewer');
  });
  afterAll(async () => {
    await deleteTestSpace(spaceSlug);
    await teardownSchema();
  });

  const editorActor = (): McpActor => ({ user: editorUser, scopes: ['read', 'write'], tokenId: 'test-editor-token' });
  // Write-scoped token, but the underlying user only has 'viewer' ROLE in the space —
  // isolates the ROLE gate from the separate SCOPE gate (covered by its own test below).
  const viewerActor = (): McpActor => ({ user: viewerUser, scopes: ['read', 'write'], tokenId: 'test-viewer-token' });

  it('folio_table_create makes a table page with the given column schema', async () => {
    const { client, close } = await connectedClient(editorActor());
    try {
      const result = await client.callTool({
        name: 'folio_table_create',
        arguments: {
          space: spaceSlug,
          parentPath: '',
          title: 'Sprint Board',
          columns: [
            { name: 'Owner', type: 'text' },
            { name: 'Status', type: 'status', options: [{ value: 'DONE', color: 'green' }, { value: 'IN PROG', color: 'blue' }] },
          ],
        },
      });
      const meta = resultJson(result) as { id: string; kind: string; title: string };
      expect(meta.kind).toBe('table');
      expect(meta.title).toBe('Sprint Board');

      const doc = await storage.readFreshTableDoc(meta.id);
      expect(doc.columns.map((c) => c.id)).toEqual(['owner', 'status']);
    } finally {
      await close();
    }
  });

  it('create_page(kind: "table") creates a table via the generic tool too', async () => {
    const { client, close } = await connectedClient(editorActor());
    try {
      const result = await client.callTool({
        name: 'create_page',
        arguments: { space: spaceSlug, parentPath: '', title: 'Via Create Page', kind: 'table', columns: [{ name: 'Note', type: 'text' }] },
      });
      const meta = resultJson(result) as { kind: string };
      expect(meta.kind).toBe('table');
    } finally {
      await close();
    }
  });

  it('update_page refuses a table page with a clear pointer to the dedicated tools, instead of a generic "not doc" error', async () => {
    const { client, close } = await connectedClient(editorActor());
    try {
      const created = resultJson(
        await client.callTool({ name: 'folio_table_create', arguments: { space: spaceSlug, parentPath: '', title: 'Update Page Guard' } }),
      ) as { id: string };
      const result = await client.callTool({ name: 'update_page', arguments: { id: created.id, markdown: '# nope\n' } });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toMatch(/folio_table_insert|folio_table_update/);
    } finally {
      await close();
    }
  });

  describe('full round-trip: schema -> insert -> query -> update -> delete', () => {
    it('walks a table through its whole MCP lifecycle', async () => {
      const editor = await connectedClient(editorActor());
      try {
        const created = resultJson(
          await editor.client.callTool({
            name: 'folio_table_create',
            arguments: {
              space: spaceSlug,
              parentPath: '',
              title: 'Weekly Plan MCP',
              columns: [
                { name: 'Owner', type: 'text' },
                { name: 'Status', type: 'status', options: [{ value: 'PLANNING', color: 'purple' }, { value: 'DONE', color: 'green' }] },
              ],
            },
          }),
        ) as { id: string };
        const pageId = created.id;

        // schema-first: folio_table_schema reflects the REAL column ids, not guessed ones
        const schema = resultJson(await editor.client.callTool({ name: 'folio_table_schema', arguments: { id: pageId } })) as {
          columns: { id: string; name: string }[];
        };
        expect(schema.columns.map((c) => c.id)).toEqual(['owner', 'status']);

        // add a column via the dedicated tool
        const addColResult = resultJson(
          await editor.client.callTool({ name: 'folio_table_add_column', arguments: { id: pageId, name: 'Priority', type: 'number' } }),
        ) as { id: string };
        expect(addColResult.id).toBe('priority');

        // insert rows
        const inserted = resultJson(
          await editor.client.callTool({
            name: 'folio_table_insert',
            arguments: { id: pageId, rows: [{ owner: 'alice', status: 'PLANNING', priority: 1 }, { owner: 'bob', status: 'PLANNING', priority: 2 }] },
          }),
        ) as { rows: { id: string; values: Record<string, unknown> }[] };
        expect(inserted.rows).toHaveLength(2);
        const [aliceRow, bobRow] = inserted.rows;

        // query with a filter, markdown format
        const queried = await editor.client.callTool({
          name: 'folio_table_query',
          arguments: { id: pageId, filter: { op: 'and', rules: [{ column: 'owner', operator: 'is', value: 'alice' }] }, format: 'markdown' },
        });
        const md = resultText(queried);
        expect(md).toContain('alice');
        expect(md).not.toContain('bob');

        // update by rowId (filter omitted entirely — the exact case that used to
        // misfire as "filter requires limit", see mcpFilterSchema's doc comment in mcp.ts)
        const updated = resultJson(
          await editor.client.callTool({ name: 'folio_table_update', arguments: { id: pageId, rowId: aliceRow.id, values: { status: 'DONE' } } }),
        ) as { values: Record<string, unknown> };
        expect(updated.values.status).toBe('DONE');

        // update by filter WITHOUT limit is refused
        const noLimit = await editor.client.callTool({ name: 'folio_table_update', arguments: { id: pageId, filter: { op: 'and', rules: [] }, values: { status: 'DONE' } } });
        expect(noLimit.isError).toBe(true);

        // update by filter WITH limit succeeds
        const byFilter = resultJson(
          await editor.client.callTool({
            name: 'folio_table_update',
            arguments: { id: pageId, filter: { op: 'and', rules: [{ column: 'owner', operator: 'is', value: 'bob' }] }, limit: 10, values: { status: 'DONE' } },
          }),
        ) as { affected: number };
        expect(byFilter.affected).toBe(1);

        // list picks this table up in its space
        const listed = resultJson(await editor.client.callTool({ name: 'folio_table_list', arguments: { space: spaceSlug } })) as { id: string }[];
        expect(listed.some((p) => p.id === pageId)).toBe(true);

        // delete
        const del = resultJson(await editor.client.callTool({ name: 'folio_table_delete', arguments: { id: pageId, rowIds: [bobRow.id] } })) as { affected: number };
        expect(del.affected).toBe(1);

        const finalDoc = await storage.readFreshTableDoc(pageId);
        expect(finalDoc.rows).toHaveLength(1);
        expect(finalDoc.rows[0].values.owner).toBe('alice');
      } finally {
        await editor.close();
      }
    });
  });

  it('a read-scoped (viewer) actor can query but every write tool is refused', async () => {
    const editor = await connectedClient(editorActor());
    const viewer = await connectedClient(viewerActor());
    try {
      const created = resultJson(
        await editor.client.callTool({ name: 'folio_table_create', arguments: { space: spaceSlug, parentPath: '', title: 'Viewer Guard Table', columns: [{ name: 'X', type: 'text' }] } }),
      ) as { id: string };

      const read = await viewer.client.callTool({ name: 'folio_table_schema', arguments: { id: created.id } });
      expect(read.isError).toBeFalsy();

      const write = await viewer.client.callTool({ name: 'folio_table_insert', arguments: { id: created.id, rows: [{ x: 'nope' }] } });
      expect(write.isError).toBe(true);
      expect(resultText(write)).toMatch(/editor|role/i);
    } finally {
      await editor.close();
      await viewer.close();
    }
  });

  it('a read-only PAT (scopes without "write") is refused even for an editor-role user', async () => {
    const readOnlyEditorActor: McpActor = { user: editorUser, scopes: ['read'], tokenId: 'test-readonly-token' };
    const { client, close } = await connectedClient(readOnlyEditorActor);
    try {
      const result = await client.callTool({ name: 'folio_table_create', arguments: { space: spaceSlug, parentPath: '', title: 'Should Not Exist' } });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toMatch(/write scope/);
    } finally {
      await close();
    }
  });
});
