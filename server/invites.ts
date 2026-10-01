/**
 * Invites by link (round 9): a token that grants a fixed set of space
 * memberships (and optionally instance-admin) to whoever accepts it, up to
 * some number of times, before it expires or is revoked. Same plaintext-token
 * shape as shares.ts's share links, for the same reason: GET /api/invites
 * keeps re-showing the full inviteable URL every time it's listed, not a
 * one-time reveal like a PAT.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { InviteInfo, SpaceRole } from '../shared/contracts.js';
import { query, queryOne } from './db/pool.js';
import { publicUrlOrOrigin } from './publicUrl.js';

export interface InviteMembership {
  space: string;
  role: SpaceRole;
}

interface InviteRow {
  id: string;
  token: string;
  created_by: string;
  created_by_name: string; // joined from users.name
  is_admin: boolean;
  memberships: InviteMembership[]; // jsonb column -- pg parses this back to a JS value automatically
  email: string | null;
  expires_at: string;
  max_uses: number;
  uses: number;
  revoked_at: string | null;
  created_at: string;
}

/** PUBLIC_URL (scheme-normalized — see publicUrl.ts) if set; otherwise the caller-supplied request origin (same fallback shares.ts uses). */
function inviteUrl(token: string, originFallback: string): string {
  return `${publicUrlOrOrigin(originFallback)}/invite/${token}`;
}

function rowToInfo(row: InviteRow, originFallback: string): InviteInfo {
  return {
    id: row.id,
    url: inviteUrl(row.token, originFallback),
    memberships: row.memberships,
    isAdmin: row.is_admin,
    email: row.email,
    expiresAt: new Date(row.expires_at).toISOString(),
    maxUses: row.max_uses,
    uses: row.uses,
    createdBy: row.created_by_name,
    createdAt: new Date(row.created_at).toISOString(),
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  };
}

const INVITE_SELECT = `SELECT i.*, u.name AS created_by_name FROM invites i JOIN users u ON u.id = i.created_by`;

export interface CreateInviteInput {
  memberships: InviteMembership[];
  isAdmin: boolean;
  expiresInDays: number;
  maxUses: number;
  email?: string;
}

export async function createInvite(input: CreateInviteInput, createdBy: string, originFallback: string): Promise<InviteInfo> {
  const token = randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);
  await query(
    `INSERT INTO invites (id, token, created_by, is_admin, memberships, email, expires_at, max_uses)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [randomUUID(), token, createdBy, input.isAdmin, JSON.stringify(input.memberships), input.email ?? null, expiresAt, input.maxUses],
  );
  const row = await queryOne<InviteRow>(`${INVITE_SELECT} WHERE i.token = $1`, [token]);
  return rowToInfo(row!, originFallback);
}

/** Instance admin's list: every invite that exists, most recent first. */
export async function listAllInvites(originFallback: string): Promise<InviteInfo[]> {
  const rows = await query<InviteRow>(`${INVITE_SELECT} ORDER BY i.created_at DESC`);
  return rows.map((r) => rowToInfo(r, originFallback));
}

/**
 * Space admin's list: invites THEY created — not re-derived from current
 * space-admin status of whatever spaces the invite happens to name, which
 * would be a much stranger definition of "mine" and could surface
 * someone ELSE's invite just because it touches a space this caller now
 * also admins. Creation itself is already restricted to spaces the creator
 * admins AT THAT TIME (see routes.ts's POST /api/invites), so this is simply
 * "the invites this admin has sent".
 */
export async function listInvitesCreatedBy(userId: string, originFallback: string): Promise<InviteInfo[]> {
  const rows = await query<InviteRow>(`${INVITE_SELECT} WHERE i.created_by = $1 ORDER BY i.created_at DESC`, [userId]);
  return rows.map((r) => rowToInfo(r, originFallback));
}

export interface InviteForRevoke {
  createdBy: string;
}

/** For the DELETE route's own creator-or-instance-admin authorization check. */
export async function getInviteForRevoke(id: string): Promise<InviteForRevoke | undefined> {
  const row = await queryOne<{ created_by: string }>('SELECT created_by FROM invites WHERE id = $1 AND revoked_at IS NULL', [id]);
  return row ? { createdBy: row.created_by } : undefined;
}

/** Soft revoke — the row stays (auditable, and still shows up in a creator's own list), just no longer acceptable. */
export async function revokeInvite(id: string): Promise<void> {
  await query('UPDATE invites SET revoked_at = now() WHERE id = $1', [id]);
}

// ---------------------------------------------------------------------------
// Public surface: GET /api/invite/:token (never 401 — validity is IN the
// payload, per DEV-PLAN) and POST /api/invite/:token/accept.
// ---------------------------------------------------------------------------

export interface RawInvite {
  id: string;
  createdByName: string;
  isAdmin: boolean;
  memberships: InviteMembership[];
  email: string | null;
  expiresAt: string;
  maxUses: number;
  uses: number;
  revokedAt: string | null;
}

function rowToRaw(row: InviteRow): RawInvite {
  return {
    id: row.id,
    createdByName: row.created_by_name,
    isAdmin: row.is_admin,
    memberships: row.memberships,
    email: row.email,
    expiresAt: new Date(row.expires_at).toISOString(),
    maxUses: row.max_uses,
    uses: row.uses,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  };
}

/**
 * Unlike resolveShareToken (server/shares.ts), this returns the row
 * REGARDLESS of validity — GET /api/invite/:token has to distinguish
 * not_found from revoked/expired/exhausted (InvitePublicInfo.reason), not
 * just collapse everything to "no".
 */
export async function getInviteByToken(token: string): Promise<RawInvite | undefined> {
  const row = await queryOne<InviteRow>(`${INVITE_SELECT} WHERE i.token = $1`, [token]);
  return row ? rowToRaw(row) : undefined;
}

export type InviteInvalidReason = 'expired' | 'revoked' | 'exhausted' | 'not_found';

/** Pure check, no DB access — shared by the public GET (for its `reason` field) and the accept route (for its 410 case). */
export function invalidReason(invite: RawInvite | undefined): InviteInvalidReason | undefined {
  if (!invite) return 'not_found';
  if (invite.revokedAt) return 'revoked';
  if (new Date(invite.expiresAt).getTime() < Date.now()) return 'expired';
  if (invite.maxUses !== 0 && invite.uses >= invite.maxUses) return 'exhausted';
  return undefined;
}

export interface ClaimedInvite {
  id: string;
  isAdmin: boolean;
  memberships: InviteMembership[];
  email: string | null;
}

/**
 * Atomically claims one use of the invite. The WHERE clause is evaluated
 * against the CURRENT row under Postgres's normal row-level locking for an
 * UPDATE — a second concurrent UPDATE against the same row blocks until the
 * first commits, then re-evaluates its OWN WHERE against the now-incremented
 * `uses`. Two parallel accepts of a max_uses=1 invite can therefore never
 * BOTH claim it: exactly one UPDATE matches a row and returns it; the other
 * matches zero rows and gets undefined back. Revocation/expiry are
 * re-checked here too (not just by the caller's earlier getInviteByToken),
 * closing the same race for those.
 */
export async function claimInviteUse(token: string): Promise<ClaimedInvite | undefined> {
  const row = await queryOne<InviteRow>(
    `UPDATE invites SET uses = uses + 1
     WHERE token = $1 AND revoked_at IS NULL AND expires_at > now() AND (max_uses = 0 OR uses < max_uses)
     RETURNING *`,
    [token],
  );
  if (!row) return undefined;
  return { id: row.id, isAdmin: row.is_admin, memberships: row.memberships, email: row.email };
}
