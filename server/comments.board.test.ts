/**
 * Comments on board elements (real PG): a thread on an element through REST
 * and through add_comment, the mention and the reply going out through the
 * same hook as on pages, a thread whose element was deleted staying in the
 * list, and the schema change leaving doc threads and the kind refusal alone.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommentThread, PageCommentsResponse } from '../shared/comments.js';
import type { User } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import * as collab from './collab.js';
import * as comments from './comments.js';
import { registerCommentRoutes } from './commentsRoutes.js';
import { baseEl, renderSceneSvg, textEl, type ExcalidrawScene } from './confluenceWhiteboard.js';
import { query } from './db/pool.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import { buildFolioMcpServer } from './mcp.js';
import { listNotifications } from './notifications/routes.js';
import * as storage from './storage.js';

const seed = () => 1;
const scene = (ids: string[]): ExcalidrawScene => ({
  type: 'excalidraw',
  version: 2,
  source: 'test',
  elements: ids.flatMap((id) => {
    const box = { ...baseEl(seed, id, 'rectangle', 0, 0, 100, 60), boundElements: [{ id: `t-${id}`, type: 'text' }] };
    const label = textEl(seed, `t-${id}`, `Label ${id}`, 0, 0, 40, 20, 16, '#1e1e1e', { container: id, align: 'center', valign: 'middle' });
    return [box, label];
  }),
  appState: { viewBackgroundColor: '#ffffff' },
  files: {},
});

describe('comments on board elements (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let admin: User;
  let editor: User;
  let viewer: User;
  let outsider: User;
  let auth: Record<'admin' | 'editor' | 'viewer' | 'outsider', { cookie: string }>;
  let space: string;
  let boardId: string;

  const cookieOf = async (user: User): Promise<{ cookie: string }> => ({ cookie: `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(user.id)).token}` });
  const target = (elementId: string) => ({ kind: 'board_element', elementId });
  const start = (who: keyof typeof auth, elementId: string, body = 'About this', id = boardId) =>
    app.inject({ method: 'POST', url: `/api/pages/${id}/comments`, headers: auth[who], payload: { target: target(elementId), body } });
  const feed = async (user: User) => (await listNotifications(user)).items.filter((i) => i.kind.startsWith('comment_'));

  async function call(user: User, scopes: ('read' | 'write')[], name: string, args: Record<string, unknown>) {
    const server = buildFolioMcpServer({ user, scopes, tokenId: 'board-comments-test' });
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

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    app = Fastify();
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

    const stamp = Date.now();
    const mk = (n: string) => authStore.createUser({ email: `${n}-${stamp}@bc-test.local`, name: n, passwordHash: 'x', isAdmin: false, username: `${n}${stamp}`.toLowerCase() });
    [admin, editor, viewer, outsider] = await Promise.all([mk('Admin'), mk('Editor'), mk('Viewer'), mk('Outsider')]);
    space = (await storage.createSpace(`BoardComments ${stamp}`, admin.id)).slug;
    await authStore.setMembership(space, admin.id, 'admin');
    await authStore.setMembership(space, editor.id, 'editor');
    await authStore.setMembership(space, viewer.id, 'viewer');
    auth = { admin: await cookieOf(admin), editor: await cookieOf(editor), viewer: await cookieOf(viewer), outsider: await cookieOf(outsider) };
    boardId = (await storage.createPage({ space, parentPath: '', title: 'Flow', kind: 'board' }, { boardSvg: renderSceneSvg(scene(['web', 'api', 'db'])) })).id;
  });

  afterAll(async () => {
    await app.close();
    await deleteTestSpace(space);
    await teardownSchema();
  });

  it('a reader starts a thread on an element over REST; the label comes from the board, not from the client', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/pages/${boardId}/comments`, headers: auth.viewer, payload: { target: { ...target('web'), label: 'forged' }, body: 'Why a box?' } });
    expect(res.statusCode).toBe(201);
    const thread = res.json<CommentThread>();
    expect(thread).toMatchObject({ pageId: boardId, anchorFrom: null, anchorTo: null, quotedText: null, status: 'open', target: { kind: 'board_element', elementId: 'web', label: 'Label web' } });
    expect(thread.comments[0]).toMatchObject({ body: 'Why a box?', author: { id: viewer.id } });

    const listed = (await app.inject({ method: 'GET', url: `/api/pages/${boardId}/comments`, headers: auth.editor })).json<PageCommentsResponse>();
    expect(listed).toMatchObject({ canComment: true, canModerate: true });
    expect(listed.threads.map((t) => t.id)).toContain(thread.id);
    expect((await app.inject({ method: 'GET', url: `/api/pages/${boardId}/comments`, headers: auth.outsider })).statusCode).toBe(404);
  });

  it('refuses what is not an element of this board: a missing element, no target, text anchors, a table cell', async () => {
    expect((await start('editor', 'no-such-element')).statusCode).toBe(400);
    const noTarget = await app.inject({ method: 'POST', url: `/api/pages/${boardId}/comments`, headers: auth.editor, payload: { body: 'x' } });
    expect(noTarget.statusCode).toBe(400);
    const textAnchors = await app.inject({ method: 'POST', url: `/api/pages/${boardId}/comments`, headers: auth.editor, payload: { anchorFrom: 'AQID', anchorTo: 'BAUG', quotedText: 'x', body: 'x' } });
    expect(textAnchors.statusCode).toBe(400);
    const both = await app.inject({ method: 'POST', url: `/api/pages/${boardId}/comments`, headers: auth.editor, payload: { anchorFrom: 'AQID', anchorTo: 'BAUG', quotedText: 'x', target: target('web'), body: 'x' } });
    expect(both.statusCode).toBe(400);
    const cell = await app.inject({ method: 'POST', url: `/api/pages/${boardId}/comments`, headers: auth.editor, payload: { target: { kind: 'table_cell', rowId: 'r1', columnId: 'c1' }, body: 'x' } });
    expect(cell.statusCode).toBe(400);
    expect((await start('outsider', 'web')).statusCode).toBe(404);
  });

  it('a mention and a reply notify through the same hook as on pages', async () => {
    const thread = (await start('editor', 'api', `@${viewer.username} take a look`)).json<CommentThread>();
    const mention = await feed(viewer);
    expect(mention).toHaveLength(1);
    expect(mention[0]).toMatchObject({ kind: 'comment_mention', pageId: boardId, payload: { space, pageTitle: 'Flow', threadId: thread.id, authorName: 'Editor' } });
    expect(await feed(outsider)).toEqual([]);

    const reply = await app.inject({ method: 'POST', url: `/api/comment-threads/${thread.id}/comments`, headers: auth.viewer, payload: { body: 'Looking' } });
    expect(reply.statusCode).toBe(201);
    const got = (await feed(editor)).filter((i) => i.kind === 'comment_reply');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ pageId: boardId, payload: { threadId: thread.id, authorName: 'Viewer' } });
    expect((await feed(viewer)).filter((i) => i.kind === 'comment_reply')).toEqual([]);
  });

  it('add_comment attaches to an element id; a mention written by the agent notifies once', async () => {
    const added = await call(editor, ['read', 'write'], 'add_comment', { page: boardId, elementId: 'db', body: `@${admin.username} is this the right store?` });
    expect(added.isError).toBe(false);
    expect(added.json!.thread).toMatchObject({ status: 'open', quotedText: null, target: { kind: 'board_element', elementId: 'db', label: 'Label db' }, createdBy: { name: 'Editor' } });
    expect(added.json!.thread.anchorFrom).toBeUndefined();
    const got = (await feed(admin)).filter((i) => i.kind === 'comment_mention');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ pageId: boardId, payload: { threadId: added.json!.thread.id } });

    expect((await call(editor, ['read', 'write'], 'add_comment', { page: boardId, elementId: 'nope', body: 'x' })).text).toMatch(/no such element/);
    expect((await call(editor, ['read', 'write'], 'add_comment', { page: boardId, body: 'x' })).text).toMatch(/needs elementId/);
    expect((await call(editor, ['read'], 'add_comment', { page: boardId, elementId: 'db', body: 'x' })).text).toMatch(/write scope/);
    expect((await call(outsider, ['read', 'write'], 'add_comment', { page: boardId, elementId: 'db', body: 'x' })).text).toBe('page not found');
  });

  it('a thread whose element was deleted stays in the list, with its label and a mark for agents', async () => {
    const thread = (await start('editor', 'db', 'Remember this one')).json<CommentThread>();
    // The element leaves the board (no live room: straight to the file).
    await collab.editBoardScene(boardId, scene(['web', 'api']));
    expect(await comments.liveElementIds(boardId)).toEqual(new Set(['web', 'api', 't-web', 't-api']));

    const listed = (await app.inject({ method: 'GET', url: `/api/pages/${boardId}/comments`, headers: auth.viewer })).json<PageCommentsResponse>();
    const kept = listed.threads.find((t) => t.id === thread.id);
    expect(kept).toMatchObject({ status: 'open', target: { elementId: 'db', label: 'Label db' } });
    expect(kept!.comments).toHaveLength(1);

    const viaMcp = await call(viewer, ['read'], 'list_comments', { page: boardId });
    const byId = new Map<string, any>(viaMcp.json!.threads.map((t: { id: string }) => [t.id, t]));
    expect(byId.get(thread.id)).toMatchObject({ targetDeleted: true, target: { elementId: 'db' } });
    expect(viaMcp.json!.threads.find((t: { target?: { elementId: string } }) => t.target?.elementId === 'web')).toMatchObject({ targetDeleted: false });

    // Replies still work on it.
    expect((await app.inject({ method: 'POST', url: `/api/comment-threads/${thread.id}/comments`, headers: auth.viewer, payload: { body: 'Still here' } })).statusCode).toBe(201);
    // And a new thread cannot be started on the deleted element.
    expect((await start('editor', 'db')).statusCode).toBe(400);
  });

  it('the migration left text threads as they were: anchors set, no target', async () => {
    const doc = await storage.createPage({ space, parentPath: '', title: 'Notes', kind: 'doc' }, { docBody: '# Notes\n\nThe quick brown fox.\n' });
    const thread = await comments.createThread(doc.id, editor.id, { anchorFrom: 'AQID', anchorTo: 'BAUG', quotedText: 'fox', body: 'Fox?' });
    expect(thread).toMatchObject({ anchorFrom: 'AQID', anchorTo: 'BAUG', quotedText: 'fox', target: null });
    const rows = await query<{ target: unknown }>('SELECT target FROM comment_threads WHERE id = $1', [thread.id]);
    expect(rows[0].target).toBeNull();
    // The CHECK keeps a half-filled row out.
    await expect(query("INSERT INTO comment_threads (page_id, anchor_from) VALUES ('x', 'abc')")).rejects.toThrow();
  });
});
