# Hand-off

The current state of Folio, for whoever picks the work up next — a person or
an agent. It describes what exists now. It is rewritten with every public
update rather than appended to, so there is no history to dig through.

Version: **0.2.0**.

## What Folio is

A team wiki whose content lives in Git. People write in the browser, together
and in real time; AI agents read and write the same pages through MCP; a space
can be published as a read-only website. One server process, PostgreSQL, Redis,
and a directory of Git repositories.

## How it is put together

| Part | What it does |
|---|---|
| `server/` | Fastify: REST API, authentication and access, Git synchronization, real-time collaboration, MCP, the assistant runtime, import and export |
| `web/` | React 19 interface: CodeMirror 6 editor, data tables, Excalidraw whiteboards, administration |
| `shared/` | Contracts between server and client (`contracts.ts`), the data-table codec, form codec |
| `db/migrations/` | Forward-only SQL migrations, applied at startup |

| Storage | Holds | Can it be rebuilt? |
|---|---|---|
| Git repositories (`data/repos/<space>/`) | All page content | It is the source |
| PostgreSQL | Accounts, access rights, sessions, tokens, the search index, page order for file pages, collaborative-editing snapshots (and with them whiteboard reactions), backups of live text the server replaced, trash records, notifications, the publishing settings of public sites, shared AI keys (encrypted), assistant conversations and analytics, the per-reader state of artifacts (`artifact_state`) | The index — yes, by scanning the files. The rest — no |
| Redis | The sign-in rate limit, locks, presence | Transient by design |
| Asset store (local disk or S3) | Uploaded images and attachments, addressed by content hash | No |

Some limits are only in the memory of the server process, not in Redis: the
limits on public-site downloads and on questions to Folio AI, the cache that
maps hosts to public sites, and the demo-mode limits on `/mcp` and the OAuth
endpoints. A restart resets them, and a second process would count on its own.

### Pages and files

| Kind | File | Notes |
|---|---|---|
| Document | `*.md` | Title is the first `#` heading. Front matter holds Folio's own keys (`id`, `order`, `status`, `icon`, `cover`); keys written by other tools are kept as they are. A space bound to a folder of a repository writes no `id` at all (see "Spaces inside a product repository") |
| Whiteboard | `*.excalidraw.svg` | An SVG with the editable scene embedded |
| Data table | `*.table.md` | Schema and views in front matter, rows as a GFM table |
| Form | `*.form.md` | Paired one to one with a data table |
| PDF | `*.pdf` | View only. Never written to by Folio |
| Office | `*.docx`, `*.xlsx`, `*.pptx` | View only, rendered in the browser |
| Artifact | `<name>.artifact/` (a folder) | Replaced as a whole, never edited in Folio. One page, however many files are inside |

A page with children takes one of two shapes: `X/index.md`, or `X.md` with a
folder `X/` next to it. Every operation that moves, renames, deletes or
restores a page has to handle both.

**Replacing a file page.** A PDF or Office page can be given a new file
(`server/filePages.ts`). The page id never changes, so everything keyed by it
(access rules, shares, stars, the URL) carries over; only the bytes and, if the
extension differs, the last part of the path change.

- `POST /api/pages/:id/file` takes one multipart `file`, runs the same name and
  magic-byte checks as the upload that creates a file page, needs the editor
  role and a write scope, and is not reachable through share links. Any of the
  four types may replace any other (pdf to pptx and back). It answers with the
  page plus `previousSha`.
- Every replace is **its own Git commit**, and before it the pending changes of
  the space are committed with `commitNow` (the author is whoever the space
  would have credited, not the person replacing). Without that flush the
  version being replaced could still be uncommitted and "restore" would have
  nothing to restore.
