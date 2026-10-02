/**
 * "The sidebar tree changed" live signal (02.10.2026) — real PG (isolated
 * schema), real files, a real HTTP server with the real `/events` socket and
 * real `ws` clients carrying a session cookie.
 *
 * What these tests pin down:
 *  - every way a page appears/changes (REST, an MCP tool with a PAT-style
 *    actor, scanSpace after files show up on disk, a trash restore, rename,
 *    move, copy, delete, an access change) produces ONE kind of frame for the
 *    space's readers — and nothing for anybody else;
 *  - the frame is `{ type: 'tree', space, v }` and nothing more: no title, no
 *    path, no page id, not even for a page the reader is not allowed to see;
 *  - bursts are coalesced into a handful of frames;
 *  - a frame never reaches a revoked session, a non-member, or a connection
 *    whose space belongs to another database schema.
 *
 * Negative assertions wait a little after the positive one has arrived: the
 * frames for every recipient are written in the same synchronous loop, so
 * "the member got it and 150 ms later the stranger still has nothing" is a
 * real check, not a race that happens to pass.
 */
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as WS from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { query, queryOne } from './db/pool.js';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import { HttpError } from './errors.js';
import * as git from './git.js';
import * as gitSync from './gitSync.js';
import { buildFolioMcpServer } from './mcp.js';
import * as notificationSocket from './notifications/socket.js';
import * as pageAccess from './pageAccess.js';
import { registerRoutes } from './routes.js';
import * as storage from './storage.js';
import { restoreTrashItem } from './trash/service.js';
import { COALESCER_DEFAULTS, createCoalescer, startTreeSignal, stopTreeSignal, TREE_SIGNAL_CHANNEL, type CoalescerOptions } from './treeSignal.js';
import type { User } from '../shared/contracts.js';

// Real PG migrations in beforeAll and real sockets: generous limits so that a loaded machine fails nothing but speed.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const QUIET_MS = 100;
const BUSY_QUIET_MS = 250;
const MAX_WAIT_MS = 600;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface TreeFrame {
  type: string;
  space: string;
  v: number;
}

interface EventsClient {
  /** Every non-ping frame, in arrival order. */
  frames: unknown[];
  /** The raw text of every frame — for "this string never appeared on the wire". */
  raw: string[];
  framesFor(space: string): TreeFrame[];
  waitForFrame(space: string, count?: number, timeoutMs?: number): Promise<void>;
  close(): void;
}

function openEvents(port: number, token: string): Promise<EventsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WS.WebSocket(`ws://127.0.0.1:${port}/events`, { headers: { cookie: `${session.SESSION_COOKIE_NAME}=${token}` } });
    const frames: unknown[] = [];
    const raw: string[] = [];
    const client: EventsClient = {
      frames,
      raw,
      framesFor: (space) => frames.filter((f): f is TreeFrame => (f as TreeFrame).type === 'tree' && (f as TreeFrame).space === space),
      waitForFrame: async (space, count = 1, timeoutMs = 5000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (client.framesFor(space).length >= count) return;
          await sleep(10);
        }
        throw new Error(`no ${count} tree frame(s) for ${space} within ${timeoutMs} ms (got ${client.framesFor(space).length})`);
      },
      close: () => ws.close(),
    };
    ws.on('message', (data) => {
      const text = String(data);
      raw.push(text);
      const parsed = JSON.parse(text) as { type: string };
      if (parsed.type !== 'ping') frames.push(parsed);
    });
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
  });
}

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

