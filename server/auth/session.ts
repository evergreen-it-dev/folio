/**
 * Sessions: cookie plumbing, the blanket `requireSession` guard, and role
 * resolution. Mirrors a sibling project's server/http/session.ts pattern
 * (httpOnly/sameSite=lax/secure-in-prod cookie, self-healing a disabled
 * user's still-unexpired session) adapted to Fastify + PostgreSQL instead of
 * Express + MySQL. Every role/store lookup is now a real query, so this
 * module's role-resolution helpers are async where round 2's were sync.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiTokenScope, SpaceRole, User } from '../../shared/contracts.js';
import * as store from './store.js';
import * as storage from '../storage.js';
import type { PageIndexEntry } from '../storage.js';
import { forbidden, notFound } from '../errors.js';
import { checkLoginRateLimitRedis, isRedisReady, type RateLimitResult } from '../db/redis.js';
import * as pageAccess from '../pageAccess.js';
import * as roles from '../access/roles.js';
import { roleAtLeast } from '../access/roles.js';
import { isAgentPath } from '../agentPath.js';
import { normalizePublicUrl } from '../publicUrl.js';
import { setSentryUser } from '../sentry.js';
import { isPublicPage, publicReadablePageIds } from '../publicSites.js';

export const SESSION_COOKIE_NAME = 'folio_session';
const PAT_PREFIX = 'folio_pat_';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireSession (or resolved ad hoc for the public /api/auth/state route). */
    authUser: User | null;
    /**
     * undefined = cookie-authenticated (full access, no PAT scoping at all —
     * a browser session was never issued a restricted scope). A real array =
     * PAT-authenticated with exactly these scopes. Route handlers that need
     * to gate PAT access use requireWriteScope/rejectPat below; nothing reads
     * this directly except those two helpers and the MCP mount.
     */
    tokenScopes?: ApiTokenScope[];
    /** Id of the API token / OAuth grant that authenticated this request; undefined for a cookie session. Written to audit_log and the review queue. */
    tokenId?: string;
  }
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

// The rank table and roleAtLeast live with the resolver (access/roles.ts); re-exported for the many existing callers.
export { roleAtLeast };

/**
 * A built-in system account (13.10.2026: the "Public visitor" that anonymous
 * public-site assistant runs act as — db/migrations/039_public_assistant.sql).
 * Its access is NOT the access model of a person: never a membership, never the
 * implicit viewer of an `instance` space, never an administrator — only an
 * implicit `viewer` of a PUBLISHED (`visibility: 'public'`) space, and within it
 * only the public page set (publicSites.ts: no restricted page, no `.agent/**`,
 * no `_templates/`). The id check is a second key to the `isSystem` flag, so a
 * User object built without the flag is still recognised.
 */
export function isSystemUser(user: Pick<User, 'id' | 'isSystem'>): boolean {
  return user.isSystem === true || user.id === store.PUBLIC_VISITOR_USER_ID;
}

/**
 * Round 27 (access and rights): NO instance-admin bypass here — content access is
 * ONLY an explicit `space_members` row, or (§3) an implicit `viewer` when the
 * space's `visibility` is `'instance'` or `'public'` (spaceOpenToInstance). `user.isAdmin` grants the ability to
 * ADMINISTER access (see canAdministerSpace below), never to read content by
 * itself — that's the whole point of this round (spec-access.md §1/§2): "not
 * 'an admin cannot read a private space', but 'an admin cannot read it
 * silently'". A disabled user gets nothing via either path (spec §5).
 * The rule itself lives in access/roles.ts (resolveSpaceRole) and its SQL twin
 * access/roleSql.ts — this is a thin wrapper.
 */
export async function effectiveRole(user: User, space: string): Promise<SpaceRole | undefined> {
  return roles.effectiveSpaceRole(roles.roleSubject(user, isSystemUser(user)), space);
}

/**
 * space slug -> role for every space this user may see: explicit
 * space_members rows, plus (round 27) every `visibility: 'instance'` or `'public'` space
 * as an implicit 'viewer' entry (explicit membership, if any, wins — an
 * explicit editor/admin role is never downgraded by the implicit grant).
 * Disabled: nothing, same as effectiveRole.
 */
export async function membershipsFor(user: User): Promise<Record<string, SpaceRole>> {
  return roles.spaceRolesForUser(roles.roleSubject(user, isSystemUser(user)));
}

export async function visibleSpaceSlugs(user: User): Promise<Set<string>> {
  return new Set(Object.keys(await membershipsFor(user)));
}

