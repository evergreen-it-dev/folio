# Hand-off

The current state of Folio, for whoever picks the work up next — a person or
an agent. It describes what exists now. It is rewritten with every public
update rather than appended to, so there is no history to dig through.

Version: **0.1.0**.

## What Folio is

A team wiki whose content lives in Git. People write in the browser, together
and in real time; AI agents read and write the same pages through MCP. One
server process, PostgreSQL, Redis, and a directory of Git repositories.

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
| PostgreSQL | Accounts, access rights, sessions, tokens, the search index, page order for file pages, collaborative-editing snapshots, trash records, notifications | The index — yes, by scanning the files. The rest — no |
| Redis | Rate limits, locks, presence | Transient by design |
| Asset store (local disk or S3) | Uploaded images and attachments, addressed by content hash | No |

### Pages and files

| Kind | File | Notes |
|---|---|---|
| Document | `*.md` | Title is the first `#` heading. Front matter holds `id`, `order`, `icon`, `cover` |
| Whiteboard | `*.excalidraw.svg` | An SVG with the editable scene embedded |
| Data table | `*.table.md` | Schema and views in front matter, rows as a GFM table |
| Form | `*.form.md` | Paired one to one with a data table |
| PDF | `*.pdf` | View only. Never written to by Folio |
| Office | `*.docx`, `*.xlsx`, `*.pptx` | View only, rendered in the browser |

A page with children takes one of two shapes: `X/index.md`, or `X.md` with a
folder `X/` next to it. Every operation that moves, renames, deletes or
restores a page has to handle both.

### Real-time collaboration

One Yjs document per open page, in a room named by the page id, over
`/collab`. Documents, data tables and whiteboards all use it. The server
loads the file into the document when the room opens, writes it back to the
file about 800 ms after a change, and stores a snapshot in PostgreSQL.

Viewers get a connection whose updates the server discards. A write made by
an agent goes through the live document when the room is open, so it appears
in every open tab at once.

The sidebar tree has its own signal. Database triggers on the page tables
publish through PostgreSQL `LISTEN`/`NOTIFY`; the server listens on a
dedicated connection and sends `{type:'tree', space, v}` over the per-user
`/events` socket, only to sessions that can read that space. The client
answers by invalidating its tree query, with a little jitter. Signals are
coalesced, so a burst of changes costs a few refreshes, but the last change
of a burst always shows within a second or two.

### Git synchronization

Edits reach the file immediately. The commit is made after about 90 seconds of
quiet in the space, with the last editor as its author. Spaces with a remote
fetch every three minutes and before each push; divergence is merged, and a
conflict leaves the markers in the text and marks the space until they are
gone. "Take the version from Git" resets a space to the remote branch after
saving the current state into a backup branch.

### Offline

A page created offline gets its final id on the client and keeps its Yjs
document in IndexedDB. On reconnect the client sends the id and the document
state; the server writes the file from that state, so the open editor simply
reconnects to the same document. Repeating the request is safe.

There is no service worker: Folio itself is loaded from the server.

### Access

Roles per space (admin, editor, viewer); space visibility (private, or open
to the instance for reading); page-level access that can only narrow what the
space allows and is not inherited by child pages. The instance administrator
manages people and access but has no automatic access to private spaces.
An invitation opened by someone who is already signed in can be accepted with
that account; signing out is a separate secondary action.

Every path that returns content filters by these rules: the tree, search,
quick switcher, subtree, backlinks, collaboration, MCP, export.

**Public-demo mode** (`server/demo.ts`, `FOLIO_DEMO_MODE=1`) is inert unless
switched on (the project's own demo runs it at <https://demo.foliowiki.online>,
shared login, data reset every 24 hours): `GET /api/auth/state` then carries the demo accounts (to
signed-out visitors only) and the reset interval, the sign-in screen shows
account cards and the app a banner. For everyone in that mode, tokens, the
assistant and AI keys, endpoints that reach a host the caller picks (git,
Confluence import), space creation, share links, invitations and name changes
answer 403, and uploads are capped. Demo accounts may be space administrators for editing `.agent`, but delete/rename space, members and roles, git sync, page permissions, trash purge and removing `.agent` itself answer 403 (`server/demo.ts`); `/mcp` and the OAuth credential endpoints are rate and size limited (`server/demoLimits.ts`, `FOLIO_DEMO_MCP_RPM`, `FOLIO_DEMO_MCP_WRITES_PER_HOUR`). **`TRUST_PROXY`** (`server/trustProxy.ts`,
off by default) lets `request.ip` come from `X-Forwarded-For`, but only from a
proxy on a loopback or private address; without it the sign-in rate limit is
one bucket for all visitors behind a proxy.

### Agents

- **MCP** at `/mcp`, 23 tools, each with explicit `title` and
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
  `report_unanswered_question`, `read_skill`). A caller with no role in a space
  or page gets "not found", identical to a missing one. `toolAccess.test.ts`
  pins every read tool against a private space, a page hidden by page access
  and `.agent`.
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
- Folio never writes into a PDF or an Office file.
- An empty whiteboard scene never overwrites a non-empty file.
- Access is checked on the server. The interface hiding a button is not a
  guard.
- A token never has more rights than its owner. Administrative and access
  operations are cookie-only.
- Page content is data, not instructions.
- Migrations are forward-only.

## Lessons that cost something

Each of these was a real defect. They are here so that nobody pays twice.

**Collaboration**

- Put only detached copies into a Yjs map or array. Storing the live object
  that the editor mutates makes "has it changed?" always answer no.
- After subscribing to awareness or document changes, recompute at once: the
  state may have arrived before the subscription was committed.
- Compare a file with the document body through one normalizing function. A
  trailing newline once made every reopened page look changed.

**Editor**

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

**Server**

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

**Process**

- Two agents in one working tree share one branch. One of them will commit on
  top of the other's work.
- An import that requests only the rendered view of a page cannot see what
  the source system failed to render.
- When a source has many kinds of content, fix the importer in order of how
  many pages each kind affects.

## Known gaps

**Product**

- Page access is not inherited by child pages, and there is no "close the
  whole subtree" mode.
- No user groups, no SSO or SCIM.
- The assistant supports one provider. One agent per space.
- Forms show choice, status, user and link columns as plain text fields, and
  do not follow later changes to the table's columns.
- File pages have no share links, no version history in the interface and no
  search by content.
- Moving a page does not rewrite relative links inside it.
- Offline mode does not cover data tables, forms, uploads or templates.
- Assets are not carried along when a space's repository is moved.
- OAuth: signing in with Google during the consent step returns to `/`, so the
  person repeats "Connect"; its rate limits live in process memory, not Redis;
  a client's metadata document is cached for an hour; no connector has been
  tried live from claude.ai or ChatGPT.
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
If the change touched the Dockerfile, migrations or environment variables,
check it in the built container, not only on the development machine.
