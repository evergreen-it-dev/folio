-- Round 27 (access and rights), spec-access.md §3/§4.
--
-- 1. New `spaces.visibility`: 'private' (default — only explicit
--    space_members) or 'instance' (plus every active user as an implicit,
--    read-only viewer). Existing spaces default to 'private': visibility is
--    an opt-in, not something that silently opens content up.
--
-- 2. Materialize the instance-admin bypass being removed from
--    server/auth/session.ts's effectiveRole()/membershipsFor() in the same
--    round: today `isAdmin` implies 'admin' on every space with no row in
--    space_members. Without this step, the day the bypass is removed every
--    instance-admin (including the owner) opens Folio to an empty sidebar —
--    their access was implicit, not stored. This makes it explicit and
--    revocable instead, for every space that exists AT MIGRATION TIME.
--    Idempotent (ON CONFLICT DO NOTHING) so re-running (or a space created
--    between two admins' migration runs) never overwrites an existing,
--    possibly-since-changed role.
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private';
ALTER TABLE spaces DROP CONSTRAINT IF EXISTS spaces_visibility_check;
ALTER TABLE spaces ADD CONSTRAINT spaces_visibility_check
  CHECK (visibility IN ('private', 'instance'));

INSERT INTO space_members (space_slug, user_id, role)
SELECT s.slug, u.id, 'admin'
FROM spaces s
CROSS JOIN users u
WHERE u.is_admin
ON CONFLICT (space_slug, user_id) DO NOTHING;