- A **changed extension is two commits**: first a pure rename, with the links
  in other documents rewritten into the same commit (the machinery of "Change
  slug", `rewriteLinksAfterMove`), then a commit with the new content. The
  rename stays a pure rename so `git log --follow` keeps one history across
  it. Only a change of case (`.PDF` to `.pdf`) is not a change.
- `previousSha` is the newest commit touching the file after that flush, i.e.
  the version just replaced. It is what the Undo toast restores. It is `null`
  when the new file was byte for byte identical (nothing was committed), and
  the interface then says nothing changed instead of offering Undo.
- The index row is updated directly (size, mtime, `updated_at`). A rescan
  would skip a file whose mtime and size look unchanged, and two same-sized
  versions written in one clock tick would go unnoticed. File pages have no
  extracted text, so there is nothing to reindex; search stays by title.
- `GET /api/pages/:id/history/:sha/file` serves the bytes at a commit (viewer
  role; `?download=1` for a download). It follows renames, so an older
  revision is found under the name it had then. The response is immutable and
  cached. `GET /api/pages/:id/history/:sha` for a file page returns only the
  path, extension and size at that revision, never the bytes. MCP has no way to
  read the bytes either.
- Restore of a file page goes through the same replace path (message
  `files: restore <path> to <sha7>`), so it is one more commit and also puts
  the old extension back.

### Artifacts

An artifact (`kind: "artifact"`) is an interactive page made by an agent: a
Claude artifact, a Cursor canvas, any self-contained HTML. Code: `server/artifact/`
(routes, serving, import, manifest, state, signed tokens) and `web/src/artifact/`
(view, import dialog, host bridge); migration 051 adds the kind and the
`artifact_state` table.

- **One folder is one page.** `<slug>.artifact/` holds `index.html`, an optional
  `artifact.yaml` (type, entry, source, capabilities; every other top-level key is
  a page property, read and written by the Properties panel straight in the
  manifest), the original source and `assets/`. The scan indexes the folder as a
  single page and never walks into it: nothing inside is a page or a space file,
  and a `.md` inside is not a page. The id is pinned to the path in the index.
  Rename, move, copy and trash are operations on the whole folder. A folder with an
  `index.html` and no manifest is still an artifact (no files are added to someone
  else's repository).
- **The frame is the security boundary.** The page is an iframe with `sandbox`
  and without `allow-same-origin`, so its origin is opaque: no cookies, no Folio
  API. `GET /art/<token>/<path>` is registered outside the session scope; the
  HMAC token (page, reader, 12 hours) is the whole credential and is minted into
  the page payload only for people who may read the page (session, share link,
  public site). Every response carries a `sandbox` Content-Security-Policy and
  the CDN allowlist; `connect-src` is `'self'` plus those CDNs, so an artifact
  cannot call other hosts. `ARTIFACTS_ORIGIN` (optional, not wired into the
  Compose files) moves the frames to a separate origin. Never add
  `allow-same-origin`, and never serve bundle files from a route that reads the
  session.
- **The host bridge** is inlined into the entry page: `window.storage` in the
  Claude artifact shape, a synchronous `localStorage` polyfill backed by memory
  (the browser forbids the real one in an opaque origin), and a `window.claude`
  stub that rejects. All traffic is `postMessage` to the parent, which checks
  `event.source`. The parent keeps the state: in the database for a signed-in
  reader (personal and shared), in the browser's `localStorage` for a guest
  (shared is read only).
- **Import** (`server/artifact/import.ts`): link, file or pasted HTML in the web
  app; `publish_artifact` over MCP. A link is downloaded only if it is a direct
  `https` file: http(s) only, private, loopback and link-local addresses refused
  after resolving, three redirects with the same check, 15 s, 20 MB. Share links
  of claude.ai, claude.site and Cursor are never fetched. ZIPs refuse `..`,
  absolute paths and symlinks and are capped at 500 files and 50 MB unpacked.
  Replacing keeps the id, properties, title and icon.
- Folio does not compile JSX or TSX. That is deliberate for now: agents build the
  page, Folio shows it.

### Page templates

- A template is any page under `_templates/` of a space (routes in
  `server/routes.ts`, placeholders in `server/templateVars.ts`, starters in
  `server/starterTemplates.ts`). There is no separate
  storage: creating from a template reuses the page copy machinery (the one
  behind duplicate and import), so subpages, properties, icon and asset links
  follow, and new page ids are minted for every copy.
- `POST /api/pages/from-template` takes `{templateId, space, parentPath, title?}`;
  `POST /api/pages/:id/make-template` takes `{title?, description?,
  includeChildren}` (`includeChildren` defaults to true) and is refused for the
  space root; `POST /api/spaces/:space/templates` takes `{title, description?}`
  and creates a blank document template. `GET /api/spaces/:space/templates`
  items carry `description`. The description is the template's property
  `template-description`: the picker shows it as a second line, the sidebar as a
  tooltip, and from-template drops it from the new page. In the web app both
  "Make template" and the Templates "+" (and the picker's empty-state button)
  open one dialog; it stays open and undismissable while the request runs. In documents `{{date}}`, `{{author}}` and
  `{{title}}` are substituted; unknown `{{…}}` are left alone.
- `_templates/` is excluded in one place per consumer: the page tree, graph,
  tags, bases, search of the tree and `publicReadablePageIds`. The sidebar
  "Templates" section is the only place that lists them.
- A new empty space gets three starter templates written from the server i18n
  bundles in the creator's language; a space cloned from Git gets none.

### Side-by-side comparison view

- `/compare?items=<id>,<id>@<sha>,…` (`web/src/app/compare/`): up to five
  columns, each a page as it is now (a live column) or one of its commits (a
  version column). The list a reader collects lives in the browser
  (`localStorage`), the address carries only page ids and commits: no titles, no
  text. Whoever opens a link fetches every column with their own rights, so a
  column they cannot open shows a notice and the rest still work; a link never
  grants access. `parseCompareParam` drops garbage and duplicates and cuts
  extras, so a hand-edited or stale link still opens.
- A live column is the ordinary page content, with the same editor and the same
  collaboration connection as the page route, not a second implementation. A
  version column is read-only (`VersionBody`): a document is rendered, a table or
  base shows its file text, a board or a file is a preview.
- "Highlight changes" diffs each version column against the leftmost column,
  block by block (`compareDiff.ts` over `settings/lineDiff.ts`); text that is new
  or changed is green, text that is gone is red and struck through, placed where
  it used to be. It is capped for very large pages and only marks version
  columns. "Compare side by side" is offered to viewers too, and not for a page that
  exists only on the device (offline).

### Real-time collaboration

One Yjs document per open page, in a room named by the page id, over
`/collab`. Documents, data tables and whiteboards all use it. The server
loads the file into the document when the room opens, writes it back to the
file about 800 ms after a change, and stores a snapshot in PostgreSQL.

Viewers get a connection whose updates the server discards, and a page the
person may only view (page access) opens read-only instead of in an editor
whose typing would be dropped. A write made by an agent goes through the live
document when the room is open, so it appears in every open tab at once.

**Typed text must reach the server, and the browser must know it did.**

- *Editor to document.* `web/src/editor/collab-sync.ts` replaces
  y-codemirror's sync plugin. It never throws, compares the editor with the
  `Y.Text` after every change and repairs any difference, and hands the
  `Y.Text` whatever only the editor had when the view goes away. CodeMirror
  switches a plugin off for good when it throws once; an earlier plugin did
  exactly that and left text on screen that the document never saw.
- *Local copy.* The page's IndexedDB copy is reopened and rewritten in full
  when its connection breaks (another tab may delete it). It is deleted only
  after the server has acknowledged the edits: `web/src/app/collabAck.ts` reads
  the server's state vector from its sync replies and counts a doc as saved when
  that vector covers it, never on y-websocket's `synced` flag. Only this tab's
  own updates count, including what the doc already held when tracking began;
  pure deletes are invisible in state vectors, so a fresh sync step 1 after them
  confirms them. Unconfirmed edits turn the header badge into "Not saved" and
  `beforeunload` asks before the tab closes.
- *Server.* A failed write of the page file keeps the room's state in
  `ydoc_state`, is retried with backoff while the room is open, and the next
  open resumes the newer snapshot instead of the older file.
  `ydoc_state.file_body_sha256` records the hash of the body the room last
  wrote; a file that still hashes to it has not changed, so a differing
  snapshot is newer and wins (a NULL hash keeps the old rule: the file wins).
  Files are written atomically (temporary file, then rename); the temporary
  files are excluded from every `git add -A` and orphans are removed by a scan.
  A live room never holds `\r`: CRLF and CR become LF wherever text enters a
  `Y.Text`. Before the server replaces all of a live room's text (a file changed
  while closed, a REST or MCP body write, "Take the version from Git") the old
  text goes to `page_text_backups` (migration 035, no foreign key on purpose, so
  a backup outlives its page; pruned by age at boot and daily).

**Whiteboard reactions** (`web/src/diagrams/reactionsModel.ts`,
`BoardReactions.tsx`) live in a dedicated root of the board's `Y.Doc`,
`reactions: Y.Map`, one key per reaction: `<elementId>|<emoji>|<userId>`.
Adding is a `set`, removing a `delete`; because each triple owns its key, two
people reacting to one shape at once both survive the merge. The scene is never
touched, so a reaction is neither a scene edit nor an undo step. The map
travels over the same socket as the scene, is cached offline with the doc and
is persisted by the room snapshot, which encodes every root of the doc. It is
not written to the SVG file. The add button is not a hover affordance: it shows
only for exactly one selected reactable element (`reactionTarget` in
`reactionsModel.ts`; a bound label stands for its container), in Edit mode, with
the selection tool and no gesture in progress (drag, resize, rotate, text
editing, drawing), at the lower right corner of the selection frame, and the
palette closes when the selection goes. `BoardCanvas` passes
`canReact = canWrite && isEditingNow`: in View mode and for a read-only viewer
the chips are shown but inert, and there is no add or remove.

Other people's carets and selections are drawn by Folio's own plugin,
`web/src/editor/remote-selections.ts`, swapped in for the one that ships with
`y-codemirror.next` (same awareness `cursor` field and relative positions, so
old and new clients see each other). It emits one mark per selection, with the
colour in a CSS variable, and no line decorations. The presence fade in
`editor.css` dims the selection background and the caret after a peer has been
idle for a few seconds; it must only ever touch those. Building the
decorations never throws: positions are mapped from the `\r\n` text of the
`Y.Text`, clamped and sorted, a failure keeps the previous set, and a caret that
would fall inside an atomic range (a replaced list marker, a widget) is moved
to its edge. It is presentation only and writes nothing to the document.

The sidebar tree has its own signal. Database triggers on the page tables
publish through PostgreSQL `LISTEN`/`NOTIFY`; the server listens on a
dedicated connection and sends `{type:'tree', space, v}` over the per-user
`/events` socket, only to sessions that can read that space. The client
answers by invalidating its tree query, with a little jitter. Signals are
coalesced, so a burst of changes costs a few refreshes, but the last change
of a burst always shows within a second or two.

### Inline syntax and the editor

The editor has three parsers for the same text, and an inline construct has to
exist in each: the Lezer grammar of the editor (`web/src/editor/*-syntax.ts`),
the remark/micromark pipeline of Reading (`web/src/markdown/pipeline.ts`), and
the server's export and import code (`server/export/`, `server/confluenceImport.ts`).
Plain TypeScript with no DOM lives in `shared/` so both sides import it.

- **Status tag**, `:status[Done]{color=green}`: a remark text directive.
  `shared/status.ts` holds the palette (grey, blue, green, yellow, red,
  purple; anything else is grey), the label escaping and the parser of the
  attributes. Reading renders `span.folio-status.folio-status--<colour>`; Live
  edit shows an atomic badge widget with a popover (`status-widget.ts`). The
  label is stored as typed; capitals come from CSS, so search, export and copy
  keep the original characters. Search indexes the label and strips the syntax
  (`stripStatusDirectives`), so the colour is never a search hit. PDF and DOCX
  take the colours from `STATUS_PALETTE`, which is kept equal to
  `web/src/markdown/status.css` by hand. A Confluence status macro (rendered
  lozenge or storage-format macro) becomes the tag; inside a table that has to
  stay raw HTML, the styled span is kept, and Reading renders it identically.
- **Underline**, `++text++`: a delimiter pair resolved like `~~`. The Lezer
  rule is `web/src/editor/underline-syntax.ts`, the Reading/export rule is a
  micromark extension in `shared/underline.ts`; the two copies must stay in
  step. Exactly two plus signs, with the same left/right flanking rules as GFM
  strike-through, so `C++`, `a + b` and `+++` stay text. It renders as `<ins>`.
  `<ins>` and `<u>` written as raw HTML on old pages are still read and shown
  underlined. `underline-migrate.ts` is a pure function that rewrites such
  pairs as `++` (un-crossing `<ins>**x</ins>**` into `**++x++**`), converting
  a pair only if the result really parses and counting the ones it left;
  nothing in the application calls it, and nothing runs it by itself.
- **Copy and cut** in Live edit (`copy-markdown.ts`, `copy-html.ts`): the
  selection is mapped back to source through the syntax tree. Every inline
  construct the selection cuts into contributes whatever part of its opening
  and closing marker the selection does not already contain; block prefixes
  (`## `, `- `, `> `) come along only when the selection covers the start of a
  line. The clipboard gets `text/plain` (that Markdown) and `text/html` (the
  rendered result). Adding an inline form to the grammar means adding a line
  to the table of layers in `copy-markdown.ts` and a test. Pasting HTML from
  Folio or from Reading goes through `html-paste.ts`, which turns highlight,
  status tags and strike-through back into their Markdown.
- **Lists** in Live edit are drawn like Reading: a bullet widget replaces the
  marker (disc, circle, square by depth), nested items indent per level with a
  hanging indent, numbers stay real text, task items show the checkbox. In
  Reading, markers hang in a gutter outside the item.
- **Table cells** have a flat inline tokenizer of their own
  (`gfm-table.ts`); it now builds a nested tree, so a cell draws bold inside
  underline, highlight inside bold and a status tag, and reading a rich cell
  back keeps underline and highlight.

### Git synchronization

Edits reach the file immediately. The commit is made after about 90 seconds of
quiet in the space, with the last editor as its author. Spaces with a remote
fetch every three minutes and before each push; divergence is merged, and a
conflict leaves the markers in the text and marks the space until they are
gone. "Take the version from Git" resets a space to the remote branch after
saving the current state into a backup branch.

### Spaces inside a product repository

A space can be bound to a folder of a repository (a root path such as
`docs/`), so documentation lives next to the code and other tools keep reading
the same files.

- **Foreign front matter survives.** `server/frontmatter.ts` merges only
  Folio's keys (`id`, `order`, `status`, `icon`, `cover`) into an existing
  block, line by line. Keys from Docusaurus, MkDocs, Hugo or Jekyll, comments,
  lists, quoting and line endings stay byte for byte. After the merge the block
  is parsed again and only Folio's keys may differ; if anything else moved,
  the block is rewritten from the parsed data without losing a key. A block
  that cannot be parsed is not touched.
- **Light footprint.** A space with a root path (`isLightFootprintSpace`)
  never gets an `id` written into its files, neither on a scan nor on create
  or save. The id lives in the index, found again through the mechanism that
  file pages already use (a claim, the same path, an orphan of the same size,
  else a deterministic id from the path), and move, rename, copy, duplicate and
  restore from the trash all pass their claims on. The space's `.folio` file is
  a dotfile inside the folder, `<rootPath>/.<slug>.folio`. A space that already
  has ids in its files or a `<slug>.folio` in the repository root keeps
  working as it did, without a migration. A space without a root path writes
  its `id` as before.
- **Images in the repository.** A per-space setting (space menu, "Image
  storage"; `PUT /api/spaces/:space/asset-mode`, audited as `space.asset_mode`)
  sends new pasted images to `assets/` under the content root and links them
  with a relative path (`assetLinkTarget` in `uploads.ts`), so GitHub shows
  them.
- **Moving a page keeps links working.** `collab.movePage` (and its undo)
  recalculates the relative links of the moved pages and rewrites the links to
  them from other pages, all in one commit (`docs: move <old> -> <new>`).
  Only `[text](path)` links and images are rewritten. A scan indexes links
  after the whole walk, so a link to a page that sorts later is not stored as
  broken.

### Git providers

- **Connect with GitHub** (`server/auth/githubConnect.ts`). A signed-in person
  links a github.com account in "Git access" through a GitHub OAuth App instead
  of pasting a token. It is not a sign-in method: `GET
  /api/auth/github-connect/start|callback` need the cookie session. State,
  PKCE (S256), the user id and the return path travel in a cookie sealed with
  `FOLIO_SECRET` (AES-GCM); the scope is `repo`; the token is saved as the
  person's git credential for github.com (migration 036 adds `source`, `pat` or
  `oauth`, and `account_login`), replacing a token saved earlier. `GET
  /api/config` reports `githubOAuth` only when both keys and `FOLIO_SECRET`
  are set and demo mode is off. GitHub Enterprise still uses tokens.
- **Repository lists** in the "create space" dialog follow the provider's
  pagination (never leaving the original host), failures come back typed
  (invalid token, rate limit, SAML single sign-on, forbidden, unreachable), and
  a space created without a branch asks the remote for its real default branch.
- The request log drops the query string of the Google and GitHub callbacks
  (a one-time code) and the guest token of a public-site conversation
  (`server/logRedaction.ts`).

### Offline

A page created offline gets its final id on the client and keeps its Yjs
document in IndexedDB. On reconnect the client sends the id and the document
state; the server writes the file from that state, so the open editor simply
reconnects to the same document. Repeating the request is safe.

There is no service worker: Folio itself is loaded from the server.

### Access

Roles per space (admin, editor, viewer) given to a person or to a **group**;
space visibility (`private`, `instance` for reading by every active user, or
`public` for reading by anyone, see "Public sites"); page-level access that can
only narrow what the space allows and is inherited by child pages (the lowest
role on the chain of restrictions wins). The instance administrator manages
people and access but has no automatic access to private spaces.
An invitation opened by someone who is already signed in can be accepted with
that account; signing out is a separate secondary action.

Every path that returns content filters by these rules: the tree, search,
quick switcher, subtree, backlinks, collaboration, MCP, export. The public
site applies its own, narrower policy (see below).

**Public-demo mode** (`server/demo.ts`, `FOLIO_DEMO_MODE=1`) is inert unless
switched on (the project's own demo runs it at <https://demo.foliowiki.online>,
shared login, data reset every 24 hours): `GET /api/auth/state` then carries the demo accounts (to
signed-out visitors only) and the reset interval, the sign-in screen shows
account cards and the app a banner. For everyone in that mode, tokens, the
assistant and AI keys, endpoints that reach a host the caller picks (git,
Confluence import), space creation, share links, invitations, name changes,
changing a space's visibility or publishing settings and setting shared AI keys
answer 403, and uploads are capped. Demo accounts may be space administrators for editing `.agent`, but delete/rename space, members and roles, git sync, page permissions, trash purge and removing `.agent` itself answer 403 (`server/demo.ts`); `/mcp` and the OAuth credential endpoints are rate and size limited (`server/demoLimits.ts`, `FOLIO_DEMO_MCP_RPM`, `FOLIO_DEMO_MCP_WRITES_PER_HOUR`). **`TRUST_PROXY`** (`server/trustProxy.ts`,
off by default) lets `request.ip` come from `X-Forwarded-For`, but only from a
proxy on a loopback or private address; without it the sign-in rate limit is
one bucket for all visitors behind a proxy.

**Link previews** (`server/pageMeta.ts`): link-preview bots read the raw HTML
and never run the app's JavaScript, so `index.html` is rewritten per request
(`/`, `/index.html` and the SPA fallback) with `description`, `og:*`,
`twitter:*` and the page title. A plain instance gets neutral defaults and
`/og/og-folio.png`; demo mode gets its own text and `/og/og-demo.png`;
`FOLIO_OG_TITLE`, `FOLIO_OG_DESCRIPTION` and `FOLIO_OG_IMAGE` override each.
Every value reaches an HTML attribute and is escaped. Share links
(`server/shareMeta.ts`) run on top and replace title, description and URL with
the shared page's own.

**Optional analytics** (`server/analytics.ts`, `web/src/analytics/`) is off
unless `FOLIO_POSTHOG_KEY` is set, and then it is the operator's own PostHog
project. Without a key `GET /api/auth/state` carries no analytics block, the
browser never loads the library, and the server never opens a connection.
Only event names, page kinds and space slugs are sent, never page content,
titles, search words, names or e-mail addresses; there is no identify call, no
person profile, no cookie (the id is in `sessionStorage`), and Do Not Track
turns it off. Session replay masks inputs and page content. The two OAuth
consent steps are server-rendered pages without scripts, so the server reports
them itself with the same anonymous id. Anything new that is sent must be
added to this list and to `docs/INSTALL.md`.

### Groups, single sign-on and the audit log

- **One role resolver.** "Which role does this person have in this space, and on
  this page" is answered in one place, in two forms that must agree:
  `server/access/roles.ts` (TypeScript) and `server/access/roleSql.ts` (SQL for
  search, the index and every list). Nothing else decides it. A person's space
  role is the highest of their own, their active (not archived) groups' and the
  implicit viewer role of an `instance` space. A page's role is the lowest of
  the roles along the chain of restricted ancestors, each of which is the
  person's own grant or the highest of their groups'. `roles.test.ts` compares
  both forms on random trees.
- **Inheritance has no table.** Ancestors come from the page path, so moves,
  renames, Git sync, trash and restore need no upkeep. Copies, duplicates and
  templates of a page restricted through its parent get their own restriction
  at the root; a page restored from the trash never comes back more open.
  `npm run access:inherit-report` (`server/tools`, read-only) lists who loses
  which page when an installation upgrades to inheritance.
- **Groups** (`groups`, `group_members`, `space_group_roles`, a group grant on
  `page_access_grants`, `invites.group_ids`): instance administrators manage
  groups, members flagged as managers manage the membership, space
  administrators grant a group a role in their space. Every membership has a
  `source` (`local`, `oidc`, `saml`, `scim`) and, for a provider, the provider
  it came from; a sync only ever removes memberships of its own source and
  provider. A space must keep an administrator, counting admins through groups.
- **Sign-in** (`server/auth/`): email first (`POST /api/auth/sso/discover`
  routes an address by domain), then password, OpenID Connect (`oidc.ts`,
  `openid-client`) or SAML 2.0 (`saml.ts`, `@node-saml/node-saml`). Both protocol
  modules only verify the provider's answer and reduce it to the same claims;
  the decision to sign in, link, create or refuse, the audit and the session
  are shared (`sso.ts`). Providers come from environment variables
  (`FOLIO_OIDC_<SLUG>_*`, `FOLIO_SAML_<SLUG>_*`, read-only in the interface) or
  from `/admin/auth` (client secrets encrypted with `FOLIO_SECRET`, never
  returned). "Sign in with Google" is one OIDC provider (`google`) and keeps its
  old callback address. An existing account is linked only when the provider
  vouches for the email (OIDC `email_verified`; SAML: the IdP is marked
  authoritative) and the domain is allowed. Enforced SSO makes the server refuse
  a password for the provider's domains in every route that sets or checks one;
  `/login?local` is the audited emergency way in for instance administrators.
  The start routes take `returnTo`, keep it in the signed flow cookie and land
  there after sign-in; `safeAppPath` (`returnPath.ts`) accepts only a same-site
  path, never `/login` or `/api`, at most 1024 characters, else `/`.
- **Group sync** (`groupSync.ts`) runs from the shared sign-in, so OIDC and SAML
  behave alike, in one transaction. It never touches `local` memberships or the
  manager flag, skips archived groups, refuses a change that would leave a space
  without an administrator, and does nothing (but audits it) when the provider
  reports an overage instead of the list.
- **SCIM 2.0** (`server/scim/`, own thin layer on `zod`, no dependency): a
  bearer token per provider (sha256, one active), users and groups, no JIT
  while a token is active. A provisioned person is a placeholder identity
  (`urn:folio:scim:<provider>`) until the first sign-in, when it is turned into a
  real identity by subject, SAML `userName`, or the sign-in email when the
  provider vouches for nothing (Entra over OIDC). Only placeholders of the same
  provider are matched by email.
- **Deactivation** goes through one function (`revokeAllAccessForUser`): sessions,
  personal tokens, MCP OAuth grants and the open sockets. Every way to disable a
  person, SCIM included, must use it.
- **Sessions** have an id, last-seen time (updated at most every five minutes),
  user agent and address. **The audit log** (`/admin/audit`, CSV streamed up to
  100,000 rows) shows what `audit_log` holds; every new action needs a label in
  both interface languages.

### Public sites

A space whose visibility is `public` is also a read-only website for people
without an account. It is the running application in a second mode, not a
static export: nothing is copied, and the publishing settings live in
PostgreSQL, not in Git.

- **Visibility.** `public` includes `instance`: every active user stays an
  implicit viewer, so signed-in people read a public space exactly as they read
  an open one. The one predicate is `spaceOpenToInstance()` in
  `shared/contracts.ts` (sessions, page access and the access matrix use it);
  SQL says `visibility IN ('instance','public')`. Migration 038 widens the
  check constraint and adds `public_subdomain`, `public_domain`,
  `public_allow_download` and `public_allow_assistant` (the two hosts are
  unique).
- **An anonymous caller is not a `User`.** The policy is a set of page ids,
  `publicReadablePageIds(slug)` in `server/publicSites.ts`: every page, minus
  pages with a `page_access` row and everything below them, minus `.agent/**`,
  minus `_templates/`.
  `isPublicPage` is the point check used by collaboration, page, export and
  MCP code; `publicMayReadFile` decides files (a file is public only if a
  public page uses it). A restriction is inherited, so the children of a
  locked page are not public either.
- **Settings.** `GET|PUT /api/spaces/:space/public-settings` (cookie session
  only; space or instance administrator; audited as `space.public_settings`
  and `space.visibility`; refused for demo accounts). Changing visibility
  clears the host cache.
- **Addresses.** `<PUBLIC_URL>/public/<slug>[/p/<id>]` always;
  `<label>.<PUBLIC_SITES_DOMAIN>`; a custom domain. `resolvePublicSiteByHost`
  maps the `Host` header (behind `TRUST_PROXY`, `X-Forwarded-Host`) to a space
  and caches it for ten seconds in process memory. The host of `PUBLIC_URL` is
  never a site. On a site host `index.html` carries a `folio-public-site` meta
  tag (`server/pageMeta.ts`), the SPA mounts the site at `/` and redirects
  `/public/<slug>/…` and `/s/<slug>/…`. The session cookie is bound to its
  host, so a reader on a subdomain or a domain is always anonymous; "Sign in"
  leads to the main host, and `GuestGate` sends signed-out visitors of
  `/s/<slug>/…` of a public space to the site (`?signin=1` opts out).
- **Server.** `server/publicSiteRoutes.ts`: anonymous `GET /api/public/site`
  (by Host), `/api/public/spaces/:slug`, `…/tree`, `…/pages/:id`, `…/resolve`
  and `…/search` (query cut at 200 characters, at most 50 hits). `buildPageDoc`
  is shared with `/api/pages/:id` and the share route. Downloads
  (`…/pages/:id/export.md|pdf|docx`) exist only when the space allows them;
  PDF and DOCX are limited per address (`PUBLIC_EXPORT_PER_MINUTE`, a sliding
  window in `server/rateLimit.ts`), Markdown is not.
- **Web.** `web/src/app/public/**` is mounted outside `AuthProvider`, because
  the shell and sidebar need a session. Documents arrive as Markdown over HTTP;
  a data table is a live read-only grid over the collaboration socket as an
  anonymous viewer whose awareness is silent (no names or cursors go in or
  out); a whiteboard is a static SVG; a form is view only; PDF and Office files
  come through `/files/<space>/…`. `web/src/markdown/publicSite.ts` rewrites
  links and images for guests.

### Agents

- **MCP** at `/mcp`, 45 tools, each with explicit `title` and
  `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`
  annotations, plus a short `instructions` text on `initialize`. `search` and `fetch` are read-only twins of `search_pages` and `read_page` with the same access rules; they exist because ChatGPT deep research and company knowledge only accept tools with exactly those names. Ready-made client setups live in `integrations/` (placeholders only), and `.claude-plugin/marketplace.json` makes the Claude Code plugin installable from this repository. It accepts a
  personal access token (`folio_pat_…`) or an OAuth access token
  (`folio_oat_…`); the code is `server/mcpRoutes.ts`. Folio is its own OAuth
  2.1 authorization server (`server/oauth/`, migration 034): discovery
  documents, dynamic client registration and Client ID Metadata Documents,
  authorization code with PKCE S256 only, consent on top of the cookie
  session, one-hour access tokens, rotating 30-day refresh tokens (reuse of an
  old one revokes the connection), audience `https://<host>/mcp` (RFC 8707),
  everything stored as hashes. OAuth tokens work on `/mcp` only, never on
  REST, and a `read` grant cannot run write tools. Metadata and audience are
  built from `PUBLIC_URL`, so it must be set to the public address, and the
  reverse proxy must pass `/.well-known/*` and `/oauth/*` to the app.
- **Markdown links**: `/share/<token>.md` returns a page, or a page with its
  subtree, as one Markdown document.
- **The built-in assistant** runs on the server as a job, survives a closed
  browser, and uses the MCP tool implementations in-process. In Ask mode the
  write tools are refused by the server. The Cursor agent is given **no
  built-in file, shell or network tools** (`tools: ['mcp']`, passed on both
  create and resume): it runs without an OS sandbox, so those tools would read
  the Git repositories of every space straight from disk around the access
  checks. It sees only the in-process tools (Folio MCP,
  `report_unanswered_question`, `read_skill`), minus the MCP-only `search` and
  `fetch`. A caller with no role in a space
  or page gets "not found", identical to a missing one. `toolAccess.test.ts`
  pins every read tool against a private space, a page hidden by page access
  and `.agent`.
- **Run progress and timing** (`server/assistant/genProgress.ts`,
  `runTiming.ts`, `web/src/app/assistant/runStream.ts`). While the model writes a
  long tool call (a whole page) the SDK reports nothing, so the status line shows
  the thinking token counter, then an elapsed counter after about three seconds
  without an event, and names the real tool. Each run logs one timing line and
  stores the same data in `ai_runs.timing` (agent ready, first text, each tool
  with its duration, rounds, token totals; migration 052): never arguments or
  results.
- **Template tools** (`list_templates`, `create_page_from_template`,
  `save_page_as_template`, `create_template`) mirror the HTTP template routes and
  their gates. The three writes are in `MCP_WRITE_TOOL_NAMES`, so Ask mode and the
  public demo's write limit see them; `list_templates` is not offered to a
  public-site run, and `create_page` refuses a path under `_templates/`.
- **Whose key pays** (`server/assistant/sharedKeys.ts`, migration 037). A run
  uses the first key that exists: the person's own (while personal keys are
  allowed), then the key of the space the question is asked in, then the key of
  the instance, then `CURSOR_API_KEY`. `resolveApiKey(userId, space)` in
  `server/assistant/routes.ts` is the only place that decides;
  `GET /api/assistant/settings?space=` reports `apiKeySource`
  (`personal`, `space`, `instance`, `environment` or `none`) and
  `personalKeysAllowed`. Instance administrators set the instance key and the
  policy (`GET|PUT|DELETE /api/admin/assistant/key`, `PUT
  /api/admin/assistant/key-policy`); space administrators set the key of their
  space (`GET|PUT|DELETE /api/spaces/:space/assistant-key`). All of these need
  the cookie session and are refused in demo mode. Shared keys are encrypted
  with `FOLIO_SECRET`, the API never returns one (only the key's name, the
  Cursor account, who set it and when), and every change is audited
  (`assistant.instance_key_set|removed`, `assistant.space_key_set|removed`,
  `assistant.key_policy`). When personal keys are off, a stored personal key is
  ignored, not deleted.
- **Ask Folio AI on a public site** (`server/assistant/publicRoutes.ts`,
  migration 039). Visitors are anonymous. Their runs belong to a built-in
  system user, "Public visitor" (`users.is_system`): no password, cannot sign
  in, hidden from lists of people, a viewer of public spaces only. The run
  carries `publicSpace` in the MCP actor (`server/mcp.ts`), so `list_spaces`,
  `list_tree`, `search_pages`/`search`, `read_page`/`fetch`,
  `folio_table_list` and `get_backlinks` answer only about that one space and
  only about its public pages; `page_history` and `page_at_sha` are refused,
  there are no write tools, and any mode other than Ask is rejected
  (`server/assistant/tools.ts`). Routes: `POST
  /api/public/spaces/:slug/assistant/runs`, `GET …/runs/:runId/events`, `POST
  …/runs/:runId/stop`, `GET …/conversations/:id`. A conversation is reached only
  with the guest token of the browser that started it (the database stores its
  SHA-256 hash, compared in constant time). Answers: 404 when the space is not
  public or the switch is off, 403 in demo mode, 409 when no key exists, 429
  with `Retry-After` past the limits (per address, `PUBLIC_ASSISTANT_RUNS_PER_HOUR`,
  default 20; per site, `PUBLIC_ASSISTANT_SPACE_RUNS_PER_HOUR`, default 200;
  both in process memory). The key is resolved space, instance, environment.
  The `.agent` rules of the space are part of the prompt of these runs too.
  The conversations show up in the assistant analytics under "Public visitor".
- **`.agent`**: pages in this folder of a space are added to every assistant
  run in that space, up to about 60,000 characters, cut at a page boundary.
  The folder is visible to space administrators only.
- **Assistant analytics** (migration 032): ratings of answers, a periodic
  survey, and questions the assistant reported through the built-in
  `report_unanswered_question` tool. They are read at `/admin/assistant`
  (`/api/admin/assistant/*`), which needs a cookie session; a token is
  refused. An instance administrator sees everything; a space administrator
  (explicit `admin` role) sees only runs in their spaces and, inside them, only
  those runs' messages. The rule is applied in SQL (`visibleMessage` in
  `server/assistant/adminRoutes.ts`), never by filtering in JS, and a filter by
  someone else's space is refused. Opening a conversation is written to the
  audit log (`assistant.conversation_viewed`, lowercase id as target); the
  conversation page reads it back as "Who opened this conversation" (migration
  033, a partial index). Reading that list is not itself audited, and the page
  must not reload a conversation on window focus, since each load counts as an
  opening.
  The `missing` argument of `report_unanswered_question` is described to the
  model as a short statement of the gap plus Markdown links to pages read in
  that run (`[title](/s/<space>/p/<id>)`), never invented ones; the description
  is pinned in `analytics.test.ts`. `GET /api/admin/assistant/access` also
  returns `spaceRefs` (`{slug, name}`) so the space administrator's note can
  show names. `insertUnanswered` takes an advisory lock per run: the same
  question (case, spacing and trailing punctuation ignored) in one run is not
  recorded twice, an empty `missing` is only completed. There is no unique
  index, so no migration.

