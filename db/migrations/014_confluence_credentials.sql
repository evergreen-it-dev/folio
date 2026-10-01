-- Round 22b: per-user saved Confluence credentials (owner doesn't want to
-- paste a Confluence token on every import). Same mechanism as
-- git_credentials (012_git_credentials.sql): token_enc is AES-256-GCM
-- ciphertext (server/secretCrypto.ts, keyed by FOLIO_SECRET) -- never
-- plaintext, never returned by the API once saved.
--
-- A SEPARATE table rather than widening git_credentials itself:
-- git_credentials' UNIQUE(user_id, host) has no `provider` in it, so
-- folding Confluence in there would make a git host and a Confluence host
-- on the SAME domain collide with each other, and every existing gitlab/
-- github row would carry permanently-NULL kind/email columns it has no use
-- for. This table mirrors the identical PATTERN instead (same encryption,
-- same ownership-check shape, same upsert-by-host) rather than the same
-- literal table.
--
-- kind='pat'   -> on-prem Confluence Data Center/Server Personal Access
--                 Token, sent as "Authorization: Bearer <token>".
-- kind='cloud' -> Atlassian Cloud API token, sent as HTTP Basic auth
--                 together with the account's email -- email travels
--                 alongside the encrypted token in the same row (it's
--                 meaningless without it, and only ever needed WITH it to
--                 build the Basic header); required for kind='cloud',
--                 always NULL for kind='pat' (enforced below, not just by
--                 convention).
CREATE TABLE IF NOT EXISTS confluence_credentials (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('pat', 'cloud')),
  email      text,
  token_enc  bytea NOT NULL,
  label      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'cloud') = (email IS NOT NULL)),
  -- One saved credential per (user, host) -- a second save for the same
  -- host replaces it (see userConfluenceCredentials.ts's upsert), same
  -- reasoning as git_credentials: never an ambiguous duplicate that a
  -- "use the saved credential for this host" lookup would have to pick
  -- between.
  UNIQUE (user_id, host)
);
