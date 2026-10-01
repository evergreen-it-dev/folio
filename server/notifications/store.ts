/**
 * Round 31 (notifications) — all the SQL of access requests and of the
 * notification feed. Routes (routes.ts) and delivery (dispatch.ts) do not
 * write queries themselves: this is the only place that knows about the
 * columns of access_requests/notifications, just as server/auth/store.ts
 * holds all the SQL of access.
 *
 * A feed row comes back already expanded into AccessRequestSummary
 * (shared/contracts.ts): the client needs the name of the space and of the
 * requester, and fetching them with separate requests per row is N+1 for nothing.
 */
import { query, queryOne } from '../db/pool.js';
import type { AccessRequestStatus, AccessRequestSummary, NotificationItem, NotificationKind, SpaceRole } from '../../shared/contracts.js';

/** How many feed rows are returned at a time: a feed is "what happened recently", not an archive. */
export const NOTIFICATION_LIMIT = 50;

export interface AccessRequestRow {
  id: string;
  space_slug: string;
  requester_user_id: string;
  status: AccessRequestStatus;
  granted_role: SpaceRole | null;
  decided_by_user_id: string | null;
  created_at: Date;
  decided_at: Date | null;
}

/**
 * One source of truth for the shape of a request: both the feed and the
 * route's answer show the same object, so the columns and joins are described
 * once, and the two queries below only add their own to them.
 */
const SUMMARY_COLUMNS = `ar.id,
         ar.space_slug,
         ar.status,
         ar.granted_role,
         ar.created_at,
         ar.decided_at,
         s.name       AS space_name,
         req.id       AS requester_id,
         req.name     AS requester_name,
         req.username AS requester_username,
         dec.id       AS decider_id,
         dec.name     AS decider_name,
         dec.username AS decider_username`;

const SUMMARY_JOINS = `JOIN spaces s ON s.slug = ar.space_slug
    JOIN users req ON req.id = ar.requester_user_id
    LEFT JOIN users dec ON dec.id = ar.decided_by_user_id`;

const SUMMARY_SELECT = `SELECT ${SUMMARY_COLUMNS}
    FROM access_requests ar
    ${SUMMARY_JOINS}`;

interface SummaryRow {
  id: string;
  space_slug: string;
  status: AccessRequestStatus;
  granted_role: SpaceRole | null;
  created_at: Date;
  decided_at: Date | null;
  space_name: string;
  requester_id: string;
  requester_name: string;
  requester_username: string | null;
  decider_id: string | null;
  decider_name: string | null;
  decider_username: string | null;
}

function toSummary(row: SummaryRow): AccessRequestSummary {
  return {
    id: row.id,
    space: row.space_slug,
    spaceName: row.space_name,
    requester: { id: row.requester_id, name: row.requester_name, username: row.requester_username },
    status: row.status,
    createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
    decidedBy: row.decider_id ? { id: row.decider_id, name: row.decider_name!, username: row.decider_username } : null,
    grantedRole: row.granted_role,
  };
}

export async function getAccessRequestSummary(id: string): Promise<AccessRequestSummary | undefined> {
  const row = await queryOne<SummaryRow>(`${SUMMARY_SELECT} WHERE ar.id = $1`, [id]);
  return row ? toSummary(row) : undefined;
}

export async function findAccessRequest(id: string): Promise<AccessRequestRow | undefined> {
  return queryOne<AccessRequestRow>('SELECT * FROM access_requests WHERE id = $1', [id]);
}

/** The live request of this person for this space — the one a repeated request returns. */
export async function findPendingAccessRequest(space: string, requesterId: string): Promise<AccessRequestRow | undefined> {
  return queryOne<AccessRequestRow>(
    "SELECT * FROM access_requests WHERE space_slug = $1 AND requester_user_id = $2 AND status = 'pending'",
    [space, requesterId],
  );
}

export async function createAccessRequest(space: string, requesterId: string): Promise<AccessRequestRow> {
  const row = await queryOne<AccessRequestRow>(
    `INSERT INTO access_requests (space_slug, requester_user_id, status)
     VALUES ($1, $2, 'pending')
     RETURNING *`,
    [space, requesterId],
  );
  return row!;
}

/**
 * The pending → approved/denied transition with the condition right in the
 * UPDATE: when two administrators press the button at once, the second gets
 * undefined and, higher up the stack, an honest 409 — not a silent overwrite
 * of somebody else's decision.
 */
