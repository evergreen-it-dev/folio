-- The title of a file page is the whole basename with the extension
-- (storage.ts's titleFallback, 16.09). The code was changed, but the rows
-- already indexed stayed with the old title: scanSpace skips a file whose
-- mtime and size did not change, so titleFallback is never called for it
-- again. This UPDATE is a one-time catch-up for existing rows; after that the
-- scan keeps the title current itself (see the `unchanged` condition in the
-- same place, which now compares the title too).
--
-- tsv is updated with the same formula as upsertPagesIndexRow: the title has
-- weight 'A', plain_text — 'B' (for pdf/office it is NULL). Without this a
-- search for "offer.pptx" would find nothing, although the title in the tree
-- already has the extension.
UPDATE pages_index
   SET title = regexp_replace(path, '^.*/', ''),
       tsv = setweight(to_tsvector('simple', unaccent(regexp_replace(path, '^.*/', ''))), 'A')
          || setweight(to_tsvector('simple', unaccent(coalesce(plain_text, ''))), 'B')
 WHERE kind IN ('pdf', 'office')
   AND title <> regexp_replace(path, '^.*/', '');