/**
 * Round 27: "can this user manage MEMBERSHIPS of `space`" — instance-admin
 * (any space, including one they don't otherwise have access to — that's
 * administration, not reading, spec §5) OR the space's own explicit admin.
 * Deliberately NOT `effectiveRole`-based content gating: use this ONLY for
 * membership-management endpoints (server/access/routes.ts), NEVER to decide
 * whether a request may read a page/tree/search hit/etc — spec §1's "honest
 * boundary" table draws exactly this line.
 */
export async function canAdministerSpace(user: User, space: string): Promise<boolean> {
  if (isSystemUser(user)) return false;
  if (user.isAdmin) return true;
  // 'admin' never comes from visibility (the implicit grant is 'viewer'), so this is "an admin member of the space".
  return (await effectiveRole(user, space)) === 'admin';
}

/** Throws 403 unless the request's user is an instance admin. Call only after requireSession has run. */
export function requireInstanceAdmin(request: FastifyRequest): User {
  const user = request.authUser!;
  if (!user.isAdmin) throw forbidden('requires instance admin');
  return user;
}

/**
 * Throws 404 if the space doesn't exist at all, 403 if it exists but the
 * caller's role there is below `min` (or they have none). Returns the
 * caller's actual role on success.
 */
export async function requireSpaceRole(request: FastifyRequest, space: string, min: SpaceRole): Promise<SpaceRole> {
  if (!(await storage.spaceExists(space))) throw notFound('space');
  const role = await effectiveRole(request.authUser!, space);
  if (!roleAtLeast(role, min)) throw forbidden(`requires ${min}+ role in this space`);
  return role as SpaceRole;
}

/**
 * Membership management of a space (docs/spec-access.md §8): 404 if the space doesn't exist, 403 unless the caller
 * is an instance admin or an admin member of it (canAdministerSpace). It lets an instance admin manage who is in a
 * space, NOT read its content: effectiveRole / requirePageRole are untouched.
 */
export async function requireSpaceAdministrator(request: FastifyRequest, space: string): Promise<void> {
  if (!(await storage.spaceExists(space))) throw notFound('space');
  if (!(await canAdministerSpace(request.authUser!, space))) throw forbidden('requires instance admin, or admin role in this space');
}

/**
 * Same as requireSpaceRole, but for a page id — resolves its space first
 * (404 if the id itself is unknown). A `.agent/**` page (owner spec,
 * 21.09.2026: admin-only everywhere pages are read) 404s the SAME WAY for
 * anyone below space/instance admin — never a 403, which would reveal the
 * page exists. Checked before the normal role gate below (which would also
 * end up denying it via effectivePageRole, just with the wrong status).
 */
export async function requirePageRole(request: FastifyRequest, id: string, min: SpaceRole): Promise<PageIndexEntry> {
  const entry = await storage.requireEntry(id);
  if (isAgentPath(entry.relPath) && !(await canAdministerSpace(request.authUser!, entry.space))) throw notFound('page');
  const role = await effectivePageRole(request.authUser!, entry);
  if (!roleAtLeast(role, min)) throw forbidden(`requires ${min}+ role on this page`);
  return entry;
}

/** `.agent/**` gate first (see requirePageRole's doc comment) — every caller of this (routes.ts, mcp.ts's checkPageRole, collab.ts, pageChanges.ts, assistant/workspace.ts) gets it for free. */
export async function effectivePageRole(user: User, entry: PageIndexEntry): Promise<SpaceRole | undefined> {
  // A system user reads exactly the public page set of a published space (see isSystemUser).
  if (isSystemUser(user)) return !user.disabled && (await isPublicPage({ id: entry.id, space: entry.space, relPath: entry.relPath })) ? 'viewer' : undefined;
  if (isAgentPath(entry.relPath) && !(await canAdministerSpace(user, entry.space))) return undefined;
  return pageAccess.effectivePageRole(user, entry, await effectiveRole(user, entry.space));
}

/**
 * `knownRole` is the caller's effectiveRole in `space` when the route already resolved it (requireSpaceRole returns
 * it) — saves repeating the membership lookup. Space-admin-ness is derived from that one role: 'admin' only ever comes
 * from an explicit membership (the implicit grant is 'viewer'), so this equals canAdministerSpace without its own query.
 */
