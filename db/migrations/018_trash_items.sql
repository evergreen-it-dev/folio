-- Trash round (DEV-PLAN "Round 27 — trash: restoring what was deleted").
--
-- trash_items: one row per deletePage() call — the DB-side record of what
-- data/.trash/<stamp>/<space>/<path> holds, so the UI can list/restore it.
-- Deliberately NO foreign key on space_slug: a kind='space' row outlives its
-- `spaces` row by definition (the cascade that removed the space is exactly
-- what this table exists to undo), and an ON DELETE CASCADE here would erase
-- the trash record together with the space it's supposed to resurrect.
--
-- deleted_by keeps the (uuid) FK on users with SET NULL — "who deleted it" is
-- display metadata; a deleted account degrades to the same null the
-- best-effort backfill of a pre-existing data/.trash/** uses.
--
-- trash_path is UNIQUE: it's the on-disk identity of the item (relative to
-- data/.trash), and the boot-time backfill relies on ON CONFLICT
-- (trash_path) DO NOTHING to stay idempotent across restarts.
--
-- payload (jsonb) is only populated for kind='space': a snapshot of the
-- spaces row (name/git config/visibility/asset_mode) and space_members
-- (userId+role), captured BEFORE the DELETE FROM spaces cascade destroys
-- them — without it a restored space would come back with its files but
-- with no members and no git identity.
CREATE TABLE IF NOT EXISTS trash_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_slug     text NOT NULL,
  -- Original page id (frontmatter id / board's folio-id comment); for
  -- kind='space' — the space slug itself.
  page_id        text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('doc', 'board', 'table', 'folder', 'space')),
  -- Path relative to the space's content root at deletion time; the moved
  -- DIRECTORY for kind='folder', '' for kind='space'.
  orig_path      text NOT NULL,
  title          text NOT NULL,
  deleted_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  deleted_at     timestamptz NOT NULL DEFAULT now(),
  -- Where the files went, relative to data/.trash (starts with the stamp dir).
  trash_path     text NOT NULL UNIQUE,
  -- For folder/space: how many pages moved along with the target.
  children_count integer NOT NULL DEFAULT 0,
  payload        jsonb
);
CREATE INDEX IF NOT EXISTS trash_items_space_idx ON trash_items(space_slug);
CREATE INDEX IF NOT EXISTS trash_items_deleted_at_idx ON trash_items(deleted_at);

-- Retention policy, single-row settings table. retention_days NULL (the
-- default) = NO auto-purge ever — the owner must never lose trash data by
-- surprise; a set value enables the LAZY purge that runs when the trash
-- list is opened (server/trash/service.ts). Manual "empty the trash" exists
-- regardless of this setting.
CREATE TABLE IF NOT EXISTS trash_settings (
  id             smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  retention_days integer CHECK (retention_days IS NULL OR retention_days > 0)
);
INSERT INTO trash_settings (id, retention_days) VALUES (1, NULL) ON CONFLICT (id) DO NOTHING;
