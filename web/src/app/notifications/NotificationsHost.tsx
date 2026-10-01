import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NOTIFICATIONS_QUERY_KEY, addNotificationToCache, useNotifications } from './useNotifications';
import { subscribeNotifications } from './socket';

/**
 * Lives once above the route tree — exactly where AssistantHost does
 * (App.tsx, inside AuthProvider): moving between pages and spaces does not
 * unmount this node, so the `/events` socket is not reopened on every
 * navigation, and the counter on the bell does not flash a zero.
 *
 * Draws nothing: the whole visible part is the bell in the header
 * (header/NotificationsBell.tsx), which reads the same cache cell.
 */
export function NotificationsHost() {
  const queryClient = useQueryClient();
  // One request per application; the bell connects to the same key.
  useNotifications();

  useEffect(() => {
    const controller = new AbortController();
    subscribeNotifications({
      signal: controller.signal,
      // A reopened socket means the feed could have changed during the break.
      onReopen: () => void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY }),
      onEvent: (event) => {
        if (event.type === 'notification') {
          addNotificationToCache(queryClient, event.item);
          return;
        }
        // `refresh` — "something in your feed has changed" (the request was
        // closed by another administrator): there is no row of its own, read anew.
        void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
      },
    });
    return () => controller.abort();
  }, [queryClient]);

  return null;
}
