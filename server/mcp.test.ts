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
import { readFileSync } from 'node:fs';
import { buildFolioMcpServer, FOLIO_SERVER_VERSION, type McpActor } from './mcp.js';
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

describe('server/mcp.ts — server identity', () => {
  it('reports the product version from package.json on initialize, not a hard-coded one', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(FOLIO_SERVER_VERSION).toBe(pkg.version);

    const actor: McpActor = { user: { id: 'nobody' } as User, scopes: ['read'], tokenId: 'test-identity-token' };
    const { client, close } = await connectedClient(actor);
    try {
      expect(client.getServerVersion()).toMatchObject({ name: 'folio', version: pkg.version });
    } finally {
      await close();
    }
  });
});

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

  it('create_page writes the optional markdown into a document and ignores it for a table', async () => {
    const { client, close } = await connectedClient(editorActor());
    try {
      const doc = resultJson(
        await client.callTool({ name: 'create_page', arguments: { space: spaceSlug, parentPath: '', title: 'Ready Text', markdown: '# Ready Text\n\nBody from create_page.\n' } }),
      ) as { id: string; kind: string };
      expect(doc.kind).toBe('doc');
      expect(await storage.readFreshDocBody(doc.id)).toContain('Body from create_page.');

      const table = resultJson(
        await client.callTool({ name: 'create_page', arguments: { space: spaceSlug, parentPath: '', title: 'Table Ignores Text', kind: 'table', markdown: 'ignored text' } }),
      ) as { id: string; kind: string };
      expect(table.kind).toBe('table');
      expect(JSON.stringify(await storage.readFreshTableDoc(table.id))).not.toContain('ignored text');
    } finally {
      await close();
    }
  });

  describe('create_page: the requested title always names the page', () => {
    async function createDoc(arguments_: { title: string; markdown?: string }): Promise<{ meta: { id: string; title: string; path: string; kind: string }; body: string }> {
      const { client, close } = await connectedClient(editorActor());
      try {
        const meta = resultJson(await client.callTool({ name: 'create_page', arguments: { space: spaceSlug, parentPath: '', ...arguments_ } })) as {
          id: string;
          title: string;
          path: string;
          kind: string;
        };
        return { meta, body: await storage.readFreshDocBody(meta.id) };
      } finally {
        await close();
      }
    }
    const h1Lines = (body: string): string[] => body.split('\n').filter((line) => /^# /.test(line));

    it('markdown without an H1 is given the requested title as its first heading (the observed agent call)', async () => {
      const { meta, body } = await createDoc({
        title: 'Release notes',
        markdown: 'A short summary of what shipped this week.\n\n## Done\n\n- one\n- two\n',
      });
      expect(meta.title).toBe('Release notes');
      expect(meta.path).toMatch(/release-notes(-\d+)?\.md$/);
      expect(body.startsWith('# Release notes\n\nA short summary of what shipped this week.\n')).toBe(true);
      expect(body).toContain('## Done');
      // the stored index agrees with the response, not just the tool's reply
      expect((await storage.requireEntry(meta.id)).title).toBe('Release notes');
    });

    it('does not double the heading when the markdown already opens with the same H1, with or without leading blank lines', async () => {
      const plain = await createDoc({ title: 'Same H1 plain', markdown: '# Same H1 plain\n\nBody.\n' });
      expect(plain.meta.title).toBe('Same H1 plain');
      expect(h1Lines(plain.body)).toEqual(['# Same H1 plain']);

      const padded = await createDoc({ title: 'Same H1 padded', markdown: '\n\n# Same H1 padded\n\nBody.\n' });
      expect(padded.meta.title).toBe('Same H1 padded');
      expect(h1Lines(padded.body)).toEqual(['# Same H1 padded']);
    });

    it('keeps a different leading H1 as the page title and says so in the reply (the H1 is the title, the `title` argument only names the file)', async () => {
      const { meta, body } = await createDoc({ title: 'File name only', markdown: '# Heading the author chose\n\nBody.\n' });
      expect(meta.title).toBe('Heading the author chose');
      expect(meta.path).toMatch(/file-name-only(-\d+)?\.md$/);
      expect(h1Lines(body)).toEqual(['# Heading the author chose']);
    });

    it('treats a front matter block as metadata, not as content: icon and cover are applied, the heading goes below it', async () => {
      const withoutH1 = await createDoc({ title: 'Front matter no H1', markdown: '---\nicon: "\u{1F4DD}"\n---\nJust a paragraph.\n' });
      expect(withoutH1.meta.title).toBe('Front matter no H1');
      expect(withoutH1.body.startsWith('# Front matter no H1\n\nJust a paragraph.\n')).toBe(true);
      expect(withoutH1.body).not.toContain('---');
      expect((await storage.requireEntry(withoutH1.meta.id)).icon).toBe('\u{1F4DD}');

      const withH1 = await createDoc({ title: 'Front matter with H1', markdown: '---\nicon: "\u{1F4DD}"\n---\n\n# Front matter with H1\n\nBody.\n' });
      expect(withH1.meta.title).toBe('Front matter with H1');
      expect(h1Lines(withH1.body)).toEqual(['# Front matter with H1']);
      expect(withH1.body).not.toContain('---');
    });

    it('works for a non-ASCII title (the file name is transliterated, the title is not)', async () => {
      const title = '\u041D\u043E\u0442\u0430\u0442\u043A\u0438 \u0440\u0435\u043B\u0456\u0437\u0443';
      const { meta, body } = await createDoc({ title, markdown: 'Short summary without a heading.\n' });
      expect(meta.title).toBe(title);
      expect(body.startsWith(`# ${title}\n\nShort summary without a heading.\n`)).toBe(true);
      expect(meta.path).toMatch(/\.md$/);
    });

    it('a fenced code block that opens the markdown is not mistaken for a heading, even if a line inside starts with "#"', async () => {
      const { meta, body } = await createDoc({ title: 'Install guide', markdown: '```bash\n# install deps\nnpm ci\n```\n' });
      expect(meta.title).toBe('Install guide');
      expect(body.startsWith('# Install guide\n\n```bash\n')).toBe(true);
    });

    it('empty markdown gives the same blank starter page as omitting it', async () => {
      const { meta, body } = await createDoc({ title: 'Empty markdown', markdown: '' });
      expect(meta.title).toBe('Empty markdown');
      expect(body).toBe('# Empty markdown\n');
    });

    it('omitting markdown is unchanged: the blank starter page is just the title as an H1', async () => {
      const { meta, body } = await createDoc({ title: 'No markdown at all' });
      expect(meta.title).toBe('No markdown at all');
      expect(body).toBe('# No markdown at all\n');
    });
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

  it('folio_table_insert gives an unfilled checkbox the same value the grid does (false, not null), and update leaves it alone', async () => {
    const { client, close } = await connectedClient(editorActor());
    try {
      const created = resultJson(
        await client.callTool({
          name: 'folio_table_create',
          arguments: {
            space: spaceSlug,
            parentPath: '',
            title: 'Checkbox Defaults',
            columns: [
              { name: 'Task', type: 'text' },
              { name: 'Done', type: 'checkbox' },
              { name: 'Reviewed', type: 'checkbox', default: true },
              { name: 'Note', type: 'text' },
            ],
          },
        }),
      ) as { id: string };

      const inserted = resultJson(
        await client.callTool({ name: 'folio_table_insert', arguments: { id: created.id, rows: [{ task: 'omit the checkboxes' }, { task: 'tick one', done: true }] } }),
      ) as { rows: { id: string; values: Record<string, unknown> }[] };
      // unfilled checkbox -> false; its own `default` still wins; other column types stay null
      expect(inserted.rows[0].values).toEqual({ task: 'omit the checkboxes', done: false, reviewed: true, note: null });
      expect(inserted.rows[1].values).toEqual({ task: 'tick one', done: true, reviewed: true, note: null });

      // folio_table_update touches only the listed columns: the checkbox stays false and no other column gains a value
      const updated = resultJson(
        await client.callTool({ name: 'folio_table_update', arguments: { id: created.id, rowId: inserted.rows[0].id, values: { note: 'edited' } } }),
      ) as { values: Record<string, unknown> };
      expect(updated.values).toEqual({ task: 'omit the checkboxes', done: false, reviewed: true, note: 'edited' });

      const queried = resultJson(await client.callTool({ name: 'folio_table_query', arguments: { id: created.id, format: 'json' } })) as {
        rows: { values: Record<string, unknown> }[];
      };
      expect(queried.rows.map((r) => r.values.done)).toEqual([false, true]);
    } finally {
      await close();
    }
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
