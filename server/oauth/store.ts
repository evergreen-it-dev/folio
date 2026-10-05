/**
 * Persistence for OAuth 2.1 (migration 034). Every secret — authorization-request id, code,
 * access token, refresh token — is generated here, returned to the caller ONCE, and stored only
 * as sha256, exactly like sessions and PATs. Single-use and rotation rules are enforced with
 * atomic UPDATE ... WHERE used_at IS NULL, never read-then-write.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { ApiTokenScope, OAuthConnectionInfo } from '../../shared/contracts.js';
import { query, queryOne } from '../db/pool.js';
import { redirectHost } from './validate.js';

export const ACCESS_TOKEN_PREFIX = 'folio_oat_';
export const REFRESH_TOKEN_PREFIX = 'folio_ort_';
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days, sliding (each rotation issues a new one)
export const CODE_TTL_SECONDS = 60;
export const AUTHZ_REQUEST_TTL_SECONDS = 10 * 60;

export function hashSecret(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
const addSeconds = (s: number): Date => new Date(Date.now() + s * 1000);

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  source: 'dcr' | 'cimd';
  clientUri: string | null;
  fetchedAt: Date | null;
}

interface ClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  source: 'dcr' | 'cimd';
  client_uri: string | null;
  fetched_at: string | null;
}
const rowToClient = (r: ClientRow): OAuthClient => ({
  clientId: r.client_id,
  clientName: r.client_name,
  redirectUris: r.redirect_uris,
  source: r.source,
  clientUri: r.client_uri,
  fetchedAt: r.fetched_at ? new Date(r.fetched_at) : null,
});

export async function getClient(clientId: string): Promise<OAuthClient | undefined> {
  const row = await queryOne<ClientRow>('SELECT * FROM oauth_clients WHERE client_id = $1', [clientId]);
  return row ? rowToClient(row) : undefined;
}

export async function createDcrClient(input: { clientName: string; redirectUris: string[]; clientUri: string | null }): Promise<OAuthClient> {
  const clientId = `folio_c_${randomBytes(16).toString('hex')}`;
  const row = await queryOne<ClientRow>(
    `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, source, client_uri) VALUES ($1, $2, $3, 'dcr', $4) RETURNING *`,
    [clientId, input.clientName, input.redirectUris, input.clientUri],
  );
  return rowToClient(row!);
}

/** Inserts or refreshes the cached copy of a CIMD client. */
export async function upsertCimdClient(input: { clientId: string; clientName: string; redirectUris: string[]; clientUri: string | null }): Promise<OAuthClient> {
  const row = await queryOne<ClientRow>(
    `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, source, client_uri, fetched_at)
     VALUES ($1, $2, $3, 'cimd', $4, now())
     ON CONFLICT (client_id) DO UPDATE SET client_name = EXCLUDED.client_name, redirect_uris = EXCLUDED.redirect_uris,
       client_uri = EXCLUDED.client_uri, fetched_at = now()
     WHERE oauth_clients.source = 'cimd'
     RETURNING *`,
    [input.clientId, input.clientName, input.redirectUris, input.clientUri],
  );
  return rowToClient(row!);
}

/** Housekeeping, called from registration: expired rows, and self-registered clients nobody ever authorized. */
export async function pruneStale(): Promise<void> {
  await query(`DELETE FROM oauth_authz_requests WHERE expires_at < now()`);
  await query(`DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 day'`);
  await query(`DELETE FROM oauth_tokens WHERE expires_at < now() - interval '1 day'`);
  await query(
    `DELETE FROM oauth_clients c WHERE c.created_at < now() - interval '7 days'
       AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.client_id)
       AND NOT EXISTS (SELECT 1 FROM oauth_authz_requests r WHERE r.client_id = c.client_id)`,
  );
}

// ---------------------------------------------------------------------------
// Pending consent (the Allow/Deny form)
// ---------------------------------------------------------------------------

export interface AuthzRequestInput {
  userId: string;
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  requestedScopes: ApiTokenScope[];
  resource: string;
}
export type AuthzRequest = AuthzRequestInput;

export async function createAuthzRequest(input: AuthzRequestInput): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO oauth_authz_requests (id_hash, user_id, client_id, redirect_uri, state, code_challenge, requested_scopes, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [hashSecret(raw), input.userId, input.clientId, input.redirectUri, input.state, input.codeChallenge, input.requestedScopes, input.resource, addSeconds(AUTHZ_REQUEST_TTL_SECONDS)],
  );
  return raw;
}

