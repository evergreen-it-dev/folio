-- Round 3: whether a pages_index row represents its containing directory in
-- the tree (index.md always; README.md only when that directory has no
-- index.md). Missing from 001 — storage.ts's getTree()/scanSpace() need it
-- as a real column rather than re-deriving "basename === 'index.md'" (which
-- would silently miss the README-as-index case).
ALTER TABLE pages_index ADD COLUMN IF NOT EXISTS is_index boolean NOT NULL DEFAULT false;
