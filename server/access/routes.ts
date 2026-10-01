/**
 * Round 27 (access and rights) route registration — see docs/spec-access.md §7
 * for the normative API. Registered once, by the orchestrator, from
 * server/index.ts's protectedScope so server/routes.ts itself stays
 * untouched by this round (its point-edits in spec §8 — session.ts,
 * search.ts, auth/store.ts, mcp.ts, routes.ts:687/218 — are separate,
 * targeted diffs, not new routes here).
 *
 * Every handler here is a thin wrapper around an exported, directly
 * unit-testable function (same pattern server/routes.ts's
 * buildAdminSpacesList uses — see server/routes.test.ts's doc comment: this
 * codebase has no HTTP-level Fastify test harness, every test calls the
 * underlying module function directly against a real PG test schema). The
 * authorization logic lives IN those functions, not in the route handler —
 * unlike a flat `session.requireInstanceAdmin(request)` gate, bulk access
 * changes and the space access-log need PER-CHANGE / per-space authorization
 * decisions (instance-admin OR that space's own admin, spec §7: "Rights:
 * everything — the instance admin; POST /api/access/bulk and the memberships
 * of a given space — its admin as well"), which is exactly the kind of business logic that
 * needs its own tests, not just plumbing tests.
 */
import type { FastifyInstance } from 'fastify';
import {
  accessBulkBodySchema,
  updateSpaceVisibilityBodySchema,
  type AccessBulkBody,
  type AccessBulkResult,
  type AccessLogEntry,
  type AccessMatrixResponse,
  type SpaceRole,
  type SpaceVisibility,
  type User,
  type UserAccessResponse,
} from '../../shared/contracts.js';
import * as storage from '../storage.js';
import * as store from '../auth/store.js';
import * as session from '../auth/session.js';
import { recordAudit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { parseBody } from '../validate.js';
import { resolveTextLanguage } from '../serverText.js';

const ACCESS_LOG_LIMIT = 100;

// ---------------------------------------------------------------------------
// GET /api/access/matrix — instance-admin only (spec §7): the full users ×
// spaces picture, which only an instance-admin should see in one shot.
// ---------------------------------------------------------------------------

export async function buildAccessMatrix(actor: User): Promise<AccessMatrixResponse> {
  if (!actor.isAdmin) throw forbidden('requires instance admin');

  const [users, spaces, memberships] = await Promise.all([store.listUsers(), storage.listSpaces(), store.listAllMemberships()]);

  const roles: Record<string, Record<string, SpaceRole>> = {};
  for (const m of memberships) {
    (roles[m.userId] ??= {})[m.space] = m.role;
  }

  return {
    users: users.map((u) => ({ id: u.id, name: u.name, email: u.email, isAdmin: u.isAdmin, disabled: Boolean(u.disabled) })),
    spaces: spaces.map((s) => ({ slug: s.slug, name: s.name, visibility: s.visibility ?? 'private' })),
    roles,
  };
}

// ---------------------------------------------------------------------------
// POST /api/access/bulk — instance-admin (any space) OR a space's own admin
// (only for that space, spec §7). Applies each change independently: a
// single bad row (space the actor doesn't administer, would-orphan-the-
// space, unknown user) becomes an `errors[]` entry, never aborts the whole
// batch — spec §6.2: "one operation — one request, errors are shown per line".
// ---------------------------------------------------------------------------

export async function applyAccessBulk(actor: User, body: AccessBulkBody): Promise<AccessBulkResult> {
  const applied: AccessBulkResult['applied'] = [];
  const errors: AccessBulkResult['errors'] = [];

  for (const change of body.changes) {
    try {
      if (!(await storage.spaceExists(change.space))) {
        errors.push({ userId: change.userId, space: change.space, error: 'space not found' });
        continue;
      }
      if (!(await session.canAdministerSpace(actor, change.space))) {
        errors.push({ userId: change.userId, space: change.space, error: 'requires instance admin, or admin role in this space' });
        continue;
      }
      const targetUser = await store.findUserById(change.userId);
      if (!targetUser) {
        errors.push({ userId: change.userId, space: change.space, error: 'user not found' });
        continue;
      }

      const currentRole = await store.getMembershipRole(change.space, change.userId);

      // spec §5: a space always keeps >=1 admin — reject a revoke, or a
      // demotion away from admin, that would leave zero (mirrors the
      // identical check in auth/routes.ts's PUT .../members/:identifier).
      if (currentRole === 'admin' && change.role !== 'admin' && (await store.countSpaceAdmins(change.space, change.userId)) === 0) {
        errors.push({ userId: change.userId, space: change.space, error: 'cannot remove the last admin of this space' });
        continue;
      }

      // spec §2: an instance-admin granting THEMSELVES access is allowed —
      // it's an unavoidable consequence of controlling memberships — but
      // must never happen silently. Detected purely off `actor.isAdmin` +
      // `actor.id === change.userId`, regardless of the space or the actor's
      // own membership there (a space-admin acting only within a space they
      // already administer isn't the scenario this event exists to flag).
      const isSelfGrant = actor.isAdmin && actor.id === change.userId && change.role !== null;

      if (change.role === null) {
        await store.removeMembership(change.space, change.userId);
        recordAudit(actor.id, 'access.revoke', change.space, { targetUserId: change.userId, previousRole: currentRole ?? null });
      } else {
        await store.setMembership(change.space, change.userId, change.role);
        const meta: Record<string, unknown> = { targetUserId: change.userId, role: change.role, previousRole: currentRole ?? null };
        if (isSelfGrant && body.reason) meta.reason = body.reason;
        recordAudit(actor.id, isSelfGrant ? 'access.self_grant' : 'access.grant', change.space, meta);
      }
      applied.push({ userId: change.userId, space: change.space, role: change.role });
    } catch (err) {
      errors.push({ userId: change.userId, space: change.space, error: err instanceof Error ? err.message : 'unknown error' });
    }
  }

  return { applied, errors };
}

// ---------------------------------------------------------------------------
// PATCH /api/spaces/:space — visibility (spec §3/§7). Judgment call: treated
// as membership-adjacent administration (same canAdministerSpace gate as the
// bulk endpoint above and the existing PUT/DELETE .../members/:identifier
// routes), not instance-admin-only — a space's own admin deciding whether
// their space is instance-wide-readable fits the "memberships of a given
// space — its admin as well" line in spec §7 as naturally as granting a role
// does; the spec doesn't spell out this one explicitly.
// ---------------------------------------------------------------------------

export async function updateSpaceVisibility(actor: User, space: string, visibility: SpaceVisibility): Promise<{ slug: string; visibility: SpaceVisibility }> {
  if (!(await storage.spaceExists(space))) throw notFound('space');
  if (!(await session.canAdministerSpace(actor, space))) throw forbidden('requires instance admin, or admin role in this space');
  await store.setSpaceVisibility(space, visibility);
  recordAudit(actor.id, 'space.visibility', space, { visibility });
  return { slug: space, visibility };
}

// ---------------------------------------------------------------------------
// GET /api/spaces/:space/access-log — spec §2 item 4: "Visible to the space's
// admins and to instance admins" — same canAdministerSpace gate, deliberately NOT
// viewer+ (this is who-changed-what-access, not page content, but it's still
// not for every space viewer).
// ---------------------------------------------------------------------------

export async function getSpaceAccessLog(actor: User, space: string): Promise<AccessLogEntry[]> {
  if (!(await storage.spaceExists(space))) throw notFound('space');
  if (!(await session.canAdministerSpace(actor, space))) throw forbidden('requires instance admin, or admin role in this space');
  return store.listAccessLogForSpace(space, ACCESS_LOG_LIMIT, resolveTextLanguage(actor.lang));
}

// ---------------------------------------------------------------------------
// GET /api/users/:id/access — instance-admin only: a cross-space view of one
// user's access is instance-level administration (spec §6.1's expandable
// row), not something a single space's admin needs or should see.
// ---------------------------------------------------------------------------

export async function getUserAccess(actor: User, targetId: string): Promise<UserAccessResponse> {
  if (!actor.isAdmin) throw forbidden('requires instance admin');
  const target = await store.findUserById(targetId);
  if (!target) throw notFound('user');
  const [memberships, log] = await Promise.all([store.spacesForUser(targetId), store.listAccessLogForUser(targetId, ACCESS_LOG_LIMIT, resolveTextLanguage(actor.lang))]);
  return { memberships, log };
}

/**
 * Every route in this module is access ADMINISTRATION, which DEV-PLAN round 7
 * puts out of a PAT's reach outright: "Admin endpoints (/api/users, members)
 * are NOT available to a PAT whatever its scope". QA-3 found the whole file missing
 * that gate — a `scopes: ['read']` token could read the full users × spaces
 * matrix AND grant itself a role via POST /api/access/bulk or open a private
 * space instance-wide via PATCH /api/spaces/:space. requireCookieAuth is the
 * real gate (it rejects a PAT whatever its scope); requireWriteScope on the
 * two mutating routes is the same belt-and-braces pairing
 * auth/routes.ts:286-287 already uses, so the write intent stays declared at
 * the route even if the cookie-only rule is ever relaxed.
 */
export function registerAccessRoutes(app: FastifyInstance): void {
  app.get('/api/access/matrix', async (request) => {
    session.requireCookieAuth(request);
    return buildAccessMatrix(request.authUser!);
  });

  app.post('/api/access/bulk', async (request) => {
    session.requireCookieAuth(request);
    session.requireWriteScope(request);
    const body = parseBody(accessBulkBodySchema, request.body);
    return applyAccessBulk(request.authUser!, body);
  });

  app.patch('/api/spaces/:space', async (request) => {
    session.requireCookieAuth(request);
    session.requireWriteScope(request);
    const { space } = request.params as { space: string };
    if (!space) throw badRequest('space is required');
    const body = parseBody(updateSpaceVisibilityBodySchema, request.body);
    return updateSpaceVisibility(request.authUser!, space, body.visibility);
  });

  app.get('/api/spaces/:space/access-log', async (request) => {
    session.requireCookieAuth(request);
    const { space } = request.params as { space: string };
    const entries = await getSpaceAccessLog(request.authUser!, space);
    return { entries };
  });

  app.get('/api/users/:id/access', async (request) => {
    session.requireCookieAuth(request);
    const { id } = request.params as { id: string };
    return getUserAccess(request.authUser!, id);
  });
}