## What must never break

- Page writes (create, copy, duplicate, make template, from template) reindex
  only the paths they touched (a scoped scan); a full `scanSpace` remains the
  fallback and the boot/Git path. Folder-prefix lookups use byte-order range
  indexes (migration 050, `COLLATE "C"`), never `left(path, n) = ...`.
- A share payload carries `ownAccess` only for a signed-in reader whose own
  role on that page is viewer or higher; a guest or an outsider must never learn
  the page's space or id from it.
- Files are the source of truth. Nothing that matters may exist only in the
  database, except what the table above lists.
- The collaborative-editing snapshot is not a cache. Deleting it or dropping
  sockets to force a reload duplicates content in clients that still hold the
  old document.
- Whatever Folio writes into a Markdown table must remain a valid GFM table
  that GitHub and GitLab render without debris.
- The tree signal carries no titles, paths or page ids, and goes only to
  sessions that can read the space. The tree itself is always fetched
  through the access checks.
- A table cell must not re-render in the middle of input-method composition.
  During composition the cell only reads the DOM; cleanup waits for
  `compositionend`.
- Folio never writes into a PDF or an Office file. Replacing a page's file
  swaps the whole file; it never edits one.
- Every replace and every restore of a file page is one commit of its own,
  preceded by a flush of the pending auto-commit. Do not batch two replaces
  into one commit and do not skip the flush: the version being replaced must
  be in the history.
