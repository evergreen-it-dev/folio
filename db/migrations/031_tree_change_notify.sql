-- "The sidebar tree of a space changed" — one NOTIFY, from the only place every
-- change to the tree has to pass through: the tables the tree is READ from.
--
-- The tree (GET /api/spaces/:space/tree) is built from pages_index and
-- filtered by page_access / page_access_grants. Whatever created, renamed,
-- moved, deleted, restored or re-protected a page — a REST route, an MCP
-- tool, the assistant, an import, a copy, the trash, scanSpace after a git
-- sync, a psql session — ends in a write to one of these three tables. A
-- trigger cannot be forgotten by a code path added next year; a call to
-- "notifyTreeChanged()" from each route can.
--
-- The payload is deliberately only {"schema": ..., "space": <slug>}: a slug
-- is not a secret for anybody who is a member of the space, and the server
-- (server/treeSignal.ts) forwards it ONLY to those. No title, path or page id
-- ever leaves the database through this channel. The schema name keeps
-- several schemas in one database (the isolated test schemas; a second
-- instance on a shared database) from hearing each other.
--
-- NOTIFY is delivered at COMMIT, so a listener never sees a change that is
-- rolled back, and by the time it hears one the new rows are visible to its
-- next query. Identical notifications within one transaction are folded by
-- PostgreSQL itself.
--
-- pages_index UPDATEs fire only when a column the tree shows changed (path,
-- kind, title, order, status, icon, cover, space, is_index): an autosave that
-- rewrites plain_text / updated_at / the full-text vector must stay silent.

CREATE OR REPLACE FUNCTION folio_notify_tree_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  slug text;
  old_slug text;
  pid text;
BEGIN
  IF TG_TABLE_NAME = 'pages_index' THEN
    IF TG_OP = 'DELETE' THEN
      slug := OLD.space_slug;
    ELSE
      slug := NEW.space_slug;
      IF TG_OP = 'UPDATE' AND OLD.space_slug IS DISTINCT FROM NEW.space_slug THEN
        old_slug := OLD.space_slug;
      END IF;
    END IF;
  ELSE
    -- page_access and page_access_grants: both carry page_id.
    IF TG_OP = 'DELETE' THEN
      pid := OLD.page_id;
    ELSE
      pid := NEW.page_id;
    END IF;
    -- No row means the page itself is being deleted (the cascade got here
    -- second); its own pages_index trigger has already announced that.
    SELECT p.space_slug INTO slug FROM pages_index p WHERE p.id = pid;
  END IF;

  IF slug IS NOT NULL THEN
    PERFORM pg_notify('folio_tree_changed', json_build_object('schema', current_schema(), 'space', slug)::text);
  END IF;
  IF old_slug IS NOT NULL THEN
    PERFORM pg_notify('folio_tree_changed', json_build_object('schema', current_schema(), 'space', old_slug)::text);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS pages_index_tree_notify_rows ON pages_index;
CREATE TRIGGER pages_index_tree_notify_rows
  AFTER INSERT OR DELETE ON pages_index
  FOR EACH ROW EXECUTE PROCEDURE folio_notify_tree_changed();

DROP TRIGGER IF EXISTS pages_index_tree_notify_update ON pages_index;
CREATE TRIGGER pages_index_tree_notify_update
  AFTER UPDATE ON pages_index
  FOR EACH ROW
  WHEN (
    OLD.space_slug IS DISTINCT FROM NEW.space_slug
    OR OLD.path IS DISTINCT FROM NEW.path
    OR OLD.kind IS DISTINCT FROM NEW.kind
    OR OLD.title IS DISTINCT FROM NEW.title
    OR OLD.sort_order IS DISTINCT FROM NEW.sort_order
    OR OLD.status IS DISTINCT FROM NEW.status
    OR OLD.icon IS DISTINCT FROM NEW.icon
    OR OLD.cover IS DISTINCT FROM NEW.cover
    OR OLD.is_index IS DISTINCT FROM NEW.is_index
  )
  EXECUTE PROCEDURE folio_notify_tree_changed();

DROP TRIGGER IF EXISTS page_access_tree_notify ON page_access;
CREATE TRIGGER page_access_tree_notify
  AFTER INSERT OR UPDATE OR DELETE ON page_access
  FOR EACH ROW EXECUTE PROCEDURE folio_notify_tree_changed();

DROP TRIGGER IF EXISTS page_access_grants_tree_notify ON page_access_grants;
CREATE TRIGGER page_access_grants_tree_notify
  AFTER INSERT OR UPDATE OR DELETE ON page_access_grants
  FOR EACH ROW EXECUTE PROCEDURE folio_notify_tree_changed();