/** Small deterministic generator, so that the "ten busy minutes" below are the same ten minutes on every run. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('createCoalescer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Feeds `noteTimes` (ms from zero, ascending) to a coalescer built from `options` and returns when it flushed (ms from zero). */
  function simulate(noteTimes: number[], options: Partial<CoalescerOptions> = {}, tailMs = 60_000): number[] {
    const flushed: number[] = [];
    const started = Date.now();
    const coalescer = createCoalescer({ ...COALESCER_DEFAULTS, ...options, onFlush: () => flushed.push(Date.now() - started) });
    let at = 0;
    for (const t of noteTimes) {
      vi.advanceTimersByTime(t - at);
      at = t;
      coalescer.note('space-a');
    }
    vi.advanceTimersByTime(tailMs);
    return flushed;
  }
  const every = (gapMs: number, count: number, from = 0): number[] => Array.from({ length: count }, (_v, i) => from + i * gapMs);
  const D = COALESCER_DEFAULTS;

  it('turns a dense burst of notes for one key into a single flush after the quiet window', () => {
    const flushed = simulate(every(10, 200)); // a git pull: 200 rows in two seconds
    expect(flushed).toEqual([1990 + D.quietMs]);
  });

  it('a lone change after a calm spell is flushed one quiet window after it', () => {
    expect(simulate([5000])).toEqual([5000 + D.quietMs]);
    expect(simulate([0, 60_000, 120_000]).map((t, i) => t - [0, 60_000, 120_000][i])).toEqual([D.quietMs, D.quietMs, D.quietMs]);
  });

  it('a burst that never goes quiet still shows progress, but only a few times (150 pages in a minute)', () => {
    const flushed = simulate(every(400, 150));
    expect(flushed.length).toBeGreaterThanOrEqual(4);
    expect(flushed.length).toBeLessThanOrEqual(10);
    expect(flushed[0]).toBeLessThanOrEqual(D.maxWaitMs);
  });

  it('a slow import — a page every second for 200 s — is a few dozen flushes at most, not 200', () => {
    const flushed = simulate(every(1000, 200));
    expect(flushed.length).toBeGreaterThanOrEqual(10);
    expect(flushed.length).toBeLessThanOrEqual(30);
  });

  it('THE LAST CHANGE OF A BURST is never held back more than the busy quiet window, however long and busy the run before it was', () => {
    const rnd = mulberry32(20261002);
    const notes: number[] = [];
    let t = 0;
    while (t < 600_000) {
      // ten minutes of mixed activity: bursts of 1..80 notes at 5..1500 ms spacing, separated by pauses of 0.3..20 s
      const burst = 1 + Math.floor(rnd() * 80);
      const spacing = [50, 200, 600, 1000, 1500][Math.floor(rnd() * 5)];
      for (let i = 0; i < burst; i++) {
        notes.push(Math.round(t));
        t += 5 + rnd() * spacing;
      }
      t += 300 + rnd() * 20_000;
    }
    const flushed = simulate(notes);
    let checked = 0;
    notes.forEach((at, i) => {
      const nextGap = (notes[i + 1] ?? Number.POSITIVE_INFINITY) - at;
      if (nextGap <= D.busyQuietMs + 10) return; // not the last of its burst: a later note answers for it
      checked++;
      const answered = flushed.find((f) => f >= at);
      expect(answered, `note at ${at} ms was never flushed`).toBeDefined();
      expect(answered! - at, `the last note of a burst at ${at} ms waited ${answered! - at} ms`).toBeLessThanOrEqual(D.busyQuietMs + 5);
    });
    expect(checked).toBeGreaterThan(30);
    // And all that did not cost a flush per note.
    expect(flushed.length).toBeLessThan(notes.length / 4);
  });

  it('a single change right after eight busy minutes is flushed within the busy quiet window (a rename must not wait for a poll)', () => {
    const busy = every(500, 960); // eight minutes, a note every half second
    const rename = busy[busy.length - 1] + 1500; // one more change, 1.5 s after the last note of the run
    const flushed = simulate([...busy, rename]);
    const answered = flushed.find((f) => f >= rename)!;
    expect(answered - rename).toBeLessThanOrEqual(D.busyQuietMs + 5);
  });

  it('a person changing something every few seconds sees every change within the busy quiet window', () => {
    const notes = every(3000, 20);
    const flushed = simulate(notes);
    notes.forEach((at) => {
      const answered = flushed.find((f) => f >= at)!;
      expect(answered - at).toBeLessThanOrEqual(D.busyQuietMs + 5);
    });
  });

  it('the first change of a run is flushed one quiet window after it, the changes that follow within the busy quiet window', () => {
    const flushed = simulate([0, 800, 1600]);
    expect(flushed[0]).toBe(D.quietMs);
    expect(flushed[flushed.length - 1] - 1600).toBeLessThanOrEqual(D.busyQuietMs + 5);
  });

  it('keeps keys apart: a busy space does not delay or swallow another space', () => {
    const flushed: string[] = [];
    const coalescer = createCoalescer({ ...D, quietMs: 100, onFlush: (key) => flushed.push(key) });
    coalescer.note('a');
    vi.advanceTimersByTime(50);
    coalescer.note('b');
    vi.advanceTimersByTime(50);
    expect(flushed).toEqual(['a']);
    vi.advanceTimersByTime(50);
    expect(flushed).toEqual(['a', 'b']);
  });

  it('cancelAll drops pending flushes (shutdown)', () => {
    const flushed: string[] = [];
    const coalescer = createCoalescer({ ...D, onFlush: (key) => flushed.push(key) });
    coalescer.note('a');
    coalescer.cancelAll();
    vi.advanceTimersByTime(5000);
    expect(flushed).toEqual([]);
  });
});

