-- Round 8: share links — unauthenticated view/edit access to exactly ONE
-- page via a bare token in a URL. token is stored PLAINTEXT (not hashed,
-- unlike sessions/api_tokens): a share link behaves like a listable,
-- manageable resource rather than a password — GET /api/pages/:id/shares
-- needs to keep showing the full shareable URL (which embeds the token)
-- every time it's listed, not just once at creation.
CREATE TABLE IF NOT EXISTS share_links (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token      text NOT NULL UNIQUE,
  page_id    text NOT NULL REFERENCES pages_index(id) ON DELETE CASCADE,
  mode       text NOT NULL CHECK (mode IN ('view', 'edit')),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS share_links_page_id_idx ON share_links(page_id);
