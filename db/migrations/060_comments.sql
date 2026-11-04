-- Inline comments on doc pages (docs/spec.md §4.4, contract: shared/comments.ts).
-- Forward-only, safe to re-run.
--
-- A thread is anchored to a range of the page's Y.Text 'content' by a pair of
-- Y.RelativePosition. The server never decodes them: anchor_from / anchor_to are
-- the bytes of Y.encodeRelativePosition, kept opaque; the client resolves them
-- against its live Y.Doc and falls back to quoted_text when they no longer do.
-- Comments never go into the markdown file, so they stay out of git.
--
--   comment_threads.page_id  deliberately NO foreign key to pages_index. A page id
--                            is stable across rename and move (the row keeps its id
--                            and gets the new path), so those need nothing. Trash is
--                            the reason: deleting a page removes its pages_index row
--                            (and cascades ydoc_state, page_access), and a restore
--                            claims the SAME id again. With ON DELETE CASCADE every
--                            comment would be lost on delete -> restore. Without the
--                            key they wait in the table; the routes reach a thread
--                            only through its page (requireEntry), so a trashed
--                            page's comments are unreachable until it returns. Page
--                            ids are ulids and never reused, so rows left by a
--                            permanent purge are inert, never mis-attached (the same
--                            reasoning as page_change_history and page_text_backups).
--   comment_threads.status   'open' | 'resolved'; resolved_by / resolved_at are set
--                            while resolved and cleared on reopen.
--   created_by, resolved_by, comments.author_id
--                            ON DELETE SET NULL: removing an account must not erase
--                            the conversation; it is shown as an unknown author.
--   comments.thread_id       ON DELETE CASCADE: a thread is its comments. The
--                            thread's first comment is its opening comment; the
--                            service deletes the whole thread when it is removed.
CREATE TABLE IF NOT EXISTS comment_threads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id     text NOT NULL,
  anchor_from bytea NOT NULL,
  anchor_to   bytea NOT NULL,
  quoted_text text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS comment_threads_page_idx ON comment_threads (page_id, created_at);

CREATE TABLE IF NOT EXISTS comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id  uuid NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  author_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at  timestamptz
);
CREATE INDEX IF NOT EXISTS comments_thread_idx ON comments (thread_id, created_at);
