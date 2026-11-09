-- Credentials of the non-Cursor AI providers (MiniMax, Anthropic API, ChatGPT
-- subscription for Codex). One row per scope and provider:
--   * scope 'user'     - personal credential, used only while the instance policy
--                        personal_keys_allowed is on;
--   * scope 'space'    - shared by a space admin, removed together with the space;
--   * scope 'instance' - shared by an instance admin.
-- Codex is personal only. Secrets are encrypted exactly like the Cursor keys
-- (server/secretCrypto.ts, FOLIO_SECRET) and are never returned by any API.
-- The cursor_* columns of the older key tables stay as they are.
CREATE TABLE IF NOT EXISTS assistant_provider_credentials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope       text NOT NULL CHECK (scope IN ('user', 'space', 'instance')),
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  space_slug  text REFERENCES spaces(slug) ON DELETE CASCADE,
  provider    text NOT NULL CHECK (provider IN ('minimax', 'anthropic', 'codex')),
  secret_enc  bytea NOT NULL,
  label       text,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_provider_credentials_scope_owner CHECK (
    (scope = 'user' AND user_id IS NOT NULL AND space_slug IS NULL)
    OR (scope = 'space' AND space_slug IS NOT NULL AND user_id IS NULL)
    OR (scope = 'instance' AND user_id IS NULL AND space_slug IS NULL)
  ),
  CONSTRAINT assistant_provider_credentials_codex_personal CHECK (provider <> 'codex' OR scope = 'user')
);

CREATE UNIQUE INDEX IF NOT EXISTS assistant_provider_credentials_user_uq
  ON assistant_provider_credentials (user_id, provider) WHERE scope = 'user';
CREATE UNIQUE INDEX IF NOT EXISTS assistant_provider_credentials_space_uq
  ON assistant_provider_credentials (space_slug, provider) WHERE scope = 'space';
CREATE UNIQUE INDEX IF NOT EXISTS assistant_provider_credentials_instance_uq
  ON assistant_provider_credentials (provider) WHERE scope = 'instance';
