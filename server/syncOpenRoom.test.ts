/**
 * A git sync that merges a remote change into a page whose collaboration room
 * is OPEN (01.10.2026). Somebody pushes an edit from an IDE while the page is
 * open in the browser; the space's sync (performSync — the same function the
 * quiet-period auto-commit, the periodic fetch and POST /sync all run) fetches
 * and merges it into the working tree. The open Y.Doc must pick the merged
 * file up — otherwise its next debounced write, or the flush when the last
 * client leaves, puts the pre-merge text straight back over the file, and the
 * sync after that pushes the revert.
 *
 * Everything here is real: a per-file PG schema, real git with a bare remote
 * in a temp dir plus a second clone standing in for the IDE, a real http
 * server with collab.attachToServer, and real y-websocket clients with a
 * cookie session — the same path a browser takes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import WS from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as collab from './collab.js';
import * as git from './git.js';
import * as gitSync from './gitSync.js';
import * as authStore from './auth/store.js';
import { queryOne } from './db/pool.js';
import { decodeScenePayload, extractScenePayload, renderSceneSvg } from './confluenceWhiteboard.js';
import type { ExcalidrawElement, ExcalidrawScene } from './confluenceWhiteboard.js';
import { isTableParseError, parseTableFile, serializeTableFile } from '../shared/tables/index.js';
import type { TableColumn, TableDoc } from '../shared/contracts.js';

// The remotes below are local bare repos — see gitNative.test.ts for why this opt-in exists.
git.__allowLocalRepoPathsForTests();

const run = promisify(execFile);
const tempRoots: string[] = [];

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-c', 'user.name=IDE User', '-c', 'user.email=ide@example.test', ...args], { cwd });
  return stdout;
}

async function pollUntil(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 10_000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil: ${what} — not within ${timeoutMs}ms`);
}

function waitSynced(provider: WebsocketProvider, timeoutMs = 10_000): Promise<void> {
  if (provider.synced) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sync timeout')), timeoutMs);
    const onSync = (isSynced: boolean) => {
      if (isSynced) {
        clearTimeout(t);
        provider.off('sync', onSync);
        resolve();
      }
    };
    provider.on('sync', onSync);
  });
}

/** Same trick collabTables.test.ts uses: attach a cookie session to y-websocket's own `new WebSocketPolyfill(url)`. */
function cookieWs(token: string): typeof globalThis.WebSocket {
  return class extends WS {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, { headers: { Cookie: `folio_session=${token}` } });
    }
  } as unknown as typeof globalThis.WebSocket;
}

interface GitSpace {
  space: string;
  bare: string;
  /** The "IDE": an ordinary clone of the remote that pushes edits behind Folio's back. */
  ide: string;
  sessionToken: string;
}

/** A space cloned from a fresh bare remote, with one editor who has a cookie session. Pages are added by the caller; call `publish` afterwards. */
async function makeGitSpace(label: string): Promise<GitSpace> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-sync-room-'));
  tempRoots.push(root);
  const bare = path.join(root, 'remote.git');
  await run('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const seed = path.join(root, 'seed');
  await fs.mkdir(seed);
  await sh(seed, 'init', '-q', '-b', 'main');
  await fs.writeFile(path.join(seed, 'index.md'), `# ${label}\n`, 'utf8');
  await sh(seed, 'add', '-A');
  await sh(seed, 'commit', '-qm', 'seed');
  await sh(seed, 'push', '-q', bare, 'HEAD:main');

  const info = await storage.createSpaceFromRepo({ name: `${label} ${Date.now()}`, repoUrl: bare, branch: 'main', rootPath: '', createdBy: null });
  const user = await authStore.createUser({ email: `sync-room-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`, name: 'Editor', passwordHash: 'x', isAdmin: false });
  await authStore.setMembership(info.slug, user.id, 'editor');
  const session = await authStore.createSession(user.id);
  return { space: info.slug, bare, ide: path.join(root, 'ide'), sessionToken: session.token };
}

/** Commits + pushes everything Folio has on disk, then (re)clones the IDE side from the remote. */
async function publish(gs: GitSpace): Promise<void> {
  const result = await gitSync.performSync(gs.space);
  expect(result.status).toBe('clean');
  await fs.rm(gs.ide, { recursive: true, force: true });
  await run('git', ['clone', '-q', gs.bare, gs.ide]);
}

/** An edit made in the IDE clone and pushed straight to the remote. */
async function pushFromIde(gs: GitSpace, relPath: string, edit: (raw: string) => string): Promise<void> {
  await sh(gs.ide, 'pull', '-q', '--no-rebase', 'origin', 'main');
  const abs = path.join(gs.ide, relPath);
  await fs.writeFile(abs, edit(await fs.readFile(abs, 'utf8')), 'utf8');
  await sh(gs.ide, 'commit', '-qam', `ide: edit ${relPath}`);
  await sh(gs.ide, 'push', '-q', 'origin', 'HEAD:main');
}

