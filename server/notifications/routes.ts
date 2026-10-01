/**
 * Round 31 (notifications and access requests) — the routes of the feed and
 * of the requests. The contracts are already described in
 * shared/contracts.ts, section "Notifications and access requests"; here are
 * exactly those, nothing on top.
 *
 * As in server/access/routes.ts, every handler is a thin wrapper around an
 * exported function: this repository has no HTTP-level harness for Fastify,
 * and the tests (routes.test.ts) call these functions directly against a real
 * PG test schema. For the same reason authorization lives INSIDE the
 * functions, not in the handler: the right to decide a request is "an admin
 * of this space OR an instance admin", and it has to be checked where the
 * space of the request is known.
 */
import type { FastifyInstance } from 'fastify';
import {
  createAccessRequestBodySchema,
  decideAccessRequestBodySchema,
  markNotificationsReadBodySchema,
  type AccessRequestSummary,
  type CreateAccessRequestBody,
  type DecideAccessRequestBody,
  type MarkNotificationsReadBody,
  type NotificationListResponse,
  type User,
} from '../../shared/contracts.js';
import * as storage from '../storage.js';
import * as session from '../auth/session.js';
import { applyAccessBulk } from '../access/routes.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { parseBody } from '../validate.js';
import * as store from './store.js';
import * as dispatch from './dispatch.js';

/** A PG unique index violation — here it is always access_requests_pending_uniq. */
const PG_UNIQUE_VIOLATION = '23505';

/** Somebody else's row will not be updated by id in any case (WHERE user_id), but non-uuid "ids" are better filtered out before the cast to uuid[]. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// POST /api/access-requests — "let me into this space".
// ---------------------------------------------------------------------------

/**
 * Idempotent: a repeated click (or a second tab) returns THE SAME live
 * request, does not breed a row and does not wake the administrators twice.
 * The "no live request" check is made both before the insert (the usual
 * path) and after a unique violation (a race of two tabs) — the index here is
 * not a failure but the database's regular answer to concurrency.
 */
export async function createAccessRequest(actor: User, body: CreateAccessRequestBody): Promise<AccessRequestSummary> {
  const space = body.space;
  if (!(await storage.spaceExists(space))) throw notFound('space');

  // Access is already there (explicit membership, or the space is visible to
  // the whole instance) — a request is pointless, and creating one so that an
  // administrator later "grants" what is granted is worse than a plain error.
  const role = await session.effectiveRole(actor, space);
  if (role) throw conflict('you already have access to this space');

  const existing = await store.findPendingAccessRequest(space, actor.id);
  if (existing) return (await store.getAccessRequestSummary(existing.id))!;

  let created: store.AccessRequestRow;
  try {
    created = await store.createAccessRequest(space, actor.id);
  } catch (err) {
    if ((err as { code?: string }).code !== PG_UNIQUE_VIOLATION) throw err;
    const raced = await store.findPendingAccessRequest(space, actor.id);
    if (!raced) throw err;
    return (await store.getAccessRequestSummary(raced.id))!;
  }

  const recipients = await store.listAccessRequestRecipients(space, actor.id);
  await dispatch.deliver(recipients, 'access_request', created.id);

  return (await store.getAccessRequestSummary(created.id))!;
}

// ---------------------------------------------------------------------------
// GET /api/notifications — the feed of the current user.
// ---------------------------------------------------------------------------

export async function listNotifications(actor: User): Promise<NotificationListResponse> {
  const [items, unread] = await Promise.all([store.listNotifications(actor.id), store.countUnread(actor.id)]);
  // unread is counted over ALL rows, not only the returned page: the counter
  // on the bell must not shrink just because the feed is truncated.
  return { items, unread };
}

// ---------------------------------------------------------------------------
// POST /api/notifications/read — mark one's own as read.
// ---------------------------------------------------------------------------

export async function markNotificationsRead(actor: User, body: MarkNotificationsReadBody): Promise<{ unread: number }> {
  if (!body.ids || body.ids.length === 0) {
    // The contract: a missing or empty list means "all of mine".
    await store.markNotificationsRead(actor.id);
  } else {
    // A list was given — but not a single item looks like an id: marking
    // EVERYTHING then would be the worst possible reading of "these ones".
    const ids = body.ids.filter((id) => UUID_RE.test(id));
    if (ids.length > 0) await store.markNotificationsRead(actor.id, ids);
  }
  // Other people's rows are not touched even by an explicit id — the
  // `user_id = $1` filter is in the UPDATE itself (store.markNotificationsRead), not here.
  return { unread: await store.countUnread(actor.id) };
}

