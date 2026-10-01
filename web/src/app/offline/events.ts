/**
 * The one signal that crosses from the sync engine to an open editor: "the
 * page you have been editing locally now exists on the server". An open
 * session answers by connecting its socket — nothing else changes for it,
 * the id and the Y.Doc are the ones it already has.
 */
import type { PageMeta } from '@shared/contracts';

type Listener = (meta: PageMeta) => void;

const listeners = new Map<string, Set<Listener>>();
const ANY = '*';

/** `id` of one page, or `'*'` for every page. Returns the unsubscribe. */
export function onLocalPageSynced(id: string, listener: Listener): () => void {
  const set = listeners.get(id) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(id, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(id);
  };
}

export function emitLocalPageSynced(meta: PageMeta): void {
  for (const key of [meta.id, ANY]) {
    for (const listener of [...(listeners.get(key) ?? [])]) {
      try {
        listener(meta);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[offline] local-page-synced listener failed:', error);
      }
    }
  }
}
