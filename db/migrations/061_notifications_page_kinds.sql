-- Notifications about pages (comment mentions/replies now; review proposals and
-- review reminders later). Forward-only, safe to re-run.
--
--   kind        widened: the access kinds stay, five page kinds are added.
--   page_id     the page the row is about. No foreign key, same reasoning as
--               comment_threads.page_id: a trashed page returns with the same id.
--   payload     what the row needs to be drawn without a join: space, page title,
--               thread/comment ids, author, excerpt. A snapshot, never a source of truth.
--   access_request_id stays nullable (it already was): page kinds have none.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('access_request', 'access_decision', 'comment_mention', 'comment_reply', 'proposal_pending', 'proposal_decided', 'review_due'));

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS page_id text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;

-- One row per person per comment and kind: a retried hook cannot notify twice.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_comment_once_uniq
  ON notifications (user_id, (payload->>'commentId'))
  WHERE kind IN ('comment_mention', 'comment_reply');
