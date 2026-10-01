-- Adds 'page.delete' to the allowed actions of page_change_history: the
-- deletion of a page now gets into the personal history too and is undone
-- through the trash (server/pageChanges.ts undoPageChange -> trash/service.ts
-- restoreTrashItem). The name of the constraint is the automatic one from 021_page_change_history.sql.
ALTER TABLE page_change_history DROP CONSTRAINT IF EXISTS page_change_history_action_check;
ALTER TABLE page_change_history ADD CONSTRAINT page_change_history_action_check
  CHECK (action IN ('page.create', 'page.copy', 'page.rename', 'page.move', 'page.slug', 'page.delete'));
