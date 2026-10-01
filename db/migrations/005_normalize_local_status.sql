-- Round 5 cleanup: a handful of local-only spaces (repo_url IS NULL) created
-- before the round-3 git-native status semantics existed still carry
-- whatever generic status string their original insert used (observed:
-- 'clean', which is really a post-sync-with-a-remote state per gitSync.ts's
-- performSync). They were never touched by registerReposOnBoot() (it only
-- INSERTs rows missing from the registry, never normalizes existing ones)
-- and never went through performSync (last_sync_at is still NULL for them),
-- so nothing else will fix this on its own. Narrowly scoped to the exact
-- stale case — never touches a space that has a real remote, is already
-- correctly 'local', or is sitting in a meaningful 'conflict'/'error' state.
UPDATE spaces
SET status = 'local'
WHERE repo_url IS NULL
  AND last_sync_at IS NULL
  AND status <> 'local';
