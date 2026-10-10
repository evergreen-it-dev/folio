# Development plan

What has been built and what comes next. This is the condensed plan: the
outcome of each stage, not the working notes behind it. It is rewritten with
every public update.

## How work is planned

Work goes in **rounds**. A round starts from a request by the product owner
and ends with something the owner can try in the browser.

1. **The request** is written down as a goal and an acceptance check — what a
   person must be able to do when the round is done.
2. **The contract first.** Anything that crosses the boundary between server
   and client is added to `shared/contracts.ts` before any other code.
3. **Zones.** The round is split by directory, and each zone goes to one
   agent: `server/` with `db/`, `web/src/app/`, `web/src/editor/`,
   `web/src/markdown/`, `web/src/diagrams/`, `web/src/tables/`,
   `shared/tables/`. Zones do not edit each other's files.
4. **Waves.** Zones that depend on each other run in order; the rest run in
   parallel. Pure logic comes first, then the server and the interface on
   top of it.
5. **Verification.** Type check, the tests of the zone, a production build —
   and then a look in a real browser.
6. **Hand-off.** What changed, what is still open and what was learned goes
   into [docs/HANDOFF.md](docs/HANDOFF.md).

From time to time a round is a **test run** instead: several agents, each
with its own browser, go through the whole product by area and report
defects with the file and line; a separate wave fixes them.

## What has been built

In the order it was built.

