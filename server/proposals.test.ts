/**
 * Agent write mode and the review queue (real PG): direct mode does not change
 * what a tool answers; in review mode update_page / create_page (MCP, the
 * assistant, REST with a token) queue a proposal and the text stays put until an
 * editor accepts; a person in the browser is never queued; a stale proposal needs
 * the differences to have been shown; the same token proposing again replaces the
 * open proposal without telling the reviewers twice.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiTokenScope, User } from '../shared/contracts.js';
import type { PageProposalDetail, PageProposalSummary, ProposalListResponse } from '../shared/proposals.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { query } from './db/pool.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import * as gitSync from './gitSync.js';
import { buildFolioMcpServer, MCP_WRITE_TOOL_NAMES } from './mcp.js';
import { REVIEW_DIRECT_TOOL_NAMES, REVIEW_QUEUED_TOOL_NAMES, REVIEW_REFUSED_TOOL_NAMES } from './mcpReviewGuard.js';
import { listNotifications } from './notifications/routes.js';
import { registerProposalRoutes } from './proposalsRoutes.js';
import { registerRoutes } from './routes.js';
import * as storage from './storage.js';
import { updateVerification } from './verification.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  await app.register(async (scope) => {
    scope.addHook('onRequest', session.requireSession);
    registerRoutes(scope);
    registerProposalRoutes(scope);
  });
  await app.ready();
  return app;
}

describe('agent write mode and the review queue (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let admin: User;
  let editor: User;
  let agentOwner: User;
  let viewer: User;
  let space: string;
  let pageId: string;
  let cookies: Record<'admin' | 'editor' | 'agentOwner' | 'viewer', { cookie: string }>;
  let agentPat: { authorization: string };

  const cookieOf = async (user: User): Promise<{ cookie: string }> => ({ cookie: `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(user.id)).token}` });

  async function withMcp<T>(user: User, tokenId: string, fn: (call: (name: string, args: Record<string, unknown>) => Promise<{ isError?: boolean; text: string; structured?: Record<string, unknown> }>) => Promise<T>): Promise<T> {
    const server = buildFolioMcpServer({ user, scopes: ['read', 'write'], tokenId });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      return await fn(async (name, args) => {
        const res = await client.callTool({ name, arguments: args });
        const text = (res.content as Array<{ type: string; text: string }>).map((c) => c.text).join('\n');
        return { isError: res.isError === true, text, structured: res.structuredContent as Record<string, unknown> | undefined };
      });
    } finally {
      await client.close();
    }
  }

  const setMode = (mode: 'direct' | 'review', who: keyof typeof cookies = 'admin') =>
    app.inject({ method: 'PATCH', url: `/api/spaces/${space}/agent-settings`, headers: cookies[who], payload: { agentWriteMode: mode } });
  const pageText = async (id = pageId) => (await storage.readFreshDocBody(id)).trim();
  const feed = async (user: User, kind: string) => (await listNotifications(user)).items.filter((i) => i.kind === kind);
  const openProposals = async (): Promise<PageProposalSummary[]> => (app.inject({ method: 'GET', url: `/api/spaces/${space}/proposals`, headers: cookies.editor }).then((r) => (r.json() as ProposalListResponse).items));
  const detail = async (id: string): Promise<PageProposalDetail> => (await app.inject({ method: 'GET', url: `/api/proposals/${id}`, headers: cookies.editor })).json() as PageProposalDetail;
  const decide = (who: keyof typeof cookies, id: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/proposals/${id}/decision`, headers: cookies[who], payload });

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    app = await buildApp();
    const stamp = Date.now();
    const mk = (n: string) => authStore.createUser({ email: `${n}-${stamp}@proposals-test.local`, name: n, passwordHash: 'x', isAdmin: false, username: `${n}${stamp}`.toLowerCase() });
    [admin, editor, agentOwner, viewer] = await Promise.all([mk('Admin'), mk('Editor'), mk('AgentOwner'), mk('Viewer')]);
    cookies = { admin: await cookieOf(admin), editor: await cookieOf(editor), agentOwner: await cookieOf(agentOwner), viewer: await cookieOf(viewer) };
    space = (await storage.createSpace(`Proposals ${stamp}`, admin.id)).slug;
    await authStore.setMembership(space, admin.id, 'admin');
    await authStore.setMembership(space, editor.id, 'editor');
    await authStore.setMembership(space, agentOwner.id, 'editor');
    await authStore.setMembership(space, viewer.id, 'viewer');
    pageId = (await storage.createPage({ space, parentPath: '', title: 'Handbook', kind: 'doc' }, { docBody: '# Handbook\n\nThe retry limit is 3.\n' })).id;
    agentPat = { authorization: `Bearer ${(await authStore.createApiToken(agentOwner.id, 'agent', ['read', 'write'] as ApiTokenScope[])).token}` };
  });

  afterAll(async () => {
    await app.close();
    await deleteTestSpace(space);
    await teardownSchema();
  });

  it('every write tool is classified for review mode: queued, refused or direct', () => {
    const classified = [...REVIEW_QUEUED_TOOL_NAMES, ...REVIEW_REFUSED_TOOL_NAMES, ...REVIEW_DIRECT_TOOL_NAMES].sort();
    expect(classified).toEqual([...MCP_WRITE_TOOL_NAMES].sort());
    expect(new Set(classified).size).toBe(classified.length);
  });

  it('direct mode (the default): update_page and create_page answer with the page, as before', async () => {
    const info = (await app.inject({ method: 'GET', url: '/api/spaces', headers: cookies.admin })).json() as { spaces: Array<{ slug: string; agentWriteMode?: string }> };
    expect(info.spaces.find((s) => s.slug === space)?.agentWriteMode).toBeUndefined();

    await withMcp(agentOwner, 'tok-direct', async (call) => {
      const updated = await call('update_page', { id: pageId, markdown: '# Handbook\n\nThe retry limit is 4.\n' });
      expect(updated.isError).toBe(false);
      expect(updated.structured).toMatchObject({ id: pageId, title: 'Handbook' });
      expect(updated.structured).not.toHaveProperty('proposalId');
      expect(await pageText()).toContain('limit is 4');

      const created = await call('create_page', { space, parentPath: '', title: 'Direct made', markdown: 'Body' });
      expect(created.isError).toBe(false);
      expect(created.structured).toMatchObject({ title: 'Direct made' });
      expect(created.structured).not.toHaveProperty('proposalId');
    });
    expect(await query('SELECT 1 FROM page_proposals WHERE space_slug = $1', [space])).toHaveLength(0);
  });

  it('only a space admin can change the mode', async () => {
    expect((await setMode('review', 'editor')).statusCode).toBe(403);
    expect((await setMode('review', 'viewer')).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: `/api/spaces/${space}/agent-settings`, headers: cookies.admin, payload: { agentWriteMode: 'bogus' } })).statusCode).toBe(400);
    expect((await setMode('review')).statusCode).toBe(200);
    const info = (await app.inject({ method: 'GET', url: '/api/spaces', headers: cookies.editor })).json() as { spaces: Array<{ slug: string; agentWriteMode?: string }> };
    expect(info.spaces.find((s) => s.slug === space)?.agentWriteMode).toBe('review');
    const audit = await query<{ meta: { agentWriteMode: string } }>("SELECT meta FROM audit_log WHERE action = 'space.agent_settings' AND target = $1", [space]);
    expect(audit.some((a) => a.meta.agentWriteMode === 'review')).toBe(true);
  });

  it('review mode: update_page over MCP leaves the text alone and queues a proposal', async () => {
    const before = await pageText();
    await withMcp(agentOwner, 'tok-a', async (call) => {
      const res = await call('update_page', { id: pageId, markdown: '# Handbook\n\nThe retry limit is 5.\n' });
      expect(res.isError).toBe(false);
      expect(res.structured).toMatchObject({ status: 'proposed', proposalId: expect.any(String) });
      expect(String(res.structured?.message)).toMatch(/review/i);
    });
    expect(await pageText()).toBe(before);
    const open = await openProposals();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'update', pageId, status: 'pending', authorId: agentOwner.id, tokenId: 'tok-a', source: 'mcp' });
  });

  it('the same token editing the same page again replaces the open proposal and does not notify again', async () => {
    const [first] = await openProposals();
    const adminBefore = await feed(admin, 'proposal_pending');
    expect(adminBefore).toHaveLength(1);
    expect(adminBefore[0]).toMatchObject({ pageId, payload: { proposalId: first.id, authorName: 'AgentOwner' } });

    await withMcp(agentOwner, 'tok-a', async (call) => {
      const res = await call('update_page', { id: pageId, markdown: '# Handbook\n\nThe retry limit is 6.\n' });
      expect(res.structured?.proposalId).toBe(first.id);
    });
    const open = await openProposals();
    expect(open).toHaveLength(1);
    expect((await detail(first.id)).markdown).toContain('limit is 6');
    expect(await feed(admin, 'proposal_pending')).toHaveLength(1);

    // A different token is a different proposal, and its own notification.
    await withMcp(agentOwner, 'tok-b', async (call) => {
      const res = await call('update_page', { id: pageId, markdown: '# Handbook\n\nThe retry limit is 7.\n' });
      expect(res.structured?.proposalId).not.toBe(first.id);
    });
    expect(await openProposals()).toHaveLength(2);
    expect(await feed(admin, 'proposal_pending')).toHaveLength(2);
    // Viewers and outsiders are told nothing and see no queue.
    expect(await feed(viewer, 'proposal_pending')).toHaveLength(0);
    expect((await app.inject({ method: 'GET', url: `/api/spaces/${space}/proposals`, headers: cookies.viewer })).statusCode).toBe(403);
  });

  it('the built-in assistant (tokenId "assistant") is queued the same way, marked as assistant', async () => {
    await withMcp(agentOwner, 'assistant', async (call) => {
      const res = await call('update_page', { id: pageId, markdown: '# Handbook\n\nThe retry limit is 8.\n' });
      expect(res.structured).toMatchObject({ status: 'proposed' });
    });
    const mine = (await openProposals()).find((p) => p.tokenId === 'assistant');
    expect(mine).toMatchObject({ source: 'assistant', authorId: agentOwner.id });
    expect(await pageText()).toContain('limit is 4');
  });

  it('REST with an API token is queued (202); a browser session writes directly; a token cannot decide', async () => {
    const viaPat = await app.inject({ method: 'PUT', url: `/api/pages/${pageId}`, headers: agentPat, payload: { markdown: '# Handbook\n\nThe retry limit is 9.\n' } });
    expect(viaPat.statusCode).toBe(202);
    const sent = viaPat.json() as { status: string; proposalId: string };
    expect(sent.status).toBe('proposed');
    expect(await pageText()).toContain('limit is 4');
    expect((await detail(sent.proposalId))).toMatchObject({ source: 'rest', status: 'pending' });

    // The agent cannot accept its own proposal with its token.
    const self = await app.inject({ method: 'POST', url: `/api/proposals/${sent.proposalId}/decision`, headers: agentPat, payload: { decision: 'accept' } });
    expect(self.statusCode).toBe(403);
    expect(await pageText()).toContain('limit is 4');

    // A restore through a token is refused too (it would replace the text).
    const restore = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/restore/abcdef0`, headers: agentPat });
    expect(restore.statusCode).toBe(403);

    // A person in the browser: no queue.
    const typed = await app.inject({ method: 'PUT', url: `/api/pages/${pageId}`, headers: cookies.editor, payload: { markdown: '# Handbook\n\nThe retry limit is 10 (typed).\n' } });
    expect(typed.statusCode).toBe(200);
    expect(await pageText()).toContain('(typed)');
    const proposalsBefore = (await openProposals()).length;
    expect(proposalsBefore).toBeGreaterThanOrEqual(3);
  });

  it('review mode: tools without a review path refuse with a plain text; comments stay direct', async () => {
    await withMcp(agentOwner, 'tok-a', async (call) => {
      const board = await call('create_board', { space, parentPath: '', title: 'Board' });
      expect(board.isError).toBe(true);
      expect(board.text).toMatch(/review mode/i);
      const table = await call('folio_table_create', { space, parentPath: '', title: 'T', columns: [{ name: 'A', type: 'text' }] });
      expect(table.isError).toBe(true);
      const props = await call('set_page_properties', { id: pageId, properties: { owner: 'x' } });
      expect(props.isError).toBe(true);
      expect(props.text).toMatch(/review mode/i);
      const tableViaPage = await call('create_page', { space, parentPath: '', title: 'T2', kind: 'table' });
      expect(tableViaPage.isError).toBe(true);
      expect(tableViaPage.text).toMatch(/review mode/i);

      const comment = await call('add_comment', { page: pageId, quote: 'retry limit', body: 'a remark' });
      expect(comment.isError).toBe(false);
    });
  });

  it('a stale proposal cannot be accepted without the differences; reject needs nothing; accept records the reviewer in Git', async () => {
    // The page changed (the typed edit above) after the proposals were made.
    const [target] = (await openProposals()).filter((p) => p.tokenId === 'tok-a');
    expect(target.status).toBe('stale');
    const shown = await detail(target.id);
    expect(shown.currentMarkdown).toContain('(typed)');
    expect(shown.currentHash).toEqual(expect.any(String));

    const blind = await decide('editor', target.id, { decision: 'accept' });
    expect(blind.statusCode).toBe(409);
    expect((blind.json() as { code: string }).code).toBe('proposal_stale');
    const wrong = await decide('editor', target.id, { decision: 'accept', currentHash: 'not-the-hash' });
    expect(wrong.statusCode).toBe(409);
    expect(await pageText()).toContain('(typed)');

    const ok = await decide('editor', target.id, { decision: 'accept', currentHash: shown.currentHash });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as PageProposalDetail).status).toBe('accepted');
    expect(await pageText()).toContain('limit is 6');
    expect(gitSync.authorFor(space)).toMatchObject({ name: 'Editor' });

    // Decided once.
    expect((await decide('admin', target.id, { decision: 'accept' })).statusCode).toBe(409);

    // The author hears about the decision.
    const told = await feed(agentOwner, 'proposal_decided');
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ pageId, payload: { decision: 'accepted', reviewerName: 'Editor' } });

    // Reject: text untouched, the reason is kept.
    const other = (await openProposals()).find((p) => p.tokenId === 'tok-b')!;
    const rejected = await decide('admin', other.id, { decision: 'reject', comment: 'not this wording' });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({ status: 'rejected', reviewComment: 'not this wording', reviewerName: 'Admin' });
    expect(await pageText()).toContain('limit is 6');

    const trail = await query<{ action: string; actor_id: string; meta: { tokenId?: string; authorId?: string } }>(
      "SELECT action, actor_id, meta FROM audit_log WHERE action IN ('proposal.created', 'proposal.accepted', 'proposal.rejected') AND target = ANY($1::text[])",
      [[target.id, other.id]],
    );
    const accepted = trail.find((a) => a.action === 'proposal.accepted')!;
    expect(accepted).toMatchObject({ actor_id: editor.id, meta: { tokenId: 'tok-a', authorId: agentOwner.id } });
    expect(trail.find((a) => a.action === 'proposal.created' && a.meta.tokenId === 'tok-a')?.actor_id).toBe(agentOwner.id);
  });

  it('a fresh proposal on an unchanged page is pending and accepts without a hash', async () => {
    await withMcp(agentOwner, 'tok-c', async (call) => {
      await call('update_page', { id: pageId, markdown: '# Handbook\n\nThe retry limit is 11.\n' });
    });
    const mine = (await openProposals()).find((p) => p.tokenId === 'tok-c')!;
    expect(mine.status).toBe('pending');
    expect((await decide('viewer', mine.id, { decision: 'accept' })).statusCode).toBe(404);
    expect((await decide('editor', mine.id, { decision: 'accept' })).statusCode).toBe(200);
    expect(await pageText()).toContain('limit is 11');
  });

  it('create_page in review mode proposes a page that does not exist yet; admins are told; accepting creates it; the rejection reaches the author', async () => {
    const adminBefore = (await feed(admin, 'proposal_pending')).length;
    let proposalId = '';
    await withMcp(agentOwner, 'tok-new', async (call) => {
      const res = await call('create_page', { space, parentPath: '', title: 'Runbook', markdown: 'Step one.' });
      expect(res.structured).toMatchObject({ status: 'proposed' });
      proposalId = String(res.structured?.proposalId);
      // The same token proposing the same page again replaces it.
      const again = await call('create_page', { space, parentPath: '', title: 'Runbook', markdown: 'Step one, then two.' });
      expect(again.structured?.proposalId).toBe(proposalId);
    });
    expect((await query('SELECT 1 FROM pages_index WHERE space_slug = $1 AND title = $2', [space, 'Runbook']))).toHaveLength(0);

    // Not lost although there is no page yet: exactly one row per admin, however often it was proposed.
    const adminAfter = await feed(admin, 'proposal_pending');
    expect(adminAfter).toHaveLength(adminBefore + 1);
    expect(adminAfter.find((i) => i.payload?.proposalId === proposalId)).toMatchObject({ pageId: null, payload: { proposalKind: 'create', pageTitle: 'Runbook', space } });

    const shown = await detail(proposalId);
    expect(shown).toMatchObject({ kind: 'create', pageId: null, title: 'Runbook', status: 'pending', currentMarkdown: null });
    expect(shown.markdown).toContain('then two');

    const ok = await decide('admin', proposalId, { decision: 'accept' });
    expect(ok.statusCode).toBe(200);
    const created = (ok.json() as PageProposalDetail).resultPageId!;
    expect(await pageText(created)).toContain('then two');
    expect(gitSync.authorFor(space)).toMatchObject({ name: 'Admin' });

    // A second one, rejected: the author is told even though no page exists.
    let second = '';
    await withMcp(agentOwner, 'tok-new', async (call) => {
      second = String((await call('create_page', { space, parentPath: '', title: 'Never made', markdown: 'x' })).structured?.proposalId);
    });
    expect((await decide('admin', second, { decision: 'reject', comment: 'no' })).statusCode).toBe(200);
    const told = (await feed(agentOwner, 'proposal_decided')).find((i) => i.payload?.proposalId === second);
    expect(told).toMatchObject({ pageId: null, payload: { decision: 'rejected', pageTitle: 'Never made' } });
  });

  it('back to direct: agents write at once again, and the open queue stays reviewable', async () => {
    expect((await setMode('direct')).statusCode).toBe(200);
    await withMcp(agentOwner, 'tok-d', async (call) => {
      const res = await call('update_page', { id: pageId, markdown: '# Handbook\n\nDirect again.\n' });
      expect(res.structured).toMatchObject({ id: pageId });
      const table = await call('folio_table_create', { space, parentPath: '', title: 'Table now fine', columns: [{ name: 'A', type: 'text' }] });
      expect(table.isError).toBe(false);
    });
    expect(await pageText()).toContain('Direct again');
  });

  it('a proposal built on a stale read is refused, as a direct write with baseRevision is', async () => {
    await setMode('review');
    const page = (await storage.createPage({ space, parentPath: '', title: 'Revisioned', kind: 'doc' }, { docBody: '# Revisioned\n\nOne.\n' })).id;
    await withMcp(agentOwner, 'tok-rev', async (call) => {
      const stale = await call('update_page', { id: page, markdown: '# Revisioned\n\nTwo.\n', baseRevision: 'not-the-revision' });
      expect(stale.isError).toBe(true);
      expect(stale.text).toContain('revision_conflict');
      const read = await call('read_page', { id: page });
      const fresh = await call('update_page', { id: page, markdown: '# Revisioned\n\nTwo.\n', baseRevision: read.structured?.bodyRevision });
      expect(fresh.structured?.status).toBe('proposed');
    });
    const rest = await app.inject({ method: 'PUT', url: `/api/pages/${page}`, headers: agentPat, payload: { markdown: '# Revisioned\n\nThree.\n', baseRevision: 'not-the-revision' } });
    expect(rest.statusCode).toBe(409);
  });

  it('a proposal goes to the page owner when the page has one, not to the admins', async () => {
    await setMode('review');
    const owned = (await storage.createPage({ space, parentPath: '', title: 'Owned', kind: 'doc' }, { docBody: '# Owned\n' })).id;
    await updateVerification((await storage.getEntry(owned))!, editor, { owner: editor.username! });
    const adminBefore = (await feed(admin, 'proposal_pending')).filter((i) => i.pageId === owned);
    await withMcp(agentOwner, 'tok-owner', (call) => call('update_page', { id: owned, markdown: '# Owned\n\nNew.\n' }));
    const toOwner = (await feed(editor, 'proposal_pending')).filter((i) => i.pageId === owned);
    expect(toOwner).toHaveLength(1);
    expect(toOwner[0].payload?.pageTitle).toBe('Owned');
    expect((await feed(admin, 'proposal_pending')).filter((i) => i.pageId === owned)).toEqual(adminBefore);
  });
});
