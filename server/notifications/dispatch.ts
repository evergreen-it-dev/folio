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
import * as authStore from '../auth/store.js';
import * as session from '../auth/session.js';
import * as storage from '../storage.js';
import type { NotificationKind, NotificationPayload, PageNotificationKind } from '../../shared/contracts.js';

/**
 * Creates a row for every recipient and pushes them into the socket at once
 * as already expanded NotificationItem objects — the client does not have to
 * make a request of its own to show a row that has just arrived.
 */
export async function deliver(userIds: string[], kind: NotificationKind, accessRequestId: string): Promise<void> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;

  const inserted = await store.insertNotifications(unique, kind, accessRequestId);
  await push(inserted);
}

async function push(inserted: store.InsertedNotification[]): Promise<void> {
  if (inserted.length === 0) return;
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

/**
 * The ONE entry for notifications about a page (comment mentions and replies
 * now; proposals and review reminders next). Who may be told is decided HERE,
 * at delivery time: a person who cannot read the page (or is disabled, or a
 * system account) gets nothing, so a closed page's existence is not revealed.
 *
 * `payload.commentId`, when present, makes the delivery idempotent per person
 * (unique index in migration 061). Returns the ids of the users who really got
 * a new row.
 */
export async function deliverToPage(userIds: string[], kind: PageNotificationKind, pageId: string, payload: NotificationPayload): Promise<string[]> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return [];
  const entry = await storage.getEntry(pageId);
  if (!entry) return [];

  const allowed: string[] = [];
  for (const id of unique) {
    const user = await authStore.findUserById(id);
    if (!user || user.disabled || session.isSystemUser(user)) continue;
    if (session.roleAtLeast(await session.effectivePageRole(user, entry), 'viewer')) allowed.push(id);
  }

  const inserted = await store.insertPageNotifications(allowed, kind, pageId, { space: entry.space, ...payload, pageTitle: payload.pageTitle || entry.title });
  await push(inserted);
  return inserted.map((row) => row.userId);
}

/**
 * Same as deliverToPage for a notification about something that has no page
 * (yet): a proposal to CREATE a page, or its rejection. The unit of access is the
 * space — a person who may not read it, a disabled account or a system user gets
 * nothing. `payload.proposalId` makes it idempotent (unique index in migration 062).
 */
export async function deliverToSpace(userIds: string[], kind: PageNotificationKind, space: string, payload: NotificationPayload): Promise<string[]> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return [];

  const allowed: string[] = [];
  for (const id of unique) {
    const user = await authStore.findUserById(id);
    if (!user || user.disabled || session.isSystemUser(user)) continue;
    if (session.roleAtLeast(await session.effectiveRole(user, space), 'viewer')) allowed.push(id);
  }

  const inserted = await store.insertPageNotifications(allowed, kind, null, { space, ...payload });
  await push(inserted);
  return inserted.map((row) => row.userId);
}
