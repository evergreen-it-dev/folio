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
  Stars,
  UiLanguage,
  User,
} from '../../shared/contracts.js';
import { conflict, notFound } from '../errors.js';
import { query, queryOne } from '../db/pool.js';
import { serverText } from '../serverText.js';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface StoredUser extends User {
  /** Round 32 (Google OAuth): NULL for a Google-only account that has never set a password — see passwords.ts's verifyPassword, which treats NULL as "no password can ever match", never comparing against it. */
  passwordHash: string | null;
  /** Round 32: Google's stable account id (JWT `sub`), or undefined for a password-only user. Never the email — that can change on Google's side. */
  googleSub?: string;
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
  /** Round 32: NULL = account not linked to Google. */
  google_sub: string | null;
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
    // DB CHECK constraint already guarantees this is 'uk'|'en'|'ru'|null; the
    // cast just tells TS what the CHECK already enforces at the DB layer.
    lang: (row.lang as UiLanguage | null) ?? undefined,
    username: row.username ?? undefined,
    googleSub: row.google_sub ?? undefined,
  };
}
function toPublicUser(u: StoredUser): User {
  // googleSub is an account identifier, not a secret, but it's still internal
  // bookkeeping (google.ts's own lookup key) — never returned over the API,
  // same as passwordHash.
  const { passwordHash: _passwordHash, googleSub: _googleSub, ...rest } = u;
  return rest;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}


// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function hasAnyUsers(): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>('SELECT EXISTS(SELECT 1 FROM users) AS exists');
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

/** Round 32: the Google sign-in callback's first lookup — an account already linked to this Google subject id. */
export async function findStoredUserByGoogleSub(googleSub: string): Promise<StoredUser | undefined> {
  const row = await queryOne<UserRow>('SELECT * FROM users WHERE google_sub = $1', [googleSub]);
  return row ? rowToStoredUser(row) : undefined;
}

export async function findUserById(id: string): Promise<User | undefined> {
  const stored = await findStoredUserById(id);
  return stored ? toPublicUser(stored) : undefined;
}

export async function listUsers(): Promise<User[]> {
  const rows = await query<UserRow>('SELECT * FROM users ORDER BY created_at');
  return rows.map((r) => toPublicUser(rowToStoredUser(r)));
}

/**
 * Round 15: GET /api/spaces/:space/mentionable. Round 27 (access and rights)
 * removed the old `OR u.is_admin` bypass (spec §8: "only those who really see
 * the space can be mentioned" — an instance-admin with no explicit
 * membership no longer sees the space at all, so they must not be offered as
 * mentionable in it either) and replaced it with the same visibility rule
 * effectiveRole/membershipsFor use: explicit members of `space`, PLUS every
 * active user when the space's `visibility` is `'instance'` (spec §3 — an
 * implicit viewer can still be @mentioned, same as any other viewer).
 * Restricted to users who have actually chosen a username, name-sorted (no
 * limit/pagination: per DEV-PLAN round 15, "teams are small"). Same as the
 * existing /members listing, this does not exclude disabled users; nothing
 * in round 15 (or round 27) asks for that extra filter and the sibling
 * endpoint doesn't apply one either.
 */
export async function listMentionableUsers(space: string): Promise<MentionableUser[]> {
  return query<MentionableUser>(
    `SELECT u.username, u.name
       FROM users u
       LEFT JOIN space_members sm ON sm.user_id = u.id AND sm.space_slug = $1
       LEFT JOIN spaces sp ON sp.slug = $1
      WHERE u.username IS NOT NULL
        AND (sm.user_id IS NOT NULL OR sp.visibility = 'instance')
      ORDER BY u.name`,
    [space],
  );
}

export interface CreateUserInput {
  email: string;
  name: string;
  /** Round 32: optional — a Google-only account (google.ts) is created with no password at all. */
  passwordHash?: string | null;
  isAdmin: boolean;
  username?: string;
  /** Round 32: set only when creating an account straight from a Google sign-in. */
  googleSub?: string;
}

