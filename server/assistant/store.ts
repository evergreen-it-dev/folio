/**
 * AI assistant (Cursor SDK) — DB access for db/migrations/022_ai_assistant.sql:
 * user_assistant_settings (one row per user: encrypted Cursor API key + model
 * preference), ai_conversations, ai_messages. Same encryption pattern as
 * userConfluenceCredentials.ts/userGitCredentials.ts — encryptSecret/
 * decryptSecret keyed by FOLIO_SECRET (server/secretCrypto.ts) — and the
 * decrypted key is returned ONLY by getDecryptedCursorKey, never by the
 * settings-row readers below, mirroring those two modules' own split between
 * "info for an HTTP response" and "server-side only, feeds an outbound call".
 */
import { randomUUID } from 'node:crypto';
import { query, queryOne, withTransaction } from '../db/pool.js';
import type { PoolClient } from 'pg';
import { decryptSecret, encryptSecret, hasSecretConfigured } from '../secretCrypto.js';
import { normalizeAssistantModelPreference } from './models.js';

export interface AssistantSettingsRow {
  userId: string;
  cursorKeyName: string | null;
  cursorEmail: string | null;
  modelId: string;
  hasKey: boolean;
}

interface RawSettingsRow {
  user_id: string;
  cursor_key_enc: Buffer | null;
  cursor_key_name: string | null;
  cursor_email: string | null;
  model_id: string;
}

function toSettingsRow(row: RawSettingsRow): AssistantSettingsRow {
  return {
    userId: row.user_id,
    cursorKeyName: row.cursor_key_name,
    cursorEmail: row.cursor_email,
    modelId: row.model_id,
    hasKey: row.cursor_key_enc !== null,
  };
}

/** Never returns the key itself — see module doc comment. Returns a default row (no key, model 'auto') for a user who has never touched assistant settings, without writing anything. */
export async function getSettings(userId: string): Promise<AssistantSettingsRow> {
  const row = await queryOne<RawSettingsRow>('SELECT * FROM user_assistant_settings WHERE user_id = $1', [userId]);
  if (!row) return { userId, cursorKeyName: null, cursorEmail: null, modelId: 'auto', hasKey: false };
  return toSettingsRow(row);
}

/** Server-side only — feeds cursorRuntime.ts's outbound Cursor SDK calls. Never wired to an HTTP response. */
export async function getDecryptedCursorKey(userId: string): Promise<string | null> {
  const row = await queryOne<{ cursor_key_enc: Buffer | null }>('SELECT cursor_key_enc FROM user_assistant_settings WHERE user_id = $1', [userId]);
  if (!row?.cursor_key_enc) return null;
  return decryptSecret(row.cursor_key_enc);
}

/** Throws (via secretCrypto.ts's own key derivation) if FOLIO_SECRET is not set — callers check hasSecretConfigured() first for a clean 409 instead of a raw throw. */
export async function saveCursorKey(userId: string, apiKey: string, keyName: string, email: string | null): Promise<void> {
  if (!hasSecretConfigured()) throw new Error('FOLIO_SECRET is not set — cannot encrypt/decrypt saved Cursor API keys.');
  const enc = encryptSecret(apiKey);
  await query(
    `INSERT INTO user_assistant_settings (user_id, cursor_key_enc, cursor_key_name, cursor_email, model_id)
     VALUES ($1, $2, $3, $4, 'auto')
     ON CONFLICT (user_id) DO UPDATE SET cursor_key_enc = EXCLUDED.cursor_key_enc, cursor_key_name = EXCLUDED.cursor_key_name, cursor_email = EXCLUDED.cursor_email, updated_at = now()`,
    [userId, enc, keyName, email],
  );
}

export async function deleteCursorKey(userId: string): Promise<void> {
  await query(
    `UPDATE user_assistant_settings SET cursor_key_enc = NULL, cursor_key_name = NULL, cursor_email = NULL, updated_at = now() WHERE user_id = $1`,
    [userId],
  );
}

/** A user who has never touched assistant settings gets the operator-configured CURSOR_AGENT_MODEL (default 'auto') rather than a hardcoded 'auto' — see .env.example. */
export async function getModel(userId: string): Promise<string> {
  const row = await queryOne<{ model_id: string }>('SELECT model_id FROM user_assistant_settings WHERE user_id = $1', [userId]);
  return normalizeAssistantModelPreference(row?.model_id ?? process.env.CURSOR_AGENT_MODEL ?? 'auto');
}

