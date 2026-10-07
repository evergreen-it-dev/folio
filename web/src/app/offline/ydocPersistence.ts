/**
 * A page's Y.Doc on disk, through y-indexeddb — one IndexedDB database per
 * page, holding the document's full Yjs state.
 *
 * What is kept, and for how long (deliberately NOT "everything, forever"):
 *  - a page created offline: from creation until it exists on the server
 *    and an open session has synced with it;
 *  - a server page: while a session is open, and after it closes ONLY if it
 *    closed with edits the server had not confirmed.
 * A copy that outlives its sync is a liability, not a cache: the day the
 * server's copy of that page gets a new CRDT history, a stale local one
 * merges into it as a second, unrelated document and the page doubles.
 * `clear()` after a confirmed sync keeps that window as small as it can be.
 *
 * No IndexedDB (jsdom, a locked-down private window): every function here
 * degrades to a no-op and `whenLoaded` resolves at once — the editor works
 * exactly as it did before offline mode existed.
 */
import { IndexeddbPersistence, clearDocument } from 'y-indexeddb';
import * as Y from 'yjs';
import { hasIndexedDb } from './db';
import type { LocalPage } from './localPages';

export function yPersistName(pageId: string): string {
  return `folio-y-${pageId}`;
}

export interface YDocPersistence {
  /** Resolves once whatever was on disk has been applied to the doc. Never rejects. */
  whenLoaded: Promise<void>;
  /** Stop persisting and delete the on-disk copy — the server has everything. */
  clear(): Promise<void>;
  /** Stop persisting, keep the on-disk copy for next time. */
  destroy(): void;
}

const NOOP: YDocPersistence = {
  whenLoaded: Promise.resolve(),
  clear: async () => undefined,
  destroy: () => undefined,
};

/** How many times one session reopens its database after losing the connection, before it gives up on local storage. */
export const MAX_REOPENS = 5;

interface StoreUpdateInternals {
  _storeUpdate: (update: Uint8Array, origin: unknown) => void;
}

export function persistYDoc(pageId: string, doc: Y.Doc): YDocPersistence {
  if (!hasIndexedDb()) return NOOP;
  let persistence: IndexeddbPersistence;
  let done = false;
  let reopens = 0;

  /**
   * y-indexeddb writes every update from inside the doc's own 'update' event,
   * and throws there when its connection is gone: another tab deleting this
   * page's database (its session closed after syncing — collabOffline.ts)
   * makes lib0 close every other connection to it, and Safari drops idle
   * connections on its own. An exception in that event escapes the
   * transaction that caused it — the editor's sync binding among them — and
   * was how typed text stopped reaching the document at all (06.10.2026,
   * editor/collab-sync.ts). So the write is guarded, and a lost connection is
   * replaced: a fresh IndexeddbPersistence stores the doc's whole current
   * state as soon as it opens, the update that failed included.
   */
  const guard = (instance: IndexeddbPersistence): void => {
    const internals = instance as unknown as StoreUpdateInternals;
    const store = internals._storeUpdate;
    doc.off('update', store);
    const safeStore = (update: Uint8Array, origin: unknown) => {
      try {
        store(update, origin);
      } catch (error) {
        replace(instance, error);
      }
    };
    // y-indexeddb's destroy() unregisters whatever this property holds.
    internals._storeUpdate = safeStore;
    doc.on('update', safeStore);
  };

  const open = (): IndexeddbPersistence => {
    const instance = new IndexeddbPersistence(yPersistName(pageId), doc);
    guard(instance);
    return instance;
  };

  const replace = (broken: IndexeddbPersistence, error: unknown): void => {
    if (broken !== persistence || done) return;
    // eslint-disable-next-line no-console
    console.warn(`[offline] lost the local copy's connection for page ${pageId}; reopening:`, error);
    void broken.destroy().catch(() => undefined);
    if (reopens >= MAX_REOPENS) {
      done = true;
      // Editing goes on (the server copy is unaffected), but nothing more is
      // kept in this browser for this page while the session lasts.
      // eslint-disable-next-line no-console
      console.error(`[offline] gave up keeping a local copy of page ${pageId} after ${MAX_REOPENS} reopen attempts; edits now rely on the server alone`);
      return;
    }
    reopens += 1;
    try {
      persistence = open();
    } catch (reopenError) {
      done = true;
      // eslint-disable-next-line no-console
      console.warn(`[offline] could not reopen local storage for page ${pageId}:`, reopenError);
    }
  };

  try {
    persistence = open();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[offline] could not open local storage for page ${pageId}:`, error);
    return NOOP;
  }
  const whenLoaded = persistence.whenSynced.then(
    () => undefined,
    (error) => {
      // eslint-disable-next-line no-console
      console.warn(`[offline] could not read the local copy of page ${pageId}:`, error);
    },
  );
  return {
    whenLoaded,
    clear: async () => {
      if (done) return;
      done = true;
      try {
        await persistence.clearData();
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(`[offline] could not delete the local copy of page ${pageId}:`, error);
      }
    },
    destroy: () => {
      if (done) return;
      done = true;
      void persistence.destroy();
    },
  };
}

/**
 * The on-disk Yjs state of a page nobody has open, as one merged update —
 * what the sync engine sends as `ydocState`. `null` when there is nothing
 * stored (or nowhere to store it).
 */
export async function readPersistedState(pageId: string): Promise<Uint8Array | null> {
  if (!hasIndexedDb()) return null;
  const doc = new Y.Doc();
  const persistence = persistYDoc(pageId, doc);
  try {
    await persistence.whenLoaded;
    const state = Y.encodeStateAsUpdate(doc);
    // An empty document still encodes to a couple of bytes; "nothing stored"
    // is a doc with no structs and no deletions at all.
    const empty = Y.encodeStateVector(doc).length <= 1 && doc.share.size === 0;
    return empty ? null : state;
  } finally {
    persistence.destroy();
    doc.destroy();
  }
}

export async function clearPersistedState(pageId: string): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await clearDocument(yPersistName(pageId));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[offline] could not delete the local copy of page ${pageId}:`, error);
  }
}

/** The very first state of a page made offline: a document opens with its title as the H1, a board opens blank. */
export function initialLocalState(page: Pick<LocalPage, 'kind' | 'title'>): Uint8Array {
  const doc = new Y.Doc();
  if (page.kind === 'doc') doc.getText('content').insert(0, `# ${page.title}\n\n`);
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

/**
 * Writes `initialLocalState` to disk at CREATION time, so the page's CRDT
 * history starts exactly once — every session that opens it afterwards
 * loads this and continues it, never seeds a second one of its own.
 */
export async function seedLocalPage(page: Pick<LocalPage, 'id' | 'kind' | 'title'>): Promise<void> {
  if (!hasIndexedDb()) return;
  const doc = new Y.Doc();
  const persistence = persistYDoc(page.id, doc);
  try {
    await persistence.whenLoaded;
    if (page.kind === 'doc' && doc.getText('content').length === 0) {
      Y.applyUpdate(doc, initialLocalState(page));
      // y-indexeddb writes on the doc's own 'update' event, asynchronously;
      // one turn of the event loop is what lets that write start before the
      // persistence is torn down below.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    persistence.destroy();
    doc.destroy();
  }
}

/** Base64 for `CreatePageBody.ydocState` — chunked, because `String.fromCharCode(...bytes)` overflows the stack on a large board. */
export function encodeYState(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