export async function createUser(input: CreateUserInput): Promise<User> {
  try {
    const row = await queryOne<UserRow>(
      `INSERT INTO users (id, email, name, password_hash, is_admin, username, google_sub)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        randomUUID(),
        input.email.trim(),
        input.name.trim(),
        input.passwordHash ?? null,
        input.isAdmin,
        input.username?.toLowerCase() ?? null,
        input.googleSub ?? null,
      ],
    );
    return toPublicUser(rowToStoredUser(row!));
  } catch (err) {
    if (isUniqueViolation(err)) {
      const constraint = String((err as { constraint?: string }).constraint ?? '');
      if (constraint.includes('username')) throw conflict('this username is already taken');
      if (constraint.includes('google_sub')) throw conflict('this Google account is already linked to another user');
      throw conflict('a user with this email already exists');
    }
    throw err;
  }
}

/** Round 32: links an existing (password) account to a Google subject id, the first time that email signs in with Google. */
export async function linkGoogleAccount(userId: string, googleSub: string): Promise<StoredUser> {
  let row: UserRow | undefined;
  try {
    row = await queryOne<UserRow>('UPDATE users SET google_sub = $1 WHERE id = $2 RETURNING *', [googleSub, userId]);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('this Google account is already linked to another user');
    throw err;
  }
  if (!row) throw notFound('user');
  return rowToStoredUser(row);
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

/** Caller (routes) is responsible for calling wouldRemoveLastActiveAdmin first and rejecting if true. */
export async function updateUser(id: string, patch: UpdateUserInput): Promise<User> {
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
  if (patch.disabled === true) await destroyAllSessionsForUser(id);
  return toPublicUser(rowToStoredUser(row!));
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface CreatedSession {
  token: string;
  expiresAt: string;
}

export async function createSession(userId: string): Promise<CreatedSession> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [hashToken(token), userId, expiresAt]);
  return { token, expiresAt: expiresAt.toISOString() };
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
  await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

export async function destroyAllSessionsForUser(userId: string): Promise<void> {
  await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
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
    const { passwordHash: _passwordHash, googleSub: _googleSub, ...user } = stored;
    members.push({ user, role });
  }
  return members;
}

export async function spacesForUser(userId: string): Promise<Record<string, SpaceRole>> {
  const rows = await query<{ space_slug: string; role: SpaceRole }>('SELECT space_slug, role FROM space_members WHERE user_id = $1', [userId]);
  return Object.fromEntries(rows.map((r) => [r.space_slug, r.role]));
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

/** Every space slug currently `visibility: 'instance'` — used by membershipsFor to add each as an implicit viewer entry. */
export async function listInstanceVisibleSpaceSlugs(): Promise<string[]> {
  const rows = await query<{ slug: string }>("SELECT slug FROM spaces WHERE visibility = 'instance'");
  return rows.map((r) => r.slug);
}

/** Throws 404 (not a silent no-op) if `space` doesn't exist — mirrors setMembership's caller expectations elsewhere in this file. */
export async function setSpaceVisibility(space: string, visibility: SpaceVisibility): Promise<void> {
  const rows = await query<{ slug: string }>('UPDATE spaces SET visibility = $2 WHERE slug = $1 RETURNING slug', [space, visibility]);
  if (rows.length === 0) throw notFound('space');
}

// ---------------------------------------------------------------------------
// Access-change log (round 27, spec-access.md §2.4/§7 — audit_log rows for
// access.grant/access.revoke/access.self_grant/space.visibility, read back
// for the space's "Access changes" feed and a user's own access panel).
// ---------------------------------------------------------------------------

const ACCESS_LOG_ACTIONS = ['access.grant', 'access.revoke', 'access.self_grant', 'space.visibility'];

interface AuditLogRow {
  id: string;
  action: string;
  actor_id: string | null;
  target: string | null;
  meta: Record<string, unknown> | null;
  at: string;
  actor_name: string | null;
}

/** actor_name is null when actor_id is null (fire-and-forget guest/system action, rare for access events) OR the actor user has since been deleted (audit_log.actor_id is ON DELETE SET NULL — see audit.ts) — either way the row itself is kept, just with a placeholder name. */
function rowToAccessLogEntry(row: AuditLogRow, language?: string): AccessLogEntry {
  return {
    id: String(row.id),
    action: row.action as AccessLogEntry['action'],
    actorId: row.actor_id,
    actorName: row.actor_name ?? serverText('audit.deletedUser', language),
    target: row.target ?? '',
    meta: row.meta ?? {},
    at: new Date(row.at).toISOString(),
  };
}

/** GET /api/spaces/:space/access-log — newest first. */
export async function listAccessLogForSpace(space: string, limit = 50, language?: string): Promise<AccessLogEntry[]> {
  const rows = await query<AuditLogRow>(
    `SELECT al.id, al.action, al.actor_id, al.target, al.meta, al.at, u.name AS actor_name
       FROM audit_log al
       LEFT JOIN users u ON u.id = al.actor_id
      WHERE al.action = ANY($1) AND al.target = $2
      ORDER BY al.at DESC
      LIMIT $3`,
    [ACCESS_LOG_ACTIONS, space, limit],
  );
  return rows.map((row) => rowToAccessLogEntry(row, language));
}

/** GET /api/users/:id/access — every access.* event where THIS user was the target (meta.targetUserId), newest first. space.visibility events have no target user, so they're excluded here (they belong to the space's own log, not any one user's). */
export async function listAccessLogForUser(userId: string, limit = 50, language?: string): Promise<AccessLogEntry[]> {
  const rows = await query<AuditLogRow>(
    `SELECT al.id, al.action, al.actor_id, al.target, al.meta, al.at, u.name AS actor_name
       FROM audit_log al
       LEFT JOIN users u ON u.id = al.actor_id
      WHERE al.action = ANY($1) AND al.meta ->> 'targetUserId' = $2
      ORDER BY al.at DESC
      LIMIT $3`,
    [ACCESS_LOG_ACTIONS.filter((a) => a !== 'space.visibility'), userId, limit],
  );
  return rows.map((row) => rowToAccessLogEntry(row, language));
}

export async function countSpaceAdmins(space: string, excludingUserId?: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    "SELECT COUNT(*) FROM space_members WHERE space_slug = $1 AND role = 'admin' AND ($2::uuid IS NULL OR user_id <> $2::uuid)",
    [space, excludingUserId ?? null],
  );
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
