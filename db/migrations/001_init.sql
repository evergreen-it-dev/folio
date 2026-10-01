-- Folio round 4: PostgreSQL core schema.
--
-- Git-tracked files under data/spaces/<space>/ remain the source of truth for
-- page CONTENT (markdown/svg bytes never live here). Everything in this file
-- is either genuinely operational state (users, sessions, space membership,
-- stars, the space registry) or a derived index that a full directory rescan
-- can always rebuild from scratch (pages_index, links) — see DEV-PLAN
-- "Round 4" for the normative version of this split.
--
-- space_members.role / stars.kind / pages_index.kind,status / links.kind use
-- text + CHECK rather than a native PG ENUM: CREATE TYPE has no IF NOT EXISTS
-- and altering an enum's allowed values later has historical sharp edges;
-- a CHECK constraint is a plain ALTER TABLE either way.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  is_admin      boolean NOT NULL DEFAULT false,
  disabled      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- token_hash = sha256(raw cookie token), hex-encoded. The raw token itself is
-- never persisted (only ever lives in the httpOnly cookie), mirroring
-- a sibling project's session pattern.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

-- The space registry. Round 3 (git-native spaces, not yet implemented) will
-- populate repo_url/branch/root_path/status for real; round 4 just carries
-- the columns with sensible defaults so that migration is additive later.
CREATE TABLE IF NOT EXISTS spaces (
  slug         text PRIMARY KEY,
  name         text NOT NULL,
  repo_url     text,
  branch       text NOT NULL DEFAULT 'main',
  root_path    text NOT NULL DEFAULT '',
  asset_mode   text NOT NULL DEFAULT 'store' CHECK (asset_mode IN ('store', 'repo')),
  status       text NOT NULL DEFAULT 'clean' CHECK (status IN ('clean', 'syncing', 'ahead', 'behind', 'conflict', 'error')),
  last_sync_at timestamptz,
  last_error   text,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS space_members (
  space_slug text NOT NULL REFERENCES spaces(slug) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
  PRIMARY KEY (space_slug, user_id)
);
CREATE INDEX IF NOT EXISTS space_members_user_id_idx ON space_members(user_id);

CREATE TABLE IF NOT EXISTS stars (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('space', 'page')),
  key        text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, key)
);

-- Derived page index — safe to drop and rebuild from a full scan of
-- data/spaces/**. Doubles as the full-text search index: plain_text is the
-- raw markdown body (docs only; boards have no prose to index), tsv is
-- built with title weighted 'A' and body weighted 'B' so ts_rank_cd ranks
-- title matches first, matching round 2's in-memory search behavior.
-- "order" is a reserved word, hence sort_order. sort_order/status are
-- nullable: NULL means "not set in frontmatter" (the API defaults sort_order
-- to a sort-last sentinel and status to 'published' at read time) — this
-- round-trips frontmatter exactly instead of writing a value back that was
-- never actually in the file.
CREATE TABLE IF NOT EXISTS pages_index (
  id          text PRIMARY KEY,
  space_slug  text NOT NULL REFERENCES spaces(slug) ON DELETE CASCADE,
  path        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('doc', 'board')),
  title       text NOT NULL,
  sort_order  double precision,
  status      text CHECK (status IN ('draft', 'published', 'archived')),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  plain_text  text,
  tsv         tsvector,
  UNIQUE (space_slug, path)
);
CREATE INDEX IF NOT EXISTS pages_index_tsv_idx ON pages_index USING GIN (tsv);
CREATE INDEX IF NOT EXISTS pages_index_title_trgm_idx ON pages_index USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS pages_index_space_path_idx ON pages_index (space_slug, path);

CREATE TABLE IF NOT EXISTS assets (
  sha256     text PRIMARY KEY,
  mime       text NOT NULL,
  size       bigint NOT NULL,
  filename   text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id       bigserial PRIMARY KEY,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action   text NOT NULL,
  target   text,
  meta     jsonb,
  at       timestamptz NOT NULL DEFAULT now()
);

-- Beyond the plan text: backlinks support (coordinator addendum). Extracted
-- from markdown bodies during the boot scan and on every write-back/
-- mutation, delete+reinsert per source page. target_page_id is resolved
-- (kind='page') when a relative .md link points at a page in the same
-- index; otherwise kind is 'asset' (a relative non-.md link), 'external'
-- (absolute http(s) URL), or 'broken' (relative .md link that doesn't
-- resolve to any known page).
CREATE TABLE IF NOT EXISTS links (
  id             bigserial PRIMARY KEY,
  source_page_id text NOT NULL REFERENCES pages_index(id) ON DELETE CASCADE,
  target_page_id text REFERENCES pages_index(id) ON DELETE CASCADE,
  target_path    text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('page', 'asset', 'external', 'broken'))
);
CREATE INDEX IF NOT EXISTS links_source_idx ON links (source_page_id);
CREATE INDEX IF NOT EXISTS links_target_idx ON links (target_page_id);
