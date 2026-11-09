/**
 * Stale-write protection for whole-page replacement (issue #11): read_page and
 * GET /api/pages/:id return a `bodyRevision`; update_page and PUT /api/pages/:id
 * take it back as `baseRevision` and refuse the write when the body changed
 * since. Real PG + real page store; the "live" room is a Y.Doc registered in
 * y-websocket's own docs map (what a browser connection would create).
 */
import { createRequire } from 'node:module';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import * as collab from './collab.js';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import { HttpError } from './errors.js';
import { buildFolioMcpServer, type McpActor } from './mcp.js';
import { registerRoutes } from './routes.js';
import * as storage from './storage.js';

const nodeRequire = createRequire(import.meta.url);
const ywsDocs = (nodeRequire('y-websocket/bin/utils') as { docs: Map<string, Y.Doc> }).docs;

describe('update_page / PUT /api/pages/:id — baseRevision (real PG)', () => {
  let teardown: () => Promise<void>;
  let app: FastifyInstance;
  let editor: User;
  let cookie: string;
  let space: string;
  let client: Client;

  beforeAll(async () => {
    teardown = await setUpTestSchema();
    const stamp = Date.now();
    editor = await authStore.createUser({ email: `rev-editor-${stamp}@test.local`, name: 'Editor', passwordHash: 'x', isAdmin: false });
    space = (await storage.createSpace(`Revision ${stamp}`, null)).slug;
    await authStore.setMembership(space, editor.id, 'editor');
    cookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(editor.id)).token}`;

    app = Fastify();
    app.decorateRequest('authUser', null);
    app.setErrorHandler((err, _request, reply) => {
      if (err instanceof HttpError) return reply.status(err.status).send(err.code ? { error: err.message, code: err.code } : { error: err.message });
      return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
    });
    await app.register(fastifyCookieModule.default);
    await app.register(async (scope) => {
      scope.addHook('onRequest', session.requireSession);
      registerRoutes(scope);
    });
    await app.ready();

    const actor: McpActor = { user: editor, scopes: ['read', 'write'], tokenId: 'test-revision-token' };
    const server = buildFolioMcpServer(actor);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });
  afterAll(async () => {
    await client.close();
    await app.close();
    await deleteTestSpace(space);
    await teardown();
  });

  async function newPage(body: string): Promise<string> {
    const page = await storage.createPage({ space, parentPath: '', title: `Rev ${Math.random().toString(36).slice(2, 8)}`, kind: 'doc' });
    await storage.writeDocBody(page.id, body);
    return page.id;
  }
  /** Opens a "room" for the page, as a browser connection would, and returns it. */
  function openRoom(id: string, text: string): Y.Text {
    const ydoc = new Y.Doc();
    ydoc.getText('content').insert(0, text);
    ywsDocs.set(id, ydoc);
    return ydoc.getText('content');
  }
  const callJson = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    return { isError: result.isError === true, text, json: result.isError ? undefined : (JSON.parse(text) as Record<string, any>) };
  };
  const put = (id: string, payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: `/api/pages/${id}`, headers: { cookie }, payload });
  const get = async (id: string) => (await app.inject({ method: 'GET', url: `/api/pages/${id}`, headers: { cookie } })).json() as { markdown: string; bodyRevision: string };

  it('read_page returns a revision that tracks the live text, not the file', async () => {
    const id = await newPage('# Page\n\nfile text\n');
    const fromFile = (await callJson('read_page', { id })).json!;
    expect(fromFile.bodyRevision).toBe(collab.bodyRevision('# Page\n\nfile text\n'));
    const ytext = openRoom(id, '# Page\n\nlive text\n');
    try {
      const live = (await callJson('read_page', { id })).json!;
      expect(live.markdown).toBe('# Page\n\nlive text\n');
      expect(live.bodyRevision).toBe(collab.bodyRevision(ytext.toString()));
      expect(live.bodyRevision).not.toBe(fromFile.bodyRevision);
      expect((await get(id)).bodyRevision).toBe(live.bodyRevision);
    } finally {
      ywsDocs.delete(id);
    }
  });

  it('a stale baseRevision on a LIVE page is refused and what was typed after the read survives (the lost-edit bug)', async () => {
    const id = await newPage('# Page\n\nfirst\n');
    const ytext = openRoom(id, '# Page\n\nfirst\n');
    try {
      const read = (await callJson('read_page', { id })).json!;
      ytext.insert(ytext.length, 'typed after the read\n'); // somebody types in the browser
      const result = await callJson('update_page', { id, markdown: '# Page\n\nagent version\n', baseRevision: read.bodyRevision });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('revision_conflict');
      expect(result.text).toContain(collab.bodyRevision(ytext.toString()));
      expect(ytext.toString()).toBe('# Page\n\nfirst\ntyped after the read\n');
    } finally {
      ywsDocs.delete(id);
    }
  });

  it('a matching baseRevision writes, on a live page and on a page with no room', async () => {
    const live = await newPage('# Live\n\nold\n');
    const ytext = openRoom(live, '# Live\n\nold\n');
    try {
      const rev = (await callJson('read_page', { id: live })).json!.bodyRevision as string;
      expect((await callJson('update_page', { id: live, markdown: '# Live\n\nnew\n', baseRevision: rev })).isError).toBe(false);
      expect(ytext.toString()).toBe('# Live\n\nnew\n');
    } finally {
      ywsDocs.delete(live);
    }
    const cold = await newPage('# Cold\n\nold\r\n');
    const rev = (await callJson('read_page', { id: cold })).json!.bodyRevision as string;
    expect((await callJson('update_page', { id: cold, markdown: '# Cold\n\nnew\n', baseRevision: rev })).isError).toBe(false);
    expect(collab.normalizeEol(await storage.readFreshDocBody(cold))).toBe('# Cold\n\nnew\n');
    // and a stale one on a page with no room is refused too
    const stale = await callJson('update_page', { id: cold, markdown: '# Cold\n\nlost\n', baseRevision: rev });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain('revision_conflict');
    expect(collab.normalizeEol(await storage.readFreshDocBody(cold))).toBe('# Cold\n\nnew\n');
  });

  it('without baseRevision the write is unconditional, as before', async () => {
    const id = await newPage('# Page\n\nfirst\n');
    const ytext = openRoom(id, '# Page\n\nfirst\n');
    try {
      ytext.insert(ytext.length, 'typed\n');
      expect((await callJson('update_page', { id, markdown: '# Page\n\nreplaced\n' })).isError).toBe(false);
      expect(ytext.toString()).toBe('# Page\n\nreplaced\n');
    } finally {
      ywsDocs.delete(id);
    }
  });

  it('a refused write does not persist icon/cover either', async () => {
    const id = await newPage('# Page\n\nfirst\n');
    const ytext = openRoom(id, '# Page\n\nfirst\n');
    try {
      const rev = collab.bodyRevision(ytext.toString());
      ytext.insert(ytext.length, 'x\n');
      const res = await put(id, { markdown: '# Page\n\nnew\n', icon: '🛰️', baseRevision: rev });
      expect(res.statusCode).toBe(409);
      expect((await storage.requireEntry(id)).icon ?? null).toBeNull();
    } finally {
      ywsDocs.delete(id);
    }
  });

  it('REST: a stale baseRevision answers 409 revision_conflict with the current revision; a matching one and none both write', async () => {
    const id = await newPage('# Page\n\nfirst\n');
    const ytext = openRoom(id, '# Page\n\nfirst\n');
    try {
      const { bodyRevision } = await get(id);
      ytext.insert(ytext.length, 'typed after the read\n');
      const stale = await put(id, { markdown: '# Page\n\nstale\n', baseRevision: bodyRevision });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'revision_conflict', currentRevision: collab.bodyRevision(ytext.toString()) });
      expect(ytext.toString()).toBe('# Page\n\nfirst\ntyped after the read\n');

      const fresh = (await get(id)).bodyRevision;
      expect((await put(id, { markdown: '# Page\n\nfresh\n', baseRevision: fresh })).statusCode).toBe(200);
      expect(ytext.toString()).toBe('# Page\n\nfresh\n');
      expect((await put(id, { markdown: '# Page\n\nno revision\n' })).statusCode).toBe(200);
      expect(ytext.toString()).toBe('# Page\n\nno revision\n');
    } finally {
      ywsDocs.delete(id);
    }
  });
});