- A changed file extension is a rename commit first, then a content commit. Do
  not fold the rename into the content: Git detects a rename by similarity,
  and a new file shares almost nothing with the old one, so the page would
  lose its earlier versions in the history.
- `previousSha` is what Undo restores. The replace response must keep carrying
  it, and a replace of identical bytes must report `null`.
- The bytes of an old revision are read as a buffer (`git show` without text
  decoding). Reading them as a string corrupts a PDF or an Office file.
- An empty whiteboard scene never overwrites a non-empty file.
- Access is checked on the server. The interface hiding a button is not a
  guard.
- A token never has more rights than its owner. Administrative and access
  operations are cookie-only.
- Page content is data, not instructions.
- Migrations are forward-only.
- The link between the editor and the `Y.Text` never throws and never stays
  switched off. Any exception in a document `update` handler (a local-storage
  provider, for instance) must be caught where it is raised.
- A local copy of a page is deleted only after the server has acknowledged the
  edits by state vector. "The socket says synced" is not an acknowledgement.
- A live room's text is never replaced without saving the old text first.
- A live room never holds a carriage return.
- A default install sends nothing to anyone. Analytics stays opt-in, behind a
  key the operator sets.
- Remote selections never use line decorations, and no presence style may set
  `opacity` or `visibility` on anything that wraps document text. Fade the
  background and the caret widget only.