/** Single-use: deleted on read. Only the user the request was created for can consume it. */
export async function consumeAuthzRequest(raw: string, userId: string): Promise<AuthzRequest | undefined> {
  const row = await queryOne<{ user_id: string; client_id: string; redirect_uri: string; state: string | null; code_challenge: string; requested_scopes: ApiTokenScope[]; resource: string }>(
    `DELETE FROM oauth_authz_requests WHERE id_hash = $1 AND user_id = $2 AND expires_at > now() RETURNING *`,
    [hashSecret(raw), userId],
  );
  if (!row) return undefined;
  return {
    userId: row.user_id,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    state: row.state,
    codeChallenge: row.code_challenge,
    requestedScopes: row.requested_scopes,
    resource: row.resource,
  };
}

// ---------------------------------------------------------------------------
// Authorization codes
// ---------------------------------------------------------------------------

export interface CodeInput {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: ApiTokenScope[];
  resource: string;
}

export async function createCode(input: CodeInput): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO oauth_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, scopes, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [hashSecret(raw), input.userId, input.clientId, input.redirectUri, input.codeChallenge, input.scopes, input.resource, addSeconds(CODE_TTL_SECONDS)],
  );
  return raw;
}

export interface CodeRow extends CodeInput {
  usedAt: Date | null;
  expired: boolean;
  grantId: string | null;
}

export async function findCode(raw: string): Promise<CodeRow | undefined> {
  const row = await queryOne<{ user_id: string; client_id: string; redirect_uri: string; code_challenge: string; scopes: ApiTokenScope[]; resource: string; used_at: string | null; expired: boolean; grant_id: string | null }>(
    `SELECT *, expires_at <= now() AS expired FROM oauth_codes WHERE code_hash = $1`,
    [hashSecret(raw)],
  );
  if (!row) return undefined;
  return {
    userId: row.user_id,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    scopes: row.scopes,
    resource: row.resource,
    usedAt: row.used_at ? new Date(row.used_at) : null,
    expired: row.expired,
    grantId: row.grant_id,
  };
}

/** Atomically marks the code used. False when somebody else got there first (or it expired in between). */
export async function markCodeUsed(raw: string, grantId: string): Promise<boolean> {
  const row = await queryOne<{ code_hash: string }>(
    `UPDATE oauth_codes SET used_at = now(), grant_id = $2 WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING code_hash`,
    [hashSecret(raw), grantId],
  );
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Grants and tokens
// ---------------------------------------------------------------------------

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  grantId: string;
}

