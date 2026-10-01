-- Round 5: frontmatter icon/cover parsed into PageMeta everywhere (tree included).
ALTER TABLE pages_index ADD COLUMN IF NOT EXISTS icon text;
ALTER TABLE pages_index ADD COLUMN IF NOT EXISTS cover text;
