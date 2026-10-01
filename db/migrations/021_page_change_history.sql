-- A personal history of structural changes to pages, for a safe undo.
--
-- It is not a replacement for audit_log: audit_log answers the question "who
-- did what", and page_change_history additionally stores the server-controlled
-- "before/after" states needed for the reverse operation. There is
-- deliberately no FK to pages_index/space: a created page can be undone (and
-- it disappears from the index), but the record of an already undone action
-- has to stay correct.
CREATE TABLE IF NOT EXISTS page_change_history (
  id           bigserial PRIMARY KEY,
  actor_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_slug   text NOT NULL,
  page_id      text NOT NULL,
  action       text NOT NULL CHECK (action IN ('page.create', 'page.copy', 'page.rename', 'page.move', 'page.slug')),
  before_state jsonb,
  after_state  jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  undone_at    timestamptz
);

CREATE INDEX IF NOT EXISTS page_change_history_actor_space_idx
  ON page_change_history (actor_id, space_slug, id DESC)
  WHERE undone_at IS NULL;
