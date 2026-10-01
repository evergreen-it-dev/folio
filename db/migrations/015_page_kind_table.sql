-- Round 26 (DATA TABLES): a data table is a third page kind, alongside 'doc'
-- and 'board' — a page whose file is `<slug>.table.md` and whose content is
-- schema + rows rather than free-form markdown or an excalidraw scene. See
-- docs/spec-tables.md for the file format and shared/contracts.ts's
-- pageKindSchema for the corresponding TS union (now 'doc' | 'board' |
-- 'folder' | 'table' — 'folder' is a client-only synthetic kind, never
-- stored here).
ALTER TABLE pages_index DROP CONSTRAINT IF EXISTS pages_index_kind_check;
ALTER TABLE pages_index ADD CONSTRAINT pages_index_kind_check
  CHECK (kind IN ('doc', 'board', 'table'));
