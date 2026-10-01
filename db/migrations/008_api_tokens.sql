-- Round 7: personal API tokens (PAT) for REST + MCP access outside the
-- browser cookie session. token_hash is sha256(raw token) — same pattern as
-- sessions.token_hash — the raw token is shown to the user exactly once, at
-- creation, and never persisted anywhere.
CREATE TABLE IF NOT EXISTS api_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  -- array_length(scopes, 1) is NULL (not 0) for an empty array, which a plain
  -- "> 0" check would NOT reject (NULL fails a CHECK only on false, not null)
  -- — cardinality() returns a real 0, closing that gap.
  scopes        text[] NOT NULL CHECK (scopes <@ ARRAY['read', 'write']::text[] AND cardinality(scopes) > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS api_tokens_user_id_idx ON api_tokens(user_id);