describe('tree-changed signal over /events (real PG, real files, real sockets)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let server: http.Server;
  let port: number;

  let editorA: User; // member (editor) — the one who makes REST changes
  let viewerB: User; // member (viewer)
  let stranger: User; // member of nothing
  let admin: User; // instance admin, for the trash restore

  let tokenA: string;
  let tokenB: string;
  let tokenStranger: string;
  const clients: EventsClient[] = [];

  async function connect(token: string): Promise<EventsClient> {
    const client = await openEvents(port, token);
    clients.push(client);
    return client;
  }

  /** A fresh private space with A (editor) and B (viewer) as members; the creation noise is waited out and cleared. */
  async function makeSpace(label: string, observers: EventsClient[]): Promise<string> {
    const info = await storage.createSpace(`Tree Signal ${label} ${Date.now()}`, editorA.id);
    await authStore.setMembership(info.slug, editorA.id, 'editor');
    await authStore.setMembership(info.slug, viewerB.id, 'viewer');
    await sleep(QUIET_MS * 4);
    for (const observer of observers) {
      observer.frames.length = 0;
      observer.raw.length = 0;
    }
    return info.slug;
  }

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    editorA = await authStore.createUser({ email: `ts-a-${stamp}@t.local`, name: 'Alice Editor', passwordHash: 'x', isAdmin: false });
    viewerB = await authStore.createUser({ email: `ts-b-${stamp}@t.local`, name: 'Bob Viewer', passwordHash: 'x', isAdmin: false });
    stranger = await authStore.createUser({ email: `ts-n-${stamp}@t.local`, name: 'Nina Stranger', passwordHash: 'x', isAdmin: false });
    admin = await authStore.createUser({ email: `ts-adm-${stamp}@t.local`, name: 'Root Admin', passwordHash: 'x', isAdmin: true });
    tokenA = (await authStore.createSession(editorA.id)).token;
    tokenB = (await authStore.createSession(viewerB.id)).token;
    tokenStranger = (await authStore.createSession(stranger.id)).token;

    app = await buildApp();
    server = http.createServer();
    notificationSocket.attachToServer(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
    // The same shape as production, scaled down ~10x so the assertions stay quick: calm quiet window, longer busy quiet window, throttled progress flushes.
    await startTreeSignal({ quietMs: QUIET_MS, busyQuietMs: BUSY_QUIET_MS, maxWaitMs: MAX_WAIT_MS, minGapMs: 300, maxGapMs: 1500, calmMs: 3000 });
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
  });

  afterAll(async () => {
    await stopTreeSignal();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
    await teardownSchema();
  });

  it('a page created over REST by user A reaches member B as a bare signal and reaches a non-member as nothing', async () => {
    const a = await connect(tokenA);
    const b = await connect(tokenB);
    const n = await connect(tokenStranger);
    const slug = await makeSpace('rest', [a, b, n]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/pages',
      cookies: { [session.SESSION_COOKIE_NAME]: tokenA },
      payload: { space: slug, parentPath: '', title: 'Quarterly Secret Roadmap', kind: 'doc' },
    });
    expect(res.statusCode).toBeLessThan(300);
    const created = res.json() as { id: string; path: string };

    await b.waitForFrame(slug);
    await a.waitForFrame(slug); // the author's own tab also gets it — one extra cheap refetch there
    await sleep(150);

    expect(b.framesFor(slug)[0]).toEqual({ type: 'tree', space: slug, v: expect.any(Number) });
    expect(Object.keys(b.frames[0] as object).sort()).toEqual(['space', 'type', 'v']);
    const wire = b.raw.join('\n');
    expect(wire).not.toContain('Quarterly');
    expect(wire).not.toContain(created.id);
    expect(wire).not.toContain(created.path);
    expect(n.frames).toEqual([]);
    expect(n.raw.filter((text) => !text.includes('"ping"'))).toEqual([]);
  });

  it('a page created by an MCP tool call (token actor) produces the signal for members only', async () => {
    const b = await connect(tokenB);
    const n = await connect(tokenStranger);
    const slug = await makeSpace('mcp', [b, n]);

    const mcp = buildFolioMcpServer({ user: editorA, scopes: ['read', 'write'], tokenId: 'tree-signal-token' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'tree-signal-test', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);
    try {
      const result = await client.callTool({ name: 'create_page', arguments: { space: slug, parentPath: '', title: 'Made By An Agent' } });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }

    await b.waitForFrame(slug);
    await sleep(150);
    expect(b.framesFor(slug)[0]).toEqual({ type: 'tree', space: slug, v: expect.any(Number) });
    expect(b.raw.join('\n')).not.toContain('Made By An Agent');
    expect(n.frames).toEqual([]);
  });

  it('files that appear on disk and are picked up by scanSpace (what a git sync does) produce the signal', async () => {
    const b = await connect(tokenB);
    const n = await connect(tokenStranger);
    const slug = await makeSpace('scan', [b, n]);

    await fs.writeFile(path.join(storage.getSpaceDir(slug), 'arrived-from-git.md'), '# Arrived From Git\n\nBody.\n', 'utf8');
    await storage.scanSpace(slug);

    await b.waitForFrame(slug);
    await sleep(150);
    expect(b.framesFor(slug).length).toBeGreaterThanOrEqual(1);
    expect(b.raw.join('\n')).not.toContain('Arrived');
    expect(n.frames).toEqual([]);
  });

  it('a trash restore produces the signal (the delete before it did too)', async () => {
    const b = await connect(tokenB);
    const n = await connect(tokenStranger);
    const slug = await makeSpace('trash', [b, n]);

    const page = await storage.createPage({ space: slug, parentPath: '', title: 'Doomed Page', kind: 'doc' });
    await b.waitForFrame(slug);
    b.frames.length = 0;
    await storage.deletePage(page.id, admin.id);
    await b.waitForFrame(slug);
    await sleep(MAX_WAIT_MS / 2);
    b.frames.length = 0;
    n.frames.length = 0;

    const row = await queryOne<{ id: string }>('SELECT id FROM trash_items WHERE page_id = $1', [page.id]);
    expect(row).toBeDefined();
    await restoreTrashItem(admin, row!.id);

    await b.waitForFrame(slug);
    await sleep(150);
    expect(b.framesFor(slug)[0]).toEqual({ type: 'tree', space: slug, v: expect.any(Number) });
    expect(b.raw.join('\n')).not.toContain('Doomed');
    expect(n.frames).toEqual([]);
  });

  it('a restricted page created by its owner still sends only the bare signal, and B really cannot see the page', async () => {
    const a = await connect(tokenA);
    const b = await connect(tokenB);
    const n = await connect(tokenStranger);
    const slug = await makeSpace('restricted', [a, b, n]);

    const page = await storage.createPage({ space: slug, parentPath: '', title: 'Salary Review Draft', kind: 'doc' });
    const entry = await storage.requireEntry(page.id);
    await pageAccess.setAccess(editorA, entry, 'restricted', []);

    await b.waitForFrame(slug);
    await sleep(MAX_WAIT_MS / 2);

    // The signal is the same for everybody who can read the space...
    for (const frame of b.framesFor(slug)) expect(frame).toEqual({ type: 'tree', space: slug, v: expect.any(Number) });
    const wire = b.raw.join('\n');
    expect(wire).not.toContain('Salary');
    expect(wire).not.toContain(page.id);
    expect(wire).not.toContain(page.path);
    // ...and the page itself is still hidden from B by the normal API path the client refetches through.
    expect((await pageAccess.readablePageIds(viewerB.id, slug, false)).has(page.id)).toBe(false);
    expect((await pageAccess.readablePageIds(editorA.id, slug, false)).has(page.id)).toBe(true);
    expect(n.frames).toEqual([]);
  });

  it('rename, move, duplicate, copy, delete and an access change each produce a signal; a content-only edit does not', async () => {
    const b = await connect(tokenB);
    const slug = await makeSpace('ops', [b]);
    const page = await storage.createPage({ space: slug, parentPath: '', title: 'Operations Page', kind: 'doc' });
    await b.waitForFrame(slug);
    await sleep(MAX_WAIT_MS / 2);

    const expectSignalAfter = async (label: string, action: () => Promise<unknown>): Promise<void> => {
      b.frames.length = 0;
      await action();
      await b.waitForFrame(slug, 1, 3000).catch((err: Error) => {
        throw new Error(`${label}: ${err.message}`);
      });
      await sleep(MAX_WAIT_MS / 2);
    };

    // A content-only edit leaves the tree alone: this is what keeps autosave quiet.
    b.frames.length = 0;
    await storage.patchEntryContent(await storage.requireEntry(page.id), '# Operations Page\n\nOnly the body changed.\n');
    await sleep(MAX_WAIT_MS / 2);
    expect(b.framesFor(slug)).toEqual([]);

    await expectSignalAfter('rename', () => storage.renameDocDirect(page.id, 'Operations Page Renamed'));
    await expectSignalAfter('move', () => storage.movePage(page.id, 'archive'));
    await expectSignalAfter('duplicate', () => storage.duplicatePage(page.id));
    await expectSignalAfter('copy', () => storage.copyPage(page.id, slug, ''));
    await expectSignalAfter('access change', async () => {
      const entry = await storage.requireEntry(page.id);
      await pageAccess.setAccess(editorA, entry, 'restricted', []);
    });
    await expectSignalAfter('delete', () => storage.deletePage(page.id, admin.id));
  });

  it('a burst of changes is coalesced: a 60-page import is fewer frames than pages, 200 raw index notifications are a handful', async () => {
    const b = await connect(tokenB);
    const slug = await makeSpace('burst', [b]);

    // What an import or a git pull looks like to the index: many files appear, one scan indexes them row by row.
    await Promise.all(
      Array.from({ length: 60 }, (_v, i) => fs.writeFile(path.join(storage.getSpaceDir(slug), `burst-page-${i}.md`), `# Burst Page ${i}\n\nBody.\n`, 'utf8')),
    );
    await storage.scanSpace(slug);
    await b.waitForFrame(slug);
    await sleep(MAX_WAIT_MS + 200);
    // How many frames depends on how fast this machine indexes (the pacing of a slow trickle is covered with fake timers above);
    // what must hold anywhere is: not one frame per page.
    const scanFrames = b.framesFor(slug).length;
    expect(scanFrames).toBeGreaterThanOrEqual(1);
    expect(scanFrames).toBeLessThan(60);

    // 200 raw notifications arriving at once, as a dense import produces them: a handful of frames at most.
    b.frames.length = 0;
    await Promise.all(
      Array.from({ length: 200 }, () => query(`SELECT pg_notify('${TREE_SIGNAL_CHANNEL}', json_build_object('schema', current_schema(), 'space', $1::text)::text)`, [slug])),
    );
    await b.waitForFrame(slug);
    await sleep(MAX_WAIT_MS + 200);
    const denseFrames = b.framesFor(slug);
    expect(denseFrames.length).toBeGreaterThanOrEqual(1);
    expect(denseFrames.length).toBeLessThanOrEqual(6);
    const versions = denseFrames.map((f) => f.v);
    expect([...versions].sort((x, y) => x - y)).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('a table page created through the MCP create_page tool (kind table) produces the signal', async () => {
    const b = await connect(tokenB);
    const slug = await makeSpace('table', [b]);

    const mcp = buildFolioMcpServer({ user: editorA, scopes: ['read', 'write'], tokenId: 'tree-signal-token-table' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'tree-signal-test', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);
    try {
      const result = await client.callTool({ name: 'create_page', arguments: { space: slug, parentPath: '', title: 'Quarterly Numbers Table', kind: 'table', columns: [{ name: 'Name', type: 'text' }] } });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }

    await b.waitForFrame(slug);
    expect(b.framesFor(slug)[0]).toEqual({ type: 'tree', space: slug, v: expect.any(Number) });
    expect(b.raw.join('\n')).not.toContain('Quarterly');
  });

  it('a page file that arrives from the git remote through a sync (what pressing Sync after an IDE push does) produces the signal', async () => {
    const b = await connect(tokenB);
    const n = await connect(tokenStranger);
    const execFileAsync = promisify(execFile);
    git.__allowLocalRepoPathsForTests();
    const bareDir = path.join(os.tmpdir(), `folio-test-bare-treesignal-${Date.now()}.git`);
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bareDir]);
    const seedDir = path.join(os.tmpdir(), `folio-test-seed-treesignal-${Date.now()}`);
    await fs.mkdir(seedDir, { recursive: true });
    await git.initWithCommit(seedDir, 'seed placeholder');
    await fs.writeFile(path.join(seedDir, 'index.md'), '---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAY\n---\n# Synced Space\n\noriginal\n', 'utf8');
    await git.commitAll(seedDir, 'seed', { name: 'Tester', email: 't@example.test' });
    await execFileAsync('git', ['remote', 'add', 'origin', bareDir], { cwd: seedDir });
    await git.push(seedDir, 'main');
    await fs.rm(seedDir, { recursive: true, force: true });

    const space = await storage.createSpaceFromRepo({ name: `Tree Signal Sync ${Date.now()}`, repoUrl: bareDir, branch: 'main', rootPath: '', createdBy: editorA.id });
    const slug = space.slug;
    await authStore.setMembership(slug, editorA.id, 'editor');
    await authStore.setMembership(slug, viewerB.id, 'viewer');
    await sleep(QUIET_MS * 4);
    b.frames.length = 0;
    b.raw.length = 0;

    const ide = path.join(os.tmpdir(), `folio-test-ide-treesignal-${Date.now()}`);
    await git.clone(bareDir, ide, 'main');
    await fs.writeFile(path.join(ide, 'pushed-from-ide.md'), '# Pushed From The IDE\n\nBody.\n', 'utf8');
    await git.commitAll(ide, 'ide: add a page', { name: 'Other', email: 'o@example.test' });
    await git.push(ide, 'main');

    try {
      const result = await gitSync.performSync(slug);
      expect(result.status).not.toBe('error');
      expect(await storage.listEntries(slug).then((entries) => entries.some((e) => e.relPath === 'pushed-from-ide.md'))).toBe(true);

      await b.waitForFrame(slug);
      await sleep(150);
      expect(b.framesFor(slug)[0]).toEqual({ type: 'tree', space: slug, v: expect.any(Number) });
      expect(b.raw.join('\n')).not.toContain('Pushed');
      expect(n.frames).toEqual([]);
    } finally {
      await deleteTestSpace(slug);
      await fs.rm(bareDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(ide, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);

  it('a lone change right after a long busy run is signalled within the busy quiet window, not when the throttle allows', async () => {
    const b = await connect(tokenB);
    const slug = await makeSpace('after-busy', [b]);
    const notify = () => query(`SELECT pg_notify('${TREE_SIGNAL_CHANNEL}', json_build_object('schema', current_schema(), 'space', $1::text)::text)`, [slug]);

    // A busy spell: a raw index notification every 80 ms for four seconds (the coalescer is deep into its throttle by now).
    const busyUntil = Date.now() + 4000;
    while (Date.now() < busyUntil) {
      await notify();
      await sleep(80);
    }
    await sleep(BUSY_QUIET_MS + 100); // the run's own last flush goes out; then one lone change shortly after it
    b.frames.length = 0;

    const changedAt = Date.now();
    await storage.createPage({ space: slug, parentPath: '', title: 'Lone Change After Busy Run', kind: 'doc' });
    await b.waitForFrame(slug, 1, 3000);
    const waited = Date.now() - changedAt;
    // createPage itself takes a few tens of ms; the signal must come one busy quiet window after its last write, nowhere near the throttle's 1.5 s ceiling.
    expect(waited).toBeLessThan(BUSY_QUIET_MS + 600);
  });

  it('an instance-visible space signals any active user; switching it back to private stops that', async () => {
    const n = await connect(tokenStranger);
    const slug = await makeSpace('instance', [n]);
    await authStore.setSpaceVisibility(slug, 'instance');

    await storage.createPage({ space: slug, parentPath: '', title: 'Visible To Everyone', kind: 'doc' });
    await n.waitForFrame(slug);
    await sleep(MAX_WAIT_MS / 2);

    await authStore.setSpaceVisibility(slug, 'private');
    n.frames.length = 0;
    await storage.createPage({ space: slug, parentPath: '', title: 'Private Again', kind: 'doc' });
    await sleep(MAX_WAIT_MS);
    expect(n.frames).toEqual([]);
  });

  it('a revoked session and a removed member stop receiving; a signal for another schema or garbage is ignored', async () => {
    const b = await connect(tokenB);
    const extraToken = (await authStore.createSession(viewerB.id)).token;
    const bSecondTab = await connect(extraToken);
    const slug = await makeSpace('revoked', [b, bSecondTab]);

    // Garbage and a foreign schema do nothing.
    await query(`SELECT pg_notify('${TREE_SIGNAL_CHANNEL}', 'not json at all')`);
    await query(`SELECT pg_notify('${TREE_SIGNAL_CHANNEL}', $1)`, [JSON.stringify({ schema: 'some_other_schema', space: slug })]);
    await query(`SELECT pg_notify('${TREE_SIGNAL_CHANNEL}', $1)`, [JSON.stringify({ schema: 'public' })]);
    await sleep(MAX_WAIT_MS / 2);
    expect(b.frames).toEqual([]);

    // Logging out one tab's session silences exactly that connection.
    await authStore.destroySession(extraToken);
    await storage.createPage({ space: slug, parentPath: '', title: 'After Logout', kind: 'doc' });
    await b.waitForFrame(slug);
    await sleep(MAX_WAIT_MS / 2);
    expect(bSecondTab.frames).toEqual([]);

    // Removing the membership silences the rest.
    await authStore.removeMembership(slug, viewerB.id);
    b.frames.length = 0;
    await storage.createPage({ space: slug, parentPath: '', title: 'After Removal', kind: 'doc' });
    await sleep(MAX_WAIT_MS);
    expect(b.frames).toEqual([]);
  });

  it('the batch reader check agrees with effectiveRole for members, strangers, instance spaces and disabled users', async () => {
    const slug = await makeSpace('parity', []);
    const disabled = await authStore.createUser({ email: `ts-dis-${Date.now()}@t.local`, name: 'Disabled', passwordHash: 'x', isAdmin: false });
    await authStore.setMembership(slug, disabled.id, 'viewer');
    const disabledToken = (await authStore.createSession(disabled.id)).token;
    await authStore.updateUser(disabled.id, { disabled: true });

    const tokens = [tokenA, tokenB, tokenStranger, disabledToken, 'not-a-session-token'];
    const users: Array<User | undefined> = [editorA, viewerB, stranger, { ...disabled, disabled: true }, undefined];
    const check = async (): Promise<boolean[]> => {
      const allowed = await authStore.sessionsThatCanReadSpace(slug, tokens);
      return tokens.map((token) => allowed.has(token));
    };
    const expected = async (): Promise<boolean[]> => Promise.all(users.map(async (user) => (user ? (await session.effectiveRole(user, slug)) !== undefined : false)));

    expect(await check()).toEqual(await expected());
    expect(await check()).toEqual([true, true, false, false, false]);

    await authStore.setSpaceVisibility(slug, 'instance');
    expect(await check()).toEqual(await expected());
    expect(await check()).toEqual([true, true, true, false, false]);

    await deleteTestSpace(slug);
  });
});
