-- A request for access to ONE PAGE (not to the whole space): a person who has
-- a role in the space but is shut out by a page restricted to named people asks
-- that page's owner (migration 025 sent every request to space admins; the
-- owner later decided restricted pages need their own request).
--
-- NULL page_id = the old space-level request, unchanged. The page is removed
-- with its requests (CASCADE): a request about a deleted page asks for nothing.
ALTER TABLE access_requests
  ADD COLUMN IF NOT EXISTS page_id text REFERENCES pages_index(id) ON DELETE CASCADE;

-- One LIVE request per person per space (page_id NULL) and per person per page.
DROP INDEX IF EXISTS access_requests_pending_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS access_requests_pending_uniq
  ON access_requests (space_slug, requester_user_id, COALESCE(page_id, ''))
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS access_requests_page_idx ON access_requests (page_id) WHERE page_id IS NOT NULL;
