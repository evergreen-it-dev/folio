/**
 * Auth persistence — PostgreSQL (round 4). Same exported surface as round
 * 2's JSON-file version (storage-layer swap only, per DEV-PLAN round 4:
 * "the API shapes do not change"), but every function is now async since it's a
 * real query. Sessions are stored as sha256(token) — the raw token only
 * ever lives in the httpOnly cookie, mirroring a sibling project.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  AccessLogEntry,
  ApiTokenInfo,
  ApiTokenScope,
  CreatedApiToken,
  MentionableUser,
  SpaceMemberInfo,
  SpaceRole,
  SpaceVisibility,
  SessionInfo,
  Stars,
  UiLanguage,
  User,
} from '../../shared/contracts.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { query, queryOne } from '../db/pool.js';
import { recordAudit } from '../audit.js';
import { disconnectSessions, disconnectUser } from '../liveConnections.js';
import { revokeAllOAuthAccessForUser } from '../oauth/store.js';
import { serverText } from '../serverText.js';
import { effectiveRolesSql } from '../access/roleSql.js';
import { SPACE_ADMINS_COUNT_SQL } from '../groups/store.js';

const DEFAULT_SESSION_TTL_DAYS = 30;

/**
 * Absolute lifetime of a login session (no sliding expiry): FOLIO_SESSION_TTL_DAYS, default 30.
 * A missing, non-numeric or non-positive value falls back to the default. Read at call time, so
 * the cookie's Max-Age and the stored expires_at always agree.
 */
export function sessionTtlMs(): number {
  const raw = process.env.FOLIO_SESSION_TTL_DAYS?.trim();
  const days = raw ? Number(raw) : DEFAULT_SESSION_TTL_DAYS;
  const valid = Number.isFinite(days) && days > 0 ? Math.min(days, 3650) : DEFAULT_SESSION_TTL_DAYS;
  return Math.round(valid * 24 * 60 * 60 * 1000);
}

/**
 * The built-in "Public visitor" system user (db/migrations/039_public_assistant.sql):
 * the identity anonymous public-site assistant runs act as. A system user never
 * signs in, never holds a session or an API token, and is never listed as a
 * person; its access is decided in session.ts (public spaces only), not by
 * memberships.
 */
export const PUBLIC_VISITOR_USER_ID = '00000000-0000-4000-8000-0000000f0110';

export interface StoredUser extends User {
  /** NULL for a single-sign-on-only account that has never set a password — see passwords.ts's verifyPassword, which treats NULL as "no password can ever match", never comparing against it. */
  passwordHash: string | null;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  is_admin: boolean;
  disabled: boolean;
  created_at: string;
  /** Round 10: NULL = no preference set — callers fall back to DEFAULT_UI_LANGUAGE. */
  lang: string | null;
  /** Round 15: NULL = no @mention handle chosen yet. Always already lower-case (see updateUsername). */
  username: string | null;
  /** 039: a built-in system account (the public visitor), never a person. */
  is_system: boolean;
}

function rowToStoredUser(row: UserRow): StoredUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    isAdmin: row.is_admin,
    disabled: row.disabled,
    createdAt: new Date(row.created_at).toISOString(),
    // DB CHECK constraint already guarantees this is 'uk'|'en'|null; the
    // cast just tells TS what the CHECK already enforces at the DB layer.
    lang: (row.lang as UiLanguage | null) ?? undefined,
    username: row.username ?? undefined,
    // Only ever present (true) on a system account: a real person's user JSON stays exactly as before.
    ...(row.is_system ? { isSystem: true } : {}),
  };
}
function toPublicUser(u: StoredUser): User {
  const { passwordHash: _passwordHash, ...rest } = u;
  return rest;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** What was cut off when an account was deactivated (counts only; they go into the user.disable audit event). */
export interface RevokedAccess {
  sessions: number;
  apiTokens: number;
  oauthGrants: number;
  sockets: number;
}


// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** Real people only: the built-in system user (migration 039) must not make a fresh instance look set up. */
export async function hasAnyUsers(): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>('SELECT EXISTS(SELECT 1 FROM users WHERE NOT is_system) AS exists');
  return row?.exists ?? false;
}

export async function findStoredUserByEmail(email: string): Promise<StoredUser | undefined> {
  // citext does the case-insensitive comparison; no manual lowercasing needed.
  const row = await queryOne<UserRow>('SELECT * FROM users WHERE email = $1', [email.trim()]);
  return row ? rowToStoredUser(row) : undefined;
}

