/**
 * The offline half of a collab session — everything a page's Y.Doc needs
 * besides the socket, shared by the document editor (editor/collab.ts) and
 * the board (diagrams/boardCollab.ts).
 *
 * Lives in app/ for the same reason collabIdentity.ts does: diagrams/ may not
 * import from editor/ (editor/ already imports diagrams/), while both may
 * import app/. It is one module, not two copies, because the rules below are
 * subtle enough that two drifting copies would be a data-loss bug:
 *
 *  - The Y.Doc is kept on disk (y-indexeddb) for as long as the session is
 *    open, so an edit typed while the socket is down survives closing the
 *    tab. On the next visit the leftover is applied to the doc BEFORE the
 *    socket opens, and y-websocket's ordinary sync then delivers it.
 *  - A page created offline ("local page", app/offline/localPages.ts) has no
 *    room on the server yet. Its provider is created disconnected and stays
 *    that way until `onLocalPageSynced` fires — then the SAME provider and
 *    doc connect, and the user, who has been typing the whole time, notices
 *    nothing.
 *  - A server page edited while disconnected is recorded in the dirty list
 *    (app/offline/dirtyDocs.ts), so that a tab closed in that state does not
 *    leave the edit stranded: the sync engine flushes such pages headlessly.
 *
 * The provider MUST be created with `connect: false`; this module opens it.
 * A share-link session does not use this module at all: a guest's browser is
 * not the place to keep a copy of someone else's page.
 */
