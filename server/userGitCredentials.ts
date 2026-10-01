/**
 * Round 11: per-user saved git PATs (repo-browser dropdown + auto-token on
 * space create). Tokens are AES-256-GCM encrypted at rest (secretCrypto.ts)
 * and NEVER returned by any exported function here in decrypted form except
 * getDecryptedTokenForHost — which exists ONLY for server-side use (calling
 * a provider's API, or feeding git's askpass) and must never be wired to an
 * HTTP response.
 */
import { randomUUID } from 'node:crypto';
import type { GitCredentialInfo, GitProviderRepos } from '../shared/contracts.js';
import { query, queryOne } from './db/pool.js';
import { decryptSecret, encryptSecret, hasSecretConfigured } from './secretCrypto.js';
import { HttpError } from './errors.js';

export type Provider = 'gitlab' | 'github';

/** host, without scheme or trailing slash, lowercased — "https://GitLab.example.com/" and "gitlab.example.com" must be the SAME saved credential. */
export function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

/** Best-effort host extraction from a repo URL — https, ssh://, and scp-like (git@host:path) forms. Used by the auto-token lookup at space-create time; undefined (rather than throwing) for anything it doesn't recognize, since that just means "no auto-token match", never a hard error. */
export function hostFromRepoUrl(repoUrl: string): string | undefined {
  try {
    if (/^https?:\/\//i.test(repoUrl)) return normalizeHost(new URL(repoUrl).host);
    const scpMatch = repoUrl.match(/^(?:git@|ssh:\/\/git@)([^:/]+)[:/]/);
    if (scpMatch) return normalizeHost(scpMatch[1]);
  } catch {
    // fall through to undefined below
  }
  return undefined;
}

interface CredRow {
  id: string;
  user_id: string;
  host: string;
  provider: Provider;
  token_enc: Buffer;
  label: string | null;
  created_at: string;
}

function rowToInfo(row: CredRow): GitCredentialInfo {
  return { id: row.id, host: row.host, provider: row.provider, label: row.label ?? row.host, createdAt: new Date(row.created_at).toISOString() };
}

export async function listForUser(userId: string): Promise<GitCredentialInfo[]> {
  const rows = await query<CredRow>('SELECT * FROM git_credentials WHERE user_id = $1 ORDER BY created_at', [userId]);
  return rows.map(rowToInfo);
}

/**
 * One saved credential per (user, host) — a second save for the same host
 * REPLACES the first (upsert), matching the UNIQUE(user_id, host) constraint
 * from migration 012: a "Connect GitLab" button re-clicked with a fresh
 * token should just update the stored one, not create an ambiguous second
 * row the auto-token lookup would then have to arbitrarily pick between.
 */
export async function saveCredential(userId: string, host: string, provider: Provider, token: string, label?: string): Promise<GitCredentialInfo> {
  if (!hasSecretConfigured()) {
    throw new HttpError(500, 'FOLIO_SECRET is not configured on this server — git credentials cannot be stored securely. Contact an administrator.');
  }
  const normalizedHost = normalizeHost(host);
  const tokenEnc = encryptSecret(token);
  const row = await queryOne<CredRow>(
    `INSERT INTO git_credentials (id, user_id, host, provider, token_enc, label)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, host) DO UPDATE SET provider = EXCLUDED.provider, token_enc = EXCLUDED.token_enc, label = EXCLUDED.label
     RETURNING *`,
    [randomUUID(), userId, normalizedHost, provider, tokenEnc, label?.trim() || null],
  );
  return rowToInfo(row!);
}

/** True if a row was actually deleted (and it belonged to this user — deleting someone else's credential by id is never possible, not even a 403 that would confirm the id exists). */
export async function deleteCredential(userId: string, id: string): Promise<boolean> {
  const rows = await query('DELETE FROM git_credentials WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
  return rows.length > 0;
}

/** Server-side only — see the module doc comment. Used by GET /api/git/repos and the auto-token wiring in POST /api/spaces + POST /api/git/branches. */
export async function getDecryptedTokenForHost(userId: string, host: string): Promise<{ token: string; provider: Provider } | undefined> {
  const row = await queryOne<CredRow>('SELECT * FROM git_credentials WHERE user_id = $1 AND host = $2', [userId, normalizeHost(host)]);
  if (!row) return undefined;
  return { token: decryptSecret(row.token_enc), provider: row.provider };
}

/**
 * Server-side only (see module doc comment) — round 19's GET /api/git/tree
 * (repo directory browsing for the create-space dialog) takes an explicit
 * `credentialId` rather than a bare host, so the lookup here is BY ID, not
 * by host. Ownership is enforced the exact same way deleteCredential() does
 * it: `id = $1 AND user_id = $2` in the query itself — a credential that
 * exists but belongs to someone else comes back undefined, identical to one
 * that doesn't exist at all, never a 403 that would confirm the id is real.
 */
export async function getDecryptedTokenById(userId: string, id: string): Promise<{ token: string; provider: Provider } | undefined> {
  const row = await queryOne<CredRow>('SELECT * FROM git_credentials WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!row) return undefined;
  return { token: decryptSecret(row.token_enc), provider: row.provider };
}

/**
 * Round 11 auto-token: an explicit token always wins (a user pasting a
 * fresh/different token must not be silently overridden by a stale saved
 * one). Otherwise, if repoUrl's host matches a credential this user has
 * saved, use it — POST /api/spaces and POST /api/git/branches both call
 * this so a saved GitLab/GitHub PAT means the "Token" field in the
 * create-space dialog can stay empty/hidden. Returns undefined (not an
 * error) when nothing matches — an unauthenticated public repo is a
 * completely normal case.
 */
export async function resolveGitToken(userId: string, repoUrl: string, explicitToken: string | undefined): Promise<string | undefined> {
  if (explicitToken) return explicitToken;
  const host = hostFromRepoUrl(repoUrl);
  if (!host) return undefined;
  const cred = await getDecryptedTokenForHost(userId, host);
  return cred?.token;
}

export type { GitProviderRepos };
