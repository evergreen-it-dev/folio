-- Content-loss fix (06.10.2026). Two server-side guarantees around a doc
-- room's text (server/collab.ts):
--
-- 1. ydoc_state.file_body_sha256: sha256 of the body the room last wrote to
--    the page's file, stored together with the snapshot that produced it. On
--    the next open, a file that still hashes to this value has NOT changed
--    since — so a snapshot that differs from it is newer (its file write
--    failed) and wins, instead of being overwritten by the older markdown.
--    NULL (every row before this migration) keeps the old rule: the file wins.
ALTER TABLE ydoc_state ADD COLUMN IF NOT EXISTS file_body_sha256 text;

-- 2. page_text_backups: the text of a live room right before the server
--    itself replaces all of it (a file changed outside the room, a REST/MCP
--    body write, "take the version from Git"). The page's git history only
--    has what reached a commit; this keeps what was in the room. No foreign
--    key on purpose: a backup must outlive its page being deleted. Pruned on
--    insert (server/collab.ts backupRoomText).
CREATE TABLE IF NOT EXISTS page_text_backups (
  id         bigserial PRIMARY KEY,
  page_id    text NOT NULL,
  reason     text NOT NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS page_text_backups_page_idx ON page_text_backups (page_id, created_at DESC);