async function remoteFile(gs: GitSpace, relPath: string): Promise<string> {
  return sh(gs.bare, 'show', `main:${relPath}`);
}

async function relPathOf(id: string): Promise<string> {
  return (await storage.requireEntry(id)).relPath;
}

async function diskFile(id: string): Promise<string> {
  return fs.readFile((await storage.requireEntry(id)).absPath, 'utf8');
}

async function snapshotStamp(id: string): Promise<number> {
  const row = await queryOne<{ updated_at: Date }>('SELECT updated_at FROM ydoc_state WHERE page_id = $1', [id]);
  return row ? row.updated_at.getTime() : 0;
}

/**
 * Closes the page's last connection and waits for the room's close-flush
 * (writeState) to finish — observable as the snapshot row being rewritten,
 * which persistDoc does right after the file.
 */
async function leaveAndWaitForFlush(id: string, provider: WebsocketProvider): Promise<void> {
  const before = await snapshotStamp(id);
  provider.destroy();
  await pollUntil(() => !collab.isDocLive(id), 'room evicted');
  await pollUntil(async () => (await snapshotStamp(id)) > before, 'close-flush wrote the room');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DOC_BODY = '# Notes\n\nFirst paragraph.\n\nSecond paragraph.\n';

const TABLE_COLUMNS: TableColumn[] = [
  { id: 'owner', name: 'Owner', type: 'text' },
  { id: 'goal', name: 'Goal', type: 'text' },
];

function tableFixture(id: string): TableDoc {
  return {
    meta: { id, version: 1, rowIds: 'column' },
    head: '# Plan\n\n',
    tail: '',
    columns: TABLE_COLUMNS.map((c) => ({ ...c })),
    views: [
      {
        id: 'all',
        name: 'All records',
        columns: { hidden: [], order: [], width: {} },
        sort: [],
        filter: { op: 'and', rules: [] },
        frozen: 0,
        rowHeight: 'short',
      },
    ],
    rows: [
      { id: 'r0000001', values: { owner: 'ann', goal: 'First goal' } },
      { id: 'r0000002', values: { owner: 'bob', goal: 'Second goal' } },
      { id: 'r0000003', values: { owner: 'cy', goal: 'Third goal' } },
    ],
  };
}

function editTableFile(raw: string, rowId: string, column: string, value: string): string {
  const doc = parseTableFile(raw);
  if (isTableParseError(doc)) throw new Error(doc.message);
  const row = doc.rows.find((r) => r.id === rowId);
  if (!row) throw new Error(`no row ${rowId}`);
  row.values[column] = value;
  return serializeTableFile(doc);
}

function tableCell(doc: TableDoc, rowId: string, column: string): unknown {
  return doc.rows.find((r) => r.id === rowId)?.values[column];
}

function parsedTable(raw: string): TableDoc {
  const doc = parseTableFile(raw);
  if (isTableParseError(doc)) throw new Error(doc.message);
  return doc;
}

function element(id: string, index: string, x: number): ExcalidrawElement {
  return {
    id,
    type: 'rectangle',
    x,
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
    index,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
}

function boardFixture(): ExcalidrawScene {
  return {
    type: 'excalidraw',
    version: 2,
    source: 'test',
    elements: [element('el-a', 'a0', 0), element('el-b', 'a1', 200), element('el-c', 'a2', 400)],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
  };
}

function sceneOf(svg: string): ExcalidrawScene {
  const payload = extractScenePayload(svg);
  if (!payload) throw new Error('no embedded scene payload');
  return decodeScenePayload(payload);
}

/** What an IDE (or excalidraw's own editor) does to one element: change it and bump its version. Folio's `<!-- folio-* -->` header lines are kept. */
function editBoardFile(raw: string, elementId: string, backgroundColor: string): string {
  const svgStart = raw.indexOf('<svg');
  const header = raw.slice(0, svgStart);
  const scene = sceneOf(raw);
  scene.elements = scene.elements.map((e) => (e.id === elementId ? { ...e, backgroundColor, version: e.version + 1, versionNonce: e.versionNonce + 1000 } : e));
  return header + renderSceneSvg(scene);
}

/** Deleting an element in excalidraw's own editor drops it from the exported scene altogether. */
function dropBoardElement(raw: string, elementId: string): string {
  const svgStart = raw.indexOf('<svg');
  const scene = sceneOf(raw);
  scene.elements = scene.elements.filter((e) => e.id !== elementId);
  return raw.slice(0, svgStart) + renderSceneSvg(scene);
}

function isLiveElement(scene: ExcalidrawScene, elementId: string): boolean {
  return scene.elements.some((e) => e.id === elementId && !e.isDeleted);
}

function boardColor(scene: ExcalidrawScene, elementId: string): string | undefined {
  return scene.elements.find((e) => e.id === elementId)?.backgroundColor;
}

/** A client-side element edit, the way the board editor writes one into the shared map. */
function editBoardInRoom(doc: Y.Doc, elementId: string, backgroundColor: string): void {
  const elements = collab.boardRoots(doc).elements;
  const cur = elements.get(elementId);
  if (!cur) throw new Error(`no element ${elementId} in the room`);
  doc.transact(() => elements.set(elementId, { ...cur, backgroundColor, version: cur.version + 1, versionNonce: cur.versionNonce + 1 }));
}

function liveScene(doc: Y.Doc): Map<string, ExcalidrawElement> {
  return new Map([...collab.boardRoots(doc).elements.entries()]);
}

/** What an IDE does to a board file beyond editing: a new element appended to the exported scene. */
function addBoardElement(raw: string, added: ExcalidrawElement): string {
  const svgStart = raw.indexOf('<svg');
  const scene = sceneOf(raw);
  scene.elements = [...scene.elements, added];
  return raw.slice(0, svgStart) + renderSceneSvg(scene);
}

/** Everything an element carries except the change counters Excalidraw bumps on any edit. */
function contentOf(el: ExcalidrawElement): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...el };
  delete copy.version;
  delete copy.versionNonce;
  delete copy.updated;
  return copy;
}

