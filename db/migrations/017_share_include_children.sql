-- Round 23 (EXPORT), R23 addendum 2: "Include child pages" — one flag, two meanings.
--
--  * for a HUMAN following the share link: the page's whole subtree is
--    reachable through that link, not just the one page;
--  * for an AGENT / an export (`/share/<token>.md`, `.md`/`.pdf`/`.docx`):
--    the subtree is COLLATED into a single document.
--
-- Stored on the token itself (not passed per-request) so that revoking or
-- re-creating the link is the only way to change what it grants — a query
-- parameter alone must never be able to WIDEN a token's scope. The
-- per-request `?children=0|1` knob narrows within these rights only.
--
-- DEFAULT false, deliberately: every share link that already exists keeps
-- meaning exactly what it meant when it was handed out ("this one page"),
-- and no existing link silently starts exposing a subtree on deploy.
ALTER TABLE share_links
  ADD COLUMN IF NOT EXISTS include_children boolean NOT NULL DEFAULT false;
