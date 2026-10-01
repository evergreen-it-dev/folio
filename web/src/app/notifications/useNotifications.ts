import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { NotificationItem, NotificationListResponse } from '@shared/contracts';
import { api } from '../api';

/**
 * The notification feed (round 31) lives in the react-query cache under one
 * key, not in a separate context: both NotificationsHost (the socket) and the
 * bell in the header read THE SAME cell, so the request happens once per
 * application, and an increment from the socket shows in the panel at once.
 */
export const NOTIFICATIONS_QUERY_KEY = ['notifications'] as const;

/**
 * `refetchOnWindowFocus` is deliberately `true` despite the general `false` in
 * App.tsx: it is the fallback for when the socket was silent (a sleeping
 * laptop, a killed proxy), the same trick already used on the page tree (PageTree.tsx).
 */
export function useNotifications() {
  return useQuery({
    queryKey: NOTIFICATIONS_QUERY_KEY,
    queryFn: api.listNotifications,
    refetchOnWindowFocus: true,
  });
}

/**
 * Adds a row that arrived over the socket WITHOUT refetching the feed. A
 * repeat by `id` is cut off: after a reconnection the same row easily arrives
 * through the re-read too, and a second copy in the list would look like a
 * second request.
 *
 * If the feed is not in the cache yet (the socket was ahead of the first GET),
 * there is nowhere to insert — then the query is just marked stale and reads it itself.
 */
export function addNotificationToCache(queryClient: QueryClient, item: NotificationItem): void {
  const current = queryClient.getQueryData<NotificationListResponse>(NOTIFICATIONS_QUERY_KEY);
  if (!current) {
    void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
    return;
  }
  if (current.items.some((existing) => existing.id === item.id)) return;
  queryClient.setQueryData<NotificationListResponse>(NOTIFICATIONS_QUERY_KEY, {
    items: [item, ...current.items],
    unread: current.unread + (item.readAt ? 0 : 1),
  });
}

/** Clears the counter locally after "mark as read" — so that the badge disappears at once, not after the next GET. */
export function markAllReadInCache(queryClient: QueryClient, readAt: string): void {
  const current = queryClient.getQueryData<NotificationListResponse>(NOTIFICATIONS_QUERY_KEY);
  if (!current) return;
  queryClient.setQueryData<NotificationListResponse>(NOTIFICATIONS_QUERY_KEY, {
    items: current.items.map((item) => (item.readAt ? item : { ...item, readAt })),
    unread: 0,
  });
}
