import type { QueryClient } from '@tanstack/react-query';

/**
 * The client half of the live "tree changed" signal (server/treeSignal.ts
 * explains the whole mechanism). The server sends a bare
 * `{ type: 'tree', space, v }` frame over the `/events` socket that
 * NotificationsHost already keeps open; this file turns it into a refetch of
 * the `['tree', space]` query — the same cache entry the sidebar, breadcrumbs,
 * starred list, quick switcher and move/copy dialogs share, so they all catch
 * up from one request.
 *
 * Why it is `invalidateQueries` and not "put the data in the cache":
 *  - the frame carries no data on purpose (no title/path/id may leak to a
 *    reader who cannot see a page); the refetch goes through
 *    GET /api/spaces/:space/tree, which filters by page access;
 *  - invalidation refetches only queries somebody is looking at and merely
 *    marks the rest stale, so a space the user visited earlier costs nothing
 *    until it is shown again;
 *  - react-query keeps structural sharing: a refetch that returns the same
 *    tree changes no object identity, so the tab that made the change (it has
 *    already invalidated locally) re-renders nothing and does not flicker.
 *    Rows keep their React identity (keyed by page id), so a row being renamed,
 *    a drag in progress and the expanded/collapsed state — all component or
 *    localStorage state, never part of the query — are untouched.
 *
 * The delay: a random 0..TREE_REFRESH_JITTER_MS wait before the refetch, and
 * signals for one space that arrive meanwhile join the same wait. The server
 * already coalesces, but it sends the SAME frame to every tab of every member
 * at once (and every tab at once after a reconnect); without a spread, a busy
 * instance would answer all of those tree requests in the same few
 * milliseconds. 250 ms is the whole budget on this side: the server's quiet
 * window is up to 1.2 s, and a change must be on screen ~2 s after it was made.
 *
 * Nothing here keeps count or remembers what came before: no ordering by the
 * frame's counter `v` (it restarts with the server process, and every frame is a
 * reason to refetch anyway), no "already handled" set. A signal is one wait that
 * ends in one invalidation, so the hundredth signal of a long session behaves
 * exactly like the first (treeLive.test.ts runs three hundred).
 */
export const TREE_REFRESH_JITTER_MS = 250;

/** Waits that have not fired yet, per client. An entry exists only while it has a wait, so nothing is retained afterwards. */
const pendingByClient = new Map<QueryClient, Map<string, ReturnType<typeof setTimeout>>>();

/** Refetch the tree of `space` soon (not now), once, however many signals arrive in the meantime. */
export function requestTreeRefresh(queryClient: QueryClient, space: string): void {
  let pending = pendingByClient.get(queryClient);
  if (!pending) {
    pending = new Map();
    pendingByClient.set(queryClient, pending);
  }
  const waits = pending;
  if (waits.has(space)) return;
  waits.set(
    space,
    setTimeout(() => {
      waits.delete(space);
      if (waits.size === 0) pendingByClient.delete(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['tree', space] });
    }, Math.random() * TREE_REFRESH_JITTER_MS),
  );
}

/**
 * The socket came back after a break: anything may have changed in any space
 * while nobody was listening. Every cached tree becomes stale at once (so it is
 * refetched the next time it is shown), and the ones with a mounted observer
 * are refetched after the usual spread — once each, not once per signal.
 */
export function requestAllTreeRefresh(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['tree'], refetchType: 'none' });
  for (const query of queryClient.getQueryCache().findAll({ queryKey: ['tree'], type: 'active' })) {
    const space = query.queryKey[1];
    if (typeof space === 'string') requestTreeRefresh(queryClient, space);
  }
}

/** Forget every wait that has not fired yet — the host unmounting, and tests. */
export function cancelPendingTreeRefreshes(): void {
  for (const waits of pendingByClient.values()) for (const timer of waits.values()) clearTimeout(timer);
  pendingByClient.clear();
}
