-- Comments on things that are not a span of text: board elements now, table
-- cells next. Forward-only, safe to re-run.
--
--   target       jsonb, NULL for the text threads of doc pages. One shape per kind
--                (contract: shared/comments.ts, commentTargetSchema):
--                  {"kind":"board_element","elementId":"...","label":"..."}
--                  {"kind":"table_cell","rowId":"...","columnId":"...","label":"..."}
--                `label` is a snapshot of what the target looked like when the
--                thread began (the element's text or type), so a thread whose
--                element was deleted can still say what it was about.
--   anchor_from, anchor_to, quoted_text
--                now nullable: only a text thread has them. A row is either a
--                text thread (all three set, no target) or a target thread
--                (a target) — the CHECK keeps a half-filled row out.
--
-- Old rows are text threads and are not touched. Threads of a deleted element
-- stay: nothing here references the board's content.
ALTER TABLE comment_threads ALTER COLUMN anchor_from DROP NOT NULL;
ALTER TABLE comment_threads ALTER COLUMN anchor_to DROP NOT NULL;
ALTER TABLE comment_threads ALTER COLUMN quoted_text DROP NOT NULL;
ALTER TABLE comment_threads ADD COLUMN IF NOT EXISTS target jsonb;

ALTER TABLE comment_threads DROP CONSTRAINT IF EXISTS comment_threads_anchor_or_target;
ALTER TABLE comment_threads ADD CONSTRAINT comment_threads_anchor_or_target CHECK (
  (target IS NULL AND anchor_from IS NOT NULL AND anchor_to IS NOT NULL AND quoted_text IS NOT NULL)
  OR (target IS NOT NULL AND jsonb_typeof(target) = 'object' AND target ? 'kind')
);