/** id -> content of every LIVE element, so "the same board" ignores tombstones and change counters. */
function liveContent(elements: Iterable<ExcalidrawElement>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const el of elements) if (!el.isDeleted) out[el.id] = contentOf(el);
  return out;
}

/**
 * The client side of a remote update, as @excalidraw/excalidraw 0.18.1 applies it
 * (data/reconcile.ts, used by BoardCanvas's remote-sync effect): a remote element
 * replaces the local one unless the local one has a higher version, or the same
 * version and a lower versionNonce. Local-only elements stay.
 */
function reconcileLikeExcalidraw(local: Map<string, ExcalidrawElement>, remote: Map<string, ExcalidrawElement>): Map<string, ExcalidrawElement> {
  const out = new Map<string, ExcalidrawElement>();
  for (const [id, theirs] of remote) {
    const mine = local.get(id);
    const keepMine = mine !== undefined && (mine.version > theirs.version || (mine.version === theirs.version && mine.versionNonce < theirs.versionNonce));
    out.set(id, keepMine ? mine : theirs);
  }
  for (const [id, mine] of local) if (!out.has(id)) out.set(id, mine);
  return out;
}

/** The user moves every element on the canvas: content changes and versions go up to `version`. */
function moveAllInRoom(doc: Y.Doc, dx: number, version: number): void {
  const elements = collab.boardRoots(doc).elements;
  doc.transact(() => {
    for (const [id, cur] of [...elements.entries()]) elements.set(id, { ...cur, x: cur.x + dx, version, versionNonce: cur.versionNonce + 100 });
  });
}

// ---------------------------------------------------------------------------

