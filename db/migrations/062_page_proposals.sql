-- Agent write mode per space and the review queue ("On review"). Forward-only, safe to re-run.
--
--   spaces.agent_write_mode   'direct' (default: an agent's edit lands at once, as before)
--                             or 'review' (an agent's edit to a Markdown page waits here
--                             until an editor accepts it).
--
--   page_proposals            one row = one proposed body text.
--     page_id        the page being changed; NULL for a page that does not exist yet
--                    (create_page in review mode) - then parent_path + title name it.
--                    No foreign key, same reasoning as comment_threads.page_id: a trashed
--                    page returns with the same id.
--     base_hash      sha256 of the page text the proposal was made against. 'stale' is not
--                    stored: it is "base_hash differs from the hash of the text right now".
--     dedupe_key     page id, or 'new:<parent>/<title>' for a page that does not exist yet.
--                    At most ONE open proposal per (dedupe_key, author, token): the same
--                    token editing the same page again replaces the open proposal in place
--                    (same row, same id, no second notification).
--     author_id      the owner of the token (or the person running the assistant). The
--                    token id itself goes to token_id; audit_log carries both.
--     status         'pending' | 'accepted' | 'rejected'.
--     result_page_id the page a 'create' proposal produced when accepted.
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS agent_write_mode text NOT NULL DEFAULT 'direct';
ALTER TABLE spaces DROP CONSTRAINT IF EXISTS spaces_agent_write_mode_check;
ALTER TABLE spaces ADD CONSTRAINT spaces_agent_write_mode_check CHECK (agent_write_mode IN ('direct', 'review'));

CREATE TABLE IF NOT EXISTS page_proposals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_slug     text NOT NULL REFERENCES spaces(slug) ON DELETE CASCADE,
  page_id        text,
  parent_path    text NOT NULL DEFAULT '',
  title          text,
  dedupe_key     text NOT NULL,
  base_hash      text,
  markdown       text NOT NULL,
  author_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_id       text NOT NULL,
  source         text NOT NULL DEFAULT 'mcp',
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  reviewer_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  review_comment text,
  result_page_id text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz
);
CREATE INDEX IF NOT EXISTS page_proposals_space_idx ON page_proposals (space_slug, status, created_at);
CREATE INDEX IF NOT EXISTS page_proposals_page_idx ON page_proposals (page_id) WHERE page_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS page_proposals_open_uniq
  ON page_proposals (dedupe_key, author_id, token_id) WHERE status = 'pending';

-- A proposal is announced once per person and decided once: a retry or a replaced
-- proposal cannot notify again (the comment kinds have their own index in 061).
CREATE UNIQUE INDEX IF NOT EXISTS notifications_proposal_once_uniq
  ON notifications (user_id, kind, (payload->>'proposalId'))
  WHERE kind IN ('proposal_pending', 'proposal_decided');