async function issueTokens(grantId: string): Promise<IssuedTokens> {
  const accessToken = `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
  const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
  await query(
    `INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES ($1, $3, 'access', $4), ($2, $3, 'refresh', $5)`,
    [hashSecret(accessToken), hashSecret(refreshToken), grantId, addSeconds(ACCESS_TOKEN_TTL_SECONDS), addSeconds(REFRESH_TOKEN_TTL_SECONDS)],
  );
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, grantId };
}

export async function createGrant(input: { userId: string; clientId: string; scopes: ApiTokenScope[]; resource: string }): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO oauth_grants (user_id, client_id, scopes, resource) VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.userId, input.clientId, input.scopes, input.resource],
  );
  return row!.id;
}

/** First tokens of a grant, issued when its code is redeemed. */
export async function issueFirstTokens(grantId: string): Promise<IssuedTokens> {
  return issueTokens(grantId);
}

export type RefreshOutcome =
  | { ok: true; tokens: IssuedTokens; grant: { userId: string; clientId: string; scopes: ApiTokenScope[]; resource: string } }
  | { ok: false; reason: 'invalid' | 'reused' | 'scope' };

/**
 * Rotates a refresh token: the old one is consumed atomically and a new access + refresh pair is
 * issued. Presenting an already-rotated refresh token means two parties hold it (the legitimate
 * client and a thief): the whole grant is revoked.
 */
export async function rotateRefreshToken(raw: string, clientId: string, requestedScopes: string[] = []): Promise<RefreshOutcome> {
  const hash = hashSecret(raw);
  const consumed = await queryOne<{ grant_id: string }>(
    `UPDATE oauth_tokens t SET used_at = now()
       FROM oauth_grants g
      WHERE t.token_hash = $1 AND t.kind = 'refresh' AND t.used_at IS NULL AND t.expires_at > now()
        AND g.id = t.grant_id AND g.revoked_at IS NULL AND g.client_id = $2
        AND g.scopes @> $3::text[]
      RETURNING t.grant_id`,
    [hash, clientId, requestedScopes],
  );
  if (!consumed) {
    const prior = await queryOne<{ grant_id: string; used_at: string | null; client_id: string; live: boolean }>(
      `SELECT t.grant_id, t.used_at, g.client_id, (t.expires_at > now() AND g.revoked_at IS NULL) AS live FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = $1 AND t.kind = 'refresh'`,
      [hash],
    );
    if (prior && prior.used_at && prior.client_id === clientId) {
      await revokeGrant(prior.grant_id);
      return { ok: false, reason: 'reused' };
    }
    // Same token, still good, but asking for more than the grant holds: nothing was consumed.
    if (prior && !prior.used_at && prior.live && prior.client_id === clientId && requestedScopes.length > 0) return { ok: false, reason: 'scope' };
    return { ok: false, reason: 'invalid' };
  }
  const grant = await queryOne<{ user_id: string; client_id: string; scopes: ApiTokenScope[]; resource: string }>('SELECT * FROM oauth_grants WHERE id = $1', [consumed.grant_id]);
  const tokens = await issueTokens(consumed.grant_id);
  return { ok: true, tokens, grant: { userId: grant!.user_id, clientId: grant!.client_id, scopes: grant!.scopes, resource: grant!.resource } };
}

export interface ResolvedOAuthAccess {
  userId: string;
  grantId: string;
  scopes: ApiTokenScope[];
  resource: string;
}

/** Valid, unexpired access token of a non-revoked grant; undefined otherwise (no hint which reason). */
export async function resolveAccessToken(raw: string): Promise<ResolvedOAuthAccess | undefined> {
  const row = await queryOne<{ grant_id: string; user_id: string; scopes: ApiTokenScope[]; resource: string }>(
    `SELECT t.grant_id, g.user_id, g.scopes, g.resource FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
      WHERE t.token_hash = $1 AND t.kind = 'access' AND t.expires_at > now() AND g.revoked_at IS NULL`,
    [hashSecret(raw)],
  );
  return row ? { userId: row.user_id, grantId: row.grant_id, scopes: row.scopes, resource: row.resource } : undefined;
}

const LAST_USED_DEBOUNCE_MS = 60_000;
const lastTouchedAt = new Map<string, number>();
/** Debounced bookkeeping, same approach as PAT last_used_at; never blocks or fails the request. */
export function touchGrantLastUsed(grantId: string): void {
  const now = Date.now();
  const last = lastTouchedAt.get(grantId);
  if (last !== undefined && now - last < LAST_USED_DEBOUNCE_MS) return;
  lastTouchedAt.set(grantId, now);
  void query('UPDATE oauth_grants SET last_used_at = now() WHERE id = $1', [grantId]).catch(() => {});
}

export async function revokeGrant(grantId: string): Promise<void> {
  await query('UPDATE oauth_grants SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [grantId]);
}

/** RFC 7009: any token (access or refresh) of a grant revokes the whole grant. Returns whether one was found. */
export async function revokeByToken(raw: string, clientId: string | undefined): Promise<boolean> {
  const row = await queryOne<{ grant_id: string }>(
    `SELECT t.grant_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
      WHERE t.token_hash = $1 AND ($2::text IS NULL OR g.client_id = $2)`,
    [hashSecret(raw), clientId ?? null],
  );
  if (!row) return false;
  await revokeGrant(row.grant_id);
  return true;
}

// ---------------------------------------------------------------------------
// "Connected apps"
// ---------------------------------------------------------------------------

export async function listConnections(userId: string): Promise<OAuthConnectionInfo[]> {
  const rows = await query<{ id: string; client_name: string; redirect_uris: string[]; scopes: ApiTokenScope[]; created_at: string; last_used_at: string | null }>(
    `SELECT g.id, c.client_name, c.redirect_uris, g.scopes, g.created_at, g.last_used_at
       FROM oauth_grants g JOIN oauth_clients c ON c.client_id = g.client_id
      WHERE g.user_id = $1 AND g.revoked_at IS NULL ORDER BY g.created_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    clientName: r.client_name,
    redirectHost: redirectHost(r.redirect_uris[0]),
    scopes: r.scopes,
    createdAt: new Date(r.created_at).toISOString(),
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
  }));
}

/** False when the id is not an active grant of this user (so one user can never revoke another's). */
export async function revokeConnection(userId: string, grantId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE oauth_grants SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
    [grantId, userId],
  );
  return row !== undefined;
}
