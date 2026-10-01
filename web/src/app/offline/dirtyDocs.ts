/**
 * Server pages that hold edits the server has not seen: typed while the
 * socket was down, kept in the page's y-indexeddb database.
 *
 * An OPEN page needs no bookkeeping — its own session syncs the moment the
 * socket is back. This list is for the other case: the tab was closed (or
 * the page navigated away from) while still offline. Nobody may ever open
 * that page again, so the sync engine walks this list when the network
 * returns and flushes each one through a headless session.
 *
 * Marked by a session on its first local edit made while disconnected,
 * cleared by whoever confirms the sync (the session itself, or the engine).
 */
import { useSyncExternalStore } from 'react';
import { openStore, type KeyValueStore } from './db';

export type DirtyKind = 'doc' | 'board';

export interface DirtyDoc {
  pageId: string;
  kind: DirtyKind;
  space: string;
  since: string;
}

let store: KeyValueStore<DirtyDoc> = openStore<DirtyDoc>('dirty', (doc) => doc.pageId);
const docs = new Map<string, DirtyDoc>();
const listeners = new Set<() => void>();
let snapshot: readonly DirtyDoc[] = [];
let ready: Promise<void> | null = null;

function publish(): void {
  snapshot = [...docs.values()];
  for (const listener of [...listeners]) listener();
}

export function dirtyDocsReady(): Promise<void> {
  ready ??= store
    .getAll()
    .then((stored) => {
      for (const doc of stored) docs.set(doc.pageId, doc);
      publish();
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.warn('[offline] could not read the unsynced-pages list:', error);
    });
  return ready;
}

export function isDocDirty(pageId: string): boolean {
  return docs.has(pageId);
}

export function listDirtyDocs(): readonly DirtyDoc[] {
  return snapshot;
}

/** Idempotent and cheap: a session calls this on every local update made while disconnected. */
export function markDocDirty(pageId: string, kind: DirtyKind, space: string): void {
  if (docs.has(pageId)) return;
  const doc: DirtyDoc = { pageId, kind, space, since: new Date().toISOString() };
  docs.set(pageId, doc);
  publish();
  void store.put(doc);
}

export function markDocClean(pageId: string): void {
  if (!docs.delete(pageId)) return;
  publish();
  void store.delete(pageId);
}

export function subscribeDirtyDocs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDirtyDocs(): readonly DirtyDoc[] {
  return useSyncExternalStore(
    subscribeDirtyDocs,
    () => snapshot,
    () => snapshot,
  );
}

/** Tests only. */
export function resetDirtyDocsForTests(next?: KeyValueStore<DirtyDoc>): void {
  store = next ?? openStore<DirtyDoc>('dirty', (doc) => doc.pageId);
  docs.clear();
  ready = null;
  publish();
}
