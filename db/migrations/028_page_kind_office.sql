-- Round OFFICE: a sixth page kind. A `.docx`/`.xlsx`/`.pptx` file in a space's
-- repo directory indexes as a first-class, read-only page — same shape
-- 026_page_kind_pdf.sql added for 'pdf'. ONE kind, 'office', covers all three
-- formats (shared/contracts.ts's officeFormat() tells them apart by
-- extension) rather than three separate kinds.
ALTER TABLE pages_index DROP CONSTRAINT IF EXISTS pages_index_kind_check;
ALTER TABLE pages_index ADD CONSTRAINT pages_index_kind_check
  CHECK (kind IN ('doc', 'board', 'table', 'pdf', 'office'));

-- trash_items.kind (018_trash_items.sql) mirrors the same set of page kinds
-- plus its own 'folder'/'space' — a deleted office page must be recordable too.
ALTER TABLE trash_items DROP CONSTRAINT IF EXISTS trash_items_kind_check;
ALTER TABLE trash_items ADD CONSTRAINT trash_items_kind_check
  CHECK (kind IN ('doc', 'board', 'table', 'pdf', 'office', 'folder', 'space'));