| # | Stage | Outcome |
|---|---|---|
| 1 | Foundation | Markdown files as the database, page tree, three editor modes, real-time editing, Mermaid, Excalidraw whiteboards, search |
| 2 | Accounts and roles | Sign-in, sessions, roles per space, favorites, transliterated file names |
| 3 | Git-native spaces | A space is a repository: clone, commit after a quiet period, fetch, merge, conflict state, page history and restore |
| 4 | Asset store | Uploaded files addressed by content hash, on local disk or S3; paste and drag-and-drop of images |
| 5 | PostgreSQL and Redis | Accounts, access and the search index move to PostgreSQL; full-text search with typo tolerance; Redis for locks and rate limits |
| 6 | Interface polish | Page links with `[[`, link previews, quick switcher, outline, page icons and covers, themes, templates |
| 7 | Tokens and MCP | Personal access tokens with scopes; MCP server over HTTP |
| 8 | Share links | View and edit links for people without an account, including live editing |
| 9 | Invitations | Links with preset roles, expiry and usage limits; ready-made MCP settings for popular clients |
| 10 | Languages | Interface in English and Ukrainian, switched on the fly |
| 11 | Git providers | Saved credentials, repository and branch pickers, directory browser |
| 12 | Confluence import | Pages and trees with images, converted to Markdown |
| 13 | Page tree directive | `::pagetree` — a live tree of child pages inside a page |
| 14 | Mobile | Layout for phones and tablets |
| 15 | Mentions | `@username` stored as plain text, highlighted when the person exists |
| 16 | Import quality | Collapsible sections, clean tables, cell colors, status labels carried over from Confluence |
| 17 | Extended tables | Merged cells, cell colors and column widths in a form that stays a valid GFM table |
| 18 | Whiteboard libraries | Built-in shape libraries, the library browser, localized interface |
| 19 | Visual diagram editor | Mermaid on a canvas: add and connect nodes by clicking, nine templates |
| 20 | One table editor | Inline table editing with row and column handles, multi-line cells, lists in cells, formatting toolbar |
| 21 | Administration | Spaces overview, page slugs with automatic link updates, page order, the `.folio` space file |
| 22 | Export | Markdown, PDF, DOCX and YAML; page headers and footers per space; export with child pages; whiteboards and tables inside exports; Markdown links for agents |
| 23 | Whiteboard import | Confluence whiteboards become Excalidraw boards, with text layout and orthogonal connectors |
| 24 | Data tables | Tables as a page kind: nine column types, views, filters, sorting, real-time editing, import and export, MCP tools |
| 25 | Trash | Deleted pages, folders and whole spaces can be restored, with members and roles |
| 26 | Access | Administrators no longer read every space; access matrix; space visibility; audit log |
| 27 | Page-level access | A page can be narrower than its space |
| 28 | Undo for structure | Create, copy, rename, move and slug change can be undone by the person who did them |
| 29 | Whiteboards together | Whiteboards join the real-time rooms; changes by agents appear at once; the tree updates without a reload |
| 30 | Assistant | Ask and Agent modes, runs that live on the server, board drawing from a short description |
| 31 | Presence and notifications | Who is on the page; access requests with instant notifications |
| 32 | Notes and glossary | Callouts and checklist items collected in a side panel; glossary terms with hover cards |
| 33 | File pages | PDF, Word, Excel and PowerPoint as pages with preview |
| 34 | Sign in with Google | Limited to listed email domains |
| 35 | `.agent` | Per-space instructions for the assistant, as ordinary pages |
| 36 | Forms | Forms that write into data tables, optionally without an account |
| 37 | Editor hardening | Caret and Enter around hidden markup, paste from spreadsheets, highlights with colors, tables that do not lose typed text |
| 38 | Offline mode | Create and edit pages and whiteboards without a connection |
| 39 | Public release | One-command installation, optional automatic HTTPS, documentation |
| 40 | First steps | A welcome wizard for a fresh installation; duplicating a page with its whole subtree |
| 41 | Dense content and navigation | Resizable document tables, searchable space switching, and accepting an invitation with the current signed-in account |
| 42 | Live tree and input methods | The sidebar page tree updates by itself when someone else changes it; emoji panels, dead keys and phone keyboards no longer break tables; a pasted address over selected text makes a link; whiteboard labels stay on top in rendered pictures; the assistant starts again in the Docker image |
| 43 | Assistant analytics | 👍/👎 on answers, a periodic "did it solve your question?" survey, questions the assistant could not answer, and an instance-administrator page with filters (migration 032) |
| 44 | Assistant security and analytics for space administrators | The assistant has no file or shell tools, only Folio's own; a space or page without any role looks the same as a missing one; space administrators see the analytics of their own spaces; the person's own question, space names and a "who opened this conversation" list (migration 033); an unanswered question links the pages the assistant read, space names in the space administrator's note, the Ask/Agent labels in Ukrainian, one report per question per run |
| 45 | OAuth for MCP | Folio is its own OAuth 2.1 authorization server, so claude.ai, Claude Desktop and ChatGPT connect without a pasted token; consent screen, rotating refresh tokens, audience binding, "Connected apps" (migration 034); tool annotations and server instructions on all MCP tools |
| 46 | Install kits and demo mode | A published image for amd64 and arm64 and kits for ten platforms; an inert-by-default public-demo mode for running your own demo; `TRUST_PROXY` for the sign-in rate limit behind a proxy |
| 47 | ChatGPT deep research and integration packs | `search` and `fetch` MCP tools (23 in all) so ChatGPT deep research and company knowledge can read Folio; `integrations/` with ready-made setups for Claude Code (a plugin, installable with `claude plugin marketplace add evergreen-it-dev/folio`), Cursor, VS Code, Codex, n8n, Open WebUI, ChatGPT and Claude; demo accounts may administer a space's `.agent` rules, with rate limits on the demo's MCP and OAuth endpoints |
| 48 | No lost text, board reactions, opt-in analytics, link previews | Typed text can no longer stay only on screen: the editor-to-document link repairs itself, the local copy goes only after the server confirms it by state vector, "Not saved" and a leave warning, a view-only page opens read-only; on the server retried file writes, the newer snapshot wins over an unchanged file, atomic writes, CRLF normalized, backups of replaced live text (migration 035); a lone `-` under a paragraph stays a dash; emoji reactions on whiteboard shapes stored in their own shared map of the board (the add button belongs to the one selected shape, in Edit mode only; chips are inert in View and read-only); an off-by-default PostHog hook for demos you run; Open Graph and Twitter cards for the front page (`FOLIO_OG_*`) |
| 49 | Dependency advisories | Seven open advisories closed: MCP SDK 1.31+, `@fastify/busboy` 3.2.2, `source-map-js` 1.2.2, `proxy-addr` 2.0.8, and by override `shell-quote` and `katex`; `sprintf-js` removed from the lock file (it only served a `js-yaml` 3 command-line tool); `npm audit --omit=dev` is clean |
| 50 | Inline formatting | A status tag (`:status[Done]{color=green}`, six colours, Confluence status macros imported, PDF and DOCX); underline as `++text++` that nests with the other formats; copy and cut in Live edit keep formatting (Markdown and HTML on the clipboard); Live edit lists look like Reading; Reading keeps the number and text of a loose list on one line; the Confluence import no longer replaces a space's home page; a collaborator's selection no longer hides text |
| 51 | Replace a file page, file version history | A PDF, Word, Excel or PowerPoint page takes a new file and keeps its id, link, place in the tree, access and stars: tree menu item, header button, drag and drop with a confirmation, an Undo toast. A new file of another type renames the file and rewrites incoming links the way a slug change does. Every replace is its own commit (the quiet-period commit is flushed first), so the history panel lists file versions with name and size, downloads any of them, previews a PDF and restores one. `POST /api/pages/:id/file`, `GET /api/pages/:id/history/:sha/file`; `docker-compose.yml` now passes `TRUST_PROXY`, `FOLIO_DEMO_*`, `FOLIO_DEFAULT_REPO_URL` and the assistant deadlines to the app (they were documented but ignored under Compose) |

## What comes next

Not promises and not dates — the order in which things are likely to be
picked up.

**Correctness**

- Dark theme for the data-table grid.
- Callouts and Mermaid diagrams in PDF and DOCX export.
- Default names that follow the user's language.
- Choice, status, user and link fields rendered properly in forms.
- Trash: remove nested folders when emptying.
- Readiness check that includes the database.

**Reach**

- Check the kits on each platform (only plain Docker Compose and Coolify have been run end to end; Folio's own production runs on Coolify).
- More providers for the assistant.
- Share links and content search for file pages.

**Depth**

- Inherited page access for a whole subtree.
- User groups and single sign-on.
- Forms that follow changes to their table.
- Offline mode for data tables.
- Space list and membership changes pushed to open sessions as the page tree already is, in place of polling.
- Relative links rewritten when a page moves.

## How to propose something

Open an issue and describe the scenario: who is doing what, and what stops
them today. See [CONTRIBUTING.md](CONTRIBUTING.md).
