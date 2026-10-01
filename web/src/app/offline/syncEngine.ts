/**
 * Brings what was made offline to the server once it can be reached.
 *
 * Two kinds of work, in this order:
 *
 *  1. LOCAL PAGES (localPages.ts) — created here while offline. Each is
 *     created on the server under the id it already has, together with the
 *     Yjs state its editor has been writing (`POST /api/pages` with `id` +
 *     `ydocState`, see shared/contracts.ts). Oldest first, and a child only
 *     after its parent: the parent's real directory is what the child is
 *     created in. Success removes the page from the registry and tells any
 *     open editor to connect (`emitLocalPageSynced`) — same id, same Y.Doc.
 *
 *  2. UNSYNCED SERVER PAGES (dirtyDocs.ts) that nobody has open — flushed
 *     through a headless y-websocket session: load the local copy, connect,
 *     let Yjs merge, delete the local copy.
 *
 * What stops a run and what does not:
 *  - a network failure stops it — the connection is still bad, and the
 *    connectivity probe will start the next run when it is not;
 *  - a 5xx stops it too (the server is there but not well);
 *  - a 4xx is about THAT page (no rights, the space is gone): it is marked
 *    `failed` with the server's reason and the run moves on. Nothing is
 *    deleted — a failed page stays readable and editable on this device.
 */
import { useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import type { PageMeta } from '@shared/contracts';
import { ApiError, api } from '../api';
import { getConnectivity, reportRequest, subscribeConnectivity } from './connectivity';
import { dirtyDocsReady, listDirtyDocs, markDocClean, subscribeDirtyDocs } from './dirtyDocs';
import { emitLocalPageSynced } from './events';
import {
  childDirOfPath,
  getLocalPage,
  listLocalPages,
  localPagesReady,
  removeLocalPage,
  subscribeLocalPages,
  updateLocalPage,
  type LocalPage,
} from './localPages';
import { isSessionOpen } from './openSessions';
import { clearPersistedState, encodeYState, initialLocalState, persistYDoc, readPersistedState } from './ydocPersistence';

export interface SyncStatus {
  running: boolean;
  /** Pages that reached the server in the last finished run. */
  lastSynced: number;
  /** When the last run that synced something finished (ms since epoch). */
  lastSyncedAt: number | null;
}

/** How long a headless flush waits for the room's first sync before giving up for this run. */
const FLUSH_SYNC_TIMEOUT_MS = 15_000;
/** After the first sync: y-websocket has queued our missing updates on the open socket; this is the time they get to leave. */
const FLUSH_SETTLE_MS = 1_500;
/** Retry cadence while something is pending and the connection is not `offline`. */
const RETRY_INTERVAL_MS = 30_000;

let status: SyncStatus = { running: false, lastSynced: 0, lastSyncedAt: null };
const statusListeners = new Set<() => void>();
let queryClient: QueryClient | null = null;
let inFlight: Promise<void> | null = null;
let again = false;

function setStatus(patch: Partial<SyncStatus>): void {
  status = { ...status, ...patch };
  for (const listener of [...statusListeners]) listener();
}

export function getSyncStatus(): SyncStatus {
  return status;
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    getSyncStatus,
    getSyncStatus,
  );
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

/** A refusal that retrying cannot fix. 408/429 are the two 4xx that are about timing, not about the request. */
function isPermanent(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}

type Outcome = 'synced' | 'blocked' | 'failed' | 'stop';

async function syncLocalPage(page: LocalPage): Promise<Outcome> {
  if (page.parentId && getLocalPage(page.parentId)) return 'blocked';
  await updateLocalPage(page.id, { state: 'syncing', error: undefined });
  let meta: PageMeta;
  try {
    const state = (await readPersistedState(page.id)) ?? initialLocalState(page);
    meta = await api.createPage({
      id: page.id,
      space: page.space,
      parentPath: page.parentPath,
      title: page.title,
      kind: page.kind,
      ydocState: encodeYState(state),
    });
  } catch (error) {
    if (isPermanent(error)) {
      await updateLocalPage(page.id, { state: 'failed', error: error.message, attempts: page.attempts + 1 });
      return 'failed';
    }
    await updateLocalPage(page.id, { state: 'pending', attempts: page.attempts + 1 });
    if (isNetworkError(error)) reportRequest(false);
    return 'stop';
  }

  // Children were waiting for this: the directory they belong in is the
  // parent's REAL one, which only exists as of this response.
  const realDir = childDirOfPath(meta.path, page.kind);
  for (const child of listLocalPages(page.space)) {
    if (child.parentId === page.id) await updateLocalPage(child.id, { parentPath: realDir, parentId: undefined });
  }
  await removeLocalPage(page.id);
  // Nobody has the page open: the server now holds exactly what was on disk,
  // and the copy has done its job. (An open session keeps using its copy and
  // deletes it itself, once it has synced — collabOffline.ts.) Left behind,
  // it would be one more stale copy waiting to be merged into a page whose
  // history has since moved on.
  if (!isSessionOpen(page.id)) await clearPersistedState(page.id);
  if (queryClient) {
    queryClient.setQueryData(['page', meta.id], (old: unknown) => ({ ...(old as object | undefined), ...meta }));
    void queryClient.invalidateQueries({ queryKey: ['tree', meta.space] });
    void queryClient.invalidateQueries({ queryKey: ['page', meta.id] });
  }
  emitLocalPageSynced(meta);
  return 'synced';
}

function collabUrl(): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`;
}

/** Load the local copy, connect, wait for the merge, delete the local copy. `false` = not this time. */
async function flushDirtyDoc(pageId: string): Promise<boolean> {
  const doc = new Y.Doc();
  const persistence = persistYDoc(pageId, doc);
  await persistence.whenLoaded;
  const provider = new WebsocketProvider(collabUrl(), pageId, doc, { connect: false });
  try {
    const synced = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), FLUSH_SYNC_TIMEOUT_MS);
      provider.on('sync', (value: boolean) => {
        if (!value) return;
        clearTimeout(timeout);
        resolve(true);
      });
    });
    provider.connect();
    if (!(await synced)) {
      persistence.destroy();
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, FLUSH_SETTLE_MS));
    if (!provider.wsconnected) {
      persistence.destroy();
      return false;
    }
    await persistence.clear();
    markDocClean(pageId);
    return true;
  } finally {
    provider.destroy();
    doc.destroy();
  }
}

async function run(): Promise<void> {
  await Promise.all([localPagesReady(), dirtyDocsReady()]);
  let synced = 0;

  // Passes until nothing moves: a child becomes syncable in the pass after
  // its parent's. Failed pages are left for an explicit retry.
  for (let progressed = true; progressed; ) {
    progressed = false;
    for (const { id } of listLocalPages()) {
      // Re-read by id: the list is a snapshot from the start of the pass, and
      // a parent synced earlier in it has just rewritten its children.
      const page = getLocalPage(id);
      if (!page || page.state === 'failed') continue;
      const outcome = await syncLocalPage(page);
      if (outcome === 'stop') return finish(synced);
      if (outcome === 'synced') {
        synced += 1;
        progressed = true;
      }
    }
  }

  for (const dirty of listDirtyDocs()) {
    if (isSessionOpen(dirty.pageId)) continue;
    try {
      if (await flushDirtyDoc(dirty.pageId)) synced += 1;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`[offline] could not flush unsynced page ${dirty.pageId}:`, error);
    }
  }
  finish(synced);
}

function finish(synced: number): void {
  if (synced > 0) setStatus({ lastSynced: synced, lastSyncedAt: Date.now() });
}

/**
 * Starts a run unless the connection is `offline`. A request that arrives
 * mid-run is not dropped: one more run follows the current one, which is
 * what picks up a page created while the first was already past it.
 */
export function requestSync(): Promise<void> {
  if (getConnectivity() === 'offline') return Promise.resolve();
  if (inFlight) {
    again = true;
    return inFlight;
  }
  setStatus({ running: true });
  inFlight = run()
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error('[offline] sync run failed:', error);
    })
    .finally(() => {
      inFlight = null;
      setStatus({ running: false });
      if (again) {
        again = false;
        void requestSync();
      }
    });
  return inFlight;
}

/** Puts a `failed` page back in the queue — the author fixed what the server objected to (or wants to try anyway). */
export async function retryLocalPage(id: string): Promise<void> {
  await updateLocalPage(id, { state: 'pending', error: undefined });
  await requestSync();
}

/** How many things on this device the server has not seen yet. */
export function pendingCount(): number {
  return listLocalPages().length + listDirtyDocs().length;
}

export function usePendingCount(): number {
  return useSyncExternalStore(
    (listener) => {
      const offPages = subscribeLocalPages(listener);
      const offDirty = subscribeDirtyDocs(listener);
      return () => {
        offPages();
        offDirty();
      };
    },
    pendingCount,
    () => 0,
  );
}

/** Wires the engine to the connectivity store and a retry timer. Idempotent per client; returns the stop function. */
export function startSyncEngine(client: QueryClient): () => void {
  queryClient = client;
  let last = getConnectivity();
  const off = subscribeConnectivity(() => {
    const now = getConnectivity();
    if (last === 'offline' && now !== 'offline') void requestSync();
    last = now;
  });
  const retry = setInterval(() => {
    if (pendingCount() > 0) void requestSync();
  }, RETRY_INTERVAL_MS);
  // Whatever a previous session of this browser left behind.
  void Promise.all([localPagesReady(), dirtyDocsReady()]).then(() => {
    if (pendingCount() > 0) void requestSync();
  });
  return () => {
    off();
    clearInterval(retry);
    if (queryClient === client) queryClient = null;
  };
}

/** Tests only. */
export function resetSyncEngineForTests(): void {
  status = { running: false, lastSynced: 0, lastSyncedAt: null };
  inFlight = null;
  again = false;
  queryClient = null;
}