- Copy and cut in Live edit put Markdown on the clipboard, not the visible
  characters. Replaced markers (`**`, `==`, `++`, link brackets) are outside a
  mouse selection of the visible word.
- The `++` underline keeps its flanking rule and "exactly two" rule in both
  parsers. Do not write underline as an HTML tag pair: a pair knows nothing
  about the `**` pair around it and the two can cross.
- Importing a Confluence tree must never replace a page that already exists at
  the target, least of all a space's own `index.md`, which the tree does not
  list.
- An anonymous request is answered from the public policy and nothing else.
  A route, tool or socket that serves content to someone without a session
  asks `isPublicPage` / `publicReadablePageIds` / `publicMayReadFile`; it never
  widens a normal route to accept no session. Restricted pages, `.agent/**`
  and templates are never public.
- A visitor of a public site must not receive anyone's name, cursor or
  presence: the anonymous collaboration connection is a silent viewer in both
  directions.
- Publishing settings, shared AI keys and their policy are changed by cookie
  session only, never by a token, and never in demo mode. A shared key is never
  returned by any endpoint, is stored encrypted and every change is audited.
- Ask Folio AI on a public site stays Ask only, confined to one space and its
  public pages, and its conversation is reachable only with the guest token
  that created it. The token is stored as a hash and never logged.
