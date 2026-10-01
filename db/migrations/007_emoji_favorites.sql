-- Round 6 addendum: personal emoji favorites reuse the existing stars
-- mechanism as a third kind rather than a new table — same shape (per-user,
-- ordered, toggle on/off), just `key` is the emoji character(s) instead of a
-- space slug or page id.
ALTER TABLE stars DROP CONSTRAINT IF EXISTS stars_kind_check;
ALTER TABLE stars ADD CONSTRAINT stars_kind_check
  CHECK (kind IN ('space', 'page', 'emoji'));
