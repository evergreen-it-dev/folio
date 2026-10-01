-- Round 3 (git-native spaces) + round 4 scan-perf follow-up.

-- 'local' = auto-registered space with no remote (round 4's plain data/spaces
-- import, and round 3's "empty space" / pre-existing data/repos dir with no
-- .git remote configured). shared/contracts.ts's spaceGitStatusSchema already
-- includes it; the CHECK constraint from 001 predates that and needs widening.
ALTER TABLE spaces DROP CONSTRAINT IF EXISTS spaces_status_check;
ALTER TABLE spaces ADD CONSTRAINT spaces_status_check
  CHECK (status IN ('local', 'clean', 'syncing', 'ahead', 'behind', 'conflict', 'error'));

-- Content-based staleness for scanSpace (DEV-PLAN round 4 follow-up: a 16k-file
-- repo must not re-read+re-parse every file on every rescan). A row is skipped
-- during a rescan when the file's current (mtime, size) still matches what's
-- stored here; either changing is enough to force a re-read.
ALTER TABLE pages_index ADD COLUMN IF NOT EXISTS file_mtime timestamptz;
ALTER TABLE pages_index ADD COLUMN IF NOT EXISTS file_size bigint;