export async function findStoredUserById(id: string): Promise<StoredUser | undefined> {
  const row = await queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
  return row ? rowToStoredUser(row) : undefined;
}

export async function findUserById(id: string): Promise<User | undefined> {
  const stored = await findStoredUserById(id);
  return stored ? toPublicUser(stored) : undefined;
}

/** True for a built-in system account (by id: the public visitor; or by the `is_system` flag of the row). */
export async function isSystemUserId(id: string): Promise<boolean> {
  if (id === PUBLIC_VISITOR_USER_ID) return true;
  const row = await queryOne<{ is_system: boolean }>('SELECT is_system FROM users WHERE id::text = $1', [id]);
  return row?.is_system ?? false;
}

/** Slugs of every published (`visibility: 'public'`) space — the only spaces a system user can read (session.ts). */
export async function listPublicSpaceSlugs(): Promise<string[]> {
  const rows = await query<{ slug: string }>("SELECT slug FROM spaces WHERE visibility = 'public'");
  return rows.map((r) => r.slug);
}

/** Every person (system accounts excluded) — GET /api/users, the access matrix, page-access candidates. */
export async function listUsers(): Promise<User[]> {
  const rows = await query<UserRow>('SELECT * FROM users WHERE NOT is_system ORDER BY created_at');
  return rows.map((r) => toPublicUser(rowToStoredUser(r)));
}

/**
 * Round 15: GET /api/spaces/:space/mentionable. Round 27 (access and rights)
 * removed the old `OR u.is_admin` bypass (spec §8: "only those who really see
 * the space can be mentioned" — an instance-admin with no explicit
 * membership no longer sees the space at all, so they must not be offered as
 * mentionable in it either) and replaced it with the same visibility rule
 * effectiveRole/membershipsFor use: explicit members of `space`, PLUS every
 * active user when the space's `visibility` is `'instance'` or `'public'` (spec §3 — an
 * implicit viewer can still be @mentioned, same as any other viewer).
 * Restricted to users who have actually chosen a username, name-sorted (no
 * limit/pagination: per DEV-PLAN round 15, "teams are small"). The rule is
 * access/roleSql.ts's (22.10.2026: one resolver), so a disabled user — who has
 * no role anywhere — is no longer offered.
 */
export async function listMentionableUsers(space: string): Promise<MentionableUser[]> {
  return query<MentionableUser>(
    `SELECT u.username, u.name
       FROM users u
       JOIN (${effectiveRolesSql({ space: '$1' })}) r ON r.user_id = u.id
      WHERE u.username IS NOT NULL
        AND NOT u.is_system
      ORDER BY u.name`,
    [space],
  );
}

export interface CreateUserInput {
  email: string;
  name: string;
  /** Optional — an account created by single sign-on (oidc.ts) has no password at all. */
  passwordHash?: string | null;
  isAdmin: boolean;
  username?: string;
}

