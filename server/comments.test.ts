/**
 * Inline comments (docs/spec.md §4.4, contract shared/comments.ts), real PG and
 * the real page store: the routes with their rights, a thread surviving a
 * rename, anchoring a quote in a room nobody has open, and the three MCP tools.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommentThread, PageComment, PageCommentsResponse } from '../shared/comments.js';
import type { User } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import * as collab from './collab.js';
import { commentRights, listThreads } from './comments.js';
import { registerCommentRoutes } from './commentsRoutes.js';
import { query } from './db/pool.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import { buildFolioMcpServer, type McpActor } from './mcp.js';
import * as storage from './storage.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  await app.register(async (scope) => {
    scope.addHook('onRequest', session.requireSession);
    registerCommentRoutes(scope);
  });
  await app.ready();
  return app;
}

describe('inline comments (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let admin: User;
  let editor: User;
  let viewer: User;
  let outsider: User;
  let auth: Record<'admin' | 'editor' | 'viewer' | 'outsider', { cookie: string }>;
  let space: string;
  let pageId: string;

  const cookieOf = async (user: User): Promise<{ cookie: string }> => ({ cookie: `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(user.id)).token}` });
  const anchor = { anchorFrom: 'AQID', anchorTo: 'BAUG', quotedText: 'handbook' };
  const read = async (who: keyof typeof auth, id = pageId) => app.inject({ method: 'GET', url: `/api/pages/${id}/comments`, headers: auth[who] });
  const start = (who: keyof typeof auth, body = 'First!', id = pageId) =>
    app.inject({ method: 'POST', url: `/api/pages/${id}/comments`, headers: auth[who], payload: { ...anchor, body } });
  const reply = (who: keyof typeof auth, threadId: string, body = 'Reply') =>
    app.inject({ method: 'POST', url: `/api/comment-threads/${threadId}/comments`, headers: auth[who], payload: { body } });
  const setStatus = (who: keyof typeof auth, threadId: string, status: string) =>
    app.inject({ method: 'PATCH', url: `/api/comment-threads/${threadId}`, headers: auth[who], payload: { status } });

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    app = await buildApp();
    const stamp = Date.now();
    const mk = (n: string) => authStore.createUser({ email: `${n}-${stamp}@comments-test.local`, name: n, passwordHash: 'x', isAdmin: false });
    [admin, editor, viewer, outsider] = await Promise.all([mk('Admin'), mk('Editor'), mk('Viewer'), mk('Outsider')]);
    auth = { admin: await cookieOf(admin), editor: await cookieOf(editor), viewer: await cookieOf(viewer), outsider: await cookieOf(outsider) };
    space = (await storage.createSpace(`Comments ${stamp}`, admin.id)).slug;
    await authStore.setMembership(space, admin.id, 'admin');
    await authStore.setMembership(space, editor.id, 'editor');
    await authStore.setMembership(space, viewer.id, 'viewer');
    pageId = (await storage.createPage({ space, parentPath: '', title: 'Handbook', kind: 'doc' }, { docBody: '# Handbook\n\nThe quick brown fox.\n' })).id;
  });

  afterAll(async () => {
    await app.close();
    await deleteTestSpace(space);
    await teardownSchema();
  });

  it('a signed-in reader (viewer included) starts a thread; everyone who can read sees it, with their rights', async () => {
    expect((await read('viewer')).json<PageCommentsResponse>()).toEqual({ threads: [], canModerate: false, canComment: true });

    const created = await start('viewer', '  Why this? ');
    expect(created.statusCode).toBe(201);
    const thread = created.json<CommentThread>();
    expect(thread).toMatchObject({
      pageId,
      anchorFrom: anchor.anchorFrom,
      anchorTo: anchor.anchorTo,
      quotedText: 'handbook',
      status: 'open',
      createdBy: { id: viewer.id, name: 'Viewer', username: null },
      resolvedBy: null,
      resolvedAt: null,
    });
    expect(thread.comments).toHaveLength(1);
    expect(thread.comments[0]).toMatchObject({ threadId: thread.id, body: 'Why this?', editedAt: null, author: { id: viewer.id } });

    const asEditor = (await read('editor')).json<PageCommentsResponse>();
    expect(asEditor.threads.map((t) => t.id)).toEqual([thread.id]);
    expect(asEditor).toMatchObject({ canModerate: true, canComment: true });
    expect((await read('admin')).json<PageCommentsResponse>().canModerate).toBe(true);
  });

  it('a page the caller cannot read is "not found" for every comment route; unknown ids and bad bodies are refused', async () => {
    expect((await read('outsider')).statusCode).toBe(404);
    expect((await start('outsider')).statusCode).toBe(404);
    const thread = (await read('admin')).json<PageCommentsResponse>().threads[0];
    expect((await reply('outsider', thread.id)).statusCode).toBe(404);
    expect((await setStatus('outsider', thread.id, 'resolved')).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/comments/${thread.comments[0].id}`, headers: auth.outsider })).statusCode).toBe(404);
    expect((await read('admin', 'no-such-page')).statusCode).toBe(404);
    expect((await reply('admin', '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await reply('admin', 'not-a-uuid')).statusCode).toBe(404);

    expect((await start('editor', '   ')).statusCode).toBe(400);
    const badAnchor = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/comments`, headers: auth.editor, payload: { ...anchor, anchorFrom: 'not base64!', body: 'x' } });
    expect(badAnchor.statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `/api/comment-threads/${thread.id}`, headers: auth.admin, payload: { status: 'closed' } })).statusCode).toBe(400);
  });

  it('only doc pages take comments', async () => {
    const board = await storage.createPage({ space, parentPath: '', title: 'Sketch', kind: 'board' });
    const refused = await start('editor', 'x', board.id);
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: string }>().error).toMatch(/documents/);
    expect((await read('editor', board.id)).json<PageCommentsResponse>()).toMatchObject({ threads: [], canComment: false, canModerate: false });
  });

  it('replies, edits (author only) and deletes (author or moderator)', async () => {
    const thread = (await start('editor', 'Opening')).json<CommentThread>();
    const mine = (await reply('viewer', thread.id, 'From the viewer')).json<PageComment>();
    expect(mine).toMatchObject({ threadId: thread.id, body: 'From the viewer', author: { id: viewer.id } });

    // Edit: its author only — an editor/admin of the page may not rewrite someone else's words.
    expect((await app.inject({ method: 'PATCH', url: `/api/comments/${mine.id}`, headers: auth.admin, payload: { body: 'Hijacked' } })).statusCode).toBe(403);
    const edited = await app.inject({ method: 'PATCH', url: `/api/comments/${mine.id}`, headers: auth.viewer, payload: { body: 'Edited' } });
    expect(edited.statusCode).toBe(200);
    expect(edited.json<PageComment>()).toMatchObject({ body: 'Edited', editedAt: expect.any(String) });

    // Delete: a viewer cannot delete the editor's comment, but can delete their own.
    const editorsReply = (await reply('editor', thread.id, 'Editor again')).json<PageComment>();
    const del = (who: keyof typeof auth, id: string) => app.inject({ method: 'DELETE', url: `/api/comments/${id}`, headers: auth[who] });
    expect((await del('viewer', editorsReply.id)).statusCode).toBe(403);
    expect((await del('viewer', mine.id)).statusCode).toBe(204);
    expect((await del('admin', editorsReply.id)).statusCode).toBe(204); // a moderator removes anyone's
    expect((await read('admin')).json<PageCommentsResponse>().threads.find((t) => t.id === thread.id)!.comments.map((c) => c.body)).toEqual(['Opening']);

    // Deleting the opening comment deletes the thread, replies and all.
    const withReply = (await start('editor', 'Doomed')).json<CommentThread>();
    await reply('viewer', withReply.id);
    expect((await del('editor', withReply.comments[0].id)).statusCode).toBe(204);
    expect((await read('admin')).json<PageCommentsResponse>().threads.map((t) => t.id)).not.toContain(withReply.id);
    expect((await query('SELECT 1 FROM comments WHERE thread_id = $1', [withReply.id])).length).toBe(0);
  });

  it('resolve and reopen: the thread starter or a moderator, nobody else', async () => {
    const thread = (await start('viewer', 'Is this right?')).json<CommentThread>();
    expect((await setStatus('outsider', thread.id, 'resolved')).statusCode).toBe(404);
    // Another viewer is neither the starter nor a moderator.
    const otherViewer = await authStore.createUser({ email: `v2-${Date.now()}@comments-test.local`, name: 'Viewer2', passwordHash: 'x', isAdmin: false });
    await authStore.setMembership(space, otherViewer.id, 'viewer');
    auth.outsider = await cookieOf(otherViewer);
    expect((await setStatus('outsider', thread.id, 'resolved')).statusCode).toBe(403);

    const resolved = await setStatus('viewer', thread.id, 'resolved');
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json<CommentThread>()).toMatchObject({ status: 'resolved', resolvedBy: { id: viewer.id }, resolvedAt: expect.any(String) });

    const reopened = (await setStatus('editor', thread.id, 'open')).json<CommentThread>(); // a moderator reopens it
    expect(reopened).toMatchObject({ status: 'open', resolvedBy: null, resolvedAt: null });
    const byModerator = (await setStatus('admin', thread.id, 'resolved')).json<CommentThread>();
    expect(byModerator.resolvedBy?.id).toBe(admin.id);
  });

  it('a read-scoped token reads but cannot write', async () => {
    const readOnly = { authorization: `Bearer ${(await authStore.createApiToken(editor.id, 'ro', ['read'])).token}` };
    expect((await app.inject({ method: 'GET', url: `/api/pages/${pageId}/comments`, headers: readOnly })).statusCode).toBe(200);
    const write = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/comments`, headers: readOnly, payload: { ...anchor, body: 'x' } });
    expect(write.statusCode).toBe(403);
  });

  it('a public-site visitor never comments, even where they may read', async () => {
    const visitor = { id: authStore.PUBLIC_VISITOR_USER_ID, isSystem: true } as User;
    const entry = await storage.requireEntry(pageId);
    // Not a reader of this private space at all, so no rights of any kind.
    expect(await commentRights(visitor, entry)).toEqual({ canView: false, canComment: false, canModerate: false });
    expect(await commentRights(editor, entry)).toEqual({ canView: true, canComment: true, canModerate: true });
    expect(await commentRights(viewer, entry)).toEqual({ canView: true, canComment: true, canModerate: false });
  });

  it('threads outlive a rename (the page id is stable) and are not tied to the page row by a foreign key', async () => {
    const page = await storage.createPage({ space, parentPath: '', title: 'Renamed one', kind: 'doc' }, { docBody: '# Renamed one\n\nBody.\n' });
    const thread = (await start('editor', 'Stay with me', page.id)).json<CommentThread>();
    await storage.renamePageSlug(page.id, 'renamed-two');
    expect((await read('viewer', page.id)).json<PageCommentsResponse>().threads.map((t) => t.id)).toEqual([thread.id]);

    // What deleting a page to the trash does to the index (restore claims the same id again): the comments stay.
    await query('DELETE FROM pages_index WHERE id = $1', [page.id]);
    expect((await read('viewer', page.id)).statusCode).toBe(404);
    expect((await reply('editor', thread.id)).statusCode).toBe(404); // unreachable while the page is gone
    expect((await query('SELECT 1 FROM comment_threads WHERE id = $1', [thread.id])).length).toBe(1);
  });
});

describe('anchoring a quote (collab.anchorQuote)', () => {
  let teardownSchema: () => Promise<void>;
  let space: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    space = (await storage.createSpace(`Anchors ${Date.now()}`, null)).slug;
  });
  afterAll(async () => {
    await deleteTestSpace(space);
    await teardownSchema();
  });

  it('opens the room of a closed page the way a connection would, anchors in it, and closes it again', async () => {
    const body = '# Anchors\n\nOne fox, two foxes.\nThree 🦊 here.\n';
    const page = await storage.createPage({ space, parentPath: '', title: 'Anchors', kind: 'doc' }, { docBody: body });
    expect(collab.isDocLive(page.id)).toBe(false);

    const found = await collab.anchorQuote(page.id, 'fox');
    expect(found?.quotedText).toBe('fox');
    expect(collab.isDocLive(page.id)).toBe(false); // opened only for this, closed again

    // The anchors resolve against the room state the next opening restores.
    const stored = await collab.loadSnapshot(page.id);
    expect(stored).toBeDefined();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, stored!);
    const resolve = (b64: string) => Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(Buffer.from(b64, 'base64')), doc)!.index;
    const text = doc.getText('content').toString();
    expect(text.slice(resolve(found!.anchorFrom), resolve(found!.anchorTo))).toBe('fox');
    expect(resolve(found!.anchorFrom)).toBe(text.indexOf('fox')); // the first occurrence

    // A second call finds the same place (the seed was stored, not redone under new identity).
    expect(await collab.anchorQuote(page.id, 'fox')).toEqual(found);
    const emoji = await collab.anchorQuote(page.id, '🦊 here');
    expect(text.slice(resolve(emoji!.anchorFrom), resolve(emoji!.anchorTo))).toBe('🦊 here');
    expect(await collab.anchorQuote(page.id, 'not on the page')).toBeUndefined();
    expect(await collab.anchorQuote(page.id, 'foxes.\r\nThree')).toMatchObject({ quotedText: 'foxes.\nThree' }); // CRLF in the quote is normalised
  });
});

describe('MCP comment tools (real PG, in-memory transport)', () => {
  let teardownSchema: () => Promise<void>;
  let admin: User;
  let editor: User;
  let viewer: User;
  let outsider: User;
  let space: string;
  let pageId: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    const mk = (n: string) => authStore.createUser({ email: `mcp-${n}-${stamp}@comments-test.local`, name: n, passwordHash: 'x', isAdmin: false });
    [admin, editor, viewer, outsider] = await Promise.all([mk('admin'), mk('editor'), mk('viewer'), mk('outsider')]);
    space = (await storage.createSpace(`MCP Comments ${stamp}`, admin.id)).slug;
    await authStore.setMembership(space, admin.id, 'admin');
    await authStore.setMembership(space, editor.id, 'editor');
    await authStore.setMembership(space, viewer.id, 'viewer');
    pageId = (await storage.createPage({ space, parentPath: '', title: 'Spec', kind: 'doc' }, { docBody: '# Spec\n\nThe retry limit is 3.\n' })).id;
  });
  afterAll(async () => {
    await deleteTestSpace(space);
    await teardownSchema();
  });

  async function call(user: User, scopes: McpActor['scopes'], name: string, args: Record<string, unknown>) {
    const server = buildFolioMcpServer({ user, scopes, tokenId: 'comments-test' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
      return { isError: result.isError === true, text, json: result.isError ? undefined : (JSON.parse(text) as Record<string, any>) };
    } finally {
      await client.close();
    }
  }

  it('add_comment anchors on the first occurrence of the quote; reply_comment and list_comments carry the conversation', async () => {
    const added = await call(editor, ['read', 'write'], 'add_comment', { page: pageId, quote: 'retry limit is 3', body: 'Why 3?' });
    expect(added.isError).toBe(false);
    const thread = added.json!.thread;
    expect(thread).toMatchObject({ status: 'open', quotedText: 'retry limit is 3', createdBy: { name: 'editor' } });
    expect(thread.anchorFrom).toBeUndefined(); // anchors are for the editor, not for tools

    const replied = await call(viewer, ['read', 'write'], 'reply_comment', { threadId: thread.id, body: 'Seems arbitrary.' });
    expect(replied.json!.comment).toMatchObject({ threadId: thread.id, body: 'Seems arbitrary.' });

    const listed = await call(viewer, ['read'], 'list_comments', { page: pageId });
    expect(listed.json).toMatchObject({ canComment: true, canModerate: false });
    expect(listed.json!.threads).toHaveLength(1);
    expect(listed.json!.threads[0].comments.map((c: { body: string }) => c.body)).toEqual(['Why 3?', 'Seems arbitrary.']);
    expect((await call(viewer, ['read'], 'list_comments', { page: pageId, status: 'resolved' })).json!.threads).toEqual([]);

    // The anchors are stored for the editor to resolve.
    const stored = (await listThreads(pageId))[0];
    expect(stored.anchorFrom).toBeTruthy();
    expect(stored.comments).toHaveLength(2);
  });

  it('refuses a quote that is not on the page, a read-only token, a stranger, and a page that is not a doc', async () => {
    const missing = await call(editor, ['read', 'write'], 'add_comment', { page: pageId, quote: 'no such sentence', body: 'x' });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.text).toMatch(/quote was not found/);

    expect((await call(editor, ['read'], 'add_comment', { page: pageId, quote: 'Spec', body: 'x' })).text).toMatch(/write scope/);
    expect((await call(editor, ['read'], 'reply_comment', { threadId: '00000000-0000-4000-8000-000000000000', body: 'x' })).text).toMatch(/write scope/);

    expect((await call(outsider, ['read', 'write'], 'add_comment', { page: pageId, quote: 'Spec', body: 'x' })).text).toBe('page not found');
    expect((await call(outsider, ['read'], 'list_comments', { page: pageId })).text).toBe('page not found');
    const threadId = (await listThreads(pageId))[0].id;
    expect((await call(outsider, ['read', 'write'], 'reply_comment', { threadId, body: 'x' })).text).toBe('comment thread not found');

    const board = await storage.createPage({ space, parentPath: '', title: 'Board', kind: 'board' });
    expect((await call(editor, ['read', 'write'], 'add_comment', { page: board.id, quote: 'x', body: 'x' })).text).toMatch(/only available on documents/);
  });
});