import { IndexeddbPersistence } from 'y-indexeddb';
import type { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import {
  clearPersistedState,
  dirtyDocsReady,
  getLocalPage,
  initialLocalState,
  isLocalPageId,
  markDocClean,
  markDocDirty,
  onLocalPageSynced,
  persistYDoc,
  type DirtyKind,
  type YDocPersistence,
  registerOpenSession,
  isDocDirty,
} from './offline';
import { hasIndexedDb } from './offline/db';
import { trackServerAck, type ServerAck } from './collabAck';

/**
 * How long a SERVER page's socket waits for the on-disk copy to load. Reading
 * it is normally a few milliseconds; the bound only exists so that a wedged
 * IndexedDB (another tab holding an upgrade, a browser that never answers)
 * can never keep a page from opening — the socket just goes ahead without it.
 * The leftover still merges in whenever it arrives: it is applied through the
 * same doc, so the provider ships it like any other local update.
 */
export const PERSISTENCE_WAIT_MS = 1_500;

export interface OfflineSessionOptions {
  pageId: string;
  kind: DirtyKind;
  doc: Y.Doc;
  /** Created with `connect: false` — this module decides when the socket opens. */
  provider: WebsocketProvider;
  /**
   * The page's space, read at the moment an offline edit is recorded rather
   * than captured now: a board only learns it from its metadata fetch, which
   * lands after the session is already open. `undefined` = not known (yet),
   * and the edit is then simply not recorded.
   */
  getSpace: () => string | undefined;
  /**
   * The session's server-acknowledgement tracker (app/collabAck.ts), when the
   * caller already has one; otherwise this module makes its own and disposes
   * it with the session.
   */
  ack?: ServerAck;
}

export interface OfflineSession {
  /**
   * The page was a local page when this session opened (fixed for the
   * session's life). A hook that reports "synced" uses it: a page that has
   * only ever existed in this browser has nothing to sync with, and must not
   * flicker back to "loading" the moment its socket first connects.
   */
  readonly startedLocal: boolean;
  /**
   * Resolves once the doc holds whatever was on disk and — for a server
   * page — the socket has been asked to connect. Never rejects. A hook shows
   * the session only after this: an editor must never render (or type into)
   * a local page's empty doc while its real content is still loading.
   */
  readonly ready: Promise<void>;
  /**
   * Tear down. Call it BEFORE `provider.destroy()`: it decides between
   * "delete the on-disk copy" and "keep it" from the provider's state, which
   * destroying the provider resets.
   */
  dispose(): void;
}

/**
 * Deletes still in flight, by page. Opening a page's database while a delete
 * of it is pending is not merely slow: the delete's `versionchange` makes
 * y-indexeddb (through lib0) CLOSE the new connection, and every later write
 * from that session then throws inside the doc's own update handler. A
 * session for the same page — page → other page → back again, faster than
 * a delete takes — therefore waits its turn.
 */
const clearing = new Map<string, Promise<void>>();

function clearOnDisk(pageId: string, persistence: YDocPersistence): void {
  // `clear()` resolves once the connection is closed, not once the database
  // is gone (y-indexeddb does not return its own deleteDatabase promise), so
  // a second, awaited delete queues behind it and marks the real end.
  const done: Promise<void> = persistence
    .clear()
    .then(() => clearPersistedState(pageId))
    .then(() => {
      if (clearing.get(pageId) === done) clearing.delete(pageId);
    });
  clearing.set(pageId, done);
}

/** Resolves when `promise` does, or after `ms` — whichever comes first. */
function boundedWait(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Removes a page from the dirty list once that list has been read from storage (an earlier answer would be overwritten by it). */
function cleanWhenReady(pageId: string, stillWanted: () => boolean): void {
  void dirtyDocsReady().then(() => {
    if (stillWanted()) markDocClean(pageId);
  });
}

export function attachOfflineSession({ pageId, kind, doc, provider, getSpace, ack: givenAck }: OfflineSessionOptions): OfflineSession {
  // `synced` is not "the server has it": y-websocket never acknowledges an
  // edit, so a dead socket or a read-only connection keeps reading as synced
  // while what was typed goes nowhere. Only the server's own state vector
  // covering this doc is (06.10.2026).
  const ack = givenAck ?? trackServerAck(provider, doc);
  // Read ONCE. The registry entry disappears the moment the page reaches the
  // server, and nothing about this session may tear down because of that.
  const startedLocal = isLocalPageId(pageId);
  let local = startedLocal;
  let disposed = false;
  let persistence: YDocPersistence | null = null;
  /** The user changed something in this session — connected or not. */
  let edited = false;
  /** Listed as unsynced BEFORE this session opened: the disk may hold a previous session's edits. */
  const dirtyAtOpen = isDocDirty(pageId);
  // The sync engine flushes unsynced pages nobody has open through a session
  // of its own, and deletes their on-disk copy when done. This page is open:
  // it syncs itself, and its copy is in use (offline/openSessions.ts).
  const releaseOpen = registerOpenSession(pageId);

  /**
   * Any update that did not come from the socket (`provider`) or from the
   * disk load (the IndexeddbPersistence instance is its origin) is the
   * user's — typing, undo, the title repair. A LOCAL page is deliberately
   * not recorded: it is not a server page with unsynced edits, it is a page
   * the server does not have at all, and the local-pages registry already
   * makes sure it gets created (with these edits inside it).
   */
  const onUpdate = (_update: Uint8Array, origin: unknown): void => {
    if (origin === provider || origin instanceof IndexeddbPersistence) return;
    // Counted whatever the socket says: a connection that died silently still
    // reads as connected for up to half a minute, and what was typed into it
    // went nowhere (see `dispose`).
    edited = true;
    if (local || provider.wsconnected) return;
    const space = getSpace();
    if (space) markDocDirty(pageId, kind, space);
  };
  doc.on('update', onUpdate);

  /** Connected and CONFIRMED: the server has everything this tab has — the edits are no longer at risk. */
  const serverHasAll = (): boolean => provider.wsconnected && provider.synced && ack.isConfirmed();
  const onConfirmed = (): void => {
    if (!serverHasAll()) return;
    cleanWhenReady(pageId, () => !disposed && serverHasAll());
  };
  provider.on('sync', onConfirmed);
  const offAck = ack.subscribe(onConfirmed);

  let loaded = false;
  // The server has created the page: this is a server page from now on. The
  // socket opens on the provider the user is already typing into. Before the
  // disk load has finished, `ready` below opens it instead (it looks at `local`).
  const unsubscribe = startedLocal
    ? onLocalPageSynced(pageId, () => {
        local = false;
        if (loaded && !disposed) provider.connect();
      })
    : () => undefined;

  const ready = (async () => {
    await clearing.get(pageId);
    if (disposed) return;
    persistence = persistYDoc(pageId, doc);
    // A local page waits for the disk without a bound: its content exists
    // nowhere else, so showing it early would show an empty page. A server
    // page's content is on the server — the disk only holds leftovers.
    await (startedLocal ? persistence.whenLoaded : boundedWait(persistence.whenLoaded, PERSISTENCE_WAIT_MS));
    if (disposed) return;
    if (startedLocal && kind === 'doc' && !hasIndexedDb()) seedInMemory();
    loaded = true;
    if (!local) provider.connect();
  })();

  /**
   * The one place a local page's starter text may be written outside
   * `seedLocalPage`: a browser with no IndexedDB at all (a private window
   * that refuses it) never had the seed to load, and the alternative is an
   * empty page under a title the sidebar already shows.
   */
  function seedInMemory(): void {
    const text = doc.getText('content');
    const page = getLocalPage(pageId);
    if (text.length === 0 && page) Y.applyUpdate(doc, initialLocalState(page));
  }

  return {
    startedLocal,
    ready,
    dispose() {
      if (disposed) return;
      disposed = true;
      doc.off('update', onUpdate);
      provider.off('sync', onConfirmed);
      offAck();
      unsubscribe();
      releaseOpen();
      const syncedNow = serverHasAll();
      if (!givenAck) ack.dispose();
      if (!persistence) return;
      // Connected and confirmed at this very moment (collabAck.ts — the server's
      // own state vector covers this doc), and not a local page: the
      // server holds everything, and a copy left behind is worse than none —
      // the day the server's history of this page is rebuilt, a stale copy
      // merges into it as a second, unrelated document (ydocPersistence.ts).
      // Anything else — never connected, dropped, still syncing, a local page
      // the server has not seen — may hold the only copy of an edit.
      //
      // One more case is safe to clear: a server page that was only LOOKED at
      // — nothing changed in this session, nothing left from an earlier one.
      // Its copy holds nothing the server lacks, and keeping it would leave a
      // stale copy behind for every page read on a train.
      //
      // And one case needs MORE than keeping: edits made in this session that
      // the server has not confirmed. They may have been typed into a socket
      // that was already dead (it reads as connected until its timeout), so
      // they were never listed as unsynced. Listing them now is what lets the
      // sync engine deliver them even if this page is never opened again.
      const nothingToLose = !edited && !dirtyAtOpen && !isDocDirty(pageId);
      if (local) {
        persistence.destroy();
      } else if (syncedNow) {
        cleanWhenReady(pageId, () => true);
        clearOnDisk(pageId, persistence);
      } else if (nothingToLose) {
        clearOnDisk(pageId, persistence);
      } else {
        if (edited) markDocDirty(pageId, kind, getSpace() ?? '');
        persistence.destroy();
      }
    },
  };
}
