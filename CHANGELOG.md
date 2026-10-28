# Changelog

Notable changes to Folio. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **Single sign-on returns to the page you opened.** Signing in through an
  OpenID Connect or SAML provider (Google included) used to land on `/` and then
  on the last space, so a shared link had to be opened again. The login screen
  now sends the current address (path, query and hash) as `returnTo`; the server
  keeps it in the signed flow cookie, accepts only a same-site path (no
  `//`, backslashes, control characters, `/login` or `/api`, at most 1024
  characters) and lands there after sign-in. Accepting an invitation through a
  provider opens the invited space; an MCP OAuth consent step interrupted by
  sign-in resumes on the consent screen. A failed sign-in comes back to the
  same page with `?authError=`.

## [0.4.2] - 2026-10-23

Groups and single sign-on. People can be put in groups that hold roles in
spaces and on restricted pages, sign in through your identity provider with
OpenID Connect or SAML 2.0, and be created, updated and deactivated by SCIM.
Instance administrators get an audit log screen and session management.
**Page restrictions are now inherited by child pages** (see Changed: read it
before upgrading). Adds migrations 053 to 057 and 059.

### Added

- **Groups.** A named set of people that holds a role (viewer, editor, admin) in a
  space and a grant on a restricted page. A person's role is the highest of
  their own, their active groups' and the implicit viewer role of an
  instance-visible space. Instance administrators create, rename, archive and
  delete groups; members marked as managers edit the membership; a space
  administrator grants or revokes a group's role in their own space. Groups show
  up in a new Groups tab of the Access page, in the access matrix, the space
  members dialog, the page access dialog and invitations, and their changes in
  the access log. A space keeps at least one administrator, counting admins
  through groups. No nested groups; "All members" stays the `instance`
  visibility (migration 053).
- **Single sign-on through OpenID Connect.** Keycloak, Authentik, Microsoft Entra
  ID, Okta, Google and any other provider; several at once. Providers are
  configured by an administrator at `/admin/auth` (with "Test connection", which
  shows what the provider sends) or with `FOLIO_OIDC_<SLUG>_*` environment
  variables. The login page asks for an email first and routes an address of
  your domain to its provider. Accounts can be created at first sign-in with
  preset spaces; an existing account is linked only when the provider has
  verified the email in an allowed domain. Invitations to such a domain are
  accepted through the provider (migration 054).
- **Enforced single sign-on.** Password sign-in can be switched off for your
  domains, with an audited emergency password sign-in for instance
  administrators at `/login?local`.
- **Single sign-on through SAML 2.0.** Microsoft Entra ID, Okta, Keycloak, Google
  Workspace, ADFS and others, configured at `/admin/auth` (from the IdP's
  metadata URL or XML) or with `FOLIO_SAML_<SLUG>_*` environment variables, with
  the same account rules, "Test connection" and login-page routing as OpenID
  Connect. Folio accepts only signed assertions that answer the sign-in the
  browser started, checks issuer, audience and validity (120 s clock skew),
  refuses replayed assertions and XML with a `DOCTYPE`, and publishes its SP
  metadata at `/api/auth/saml/<slug>/metadata` (migration 056).
- **Group sync from the identity provider** (OpenID Connect and SAML). Per
  provider, at every sign-in Folio adds people to the Folio groups the groups
  claim or attribute names and removes them from the ones the provider no longer
  reports. Matching by name or slug, or by an explicit table; optionally creates
  missing groups; an allowlist (prefixes or a regular expression) narrows the IdP
  groups considered. Memberships added by hand and manager flags are never
  touched, archived groups are skipped, and the last administrator of a space is
  never removed this way. Entra ID "overage" (too many groups for the token)
  changes nothing and is audited. Set in the provider dialog or with
  `FOLIO_OIDC_<SLUG>_GROUP_SYNC` / `FOLIO_SAML_<SLUG>_GROUP_SYNC`, `_GROUP_SYNC_MODE`,
  `_GROUP_MAP`, `_GROUP_CREATE`, `_GROUP_ALLOW`. The Groups tab marks groups and
  members that come from a provider (migration 057).
- **SCIM 2.0 provisioning** at `/scim/v2` (users and groups; Okta, Microsoft Entra
  ID, Keycloak plugins, OneLogin, JumpCloud). A bearer token per sign-in
  provider, generated, rotated and revoked at `/admin/auth` and stored hashed;
  filters on `userName`, `externalId`, emails, `displayName` and members;
  create, replace, patch (including Entra ID's forms) and delete. DELETE
  deactivates rather than deletes, and archives groups. A provisioned person is
  recognized at first sign-in by the `externalId` (SAML: also the `userName`)
  equal to the sign-in subject, otherwise by the SCIM email equal to the
  sign-in email in an allowed domain (so Entra ID over OpenID Connect works
  without `email_verified`), otherwise by the verified-email rule. While SCIM is
  on, accounts are not created at first sign-in (migration 059).
- **Audit log screen** for instance administrators (`/admin/audit`): filter by
  actor, action prefix, target and dates, load page by page, readable names for
  known actions, and a streamed CSV export of the current filter (up to 100,000
  rows). New audited actions: `auth.*` for sign-ins and group sync, `scim.*`,
  `group.*`, `user.disable`, `user.enable`, `session.revoke`, `session.revoke_all`
  and `audit.export`.
- **Sign-in sessions.** Everyone can see their sessions (device, address, last
  activity) in Settings and sign out their other devices; an administrator can
  end one or all sessions of a person. Sessions record when and from where they
  were last used (migration 055). New setting `FOLIO_SESSION_TTL_DAYS` (default
  30).

### Changed

- **Behaviour change: page restrictions are now inherited by child pages**
  (like Confluence view restrictions). A page is readable only by whoever
  passes its own restriction and those of all its restricted ancestors; the
  role on it is the lowest of the roles they give, so a child can narrow its
  parent's audience but never widen it. On upgrade, the children of restricted
  pages become restricted. Run `npm run access:inherit-report` (read-only, uses
  `DATABASE_URL`) before upgrading to see which pages lose which readers.
  Moves follow the new place of a page; copies, duplicates and templates of a
  page restricted through its parent stay restricted; a page restored from the
  trash never comes back more open than it was. Share links keep their
  meaning, and public sites no longer show anything below a restricted page.
  The page access dialog shows "Restricted by parent page …" and who can open
  the page, and the sidebar marks restricted pages with a lock.
- "Sign in with Google" is now an OpenID Connect provider and checks the ID
  token's signature. Existing Google accounts keep signing in; the redirect URL
  does not change.
- The compare feature is now called "side-by-side comparison" in the interface:
  "Compare side by side" in the sidebar menu and the page header, a "Side by side
  · N" chip at the bottom of the window, "Compare side by side with current" and
  "Add to side by side" in the history panel.
- Side-by-side columns are compact: they no longer use the full-page reading
  width, and tables and code scroll inside their own box instead of being
  clipped. A zoom control at the bottom (and Ctrl/Cmd with `-`, `=`, `0`) scales
  every column's content together, from 50 to 125%, and is remembered in the
  browser.

### Security

- Deactivating a person now also revokes their personal API tokens and MCP OAuth
  connections and closes their open editor and notification connections, not
  just their browser sessions.

### Fixed

- Board, canvas, artifact and PDF/Office columns no longer get the shared zoom: a
  board was clipped and pointer positions were off when the zoom was not 100%.

## [0.4.1] - 2026-10-22

Compare pages and versions side by side, custom page templates, artifacts for
Claude and Cursor, and a clearer Folio AI. Pages and versions open in up to five
columns, with the changes highlighted and a link to share. Any page can be a
template, the MCP server has 45 tools (four of them for templates), Claude
artifacts and Cursor canvases become interactive pages, and properties update
live for everyone on the page. Share links open in your own account, copying
pages is about ten times faster on large spaces, and page exports are no longer
served stale behind a CDN. Adds migrations 049 to 052.

### Added

- **Compare pages and versions side by side.** Up to five pages, or older
  versions of a page, in one view (`/compare?items=…`). "Add to comparison" is in
  the sidebar and right-click menu (people who can only read a space get it too),
  in the page header and in the history panel. A "Comparison · N" chip at the
  bottom of the window holds the list (any spaces you can open, kept in the
  browser). A column of a current page is the page itself, with the live editor and
  live collaboration. In the history panel, "Compare with current" opens the page
  with the chosen version beside it, read-only, and "Add to comparison" sets a
  version aside. "Highlight changes" marks every version column against the
  leftmost one (green: new or changed blocks; red, struck through: removed text,
  with a count), "Refresh base" rereads the leftmost column, and synchronized
  scrolling keeps the columns together. "Copy link" copies an address with only
  page ids and version numbers; whoever opens it sees each column with their own
  access. Highlighting is block by block and skips a very large page; see
  [LIMITATIONS.md](docs/LIMITATIONS.md).
- **Template tools for MCP and the assistant.** Four new tools, 45 in all (21
  read-only, 24 that write): `list_templates`, `create_page_from_template`,
  `save_page_as_template` and `create_template`. `create_page` refuses a
  `parentPath` inside `_templates/` and points to them. The assistant in Agent mode
  has the same tools, and its guide to them covers templates. See [MCP.md](docs/MCP.md).
- **Live status for Folio AI runs.** The status line shows the model's thinking
  with a token counter, an elapsed-time counter after about three seconds of
  silence (a long page being written reports nothing for minutes) and the real
  tool names instead of a generic "mcp". The live reply keeps its paragraph breaks
  and renders Markdown links. The server logs the timing of each step of a run and
  stores it with the run (`ai_runs.timing`, migration 052).
- **Artifacts: publish Claude artifacts and Cursor canvases.** A new page kind,
  "Artifact": an interactive page made by an agent (a Claude artifact, a Cursor
  canvas or any self-contained HTML page) that lives in the tree, search, trash and
  Git like any other page. On disk it is a folder `<name>.artifact/` with
  `index.html`, an `artifact.yaml` manifest (type, origin, the capabilities the page
  expects, properties), the original source and `assets/`. It runs in a sandboxed
  iframe without cookies or access to the Folio API (`/art/<signed token>/…`, a
  `sandbox` Content-Security-Policy, scripts and fonts only from cdnjs, jsDelivr,
  unpkg, Tailwind, jQuery, esm.sh and Google Fonts); filters, tabs and charts work,
  and state is kept through `window.storage` (the Claude artifact API) and
  `localStorage`: in the database for signed-in readers (migration 051), in the
  browser for guests. Import with "Artifact…" in the "+" menu: a link to an
  `.html`, `.zip`, `.svg` or `.md` file, a file, pasted HTML, or the embed code of a
  Claude artifact; claude.ai and Cursor share links are not downloaded (the dialog
  suggests publishing over MCP). On the page: "Show source", "Download .zip",
  "Replace…", and a "works partially" note when the page expects calls to Claude,
  network access or connectors. New MCP tool **`publish_artifact`** creates an artifact or replaces one by `id`; `read_page` returns an artifact's
  manifest, files and entry HTML; `kind:artifact` works in search. The MCP request
  body limit outside the demo is now 25 MB, so a page with its data inlined fits.
  Folio does not build JSX or TSX: agents send finished HTML. See
  [FEATURES.md](docs/FEATURES.md), [MCP.md](docs/MCP.md) and
  [LIMITATIONS.md](docs/LIMITATIONS.md).
- **Custom page templates.** Any page in the space's `_templates/` folder is a
  template: a document, board, data table, form, base, or a whole page with
  subpages (before, only plain documents directly in the folder worked, one menu
  item each). "From template…" in the "+" menu (space root and every tree row)
  opens a picker, with a filter when there are more than six; creating copies the
  template with its subpages, properties and icon to the chosen place
  (`POST /api/pages/from-template`). In documents `{{date}}`, `{{author}}` and
  `{{title}}` are filled in; other `{{…}}` are left as they are. "Make template"
  in a page's context menu or "…" menu opens a dialog: the template name
  (prefilled with the page title), an optional description, and an "Include
  subpages" checkbox when the page has children. While it works the button says
  "Creating…" and the dialog can't be dismissed; afterwards the Templates section
  expands and a toast offers "Open". It copies the page into `_templates/`
  (`POST /api/pages/:id/make-template` with `title`, `description` and
  `includeChildren`); not for the space root, and disabled offline. The
  description is stored as the template's property `template-description`: it
  shows as a second line in the picker and as a tooltip in the sidebar, and a
  page created from the template does not get it. Editors get a "Templates"
  section in the sidebar (collapsed, with a count, rename and delete in the tree)
  whose "+", like the picker's empty-state button, opens the same dialog and
  creates a blank document template (`POST /api/spaces/:space/templates` with
  `title` and optional `description`; the items of `GET` on it carry
  `description`); an open template is marked "Template" in the breadcrumbs. The
  folder stays hidden from the page tree, graph, tags, bases and public sites. A
  new empty space starts with three templates in the creator's language (English
  or Ukrainian): Meeting notes, How-to, Decision record. Spaces cloned from Git
  get none.
