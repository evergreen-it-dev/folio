/**
 * OFFLINE CREATION (29.09.2026) — POST /api/pages with a client-minted `id` and
 * the client's Y.Doc (`ydocState`).
 *
 * The whole point of the feature is that the collab room RESUMES from the
 * client's CRDT history: the server stores `ydocState` as the room's snapshot
 * and writes the file from that same doc. If it seeded the room fresh from the
 * file instead, the browser's local doc would merge in as an unrelated second
 * document and the body would double ("THE DOUBLING", see server/collab.ts
 * bindState). So most cases below end the same way: open a room the way
 * production does (`bindState` on a fresh doc), let the client's doc — with
 * edits made on top of what was sent — sync with it in both directions, and
 * count how many times the text is there.
 *
 * Same harness as spacesRepoUrl.test.ts: real PG (isolated schema), real
 * files, the real routes through Fastify's inject.
 */
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { ulid } from 'ulidx';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import * as collab from './collab.js';
import { query } from './db/pool.js';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import { decodeScenePayload, extractScenePayload } from './confluenceWhiteboard.js';
import type { ExcalidrawElement, ExcalidrawScene } from './confluenceWhiteboard.js';
import { HttpError } from './errors.js';
import { registerRoutes } from './routes.js';
import * as storage from './storage.js';

// `yjs` is a dual ESM/CJS package (see collab.ts's yEngineFor). The test's own
// `Y` is the ESM copy — what a plain `new Y.Doc()` in the other collab tests
// is. Production rooms are y-websocket's WSSharedDoc, built from the CJS copy.
const nodeRequire = createRequire(import.meta.url);
const YCjs = nodeRequire('yjs') as typeof Y;
const { WSSharedDoc } = nodeRequire('y-websocket/bin/utils') as { WSSharedDoc: new (name: string) => Y.Doc };

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  await app.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', session.requireSession);
    registerRoutes(protectedScope);
  });
  await app.ready();
  return app;
}

function makeElement(id: string, overrides: Partial<ExcalidrawElement> = {}): ExcalidrawElement {
  return {
    id,
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: 'a0',
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    ...overrides,
  };
}

/** A client's local doc for a page: text typed into Y.Text('content'). */
function clientDocWithText(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, text);
  return doc;
}

/** A client's local doc for a board: elements written the way the board editor's collab binding writes them. */
function clientBoardDoc(elements: ExcalidrawElement[]): Y.Doc {
  const doc = new Y.Doc();
  const roots = collab.boardRoots(doc);
  doc.transact(() => {
    for (const el of elements) roots.elements.set(el.id, el);
    roots.board.set('viewBackgroundColor', '#ffffff');
  });
  return doc;
}

async function readFileScene(absPath: string): Promise<ExcalidrawScene> {
  const payload = extractScenePayload(await fs.readFile(absPath, 'utf8'));
  if (!payload) throw new Error('no embedded scene payload');
  return decodeScenePayload(payload);
}