describe('a sync merge into a page with an open collaboration room', () => {
  let teardownSchema: () => Promise<void>;
  let server: http.Server;
  let port: number;
  const providers: WebsocketProvider[] = [];
  const spaces: string[] = [];

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    collab.initCollab();
    server = http.createServer();
    collab.attachToServer(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterAll(async () => {
    for (const p of providers) p.destroy();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const s of spaces) await deleteTestSpace(s);
    await teardownSchema();
    await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function connect(gs: GitSpace, pageId: string): Promise<{ doc: Y.Doc; provider: WebsocketProvider }> {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, pageId, doc, {
      WebSocketPolyfill: cookieWs(gs.sessionToken),
      connect: true,
      disableBc: true,
    });
    providers.push(provider);
    await waitSynced(provider);
    return { doc, provider };
  }

  async function docSpace(label: string): Promise<{ gs: GitSpace; id: string; rel: string }> {
    const gs = await makeGitSpace(label);
    spaces.push(gs.space);
    const page = await storage.createPage({ space: gs.space, parentPath: '', title: 'Notes', kind: 'doc' });
    await storage.writeDocBody(page.id, DOC_BODY);
    await publish(gs);
    return { gs, id: page.id, rel: await relPathOf(page.id) };
  }

  // ----- doc ---------------------------------------------------------------

  it('doc, nothing pending: the IDE edit reaches the open room, and neither the next room edit nor the last client leaving writes it away', async () => {
    const { gs, id, rel } = await docSpace('Doc Clean');
    const client = await connect(gs, id);
    await pollUntil(() => client.doc.getText('content').toString() === DOC_BODY, 'client received the page');

    await pushFromIde(gs, rel, (raw) => raw.replace('Second paragraph.', 'Second paragraph, edited in the IDE.'));
    expect((await gitSync.performSync(gs.space)).status).toBe('clean');
    expect(await diskFile(id)).toContain('edited in the IDE');

    // (a) the open room — and the connected client — now hold the merged text.
    await pollUntil(() => client.doc.getText('content').toString().includes('edited in the IDE'), 'client sees the IDE edit');
    expect(collab.getLiveText(id)).toBe('# Notes\n\nFirst paragraph.\n\nSecond paragraph, edited in the IDE.\n');

    // (b) a new edit in the room is written together with the IDE edit, not over it.
    const text = client.doc.getText('content');
    text.insert(text.toString().indexOf('First paragraph.'), 'Typed in the room. ');
    await pollUntil(async () => (await diskFile(id)).includes('Typed in the room.'), 'room edit written');
    expect(await diskFile(id)).toContain('edited in the IDE');

    expect((await gitSync.performSync(gs.space)).status).toBe('clean');
    const pushed = await remoteFile(gs, rel);
    expect(pushed).toContain('Typed in the room.');
    expect(pushed).toContain('edited in the IDE');

    // The last client leaving flushes the room — the merged text, not the old one.
    await leaveAndWaitForFlush(id, client.provider);
    expect(await diskFile(id)).toContain('edited in the IDE');
    expect(await diskFile(id)).toContain('Typed in the room.');
  }, 40_000);

  it('doc, nothing pending: the last client leaving right after the sync does not write the pre-merge text back', async () => {
    const { gs, id, rel } = await docSpace('Doc Leave');
    const client = await connect(gs, id);
    await pollUntil(() => client.doc.getText('content').toString() === DOC_BODY, 'client received the page');

    await pushFromIde(gs, rel, (raw) => raw.replace('Second paragraph.', 'Second paragraph, edited in the IDE.'));
    expect((await gitSync.performSync(gs.space)).status).toBe('clean');

    await leaveAndWaitForFlush(id, client.provider);
    expect(await diskFile(id)).toContain('edited in the IDE');

    expect((await gitSync.performSync(gs.space)).status).toBe('clean');
    expect(await remoteFile(gs, rel)).toContain('edited in the IDE');

    // Reopening reads the file, as before.
    const again = await connect(gs, id);
    await pollUntil(() => again.doc.getText('content').toString().includes('edited in the IDE'), 'reopened room has the IDE edit');
  }, 40_000);

  it('doc, a room edit still pending (not yet on disk) when the merge lands: both the room edit and the IDE edit survive', async () => {
    const { gs, id, rel } = await docSpace('Doc Pending');
    const client = await connect(gs, id);
    await pollUntil(() => client.doc.getText('content').toString() === DOC_BODY, 'client received the page');

    await pushFromIde(gs, rel, (raw) => raw.replace('Second paragraph.', 'Second paragraph, edited in the IDE.'));

    const text = client.doc.getText('content');
    text.insert(text.toString().indexOf('First paragraph.'), 'Typed just before the sync. ');
    await pollUntil(() => (collab.getLiveText(id) ?? '').includes('Typed just before the sync.'), 'room received the edit');
    expect(await diskFile(id)).not.toContain('Typed just before the sync.'); // still inside the 800ms debounce
    expect((await gitSync.performSync(gs.space)).status).toBe('clean');

    await pollUntil(() => client.doc.getText('content').toString().includes('edited in the IDE'), 'client sees the IDE edit');
    expect(client.doc.getText('content').toString()).toBe('# Notes\n\nTyped just before the sync. First paragraph.\n\nSecond paragraph, edited in the IDE.\n');
    await new Promise((r) => setTimeout(r, 1200)); // past the debounce: any stale pending write has fired by now
    const onDisk = await diskFile(id);
    expect(onDisk).toContain('Typed just before the sync.');
    expect(onDisk).toContain('edited in the IDE');

    expect((await gitSync.performSync(gs.space)).status).toBe('clean');
    const pushed = await remoteFile(gs, rel);
    expect(pushed).toContain('Typed just before the sync.');
    expect(pushed).toContain('edited in the IDE');
  }, 40_000);

  it('doc, an edit that reaches the room while git fetches and merges is kept next to the merged change', async () => {
    const { gs, id, rel } = await docSpace('Doc Window');
    const client = await connect(gs, id);
    await pollUntil(() => client.doc.getText('content').toString() === DOC_BODY, 'client received the page');
    await pushFromIde(gs, rel, (raw) => raw.replace('Second paragraph.', 'Second paragraph, edited in the IDE.'));

    // performSync's steps, with an edit landing between the commit and the merge.
    const dir = storage.getRepoDir(gs.space);
    const bases = await collab.settleRoomsForSync(gs.space);
    await git.commitAll(dir, 'folio:update', { name: 'Tester', email: 't@example.test' });
    const text = client.doc.getText('content');
    text.insert(text.toString().indexOf('First paragraph.'), 'Typed during the merge. ');
    await pollUntil(() => (collab.getLiveText(id) ?? '').includes('Typed during the merge.'), 'room received the edit');
    await git.fetch(dir);
    const preMerge = await git.headSha(dir);
    expect((await git.mergeFetchedRemote(dir, 'main')).conflict).toBe(false);
    expect(await git.filesChangedBetween(dir, preMerge, 'HEAD')).toEqual([rel]);
    await storage.scanSpace(gs.space);
    collab.reconcileLiveRoomAfterMerge(await storage.requireEntry(id), await git.showFileAt(dir, 'HEAD', rel), bases.get(id));

    const expected = '# Notes\n\nTyped during the merge. First paragraph.\n\nSecond paragraph, edited in the IDE.\n';
    await pollUntil(() => client.doc.getText('content').toString() === expected, 'client has both edits');
    await pollUntil(async () => storage.splitLeadingFrontmatter(await diskFile(id)).body === expected, 'both edits written');
    expect((await gitSync.performSync(gs.space)).status).toBe('clean');
    expect(storage.splitLeadingFrontmatter(await remoteFile(gs, rel)).body).toBe(expected);
  }, 40_000);

  it('doc, the room and the IDE changed the same line: the page stays in conflict and the room shows the markers instead of writing over them', async () => {
    const { gs, id, rel } = await docSpace('Doc Conflict');
    const client = await connect(gs, id);
    await pollUntil(() => client.doc.getText('content').toString() === DOC_BODY, 'client received the page');

    const text = client.doc.getText('content');
    const at = text.toString().indexOf('Second paragraph.');
    client.doc.transact(() => {
      text.delete(at, 'Second paragraph.'.length);
      text.insert(at, 'Second paragraph, room version.');
    });
    await pollUntil(async () => (await diskFile(id)).includes('room version'), 'room edit written');
    await pushFromIde(gs, rel, (raw) => raw.replace('Second paragraph.', 'Second paragraph, IDE version.'));
    const remoteBefore = await remoteFile(gs, rel);

    expect((await gitSync.performSync(gs.space)).status).toBe('conflict');

    // (a) the room carries the conflict as text, both sides included.
    await pollUntil(() => client.doc.getText('content').toString().includes('<<<<<<<'), 'client sees the conflict markers');
    expect(client.doc.getText('content').toString()).toContain('IDE version');
    expect(client.doc.getText('content').toString()).toContain('room version');

    // (b) typing elsewhere on the page keeps the markers (and both sides) in the file.
    text.insert(0, 'Unrelated typing. ');
    await pollUntil(async () => (await diskFile(id)).includes('Unrelated typing.'), 'room edit written');
    const onDisk = await diskFile(id);
    expect(onDisk).toContain('<<<<<<<');
    expect(onDisk).toContain('IDE version');
    expect(onDisk).toContain('room version');

    // Still a conflict on the next sync, and nothing was pushed over the IDE's version.
    expect((await gitSync.performSync(gs.space)).status).toBe('conflict');
    expect(await remoteFile(gs, rel)).toBe(remoteBefore);

    // "Take the version from Git" still resolves it, live room included.
    expect((await gitSync.resetSpaceToRemote(gs.space)).status).toBe('clean');
    const remoteBody = storage.splitLeadingFrontmatter(remoteBefore).body;
    await pollUntil(() => client.doc.getText('content').toString() === remoteBody, 'client has the remote version');
    await new Promise((r) => setTimeout(r, 1200));
    expect(await diskFile(id)).toBe(remoteBefore);
  }, 40_000);

  // ----- table -------------------------------------------------------------

  async function tableSpace(label: string): Promise<{ gs: GitSpace; id: string; rel: string }> {
    const gs = await makeGitSpace(label);
    spaces.push(gs.space);
    const page = await storage.createPage({ space: gs.space, parentPath: '', title: 'Plan', kind: 'table', columns: TABLE_COLUMNS });
    await storage.writeTableDoc(page.id, tableFixture(page.id));
    await publish(gs);
    return { gs, id: page.id, rel: await relPathOf(page.id) };
  }

  it('table, nothing pending: an IDE cell edit reaches the open room, and neither a room edit nor the last client leaving writes it away', async () => {
    const { gs, id, rel } = await tableSpace('Table Clean');
    const client = await connect(gs, id);
    await pollUntil(() => collab.tableRoots(client.doc).rows.length === 3, 'client received the table');

    await pushFromIde(gs, rel, (raw) => editTableFile(raw, 'r0000001', 'owner', 'from-ide'));
    expect((await gitSync.performSync(gs.space)).status).toBe('clean');

    await pollUntil(() => tableCell(collab.tableDocFromYDoc(client.doc), 'r0000001', 'owner') === 'from-ide', 'client sees the IDE cell');

    client.doc.transact(() => collab.tableRoots(client.doc).rows.get(1).set('owner', 'from-room'));
    await pollUntil(async () => (await diskFile(id)).includes('from-room'), 'room edit written');
    expect(tableCell(parsedTable(await diskFile(id)), 'r0000001', 'owner')).toBe('from-ide');

    expect((await gitSync.performSync(gs.space)).status).toBe('clean');
    const pushed = parsedTable(await remoteFile(gs, rel));
    expect(tableCell(pushed, 'r0000001', 'owner')).toBe('from-ide');
    expect(tableCell(pushed, 'r0000002', 'owner')).toBe('from-room');

    await leaveAndWaitForFlush(id, client.provider);
    expect(tableCell(parsedTable(await diskFile(id)), 'r0000001', 'owner')).toBe('from-ide');
  }, 40_000);

  it('table, a room edit still pending when the merge lands: both cells survive', async () => {
    const { gs, id, rel } = await tableSpace('Table Pending');
    const client = await connect(gs, id);
    await pollUntil(() => collab.tableRoots(client.doc).rows.length === 3, 'client received the table');

    await pushFromIde(gs, rel, (raw) => editTableFile(raw, 'r0000001', 'owner', 'from-ide'));
    client.doc.transact(() => collab.tableRoots(client.doc).rows.get(2).set('owner', 'pending-room'));
    await pollUntil(() => tableCell(collab.getLiveTable(id)!, 'r0000003', 'owner') === 'pending-room', 'room received the edit');
    expect((await gitSync.performSync(gs.space)).status).toBe('clean');

    await pollUntil(() => tableCell(collab.tableDocFromYDoc(client.doc), 'r0000001', 'owner') === 'from-ide', 'client sees the IDE cell');
    await new Promise((r) => setTimeout(r, 1200));
    const onDisk = parsedTable(await diskFile(id));
    expect(tableCell(onDisk, 'r0000001', 'owner')).toBe('from-ide');
    expect(tableCell(onDisk, 'r0000003', 'owner')).toBe('pending-room');

    expect((await gitSync.performSync(gs.space)).status).toBe('clean');
    const pushed = parsedTable(await remoteFile(gs, rel));
    expect(tableCell(pushed, 'r0000001', 'owner')).toBe('from-ide');
    expect(tableCell(pushed, 'r0000003', 'owner')).toBe('pending-room');
  }, 40_000);

  it('table, the room and the IDE changed the same cell: the conflicted file is not written over by the room until "Take the version from Git"', async () => {
    const { gs, id, rel } = await tableSpace('Table Conflict');
    const client = await connect(gs, id);
    await pollUntil(() => collab.tableRoots(client.doc).rows.length === 3, 'client received the table');

    client.doc.transact(() => collab.tableRoots(client.doc).rows.get(0).set('owner', 'room-value'));
    await pollUntil(async () => (await diskFile(id)).includes('room-value'), 'room edit written');
    await pushFromIde(gs, rel, (raw) => editTableFile(raw, 'r0000001', 'owner', 'ide-value'));
    const remoteBefore = await remoteFile(gs, rel);

    expect((await gitSync.performSync(gs.space)).status).toBe('conflict');
    const conflicted = await diskFile(id);
    expect(conflicted).toContain('<<<<<<<');

    client.doc.transact(() => collab.tableRoots(client.doc).rows.get(1).set('owner', 'typed-during-conflict'));
    await pollUntil(() => tableCell(collab.getLiveTable(id)!, 'r0000002', 'owner') === 'typed-during-conflict', 'room received the edit');
    await new Promise((r) => setTimeout(r, 1200));
    expect(await diskFile(id)).toBe(conflicted);

    expect((await gitSync.performSync(gs.space)).status).toBe('conflict');
    expect(await remoteFile(gs, rel)).toBe(remoteBefore);

    expect((await gitSync.resetSpaceToRemote(gs.space)).status).toBe('clean');
    await pollUntil(() => tableCell(collab.tableDocFromYDoc(client.doc), 'r0000001', 'owner') === 'ide-value', 'client has the remote version');
  }, 40_000);

  // ----- board -------------------------------------------------------------

  async function boardSpace(label: string): Promise<{ gs: GitSpace; id: string; rel: string }> {
    const gs = await makeGitSpace(label);
    spaces.push(gs.space);
    const page = await storage.createPage({ space: gs.space, parentPath: '', title: 'Sketch', kind: 'board' });
    await storage.writeBoardSvg(page.id, renderSceneSvg(boardFixture()), true);
    await publish(gs);
    return { gs, id: page.id, rel: await relPathOf(page.id) };
  }

  it('board, nothing pending: an IDE element edit (and deletion) reaches the open room, and neither a room edit nor the last client leaving writes it away', async () => {
    const { gs, id, rel } = await boardSpace('Board Clean');
    const client = await connect(gs, id);
    await pollUntil(() => collab.boardRoots(client.doc).elements.size === 3, 'client received the board');

    await pushFromIde(gs, rel, (raw) => dropBoardElement(editBoardFile(raw, 'el-a', '#00aa00'), 'el-c'));
    expect((await gitSync.performSync(gs.space)).status).toBe('clean');

    await pollUntil(() => liveScene(client.doc).get('el-a')?.backgroundColor === '#00aa00', 'client sees the IDE element');
    await pollUntil(() => liveScene(client.doc).get('el-c')?.isDeleted === true, 'client sees the IDE deletion');

    editBoardInRoom(client.doc, 'el-b', '#aa0000');
    await pollUntil(async () => boardColor(sceneOf(await diskFile(id)), 'el-b') === '#aa0000', 'room edit written');
    expect(boardColor(sceneOf(await diskFile(id)), 'el-a')).toBe('#00aa00');
    expect(isLiveElement(sceneOf(await diskFile(id)), 'el-c')).toBe(false);

    expect((await gitSync.performSync(gs.space)).status).toBe('clean');
    const pushed = sceneOf(await remoteFile(gs, rel));
    expect(boardColor(pushed, 'el-a')).toBe('#00aa00');
    expect(boardColor(pushed, 'el-b')).toBe('#aa0000');
    expect(isLiveElement(pushed, 'el-c')).toBe(false);

    await leaveAndWaitForFlush(id, client.provider);
    expect(boardColor(sceneOf(await diskFile(id)), 'el-a')).toBe('#00aa00');
    expect(isLiveElement(sceneOf(await diskFile(id)), 'el-c')).toBe(false);
  }, 40_000);

  it('board, a room edit still pending when the merge lands: the IDE change is never silently written away', async () => {
    const { gs, id, rel } = await boardSpace('Board Pending');
    const client = await connect(gs, id);
    await pollUntil(() => collab.boardRoots(client.doc).elements.size === 3, 'client received the board');

    await pushFromIde(gs, rel, (raw) => editBoardFile(raw, 'el-a', '#00aa00'));
    editBoardInRoom(client.doc, 'el-b', '#aa0000');
    await pollUntil(() => collab.getLiveBoardScene(id)?.elements.find((e) => e.id === 'el-b')?.backgroundColor === '#aa0000', 'room received the edit');
    const status = (await gitSync.performSync(gs.space)).status;

    await new Promise((r) => setTimeout(r, 1200));
    const onDisk = await diskFile(id);
    // The scene payload is one opaque line, so git cannot merge two edits of
    // one board: either the sync merged it cleanly (and the file holds both
    // changes), or it is a conflict that stays visible until resolved.
    if (status === 'clean') {
      expect(boardColor(sceneOf(onDisk), 'el-a')).toBe('#00aa00');
      expect(boardColor(sceneOf(onDisk), 'el-b')).toBe('#aa0000');
    } else {
      expect(status).toBe('conflict');
      expect(onDisk).toContain('<<<<<<<');
      expect((await gitSync.performSync(gs.space)).status).toBe('conflict');
    }
    expect(boardColor(sceneOf(await remoteFile(gs, rel)), 'el-a')).toBe('#00aa00');
  }, 40_000);

  // ----- board: "Take the version from Git" with the room open --------------

  /**
   * A board open in a client whose user moved every element (versions 1 -> 7),
   * while the IDE pushed its own edit to the same board. The sync ends in a
   * conflict; the caller then takes the version from Git.
   */
  async function boardInConflict(label: string, ideEdit: (raw: string) => string) {
    const { gs, id, rel } = await boardSpace(label);
    const client = await connect(gs, id);
    await pollUntil(() => collab.boardRoots(client.doc).elements.size === 3, 'client received the board');

    moveAllInRoom(client.doc, 50, 7);
    await pollUntil(async () => sceneOf(await diskFile(id)).elements.every((e) => e.version === 7), 'room edit written');

    await pushFromIde(gs, rel, ideEdit);
    const gitRaw = await remoteFile(gs, rel);
    const headBefore = (await sh(gs.bare, 'rev-parse', 'main')).trim();
    expect((await gitSync.performSync(gs.space)).status).toBe('conflict');
    expect(await diskFile(id)).toContain('<<<<<<<');
    expect(await remoteFile(gs, rel)).toBe(gitRaw);
    return { gs, id, rel, client, gitRaw, gitScene: sceneOf(gitRaw), headBefore };
  }

  /** The common assertions after "Take the version from Git" on a board, for both IDE edits below. */
  async function expectGitSceneEverywhere(ctx: Awaited<ReturnType<typeof boardInConflict>>): Promise<void> {
    const { gs, id, rel, client, gitRaw, gitScene, headBefore } = ctx;
    const gitLive = liveContent(gitScene.elements);
    const clientBefore = liveScene(client.doc);

    expect((await gitSync.resetSpaceToRemote(gs.space)).status).toBe('clean');

    // (b) the connected client receives the Git scene.
    await pollUntil(() => liveScene(client.doc).get('el-b')?.backgroundColor === '#00aa00', 'client has the Git version of el-b', 5_000);
    await new Promise((r) => setTimeout(r, 300));

    // (a) the room is the Git scene: same live elements, same fields; everything else is a tombstone the clients drop.
    expect(liveContent(liveScene(client.doc).values())).toEqual(gitLive);
    expect(liveContent(collab.getLiveBoardScene(id)!.elements)).toEqual(gitLive);
    for (const [elId, el] of liveScene(client.doc)) {
      if (!(elId in gitLive)) expect(el.isDeleted).toBe(true);
    }
    // ...and it is adopted by a canvas that holds the discarded local versions: excalidraw keeps a local element with the higher version.
    const adopted = reconcileLikeExcalidraw(clientBefore, liveScene(client.doc));
    expect(liveContent(adopted.values())).toEqual(gitLive);

    // (c) the last client leaving flushes the room; the file stays the Git file, byte for byte.
    await leaveAndWaitForFlush(id, client.provider);
    expect(await diskFile(id)).toBe(gitRaw);

    // (d) the next sync is clean and pushes nothing.
    expect((await gitSync.performSync(gs.space)).status).toBe('clean');
    expect(await remoteFile(gs, rel)).toBe(gitRaw);
    expect((await sh(gs.bare, 'rev-parse', 'main')).trim()).toBe(headBefore);

    // Reopening the room (snapshot + file) still gives the Git scene, not the discarded local one.
    const again = await connect(gs, id);
    await pollUntil(() => collab.boardRoots(again.doc).elements.size >= Object.keys(gitLive).length, 'reopened room has the board');
    expect(liveContent(liveScene(again.doc).values())).toEqual(gitLive);

    // (e) the conflict is over: an edit in the room is written and synced like any other.
    editBoardInRoom(again.doc, 'el-a', '#aa0000');
    await pollUntil(async () => boardColor(sceneOf(await diskFile(id)), 'el-a') === '#aa0000', 'room edit written after the reset');
    expect((await gitSync.performSync(gs.space)).status).toBe('clean');
    const pushed = sceneOf(await remoteFile(gs, rel));
    expect(boardColor(pushed, 'el-a')).toBe('#aa0000');
    expect(liveContent(pushed.elements.map((e) => (e.id === 'el-a' ? { ...e, backgroundColor: gitScene.elements.find((g) => g.id === 'el-a')!.backgroundColor } : e)))).toEqual(gitLive);
  }

  it('board, "Take the version from Git" while the room is open: every element returns to the Git scene although the local versions are higher', async () => {
    const ctx = await boardInConflict('Board Reset', (raw) => editBoardFile(raw, 'el-b', '#00aa00'));
    await expectGitSceneEverywhere(ctx);
  }, 60_000);

  it('board, "Take the version from Git" while the room is open: an element the IDE deleted goes away and one it added appears', async () => {
    const ctx = await boardInConflict('Board Reset Delete Add', (raw) =>
      addBoardElement(dropBoardElement(editBoardFile(raw, 'el-b', '#00aa00'), 'el-c'), element('el-d', 'a3', 600)),
    );
    await expectGitSceneEverywhere(ctx);
    expect(isLiveElement(ctx.gitScene, 'el-c')).toBe(false);
    expect(isLiveElement(ctx.gitScene, 'el-d')).toBe(true);
  }, 60_000);

  it('board, "Take the version from Git" when nobody has the board open: opening it afterwards shows the Git scene, not the stored local one', async () => {
    const { gs, id, rel } = await boardSpace('Board Reset Closed');
    const client = await connect(gs, id);
    await pollUntil(() => collab.boardRoots(client.doc).elements.size === 3, 'client received the board');
    moveAllInRoom(client.doc, 50, 7);
    await pollUntil(async () => sceneOf(await diskFile(id)).elements.every((e) => e.version === 7), 'room edit written');
    await leaveAndWaitForFlush(id, client.provider); // the room is gone; its stored state holds the moved elements

    await pushFromIde(gs, rel, (raw) => editBoardFile(raw, 'el-b', '#00aa00'));
    const gitRaw = await remoteFile(gs, rel);
    const gitLive = liveContent(sceneOf(gitRaw).elements);
    const headBefore = (await sh(gs.bare, 'rev-parse', 'main')).trim();
    expect((await gitSync.performSync(gs.space)).status).toBe('conflict');
    expect((await gitSync.resetSpaceToRemote(gs.space)).status).toBe('clean');
    expect(await diskFile(id)).toBe(gitRaw);

    const again = await connect(gs, id);
    await pollUntil(() => collab.boardRoots(again.doc).elements.size === 3, 'reopened room has the board');
    expect(liveContent(liveScene(again.doc).values())).toEqual(gitLive);

    await leaveAndWaitForFlush(id, again.provider);
    expect(await diskFile(id)).toBe(gitRaw);
    expect((await gitSync.performSync(gs.space)).status).toBe('clean');
    expect(await remoteFile(gs, rel)).toBe(gitRaw);
    expect((await sh(gs.bare, 'rev-parse', 'main')).trim()).toBe(headBefore);
  }, 60_000);
});
