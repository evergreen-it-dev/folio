/**
 * The page's text as it is RIGHT NOW, straight from the collaborative
 * document — for the panels that summarise a page rather than render it.
 *
 * The outline (and the Notes list under it) used to be fed PageContent's
 * `data.markdown`: the last REST fetch. That is correct the moment a page
 * opens and stale from the first keystroke after — type a new heading in Live
 * edit and the outline simply did not know about it until a refetch (owner,
 * 11.09: "the outline is not rebuilt when headings are added").
 *
 * A module-level store rather than React state or a context value, and
 * deliberately so: the publisher is the editor, which re-renders on every
 * keystroke's worth of work already. Holding this in PageContent's state
 * would re-render the whole page — CodeMirror host included — a few times a
 * second while someone types. With a store, a text change re-renders exactly
 * the components that subscribed, which is the outline panel and nothing
 * else. Same reasoning (and same useSyncExternalStore shape) as
 * editor/collab.ts's useDocumentText.
 *
 * Keyed by page id because a store is global: navigating to another page must
 * not show the previous page's text for the frame before the new editor
 * publishes.
 */
import { useCallback, useSyncExternalStore } from 'react';

interface LiveDoc {
  pageId: string;
  text: string;
}

let current: LiveDoc | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Called by the mounted editor with a debounced snapshot of its document. */
export function publishLiveDocText(pageId: string, text: string): void {
  if (current?.pageId === pageId && current.text === text) return;
  current = { pageId, text };
  notify();
}

/** Paired with the publisher on unmount. Identity-checked so a late teardown can't erase the page that already replaced it. */
export function clearLiveDocText(pageId: string): void {
  if (current?.pageId !== pageId) return;
  current = null;
  notify();
}

/**
 * The live text for `pageId`, or null when no editor is mounted for it (a
 * board, a table, reading mode before the collab session connects) — the
 * caller then falls back to whatever it was fed by the server.
 */
export function useLiveDocText(pageId: string | undefined): string | null {
  const snapshot = useCallback(() => (pageId && current?.pageId === pageId ? current.text : null), [pageId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