export async function createUser(input: CreateUserInput): Promise<User> {
  try {
    const row = await queryOne<UserRow>(
      `INSERT INTO users (id, email, name, password_hash, is_admin, username)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        randomUUID(),
        input.email.trim(),
        input.name.trim(),
        input.passwordHash ?? null,
        input.isAdmin,
        input.username?.toLowerCase() ?? null,
      ],
    );
    return toPublicUser(rowToStoredUser(row!));
  } catch (err) {
    if (isUniqueViolation(err)) {
      const constraint = String((err as { constraint?: string }).constraint ?? '');
      if (constraint.includes('username')) throw conflict('this username is already taken');
      throw conflict('a user with this email already exists');
    }
    throw err;
  }
}

/** Round 10: PATCH /api/me/preferences {lang}. Set-only — the schema has no way to clear back to "no preference" (matches DEV-PLAN's PATCH .../preferences {lang} shape). */
export async function updateUserLang(userId: string, lang: UiLanguage): Promise<User> {
  const row = await queryOne<UserRow>('UPDATE users SET lang = $1 WHERE id = $2 RETURNING *', [lang, userId]);
  if (!row) throw notFound('user');
  return toPublicUser(rowToStoredUser(row));
}

/**
 * Round 15: PATCH /api/me/preferences {username}. `username` is lower-cased
 * here too (not just by the route's pre-validation normalize) so this
 * function keeps the "always lower-case in the DB" invariant on its own,
 * regardless of what a future caller passes in. `null` unsets the handle
 * (Postgres UNIQUE allows any number of NULLs, so this never conflicts).
 * A taken handle surfaces as 409 — the route wants a clear message, not a
 * raw pg unique-violation.
 */
export async function updateUsername(userId: string, username: string | null): Promise<User> {
  const normalized = username === null ? null : username.toLowerCase();
  let row: UserRow | undefined;
  try {
    row = await queryOne<UserRow>('UPDATE users SET username = $1 WHERE id = $2 RETURNING *', [normalized, userId]);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('this username is already taken');
    throw err;
  }
  if (!row) throw notFound('user');
  return toPublicUser(rowToStoredUser(row));
}

export interface UpdateUserInput {
  name?: string;
  username?: string | null;
  isAdmin?: boolean;
  passwordHash?: string;
  disabled?: boolean;
}

/** Pure business-rule check (no mutation): would this patch leave the instance with zero active admins? */
export async function wouldRemoveLastActiveAdmin(id: string, patch: UpdateUserInput): Promise<boolean> {
  const current = await findStoredUserById(id);
  if (!current || current.disabled || !current.isAdmin) return false; // not currently an active admin: nothing to protect
  const staysAdmin = patch.isAdmin === undefined ? true : patch.isAdmin;
  const staysEnabled = patch.disabled === undefined ? true : !patch.disabled;
  if (staysAdmin && staysEnabled) return false; // still an active admin after the patch
  const row = await queryOne<{ count: string }>('SELECT COUNT(*) FROM users WHERE id <> $1 AND is_admin AND NOT disabled', [id]);
  return Number(row?.count ?? '0') === 0;
}

export interface UpdateUserOptions {
  /** Who made the change, for the audit event; null/undefined = no signed-in actor (a sync job, a future SCIM call). */
  actorId?: string | null;
}

/**
 * Everything a deactivated account could still use, cut off in one place so no path forgets one:
 * browser sessions, personal API tokens, MCP OAuth grants (access + refresh tokens, pending
 * consents and unredeemed codes) and the live collab / notification sockets. Idempotent.
 */
export async function revokeAllAccessForUser(userId: string): Promise<RevokedAccess> {
  const sessions = await query<{ token_hash: string }>('DELETE FROM sessions WHERE user_id = $1 RETURNING token_hash', [userId]);
  const apiTokens = await query<{ id: string }>('UPDATE api_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id', [userId]);
  const oauthGrants = await revokeAllOAuthAccessForUser(userId);
  const sockets = disconnectUser(userId);
  return { sessions: sessions.length, apiTokens: apiTokens.length, oauthGrants, sockets };
}

/**
 * Caller (routes) is responsible for calling wouldRemoveLastActiveAdmin first and rejecting if true.
 * Disabling an account (any caller: the admin edit dialog, a future SCIM deactivation) revokes all of
 * its access (revokeAllAccessForUser) and writes `user.disable` with the counts; re-enabling writes
 * `user.enable`. Only a real change of state is audited.
 */
export async function updateUser(id: string, patch: UpdateUserInput, options: UpdateUserOptions = {}): Promise<User> {
  const current = await findStoredUserById(id);
  if (!current) throw conflict('user not found');
  let row: UserRow | undefined;
  try {
    row = await queryOne<UserRow>(
      `UPDATE users SET
         name = COALESCE($2, name),
         is_admin = COALESCE($3, is_admin),
         password_hash = COALESCE($4, password_hash),
         disabled = COALESCE($5, disabled),
         username = CASE WHEN $6 THEN $7 ELSE username END
       WHERE id = $1
       RETURNING *`,
      [id, patch.name?.trim() ?? null, patch.isAdmin ?? null, patch.passwordHash ?? null, patch.disabled ?? null, patch.username !== undefined, patch.username?.toLowerCase() ?? null],
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('this username is already taken');
    throw err;
  }
  if (patch.disabled === true) {
    // Even when it was already disabled: a leftover credential must not survive a repeated "disable".
    const revoked = await revokeAllAccessForUser(id);
    if (!current.disabled) recordAudit(options.actorId ?? null, 'user.disable', id, { email: current.email, name: current.name, ...revoked });
  } else if (patch.disabled === false && current.disabled) {
    recordAudit(options.actorId ?? null, 'user.enable', id, { email: current.email, name: current.name });
  }
  return toPublicUser(rowToStoredUser(row!));
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface CreatedSession {
  token: string;
  expiresAt: string;
}

/** Where a session was opened from — shown in the session list so a person can tell their devices apart. */
export interface SessionClientInfo {
  userAgent?: string | null;
  ip?: string | null;
}

const MAX_USER_AGENT_LENGTH = 300;
const MAX_IP_LENGTH = 64;

function cleanClientText(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const trimmed = value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);
  return trimmed || null;
}

/** Refuses (403) a system account: whatever path asked for it (login, Google, invite), a system user never gets a session. `client` (user agent, ip) is optional bookkeeping; the first authenticated request fills it in if the creator did not know it. */
export async function createSession(userId: string, client: SessionClientInfo = {}): Promise<CreatedSession> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + sessionTtlMs());
  const rows = await query<{ token_hash: string }>(
    `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent, ip, last_seen_at)
     SELECT $1::text, $2::uuid, $3::timestamptz, $4::text, $5::text, now()
      WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = $2::uuid AND is_system)
     RETURNING token_hash`,
    [hashToken(token), userId, expiresAt, cleanClientText(client.userAgent, MAX_USER_AGENT_LENGTH), cleanClientText(client.ip, MAX_IP_LENGTH)],
  );
  if (rows.length === 0) throw forbidden('a system account cannot sign in');
  return { token, expiresAt: expiresAt.toISOString() };
}

/** A session is "seen" at most this often (in-memory first, then the same rule in SQL so several instances agree). */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const sessionTouchedAt = new Map<string, number>();

/** Fire-and-forget bookkeeping: last_seen_at (throttled), and the client info when the row has none yet. Never blocks or fails the request. */
export function touchSession(token: string, client: SessionClientInfo = {}): void {
  const tokenHash = hashToken(token);
  const now = Date.now();
  const last = sessionTouchedAt.get(tokenHash);
  if (last !== undefined && now - last < SESSION_TOUCH_INTERVAL_MS) return;
  if (sessionTouchedAt.size > 5000) sessionTouchedAt.clear(); // a bound, not a cache: the SQL condition is the real throttle
  sessionTouchedAt.set(tokenHash, now);
  void query(
    `UPDATE sessions SET last_seen_at = now(),
            user_agent = COALESCE(user_agent, $2), ip = COALESCE(ip, $3)
      WHERE token_hash = $1
        AND (last_seen_at IS NULL OR last_seen_at < now() - ($4::int * interval '1 millisecond') OR user_agent IS NULL OR ip IS NULL)`,
    [tokenHash, cleanClientText(client.userAgent, MAX_USER_AGENT_LENGTH), cleanClientText(client.ip, MAX_IP_LENGTH), SESSION_TOUCH_INTERVAL_MS],
  ).catch(() => {});
}

/** Test-only: the touch throttle map is a module-level singleton. */
export function __resetSessionTouchThrottleForTests(): void {
  sessionTouchedAt.clear();
}

interface SessionRow {
  id: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string | null;
  expires_at: string;
  user_agent: string | null;
  ip: string | null;
}

/** Unexpired sessions of a user, most recently active first. `currentToken` (the caller's own cookie) marks the row that is "this device". */
export async function listActiveSessions(userId: string, currentToken?: string): Promise<SessionInfo[]> {
  const rows = await query<SessionRow>(
    `SELECT id, token_hash, created_at, last_seen_at, expires_at, user_agent, ip
       FROM sessions WHERE user_id = $1 AND expires_at > now()
      ORDER BY COALESCE(last_seen_at, created_at) DESC, created_at DESC`,
    [userId],
  );
  const currentHash = currentToken ? hashToken(currentToken) : undefined;
  return rows.map((r) => ({
    id: r.id,
    createdAt: new Date(r.created_at).toISOString(),
    lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
    expiresAt: new Date(r.expires_at).toISOString(),
    userAgent: r.user_agent,
    ip: r.ip,
    current: currentHash !== undefined && r.token_hash === currentHash,
  }));
}

/** Ends one session of this user (and closes its live sockets). False when the id is not an active session of that user. */
export async function revokeSessionById(userId: string, sessionId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return false;
  const rows = await query<{ token_hash: string }>('DELETE FROM sessions WHERE id = $1 AND user_id = $2 RETURNING token_hash', [sessionId, userId]);
  disconnectSessions(new Set(rows.map((r) => r.token_hash)));
  return rows.length > 0;
}

/** Ends every session of the user except `exceptToken` (omit it to end all of them). Returns how many were ended. */
export async function revokeSessionsForUser(userId: string, exceptToken?: string): Promise<number> {
  const rows = await query<{ token_hash: string }>('DELETE FROM sessions WHERE user_id = $1 AND ($2::text IS NULL OR token_hash <> $2) RETURNING token_hash', [
    userId,
    exceptToken ? hashToken(exceptToken) : null,
  ]);
  disconnectSessions(new Set(rows.map((r) => r.token_hash)));
  return rows.length;
}

/** Returns the session's userId, or undefined if the token is missing/expired (lazily pruning it). */
export async function resolveSessionUserId(token: string): Promise<string | undefined> {
  const row = await queryOne<{ user_id: string; expires_at: string }>('SELECT user_id, expires_at FROM sessions WHERE token_hash = $1', [
    hashToken(token),
  ]);
  if (!row) return undefined;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
    return undefined;
  }
  return row.user_id;
}

export async function destroySession(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  disconnectSessions(new Set([tokenHash]));
}

export async function destroyAllSessionsForUser(userId: string): Promise<void> {
  await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  disconnectUser(userId);
}

/**
 * Of these raw session tokens, the ones that — RIGHT NOW — belong to an
 * unexpired session of an active user who can read `space`. The batch twin of
 * `session.effectiveRole(user, space) !== undefined`: the same rule (an
 * explicit membership, or an `instance`-visible space; a disabled user gets
 * nothing; no instance-admin bypass), answered for a whole set of live sockets
 * in one query instead of three queries per socket. Used to decide who may be
 * told "the tree of this space changed" (server/treeSignal.ts) — a socket is
 * authenticated once, at upgrade, so the answer has to be re-checked at send
 * time or a logged-out tab and a removed member would keep listening.
 * server/treeSignal.test.ts asserts this stays equal to effectiveRole.
 */
export async function sessionsThatCanReadSpace(space: string, tokens: readonly string[]): Promise<Set<string>> {
  if (tokens.length === 0) return new Set();
  const byHash = new Map(tokens.map((token) => [hashToken(token), token]));
  const rows = await query<{ token_hash: string }>(
    `SELECT s.token_hash
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ANY($2::text[])
        AND s.expires_at > now()
        AND NOT u.disabled
        AND EXISTS (SELECT 1 FROM (${effectiveRolesSql({ user: 'u.id', space: '$1' })}) r)`,
    [space, [...byHash.keys()]],
  );
  const allowed = new Set<string>();
  for (const row of rows) {
    const token = byHash.get(row.token_hash);
    if (token !== undefined) allowed.add(token);
  }
  return allowed;
}

// ---------------------------------------------------------------------------
// API tokens (PAT, round 7)
// ---------------------------------------------------------------------------

interface ApiTokenRow {
  id: string;
  user_id: string;
  name: string;
  scopes: ApiTokenScope[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

function rowToApiTokenInfo(row: ApiTokenRow): ApiTokenInfo {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
  };
}

/** Generates + stores a new PAT; the raw token is returned ONLY here — the row keeps just its sha256, same as sessions. */
export async function createApiToken(userId: string, name: string, scopes: ApiTokenScope[]): Promise<CreatedApiToken> {
  if (await isSystemUserId(userId)) throw forbidden('a system account cannot hold API tokens');
  const raw = `folio_pat_${randomBytes(16).toString('hex')}`;
  const row = await queryOne<ApiTokenRow>(`INSERT INTO api_tokens (user_id, name, token_hash, scopes) VALUES ($1, $2, $3, $4) RETURNING *`, [
    userId,
    name.trim(),
    hashToken(raw),
    scopes,
  ]);
  return { ...rowToApiTokenInfo(row!), token: raw };
}

/** Revoked tokens are excluded — the row itself stays (soft revoke, auditable), just no longer listed as active. */
export async function listApiTokens(userId: string): Promise<ApiTokenInfo[]> {
  const rows = await query<ApiTokenRow>('SELECT * FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at', [userId]);
  return rows.map(rowToApiTokenInfo);
}

export interface ResolvedApiToken {
  userId: string;
  tokenId: string;
  scopes: ApiTokenScope[];
}

/** Resolves a raw PAT to its owner + scopes. undefined for unknown OR revoked (both look the same to a caller — no oracle for "which reason"). */
export async function resolveApiToken(rawToken: string): Promise<ResolvedApiToken | undefined> {
  const row = await queryOne<ApiTokenRow>('SELECT * FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NULL', [hashToken(rawToken)]);
  if (!row) return undefined;
  return { userId: row.user_id, tokenId: row.id, scopes: row.scopes };
}

/** Soft revoke (sets revoked_at, never deletes the row). False if no matching active token — caller decides 404 vs "already gone" framing; either way it's not usable afterward. */
export async function revokeApiToken(userId: string, tokenId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
    [tokenId, userId],
  );
  return rows.length > 0;
}

// last_used_at is bookkeeping, not correctness-critical — debounced in memory
// (round 7: "a minute") so a busy caller (an MCP client polling tools, a script
// hitting the REST API in a loop) doesn't turn every single request into an
// extra write. Fire-and-forget: never blocks or fails the request it's riding
// along with.
const LAST_USED_DEBOUNCE_MS = 60_000;
const lastTouchedAt = new Map<string, number>();

export function touchApiTokenLastUsed(tokenId: string): void {
  const now = Date.now();
  const last = lastTouchedAt.get(tokenId);
  if (last !== undefined && now - last < LAST_USED_DEBOUNCE_MS) return;
  lastTouchedAt.set(tokenId, now);
  void query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [tokenId]).catch(() => {});
}

/** Test-only escape hatch: the debounce map is a module-level singleton. */
export function __resetApiTokenLastUsedDebounceForTests(): void {
  lastTouchedAt.clear();
}

// ---------------------------------------------------------------------------
// Space memberships
// ---------------------------------------------------------------------------

export async function getMembershipRole(space: string, userId: string): Promise<SpaceRole | undefined> {
  const row = await queryOne<{ role: SpaceRole }>('SELECT role FROM space_members WHERE space_slug = $1 AND user_id = $2', [space, userId]);
  return row?.role;
}

export async function listMembersOf(space: string): Promise<Record<string, SpaceRole>> {
  const rows = await query<{ user_id: string; role: SpaceRole }>('SELECT user_id, role FROM space_members WHERE space_slug = $1', [space]);
  return Object.fromEntries(rows.map((r) => [r.user_id, r.role]));
}

/**
 * Every member of `space` with full user details attached (name/email/
 * username/etc — password hash stripped), for the members dialog
 * (GET /api/spaces/:space/members) and round 22's admin spaces list alike.
 * A membership row whose user has since been deleted is silently omitted
 * rather than surfaced as a broken entry (defensive; space_members.user_id
 * is itself FK ON DELETE CASCADE, so this window shouldn't normally exist).
 */
export async function listMembersWithDetails(space: string): Promise<SpaceMemberInfo[]> {
  const roles = await listMembersOf(space);
  const members: SpaceMemberInfo[] = [];
  for (const [userId, role] of Object.entries(roles)) {
    const stored = await findStoredUserById(userId);
    if (!stored) continue;
    const { passwordHash: _passwordHash, ...user } = stored;
    members.push({ user, role });
  }
  return members;
}

export async function spacesForUser(userId: string): Promise<Record<string, SpaceRole>> {
  const rows = await query<{ space_slug: string; role: SpaceRole }>('SELECT space_slug, role FROM space_members WHERE user_id = $1', [userId]);
  return Object.fromEntries(rows.map((r) => [r.space_slug, r.role]));
}

/**
 * Slugs of the spaces where `userId`'s effective role is `admin` (sorted, byte order) — the
 * "space admin" of canAdministerSpace without the instance-admin bypass (access/roleSql.ts; an
 * implicit grant is never `admin`). A trashed space is deleted from `spaces` and its memberships
 * cascade away, so it never counts until restored.
 */
export async function listAdminSpaceSlugs(userId: string): Promise<string[]> {
  const rows = await query<{ space_slug: string }>(
    `SELECT r.space_slug FROM (${effectiveRolesSql({ user: '$1' })}) r
      WHERE r.role = 'admin' ORDER BY r.space_slug COLLATE "C"`,
    [userId],
  );
  return rows.map((r) => r.space_slug);
}

/** Round 27: GET /api/access/matrix's roles[userId][space] grid — every EXPLICIT membership, instance-wide, in one query (a per-user/per-space loop would be O(users*spaces) round trips). Implicit `visibility: 'instance'` viewer grants are deliberately NOT included — the matrix UI derives those from spaces[].visibility instead (see AccessMatrixResponse's doc comment in shared/contracts.ts). */
export async function listAllMemberships(): Promise<{ userId: string; space: string; role: SpaceRole }[]> {
  const rows = await query<{ user_id: string; space_slug: string; role: SpaceRole }>('SELECT user_id, space_slug, role FROM space_members');
  return rows.map((r) => ({ userId: r.user_id, space: r.space_slug, role: r.role }));
}

// ---------------------------------------------------------------------------
// Space visibility (round 27, spec-access.md §3)
// ---------------------------------------------------------------------------

export async function getSpaceVisibility(space: string): Promise<SpaceVisibility | undefined> {
  const row = await queryOne<{ visibility: SpaceVisibility }>('SELECT visibility FROM spaces WHERE slug = $1', [space]);
  return row?.visibility;
}

/** Every space slug currently `visibility: 'instance'` or `'public'` (a public space is also open to the whole instance) — used by membershipsFor to add each as an implicit viewer entry. */
export async function listInstanceVisibleSpaceSlugs(): Promise<string[]> {
  const rows = await query<{ slug: string }>("SELECT slug FROM spaces WHERE visibility IN ('instance', 'public')");
  return rows.map((r) => r.slug);
}

/** Throws 404 (not a silent no-op) if `space` doesn't exist — mirrors setMembership's caller expectations elsewhere in this file. */
export async function setSpaceVisibility(space: string, visibility: SpaceVisibility): Promise<void> {
  const rows = await query<{ slug: string }>('UPDATE spaces SET visibility = $2 WHERE slug = $1 RETURNING slug', [space, visibility]);
  if (rows.length === 0) throw notFound('space');
}

// ---------------------------------------------------------------------------
// Access-change log (round 27, spec-access.md §2.4/§7 — audit_log rows for
// access.grant/access.revoke/access.self_grant/space.visibility/space.public_settings,
// read back for the space's "Access changes" feed and a user's own access panel).
// ---------------------------------------------------------------------------

const ACCESS_LOG_ACTIONS = [
  'access.grant',
  'access.revoke',
  'access.self_grant',
  'access.group_grant',
  'access.group_revoke',
  'space.visibility',
  'space.public_settings',
];

/** Group events (053): target = the group id. A space's feed shows those of the groups that hold a role in it now; a user's panel those naming them (meta.targetUserId). */
const GROUP_LOG_ACTIONS = ['group.create', 'group.update', 'group.archive', 'group.restore', 'group.delete', 'group.member_add', 'group.member_remove', 'group.manager_set'];

/** Space-level events: they have no target user, so they only belong to the space's own feed (never a single user's access panel). */
const SPACE_LEVEL_ACCESS_LOG_ACTIONS = ['space.visibility', 'space.public_settings', 'access.group_grant', 'access.group_revoke'];

interface AuditLogRow {
  id: string;
  action: string;
  actor_id: string | null;
  target: string | null;
  meta: Record<string, unknown> | null;
  at: string;
  actor_name: string | null;
  /** Only listAccessLogForSpace selects it: the name of meta.targetUserId, null when that user is gone. */
  target_user_name?: string | null;
}

/** actor_name is null when actor_id is null (fire-and-forget guest/system action, rare for access events) OR the actor user has since been deleted (audit_log.actor_id is ON DELETE SET NULL — see audit.ts) — either way the row itself is kept, just with a placeholder name. */
function rowToAccessLogEntry(row: AuditLogRow, language?: string): AccessLogEntry {
  return {
    id: String(row.id),
    action: row.action as AccessLogEntry['action'],
    actorId: row.actor_id,
    actorName: row.actor_name ?? serverText('audit.deletedUser', language),
    target: row.target ?? '',
    meta: withTargetUserName(row, language),
    at: new Date(row.at).toISOString(),
  };
}

/** A space's log names the person each access.* event was about: their current name, a placeholder once the account is deleted. */
function withTargetUserName(row: AuditLogRow, language?: string): Record<string, unknown> {
  const meta = row.meta ?? {};
  if (row.target_user_name === undefined || typeof meta.targetUserId !== 'string' || typeof meta.targetUserName === 'string') return meta;
  return { ...meta, targetUserName: row.target_user_name ?? serverText('audit.deletedUser', language) };
}

/** GET /api/spaces/:space/access-log — newest first. */
export async function listAccessLogForSpace(space: string, limit = 50, language?: string): Promise<AccessLogEntry[]> {
  const rows = await query<AuditLogRow>(
    `SELECT al.id, al.action, al.actor_id, al.target, al.meta, al.at, u.name AS actor_name, tu.name AS target_user_name
       FROM audit_log al
       LEFT JOIN users u ON u.id = al.actor_id
       LEFT JOIN users tu ON tu.id::text = al.meta ->> 'targetUserId'
      WHERE (al.action = ANY($1) AND al.target = $2)
         OR (al.action = ANY($4) AND al.target IN (SELECT r.group_id::text FROM space_group_roles r WHERE r.space_slug = $2))
      ORDER BY al.at DESC
      LIMIT $3`,
    [ACCESS_LOG_ACTIONS, space, limit, GROUP_LOG_ACTIONS],
  );
  return rows.map((row) => rowToAccessLogEntry(row, language));
}

/** GET /api/users/:id/access — every access.* event where THIS user was the target (meta.targetUserId), newest first. space.visibility / space.public_settings events have no target user, so they're excluded here (they belong to the space's own log, not any one user's). */
export async function listAccessLogForUser(userId: string, limit = 50, language?: string): Promise<AccessLogEntry[]> {
  const rows = await query<AuditLogRow>(
    `SELECT al.id, al.action, al.actor_id, al.target, al.meta, al.at, u.name AS actor_name
       FROM audit_log al
       LEFT JOIN users u ON u.id = al.actor_id
      WHERE al.action = ANY($1) AND al.meta ->> 'targetUserId' = $2
      ORDER BY al.at DESC
      LIMIT $3`,
    [[...ACCESS_LOG_ACTIONS.filter((a) => !SPACE_LEVEL_ACCESS_LOG_ACTIONS.includes(a)), ...GROUP_LOG_ACTIONS], userId, limit],
  );
  return rows.map((row) => rowToAccessLogEntry(row, language));
}

/**
 * The last-admin guard's count (spec-access.md §5, §15): direct admins other
 * than `excludingUserId` (whose DIRECT row is about to change), plus active
 * members of active groups holding `admin` in the space — distinct people, so
 * someone who stays admin through a group keeps the space administered.
 */
export async function countSpaceAdmins(space: string, excludingUserId?: string): Promise<number> {
  const row = await queryOne<{ count: string }>(SPACE_ADMINS_COUNT_SQL, [space, excludingUserId ?? null]);
  return Number(row?.count ?? '0');
}

export async function setMembership(space: string, userId: string, role: SpaceRole): Promise<void> {
  await query(
    `INSERT INTO space_members (space_slug, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (space_slug, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [space, userId, role],
  );
}

export async function removeMembership(space: string, userId: string): Promise<void> {
  await query('DELETE FROM space_members WHERE space_slug = $1 AND user_id = $2', [space, userId]);
}

/**
 * Explicit cleanup for callers that want it, but no longer load-bearing:
 * space_members.space_slug REFERENCES spaces(slug) ON DELETE CASCADE, so
 * deleting the spaces row (storage.ts's whole-space delete path) already
 * takes memberships (and pages_index, and links) with it.
 */
export async function deleteAllMembershipsForSpace(space: string): Promise<void> {
  await query('DELETE FROM space_members WHERE space_slug = $1', [space]);
}

// ---------------------------------------------------------------------------
// Stars
// ---------------------------------------------------------------------------

export async function getStars(userId: string): Promise<Stars> {
  // ORDER BY created_at, then a plain .filter() per kind below — .filter() preserves
  // the relative order of whatever passes it, so each of the three arrays comes out
  // in the user's own insertion order (matters for emojis: it's a personal, ordered
  // favorites bar, not a set).
  const rows = await query<{ kind: 'space' | 'page' | 'emoji'; key: string }>('SELECT kind, key FROM stars WHERE user_id = $1 ORDER BY created_at', [
    userId,
  ]);
  return {
    spaces: rows.filter((r) => r.kind === 'space').map((r) => r.key),
    pages: rows.filter((r) => r.kind === 'page').map((r) => r.key),
    emojis: rows.filter((r) => r.kind === 'emoji').map((r) => r.key),
  };
}

async function setStar(userId: string, kind: 'space' | 'page' | 'emoji', key: string, starred: boolean): Promise<Stars> {
  if (starred) {
    await query('INSERT INTO stars (user_id, kind, key) VALUES ($1, $2, $3) ON CONFLICT (user_id, kind, key) DO NOTHING', [userId, kind, key]);
  } else {
    await query('DELETE FROM stars WHERE user_id = $1 AND kind = $2 AND key = $3', [userId, kind, key]);
  }
  return getStars(userId);
}

export function setSpaceStar(userId: string, slug: string, starred: boolean): Promise<Stars> {
  return setStar(userId, 'space', slug, starred);
}
export function setPageStar(userId: string, pageId: string, starred: boolean): Promise<Stars> {
  return setStar(userId, 'page', pageId, starred);
}
export function setEmojiStar(userId: string, emoji: string, starred: boolean): Promise<Stars> {
  return setStar(userId, 'emoji', emoji, starred);
}

// ---------------------------------------------------------------------------

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
