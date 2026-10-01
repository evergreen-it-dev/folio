-- Round FORMS: a seventh page kind. A `<slug>.form.md` file is a small
-- "fill this table in" UI paired 1:1 with a data table (shared/forms/codec.ts
-- owns the file format) — same shape 026_page_kind_pdf.sql /
-- 028_page_kind_office.sql added for 'pdf'/'office'.
ALTER TABLE pages_index DROP CONSTRAINT IF EXISTS pages_index_kind_check;
ALTER TABLE pages_index ADD CONSTRAINT pages_index_kind_check
  CHECK (kind IN ('doc', 'board', 'table', 'pdf', 'office', 'form'));

-- trash_items.kind (018_trash_items.sql) mirrors the same set of page kinds
-- plus its own 'folder'/'space' — a deleted form page must be recordable too.
ALTER TABLE trash_items DROP CONSTRAINT IF EXISTS trash_items_kind_check;
ALTER TABLE trash_items ADD CONSTRAINT trash_items_kind_check
  CHECK (kind IN ('doc', 'board', 'table', 'pdf', 'office', 'form', 'folder', 'space'));
