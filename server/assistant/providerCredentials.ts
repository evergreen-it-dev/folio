/**
 * Credentials of the non-Cursor providers (db/migrations/064): one row per
 * scope and provider. Same split as store.ts and sharedKeys.ts: the readers
 * that feed an HTTP response never touch the plaintext, and the decrypted value
 * comes out of getDecryptedProviderSecret only, which feeds the outbound call.
 */
import { providerEnabled } from './providerFlags.js';
import type { AssistantCredentialProviderId, AssistantProviderKeyInfo, SharedAssistantKeyScope } from '../../shared/contracts.js';
import { saveAssistantProviderKeyBodySchema } from '../../shared/contracts.js';
import { query, queryOne } from '../db/pool.js';
import { badRequest, conflict, HttpError, notFound } from '../errors.js';
import { decryptSecret, encryptSecret, hasSecretConfigured } from '../secretCrypto.js';
import { parseBody } from '../validate.js';
import { PROVIDER_LABELS } from './models.js';
import { verifyProviderKey } from './runtime/index.js';

export type ProviderCredentialTarget = { scope: 'user'; userId: string } | { scope: 'space'; space: string } | { scope: 'instance' };
export type ShareableProviderId = Exclude<AssistantCredentialProviderId, 'codex'>;

export interface ApplicableCredential {
  scope: 'user' | 'space' | 'instance';
  provider: AssistantCredentialProviderId;
  label: string | null;
}

/** `:provider` on a route that takes a provider. Unknown is a 404; Cursor has its own key routes. */
export function parseCredentialProvider(raw: string): AssistantCredentialProviderId {
  // A provider that is switched off (see providerFlags.ts) does not exist for any route.
  if ((raw === 'minimax' || raw === 'anthropic' || raw === 'codex') && providerEnabled(raw)) return raw;
  if (raw === 'cursor') throw badRequest('Cursor keys have their own routes');
  throw notFound('assistant provider');
}

/** `:provider` on a route that takes a key: Codex connects through a login flow and is never shared. */
export function parseKeyProvider(raw: string): ShareableProviderId {
  const provider = parseCredentialProvider(raw);
  if (provider === 'codex') throw badRequest('Codex can only be connected personally, through its login flow');
  return provider;
}

function targetClause(target: ProviderCredentialTarget, firstParam: number): { sql: string; params: unknown[] } {
  switch (target.scope) {
    case 'user':
      return { sql: `scope = 'user' AND user_id = $${firstParam}`, params: [target.userId] };
    case 'space':
      return { sql: `scope = 'space' AND space_slug = $${firstParam}`, params: [target.space] };
    case 'instance':
      return { sql: `scope = 'instance'`, params: [] };
  }
}

/** Every credential that could serve this user in this space, without the secrets. */
export async function listApplicableCredentials(userId: string, space: string | null): Promise<ApplicableCredential[]> {
  return query<ApplicableCredential>(
    `SELECT scope, provider, label FROM assistant_provider_credentials
      WHERE (scope = 'user' AND user_id = $1) OR (scope = 'space' AND space_slug = $2) OR scope = 'instance'`,
    [userId, space],
  );
}

/** Server-side only: feeds the outbound provider call. Never wired to an HTTP response. */
export async function getDecryptedProviderSecret(provider: AssistantCredentialProviderId, target: ProviderCredentialTarget): Promise<string | null> {
  const { sql, params } = targetClause(target, 2);
  const row = await queryOne<{ secret_enc: Buffer }>(`SELECT secret_enc FROM assistant_provider_credentials WHERE provider = $1 AND ${sql}`, [provider, ...params]);
  return row ? decryptSecret(row.secret_enc) : null;
}

