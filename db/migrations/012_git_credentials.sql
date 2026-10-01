-- Round 11: per-user saved git PATs (for the repo-browser dropdown and
-- auto-token-on-space-create). token_enc is AES-256-GCM ciphertext
-- (server/secretCrypto.ts, keyed by FOLIO_SECRET) -- never plaintext, and
-- never returned by the API once saved.
CREATE TABLE IF NOT EXISTS git_credentials (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host       text NOT NULL,
  provider   text NOT NULL CHECK (provider IN ('gitlab', 'github')),
  token_enc  bytea NOT NULL,
  label      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One saved credential per (user, host) -- a second POST for the same
  -- host replaces it (see userGitCredentials.ts's upsert), rather than
  -- silently accumulating ambiguous duplicates the auto-token lookup would
  -- then have to pick between.
  UNIQUE (user_id, host)
);
