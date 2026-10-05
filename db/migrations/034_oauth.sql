-- OAuth 2.1 for MCP: Folio is both authorization server and resource server, so that
-- claude.ai / Claude Desktop / ChatGPT can connect it as a connector. Everything secret
-- (authorization-request ids, codes, access/refresh tokens) is stored ONLY as sha256,
-- the same way sessions and PATs are.

-- Registered clients: DCR (RFC 7591, self-registered, public) or CIMD (client_id is an
-- https URL of a metadata document, cached here).
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id      text PRIMARY KEY,
  client_name    text NOT NULL,
  redirect_uris  text[] NOT NULL CHECK (cardinality(redirect_uris) > 0),
  source         text NOT NULL CHECK (source IN ('dcr', 'cimd')),
  client_uri     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  fetched_at     timestamptz
);

-- A pending consent screen. The raw id is the CSRF secret of the Allow/Deny form: it is bound
-- to the logged-in user, single use, short lived, and carries the validated authorize params so
-- nothing about them can be altered between the consent page and the decision.
CREATE TABLE IF NOT EXISTS oauth_authz_requests (
  id_hash          text PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id        text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri     text NOT NULL,
  state            text,
  code_challenge   text NOT NULL,
  requested_scopes text[] NOT NULL,
  resource         text NOT NULL,
  expires_at       timestamptz NOT NULL
);

-- One connection of one app to one user's Folio ("Connected apps"). Revoking it kills every
-- access and refresh token that belongs to it.
CREATE TABLE IF NOT EXISTS oauth_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id     text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  scopes        text[] NOT NULL CHECK (scopes <@ ARRAY['read', 'write']::text[] AND cardinality(scopes) > 0),
  resource      text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS oauth_grants_user_idx ON oauth_grants(user_id);

-- Authorization codes: single use (used_at), ~60 s TTL. grant_id is filled when the code is
-- redeemed, so a replayed code can revoke the grant it already produced.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash       text PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id       text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri    text NOT NULL,
  code_challenge  text NOT NULL,
  scopes          text[] NOT NULL,
  resource        text NOT NULL,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  grant_id        uuid REFERENCES oauth_grants(id) ON DELETE CASCADE
);

-- Access (short) and refresh (long, rotated) tokens. A refresh token's used_at set means it was
-- already rotated; presenting it again is treated as theft and revokes the whole grant.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash  text PRIMARY KEY,
  grant_id    uuid NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('access', 'refresh')),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX IF NOT EXISTS oauth_tokens_grant_idx ON oauth_tokens(grant_id);