export async function readablePageIds(user: User, space: string, knownRole?: SpaceRole): Promise<Set<string>> {
  const role = knownRole ?? (await effectiveRole(user, space));
  if (!role) return new Set();
  if (isSystemUser(user)) return publicReadablePageIds(space);
  return pageAccess.readablePageIds(user.id, space, user.isAdmin || role === 'admin');
}

/**
 * Throws (403) unless `targetDirPath` is outside `.agent/**`, or the caller
 * can administer `space`. Read access is only half of ".agent is
 * admin-only" — its content is injected into the assistant's own system
 * prompt for the whole space (server/assistant/agentContext.ts), so a
 * non-admin editor planting a page there via create/move/copy would be a
 * prompt-injection / privilege-escalation path, not just a visibility leak.
 * Every route that lets a caller CHOOSE a destination directory calls this
 * before writing — `targetDirPath` is the NORMALIZED parent/destination dir
 * (storage.normalizeDirParam), not a full page path.
 */
export async function requireAgentWriteAllowed(user: User, space: string, targetDirPath: string): Promise<void> {
  if (isAgentPath(targetDirPath) && !(await canAdministerSpace(user, space))) {
    throw forbidden('.agent is admin-only');
  }
}

// ---------------------------------------------------------------------------
// Cookie plumbing
// ---------------------------------------------------------------------------

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Whether auth cookies carry `Secure`. On in production, EXCEPT when the
 * operator explicitly configured a plain-http PUBLIC_URL (a self-hosted
 * instance on a LAN, or one not yet behind TLS): browsers drop `Secure`
 * cookies on any http origin other than localhost, so sign-in would fail
 * silently. An https or scheme-less PUBLIC_URL (normalized to https) keeps
 * the flag on. Exported for google.ts's own short-lived state/PKCE cookie,
 * which needs the same rule as the session cookie.
 */
export function cookiesSecure(): boolean {
  if (!isProduction()) return false;
  const raw = process.env.PUBLIC_URL;
  return !(raw && normalizePublicUrl(raw).toLowerCase().startsWith('http://'));
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookiesSecure(),
    maxAge: Math.floor(store.sessionTtlMs() / 1000),
    path: '/',
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
}

/**
 * Tiny manual `Cookie:` header parser for the raw WebSocket upgrade path
 * (server/collab.ts), which happens on the bare http.Server before Fastify
 * (and @fastify/cookie) ever sees the request.
 */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Session resolution
// ---------------------------------------------------------------------------

/** Resolves a raw token to its User; self-heals (destroys all sessions) for a disabled account. */
export async function userForToken(token: string | undefined | null): Promise<User | null> {
  if (!token) return null;
  const userId = await store.resolveSessionUserId(token);
  if (!userId) return null;
  const stored = await store.findStoredUserById(userId);
  if (!stored) return null;
  // A system account never holds a session (store.createSession refuses it); should a row ever appear, it authenticates nothing.
  if (stored.isSystem) return null;
  if (stored.disabled) {
    await store.destroyAllSessionsForUser(userId);
    return null;
  }
  const { passwordHash: _passwordHash, ...user } = stored;
  return user;
}

function extractBearerPat(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  const token = header.slice('Bearer '.length).trim();
  return token.startsWith(PAT_PREFIX) ? token : undefined;
}

export interface ResolvedAuth {
  user: User;
  /** Set only for a PAT-authenticated request. Cookie sessions never carry a scope restriction. */
  tokenScopes?: ApiTokenScope[];
  tokenId?: string;
}

/**
 * Cookie session first (the original, unchanged path); `Authorization: Bearer
 * folio_pat_…` second, as an alternative (round 7). A disabled user is
 * rejected either way — self-healed for cookies (all sessions destroyed,
 * mirroring userForToken below); for a PAT there's nothing to "destroy" per
 * request, it just stops authenticating starting now.
 */
async function resolvePat(request: FastifyRequest): Promise<ResolvedAuth | null> {
  const bearer = extractBearerPat(request);
  if (!bearer) return null;
  const resolved = await store.resolveApiToken(bearer);
  if (!resolved) return null;
  const user = await store.findUserById(resolved.userId);
  if (!user || user.disabled || isSystemUser(user)) return null;
  store.touchApiTokenLastUsed(resolved.tokenId);
  return { user, tokenScopes: resolved.scopes, tokenId: resolved.tokenId };
}