- Error reporting can attach a recording of recent actions to a report (Sentry
  Session Replay). Everything is masked: all text, form fields and images are
  replaced by placeholders, board drawings and embedded frames are not recorded,
  and no request bodies or headers are captured. The report dialog has a box
  "Attach a recording of recent actions (text hidden)", ticked by default and
  explained under "What is recorded?"; unticked, nothing is attached. `SENTRY_REPLAY=0`
  turns recording off, `SENTRY_REPLAY_ON_ERROR` (default 1) sets the share of
  visits with an error whose last minute is sent, and `SENTRY_REPLAY_SESSION_RATE`
  (default 0) the share of whole visits recorded. Click trails keep only an
  element's CSS path, never its text.

### Changed

- **Starter templates have descriptions.** The three templates a new space starts
  with (Meeting notes, How-to, Decision record) carry a `template-description` in
  the creator's language, shown as the second line in the "From template…" picker.
- **Copying pages is about ten times faster on large spaces.** Make template,
  From template, Duplicate, Copy and New page reindex only the pages they wrote
  instead of rescanning the whole space, and the "is this a folder" lookup walks
  new range indexes (migration 050) instead of every file of the space. On a
  6150-page space with 5 ms per database query, duplicating a page with 40
  subpages went from 12.7 s to 1.3 s.

- **A share link opens in your own account.** If you are signed in and can open
  the page yourself, `/share/<token>` takes you to the normal page
  (`/s/<space>/p/<id>`) with your sidebar and rights instead of the guest view.
  `GET /api/share/:token` adds `ownAccess` only for such a reader (never for a
  guest or a signed-in outsider) and answers with `Cache-Control: private,
  no-store`. Add `?as=guest` to the link to see what a guest sees.

- **Properties update live.** When someone else changes a page's properties (the
  panel, a base cell, MCP `set_page_properties`, a tag rename, the page icon, a Git
  sync), everyone who has the page open and may read it sees the change without a
  reload, and the bases of that space refresh. The server sends a small
  `page-properties` event over the existing `/events` socket only to sessions that
  may read that page. A field you are typing into is never overwritten: it says
  "Someone else changed this to …", Enter keeps yours, Esc takes theirs.
- **`status` is an ordinary property in a vault** (an Obsidian vault or a
  repository with files of its own): any value, editable in the panel and in base
  cells, typed like other keys. Folio's page status reads only `draft`,
  `published` and `archived` from it; anything else counts as `published`. Search:
  `status:todo` (any value other than those three) matches the front matter
  `status`; the public site never matches it. Native Folio spaces are unchanged.

- **"Sync now" for editors.** Anyone who can edit a space can sync it with Git from the space menu or the quick switcher; taking the Git version, connecting Git and the other space settings stay with space admins.

- A tab left open across an update no longer reloads in a loop when a lazily loaded
  part of the app (the graph, the space settings, the board editor) is gone from
  the server. The page reloads at most once per missing file per minute; if the
  file is still missing, an error screen says "Part of the app could not be loaded.
  Reload the page." with Retry and, with error reporting on, "Report a problem",
  and the error is reported once.
- An open tab that is behind the server now shows "A new version of Folio is
  available." with a Reload button, instead of failing later on a missing file.
- With error reporting on, "Found an issue?" in a board's help dialog opens
  Folio's own "Report a problem" dialog instead of Excalidraw's GitHub issues, and
  Excalidraw's blog and YouTube links are hidden. The error screens have a
  "Report a problem" button that attaches the crash to the report. With no
  `SENTRY_DSN` the issue link is hidden too.
- The page tree draws indent guides: a thin line drops from a parent's chevron
  through its children, so deep trees are easier to read.

### Fixed