export async function saveModel(userId: string, model: string): Promise<void> {
  const normalized = normalizeAssistantModelPreference(model);
  await query(
    `INSERT INTO user_assistant_settings (user_id, model_id) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET model_id = EXCLUDED.model_id, updated_at = now()`,
    [userId, normalized],
  );
}

// ---------------------------------------------------------------------------
// Conversations / messages
// ---------------------------------------------------------------------------

export interface AssistantConversationRow {
  id: string;
  userId: string;
  title: string | null;
  cursorAgentId: string;
  model: string;
  createdAt: Date;
  updatedAt: Date;
}

interface RawConversationRow {
  id: string;
  user_id: string;
  title: string | null;
  cursor_agent_id: string;
  model: string;
  created_at: Date;
  updated_at: Date;
}

function toConversationRow(row: RawConversationRow): AssistantConversationRow {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    cursorAgentId: row.cursor_agent_id,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function insertConversation(input: { userId: string; title: string | null; cursorAgentId: string; model: string }): Promise<AssistantConversationRow> {
  const row = await queryOne<RawConversationRow>(
    `INSERT INTO ai_conversations (id, user_id, title, cursor_agent_id, model)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [randomUUID(), input.userId, input.title, input.cursorAgentId, input.model],
  );
  return toConversationRow(row!);
}

export async function findConversation(id: string, userId: string): Promise<AssistantConversationRow | null> {
  const row = await queryOne<RawConversationRow>('SELECT * FROM ai_conversations WHERE id = $1 AND user_id = $2', [id, userId]);
  return row ? toConversationRow(row) : null;
}

export async function findLatestConversation(userId: string): Promise<AssistantConversationRow | null> {
  const row = await queryOne<RawConversationRow>('SELECT * FROM ai_conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1', [userId]);
  return row ? toConversationRow(row) : null;
}

/** Most recent 50 first, per the round's contract (AssistantConversationsResponse doc comment in shared/contracts.ts). */
export async function listConversations(userId: string, limit = 50): Promise<AssistantConversationRow[]> {
  const rows = await query<RawConversationRow>(
    'SELECT * FROM ai_conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2',
    [userId, Math.max(1, Math.min(limit, 100))],
  );
  return rows.map(toConversationRow);
}

export async function touchConversation(id: string, client?: PoolClient): Promise<void> {
  const runner = client ? (text: string, params: unknown[]) => client.query(text, params) : query;
  await runner('UPDATE ai_conversations SET updated_at = now() WHERE id = $1', [id]);
}

export interface AssistantMessageRow {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
}

interface RawMessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: Date;
}

function toMessageRow(row: RawMessageRow): AssistantMessageRow {
  return { id: row.id, conversationId: row.conversation_id, role: row.role, content: row.content, createdAt: row.created_at };
}

export async function insertMessage(conversationId: string, role: 'user' | 'assistant', content: string): Promise<AssistantMessageRow> {
  return withTransaction(async (client) => {
    const row = await client.query<RawMessageRow>(
      'INSERT INTO ai_messages (id, conversation_id, role, content) VALUES ($1, $2, $3, $4) RETURNING *',
      [randomUUID(), conversationId, role, content],
    );
    await touchConversation(conversationId, client);
    return toMessageRow(row.rows[0]!);
  });
}

export async function listMessages(conversationId: string, limit = 80): Promise<AssistantMessageRow[]> {
  const rows = await query<RawMessageRow>(
    'SELECT * FROM ai_messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT $2',
    [conversationId, Math.max(1, Math.min(limit, 200))],
  );
  return rows.map(toMessageRow);
}

/** runs.ts's loadTerminalFromDb: rebuilds the `complete` event for a run whose in-memory buffer is gone (evicted or lost to a restart) but whose ai_runs row still points at a saved message. */
export async function findMessageById(id: string): Promise<AssistantMessageRow | null> {
  const row = await queryOne<RawMessageRow>('SELECT * FROM ai_messages WHERE id = $1', [id]);
  return row ? toMessageRow(row) : null;
}
