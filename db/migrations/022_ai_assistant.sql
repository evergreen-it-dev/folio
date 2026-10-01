-- AI assistant (Cursor SDK), 04.09.2026. PostgreSQL tables for conversations
-- and messages. The Cursor key is stored encrypted (server/secretCrypto.ts,
-- FOLIO_SECRET) — the same way as git_credentials and
-- confluence_credentials; it does not get into the workspace of the agent or
-- into the logs.
CREATE TABLE IF NOT EXISTS user_assistant_settings (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cursor_key_enc  bytea,
  cursor_key_name text,
  cursor_email    text,
  model_id        text NOT NULL DEFAULT 'auto',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           text,
  cursor_agent_id text NOT NULL UNIQUE,
  model           text NOT NULL DEFAULT 'auto',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_conversations_user_idx ON ai_conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  content         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_messages_conversation_idx ON ai_messages(conversation_id, created_at);
