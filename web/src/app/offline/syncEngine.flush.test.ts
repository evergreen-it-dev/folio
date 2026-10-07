/**
 * The sync engine's headless flush of an unsynced page (flushDirtyDoc), in
 * the order it really runs: the local copy is loaded into the doc FIRST, the
 * server-acknowledgement tracker is attached after. The copy may be the only
 * one of an offline edit, so it is deleted only when the server's state
 * vector covers it (review of 90def95: a tracker that started from an empty
 * doc confirmed it at once, and a server that never took the edit — a
 * read-only connection, a dead socket — lost it).
 */
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirtyDoc } from './dirtyDocs';
import type { LocalPage } from './localPages';

const world = vi.hoisted(() => ({
  /** What the page's IndexedDB copy holds. */
  onDisk: null as Uint8Array | null,
  cleared: 0,
  destroyed: 0,
  /** The server's own doc — what its step 1 answers describe. */
  server: null as unknown as import('yjs').Doc,
  /** Whether the server applies what the client sends (false = a read-only connection). */
  accepts: true,
}));

vi.mock('./ydocPersistence', async (original) => ({
  ...(await original<typeof import('./ydocPersistence')>()),
  persistYDoc: (_pageId: string, doc: Y.Doc) => {
    if (world.onDisk) Y.applyUpdate(doc, world.onDisk, 'indexeddb');
    return {
      whenLoaded: Promise.resolve(),
      clear: async () => {
        world.cleared += 1;
      },
      destroy: () => {
        world.destroyed += 1;
      },
    };
  },
}));

vi.mock('y-websocket', () => {
  type Handler = (encoder: encoding.Encoder, decoder: decoding.Decoder, provider: unknown, emitSynced: boolean, messageType: number) => void;
  class FakeProvider {
    wsconnected = false;
    synced = false;
    private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    messageHandlers: Handler[] = [() => undefined];
    ws = {
      readyState: 1,
      // A step 1 from the client: the server answers with its own state vector.
      send: (data: Uint8Array) => {
        const decoder = decoding.createDecoder(data);
        decoding.readVarUint(decoder);
        if (decoding.readVarUint(decoder) === syncProtocol.messageYjsSyncStep1) queueMicrotask(() => this.serverStep1());
      },
    };
    constructor(
      _url: string,
      _room: string,
      private readonly doc: Y.Doc,
    ) {}
    on(event: string, fn: (...args: unknown[]) => void) {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)!.add(fn);
    }
    off(event: string, fn: (...args: unknown[]) => void) {
      this.listeners.get(event)?.delete(fn);
    }
    connect() {
      this.wsconnected = true;
      // The usual exchange: the client's state reaches the server (if it accepts it), the sync completes.
      if (world.accepts) Y.applyUpdate(world.server, Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(world.server)));
      this.synced = true;
      for (const fn of this.listeners.get('sync') ?? []) fn(true);
    }
    serverStep1() {
      const frame = encoding.createEncoder();
      syncProtocol.writeSyncStep1(frame, world.server);
      this.messageHandlers[0](encoding.createEncoder(), decoding.createDecoder(encoding.toUint8Array(frame)), this, true, 0);
    }
    destroy() {}
  }
  return { WebsocketProvider: FakeProvider };
});

const { memoryStore } = await import('./db');
const { dirtyDocsReady, isDocDirty, markDocDirty, resetDirtyDocsForTests } = await import('./dirtyDocs');
const { resetLocalPagesForTests } = await import('./localPages');
const { resetOpenSessionsForTests } = await import('./openSessions');
const { resetConnectivityForTests } = await import('./connectivity');
const { requestSync, resetSyncEngineForTests } = await import('./syncEngine');

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubGlobal('location', { protocol: 'https:', host: 'folio.test' });
  resetOpenSessionsForTests();
  resetLocalPagesForTests(memoryStore<LocalPage>((page) => page.id));
  resetDirtyDocsForTests(memoryStore<DirtyDoc>((doc) => doc.pageId));
  resetSyncEngineForTests();
  resetConnectivityForTests();
  world.server = new Y.Doc();
  world.server.getText('content').insert(0, '# Page\n');
  // The local copy: the server's text plus an edit typed offline.
  const local = new Y.Doc();
  Y.applyUpdate(local, Y.encodeStateAsUpdate(world.server));
  local.getText('content').insert(7, 'typed offline\n');
  world.onDisk = Y.encodeStateAsUpdate(local);
  world.cleared = 0;
  world.destroyed = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function flushOnce(): Promise<void> {
  await dirtyDocsReady();
  markDocDirty('p1', 'doc', 'eng');
  const run = requestSync();
  await vi.advanceTimersByTimeAsync(40_000);
  await run;
}

describe('flushDirtyDoc', () => {
  it('keeps the copy (and the page listed) when the server never took the offline edit', async () => {
    world.accepts = false;
    await flushOnce();
    expect(world.cleared).toBe(0);
    expect(world.destroyed).toBe(1);
    expect(isDocDirty('p1')).toBe(true);
  });

  it('deletes the copy once the server state vector covers it', async () => {
    world.accepts = true;
    await flushOnce();
    expect(world.server.getText('content').toString()).toBe('# Page\ntyped offline\n');
    expect(world.cleared).toBe(1);
    expect(isDocDirty('p1')).toBe(false);
  });
});
