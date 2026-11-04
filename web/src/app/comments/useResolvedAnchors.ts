import { useEffect, useMemo, useState } from 'react';
import { debounce } from '../../editor/debounce';
import { resolveThreads, sameResolution, type AnchoredThread, type ResolvedAnchor } from '../../editor/comment-anchors';
import type { CollabSession } from '../../editor/collab';

/** After typing stops, so a burst of keystrokes resolves once. Between resolutions the editor maps the ranges itself. */
const RESOLVE_DEBOUNCE_MS = 150;

/**
 * Where each thread sits in the live document now, by id. Re-resolved whenever
 * the Y.Text changes or the threads do. Empty until `ready` (the first sync):
 * resolving against a document that has not arrived yet would call every
 * thread detached.
 */
export function useResolvedAnchors(session: CollabSession | null, threads: readonly AnchoredThread[], ready: boolean): ReadonlyMap<string, ResolvedAnchor> {
  const [resolved, setResolved] = useState<readonly ResolvedAnchor[]>([]);
  useEffect(() => {
    if (!session || !ready || threads.length === 0) {
      setResolved((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const run = () => setResolved((prev) => {
      const next = resolveThreads(session.doc, session.ytext, threads);
      return sameResolution(prev, next) ? prev : next;
    });
    run();
    const later = debounce(run, RESOLVE_DEBOUNCE_MS);
    session.ytext.observe(later);
    return () => {
      session.ytext.unobserve(later);
      later.cancel();
    };
  }, [session, ready, threads]);
  return useMemo(() => new Map(resolved.map((r) => [r.id, r])), [resolved]);
}