- **Vite 8.2.4** (development dependency): fixes GHSA-698v-4r3x-3vcv in
  `launch-editor`, which did not escape `%` in arguments on Windows (Dependabot
  alert #16). Only the dev server opened files in an editor that way; builds and
  the running server are unaffected.
- **Page exports are no longer served stale behind a CDN.** Export routes sent no
  `Cache-Control`, so Cloudflare, which caches `.pdf` and `.docx` URLs by extension,
  returned the first file for every later export even after the page was edited.
  Every page export (Markdown, PDF, DOCX, YAML, the public-site routes and
  `/share/<token>.md`) now answers with `Cache-Control: no-store`
  ([#7](https://github.com/evergreen-it-dev/folio/issues/7)).

## [0.4.0] - 2026-10-16

A graph of how your pages link, Obsidian canvases and bases, and a few tools for
working together. The space opens as a graph (across spaces, with the page tree
as dashed lines) and every page has a local graph panel. Obsidian canvases open
as pages, Obsidian bases run as live tables, cards and lists whose cells you can
edit, and a canvas converts to a Folio board. A page gets a shared countdown
timer, the properties panel works on every page kind, Folio links are indexed as
page links, and a link pasted into Slack or Microsoft Teams unfurls into a card.
Folio AI and MCP now build forms, tables and bases (the MCP server has 40 tools,
and a `get_graph` tool reads the link graph). Optional error reporting with a
"Report a problem" dialog is off by default. Indexing no longer blocks the
server. The interface now speaks English and Ukrainian only (the Russian
interface is removed). Adds migrations 045 to 048.

### Added

- **A reload no longer loses a form you were building or filling in.** The form
  editor keeps a local draft of everything on screen (title, description, submit
  text, fields with help text and "required", order, fields not saved yet) and
  offers it back after a reload with "Restore" / "Discard"; closing the editor with
  unsaved changes asks whether to keep editing, close and keep the draft, or discard
  it, and closing the tab warns. A person filling in a form (signed in, through a
  share link, or an embedded form) gets their answers back after a reload with a
  "Clear" link, and they are removed once the response is sent. Drafts live in the
  browser only, per user and per form; file contents and sensitive field types are
  never stored.
- **Optional error reporting and a "Report a problem" dialog (off by default).**
  Set `SENTRY_DSN` to the DSN of a Sentry project of your own and the server and
  the browser report unhandled errors and 5xx answers (a sample of traces too:
  `SENTRY_TRACES_SAMPLE_RATE`, default 0.1), and the user menu gets "Report a
  problem": a message, an optional screenshot (picked or pasted), the page path
  without its query, the page id and kind, the release and the browser, tied to
  the last error the person ran into. Nothing goes to the Folio authors. No page
  content, search words, request bodies, cookies, `Authorization` headers or query
  strings are sent (a share token in a path becomes `[token]`); the user is the
  internal id only; there is no Session Replay; expected 4xx answers are not
  reported. With no DSN nothing is loaded and nothing is contacted. Builds given
  `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` and `FOLIO_RELEASE` upload
  source maps and delete them from the output. Details:
  [docs/INSTALL.md](docs/INSTALL.md#optional-error-reporting-off-by-default).
- **Graph view across spaces and with the tree structure.** A page of another
  space that you may open appears in the graph, labelled "space / title" in its
  own colour, and opens in its own space. A "Tree structure" toggle (on by
  default) adds the page tree's parent → child lines, dashed, so a nested space
  is not a cloud of dots; in the local graph the parent, the children and the
  siblings (two steps away) are neighbours too. The graph API takes `tree=1`.
- **A clearer local graph panel.** A visible Depth label with a hint on each
  button (direct links, through one page, through two pages), a header that
  collapses the section (remembered for every page), and an empty state that
  says how to get links.
- **Canvases in an Obsidian vault follow renames, like notes.** In a
  light-footprint space (an Obsidian vault, a notes repository) the `.canvas`
  file used to be left alone, so a file card read "File not found" after a note
  was renamed or moved through Folio. The canvas is now rewritten in every space
  by the same rules as the wikilinks of notes: only the changed path strings are
  touched, every other byte stays, and the edit rides the rename's own commit.
- **Free names for canvases and bases.** As in Obsidian, the name of a canvas or
  a base is its file name. "Rename" in the page tree menu takes any valid file
  name, such as "My tasks" with a space or non-Latin letters (no `/ \ : * ? " < > |`,
  no leading or trailing dot, up to 200 bytes), keeps the `.canvas` / `.base`
  extension, moves the page's property sidecar along, rewrites links to the file
  (wikilinks, Markdown links, file cards of other canvases, vaults included) in
  one commit, and keeps the page id. A name already taken is refused with a clear
  error; a change of letter case is allowed. `POST /api/pages/:id/rename` now
  renames the file for these two kinds as well, and `POST /api/pages/:id/slug`
  takes a free name for them (other pages still take a lowercase slug).
- **The built-in assistant and MCP build every kind of page.** Folio AI in Agent
  mode, and any MCP client with a `write` token, can now create and change forms
  and the table their answers go to, change data table columns and views, and
  turn an Obsidian canvas into an editable board. Seven new tools (40 in all, 20
  of them read-only): `create_form`, `update_form` (the same steps as the form
  editor: a new field adds a column to the paired table, a removed field keeps
  its column and answers; a stale `etag` is refused), `folio_table_update_column`,
  `folio_table_delete_column`, `folio_table_save_view`, `folio_table_delete_view`
  and `convert_canvas_to_board`. `read_page` on a form returns its fields and
  etag. A `status` column created through MCP without options gets the status
  preset, as in the web app. The assistant has two new skills, for forms and for
  the syntax of bases, and its Ask mode hides exactly the tools that write.
- **MCP: tags, properties and bases.** Five new tools (the MCP server now has
  33 tools, 20 of them read-only). `list_tags(space, prefix?, limit?)` returns
  the space's tag tree with page counts, `list_properties(space)` the property
  keys in use with their type, page count and sample values; both count only
  pages the caller can open. `rename_tag(space, from, to)` renames a tag across
  the space like the web app (bodies, `tags:` / `labels:`, tables, boards and
  files; one commit authored by the token's owner), changes only pages the
  caller can edit and reports how many pages it changed and skipped.
  `set_page_properties(id, properties, etag?, merge?)` writes a page's
  properties for any page kind through the same code as the properties panel
  (a stale `etag` fails with the current etag, reserved table and form keys are
  refused, `merge: true` changes only the keys given). `save_base(space, yaml,
  path?, id?, etag?)` creates a `.base` or replaces one, refuses invalid YAML
  with the line number, and returns a preview of the first view.
- **Link previews in Slack and Microsoft Teams.** A Folio link pasted into a
  message unfurls into a card with the page's title, breadcrumb, opening text,
  headings, tags and last update (rows and columns for a data table), built with
  the Folio access of the person who shared it. People connect their own Folio
  account once from the chat app (Sign in with Slack or the Teams sign-in window,
  then Folio's own OAuth consent, read only); a page they cannot open gives a
  card with no title, and a restricted page shows its title only because the
  whole channel sees the card. Share links and public-site pages unfurl without
  connecting. New settings `FOLIO_SLACK_*` and `FOLIO_TEAMS_*`; a new
  Administration → Chat integrations page with the Slack manifest and the Teams
  app package; "Chat apps" in API tokens to disconnect. Database migration 045.
  See [docs/CHAT-PREVIEWS.md](docs/CHAT-PREVIEWS.md).
- **Obsidian Bases (`.base`).** A base from an Obsidian vault opens as a page:
  a saved query over the pages of its space that you may open, shown as a table,
  cards (cover from an `image:` property) or a list, with group by, sort,
  limit, column summaries (the built-in ones and your own formulas), display
  names, and the base's and the view's filters combined with `and` / `or` /
  `not`. Formulas and filters run in a safe evaluator of our own (no `eval`):
  arithmetic, comparisons, date arithmetic with durations, lists, objects,
  regular expressions, `this`, and the usual string, number, date, list, link,
  file and object functions; `html()`, `image()`, `icon()` and plugin functions
  are not supported (a formula column shows "formula not supported", a filter
  using one is ignored with a warning), and `kanban` and `map` views fall back to
  a table with a notice. Access is applied in SQL, as in search and the graph, so
  a page you cannot open is never a row; a query looks at up to 5,000 candidate
  pages and shows 200 rows at a time. An Edit toggle changes a cell in place: it
  edits that page's property (only pages you can edit, only note properties,
  never `file.*` or `formula.*`, never a Folio key holding a foreign value). A
  visual editor ("Configure") edits views, filters, formulas and display names
  and has a raw YAML tab; saving keeps unchanged blocks and views byte for byte,
  comments and unknown keys included, in one commit by you. Create one with
  "+ → New base" or the quick switcher's "New base", or turn a search into a base
  with "Save as base…". `base` code blocks in documents render the same view
  (read-only, with `this` meaning the document); share links and public sites
  show a note instead. A base exports to Markdown as its YAML in a `base` fence,
  and `kind:base` works in search. New REST routes
  `GET /api/pages/:id/base`, `GET /api/pages/:id/base/source`,
  `PUT /api/pages/:id/base` and `POST /api/spaces/:space/base/preview`, and a
  read-only MCP tool `query_base`; `read_page` on a base returns its YAML and `fetch` renders its rows
  as a table. Database migration 047. Not yet: `kanban` and `map` views, editing
  cells inside an embedded block, attachments as rows, `![[x.base]]` embeds, and
  a base across spaces.
- **Graph view.** A "Graph" row under Tags in the sidebar opens the space as a
  graph: pages are nodes, links are edges, and tags, attachments and unresolved
  links can be added. A "Local graph" section at the top of a document's
  right-hand panel shows the page and its neighbours 1 to 3 links away (out, in
  or both) and opens full size. Hover highlights neighbours, click opens the
  page, nodes drag, the canvas zooms and pans, and on a touch screen the first
  tap selects. A compact settings panel, remembered per space, has filters in the
  search grammar, colour groups (top folder, page kind, tag or your own query),
  display options and the four layout forces. The graph is built on the server
  from the page index in a few queries (5,000 pages in about 150 ms) with page
  access applied in SQL: a page you cannot open is never a node, a ghost or an
  edge. Above 10,000 readable pages the most recently changed 10,000 are shown.
  New REST routes `GET /api/spaces/:space/graph` and
  `GET /api/pages/:id/graph`, and a read-only MCP tool `get_graph` (the MCP
  server now has 27 tools); the built-in AI assistant can use it too. The
  renderer is a small canvas with `d3-force`, loaded only when a graph is opened.
- **Shared page timer.** A timer icon in the header of every page (and of a folder
  listing): 1, 3, 5, 10 minutes or a custom time up to 3 hours, a live `mm:ss`
  countdown, pause / resume / +1 min / reset. It belongs to the page: everyone who
  has it open sees the same countdown and reaches zero together, with a soft chime
  (generated in the browser) and a "Time is up" toast; a muted-speaker icon and a
  hint appear while the browser still blocks sound. Editors on the page control it,
  everyone else who can read the page watches. The state lives in server memory (not
  in the page, Git or the audit log) and travels over the existing `/events` socket,
  only to people who can read the page. `GET`/`POST /api/pages/:id/timer`. Single
  server process, like the live editing rooms. No migration.
- **Obsidian canvases (`.canvas`, JSON Canvas 1.0) open as pages.** A canvas is
  shown as it is, read-only — Folio never writes the file while showing or
  indexing it: an infinite canvas with pan, zoom and fit, text cards rendered as
  Markdown (Obsidian syntax included), note cards with the note's start or the
  `#heading` / `#^block` they are narrowed to, images, audio and video, web page
  cards with their URL, groups with labels and background images, Obsidian's
  colours in light and dark, and curved connections with arrows, labels and
  colours. A card pointing at a page you may not open shows only "No access".
  Text cards are searchable, their `#tags` tag the canvas, file cards and links
  in text cards appear in backlinks and unresolved links, and MCP `read_page`
  returns an `outline` of the canvas. **Convert to Folio board** makes a new,
  editable whiteboard from a canvas in one commit, showing first what the board
  cannot keep; the canvas stays. Renaming or moving a page a canvas points at
  updates the canvas in any space, an Obsidian vault included. Migration `046_page_kind_canvas.sql`.
- **Properties on data tables, forms, boards and files.** The properties panel
  now appears on every page kind except folders, as a thin row above the page
  ("Properties (N)" at the top left). A data table or a form keeps its properties
  in its own front matter, next to the keys that define it (schema, views,
  fields): those stay hidden and byte-for-byte untouched, and a table or form
  save keeps the properties. A board, a PDF or an Office file keeps them in a
  sidecar YAML file, `.folio/<path>.props.yaml`, created by the first property,
  deleted with the last, committed on its own with every save, and moved, trashed
  and restored together with its page; a sidecar changed in git is picked up on
  the next scan. Tags and properties of all of them work in search (`tag:`,
  `prop:`), in the tag tree and rename, and in MCP `get_page_metadata`.

### Fixed

- **Select, status, member and link questions in a form are real controls now.** They
  used to show up as plain text boxes. A form (its own page, an embedded `::form{id}`,
  a share link, a public site) now offers the options of the table column: a radio
  group up to 6 choices and a dropdown above that, checkboxes or a searchable list for
  multiple choice, status with its colours, a searchable member picker (only for
  signed-in members; anonymous respondents never see the member list, and the question
  is left out for them) and a URL with an optional label for links. The server
  rejects an answer that is not among the options, a list for a single-choice column,
  an unknown member and a link that is not http(s)/mailto. Saved drafts keep multiple
  answers and drop options that no longer exist. The Folio AI `folio-forms` skill
  describes it.
- **A collaborator's cursor name tag no longer loses its first letters inside a list
  item** (it inherited the list's hanging indent).
- **Graph, bases and the "New base" dialog, after a visual check.** The space graph
  no longer draws every label into an unreadable mass: labels fade in with the zoom
  like Obsidian's (the top hubs at the fitted overview, more as you zoom in, none
  over another; a hovered or selected node and its neighbours stay labelled), and
  "Text fade threshold" still sets when they all appear. Folders are named by the
  title of their page (`Tech / Prompts`) in the graph legend and in the `file.folder`
  column of a base, instead of their slugs; filters and sorting still compare the path.
  The base editor lists columns, sort, group and summaries by their plain names
  (Name, Folder, Tags, Modified, …, or the base's `displayName`) with the raw key as
  a muted hint. "New base" opens at once, and on a phone the graph's counts no longer
  sit under the zoom buttons.

- **Links Folio writes itself are page links.** The URL "Copy link" gives
  (`https://<host>/s/<space>/p/<id>`), a pasted page address, `/s/<space>/p/<id>`
  as the assistant and MCP write it, the space home `/s/<space>` and a folder
  route were indexed as external links, so a space linked this way showed its
  pages and no links in the graph, and backlinks, orphans, unresolved links,
  bases and `get_backlinks` missed them. They now resolve to the page by id, in
  any space, on the instance's own host (`PUBLIC_URL`) or root-relative; an
  unknown id is an unresolved link; other hosts, share links and public-site
  addresses stay external. Every document is indexed again on the next start.
- **Indexing no longer blocks the server.** Some Markdown constructs (a large
  table, a long list or quote, a paragraph with thousands of links, one large
  HTML block) took far more than linear time to index, and a single big
  document could hold the server for minutes, so health checks failed while it
  started. Big documents are now indexed in chunks with pauses between them; a
  space of 3,000 pages with 1–2 MB documents is indexed while the server keeps
  answering within a fraction of a second.

### Changed

- **A browser that asks for Russian gets Ukrainian.** Folio's interface languages
  are English and Ukrainian; a saved `ru` interface choice from an older database
  becomes `uk` (migration `048`), and any other unknown browser language still
  falls back to English.
- **Reading mode is read-only for properties.** In Reading mode the properties
  are shown as text and chips for everyone; adding, editing and removing them
  happens in Live and Source.

## [0.3.0] - 2026-10-15

Your Obsidian vault or `docs/` folder becomes a team wiki in the browser, and
the files stay untouched. A vault connects with a light footprint (no `id` is
written, `git status` stays clean) and Folio reads Obsidian markup: wikilinks
and embeds, callouts, `%%comments%%`, block ids, tags and formulas, with a
properties panel and types, a tag tree with rename, one search grammar with
operators and saved searches, an index of space files, and a page index with
metadata, unresolved links and orphans (the MCP server now has 26 tools).
Also in this release: a "Site & PDF" settings page backed by a `.folio/`
folder, SEO for public sites (per-page `<head>`, `robots.txt`, `sitemap.xml`),
six docs-as-code fixes found by testing real documentation repositories, and
fixes from a test on real Obsidian vaults. Obsidian markup is read, not
written; Dataview, Canvas and plugins are not supported.

### Added

- **A "Site & PDF" settings page and a `.folio/` folder in the repository.**
  A space administrator opens the space menu, chooses "Site & PDF settings…" and
  gets one page, `/s/<space>/settings`, with three tabs: Site (title, tagline,
  description, language, social image, favicon and logo, next to a summary of
  the publication), Site appearance (a stylesheet with a live preview) and PDF
  (header, footer and print stylesheet, with a "Test PDF" button). What a space
  looks like outside the app is kept in the repository, in a `.folio/` folder at
  the root of the space's content (`docs/.folio/` for a space with a root path):
  `site.json`, `site.css`, `export.css`, `pdf-header.html`, `pdf-footer.html`
  and `assets/` for the logo, favicon, social image and fonts. Git is an equal
  editor: each file shows its path and an "Open in repository" link, every save
  is one commit (`settings: update .folio/site.css`) that contains only the
  files you saved, never other people's unsaved page edits, and if a file was
  changed in the repository after the page was opened, the save is refused and
  the page shows the difference so you can take the repository's version or
  keep yours. Who can see the site and where (visibility, subdomain, domain,
  downloads, Folio AI) stays in the database and in the publishing dialog. The
  "Powered by Folio" footer of a public site is not configurable.
- **SEO for public sites.** Every public page now gets its own `<head>` from
  the server, so crawlers and link previews see it without running scripts:
  the title (page title, then site title), a description (the page's front
  matter `description`, else the site's, else an excerpt), Open Graph tags, a
  canonical link, the language, the site's favicon, and `noindex` for a page
  with `unlisted: true` in its front matter. A page that is not on the site
  answers with a real 404. Folio serves `robots.txt` and `sitemap.xml` for each
  host: a site's own host gets that site's sitemap, and the main host keeps
  crawlers out of `/s/`, `/share/` and `/api/` and lists the sitemaps of sites
  served at `/public/<space>` (`/public/<space>/sitemap.xml`). The publishing
  dialog has a switch, "Allow search engines to index this site" (on by default;
  off means `noindex` on every page, `Disallow: /` and no sitemap), and a
  "Primary address" choice (automatic, address on this Folio, subdomain or
  custom domain) that decides which address is canonical and goes into the
  sitemap. In the public demo every site is `noindex`. Adds migration 040.
- **A stylesheet for the public site.** `.folio/site.css` restyles a public site
  and never the app itself. Folio sanitizes it before serving it: comments and
  `@import` are removed, `url()` keeps only `data:` images and fonts and files
  from `.folio/assets/` (anything else becomes `none`), and a file over 256 KB
  is not applied at all. The settings page shows the same warnings while you
  type. `.folio-site` and `[data-folio-site-part="header"]` (also `sidebar`,
  `main`, `footer` and `page`) are stable selectors. The logo from `site.json`
  appears in the header of the site, and the site title replaces the space
  name. There is no JavaScript and no third-party snippet.
- **Obsidian vaults connect without a single change to your files.** A
  repository (or the chosen folder) that holds `.obsidian/` is detected when you
  create the space, and the space is created with a light footprint even when it
  is the whole repository: Folio adds no `id` to any file, keeps its metadata in
  a dotfile (`.<slug>.folio`), and `git status` stays clean after the scan. The
  "Light footprint" switch can also be turned on by hand. What the scan skips is
  now a per-space list: `.obsidian/`, `.trash/` and `.git/` are always skipped,
  and a space administrator adds more (a name, a `prefix*` pattern, a trailing
  `/` for folders only) in the space menu under "Indexing & files…", or with
  `PATCH /api/spaces/:space/scan-settings`; changing the list rescans the space
  and never touches the files on disk. Wikilinks (`[[Note]]`, `[[Note|alias]]`,
  `[[Note#Heading]]`, `[[Note#^block]]`, `![[Note]]` and `![[image.png]]`) are
  indexed with Obsidian's shortest-path rules, so they show up in backlinks and
  in the broken-link count, and renaming or moving a page rewrites them in their
  own form. Code blocks and inline code are never indexed or rewritten. Adds migration 041.
- **A richer page index.** Each page is parsed once, when the space is scanned
  and when the page is saved, and the index now holds its headings (with the
  same anchors as the outline), `^block-id`s, tags (`#tag` in the text outside
  code, and `tags:` in the front matter, with `labels:` read as a synonym), the
  whole front matter as properties, and every link of every kind: Markdown
  links, images, wikilinks, embeds, HTML `<a>` and `<img>`, and reference-style
  links, each with its heading or block fragment and whether that fragment
  exists. Links are resolved in a second step over the whole space, so a page
  that appears later brings the links that point to it back to life, and a
  deleted page leaves its links as unresolved instead of erasing them. New
  reads, all filtered by the reader's rights in the query itself (counts and
  lists never include a page the reader cannot open):
  `GET /api/pages/:id/meta` (outline, tags, properties, links);
  `GET /api/pages/:id/backlinks`, now one entry per link with its syntax,
  fragment, line and the line of text around it; `GET /api/spaces/:space/tags`;
  `GET /api/spaces/:space/unresolved-links`; and `GET /api/spaces/:space/orphans`
  (pages nothing links to). HTML and reference-style links are indexed but not
  rewritten when a page is renamed or moved. Adds migration 042.
- **Three more MCP tools, 26 in all.** `get_page_metadata` returns a page's
  outline, tags, properties and links, `list_unresolved_links` lists a space's
  links that point nowhere, and `list_orphans` lists the pages nothing links to.
  All three respect the token owner's access rights.
- **Obsidian markup is shown, never written.** Wikilinks (`[[Note]]`,
  `[[Note|alias]]`, `[[Note#Heading]]`, `[[Note#^block]]`) are links, a dashed one
  offers "Create page" when its target is missing; `![[image.png|300]]` is an
  image; `![[Note]]` and `![[Note#Heading]]` embed the note (the reader's access is
  checked on the server, depth up to 3, cycles cut) through
  `GET /api/pages/:id/embed`; callouts of any type with fold and title; `%%comments%%`
  are hidden; `^block-id` is an anchor; `#tag` is a chip; formulas are drawn with
  KaTeX. Reading and Live agree, PDF/DOCX and search get the same text, and the
  files are never rewritten. Dataview, Canvas, Bases and plugins are not supported.
- **Space files are indexed as files** (migration 043). Attachments and `assets/`
  stay out of the tree and search, but links to them resolve by Obsidian's rules
  (from the root, or by name with the nearest folder) and a missing file shows up
  among unresolved links. `GET /api/spaces/:space/files`.
- **A properties panel.** Property types (`text`, `number`, `checkbox`, `date`,
  `datetime`, `list`, `tags`, `aliases`) live in `.folio/properties.json`, with
  `.obsidian/types.json` as a read-only fallback. Saving rewrites only the front
  matter block. A Folio key with a foreign value is shown as such and never
  overwritten; `labels:` is read, `tags:` is written.
- **Tags and search.** A tag tree in the sidebar with bulk rename
  (`POST /api/spaces/:space/tags/rename`), and one search grammar everywhere (UI,
  REST, MCP): `"phrase"`, `-word`, `tag:`, `in:folder/`, `kind:`, `status:`,
  `prop:key=value`; saved searches (up to 50 per person, migration 044).

### Changed

- **The PDF header and footer moved from the dialog to the settings page.** The
  "PDF header & footer" dialog is gone; the PDF tab of the new page edits the
  header, the footer and the print stylesheet, which now live in `.folio/`
  (`pdf-header.html`, `pdf-footer.html`, `export.css`). Images in a template are
  files in `.folio/assets/` referred to by name (`<img src="logo.png">`) and
  are embedded when the PDF is made, so printing makes no network requests.
  Settings saved earlier (the `export` section of `<slug>.folio` and
  `<slug>.export.css`) are still read, and the first save of the PDF tab moves
  them into `.folio/` in one commit, with embedded pictures becoming files in
  `.folio/assets/`.

- **The public demo can publish.** In demo mode (`FOLIO_DEMO_MODE=1`) a demo
  account that administers a space can now change its visibility and publish
  settings, so visitors can try "Publish as website". A subdomain or a custom
  domain is refused (400) so that nobody can point a host at a shared demo, and
  Ask Folio AI on a public site stays off. The demo seed publishes the Folio
  Handbook at `/public/folio-handbook`.

- **The MCP server now offers 26 tools (it was 23).** The three new ones are
  `get_page_metadata`, `list_unresolved_links` and `list_orphans`, and the
  `instructions` the server sends to clients mention them. A client that lists
  tools shows 26, so a connection check that expects 23 needs updating.

- **The first start after upgrading re-reads every document.** The page index
  has a new version, so the scan re-parses all documents once even when their
  files have not changed. The server starts listening before that scan, but
  a very large space can keep it from answering for a few minutes, and
  until it has passed over a space the new page metadata, tags and unresolved
  links for it are incomplete. The `links` table is now a view over the new
  `page_links` table, with the same columns for anything that still reads it.

### Fixed

- **Obsidian vaults, fixes from a test on real vaults.** A `labels:` key is no
  longer removed or merged into `tags:` by the properties panel or a tag rename.
  A space created from a non-empty repository at its root now uses the light
  footprint by default, so connecting it writes no `id:` into the files.
  Images and files resolved by name now work through share links and for
  `![[file.pdf]]`. DOCX export embeds images next to text and JPEG, GIF, BMP and
  WebP, and PDF and DOCX honour `|200` widths; anything that cannot be embedded
  shows as `[image: name]`. Note embeds after text, wikilinks with a code alias,
  callouts with a non-breaking space and block embeds of a callout render
  correctly. Mixed line endings are kept per line after an edit.

- **"Page not found" and "no access" are different screens.** A page or space
  that does not exist shows 404 with no "Request access" button. A page or
  space that exists but you cannot open shows "No access": a "Request access"
  button when you have no role in the space, or a note to ask the page owner
  when the page itself is restricted to specific people. Anonymous visitors
  never see the button.
- **Public site layout.** Search and "Ask AI" moved into the header, like the
  main app; "Space home" is back above the page tree; "Sign in" and "Powered
  by Folio" (now linking to foliowiki.online) sit at the bottom of the left
  column, and the footer under the content is gone.
- **Another tool's `id:` no longer merges spaces.** Two connected documentation
  folders whose files carry the same front matter `id` (Docusaurus and Jest use
  `id: intro`) used to trade pages: the space scanned last took them over, and an
  edit in one landed in the other's file. A file's `id` now counts only when no
  live page already holds it; a duplicate gets an id of its own in the index and
  its file is left untouched. A file carried from one space to another outside
  Folio still takes its id along.
- **Front matter values Folio did not write are never removed.** Saving a page
  no longer drops a value under a key Folio also uses when Folio could not have
  written it, such as MkDocs' `status: deprecated`. Clearing a status, order,
  icon or cover that Folio set still works.
- **Opening a page writes nothing.** Merely viewing a page used to rewrite its
  file and commit it: the executable bit was lost, CRLF line endings became LF,
  a missing final newline was added, and a `# Title` line ending in CRLF was not
  recognised as the heading, which renamed the file. Nothing changes until
  someone edits the page, and an edit keeps the file mode, CRLF and a missing
  final newline.
- **No inserted or duplicate H1 in a docs folder.** In a space that is a
  sub-folder of a repository, the editor no longer adds `# <file name>` to a page
  that has no heading, and a page with a blank line above its `# Heading` no
  longer gets a second one. A page without an H1 is titled by its front matter
  `title:` (Hugo, Docusaurus, Jekyll) and only then by its file name.
- **Links with `%20` and links without an extension open.**
  `[x](guide/Getting%20Started.md)` and `[x](../getting-started)` open the page
  instead of "Page not found" or a file download, on public sites too, and
  backlinks and broken-link counts agree with what opens. A link without an
  extension that matches no page (`LICENSE`, `Makefile`) still opens the raw
  file.
- **The scan reports skipped `.mdx` and `.markdown` files.** MDX is still not
  supported, but a folder of `.mdx` files no longer connects as an empty space
  in silence: each scan logs how many such files it skipped.

## [0.2.0] - 2026-10-14

Folio can now publish a space as a public website, pay for Folio AI with a key
shared by an instance or a space, and let visitors of a public site ask Folio
AI about it. Spaces that live in a product repository stay tidy: front matter
from other tools is kept, ids stay out of the files, images can live in the
repository, and moving a page keeps its links working. Also in this release:
OAuth 2.1 so that claude.ai, Claude Desktop and ChatGPT connect to `/mcp`,
`search` and `fetch` tools, assistant analytics, replacing a file page with a
new version, "Connect with GitHub", install kits for ten platforms and a
public-demo mode.

Upgrading from 0.1.0: back up first (see `docs/INSTALL.md`). Migrations 031 to
039 are applied automatically at startup. They add tables, columns, indexes and
triggers, widen two check constraints (the source of a saved git credential and
the visibility of a space) and create one system user, "Public visitor", the
identity behind Ask Folio AI on public sites; it has no password, cannot sign
in and is hidden from lists of people. Nothing is removed. Every new setting is
optional, and an unset one keeps its default or leaves its feature off:
`PUBLIC_SITES_DOMAIN`, `PUBLIC_EXPORT_PER_MINUTE`,
`PUBLIC_ASSISTANT_RUNS_PER_HOUR`, `PUBLIC_ASSISTANT_SPACE_RUNS_PER_HOUR`,
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `TRUST_PROXY`, `FOLIO_OG_*`,
`FOLIO_POSTHOG_KEY` and `FOLIO_DEMO_*`. A space that is not public behaves
exactly as before.

### Added

- **Publish a space as a public website.** A space or instance administrator
  opens the space menu, chooses "Publish as website" and sets who can read the
  space to "public": anyone on the internet then reads it without an account,
  as a read-only site with the page tree, search inside the space, documents,
  data tables (live, read-only), whiteboards as pictures, forms (view only) and
  PDF and Office files. The site is served at `<PUBLIC_URL>/public/<space>` as
  soon as the space is public; at `<label>.<PUBLIC_SITES_DOMAIN>` when the
  operator sets `PUBLIC_SITES_DOMAIN` (wildcard DNS and a wildcard certificate
  on the reverse proxy) and the administrator picks a label; and at a custom
  domain such as `docs.example.com` (a CNAME to the instance and a proxy route
  for that host). The administrator can also let visitors download a page as
  Markdown, PDF or DOCX (`PUBLIC_EXPORT_PER_MINUTE` caps PDF and DOCX per
  address, default 6). Pages with their own access restrictions, the `.agent`
  folder and templates are never published (a restriction is not inherited by
  child pages, so lock each page that must stay closed), and visitors are not
  sent the names or cursors of the people editing. People who are signed in
  read a public space exactly as they read a space open to the whole instance.
  The publishing settings live in the database, not in Git, and only a browser
  session can change them: not an API token, and not the public demo. The
  access matrix and the spaces list show the new visibility, and switching a
  space to public asks for confirmation. Folio does not generate `robots.txt`
  or a sitemap for these sites yet. Adds migration 038. See `docs/INSTALL.md`
  and `docs/LIMITATIONS.md`.
- **Shared Folio AI key.** Folio AI no longer needs a key per person. An
  instance administrator can set one Cursor key for the whole instance (the
  "Shared key" tab of the Assistant analytics page) and a space administrator
  can set one for a single space (space menu, "Folio AI key"); whoever owns the
  key pays. A run uses the first key that exists, in this order: the person's
  own key, the key of the space the question is asked in, the key of the
  instance, then `CURSOR_API_KEY` from the environment. An instance
  administrator can also turn personal keys off so that everyone uses the
  shared key: a stored personal key is then ignored and the form for adding one
  is hidden. The assistant settings show whose key is in use. Shared keys are
  stored encrypted with `FOLIO_SECRET` and are never sent back to the browser
  after they are saved (only the key's name, the Cursor account, who set it and
  when); every change is written to the audit log, and the public demo cannot
  change them. Adds migration 037. Cursor remains the only provider.
- **Ask Folio AI on a public site.** In the publishing settings a space
  administrator can switch on "Allow visitors to ask Folio AI about this space"
  (off by default). Visitors then get an "Ask AI about this space" button and
  need no account. The assistant runs in Ask mode only, answers from the public
  pages of that one space, cannot change anything, cannot read page history,
  and is told it is talking to an anonymous visitor. It uses the key of the
  space, else the key of the instance, else `CURSOR_API_KEY` (a visitor has no
  personal key), so the owner of the key pays; with no key the panel says Folio
  AI is not set up for the site. A conversation belongs to the browser that
  started it (a random token whose hash is stored), and nobody else can
  continue or read it. Questions are rate limited per address
  (`PUBLIC_ASSISTANT_RUNS_PER_HOUR`, default 20 an hour across all public
  sites) and per site (`PUBLIC_ASSISTANT_SPACE_RUNS_PER_HOUR`, default 200 an
  hour); the counters live in the memory of the server process. Public
  conversations appear in the assistant analytics as "Public visitor". The
  rules in the space's `.agent` folder still apply to these runs, so keep
  secrets out of them. Adds migration 039.
- **Front matter from other tools is kept.** Folio edits only its own keys
  (`id`, `order`, `status`, `icon`, `cover`) inside an existing front matter
  block. Keys written by Docusaurus, MkDocs, Hugo or Jekyll (`title`,
  `sidebar_position`, `slug`, `tags`, `description`, ...), comments, lists and
  quoting stay byte for byte through a scan, a save, a change of icon or order,
  a rename, a copy and a duplicate. A block that cannot be parsed is left
  exactly as it is.
- **A light footprint in a product repository.** A space bound to a folder of a
  repository (a root path such as `docs/`) no longer gets an `id` written into
  its files, neither on the first scan nor when a page is created or edited.
  Ids live in Folio's index and survive moves, renames, copies and restores
  from the trash, and the space's `.folio` metadata file goes into a dotfile
  inside that folder (`docs/.<slug>.folio`) instead of the repository root,
  where site generators ignore it. Spaces that already carry ids in their
  files, or a `<slug>.folio` in the root, keep working as they are, with no
  migration.
- **Images in the repository.** A space administrator can turn on "Store images
  in the repository" (space menu, "Image storage"). New pasted or dropped
  images are then saved in `assets/` of the space's folder (`docs/assets/` for
  a space with a root path), committed with the page and linked by a relative
  path (`../assets/diagram.png`), so they also show on GitHub. Off by default;
  images already in pages do not move.
- **Moving or renaming a page keeps its links working.** Relative links and
  images inside the moved page and its subtree are recalculated for the new
  location, and links to it from other pages are rewritten. The move and every
  rewrite are one commit (`docs: move <old> -> <new>`, `docs: rename ...` for a
  slug), and Undo restores the old place the same way. Only `[text](path)`
  links and images are rewritten, not HTML tags or reference-style links.
- **Make heading on a whiteboard.** Select a free text block that has a first
  line and a body, in Edit mode, and a "Make heading" button appears beside the
  selection: the first line becomes a larger heading of its own, grouped with
  the body, in one undo step. (Excalidraw has no bold inside a text element, so
  this is how a heading is made.) Text inside a shape or a sticky note is not
  offered it.
- **Connect with GitHub.** "Git access" can link a github.com account through
  a GitHub OAuth App instead of a pasted token: one click, GitHub's consent
  screen, and the token is saved for github.com (it replaces a token saved
  there earlier). It appears only when `GITHUB_CLIENT_ID` and
  `GITHUB_CLIENT_SECRET` are set, and is also offered in the "create space"
  and "connect git" dialogs. The token form now names the scopes it needs and
  links to the page where the token is created. See `docs/INSTALL.md`.
- **MCP tools declare their result shape.** All 23 tools now publish an
  `outputSchema` and return `structuredContent` next to the JSON text they
  always returned, so clients and catalogs that read structured output get
  typed results (lists are wrapped in an object: `{"spaces": [...]}`,
  `{"hits": [...]}`, ...; the text form is unchanged). Every tool parameter
  now has a description, including `limit`/`offset` of `folio_table_query`
  and the column fields of `folio_table_add_column`, `folio_table_create`
  and `create_page`. Tool names are unchanged. See `docs/MCP.md`.
- **Replace a file page with a new version.** A PDF, Word, Excel or PowerPoint
  page can now take a new file without becoming a new page: it keeps its
  link, its place in the tree, its icon, its access rules and its stars. Use
  "Replace with new version…" in the page's tree menu, the button in the
  page header (editors only), or drag a file from the desktop onto the open
  page and confirm. After a replace a toast offers "Undo". The new file may
  have a different type (a deck that is now a PDF): the file is renamed and
  every link to it from other pages is rewritten, the same way "Change slug"
  does. A file that is byte for byte the current one changes nothing. The
  usual checks apply (`.pdf`, `.docx`, `.xlsx`, `.pptx`, and the bytes must
  look like the claimed format), and share links cannot replace anything.
- **Version history for file pages, with restore.** Every replace is its own
  Git commit, and whatever was still waiting for the quiet-period commit is
  committed first, so the version you replaced is always in the history. The
  history panel of a file page lists the versions; each shows the file name
  and size it had then, a download of exactly that version and, for a PDF,
  a preview. "Restore this version" puts that file back (and its type) as one
  more commit, so nothing is rewritten and the version you restored over stays
  in the history. New endpoints: `POST /api/pages/:id/file` (replace) and
  `GET /api/pages/:id/history/:sha/file` (the file at a commit). The MCP
  tool for a page at a revision now answers for a file page with its path,
  extension and size; the bytes are not exposed over MCP. Search still finds
  file pages by title only.
- **Status tags.** A short coloured badge inside a sentence, like the status
  lozenge in Confluence: `:status[Done]{color=green}`. Six colours (grey, blue,
  green, yellow, red, purple); grey is the default and is also what a missing
  or unknown colour falls back to. The text is stored as typed and shown in
  capitals, so search, export and copy keep your own spelling. In Live edit the
  tag is one badge that the caret skips over; click it for a popover with a
  text field and the six colours, and insert one from the toolbar button, the
  selection bar or the `/` menu (with text selected it wraps the selection).
  Tags also work inside table cells. Outside Folio the source reads as plain
  `:status[Done]`. Search finds a tag by its text, never by its colour. The
  Confluence import turns status macros into these tags (both the rendered
  lozenge and the storage-format macro), PDF and DOCX export draw them as
  badges, and the assistant knows the syntax.
- **Underline is written `++text++`.** Underline used to be an HTML tag pair
  (`<ins>…</ins>`), and a pair like that could cross a `**` pair and produce
  text nothing could render. `++text++` is a delimiter pair like `~~` and
  `**`, so it nests with bold, italic, strike-through and highlight in any
  order and can never cross them. Exactly two plus signs: `C++` and `a + b`
  stay text. The toolbar button and the hotkey write it, paste and the
  Confluence import write it, and the assistant and MCP descriptions tell
  agents to use it. Existing `<ins>` and `<u>` on pages still render
  underlined, and the underline button reads them too (pressing it on such a
  span removes it). The conversion is also available as a function for anyone
  who wants to rewrite old pages in bulk: it is conservative, leaves any pair
  whose rewrite would not parse exactly as it was, and counts what it skipped.
- **Copy and cut in Live edit keep inline formatting.** Live edit folds the
  markers (`**`, `==`, `++`, link brackets) away, so copying the visible word
  used to put bare text on the clipboard. The selection is now mapped back to
  its Markdown source, and the clipboard gets two flavours: Markdown as plain
  text, and the rendered result as HTML, so Slack, Google Docs and mail keep
  the formatting. Pasting that HTML back into Folio (or HTML copied from
  Reading) converts highlights, status tags and strike-through to Folio's own
  Markdown.
- **Live edit lists look like Reading.** Bullets are drawn by depth (disc,
  circle, square), nested items indent one level at a time with a hanging
  indent, ordered numbers stay real text, and checklist items drop the dash in
  favour of the checkbox. Source mode is unchanged.
- **Emoji reactions on whiteboard shapes.** Select a shape in Edit mode and a
  small reaction button appears at the lower right corner of the selection
  frame; it opens a palette of eleven
  emoji (✅ ❌ 🔧 for yes, no and in progress, then 👍 ❤️ 😂 🎉 🤔 👀 🔥 👏), each
  with a name on hover. A reaction shows up as a chip with a count just below
  the shape; click the chip to add or remove yours, and point at it to see who
  reacted. Reactions are stored in their own shared map of the board's live
  document, one entry per shape, emoji and person, so two people reacting to the
  same shape at the same moment both keep their reaction, and they appear in
  every open tab at once. They do not touch the drawing: no scene edit, no undo
  step, nothing in the board's SVG file or in Git. People who may only view a
  board, and anyone in View mode, see the chips but cannot react.
- **Optional analytics hook for a demo you run (off by default).** Folio sends
  no telemetry: with no key set, the browser never loads an analytics library
  and the server never opens a connection to anyone. An operator who runs a
  public demo can set `FOLIO_POSTHOG_KEY` (and `FOLIO_POSTHOG_HOST`) to send
  anonymous events to a PostHog project of their own: the kind of page opened
  or edited, the space slug and the steps of connecting an AI app, never page
  text, titles, search words, names or e-mail addresses. Visitors are not
  identified and the visit id lives in the tab's session storage, not in a
  cookie; the browser's Do Not Track setting turns it off. See
  `docs/INSTALL.md`.
- **Link previews.** Links to the instance's front page now carry Open Graph
  and Twitter card tags, so LinkedIn, Slack, Telegram and the like show a title,
  a description and a 1200x630 picture. A plain installation gets neutral
  defaults and a Folio card; the public-demo mode has its own text and card.
  `FOLIO_OG_TITLE`, `FOLIO_OG_DESCRIPTION` and `FOLIO_OG_IMAGE` (a path under
  the site or an absolute address) override any of the three. Share links keep
  showing the shared page's own title and excerpt.
- **`search` and `fetch` MCP tools for ChatGPT deep research and company
  knowledge.** ChatGPT only accepts two read-only tools of exactly these
  names. `search(query)` returns `{results: [{id, title, url}]}` and
  `fetch(id)` returns `{id, title, text, url, metadata}` (the page as
  Markdown; a data table as a Markdown table, a board as its labels and
  connections, a PDF or Office file as a note). They apply the same access
  rules as `search_pages` and `read_page`: a page you may not see is "page not
  found", the same answer as for one that does not exist. The server now has
  23 tools.
- **`integrations/`: ready-made setups for AI tools.** Config files and
  instructions for connecting Folio over MCP: a Claude Code plugin (with a
  `folio-wiki` skill and a marketplace file, so `claude plugin marketplace add
  evergreen-it-dev/folio` works), Cursor (`mcp.json` and a rule), VS Code,
  Codex, Open WebUI, two importable n8n workflows (a new GitHub issue becomes a
  table row; a weekly summary page), steps for ChatGPT and Claude (OAuth), and a
  description of an onboarding setup. Placeholders only, no tokens.
- **OAuth 2.1 for MCP: connect Folio from claude.ai, Claude Desktop and
  ChatGPT.** `/mcp` now answers an unauthenticated request with `401` and a
  `WWW-Authenticate` header pointing at the protected-resource metadata, and
  Folio is its own authorization server: discovery documents
  (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`),
  dynamic client registration and Client ID Metadata Documents, authorization
  code with PKCE (S256 only), a consent screen on top of the normal sign-in
  (read, or read and write), one-hour access tokens with rotating 30-day
  refresh tokens, audience binding to `/mcp` (RFC 8707) and revocation
  (`/oauth/revoke`, and "Connected apps" under "API tokens"). Tokens act with
  the rights of the person who approved them; a `read` connection cannot run
  write tools; everything is stored as hashes. Personal access tokens work
  unchanged. Adds migration 034 (five tables).
- **MCP tool annotations and server instructions.** All 21 tools now declare
  `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint` and
  `openWorldHint` explicitly, so clients can skip confirmation for reads and
  ask for it on replacing or deleting tools. The server also sends a short
  `instructions` text on `initialize`.
- **Install kits and a ready-made image.** A workflow publishes the image
  (`ghcr.io/evergreen-it-dev/folio`, amd64 and arm64), and `deploy/` carries
  kits for a plain Linux server (`install.sh`), Coolify, Railway, Render,
  DigitalOcean, Dokploy, CapRover, Easypanel, Portainer and Fly.io, plus a
  smoke check for a fresh installation (`deploy/smoke.mjs`). See
  `docs/INSTALL.md`.
- **Public-demo mode (for running your own demo).** Off unless
  `FOLIO_DEMO_MODE=1`; an ordinary instance never serves any of it. When on,
  the sign-in screen offers one-click demo accounts and a thin banner shows in
  the app. For everyone in that mode the features that could be abused on a
  shared instance are refused with 403: API tokens, the assistant and AI keys,
  git and Confluence endpoints that connect to a host the caller chooses,
  creating spaces, share links, invitations, changing name or username,
  changing a space's visibility or publishing it, and setting shared AI keys;
  uploads are capped (`FOLIO_DEMO_MAX_UPLOAD_MB`, default 5), and a demo
  account cannot change passwords. See `.env.dev.example`.
  Demo accounts may be space administrators (to edit a space's `.agent`
  rules) without being able to break the demo for others: deleting or
  renaming a space, members and roles, git sync, page permissions, emptying
  the trash and removing the `.agent` folder itself answer 403. `/mcp` and the
  OAuth credential endpoints are rate limited per address and size capped
  (`FOLIO_DEMO_MCP_RPM`, `FOLIO_DEMO_MCP_WRITES_PER_HOUR`).
- **`TRUST_PROXY`.** Behind nginx, Traefik or Caddy every visitor used to
  share the proxy's address, so the sign-in rate limit was one bucket for
  everybody. `TRUST_PROXY=true` takes the client address from
  `X-Forwarded-For`, but only from a proxy on a loopback or private address
  and only the entry that proxy appended. Off by default; a bare hop count is
  refused.
- **Assistant feedback and analytics.** Every saved assistant answer can be
  rated 👍 or 👎, the panel asks "Did the assistant solve your question?" after
  every third answer, and the assistant records questions it could not answer
  or was unsure about. Instance administrators get an "Assistant analytics"
  page (`/admin/assistant`) with the conversations, ratings, survey results and
  a "Questions without an answer" list, filtered by space, user and date.
  Opening someone's conversation is recorded in the audit log. Adds migration
  032.
- **Assistant analytics for space administrators.** A person who administers a
  space now sees the "Assistant analytics" entry in the account menu, limited
  to their own spaces: only conversations that ran in those spaces, and inside
  them only the messages of those runs. Counts, first question and dates are
  computed over that visible part, a filter by someone else's space is
  refused, and the page says how many messages are hidden. Instance
  administrators still see everything; a personal access token is still
  refused.
- **"Who opened this conversation".** The page of a conversation in the
  assistant analytics lists who opened it and when (the latest 50, then "and N
  earlier openings"), read from the audit log. Adds migration 033, a partial
  index only.
- **Paste a link over selected text.** Select some words and paste a single
  address: the words become a link to it instead of being replaced. Works in
  the page text and inside table cells. A selection that is already a link or
  an address, a selection inside code, or a clipboard holding anything other
  than one address is replaced as before.
- **Search in the space switcher.** Long space lists scroll inside the menu,
  while the action for creating a new space stays visible.
- Markdown tables have three labelled width modes: narrow, medium and full
  viewport. In narrow and full-width mode the highlighted right edge can be
  dragged to set an exact width. A full-width table may grow past the viewport
  and scroll horizontally inside its own container.
- **A welcome wizard for a fresh installation.** Instead of an empty screen
  with one button, someone who has no space yet gets three steps: what to
  create first (a document, a whiteboard or a data table), what Folio can do,
  and what the assistant is. Then the first space is created with the chosen
  page in it, and a first document opens ready to type in. "Skip" goes
  straight to that result. The tour can be reopened from the account menu.
- **Duplicate** in the page menu of the sidebar. The copy appears next to
  the original together with all of its child pages, is named
  "Title (copy)" and opens at once. Works for documents, whiteboards, data
  tables, forms and file pages; "Copy to…" remains for a copy in another
  place or another space.

### Changed

- **The assistant links the pages behind an unanswered question.** The "what
  is missing" text of a question it could not answer now names the gap briefly
  and links the pages the assistant actually read for it, so an administrator
  can jump straight to the page that should have held the answer. Pages it did
  not open are never linked.
- **The space administrator's note shows space names.** The line saying which
  conversations a space administrator sees now lists the names of their
  spaces instead of their short addresses.
- In "Questions without an answer" the person's own question is now the main
  line, with the assistant's restatement below it as "Assistant's wording";
  older reports that were saved without a run show only the restatement. The
  space filter and the space columns of the assistant analytics show space
  names instead of slugs.
- Interface languages are picked up from the bundle files that exist, so
  adding a language means adding files, not editing code. English is the
  fallback when the browser asks for a language there is no bundle for.
- Texts the server writes into content — the name of the first view of a new
  table, the heading of the link list on an imported whiteboard — follow the
  language of the person who triggers them.
- The assistant's instructions are in English; it answers and writes pages in
  the language it is addressed in.
- Code comments, tests, test data and server error messages are in English.
- In the share menu the checkbox under an existing link is always labelled
  "Include child pages": the tick alone says whether it is on.
- Share links can be listed, created, changed and revoked only from the
  browser. A personal access token, whatever its scope, is refused: the link
  holds an access key. Agents still read a page through a link they already
  have.
- A share link "with child pages" leaves out every page that has its own
  access restrictions, and everything below such a page. The set is checked on
  every visit, so restricting a page later also takes it out of links that
  already exist. A restricted page shared by a link of its own is still shared
  together with its unrestricted children.
- Raw files (`/files/…`) follow page access. A page file is served under the
  rules of that page; any other file is served to a signed-in user unless
  every page that references it is hidden from them, and to a share guest
  only when a page of the share references it. A file no page references
  stays open to the members of the space.
- Uploaded attachments and repository files in an unusual format are
  downloaded instead of being opened in the browser; SVG still opens, but
  without scripts or network access. Common raster images and PDF open as
  before. In particular, a link from a page to a `.html`, `.txt`, `.md`,
  `.json` or `.csv` file, or to a video or audio file, now downloads it
  instead of opening it in the tab.
- URL paths that are not in canonical form (`//`, `/./`, backslashes, an
  encoded `..`) now answer 403.
- Running outside Docker needs Node.js 22 (the image already uses it).
- The assistant checks the `space` and `pageId` sent with a request. A space
  the user cannot read answers `404 space not found`, exactly as a space that
  does not exist; an unknown or inaccessible page answers `404 page not
  found`; a `pageId` without `space` is `400`. Earlier an unknown page id was
  silently ignored. An instance admin who is not a member of a space can no
  longer start an assistant run in it.

### Fixed

- **Repository lists from GitHub and GitLab are complete, and say why they
  fail.** The "create space" dialog follows the provider's pagination (up to
  1,000 repositories over 10 pages, never leaving the original host), and a
  provider failure (invalid token, rate limit, SAML single sign-on required,
  forbidden, unreachable) shows a specific message instead of an empty list.
  Creating a space from a repository without naming a branch asks the remote
  for its real default branch instead of assuming one.
- **A link to a page that sorts later is no longer stored as broken.** The
  first scan of a space classified each page's links while it walked, so a link
  to a page further down the alphabet was recorded as broken and never counted
  as a backlink. Links are now indexed after the whole walk, and a rescan
  re-indexes unchanged pages that held broken links.
- **Formatting keeps its blanks outside the markers.** Every inline formatting
  button leaves a selection made only of blanks alone and keeps leading and
  trailing blanks outside the markers. Pairs are read with the CommonMark
  flanking rules, so an asterisk after a space is not an italic, and pressing
  the button on a broken pair such as `*word *` moves the markers onto the text
  (`*word* `).
- **Headings show plain text in the outline, notes and page title.**
  Highlights, status tags, emphasis, links and escapes are resolved, so the
  outline, the notes panel and a page's title (the first `#` heading) no longer
  show raw markers such as `==text=={.green}`. Heading anchors are unchanged,
  so saved links keep working.
- **A new sticky note opens its text field after Escape.** On a whiteboard,
  after pressing Escape the next new sticky note used to open the previous
  note's text (or nothing). The new note is now the only selection and opens
  for typing.
- **The built-in assistant no longer gets the MCP tools `search` and `fetch`.**
  They exist only because ChatGPT deep research accepts tools with exactly
  those names, and they duplicate `search_pages` and `read_page` (same access
  checks), so the model saw both reading tools twice, and a bare `fetch` looks like a
  web fetch to a model that has no way to open a URL. The assistant now sees
  the other 21 MCP tools in Agent mode and the read-only ones in Ask mode. The
  external `/mcp` endpoint is unchanged and still offers all 23 tools. The
  `pageMeta` test no longer depends on the environment variables of the
  shell that runs it.
- **`docker-compose.yml` passes every documented setting to the app.**
  `TRUST_PROXY`, `FOLIO_DEMO_MODE` and the other `FOLIO_DEMO_*` settings,
  `FOLIO_DEFAULT_REPO_URL` and the assistant deadlines
  (`CURSOR_AGENT_TIMEOUT_MS`, `CURSOR_AGENT_TIMEOUT_MS_AGENT`,
  `CURSOR_AGENT_IDLE_TIMEOUT_MS`) were read from `.env` by nobody, so under
  Compose they silently did nothing. They now reach the container; left empty
  they keep their built-in defaults. `.env.example` and `docs/INSTALL.md`
  describe them.
- **Reading: a loose list keeps its number and its text on one line.** A list
  with blank lines between items wraps each item in a paragraph, and with the
  marker inside the item the number sat alone on the line above the text.
  Markers now hang in a gutter of their own at every level, which also gives
  wrapped lines a hanging indent. Checklists and lists inside table cells keep
  their layout.
- **Confluence import no longer overwrites the space's home page.** Importing
  into an existing space with the default target wrote the imported root page
  over the space's own `index.md`; the tree never lists that file (the space
  home has its own row), so the imported page vanished from the tree and the
  old home was gone. The same happened for a chosen folder that already had a
  page of its own. The root now takes `index.md` only where nothing would be
  replaced or hidden, and otherwise goes into its own folder; importing the
  same tree again updates that folder in place.
- **Formatting inside a table cell is no longer erased on the first
  keystroke.** Cells draw nested formatting (bold inside underline, highlight
  inside bold) instead of showing raw tags and markers, and typing into a
  formatted cell no longer drops its underline and highlight.
- **Someone else's selection no longer hides your text.** When a collaborator
  selected a range, everyone else saw the selected lines turn into a blank gap
  after a few seconds of the collaborator being idle. The text itself was
  intact in the editor, the shared document and on the server; only its
  drawing was hidden by the fade that dims idle collaborators. Folio now draws
  remote selections itself, as a coloured mark that never touches the text's
  visibility, and the fade dims only the colour and the caret. Mixed versions
  keep working, since the presence data is unchanged.
- **The reaction button on a whiteboard no longer follows the pointer.** The
  button used to pop up at whatever shape the pointer crossed, which got in the
  way of drawing and selecting. It now belongs to the selection: select exactly
  one shape in Edit mode and it appears at the lower right corner of the
  selection frame; it stays hidden while you drag, resize, rotate, type or draw,
  and the palette closes when the selection goes away. In View mode, and for
  people who may only view the board, the chips are still shown but cannot be
  clicked.
- **Typed text can no longer be lost between Live edit and Reading.** One
  error raised while the browser saved a local copy of the page used to switch
  the editor's connection to the shared document off for good: from then on
  the editor kept text on screen that the document never received, and it was
  gone when you moved to Reading or reloaded. The connection between the
  editor and the shared text now never switches itself off: after every change
  it checks that both sides agree and repairs any difference, and when the
  editor closes it hands over whatever only it had. The local copy is reopened
  if its storage connection breaks, and it is deleted only after the server has
  confirmed it holds your edits (checked against the server's own state, not
  the socket's "synced" flag). If the server does not take your edits the
  header shows "Not saved", and closing the tab with unconfirmed edits asks
  first. A page you may only view (page access) now opens read-only instead of
  an editor whose typing was silently dropped.
- **The server keeps what a live page holds when a file write fails.** A failed
  write of a page file is retried with growing pauses and the room's snapshot
  stays in the database; the next open continues from the newer snapshot instead
  of the older file. Page files are written atomically (a temporary file, then a
  rename), and the temporary files are excluded from Git commits and cleaned up
  if a crash leaves one behind. Carriage returns (Windows line ends) are
  normalized wherever text enters a live page, which also stops two clients from
  rewriting the same span and doubling it. When the server itself replaces all
  of a live page's text (a file changed outside while the page was closed, an
  API or MCP body write, "Take the version from Git"), the replaced text is
  first saved in a backup table that is pruned by age. Adds migration 035.
- **A single `-` under a paragraph stays a dash.** Typing `-` on the line right
  after a paragraph used to turn the whole paragraph into a heading in the
  editor, because Markdown treats a line of dashes under text as an
  underline-style heading. The editor no longer recognises that form while you
  type; `#` headings, lists, quotes, bold and rules work as before, and Reading
  mode still renders underline-style headings in existing or imported text.
- The "Ask" and "Agent" mode labels in the assistant panel and on the first-run
  screen are now translated into Ukrainian instead of staying in English.
- Asking the same unanswered question twice inside one assistant run no longer
  creates a second report; the text of the first one is kept (or completed, if
  it was empty). The limit of three reports per run is unchanged.
- The "what is missing" text of an unanswered question in the assistant
  analytics is now rendered as Markdown (links open in a new tab; raw HTML and
  `javascript:` links are dropped) instead of showing the markup as text.
- **The trash page scrolls.** A long list of deleted items no longer runs
  past the bottom of the window with no way to reach the rest.
- **The sidebar page tree now updates by itself when someone else changes it.**
  A page created, renamed, moved, deleted or restored by another user, an API or
  MCP client, the assistant, an import or a Git sync used to stay invisible in an
  already open sidebar until the page was reloaded. It now appears within about a
  second. Only people who can read the space are told, and only that something
  changed; the list itself is fetched through the usual access checks, so
  restricted pages stay hidden. During a long import the tree refreshes at a
  relaxed pace instead of after every page.
- The personal "Undo" history of a deleted space no longer shows up in a new space
  created with the same name.
- Choosing "New space" in the Confluence import dialog now starts with an empty
  name field instead of the address of the current space.
- Text typed on the line right under a table no longer joins the table. The
  first character there — a letter or an emoji — used to become one more table
  row and turn the grid back into raw Markdown; a blank line now stays between
  the table and the new text.
- Emoji from the system emoji panel, dead keys and phone keyboards (anything
  typed through an input method) no longer break tables: in an empty cell the
  text was entered twice, and on the line under a table it turned the grid
  into raw Markdown. Enter, Tab, Escape and the arrow keys pressed while an
  input method is composing stay with it instead of moving between cells.
- A whiteboard box no longer looks empty in the picture of a board. When a
  board was created or updated by the assistant, or imported, the label of a
  box could be drawn underneath the box in the preview used by a document that
  embeds the board, by the version history and by the `.excalidraw.svg` file
  in Git, while the canvas itself was fine. The label is now always drawn
  directly above its box, and the stacking order the board was built in is
  kept once the board has been opened and saved. A board that already has the
  problem is corrected by its next save; the server does not rewrite a board's
  file just because the board was opened.
- The AI assistant starts again in the Docker image. After the Cursor SDK
  update, its native parts (built for glibc) could not be loaded by the
  Alpine-based image, so the first question failed with "Error loading shared
  library" on both x86-64 and ARM (Apple Silicon). The image now carries the
  compatibility layer they need, and the build checks that these parts load,
  so an image in which the assistant cannot start fails the build instead of
  failing for the first user.
- Opening an invitation while already signed in now offers a primary
  **Continue** action that accepts the invitation with the current account.
  Signing out remains available as a secondary action.
- A space typed at the edge of formatted text no longer breaks the
  formatting. With the caret right before a bold, italic, struck-through,
  highlighted or underlined phrase, or before a link, the space now goes in
  front of the hidden marker instead of after it, where it used to turn
  `**bold**` into plain text with the asterisks showing.
- The MCP server now reports the product version when a client connects,
  instead of a fixed `1.0.0`. The MCP documentation now matches the code: the
  `create_page` tool takes the text of a new document (REST creation does
  not), and the data table tools are split into three that read and five that
  need the `write` scope.
- A change pushed to Git (for example from an IDE) now reaches a page that is
  open in the editor right after the sync. Before, the open page did not know
  about it: the next keystroke or closing the tab wrote the old version over
  the file, and the change was silently lost. This holds for documents, data
  tables and whiteboards. Text typed a moment before the sync is merged with
  the change from Git instead of being dropped.
- When the same passage was changed in Folio and in Git, the conflict markers
  now show up in the document text and the page stays in the conflict state
  until it is resolved. A data table or whiteboard with a conflict is not
  overwritten until "Take the version from Git" is chosen.
- "Take the version from Git" on a whiteboard now really restores the
  version from Git: the open canvas switches to it, and closing the tab no
  longer writes the discarded version back to the repository.
- Two small fixes in the MCP server found while an agent used it. A document
  made with `create_page` from text that does not start with a heading now
  keeps the title you asked for (it used to be named after the file, for
  example "release-notes"): the heading is added above the text, and a
  leading heading you write yourself is kept and becomes the title. And
  `folio_table_insert` now stores an unticked checkbox as `false` in a column
  you did not fill, as adding a row by hand does, instead of `null`.

### Security

- The request log no longer records the query string of the Google and GitHub
  sign-in callbacks (it carries a one-time code), nor the guest token of a
  public-site Ask Folio AI conversation.
- **The assistant no longer has file or shell tools.** The Cursor agent runs
  without an operating-system sandbox, and its built-in read, search and shell
  tools were not confined to the conversation workspace, so they could open
  the Git repositories of spaces the person cannot read. A run now offers the
  model only Folio's own tools (the MCP tool set, the built-in tool that
  records unanswered questions, and `read_skill`, which returns the shipped
  working instructions by name); access control is therefore the one the
  tools apply to the signed-in person, not the file system's.
- Asking for a space or a page the caller has no role in at all now gets the
  same "space not found" / "page not found" as for one that does not exist,
  in the assistant and over MCP, so private space slugs and page ids cannot
  be probed. A caller with too low a role (a viewer asking to write) is still
  told so.
- Page search over MCP and in the assistant returns nothing for a disabled
  user, as every other read already did.
- Dependency updates close four high-severity advisories. `puppeteer-core` is
  now 25.x (used only to render PDFs with the system Chromium); its browser
  downloader no longer pulls in `extract-zip` (symlink path traversal, no fixed
  version) or `basic-ftp`. The `nanoid` copy bundled through the Mermaid import
  of whiteboards is raised to 5.1.11 or later. `npm audit` reports no known
  vulnerabilities. Running outside Docker now needs Node.js 22.12 or newer.
- A second round of dependency updates closes the seven advisories that were
  still open. `@modelcontextprotocol/sdk` is 1.31 or later (the OAuth client now
  binds stored credentials to the authorization server that issued them; Folio
  itself only uses the SDK's server side and in-process client, so nothing
  changes for it). `@fastify/busboy`, behind multipart uploads, is 3.2.2 (CRLF
  injection through the filename in `Content-Disposition`), `source-map-js` is
  1.2.2, and the Express copy of `proxy-addr` that the SDK brings in is 2.0.8.
  The development-only `shell-quote` (via `concurrently`) is raised with an
  override, and so is `katex` (via Mermaid, 0.18.2 or later). `sprintf-js` has
  no fixed version; it was only reachable through the command-line tool of
  `js-yaml` 3 (inside `gray-matter`), which Folio never runs, so an override now
  gives that tool a dependency-free `argparse` and the package is gone from the
  lock file. `npm audit --omit=dev` reports no known vulnerabilities. A reminder
  for operators: `TRUST_PROXY` takes address lists as written, so write IPv4
  proxies in plain form (`10.0.0.0/8`), not as a short IPv4-mapped IPv6 prefix.
- "Copy to…" and "Duplicate" no longer carry over what the person copying
  cannot open. Before, an editor (or a viewer who could edit another space)
  could copy a page together with its children and read, in the copy, a child
  hidden from them by page access, with its files; copying the root page of a
  space into another space also took the `.agent` folder along. Now a page
  hidden from the person copying is left out together with everything below it
  and the files only such pages use, the `.agent` folder is not copied unless
  the person administers the space, and dot files and folders are never
  copied. The copy of a page that has its own access rules is private to the
  person who made it; sharing it again is a deliberate step.
- A page restricted by page access that was deleted and then restored from the
  trash used to come back open to everyone in the space, and so did restricted
  pages inside a restored folder or a restored space. The trash now keeps who
  could open each restricted page and puts that back together with the page, in
  the same step that makes it visible, narrowed to people who are still members
  of the space. An administrator who was never let into a restricted page no
  longer sees its title or path in the trash. Items that were already in the
  trash before the fix carry no record of their access and are restored as
  before.
- Raw files of a space can no longer be read around page access, and a share
  link to one page no longer opens other files of its space (other pages'
  Markdown and tables, repository internals). Hidden paths (anything starting
  with a dot, such as `.git`), metadata files and symbolic links are never
  served.
- A share link "with child pages" no longer publishes pages that the person
  who made the link cannot read themselves.
- Share-link management is closed to API tokens, so a read-only token can no
  longer obtain the address of an edit link.
- Uploaded attachments are served by their detected content type rather than
  the type the uploader claimed. Verified raster images and PDF are shown
  inline, SVG inline under a policy that blocks scripts and network access,
  other known file types as downloads, anything else as an opaque download;
  every response carries `X-Content-Type-Options: nosniff`. Responses a
  browser has already cached keep their earlier headers until the cache
  expires.
- Files served straight from a space's git repository (`/files/…`) get the
  same safe headers as uploaded attachments: the type comes from the content,
  SVG opens under a policy that blocks scripts and network access, and HTML,
  XML, scripts and unknown types are downloads. Anyone who could commit a file
  to a space used to be able to run a script in a visitor's session this way.
- The assistant no longer loads the `.agent` rules of a space the user cannot
  read. Rules restricted by page access are skipped for people they are hidden
  from. Rules of a space remain part of every member's run, as documented.
  Turns an earlier conversation already contains are not rewritten.
- PDF and DOCX export no longer lets page content or an SVG make the server's
  rendering browser request external or internal addresses. The page is
  rendered with scripts off, every request except inline data blocked, a
  content policy inside the document and a dead network proxy. Remote images
  in a PDF remain possible only where the operator explicitly allows them;
  that setting never applies to SVG rendering for DOCX.
- Updated dependencies with known advisories: Fastify, the Cursor SDK (which
  also drops an old `undici`), `undici`, `fast-uri`, `hono`, `qs`,
  `ip-address`, `brace-expansion` and `dompurify`.
- Upgraded `@fastify/static` to 10.x, which closes a route-guard bypass through
  encoded separators, a path traversal and a bypass through non-canonical URL
  paths.

## [0.1.0] - 2026-09-29

The first public release.

### Included

- Documents in Markdown with three editor modes, callouts, page links,
  mentions, image attachments, light and dark themes.
- Visual editor for Mermaid diagrams: build on a canvas, nine templates.
- Excalidraw whiteboards stored as editable SVG files.
- Data tables with typed columns, saved views, filters and sorting.
- Forms that write answers into a data table, optionally without an account.
- Real-time collaborative editing of documents, tables and whiteboards.
- Git in both directions: empty spaces, cloning a repository, connecting one
  later, conflict list, page history, "take the version from Git" with a
  backup branch.
- Access management: roles per space, private and open spaces, the access
  matrix, page-level access, audit log, invitations, access requests, public
  share links, optional sign-in with Google.
- Preview of PDF, Word, Excel and PowerPoint files as pages.
- MCP endpoint with 21 tools and personal access tokens.
- AI assistant with Ask and Agent modes, customized per space through the
  `.agent` folder. Bring your own subscription: Cursor today.
- Offline mode: write, edit and create pages and whiteboards without a
  connection.
- Import from Confluence, including whiteboards.
- Export to Markdown, PDF, DOCX and YAML, and a zip of a whole space.
- Full-text search, backlinks, trash with restore, notifications.
- Interface in English and Ukrainian.
- One-command installation with Docker Compose, with optional automatic HTTPS.
