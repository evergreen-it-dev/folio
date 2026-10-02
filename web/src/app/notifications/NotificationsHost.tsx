import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NOTIFICATIONS_QUERY_KEY, addNotificationToCache, useNotifications } from './useNotifications';
import { subscribeNotifications } from './socket';
import { cancelPendingTreeRefreshes, requestAllTreeRefresh, requestTreeRefresh } from '../sidebar/treeLive';

/**
 * Lives once above the route tree — exactly where AssistantHost does
 * (App.tsx, inside AuthProvider): moving between pages and spaces does not
 * unmount this node, so the `/events` socket is not reopened on every
 * navigation, and the counter on the bell does not flash a zero.
 *
 * Draws nothing: the whole visible part is the bell in the header
 * (header/NotificationsBell.tsx), which reads the same cache cell.
 *
 * The same socket also carries the sidebar's live signal: a bare
 * `{ type: 'tree', space }` frame means "the tree of this space changed, fetch
 * it again" (sidebar/treeLive.ts; the server half is server/treeSignal.ts).
 * It is handled here, not in the sidebar, because this is the one place that
 * owns the socket — a second subscriber would open a second connection per tab.
 */
export function NotificationsHost() {
  const queryClient = useQueryClient();
  // One request per application; the bell connects to the same key.
  useNotifications();

  useEffect(() => {
    const controller = new AbortController();
    subscribeNotifications({
      signal: controller.signal,
      // A reopened socket means the feed — and any tree — could have changed during the break.
      onReopen: () => {
        void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
        requestAllTreeRefresh(queryClient);
      },
      onEvent: (event) => {
        if (event.type === 'notification') {
          addNotificationToCache(queryClient, event.item);
          return;
        }
        if (event.type === 'tree') {
          // A frame from a newer server than this bundle, or a malformed one, must not blow up the feed.
          if (typeof event.space === 'string' && event.space) requestTreeRefresh(queryClient, event.space);
          return;
        }
        if (event.type !== 'refresh') return;
        // `refresh` — "something in your feed has changed" (the request was
        // closed by another administrator): there is no row of its own, read anew.
        void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
      },
    });
    return () => {
      controller.abort();
      cancelPendingTreeRefreshes();
    };
  }, [queryClient]);

  return null;
}