export async function decideAccessRequest(
  id: string,
  status: Exclude<AccessRequestStatus, 'pending'>,
  grantedRole: SpaceRole | null,
  decidedByUserId: string,
): Promise<AccessRequestRow | undefined> {
  return queryOne<AccessRequestRow>(
    `UPDATE access_requests
        SET status = $2, granted_role = $3, decided_by_user_id = $4, decided_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [id, status, grantedRole, decidedByUserId],
  );
}

/** Putting a request back to pending — the rollback when granting the role right after "approve" failed. */
export async function revertAccessRequestToPending(id: string): Promise<void> {
  await query(
    `UPDATE access_requests
        SET status = 'pending', granted_role = NULL, decided_by_user_id = NULL, decided_at = NULL
      WHERE id = $1`,
    [id],
  );
}

/**
 * Who a request goes to: the administrators of THIS space plus the instance
 * administrators — in one query and without duplicates (UNION removes them).
 * The requester is not on the list even when they are an instance admin:
 * asking yourself for access makes no sense. Disabled users are not on it
 * either — a feed nobody will open only hides the request from live administrators.
 */
export async function listAccessRequestRecipients(space: string, requesterId: string): Promise<string[]> {
  const rows = await query<{ user_id: string }>(
    `SELECT u.id AS user_id
       FROM users u
      WHERE u.disabled = false
        AND u.id <> $2
        AND (u.is_admin = true
             OR EXISTS (SELECT 1 FROM space_members m WHERE m.space_slug = $1 AND m.user_id = u.id AND m.role = 'admin'))`,
    [space, requesterId],
  );
  return rows.map((r) => r.user_id);
}

/**
 * Those who already have a row about this request in their feed — they are
 * the ones to be told "re-read" after the decision, because their row is stale.
 */
export async function listNotifiedRecipients(accessRequestId: string, kind: NotificationKind): Promise<string[]> {
  const rows = await query<{ user_id: string }>('SELECT DISTINCT user_id FROM notifications WHERE access_request_id = $1 AND kind = $2', [
    accessRequestId,
    kind,
  ]);
  return rows.map((r) => r.user_id);
}

export interface InsertedNotification {
  id: string;
  userId: string;
}

/**
 * One INSERT for all recipients (unnest), not a loop: there may be a dozen
 * instance administrators, and every separate round trip here is for
 * nothing. Called ONLY from dispatch.ts, so that "wrote the row but forgot to
 * push it into the socket" is structurally impossible.
 */
export async function insertNotifications(userIds: string[], kind: NotificationKind, accessRequestId: string): Promise<InsertedNotification[]> {
  if (userIds.length === 0) return [];
  const rows = await query<{ id: string; user_id: string }>(
    `INSERT INTO notifications (user_id, kind, access_request_id)
     SELECT u, $2, $3 FROM unnest($1::uuid[]) AS u
     RETURNING id, user_id`,
    [userIds, kind, accessRequestId],
  );
  return rows.map((r) => ({ id: r.id, userId: r.user_id }));
}

interface NotificationRow extends SummaryRow {
  notification_id: string;
  kind: NotificationKind;
  notification_created_at: Date;
  read_at: Date | null;
}

// JOIN (not LEFT JOIN) on access_requests — a row without a request simply
// does not get into the feed: the column is nullable for the sake of future
// kinds of notifications, which the client of this round cannot show anyway.
const NOTIFICATION_SELECT = `SELECT n.id AS notification_id,
         n.kind,
         n.created_at AS notification_created_at,
         n.read_at,
         ${SUMMARY_COLUMNS}
    FROM notifications n
    JOIN access_requests ar ON ar.id = n.access_request_id
    ${SUMMARY_JOINS}`;

function toItem(row: NotificationRow): NotificationItem {
  return {
    id: row.notification_id,
    kind: row.kind,
    createdAt: row.notification_created_at.toISOString(),
    readAt: row.read_at ? row.read_at.toISOString() : null,
    accessRequest: toSummary(row),
  };
}

/** A user's feed: newest first, with the request expanded. */
export async function listNotifications(userId: string, limit = NOTIFICATION_LIMIT): Promise<NotificationItem[]> {
  const rows = await query<NotificationRow>(`${NOTIFICATION_SELECT} WHERE n.user_id = $1 ORDER BY n.created_at DESC, n.id DESC LIMIT $2`, [
    userId,
    limit,
  ]);
  return rows.map(toItem);
}

/** Rows by id — to push a just created notification into the socket as a ready NotificationItem. */
export async function listNotificationsByIds(ids: string[]): Promise<NotificationItem[]> {
  if (ids.length === 0) return [];
  const rows = await query<NotificationRow>(`${NOTIFICATION_SELECT} WHERE n.id = ANY($1::uuid[])`, [ids]);
  return rows.map(toItem);
}

export async function countUnread(userId: string): Promise<number> {
  const row = await queryOne<{ count: string }>('SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId]);
  return Number(row?.count ?? '0');
}

/**
 * Mark one's OWN rows as read: `user_id = $1` is always in the WHERE, and the
 * list of ids only narrows it — an explicit id of somebody else's row simply
 * does not match and stays untouched (there is deliberately no separate
 * "whose row is this" check: it would be a second place where this invariant
 * could be forgotten). An empty or missing list means "all of mine".
 */
export async function markNotificationsRead(userId: string, ids?: string[]): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE notifications
        SET read_at = now()
      WHERE user_id = $1
        AND read_at IS NULL
        AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
      RETURNING id`,
    [userId, ids && ids.length > 0 ? ids : null],
  );
  return rows.length;
}