- The host of `PUBLIC_URL` is never served as a public site.
- MCP-only tools (`search`/`fetch`) are not offered to the in-app assistant;
  the assistant tool set must not contain URL/path/command-looking tools. The
  external `/mcp` endpoint keeps all 45. The skip list is
  `MCP_ONLY_TOOL_NAMES` in `server/assistant/tools.ts`, pinned in
  `toolAccess.test.ts`.
- `_templates/` never leaks: not into the page tree, graph, tags, bases, public
  sites, and not into the public page set. A new place that lists pages has to
  skip it, and the sidebar "Templates" section stays the one exception.
- A person's role comes from the one resolver (`access/roles.ts` and
  `roleSql.ts`), never from a query or a check written next to it. Do not add a
  third place that decides "may this person open this page". A restricted
  ancestor can only narrow what a child allows, never widen it.
- A single sign-on assertion is accepted only when it is signed, answers the
  sign-in this browser started (state, nonce, `InResponseTo`), is within its
  validity and has not been seen before. SAML XML with a `DOCTYPE` is refused.
  Never log a token, an assertion or a client secret, and never return a secret
  from an endpoint.
- An existing account is linked to a provider only when the provider vouches for
  the email and the domain is allowed. A SCIM placeholder is matched only within
  its own provider and only while it has not signed in.
