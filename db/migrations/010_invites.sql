-- Round 9: invites by link. token is a 32-hex random string (same
-- randomBytes(16).toString('hex') shape as share_links.token), plaintext for
-- the same reason share_links.token is: GET /api/invites needs to keep
-- showing the full inviteable URL every time it's listed.
-- memberships is a JSON array of {space, role} objects — the set of
-- space_members rows accepting this invite will create. is_admin, separately,
-- grants instance-admin on accept; only an instance admin may set it true
-- (enforced in the route, not here).
CREATE TABLE IF NOT EXISTS invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token       text NOT NULL UNIQUE,
  created_by  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_admin    boolean NOT NULL DEFAULT false,
  memberships jsonb NOT NULL DEFAULT '[]',
  -- Pinned recipient email, optional: when set, POST /accept must match it exactly.
  email       text,
  expires_at  timestamptz NOT NULL,
  -- 0 = unlimited uses; otherwise the accept route claims a use atomically
  -- (UPDATE ... WHERE uses < max_uses RETURNING) so two concurrent accepts
  -- against max_uses=1 can never both succeed.
  max_uses    integer NOT NULL DEFAULT 1,
  uses        integer NOT NULL DEFAULT 0,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invites_created_by_idx ON invites(created_by);