/** Throws if FOLIO_SECRET is not set: callers check hasSecretConfigured() first for a clean 409. */
export async function saveProviderCredential(
  provider: AssistantCredentialProviderId,
  target: ProviderCredentialTarget,
  secret: string,
  label: string | null,
  actorId: string,
): Promise<void> {
  const enc = encryptSecret(secret);
  const userId = target.scope === 'user' ? target.userId : null;
  const space = target.scope === 'space' ? target.space : null;
  const conflictTarget = target.scope === 'user' ? `(user_id, provider) WHERE scope = 'user'` : target.scope === 'space' ? `(space_slug, provider) WHERE scope = 'space'` : `(provider) WHERE scope = 'instance'`;
  await query(
    `INSERT INTO assistant_provider_credentials (scope, user_id, space_slug, provider, secret_enc, label, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT ${conflictTarget} DO UPDATE SET secret_enc = EXCLUDED.secret_enc, label = EXCLUDED.label, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [target.scope, userId, space, provider, enc, label, actorId],
  );
}

/**
 * Replaces the secret of an EXISTING credential and nothing else (label and owner stay). A credential that was
 * removed in the meantime stays removed: the Codex write-back of a refreshed sign-in must never bring a
 * disconnected account back. Returns whether a row was updated.
 */
export async function updateProviderCredentialSecret(provider: AssistantCredentialProviderId, target: ProviderCredentialTarget, secret: string): Promise<boolean> {
  const enc = encryptSecret(secret);
  const { sql, params } = targetClause(target, 3);
  const rows = await query<{ provider: string }>(
    `UPDATE assistant_provider_credentials SET secret_enc = $2, updated_at = now() WHERE provider = $1 AND ${sql} RETURNING provider`,
    [provider, enc, ...params],
  );
  return rows.length > 0;
}

export async function deleteProviderCredential(provider: AssistantCredentialProviderId, target: ProviderCredentialTarget): Promise<void> {
  const { sql, params } = targetClause(target, 2);
  await query(`DELETE FROM assistant_provider_credentials WHERE provider = $1 AND ${sql}`, [provider, ...params]);
}

/** The body of a shared-key GET or PUT. Never carries the key. */
export async function buildProviderKeyInfo(provider: ShareableProviderId, scope: SharedAssistantKeyScope, space: string | null): Promise<AssistantProviderKeyInfo> {
  const target: ProviderCredentialTarget = scope === 'space' ? { scope: 'space', space: space! } : { scope: 'instance' };
  const { sql, params } = targetClause(target, 2);
  const row = await queryOne<{ label: string | null; updated_at: Date; updated_by: string | null; updated_by_name: string | null }>(
    `SELECT label, updated_at, updated_by, (SELECT u.name FROM users u WHERE u.id = c.updated_by) AS updated_by_name
       FROM assistant_provider_credentials c
      WHERE provider = $1 AND ${sql}`,
    [provider, ...params],
  );
  return {
    provider,
    scope,
    space,
    configured: row !== undefined,
    keyName: row?.label ?? null,
    updatedAt: row ? row.updated_at.toISOString() : null,
    updatedBy: row?.updated_by && row.updated_by_name !== null ? { id: row.updated_by, name: row.updated_by_name } : null,
    encryptionAvailable: hasSecretConfigured(),
  };
}

/** The checks every provider-key PUT runs before it stores anything; the key itself is never echoed. */
export async function verifyProviderKeyBody(provider: ShareableProviderId, body: unknown): Promise<{ apiKey: string; label: string | null }> {
  if (!hasSecretConfigured()) throw conflict('FOLIO_SECRET is not configured on this server — API keys cannot be stored securely.');
  const input = parseBody(saveAssistantProviderKeyBodySchema, body);
  const verdict = await verifyProviderKey(provider, input.apiKey);
  if (verdict === 'rejected') throw badRequest(`${PROVIDER_LABELS[provider]} API key was not accepted`);
  if (verdict === 'unavailable') throw new HttpError(502, `Could not reach ${PROVIDER_LABELS[provider]} to verify the key — try again`);
  return { apiKey: input.apiKey, label: input.label ?? null };
}
