/**
 * Comments on table cells (real PG): a thread on a cell through REST and
 * through add_comment, the mention and the reply going out through the same
 * hook as on pages, a thread whose row or column was deleted staying in the
 * list (and open to replies), and the other kinds keeping their behaviour.
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
import * as tableService from './tables/service.js';
import { query } from './db/pool.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import { buildFolioMcpServer } from './mcp.js';
import { listNotifications } from './notifications/routes.js';
import * as storage from './storage.js';

const seed = () => 1;
const scene: ExcalidrawScene = {
  type: 'excalidraw',
  version: 2,
  source: 'test',
  elements: [baseEl(seed, 'box', 'rectangle', 0, 0, 100, 60), textEl(seed, 'lbl', 'Box', 0, 0, 40, 20, 16, '#1e1e1e', {})],
  appState: { viewBackgroundColor: '#ffffff' },
  files: {},
};

describe('comments on table cells (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let admin: User;
  let editor: User;
  let viewer: User;
  let outsider: User;
  let auth: Record<'admin' | 'editor' | 'viewer' | 'outsider', { cookie: string }>;
  let space: string;
  let tableId: string;
  let boardId: string;
  let rows: { id: string }[];

  const cookieOf = async (user: User): Promise<{ cookie: string }> => ({ cookie: `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(user.id)).token}` });
  const cell = (rowId: string, columnId: string) => ({ kind: 'table_cell', rowId, columnId });
  const start = (who: keyof typeof auth, rowId: string, columnId: string, body = 'About this cell', id = tableId) =>
    app.inject({ method: 'POST', url: `/api/pages/${id}/comments`, headers: auth[who], payload: { target: cell(rowId, columnId), body } });
  const feed = async (user: User) => (await listNotifications(user)).items.filter((i) => i.kind.startsWith('comment_'));

  async function call(user: User, scopes: ('read' | 'write')[], name: string, args: Record<string, unknown>) {
    const server = buildFolioMcpServer({ user, scopes, tokenId: 'table-comments-test' });
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
    const mk = (n: string) => authStore.createUser({ email: `${n}-${stamp}@tc-test.local`, name: n, passwordHash: 'x', isAdmin: false, username: `${n}${stamp}`.toLowerCase() });
    [admin, editor, viewer, outsider] = await Promise.all([mk('Admin'), mk('Editor'), mk('Viewer'), mk('Outsider')]);
    space = (await storage.createSpace(`TableComments ${stamp}`, admin.id)).slug;
    await authStore.setMembership(space, admin.id, 'admin');
    await authStore.setMembership(space, editor.id, 'editor');
    await authStore.setMembership(space, viewer.id, 'viewer');
    auth = { admin: await cookieOf(admin), editor: await cookieOf(editor), viewer: await cookieOf(viewer), outsider: await cookieOf(outsider) };
    tableId = (
      await storage.createPage({
        space,
        parentPath: '',
        title: 'Tasks',
        kind: 'table',
        columns: [
          { id: 'owner', name: 'Owner', type: 'text' },
          { id: 'week', name: 'Week', type: 'text' },
          { id: 'note', name: 'Note', type: 'text' },
        ],
      })
    ).id;
    rows = (await tableService.insertRows(tableId, [{ owner: 'alice', week: 'W8' }, { owner: 'bob' }, { owner: 'carol' }, { owner: 'dave' }])).rows;
    boardId = (await storage.createPage({ space, parentPath: '', title: 'Flow', kind: 'board' }, { boardSvg: renderSceneSvg(scene) })).id;
  });

  afterAll(async () => {
    await app.close();
    await deleteTestSpace(space);
    await teardownSchema();
  });

  it('a reader starts a thread on a cell over REST; the label is the cell text (or the column name), not what the client sent', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/pages/${tableId}/comments`, headers: auth.viewer, payload: { target: { ...cell(rows[0].id, 'owner'), label: 'forged' }, body: 'Is alice right?' } });
    expect(res.statusCode).toBe(201);
    const thread = res.json<CommentThread>();
    expect(thread).toMatchObject({ pageId: tableId, anchorFrom: null, anchorTo: null, quotedText: null, status: 'open', target: { kind: 'table_cell', rowId: rows[0].id, columnId: 'owner', label: 'alice' } });
    expect(thread.comments[0]).toMatchObject({ body: 'Is alice right?', author: { id: viewer.id } });

    const empty = (await start('editor', rows[1].id, 'note')).json<CommentThread>();
    expect(empty.target).toMatchObject({ label: 'Note' });

    const listed = (await app.inject({ method: 'GET', url: `/api/pages/${tableId}/comments`, headers: auth.editor })).json<PageCommentsResponse>();
    expect(listed).toMatchObject({ canComment: true, canModerate: true });
    expect(listed.threads.map((t) => t.id)).toEqual(expect.arrayContaining([thread.id, empty.id]));
    expect((await app.inject({ method: 'GET', url: `/api/pages/${tableId}/comments`, headers: auth.outsider })).statusCode).toBe(404);
  });

  it('refuses what is not a cell of this table: a missing row or column, no target, text anchors, a board element', async () => {
    expect((await start('editor', 'nope', 'owner')).statusCode).toBe(400);
    expect((await start('editor', rows[0].id, 'nope')).statusCode).toBe(400);
    const noTarget = await app.inject({ method: 'POST', url: `/api/pages/${tableId}/comments`, headers: auth.editor, payload: { body: 'x' } });
    expect(noTarget.statusCode).toBe(400);
    const textAnchors = await app.inject({ method: 'POST', url: `/api/pages/${tableId}/comments`, headers: auth.editor, payload: { anchorFrom: 'AQID', anchorTo: 'BAUG', quotedText: 'x', body: 'x' } });
    expect(textAnchors.statusCode).toBe(400);
    const element = await app.inject({ method: 'POST', url: `/api/pages/${tableId}/comments`, headers: auth.editor, payload: { target: { kind: 'board_element', elementId: 'box' }, body: 'x' } });
    expect(element.statusCode).toBe(400);
    expect((await start('outsider', rows[0].id, 'owner')).statusCode).toBe(404);
    // A board still refuses a cell, and still takes an element.
    expect((await start('editor', rows[0].id, 'owner', 'x', boardId)).statusCode).toBe(400);
    const onBoard = await app.inject({ method: 'POST', url: `/api/pages/${boardId}/comments`, headers: auth.editor, payload: { target: { kind: 'board_element', elementId: 'box' }, body: 'ok' } });
    expect(onBoard.statusCode).toBe(201);
  });

  it('other kinds still refuse comments', async () => {
    expect(comments.isCommentableKind('doc')).toBe(true);
    expect(comments.isCommentableKind('board')).toBe(true);
    expect(comments.isCommentableKind('table')).toBe(true);
    for (const kind of ['canvas', 'artifact', 'base', 'form', 'pdf', 'office', 'folder']) expect(comments.isCommentableKind(kind)).toBe(false);
    const form = await storage.createPage({ space, parentPath: '', title: 'Feedback', kind: 'form' });
    expect((await start('editor', rows[0].id, 'owner', 'x', form.id)).statusCode).toBe(400);
    expect((await call(editor, ['read', 'write'], 'add_comment', { page: form.id, rowId: rows[0].id, columnId: 'owner', body: 'x' })).text).toMatch(/only available on documents, boards and tables/);
  });

  it('a mention and a reply notify through the same hook as on pages', async () => {
    const thread = (await start('editor', rows[2].id, 'owner', `@${viewer.username} check carol`)).json<CommentThread>();
    const mention = await feed(viewer);
    expect(mention).toHaveLength(1);
    expect(mention[0]).toMatchObject({ kind: 'comment_mention', pageId: tableId, payload: { space, pageTitle: 'Tasks', threadId: thread.id, authorName: 'Editor' } });
    expect(await feed(outsider)).toEqual([]);

    const reply = await app.inject({ method: 'POST', url: `/api/comment-threads/${thread.id}/comments`, headers: auth.viewer, payload: { body: 'On it' } });
    expect(reply.statusCode).toBe(201);
    const got = (await feed(editor)).filter((i) => i.kind === 'comment_reply');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ pageId: tableId, payload: { threadId: thread.id, authorName: 'Viewer' } });
  });

  it('add_comment attaches to rowId + columnId (both required); a mention written by the agent notifies once', async () => {
    const added = await call(editor, ['read', 'write'], 'add_comment', { page: tableId, rowId: rows[3].id, columnId: 'owner', body: `@${admin.username} is dave right?` });
    expect(added.isError).toBe(false);
    expect(added.json!.thread).toMatchObject({ status: 'open', quotedText: null, target: { kind: 'table_cell', rowId: rows[3].id, columnId: 'owner', label: 'dave' }, createdBy: { name: 'Editor' } });
    const got = (await feed(admin)).filter((i) => i.kind === 'comment_mention');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ pageId: tableId, payload: { threadId: added.json!.thread.id } });

    expect((await call(editor, ['read', 'write'], 'add_comment', { page: tableId, rowId: 'nope', columnId: 'owner', body: 'x' })).text).toMatch(/no such row or column/);
    expect((await call(editor, ['read', 'write'], 'add_comment', { page: tableId, rowId: rows[0].id, body: 'x' })).text).toMatch(/both rowId and columnId/);
    expect((await call(editor, ['read', 'write'], 'add_comment', { page: tableId, columnId: 'owner', body: 'x' })).text).toMatch(/both rowId and columnId/);
    expect((await call(editor, ['read', 'write'], 'add_comment', { page: tableId, quote: 'alice', body: 'x' })).text).toMatch(/both rowId and columnId/);
    expect((await call(editor, ['read'], 'add_comment', { page: tableId, rowId: rows[0].id, columnId: 'owner', body: 'x' })).text).toMatch(/write scope/);
    expect((await call(outsider, ['read', 'write'], 'add_comment', { page: tableId, rowId: rows[0].id, columnId: 'owner', body: 'x' })).text).toBe('page not found');
  });

  it('a thread whose row or column was deleted stays in the list, with its label and a mark for agents; replies work, new threads do not', async () => {
    const onRow = (await start('editor', rows[1].id, 'owner', 'Bob row')).json<CommentThread>();
    const onColumn = (await start('editor', rows[0].id, 'week', 'Week column')).json<CommentThread>();
    await tableService.deleteRow(tableId, rows[1].id);
    await tableService.deleteColumn(tableId, 'week');
    expect(await comments.liveTableIds(tableId)).toEqual({ rows: new Set([rows[0].id, rows[2].id, rows[3].id]), columns: new Set(['owner', 'note']) });

    const listed = (await app.inject({ method: 'GET', url: `/api/pages/${tableId}/comments`, headers: auth.viewer })).json<PageCommentsResponse>();
    for (const [thread, label] of [[onRow, 'bob'], [onColumn, 'W8']] as const) {
      const kept = listed.threads.find((t) => t.id === thread.id);
      expect(kept).toMatchObject({ status: 'open', target: { label } });
      expect(kept!.comments).toHaveLength(1);
    }

    const viaMcp = await call(viewer, ['read'], 'list_comments', { page: tableId });
    const byId = new Map<string, any>(viaMcp.json!.threads.map((t: { id: string }) => [t.id, t]));
    expect(byId.get(onRow.id)).toMatchObject({ targetDeleted: true });
    expect(byId.get(onColumn.id)).toMatchObject({ targetDeleted: true });
    expect(viaMcp.json!.threads.find((t: { target?: { rowId: string; columnId: string } }) => t.target?.rowId === rows[0].id && t.target?.columnId === 'owner')).toMatchObject({ targetDeleted: false });

    expect((await app.inject({ method: 'POST', url: `/api/comment-threads/${onRow.id}/comments`, headers: auth.viewer, payload: { body: 'Still here' } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/api/comment-threads/${onColumn.id}/comments`, headers: auth.editor, payload: { body: 'And here' } })).statusCode).toBe(201);
    expect((await start('editor', rows[1].id, 'owner')).statusCode).toBe(400);
    expect((await start('editor', rows[0].id, 'week')).statusCode).toBe(400);
  });

  it('doc threads keep their text anchors and no target', async () => {
    const doc = await storage.createPage({ space, parentPath: '', title: 'Notes', kind: 'doc' }, { docBody: '# Notes\n\nThe quick brown fox.\n' });
    const thread = await comments.createThread(doc.id, editor.id, { anchorFrom: 'AQID', anchorTo: 'BAUG', quotedText: 'fox', body: 'Fox?' });
    expect(thread).toMatchObject({ anchorFrom: 'AQID', anchorTo: 'BAUG', quotedText: 'fox', target: null });
  });
});
