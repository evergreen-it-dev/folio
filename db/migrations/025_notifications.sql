-- Notifications and access requests (round 31). The owner's decision of
-- 11.09.2026: access is asked for to a SPACE (not to a page), the role on
-- approval is chosen by the administrator, for now only the access request
-- lives in the feed — but the kind of a notification is a separate column, so
-- that a mention through @ is an extension of the list, not a rework of the table.

-- A request is an entity of its own, not a field inside a notification:
-- there are several administrators, each sees it in their feed, and without
-- a shared status two of them would grant access twice.
CREATE TABLE IF NOT EXISTS access_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_slug         text NOT NULL REFERENCES spaces(slug) ON DELETE CASCADE,
  requester_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status             text NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  -- The role granted on approval: the list is the same as in space_members.role.
  granted_role       text CHECK (granted_role IN ('viewer', 'editor', 'admin')),
  -- SET NULL, not CASCADE: a deleted administrator must not take the request
  -- itself away — it has already changed somebody's rights, and the trace of
  -- that has to stay even without the name of the one who decided.
  decided_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz
);

-- One person — one LIVE request per space. A partial unique index (not a
-- UNIQUE on a pair of columns) exactly because after a refusal a person has
-- the right to ask again: closed requests stay as history and do not get in the way.
CREATE UNIQUE INDEX IF NOT EXISTS access_requests_pending_uniq
  ON access_requests (space_slug, requester_user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS access_requests_space_idx ON access_requests (space_slug, created_at DESC);

-- A feed row of a PARTICULAR recipient: one request produces as many rows as
-- it has addressees, because everybody has their own read state.
CREATE TABLE IF NOT EXISTS notifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('access_request', 'access_decision')),
  -- Nullable on purpose: future kinds (a mention through @) will have no
  -- request, and the feed simply does not show a row without one (INNER JOIN in store.ts).
  access_request_id uuid REFERENCES access_requests(id) ON DELETE CASCADE,
  read_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- The only query of the feed is "mine, newest first"; the counter of unread
-- items goes by the same index.
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);