export async function resolveAuth(request: FastifyRequest): Promise<ResolvedAuth | null> {
  const cookieToken = request.cookies?.[SESSION_COOKIE_NAME];
  const cookieUser = await userForToken(cookieToken);
  if (cookieUser) {
    // Throttled bookkeeping for the session list ("last active", device, address); request.ip is the real client address only with TRUST_PROXY.
    if (cookieToken) store.touchSession(cookieToken, { userAgent: request.headers['user-agent'], ip: request.ip });
    return { user: cookieUser };
  }
  return resolvePat(request);
}

/**
 * PAT Bearer only — cookie sessions are explicitly NOT accepted here.
 * DEV-PLAN round 7, the MCP mount: "auth — PAT Bearer (cookies are not
 * accepted)". Used only by index.ts's /mcp route, never the general
 * `requireSession` blanket guard (which accepts either, via resolveAuth).
 */
export const resolvePatOnly = resolvePat;

export async function userForRequest(request: FastifyRequest): Promise<User | null> {
  const resolved = await resolveAuth(request);
  return resolved?.user ?? null;
}

/**
 * Blanket guard: registered as an onRequest hook on the protected route
 * scope in index.ts (everything except health/auth-state/setup/login — see
 * that file for why a Fastify child scope, not route-registration order,
 * is what actually exempts those four routes).
 */
export async function requireSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const resolved = await resolveAuth(request);
  if (!resolved) {
    reply.status(401).send({ error: 'authentication required' });
    return;
  }
  request.authUser = resolved.user;
  request.tokenScopes = resolved.tokenScopes;
  request.tokenId = resolved.tokenId;
  setSentryUser(resolved.user.id);
}

/**
 * Throws 403 if this request is PAT-authenticated at all, regardless of
 * scope — for routes a stolen token must never reach: /api/users*, space
 * members, /api/me/tokens itself, and protected auth routes (logout). Cookie
 * sessions (tokenScopes undefined) always pass.
 */
export function requireCookieAuth(request: FastifyRequest): void {
  if (request.tokenScopes !== undefined) throw forbidden('not available via API token');
}

/**
 * Throws 403 if this request is PAT-authenticated with a scope set that
 * doesn't include 'write' — the enumerated mutating routes (create/PUT/
 * move/rename/delete/restore/assets/sync) call this after their normal role
 * check. Cookie sessions always pass; a read-scoped PAT is blocked here even
 * though its owner might otherwise have editor+ role in the space.
 */
export function requireWriteScope(request: FastifyRequest): void {
  if (request.tokenScopes !== undefined && !request.tokenScopes.includes('write')) {
    throw forbidden('this action requires a token with write scope');
  }
}

// ---------------------------------------------------------------------------
// Login rate limiting: 10/min/IP. Redis-backed (round 4) when Redis is up;
// falls back to the round-2 in-memory sliding window otherwise (DEV-PLAN:
// "Redis unavailable -> degrade with a warning (rate limit in memory), do not fail").
// ---------------------------------------------------------------------------

const LOGIN_RATE_LIMIT_WINDOW_MS = 60_000;
const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 10;
const loginAttemptsByIp = new Map<string, number[]>();

function pruneExpiredLoginAttempts(now: number): void {
  const windowStart = now - LOGIN_RATE_LIMIT_WINDOW_MS;
  for (const [ip, timestamps] of loginAttemptsByIp) {
    if (timestamps.every((t) => t <= windowStart)) loginAttemptsByIp.delete(ip);
  }
}

function checkLoginRateLimitMemory(ip: string): RateLimitResult {
  const now = Date.now();
  const windowStart = now - LOGIN_RATE_LIMIT_WINDOW_MS;
  pruneExpiredLoginAttempts(now);

  const recent = (loginAttemptsByIp.get(ip) ?? []).filter((t) => t > windowStart);
  if (recent.length >= LOGIN_RATE_LIMIT_MAX_ATTEMPTS) {
    loginAttemptsByIp.set(ip, recent);
    const retryAfterMs = recent[0] + LOGIN_RATE_LIMIT_WINDOW_MS - now;
    return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }
  recent.push(now);
  loginAttemptsByIp.set(ip, recent);
  return { limited: false };
}

export async function checkLoginRateLimit(ip: string): Promise<RateLimitResult> {
  if (isRedisReady()) {
    try {
      return await checkLoginRateLimitRedis(ip);
    } catch {
      // transient Redis error mid-request: fall through to the in-memory limiter below
    }
  }
  return checkLoginRateLimitMemory(ip);
}

/** Test-only escape hatch: the in-memory limiter (Redis fallback path) is a module-level singleton. */
export function __resetLoginRateLimitForTests(): void {
  loginAttemptsByIp.clear();
}
