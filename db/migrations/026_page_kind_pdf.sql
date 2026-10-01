-- Round PDF: a fourth page kind. A `.pdf` file in a space's repo directory
-- indexes as a first-class, read-only page — same shape 015_page_kind_table.sql
-- added for 'table'. shared/contracts.ts's pageKindSchema is the
-- corresponding TS union (now 'doc' | 'board' | 'folder' | 'table' | 'pdf' —
-- 'folder' stays client-only synthetic, never stored here).
ALTER TABLE pages_index DROP CONSTRAINT IF EXISTS pages_index_kind_check;
ALTER TABLE pages_index ADD CONSTRAINT pages_index_kind_check
  CHECK (kind IN ('doc', 'board', 'table', 'pdf'));

-- trash_items.kind (018_trash_items.sql) mirrors the same set of page kinds
-- plus its own 'folder'/'space' — a deleted pdf page must be recordable too.
ALTER TABLE trash_items DROP CONSTRAINT IF EXISTS trash_items_kind_check;
ALTER TABLE trash_items ADD CONSTRAINT trash_items_kind_check
  CHECK (kind IN ('doc', 'board', 'table', 'pdf', 'folder', 'space'));