- Group sync removes only what it added (same source, same provider), never
  hand-made memberships and never the last administrator of a space.
- Deactivating a person revokes sessions, tokens, OAuth grants and sockets
  together; a new way to disable an account must call the same function.
- Provider settings and SCIM tokens are changed by an instance administrator's
  cookie session only, never by a token, and every change is audited. A SCIM
  token sees and changes only the people and groups of its own provider.

- A compare link must carry only page ids and commits, and every column must be
  fetched with the rights of whoever opens it. Putting a title, a text or a
  resolved permission into the address, or fetching a column with the sender's
  rights, would turn the link into a way around page access.

- An artifact's frame must stay an opaque origin and `/art/…` must stay
  independent of the session: a bundle is code written by a stranger or an agent.
  A change that lets it read a cookie, call `/api/…` or load an arbitrary host
  breaks the model.

## Lessons that cost something

Each of these was a real defect. They are here so that nobody pays twice.

**Collaboration**

- Put only detached copies into a Yjs map or array. Storing the live object
  that the editor mutates makes "has it changed?" always answer no.
- After subscribing to awareness or document changes, recompute at once: the
  state may have arrived before the subscription was committed.
- Compare a file with the document body through one normalizing function. A
  trailing newline once made every reopened page look changed.
- A reaction, a cursor, anything a person adds to a shared object, gets its own
  key in a shared map. A field on the shared object is last-writer-wins and
  loses one of two simultaneous writers.
- `Y.Text` positions and the editor's can differ when the text contains `\r`;
  two clients then rewrite the same span and double it. Normalize on entry.
- A write that fails must leave the next attempt something to work from: keep
  the state, retry with backoff, and let the newer state win on the next open.
- An exception inside a `Y.Doc` `update` handler (a local-storage provider
  writing to a closed connection, for example) escapes into the editor binding
  and, in CodeMirror, switches that plugin off for good. A test for this layer
  makes the persistence provider fail and then checks that the text still
  arrives.

**Editor**

- A third-party plugin that decorates whole lines will fight your own styles.
  `y-codemirror.next` marked the middle lines of a selection with a line
  decoration and wrapped the rest in marks; a fade that set `opacity: 0` on
  those classes made other people's selected text vanish for everyone watching
  (the text was intact; only its drawing was hidden). When a style is
  conditional on someone else's state, make it affect a colour, never the
  text's visibility.
- An HTML tag pair is a bad inline format for Markdown: it ignores the
  delimiter pairs around it and can cross them. A delimiter pair resolved by
  the parser nests and cannot cross.
- A flat tokenizer for table cells shows raw markers for any nested format.
  Anything a cell can contain needs the nested tree, and the read-back of a
  rich cell has to keep every format, or the first keystroke strips them.
- A line of dashes under a paragraph is a Markdown underline-style heading, so
  typing a single `-` re-parsed the whole paragraph as a heading. The editor's
  parser drops that heading form; Reading mode still renders it.
- jsdom does not reproduce `contenteditable`, focus, selection or layout. A
  green unit test proves little here; look in a real browser.
- A test that types instantly passes on code that fails at human speed. Tests
  for input handling need a pause between keystrokes.
- Hidden markup needs atomic ranges, or the caret ends up inside it and Enter
  splits a link in half.
- Third-party editor styles are often more specific than yours. Check the
  computed value, not the rule you wrote.
- Input methods (emoji panel, dead keys, phone keyboards) compose text in
  steps that a plain key handler never sees. Keys pressed during composition
  belong to the composition; test with real composition events, not inserted
  text.

**Markdown**

- A directive parser claims every colon in prose. Times, ratios and ports go
  through it; undeclared inline directives must be returned as the original
  text.
- Do not rewrite absolute asset paths as if they were relative.
- A CSS list marker inside a block-level item (a loose list wraps item text in
  a paragraph) becomes a line of its own. Hang the marker outside the item.
- `:status[...]` is the one inline directive Folio declares; the rule above
  still applies to every other `:name` in prose.

**Server**

- A tree importer that writes to the "root" of a space writes onto the space's
  home page. Choose the destination so that it cannot clobber or hide a page
  that exists; when in doubt, make a folder of its own and update that in
  place on re-import.
- An anonymous caller is a different kind of caller, not a user with fewer
  rights. Model it as a policy that has to be asked explicitly (a set of
  readable ids) instead of a role, so that a new route cannot be public by
  forgetting a check.
- A session cookie belongs to one host. A site on another host or domain is
  anonymous by construction; do not try to share the cookie across hosts.
- Anything that spends someone's money (a shared AI key) must show whose key is
  in use, and the order in which keys are tried has to live in one function.
- Foreign front matter belongs to other tools. Merge only your own keys, parse
  the result again and check that nothing else moved; a rewrite from parsed
  data is the fallback, never the first move.
- Do heavy work after the port is open, never before. A scan that throws
  during startup takes the whole instance down with no way to see why.
- Do not turn "every file I read failed" into "system failure": with one
  pathological file left to read, it fires every time.
- When production misbehaves, first make the cause visible over HTTP.
- PostgreSQL limits a text-search vector to 1 MB. Cap what goes into it.
- Partial clones fetch blobs during merge and history too, so those need the
  same credentials as fetch and push.
- A health endpoint that checks the process only is green while the database
  is down.
- Every download or export response needs an explicit `Cache-Control`, and
  `no-store` for anything built from live data. A CDN such as Cloudflare caches
  by file extension (`.pdf`, `.docx`) and ignores that the route is
  authenticated, so without the header every export after the first is stale.
- Do not pace every refresh. Throttling all of them delayed the last change
  of a burst; only intermediate progress refreshes may be spaced out. Measure
  the interval from the start of an API call, not from when it returns.

**Front end and deployment**

- Keep long popover lists internally scrollable and keep their persistent
  actions outside the scroll area. Scroll events from inside a menu must not
  be mistaken for page scroll and close it.
- A missing chunk after a deployment must be a real 404, not `index.html`
  with status 200, and the client should reload once when it sees it.
- A browser remembers a failed dynamic import for the life of the document.
  Retrying means reloading the page.
