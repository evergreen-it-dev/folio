/**
 * The assistant's tools (tools.ts: Folio's MCP server built for the signed-in
 * user, plus two built-ins) must never hand a user anything from a space — or a
 * page — that user cannot read: no content, no title, no snippet, no slug, no
 * page id, no path. Found while recording the assistant-analytics video: Sam's
 * answer cited a page of another space, "Company Policies". The audit's
 * answer is that this particular citation was legitimate (the space is
 * visible to the whole instance, so Sam is its implicit viewer, and the system
 * prompt tells the assistant to search every space the user can see), and the
 * tests below pin the rule down in both directions:
 *  - a PRIVATE space (and a page hidden by page-level access, and `.agent`)
 *    stays invisible through every read tool, however it is asked for;
 *  - an INSTANCE-visible space is readable by a non-member, as the access
 *    model says (docs/spec-access.md §3).
 *
 * The second half covers the other way to the same data: the Cursor agent runs
 * without an OS sandbox, so any built-in file/shell tool it were offered could
 * read the repositories of every space from disk. The run must offer the
 * model the `mcp` tool family only.
 *
 * Real PostgreSQL, real storage, real MCP server over the in-memory transport.
 * Only the Cursor SDK is mocked.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { User } from '../../shared/contracts.js';

const sdkMock = vi.hoisted(() => {
  const run = { supports: () => false, wait: async () => ({ status: 'finished', result: 'Stub reply' }), cancel: async () => {} };
  const agent = { reload: async () => {}, send: vi.fn(async () => run), close: async () => {} };
  return {
    resume: vi.fn(async (_id: string, _options: unknown) => agent),
    create: vi.fn(async (_options: unknown) => agent),
    configure: vi.fn(),
  };
});

vi.mock('@cursor/sdk', () => ({
  Cursor: { configure: sdkMock.configure },
  JsonlLocalAgentStore: class {},
  Agent: { resume: sdkMock.resume, create: sdkMock.create },
}));
vi.mock('./cursorCliConfig.js', () => ({ ensureAssistantCursorPermissions: vi.fn() }));

// cursorRuntime.ts gates on Node >= 22.13; the SDK is mocked, so fake the version on an older Node (same as spaceAccess.test.ts).
const realNodeVersions = process.versions;
{
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    Object.defineProperty(process, 'versions', { value: { ...process.versions, node: '22.13.0' }, configurable: true });
  }
}

const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-assistant-ws-'));
const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-assistant-state-'));
process.env.CURSOR_AGENT_WORKSPACE_ROOT = workspaceRoot;
process.env.CURSOR_AGENT_STATE_DIR = stateDir;

const { setUpTestSchema, deleteTestSpace } = await import('../db/testSchema.js');
const authStore = await import('../auth/store.js');
const storage = await import('../storage.js');
const pageAccess = await import('../pageAccess.js');
const { buildAssistantTools, READ_SKILL_TOOL } = await import('./tools.js');
const { runCursorAssistant, ASSISTANT_BUILTIN_TOOLS } = await import('./cursorRuntime.js');
const assistantStore = await import('./store.js');

type Tools = Awaited<ReturnType<typeof buildAssistantTools>>;

describe('assistant tools only return what the user may read (real PG, in-process MCP, mocked Cursor SDK)', () => {
  let teardownSchema: () => Promise<void>;
  const stamp = Date.now();
  const createdSpaces: string[] = [];
  const open: Tools[] = [];

  // Space A: alice's (carol is a plain viewer there). Space B: private, bob's, holds every secret.
  // Space C: visible to the whole instance. eve is a member of nothing.
  let alice: User;
  let bob: User;
  let carol: User;
  let eve: User;
  let root: User; // instance admin without a membership in B
  let slugA: string;
  let slugB: string;
  let slugC: string;
  let nameB: string;
  const ids = { a: '', aHidden: '', b: '', bTable: '', bAgent: '', c: '' };
  const titleB = `Bravo payroll ${stamp}`;
  const titleBTable = `Bravo salaries ${stamp}`;
  const markerB = `bravosecret${stamp}`;
  const markerBTable = `bravorow${stamp}`;
  const markerBAgent = `bravoagent${stamp}`;
  const markerAHidden = `hiddeninalpha${stamp}`;
  const markerC = `commonpolicy${stamp}`;
  const titleC = `Common Policies ${stamp}`;

  async function tools(user: User, mode: 'ask' | 'agent' = 'ask'): Promise<Tools> {
    const handle = await buildAssistantTools(user, mode, { runId: 'r', conversationId: 'c', space: null, pageId: null });
    open.push(handle);
    return handle;
  }

  /** Calls one tool and returns the whole answer as text, whether it succeeded or not. */
  async function call(handle: Tools, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
    const tool = handle.tools[name];
    if (!tool) throw new Error(`tool ${name} is not offered`);
    const result = (await tool.execute(args as never, {} as never)) as unknown;
    if (typeof result === 'string') return { text: result, isError: false };
    const r = result as { content?: Array<{ text?: string }>; isError?: boolean };
    return { text: (r.content ?? []).map((c) => c.text ?? '').join('\n'), isError: !!r.isError };
  }

  /** Everything that identifies B or anything in it. */
  const secretsOfB = () => [slugB, nameB, titleB, titleBTable, markerB, markerBTable, markerBAgent, ids.b, ids.bTable, ids.bAgent];

  function expectNoSecretsOfB(text: string): void {
    for (const secret of secretsOfB()) expect(text, `leaked ${secret}`).not.toContain(secret);
  }

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const mk = (name: string, isAdmin = false) => authStore.createUser({ email: `tool-${name}-${stamp}@test.local`, name, passwordHash: 'x', isAdmin });
    [alice, bob, carol, eve, root] = await Promise.all([mk('alice'), mk('bob'), mk('carol'), mk('eve'), mk('root', true)]);

    const spaceA = await storage.createSpace(`Tool Alpha ${stamp}`, alice.id);
    nameB = `Tool Bravo ${stamp}`;
    const spaceB = await storage.createSpace(nameB, bob.id);
    const spaceC = await storage.createSpace(`Tool Common ${stamp}`, bob.id);
    [slugA, slugB, slugC] = [spaceA.slug, spaceB.slug, spaceC.slug];
    createdSpaces.push(slugA, slugB, slugC);

    await authStore.setMembership(slugA, alice.id, 'editor');
    await authStore.setMembership(slugA, carol.id, 'viewer');
    await authStore.setMembership(slugB, bob.id, 'admin');
    await authStore.setMembership(slugC, bob.id, 'admin');
    await authStore.setSpaceVisibility(slugC, 'instance');

    const doc = async (space: string, title: string, body: string) => (await storage.createPage({ space, parentPath: '', title, kind: 'doc' }, { docBody: `# ${title}\n\n${body}\n` })).id;
    ids.a = await doc(slugA, `Alpha notes ${stamp}`, 'Open notes of the alpha team.');
    ids.b = await doc(slugB, titleB, `Salaries are in the table. ${markerB}`);
    ids.c = await doc(slugC, titleC, `Everybody reads this. ${markerC}`);
    ids.bTable = (await storage.createPage({ space: slugB, parentPath: '', title: titleBTable, kind: 'table', columns: [{ id: 'who', name: 'Who', type: 'text' }] })).id;
    ids.bAgent = (await storage.createPage({ space: slugB, parentPath: '.agent', title: 'Rules', kind: 'doc' }, { docBody: `# Rules\n\nPrivate rules. ${markerBAgent}\n` })).id;

    // A page of A that A's plain viewer carol must not see (page-level access), linking to a page she can see.
    ids.aHidden = await doc(slugA, `Alpha restricted ${stamp}`, `Only for alice. ${markerAHidden} [notes](./${(await storage.requireEntry(ids.a)).relPath.split('/').pop()})`);
    await pageAccess.setAccess(alice, await storage.requireEntry(ids.aHidden), 'restricted', []);
  });

  afterAll(async () => {
    await Promise.all(open.map((h) => h.close()));
    for (const slug of createdSpaces) await deleteTestSpace(slug).catch(() => {});
    await teardownSchema();
    Object.defineProperty(process, 'versions', { value: realNodeVersions, configurable: true });
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  // -------------------------------------------------------------------------
  // The reported situation: a space the user did not join, seen through the assistant
  // -------------------------------------------------------------------------

  it('sanity: the member of B does see all of it (the fixtures are findable, so the negatives below mean something)', async () => {
    const t = await tools(bob);
    expect((await call(t, 'list_spaces')).text).toContain(slugB);
    expect((await call(t, 'list_tree', { space: slugB })).text).toContain(titleB);
    expect((await call(t, 'read_page', { id: ids.b })).text).toContain(markerB);
    expect((await call(t, 'search_pages', { query: markerB })).text).toContain(ids.b);
    expect((await call(t, 'folio_table_list', {})).text).toContain(titleBTable);
  });

  it('list_spaces: a non-member sees the spaces she can read — her own and the instance-visible one — and not the private one', async () => {
    const out = (await call(await tools(alice), 'list_spaces')).text;
    expect(out).toContain(slugA);
    expect(out).toContain(slugC);
    expectNoSecretsOfB(out);
    const none = (await call(await tools(eve), 'list_spaces')).text;
    expect(none).toContain(slugC);
    expect(none).not.toContain(slugA);
    expectNoSecretsOfB(none);
  });

  it('search_pages: nothing of B, by marker, by title or by path, across all spaces or aimed straight at B', async () => {
    const t = await tools(alice);
    for (const query of [markerB, markerBTable, markerBAgent, 'payroll', 'Bravo', titleB, titleBTable, 'Rules']) {
      expectNoSecretsOfB((await call(t, 'search_pages', { query })).text);
    }
    const aimed = await call(t, 'search_pages', { query: markerB, space: slugB });
    expect(aimed.isError).toBe(true);
    expectNoSecretsOfB(aimed.text.replace(slugB, ''));
  });

  it('an instance admin who is not a member of B reads nothing of B either (admin = administer, not read)', async () => {
    const t = await tools(root);
    expectNoSecretsOfB((await call(t, 'search_pages', { query: markerB })).text);
    expectNoSecretsOfB((await call(t, 'list_spaces')).text);
    expect((await call(t, 'read_page', { id: ids.b })).isError).toBe(true);
    expect((await call(t, 'list_tree', { space: slugB })).isError).toBe(true);
  });

  it('every targeted read of B is refused and says nothing about B: list_tree, read_page, resolve_folio_url, history, tables, backlinks', async () => {
    const t = await tools(alice);
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['list_tree', { space: slugB }],
      ['read_page', { id: ids.b }],
      ['read_page', { id: ids.bTable }],
      ['read_page', { id: ids.bAgent }],
      ['resolve_folio_url', { url: `/s/${slugB}` }],
      ['resolve_folio_url', { url: `/s/${slugB}/p/${ids.b}` }],
      ['resolve_folio_url', { url: `https://folio.example.com/s/${slugB}/d/anything` }],
      ['get_backlinks', { id: ids.b }],
      ['page_history', { id: ids.b }],
      ['page_at_sha', { id: ids.b, sha: 'HEAD' }],
      ['folio_table_schema', { id: ids.bTable }],
      ['folio_table_query', { id: ids.bTable }],
      ['folio_table_list', { space: slugB }],
    ];
    for (const [name, args] of attempts) {
      const out = await call(t, name, args);
      expect(out.isError, `${name} ${JSON.stringify(args)} should be refused`).toBe(true);
      // The only thing a refusal may repeat is what the caller typed herself (the slug / id she passed in).
      const text = out.text.split(slugB).join('').split(ids.b).join('').split(ids.bTable).join('').split(ids.bAgent).join('');
      expectNoSecretsOfB(text);
    }
  });

  it('folio_table_list without a space: the instance-wide listing leaves out B\'s tables', async () => {
    expectNoSecretsOfB((await call(await tools(alice), 'folio_table_list', {})).text);
  });

  it('write tools cannot reach B either, in agent mode: create_page, update_page, create_board, folio_table_insert are refused', async () => {
    const t = await tools(alice, 'agent');
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['create_page', { space: slugB, parentPath: '', title: 'Planted', markdown: 'x' }],
      ['update_page', { id: ids.b, markdown: '# changed' }],
      ['folio_table_create', { space: slugB, parentPath: '', title: 'Planted table' }],
      ['folio_table_insert', { id: ids.bTable, rows: [{ who: 'x' }] }],
    ];
    for (const [name, args] of attempts) {
      const out = await call(t, name, args);
      expect(out.isError, name).toBe(true);
    }
    expect((await storage.listEntries(slugB)).some((e) => e.title === 'Planted' || e.title === 'Planted table')).toBe(false);
    expect((await call(await tools(bob), 'read_page', { id: ids.b })).text).toContain(markerB);
  });

  it('no existence oracle: a private space and a slug that does not exist are answered the same way, for spaces and for pages', async () => {
    const t = await tools(alice);
    const ghost = `no-such-space-${stamp}`;
    const real = await call(t, 'list_tree', { space: slugB });
    const none = await call(t, 'list_tree', { space: ghost });
    expect(real.text).toBe(none.text);
    expect((await call(t, 'search_pages', { query: 'x', space: slugB })).text).toBe((await call(t, 'search_pages', { query: 'x', space: ghost })).text);
    expect((await call(t, 'read_page', { id: ids.b })).text).toBe((await call(t, 'read_page', { id: `01NOSUCHPAGE${stamp}` })).text);
  });

  // -------------------------------------------------------------------------
  // The legitimate side: the instance-visible space
  // -------------------------------------------------------------------------

  it('an instance-visible space is readable by a non-member, with the viewer role the access model gives her (this is the "Company Policies" case)', async () => {
    const t = await tools(eve);
    expect((await call(t, 'list_spaces')).text).toMatch(new RegExp(`${slugC}[\\s\\S]*"myRole": "viewer"`));
    expect((await call(t, 'list_tree', { space: slugC })).text).toContain(titleC);
    expect((await call(t, 'read_page', { id: ids.c })).text).toContain(markerC);
    expect((await call(t, 'search_pages', { query: markerC })).text).toContain(ids.c);
    // ...read-only: she is an implicit viewer, not an editor.
    const write = await call(await tools(eve, 'agent'), 'update_page', { id: ids.c, markdown: '# vandalism' });
    expect(write.isError).toBe(true);
    expect((await call(await tools(bob), 'read_page', { id: ids.c })).text).not.toContain('vandalism');
  });

  it('once the space stops being instance-visible it disappears from the same user\'s tools at once', async () => {
    const extra = await storage.createSpace(`Tool Temp ${stamp}`, bob.id);
    createdSpaces.push(extra.slug);
    await authStore.setSpaceVisibility(extra.slug, 'instance');
    const pageId = (await storage.createPage({ space: extra.slug, parentPath: '', title: 'Temp page', kind: 'doc' }, { docBody: `# Temp page\n\ntempmarker${stamp}\n` })).id;
    const t = await tools(eve);
    expect((await call(t, 'read_page', { id: pageId })).text).toContain(`tempmarker${stamp}`);
    await authStore.setSpaceVisibility(extra.slug, 'private');
    expect((await call(t, 'read_page', { id: pageId })).isError).toBe(true);
    expect((await call(t, 'search_pages', { query: `tempmarker${stamp}` })).text).not.toContain(pageId);
    expect((await call(t, 'list_spaces')).text).not.toContain(extra.slug);
  });

  // -------------------------------------------------------------------------
  // Page level inside a space the user can read
  // -------------------------------------------------------------------------

  it('a page hidden by page-level access is invisible inside a readable space: tree, read, search, backlinks, history', async () => {
    const t = await tools(carol);
    expect((await call(t, 'list_tree', { space: slugA })).text).toContain(`Alpha notes ${stamp}`);
    const hidden = [`Alpha restricted ${stamp}`, markerAHidden, ids.aHidden];
    const texts = [
      (await call(t, 'list_tree', { space: slugA })).text,
      (await call(t, 'search_pages', { query: markerAHidden })).text,
      (await call(t, 'search_pages', { query: 'restricted', space: slugA })).text,
      (await call(t, 'get_backlinks', { id: ids.a })).text, // aHidden links to a: the source is hidden from carol
    ];
    for (const text of texts) for (const h of hidden) expect(text).not.toContain(h);
    for (const name of ['read_page', 'page_history', 'get_backlinks']) {
      if (name === 'get_backlinks') continue;
      expect((await call(t, name, { id: ids.aHidden })).isError, name).toBe(true);
    }
    // Her colleague with a grant (alice owns it) does see it.
    expect((await call(await tools(alice), 'read_page', { id: ids.aHidden })).text).toContain(markerAHidden);
  });

  it('.agent pages are not readable through the tools by a non-admin, even a member of that very space', async () => {
    await authStore.setMembership(slugB, carol.id, 'editor');
    try {
      const t = await tools(carol);
      expect((await call(t, 'read_page', { id: ids.bAgent })).isError).toBe(true);
      expect((await call(t, 'search_pages', { query: markerBAgent })).text).not.toContain(ids.bAgent);
      expect((await call(t, 'list_tree', { space: slugB })).text).not.toContain('Rules');
    } finally {
      await authStore.removeMembership(slugB, carol.id);
    }
  });

  it('a disabled user gets nothing from any tool, instance-visible space included', async () => {
    const gone = { ...alice, disabled: true };
    const t = await tools(gone);
    expect((await call(t, 'list_spaces')).text).toBe('[]');
    expect((await call(t, 'read_page', { id: ids.c })).isError).toBe(true);
    expect((await call(t, 'search_pages', { query: markerC })).text).not.toContain(ids.c);
  });

  // -------------------------------------------------------------------------
  // The tool surface itself
  // -------------------------------------------------------------------------

  it('the model is offered no tool that takes a file path, a command or a URL', async () => {
    const names = Object.keys((await tools(bob, 'agent')).tools);
    expect(names.sort()).toEqual(
      [
        'board_ops', 'create_board', 'create_page', 'folio_table_add_column', 'folio_table_create', 'folio_table_delete', 'folio_table_insert',
        'folio_table_list', 'folio_table_query', 'folio_table_schema', 'folio_table_update', 'get_backlinks', 'list_spaces', 'list_tree', 'page_at_sha',
        'page_history', 'read_page', 'read_skill', 'report_unanswered_question', 'resolve_folio_url', 'search_pages', 'update_board', 'update_page',
      ].sort(),
    );
  });

  it('read_skill returns a shipped skill and nothing else: a path is not a skill name', async () => {
    const t = await tools(eve);
    const ok = await call(t, READ_SKILL_TOOL, { name: 'folio-mcp' });
    expect(ok.isError).toBe(false);
    expect(ok.text).toContain('list_spaces');
    for (const name of ['../../../.env', '/etc/passwd', 'folio-mcp/../folio-tables', '..', '', 'FOLIO-MCP']) {
      const out = await call(t, READ_SKILL_TOOL, { name });
      expect(out.isError, name).toBe(true);
      expect(out.text).toContain('Unknown skill');
    }
    expect((await call(t, READ_SKILL_TOOL, {})).isError).toBe(true);
  });

  // -------------------------------------------------------------------------
  // No OS sandbox: the Cursor agent must be offered the MCP tool family only
  // -------------------------------------------------------------------------

  it('every run restricts the Cursor agent\'s built-in tools to `mcp` — on create and on resume — so no shell/read/grep/glob/web tool exists to open files outside the Folio tools', async () => {
    expect(ASSISTANT_BUILTIN_TOOLS).toEqual(['mcp']);
    const conversation = await assistantStore.insertConversation({ userId: alice.id, title: 'x', cursorAgentId: `agent-${stamp}`, model: 'composer-2' });
    const run = (mode: 'ask' | 'agent') =>
      runCursorAssistant({ runId: 'r1', apiKey: 'k', user: alice, conversation, message: 'hi', currentPath: null, space: slugA, pageId: null, runMode: mode });

    sdkMock.resume.mockClear();
    sdkMock.create.mockClear();
    // First: resume finds nothing -> create is used.
    sdkMock.resume.mockRejectedValueOnce(new Error('agent not found'));
    expect(await run('ask')).toBe('Stub reply');
    expect(sdkMock.create).toHaveBeenCalledTimes(1);
    expect((sdkMock.create.mock.calls[0]![0] as { tools?: string[] }).tools).toEqual(['mcp']);
    // Second: an existing agent is resumed — the restriction is not persisted by the SDK, so it must be passed again.
    expect(await run('agent')).toBe('Stub reply');
    expect(sdkMock.resume).toHaveBeenCalledTimes(2);
    expect((sdkMock.resume.mock.calls[1]![1] as { tools?: string[] }).tools).toEqual(['mcp']);
    for (const call of [...sdkMock.create.mock.calls.map((c) => c[0]), ...sdkMock.resume.mock.calls.map((c) => c[1])]) {
      const options = call as { tools?: string[]; disallowedTools?: string[]; local?: { customTools?: Record<string, unknown> } };
      expect(options.tools).toBeDefined();
      expect(Object.keys(options.local?.customTools ?? {})).toContain('read_skill');
    }
  });
});
