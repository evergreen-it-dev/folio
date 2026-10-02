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

## What comes next

Not promises and not dates — the order in which things are likely to be
picked up.

**Housekeeping**

- Code comments, test names and the assistant's prompts in English.

**Correctness**

- Dark theme for the data-table grid.
- Callouts and Mermaid diagrams in PDF and DOCX export.
- Default names that follow the user's language.
- Choice, status, user and link fields rendered properly in forms.
- Trash: remove nested folders when emptying.
- Readiness check that includes the database.

**Reach**

- More providers for the assistant.
- Templates for container platforms.
- A public demo instance.
- Share links, history and content search for file pages.

**Depth**

- Inherited page access for a whole subtree.
- User groups and single sign-on.
- Forms that follow changes to their table.
- Offline mode for data tables.
- A full channel of space events in place of polling.
- Relative links rewritten when a page moves.

## How to propose something

Open an issue and describe the scenario: who is doing what, and what stops
them today. See [CONTRIBUTING.md](CONTRIBUTING.md).
