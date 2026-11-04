/**
 * Writing rules (real fs + real PG, in-memory MCP transport): the starter page, the per-space flag behind
 * GET /api/spaces, and the MCP tool `check_page_writing_rules` — readable by a plain member although `.agent`
 * itself is admin-only, a "no rules" answer, and the documents-only / no-access gates.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as authStore from './auth/store.js';
import { buildFolioMcpServer, type McpActor } from './mcp.js';
import { buildAgentRulesInfo } from './routes.js';
import { createStarterWritingRules, findWritingRulesEntry, loadWritingRules } from './writingRules.js';
import { serverText } from './serverText.js';
import { WRITING_RULES_PATH } from '../shared/contracts.js';
import type { User } from '../shared/contracts.js';

async function call(actor: McpActor, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; json: Record<string, any> }> {
  const server = buildFolioMcpServer(actor);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* an error message */
    }
    return { isError: result.isError === true, text, json };
  } finally {
    await client.close();
  }
}

describe('writing rules', () => {
  let teardownSchema: () => Promise<void>;
  let viewer: User;
  let outsider: User;
  let withRules: string;
  let withoutRules: string;
  let draftId: string;
  let boardId: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    viewer = await authStore.createUser({ email: `wr-viewer-${stamp}@test.local`, name: 'Vic Viewer', passwordHash: 'x', isAdmin: false });
    outsider = await authStore.createUser({ email: `wr-out-${stamp}@test.local`, name: 'Otto Outsider', passwordHash: 'x', isAdmin: false });
    withRules = (await storage.createSpace(`Rules ${stamp}`, null)).slug;
    withoutRules = (await storage.createSpace(`No rules ${stamp}`, null)).slug;
    await authStore.setMembership(withRules, viewer.id, 'viewer');
    await authStore.setMembership(withoutRules, viewer.id, 'viewer');
    draftId = (await storage.createPage({ space: withRules, parentPath: '', title: 'Draft', kind: 'doc' }, { docBody: '# Draft\n\nOur seamless, powerful platform utilizes SSO.\n' })).id;
    await storage.createPage({ space: withoutRules, parentPath: '', title: 'Plain', kind: 'doc' }, { docBody: '# Plain\n\nHello.\n' });
    boardId = (await storage.createPage({ space: withRules, parentPath: '', title: 'Sketch', kind: 'board' })).id;
  });
  afterAll(async () => {
    await deleteTestSpace(withRules);
    await deleteTestSpace(withoutRules);
    await teardownSchema();
  });

  const asViewer = (): McpActor => ({ user: viewer, scopes: ['read'], tokenId: 'wr-viewer' });

  it('has no rules until the starter page is created; creating it twice is a 409', async () => {
    expect(await findWritingRulesEntry(withRules)).toBeUndefined();
    expect((await storage.spacesWithWritingRules([withRules, withoutRules])).size).toBe(0);

    const meta = await createStarterWritingRules(withRules, 'en');
    expect(meta.path).toBe(WRITING_RULES_PATH);
    expect(meta.title).toBe('Writing rules');
    const entry = await findWritingRulesEntry(withRules);
    expect(entry?.id).toBe(meta.id);
    expect(await storage.readFreshDocBody(meta.id)).toContain('## Plain language');

    await expect(createStarterWritingRules(withRules, 'en')).rejects.toMatchObject({ status: 409 });
    expect([...(await storage.spacesWithWritingRules([withRules, withoutRules]))]).toEqual([withRules]);
  });

  it('the starter exists in every server language, with the same shape', () => {
    for (const lang of ['en', 'uk']) {
      const text = serverText('writingRules.template', lang);
      expect(text.startsWith('# ')).toBe(true);
      expect((text.match(/^## /gm) ?? []).length).toBeGreaterThanOrEqual(6);
    }
    expect(serverText('writingRules.template', 'uk')).not.toBe(serverText('writingRules.template', 'en'));
  });

  it('SpaceInfo.agentRules carries writingRules only when true', () => {
    expect(buildAgentRulesInfo(1, false, true)).toEqual({ used: true, pages: 1, writingRules: true });
    expect(buildAgentRulesInfo(1, true, false)).toEqual({ used: true, pages: 1, path: '.agent' });
  });

  it('loadWritingRules: a plain member reads the rules; a non-member gets 404', async () => {
    const rules = await loadWritingRules(viewer, withRules);
    expect(rules?.path).toBe(WRITING_RULES_PATH);
    expect(rules?.markdown).toContain('No marketing words');
    expect(await loadWritingRules(viewer, withoutRules)).toBeNull();
    await expect(loadWritingRules(outsider, withRules)).rejects.toMatchObject({ status: 404 });
  });

  it('check_page_writing_rules returns the rules and the page text to a read-only member', async () => {
    const res = await call(asViewer(), 'check_page_writing_rules', { page: draftId });
    expect(res.isError).toBe(false);
    expect(res.json.hasRules).toBe(true);
    expect(res.json.rules.path).toBe(WRITING_RULES_PATH);
    expect(res.json.rules.markdown).toContain('Define acronyms on first use');
    expect(res.json.page.markdown).toContain('seamless, powerful platform utilizes SSO');
    expect(res.json.instructions).toContain('exact fragment');
  });

  it('says so when the space has no writing rules, and refuses non-documents and strangers', async () => {
    const plain = (await storage.listEntries(withoutRules)).find((e) => e.title === 'Plain')!;
    const none = await call(asViewer(), 'check_page_writing_rules', { page: plain.id });
    expect(none.isError).toBe(false);
    expect(none.json.hasRules).toBe(false);
    expect(none.json.rules).toBeNull();
    expect(none.json.page.markdown).toContain('Hello.');

    const board = await call(asViewer(), 'check_page_writing_rules', { page: boardId });
    expect(board.isError).toBe(true);
    expect(board.text).toContain('documents only');

    const stranger = await call({ user: outsider, scopes: ['read'], tokenId: 'wr-out' }, 'check_page_writing_rules', { page: draftId });
    expect(stranger.isError).toBe(true);
    expect(stranger.text).toContain('page not found');
  });

  it('is not offered on a public site', async () => {
    const res = await call({ user: viewer, scopes: ['read'], tokenId: 'wr-pub', publicSpace: withRules }, 'check_page_writing_rules', { page: draftId });
    expect(res.isError).toBe(true);
  });
});