- Content-hashed assets should be cached as immutable; without that an
  offline tab has nothing to work with.
- A query library may pause requests when the browser reports offline.
  Offline creation needs requests that run regardless.
- The development proxy may break WebSockets. Check collaboration against the
  server port directly.
- Panels inside a container with hidden overflow get clipped whatever their
  z-index. Render them in a portal with fixed positioning.
- Dependency advisories: first try a lock-file update (`npm update <pkg>`), then
  a direct bump, and only then `overrides` in `package.json`. The overrides in
  place (`nanoid`, `katex`, `shell-quote`, and `argparse` inside `gray-matter`'s
  `js-yaml` 3) exist because a parent pins an old range or no fix exists; drop
  each one when its parent catches up and check `npm ls <pkg>` shows no
  `invalid`. `gray-matter` needs `js-yaml` 3 (`safeLoad`), so it cannot simply
  be pointed at 4. Fastify's own `@fastify/proxy-addr` accepts a mis-written
  IPv4-mapped trust subnet the same way as the `proxy-addr` advisory describes;
  keep `TRUST_PROXY` values in plain IPv4 or full IPv6 form.

**Configuration**

- `docker-compose.yml` lists the app's environment variables one by one, so a
  setting that is read in `server/` and documented but not listed there never
  reaches the container: it works from source and silently does nothing under
  Compose (`TRUST_PROXY` and `FOLIO_DEMO_*` were like that). A new setting goes
  into the compose `environment:` block as `${NAME:-}`, into `.env.example` and
  into the table in `docs/INSTALL.md`. Compose then passes an empty string, so
  the server must read an empty value as unset (`||`, or `?? ''` plus a check
  for empty), never `Number(process.env.X ?? 2)`, which turns an empty string
  into 0. A setting whose empty string means something else (`EXPORT_PDF_*`)
  is left out of the compose file on purpose.

**Process**

- Two agents in one working tree share one branch. One of them will commit on
  top of the other's work.
- An import that requests only the rendered view of a page cannot see what
  the source system failed to render.
- When a source has many kinds of content, fix the importer in order of how
  many pages each kind affects.

## Known gaps

**Product**

- GitHub and GitLab show `++underline++` and `:status[...]{color=…}` as written;
  only Folio renders them. Status tags degrade to readable text, underline to
  the text between plus signs.
- The conversion of old `<ins>`/`<u>` underline to `++` exists as a function
  (`web/src/editor/underline-migrate.ts`) with no runner in the application:
  old pages keep rendering underlined without it.
- `{{title}}` is substituted only in documents, not in the text of data tables
  or forms. The subpages of a template appear only in the Templates section
  tree, nowhere else.
- A child page cannot be opened wider than its restricted parent; a page moved
  out from under a restricted page is open to its space again.
- Group sync runs at sign-in only: a change at the provider reaches Folio at
  the person's next sign-in (SCIM is immediate). Entra ID's overage (too many
  groups for the token) is not resolved through Graph. Groups do not nest.
- SAML: no encrypted assertions, no signed requests, no single logout. SCIM is
  the subset providers use (no bulk, sort, ETag). No LDAP.
- Audit entries are written without waiting and never pruned; actions such as
  ordinary page edits are not audited.
- The assistant supports one provider. One agent per space.
- Forms do not follow later changes to the table's columns.
- File pages have no share links and no search by content. Their version
  history lists, downloads and restores versions; the compare view shows a
  version as a preview without change marks, and an Office version has no in-browser preview in the history
  panel (only a download; a PDF is previewed).
- Moving or renaming a page rewrites `[text](path)` links and images, but not
  HTML tags or reference-style links.
- Offline mode does not cover data tables, forms, uploads or templates.
- Reactions exist on whiteboard shapes only, not on documents, tables or
  comments, and live in the database, not in the board's file or in Git.
- The "Not saved" badge reports that the server has not confirmed the latest
  edits; it cannot tell a dropped connection from a role that does not allow
  editing, so its hint mentions both.
- Assets are not carried along when a space's repository is moved.
- Compare: five columns at most; highlighting is block by block, so a moved
  paragraph shows as changed, a very large page is skipped, and only version
  columns are marked. The collected list is per browser; the link is how it is
  shared.
- Artifacts: no JSX or TSX runtime, no comments, no version list in the interface
  (Git has them); the Claude API inside a page is a stub and network calls are
  blocked; search sees the visible text of the entry page, not what scripts draw;
  claude.ai and Cursor share links are not fetched (publish over MCP instead).
- OAuth: a consent address longer than 1024 characters is not kept through
  single sign-on, so the person repeats "Connect"; its rate limits live in
  process memory, not Redis;
  a client's metadata document is cached for an hour; no connector has been
  tried live from claude.ai or ChatGPT.
- Public sites: Folio generates no `robots.txt` or sitemap and does not mark
  the pages `noindex`. Only downloads and Ask Folio AI are rate limited; public
  search and the other read routes have no per-address limit. The limits and the
  host cache are in process memory, so several processes behind one address
  need a shared (Redis-backed) limiter and a way to invalidate the cache.
  "Sign in" on a site leads to the main host. The `.agent` rules of a space
  reach the prompt of public Ask runs, so a visitor may get them paraphrased.
- Spaces inside a product repository: a rename made outside Folio in Git is
  matched to its page by file size (as for PDF and Office files), and a
  Confluence import into such a space still writes `id`s.
- Folio runs as one server process. Real-time rooms and sockets live in that
  process, so several processes behind one address need a deliberate design.

**Defects**

- Dark theme: the data-table grid stays white and column headers are hard to
  read.
- Export to PDF and DOCX does not render callouts or Mermaid diagrams.
- The default view of a new data table is named in Ukrainian whatever the
  user's language is.
- Emptying the trash can leave a folder with nested pages behind.
- Nested collapsible sections may not collapse in Live edit.
- On Android the keyboard uses `EditContext`, and composition events may not
  reach the editor, so text typed right under a table can still stick to it.
- `/api/health` reports the process only, not the database.

**Not verified**

- Whiteboard editing and the quick switcher with an open keyboard on a real
  phone.
- Automatic HTTPS with a real domain (checked with a local certificate).
- The install kits on their platforms (only plain Docker Compose and Coolify have been run end to end; Folio's own production runs on Coolify).

**Languages**

- The interface ships in English and Ukrainian. Which languages a build has
  is decided by the bundle files that exist (`web/src/*/i18n/<code>.json`,
  `server/i18n/<code>.json`, `web/src/emoji/keywords/<code>.ts`,
  `web/src/editor/emoji-aliases/<code>.ts`): adding a language means adding
  files, not editing code.
- Code, comments, tests and the assistant's prompts are in English. Tests run
  in English; a test that needs Cyrillic text lives in a file of its own.

## Before a release

```bash
npm run typecheck
npm run build
npx vitest run <the files you touched>
```

Then start the whole stack from a clean checkout with `docker compose up -d`,
create the first account, a space and a page, and open the page in two tabs.
If the change touched publishing, make a space public and open
`<PUBLIC_URL>/public/<space>` in a private window: the tree, a page, search and
a data table must work, and a locked page must answer "not found".
If the change touched the Dockerfile, migrations or environment variables,
check it in the built container, not only on the development machine.