/** The full two-way exchange y-websocket's sync protocol performs on connect. */
function syncBothWays(a: Y.Doc, b: Y.Doc, engineOfB: typeof Y = Y): void {
  const fromA = Y.encodeStateAsUpdate(a);
  const fromB = engineOfB.encodeStateAsUpdate(b);
  engineOfB.applyUpdate(b, fromA);
  Y.applyUpdate(a, fromB);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('POST /api/pages with a client id and Y.Doc (real PG + real files, fastify inject)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let editorCookie: string;
  let viewerCookie: string;
  let spaceA: string;
  let spaceB: string;
  const openedRooms: string[] = [];

  function create(body: Record<string, unknown>, cookie = editorCookie) {
    return app.inject({ method: 'POST', url: '/api/pages', payload: body, headers: { cookie } });
  }

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const editor = await authStore.createUser({ email: `offline-editor-${Date.now()}@test.local`, name: 'Editor', passwordHash: 'x', isAdmin: false });
    const viewer = await authStore.createUser({ email: `offline-viewer-${Date.now()}@test.local`, name: 'Viewer', passwordHash: 'x', isAdmin: false });
    editorCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(editor.id)).token}`;
    viewerCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(viewer.id)).token}`;

    spaceA = (await storage.createSpace(`Offline A ${Date.now()}`, editor.id)).slug;
    spaceB = (await storage.createSpace(`Offline B ${Date.now()}`, editor.id)).slug;
    await authStore.setMembership(spaceA, editor.id, 'editor');
    await authStore.setMembership(spaceB, editor.id, 'editor');
    await authStore.setMembership(spaceA, viewer.id, 'viewer');

    app = await buildApp();
  });

  afterAll(async () => {
    // A room this file opened has a debounced write-back armed; run it now, not after the schema is gone.
    for (const id of openedRooms) await collab.flushDoc(id).catch(() => {});
    await app?.close();
    await deleteTestSpace(spaceA);
    await deleteTestSpace(spaceB);
    await teardownSchema();
  });

  // -------------------------------------------------------------------------
  // doc
  // -------------------------------------------------------------------------

  // The text deliberately has NO trailing newline: that is what a user leaves
  // behind by typing at the end of "# Title\n\n", and it is the shape that used
  // to make bindState think the file had "moved on" and replace the whole body.
  const TYPED = '# Retyped Title\n\nWritten with no network.';

  it('doc: the page gets the client id, the file is written from the Y.Text, and ydoc_state holds the client bytes', async () => {
    const id = ulid();
    const client = clientDocWithText(TYPED);
    const state = Y.encodeStateAsUpdate(client);

    const res = await create({ space: spaceA, parentPath: '', title: 'Untitled', kind: 'doc', id, ydocState: toBase64(state) });
    expect(res.statusCode).toBe(201);
    const meta = res.json();
    expect(meta).toMatchObject({ id, space: spaceA, kind: 'doc', title: 'Retyped Title', path: 'retyped-title.md' }); // the H1, not the form's `title`

    // The file body is the Y.Text (persistDocFrontmatter's usual final newline aside), frontmatter carries the client id.
    expect(await storage.readFreshDocBody(id)).toBe(storage.docFileBody(TYPED));
    expect(await fs.readFile((await storage.requireEntry(id)).absPath, 'utf8')).toContain(`id: ${id}`);

    // Byte for byte the client's history.
    const stored = await collab.loadSnapshot(id);
    expect(stored).toBeDefined();
    expect(Buffer.compare(Buffer.from(stored!), Buffer.from(state))).toBe(0);
  });

  it('doc: a room opened for that id holds the text exactly once and merges the client\'s later edits without doubling', async () => {
    const id = ulid();
    const client = clientDocWithText(TYPED);
    const res = await create({ space: spaceA, parentPath: '', title: 'Untitled', kind: 'doc', id, ydocState: toBase64(Y.encodeStateAsUpdate(client)) });
    expect(res.statusCode).toBe(201);

    // The user kept typing while the request was in flight: edits on top of the ORIGINAL doc, in the middle and at the end.
    client.getText('content').insert('# Retyped Title\n\nWritten'.length, ' (edited)');
    client.getText('content').insert(client.getText('content').length, ' More.');
    const expected = '# Retyped Title\n\nWritten (edited) with no network. More.';
    expect(client.getText('content').toString()).toBe(expected);

    const room = new Y.Doc();
    await collab.bindState(id, room);
    openedRooms.push(id);
    // Resumed from the snapshot; the file's final "\n" is not a difference and must not turn into an edit.
    expect(room.getText('content').toString()).toBe(TYPED);

    syncBothWays(client, room);
    expect(room.getText('content').toString()).toBe(expected);
    expect(client.getText('content').toString()).toBe(expected);
    expect(occurrences(room.getText('content').toString(), 'Retyped Title')).toBe(1);
    expect(occurrences(room.getText('content').toString(), 'Written')).toBe(1);
  });

  it('doc: the same holds for a production room (y-websocket\'s WSSharedDoc, built from the CJS copy of yjs)', async () => {
    const id = ulid();
    const client = clientDocWithText('# CJS Room\n\nBody typed offline\n');
    const res = await create({ space: spaceA, parentPath: '', title: 'Untitled', kind: 'doc', id, ydocState: toBase64(Y.encodeStateAsUpdate(client)) });
    expect(res.statusCode).toBe(201);
    client.getText('content').insert(client.getText('content').length, 'Then more.\n');

    const room = new WSSharedDoc(id);
    await collab.bindState(id, room);
    openedRooms.push(id);
    expect(room.getText('content').toString()).toBe('# CJS Room\n\nBody typed offline\n');

    syncBothWays(client, room, YCjs);
    expect(room.getText('content').toString()).toBe('# CJS Room\n\nBody typed offline\nThen more.\n');
    expect(client.getText('content').toString()).toBe(room.getText('content').toString());
  });

  it('doc: a client doc with no text yields the ordinary starter file (titled by the form) and still gets its snapshot', async () => {
    const id = ulid();
    const state = Y.encodeStateAsUpdate(new Y.Doc());
    const res = await create({ space: spaceA, parentPath: '', title: 'Blank Offline', kind: 'doc', id, ydocState: toBase64(state) });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id, title: 'Blank Offline', path: 'blank-offline.md' });
    expect(await storage.readFreshDocBody(id)).toBe('# Blank Offline\n');
    expect(await collab.loadSnapshot(id)).toBeDefined();
  });

  it('doc: an id without a ydocState is honoured too (no snapshot; the room will seed from the file as usual)', async () => {
    const id = ulid();
    const res = await create({ space: spaceA, parentPath: '', title: 'Id Only', kind: 'doc', id });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).toBe(id);
    expect(await storage.readFreshDocBody(id)).toBe('# Id Only\n');
    expect(await collab.loadSnapshot(id)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // board
  // -------------------------------------------------------------------------

  it('board: the file embeds the scene from the client\'s doc and the room opens with exactly those elements', async () => {
    const id = ulid();
    const client = clientBoardDoc([makeElement('el-a', { index: 'a0' }), makeElement('el-b', { index: 'a1', x: 200 })]);
    const state = Y.encodeStateAsUpdate(client);

    const res = await create({ space: spaceA, parentPath: '', title: 'Offline Board', kind: 'board', id, ydocState: toBase64(state) });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id, kind: 'board', title: 'Offline Board' });

    const entry = await storage.requireEntry(id);
    const scene = await readFileScene(entry.absPath);
    expect(scene.elements.map((e) => e.id).sort()).toEqual(['el-a', 'el-b']);
    expect(await fs.readFile(entry.absPath, 'utf8')).toContain(`folio-id: ${id}`);

    const stored = await collab.loadSnapshot(id);
    expect(Buffer.compare(Buffer.from(stored!), Buffer.from(state))).toBe(0);

    // The room resumes from the client's history; an element drawn on top of the sent doc merges in once.
    client.transact(() => collab.boardRoots(client).elements.set('el-c', makeElement('el-c', { index: 'a2', x: 400 })));
    const room = new Y.Doc();
    await collab.bindState(id, room);
    openedRooms.push(id);
    expect([...collab.boardRoots(room).elements.keys()].sort()).toEqual(['el-a', 'el-b']);

    syncBothWays(client, room);
    expect([...collab.boardRoots(room).elements.keys()].sort()).toEqual(['el-a', 'el-b', 'el-c']);
    expect([...collab.boardRoots(client).elements.keys()].sort()).toEqual(['el-a', 'el-b', 'el-c']);
  });

  it('board: a board with no elements gets the blank starter file (no scene payload) but still its snapshot', async () => {
    const id = ulid();
    const client = new Y.Doc();
    client.transact(() => collab.boardRoots(client).board.set('viewBackgroundColor', '#eeeeee'));
    const res = await create({ space: spaceA, parentPath: '', title: 'Empty Board', kind: 'board', id, ydocState: toBase64(Y.encodeStateAsUpdate(client)) });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id, kind: 'board', title: 'Empty Board' });
    const svg = await fs.readFile((await storage.requireEntry(id)).absPath, 'utf8');
    expect(extractScenePayload(svg)).toBeFalsy();
    expect(svg).toContain('width="1" height="1"');
    expect(await collab.loadSnapshot(id)).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // replay / conflict
  // -------------------------------------------------------------------------

  it('replay: the same create again answers 200 with the same meta, changes nothing and records no second page change', async () => {
    const id = ulid();
    const payload = { space: spaceA, parentPath: '', title: 'Replay Me', kind: 'doc', id, ydocState: toBase64(Y.encodeStateAsUpdate(clientDocWithText('# Replay Me\n\nOnce.\n'))) };
    const first = await create(payload);
    expect(first.statusCode).toBe(201);
    const snapshotAfterFirst = await collab.loadSnapshot(id);

    const changes = async () => Number((await query<{ n: string }>('SELECT count(*)::text AS n FROM page_change_history WHERE page_id = $1', [id]))[0].n);
    expect(await changes()).toBe(1);

    const second = await create(payload);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());

    expect(await changes()).toBe(1);
    const files = (await fs.readdir(storage.getRepoDir(spaceA))).filter((f) => f.startsWith('replay-me'));
    expect(files).toEqual(['replay-me.md']); // no `replay-me-2.md`
    // The room's snapshot is untouched — a replay must never rewind a room that may have moved on.
    expect(Buffer.compare(Buffer.from((await collab.loadSnapshot(id))!), Buffer.from(snapshotAfterFirst!))).toBe(0);
  });

  it('replay still needs the create permissions: a viewer gets 403, for a fresh id and for an existing one', async () => {
    const id = ulid();
    expect((await create({ space: spaceA, parentPath: '', title: 'Viewer Try', kind: 'doc', id }, viewerCookie)).statusCode).toBe(403);
    expect(await storage.getEntry(id)).toBeUndefined();

    const made = await create({ space: spaceA, parentPath: '', title: 'Editor Made', kind: 'doc', id });
    expect(made.statusCode).toBe(201);
    expect((await create({ space: spaceA, parentPath: '', title: 'Editor Made', kind: 'doc', id }, viewerCookie)).statusCode).toBe(403);
  });

  it('conflict: an id owned by a page of another space is a 409 and the existing page is untouched', async () => {
    const id = ulid();
    expect((await create({ space: spaceA, parentPath: '', title: 'Owner Page', kind: 'doc', id })).statusCode).toBe(201);

    const res = await create({ space: spaceB, parentPath: '', title: 'Thief', kind: 'doc', id });
    expect(res.statusCode).toBe(409);
    expect((await storage.requireEntry(id)).space).toBe(spaceA);
    expect(await fs.readdir(storage.getRepoDir(spaceB))).not.toContain('thief.md');
  });

  it('conflict: an id owned by a page of another kind (same space) is a 409', async () => {
    const id = ulid();
    expect((await create({ space: spaceA, parentPath: '', title: 'A Doc', kind: 'doc', id })).statusCode).toBe(201);
    const res = await create({ space: spaceA, parentPath: '', title: 'A Board', kind: 'board', id });
    expect(res.statusCode).toBe(409);
    expect((await storage.requireEntry(id)).kind).toBe('doc');
  });

  it('storage.createPage itself refuses to stamp an id twice (two concurrent creates racing past the route\'s check)', async () => {
    const id = ulid();
    await storage.createPage({ space: spaceA, parentPath: '', title: 'Raced', kind: 'doc', id });
    await expect(storage.createPage({ space: spaceA, parentPath: '', title: 'Raced Again', kind: 'doc', id })).rejects.toMatchObject({ status: 409 });
    expect(await fs.readdir(storage.getRepoDir(spaceA))).not.toContain('raced-again.md');
  });

  // -------------------------------------------------------------------------
  // bad input
  // -------------------------------------------------------------------------

  it('invalid ydocState is a 400 and creates nothing', async () => {
    const valid = Y.encodeStateAsUpdate(clientDocWithText('# Some Reasonably Long Title\n\nAnd a body long enough to truncate.\n'));
    const badStates: Record<string, string> = {
      'not base64 at all': '!!!not base64!!!',
      'base64 with a stray character': `${toBase64(valid).slice(0, 8)}*${toBase64(valid).slice(8)}`,
      'a lone character (no whole byte)': 'A',
      'empty': '',
      'random bytes': toBase64(Uint8Array.from([255, 254, 253, 252, 251, 250, 249, 248])),
      'a truncated update': toBase64(valid.slice(0, Math.floor(valid.length / 2))),
    };
    for (const [label, ydocState] of Object.entries(badStates)) {
      for (const kind of ['doc', 'board'] as const) {
        const id = ulid();
        const res = await create({ space: spaceA, parentPath: '', title: 'Garbage', kind, id, ydocState });
        expect(res.statusCode, `${kind}: ${label}`).toBe(400);
        expect(await storage.getEntry(id), `${kind}: ${label}`).toBeUndefined();
      }
    }
    expect((await fs.readdir(storage.getRepoDir(spaceA))).filter((f) => f.startsWith('garbage'))).toEqual([]);
  });

  it('ydocState without an id is a 400', async () => {
    const res = await create({ space: spaceA, parentPath: '', title: 'No Id', kind: 'doc', ydocState: toBase64(Y.encodeStateAsUpdate(clientDocWithText('# No Id\n'))) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/requires id/);
    expect((await fs.readdir(storage.getRepoDir(spaceA))).filter((f) => f.startsWith('no-id'))).toEqual([]);
  });

  it('an id that is not a ULID is a 400 (the contract\'s own check)', async () => {
    const res = await create({ space: spaceA, parentPath: '', title: 'Bad Id', kind: 'doc', id: 'not-a-ulid' });
    expect(res.statusCode).toBe(400);
  });

  // -------------------------------------------------------------------------
  // other kinds / unchanged behaviour
  // -------------------------------------------------------------------------

  it('other kinds honour the id and ignore ydocState (no snapshot is stored for them)', async () => {
    const id = ulid();
    const res = await create({ space: spaceA, parentPath: '', title: 'Offline Table', kind: 'table', id, ydocState: toBase64(Y.encodeStateAsUpdate(clientDocWithText('ignored'))) });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id, kind: 'table' });
    expect(await collab.loadSnapshot(id)).toBeUndefined();
  });

  it('without the new fields the create is exactly what it was: 201, a freshly minted id, the starter file, no snapshot', async () => {
    const res = await create({ space: spaceA, parentPath: '', title: 'Plain Page', kind: 'doc' });
    expect(res.statusCode).toBe(201);
    const meta = res.json();
    expect(meta.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(meta).toMatchObject({ title: 'Plain Page', path: 'plain-page.md' });
    expect(await storage.readFreshDocBody(meta.id)).toBe('# Plain Page\n');
    expect(await collab.loadSnapshot(meta.id)).toBeUndefined();
  });
});
