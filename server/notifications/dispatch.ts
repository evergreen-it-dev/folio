/**
 * Round 31 — the ONLY place through which a notification reaches a person: a
 * row in `notifications` and a push into the `/events` socket always go
 * together. Routes (routes.ts) and any future sender (an @ mention, a reply
 * in a comment) come here instead of writing the INSERT themselves —
 * otherwise sooner or later there will be a path that creates a row and
 * forgets about the socket, and the feed will start updating "sometimes".
 *
 * The socket here is an accelerator, not the transport: if the person is not
 * online, nothing happened — the row is already in the database and will
 * arrive with the next GET /api/notifications.
 */
import * as store from './store.js';
import * as socket from './socket.js';
import type { NotificationKind } from '../../shared/contracts.js';

/**
 * Creates a row for every recipient and pushes them into the socket at once
 * as already expanded NotificationItem objects — the client does not have to
 * make a request of its own to show a row that has just arrived.
 */
export async function deliver(userIds: string[], kind: NotificationKind, accessRequestId: string): Promise<void> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;

  const inserted = await store.insertNotifications(unique, kind, accessRequestId);
  const items = await store.listNotificationsByIds(inserted.map((n) => n.id));
  const byId = new Map(items.map((item) => [item.id, item]));

  for (const row of inserted) {
    const item = byId.get(row.id);
    if (item) socket.sendToUser(row.userId, { type: 'notification', item });
  }
}

/**
 * "Re-read the feed" — for those whose row has become stale (the request was
 * closed by ANOTHER administrator). They get no new row: sending a person
 * somebody else's decision as an event is noise, but the list must be updated.
 */
export function notifyRefresh(userIds: string[]): void {
  for (const userId of new Set(userIds)) socket.sendToUser(userId, { type: 'refresh' });
}
