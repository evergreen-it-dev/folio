-- Page-level rights. The absence of a row in page_access means ordinary
-- access through the space; the presence of a row turns on the private mode of the page.
CREATE TABLE IF NOT EXISTS page_access (
  page_id    text PRIMARY KEY REFERENCES pages_index(id) ON DELETE CASCADE,
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS page_access_grants (
  page_id text NOT NULL REFERENCES page_access(page_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    text NOT NULL CHECK (role IN ('viewer', 'editor')),
  PRIMARY KEY (page_id, user_id)
);

CREATE INDEX IF NOT EXISTS page_access_grants_user_idx ON page_access_grants(user_id);
