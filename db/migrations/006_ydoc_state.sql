-- P0 fix: "THE DOUBLING". bindState previously re-seeded a fresh Y.Doc from
-- the file on every server restart (tsx watch restarts constantly in dev),
-- assigning the seed insert NEW CRDT operation identity each time. A client
-- that held the page open across the restart still has its OWN copy of the
-- OLD identity's insert ops; on reconnect the two independently-originated
-- insertions of "the same" text merge as two real, unrelated edits — body
-- gets duplicated. Persisting the actual Yjs state (not just the plain-text
-- body) across restarts preserves identity, so a reconnecting client merges
-- into the SAME ops instead of a parallel copy.
--
-- Separate table, not a pages_index column: encodeStateAsUpdate() snapshots
-- are binary and can be large (proportional to a doc's edit history density,
-- not just its final text length) — keeping them out of pages_index avoids
-- bloating every row/index scan on that table for a field only collab.ts
-- ever reads.
CREATE TABLE IF NOT EXISTS ydoc_state (
  page_id    text PRIMARY KEY REFERENCES pages_index(id) ON DELETE CASCADE,
  snapshot   bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