// ---------------------------------------------------------------------------
// POST /api/access-requests/:id/decision — the administrator's decision.
// ---------------------------------------------------------------------------

/**
 * The right is the same `canAdministerSpace` as for the rest of membership
 * management (an admin of this space OR an instance admin). Granting the role
 * is NOT duplicated here: `applyAccessBulk` from server/access/routes.ts is
 * called — exactly the path by which access is granted from the admin
 * screen, with its checks (the last admin of a space, the user exists) and
 * its audit record (`access.grant`/`access.self_grant`). An INSERT of our own
 * into space_members would be a second way of granting access, with holes of its own.
 */
export async function decideAccessRequest(actor: User, id: string, body: DecideAccessRequestBody): Promise<AccessRequestSummary> {
  if (!UUID_RE.test(id)) throw notFound('access request');
  const request = await store.findAccessRequest(id);
  if (!request) throw notFound('access request');
  if (!(await session.canAdministerSpace(actor, request.space_slug))) {
    throw forbidden('requires instance admin, or admin role in this space');
  }
  if (request.status !== 'pending') throw conflict('access request is already decided');

  const approving = body.decision === 'approve';
  const role = approving ? body.role! : null;

  // The state is changed FIRST and conditionally (WHERE status = 'pending'):
  // the race of two administrators is won by the one whose UPDATE arrived
  // earlier, the other gets a 409 instead of silently overwriting the decision.
  const decided = await store.decideAccessRequest(id, approving ? 'approved' : 'denied', role, actor.id);
  if (!decided) throw conflict('access request is already decided');

  if (approving) {
    const result = await applyAccessBulk(actor, { changes: [{ userId: request.requester_user_id, space: request.space_slug, role: role! }] });
    if (result.errors.length > 0) {
      // The role was not granted — the request must not stay "approved": put
      // it back in the queue so that the administrator sees the error and decides again.
      await store.revertAccessRequestToPending(id);
      throw conflict(result.errors[0].error);
    }
  }

  // The requester learns of the decision from a row in their feed — both on
  // approval and on refusal: a silent refusal is no different from "it got lost".
  await dispatch.deliver([request.requester_user_id], 'access_decision', id);

  // The other administrators get only "re-read": their row with the buttons
  // is stale, but they need no separate event about somebody else's decision.
  const stale = (await store.listNotifiedRecipients(id, 'access_request')).filter((userId) => userId !== request.requester_user_id);
  dispatch.notifyRefresh(stale);

  return (await store.getAccessRequestSummary(id))!;
}

// ---------------------------------------------------------------------------
// Registration. Cookie-only (like the /events socket): the notification feed
// is a browser thing, a PAT does not come here, just as it does not go to /collab.
// ---------------------------------------------------------------------------

export function registerNotificationRoutes(app: FastifyInstance): void {
  app.post('/api/access-requests', async (request, reply) => {
    session.requireCookieAuth(request);
    session.requireWriteScope(request);
    const body = parseBody(createAccessRequestBodySchema, request.body);
    const created = await createAccessRequest(request.authUser!, body);
    reply.status(201);
    return { request: created };
  });

  app.get('/api/notifications', async (request) => {
    session.requireCookieAuth(request);
    return listNotifications(request.authUser!);
  });

  app.post('/api/notifications/read', async (request) => {
    session.requireCookieAuth(request);
    session.requireWriteScope(request);
    const body = parseBody(markNotificationsReadBodySchema, request.body);
    return markNotificationsRead(request.authUser!, body);
  });

  app.post('/api/access-requests/:id/decision', async (request) => {
    session.requireCookieAuth(request);
    session.requireWriteScope(request);
    const { id } = request.params as { id: string };
    const body = parseBody(decideAccessRequestBodySchema, request.body);
    return { request: await decideAccessRequest(request.authUser!, id, body) };
  });
}
