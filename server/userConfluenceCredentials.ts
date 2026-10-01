/**
 * Round 22b: per-user saved Confluence credentials (the owner doesn't want
 * to paste a Confluence token on every import). Same mechanism as
 * userGitCredentials.ts: AES-256-GCM at rest (secretCrypto.ts), ownership
 * enforced with `WHERE id = $1 AND user_id = $2` everywhere, and the token
 * is NEVER returned by any exported function here in decrypted form except
 * the two getDecryptedToken* functions below — which exist ONLY for
 * server-side use (feeding confluenceImport.ts's own fetch calls) and must
 * never be wired to an HTTP response.
 *
 * A separate table from git_credentials (see migration 014's own comment
 * for why), but the identical PATTERN: host normalization is reused
 * DIRECTLY from userGitCredentials.ts (a host is a host, regardless of
 * which service it's for), upsert-by-(user,host), and the same
 * ownership-check shape as deleteCredential there.
 *
 * Naming note: this module's `kind` is 'pat' | 'cloud' — what's actually
 * being stored and shown in the credentials list. shared/contracts.ts's
 * ConfluenceSource.auth.kind (round 12, unchanged by this round) is
 * 'pat' | 'basic' — 'basic' there means exactly the same thing as 'cloud'
 * here (HTTP Basic auth with an email). The two vocabularies map 1:1
 * (cloud <-> basic); confluenceImport.ts's resolveImportAuth is the one
 * place that translates between them.
 *
 * The request/response shapes below (saveConfluenceCredentialBodySchema,
 * ConfluenceCredentialInfo) are a pending shared/contracts.ts addition —
 * defined here rather than there per this round's own instructions
 * ("do not touch contracts.ts, I will add it myself"). See the SERVER round-22b
 * report for the exact shape to move over.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { query, queryOne } from './db/pool.js';
import { decryptSecret, encryptSecret, hasSecretConfigured } from './secretCrypto.js';
import { normalizeHost } from './userGitCredentials.js';
import { badRequest, HttpError } from './errors.js';

export type ConfluenceCredentialKind = 'pat' | 'cloud';

export interface ConfluenceCredentialInfo {
  id: string;
  host: string;
  kind: ConfluenceCredentialKind;
  label: string;
  /** Only present for kind==='cloud' — the Atlassian account email a saved API token belongs to. Never the token itself. */
  email?: string;
  createdAt: string;
}

/** POST /api/me/confluence-credentials body — see module doc comment re: contracts.ts. */
export const saveConfluenceCredentialBodySchema = z
  .object({
    host: z.string().min(1),
    kind: z.enum(['pat', 'cloud']),
    token: z.string().min(1),
    email: z.string().optional(),
    label: z.string().optional(),
  })
  .refine((v) => v.kind !== 'cloud' || Boolean(v.email?.trim()), {
    message: 'email is required for a cloud (email + API token) Confluence credential',
    path: ['email'],
  });
export type SaveConfluenceCredentialBody = z.infer<typeof saveConfluenceCredentialBodySchema>;

interface CredRow {
  id: string;
  user_id: string;
  host: string;
  kind: ConfluenceCredentialKind;
  email: string | null;
  token_enc: Buffer;
  label: string | null;
  created_at: string;
}

function rowToInfo(row: CredRow): ConfluenceCredentialInfo {
  const info: ConfluenceCredentialInfo = {
    id: row.id,
    host: row.host,
    kind: row.kind,
    label: row.label ?? row.host,
    createdAt: new Date(row.created_at).toISOString(),
  };
  if (row.email) info.email = row.email;
  return info;
}

export async function listForUser(userId: string): Promise<ConfluenceCredentialInfo[]> {
  const rows = await query<CredRow>('SELECT * FROM confluence_credentials WHERE user_id = $1 ORDER BY created_at', [userId]);
  return rows.map(rowToInfo);
}

/**
 * One saved credential per (user, host) — a second save for the same host
 * REPLACES the first (upsert), matching the UNIQUE(user_id, host)
 * constraint from migration 014 — same reasoning as
 * userGitCredentials.saveCredential: a re-entered token for a host already
 * saved should just update it, not create an ambiguous second row.
 *
 * `email` is required (non-blank) when kind==='cloud' and is always stored
 * as NULL for kind==='pat' (whatever was passed in `opts.email` for a 'pat'
 * save is silently ignored, not stored) — matches the DB's own CHECK
 * constraint, so a bad combination is a clean 400 from THIS function
 * rather than a raw constraint-violation error surfacing from Postgres.
 */
export async function saveCredential(
  userId: string,
  host: string,
  kind: ConfluenceCredentialKind,
  token: string,
  opts?: { email?: string; label?: string },
): Promise<ConfluenceCredentialInfo> {
  if (!hasSecretConfigured()) {
    throw new HttpError(500, 'FOLIO_SECRET is not configured on this server — Confluence credentials cannot be stored securely. Contact an administrator.');
  }
  const trimmedEmail = opts?.email?.trim() || undefined;
  if (kind === 'cloud' && !trimmedEmail) {
    throw badRequest('email is required for a cloud (email + API token) Confluence credential');
  }
  const normalizedHost = normalizeHost(host);
  const tokenEnc = encryptSecret(token);
  const row = await queryOne<CredRow>(
    `INSERT INTO confluence_credentials (id, user_id, host, kind, email, token_enc, label)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, host) DO UPDATE SET kind = EXCLUDED.kind, email = EXCLUDED.email, token_enc = EXCLUDED.token_enc, label = EXCLUDED.label
     RETURNING *`,
    [randomUUID(), userId, normalizedHost, kind, kind === 'cloud' ? trimmedEmail : null, tokenEnc, opts?.label?.trim() || null],
  );
  return rowToInfo(row!);
}

/** True if a row was actually deleted (and it belonged to this user — deleting someone else's credential by id is never possible, not even a 403 that would confirm the id exists). */
export async function deleteCredential(userId: string, id: string): Promise<boolean> {
  const rows = await query('DELETE FROM confluence_credentials WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
  return rows.length > 0;
}

export interface DecryptedConfluenceCredential {
  token: string;
  kind: ConfluenceCredentialKind;
  /** Only present for kind==='cloud'. */
  email?: string;
}

function rowToDecrypted(row: CredRow): DecryptedConfluenceCredential {
  const out: DecryptedConfluenceCredential = { token: decryptSecret(row.token_enc), kind: row.kind };
  if (row.email) out.email = row.email;
  return out;
}

/** Server-side only — see module doc comment. Used by confluenceImport.ts's resolveImportAuth (credentialId branch), never wired to an HTTP response. */
export async function getDecryptedTokenById(userId: string, id: string): Promise<DecryptedConfluenceCredential | undefined> {
  const row = await queryOne<CredRow>('SELECT * FROM confluence_credentials WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!row) return undefined;
  return rowToDecrypted(row);
}

/** Server-side only (see module doc comment) — by-host lookup, symmetric with userGitCredentials' own. Not wired to any silent auto-fallback in the import route (round 22b's SHELL flow always resolves "is this host already saved" itself from the full list and sends an explicit credentialId) — kept for parity and any future caller that wants a direct by-host lookup. */
export async function getDecryptedTokenForHost(userId: string, host: string): Promise<DecryptedConfluenceCredential | undefined> {
  const row = await queryOne<CredRow>('SELECT * FROM confluence_credentials WHERE user_id = $1 AND host = $2', [userId, normalizeHost(host)]);
  if (!row) return undefined;
  return rowToDecrypted(row);
}
