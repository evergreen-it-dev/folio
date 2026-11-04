---
name: Folio MCP
description: Read and change Folio spaces, pages, boards, data tables, forms, bases, artifacts, properties and tags through the in-process MCP tools, with the current user's rights.
version: "1.0.0"
tags: [folio, mcp, tables, boards, forms, bases, artifacts]
---

# The internal Folio MCP

Use this skill for any work with Folio spaces, pages, boards, data tables,
forms and bases. These are the same tools that are registered in `server/mcp.ts`
(`buildFolioMcpServer`) and available through the public `/mcp` with a PAT
token — the built-in chat gets them in-process, with the rights and the
audit of the current user of the session, without a separate token.

## The order of work

1. Find the entity: `search_pages` or `list_tree` — do not guess the `id` of
   a page.
2. Read it: `read_page` (a document/board) or `folio_table_schema` +
   `folio_table_query` (a table) — before any edit.
3. Change as little as possible: a pinpoint edit, not a rewrite of the whole
   body from scratch, unless exactly that was asked for.
4. Re-read after the write and only then confirm the success to the user.

## MCP tools for reading

| Tool | Purpose |
|---|---|
| `resolve_folio_url` | A Folio link (`/s/<space>`, `/s/<space>/p/<id>`, `/s/<space>/d/<dir>`) → a particular page (`id`, `path`, `parentPathForChildren`). `/s/<space>` without `/p/` = the home page of the space (`index.md`), NOT "the whole space". Call it first if the message contains a link |
| `list_spaces` | The spaces available to the user: slug, name, number of pages, role |
| `list_tree` | The full page tree of one space: id, title, kind, path, order |
| `read_page` | One page by `id`: metadata + the full markdown body (doc), the scene (board), the definition and `etag` (form), the YAML (base), a readable outline (Obsidian canvas), `artifact` (manifest, file list) + `entryHtml` (the entry page's HTML, cut at 60 000 characters, `entryTruncated`) for an artifact; for a table — a note to use `folio_table_schema` |
| `search_pages` | Full-text search, optionally within one space |
| `get_backlinks` | The links into the given page: the source page plus the line with the link (`context`) |
| `get_page_metadata` | One page's outline (headings with anchors), `^block` ids, tags, properties (front matter) and outgoing links with their kind (page / asset / external / unresolved) |
| `list_unresolved_links` | Links in a space that point at no existing page (`limit`/`offset`, sorted by target) |
| `list_orphans` | Pages of a space nothing links to |
| `get_graph` | The link graph of a space, or of one page's neighbourhood (`page`, `depth` 1–3, `direction`): nodes with their degree and edges; optional tag, file and unresolved nodes. For "what is connected to X", hub pages, clusters |
| `query_base` | The rows of a base page (an Obsidian `.base` file: a saved query over the pages of a space): values by column, groups, summaries; `view`, `limit`, `offset`. Read its YAML with `read_page` |
| `list_tags` | The tag tree of a space (`a/b` under `a`) with page counts (`pages` exact, `total` with children); `prefix`, `limit`. Counts only pages the user can open |
| `list_templates` | The templates of a space (the pages of `_templates/`, which `list_tree` and `search_pages` never show): id, path, title, kind, description. Empty when the space has none |
| `list_properties` | The property (front matter) keys used in a space: type (declared or inferred), number of pages, a few sample values. Look here before setting a property or writing a base filter |
| `check_page_writing_rules` | The space's writing rules (`.agent/writing-rules.md`) plus the text of one page (`page`): `hasRules`, `rules.markdown`, `page.markdown`. Judge the page against each rule; per violation give the rule, the exact fragment and a rewrite. Reads only |
| `page_history` | The git commit history of a page: sha/author/date/message |
| `page_at_sha` | The content of a page at the given commit (a sha from `page_history`) |
| `folio_table_list` | The data tables of one space or of all available ones |
| `folio_table_schema` | The real columns, their types/options, the views (id, name, filter, sort), the number of rows |
| `folio_table_query` | The rows of a table with a filter/sort/search/limit |

## Built-in assistant tool (not an MCP tool; ASK and AGENT)

| Tool | Purpose |
|---|---|
| `report_unanswered_question` | Report a question the pages could not answer or that you answered without confidence: `question` (restated), `reason` (`no_answer` / `low_confidence`), optional `missing` (short; Markdown links `[title](/s/<space>/p/<id>)` to the related pages you read in this run, never invented). Once per question, at most 3 per run; then still answer the user. It is for the documentation owners — do not mention it to the user |

## MCP tools for writing (AGENT mode only)

| Tool | Purpose |
|---|---|
| `board_ops` | Align/distribute/move/automatically lay out the elements of an EXISTING board by their ids (from `read_page`), keeping labels and arrows — for "make it tidy", "align it" |
| `create_page` | Create a page (`doc` by default, or `kind: 'table'` with a starting schema of columns) |
| `update_page` | Replace the markdown body of a document (NOT for `board`/`table`) |
| `create_page_from_template` | Copy a template (`templateId` from `list_templates`, any kind, its subpages along) under `parentPath` of `space`, optional `title`; `{{date}}`, `{{author}}`, `{{title}}` in its documents are filled in. Returns the new page and its `url` |
| `save_page_as_template` | Copy an existing page (`id`) into `_templates/` so it can be reused; optional `title`, `description`, `includeChildren` (default true). The original stays. Returns the template and its `id` |
| `create_template` | A new document template in `_templates/` (`space`, `title`, optional `description`, `markdown` with `{{date}}`/`{{author}}`/`{{title}}`). To make a template of an existing page use `save_page_as_template` |
| `create_board` | Create an Excalidraw board from the `sketch` DSL (or a full `scene`) — see the `folio-boards` skill |
| `update_board` | Overwrite the scene of an existing board — `sketch` or `scene` |
| `folio_table_create` | Create a data table with an explicit schema of columns |
| `folio_table_add_column` | Add a column (the type, the options for select/status; a status column without options gets the status preset) |
| `folio_table_update_column` | Change a column: rename, type (values are converted, the answer counts what was cleared), hint, options (the whole list), … |
| `folio_table_delete_column` | Delete a column and its values. Ask first |
| `folio_table_save_view` | Create a view (tab) of a table — `name`, `filter`, `sort`, `hiddenColumns`, `columnOrder` — or change one (`viewId`) |
| `folio_table_delete_view` | Delete a view (not the last one) |
| `create_form` | Create a form: `title`, `fields` (label, type, required, help, options); a new paired table is created, or `table` = an existing table id. See the `folio-forms` skill |
| `update_form` | Change a form: settings and/or the whole ordered `fields` list (keep `columnId` of the fields that stay); `etag` from `read_page` |
| `convert_canvas_to_board` | Make a new editable board from an Obsidian canvas (the canvas stays as it is) |
| `folio_table_insert` | Add rows |
| `folio_table_update` | Change values in cells — by `rowId` or by a filter (then `limit` is mandatory) |
| `folio_table_delete` | Delete rows by `rowId` |
| `rename_tag` | Rename a tag across a space (`from`, `to`): `#tag` in bodies, `tags:`/`labels:` in front matter, tags of tables/boards/files; children follow; pages the user cannot edit are skipped and counted. One commit. Ask first: it touches many pages |
| `set_page_properties` | Set a page's properties (front matter) for any page kind. `properties` is the whole map by default (omitted keys are removed); with `merge: true` only the given keys change and `null` removes one — prefer `merge: true` to set one key. Optional `etag` from a previous call; a conflict error carries the current etag |
| `publish_artifact` | Publish an interactive page (kind `artifact`): a new one under `parentPath` of `space`, or replace one by `id` with the WHOLE new content. ONE self-contained HTML in `html` (data inlined, scripts only from the CDN allowlist), or `text` (`svg`/`markdown`/`mermaid`), `files`, `sourceCode`. No `url`/`embedCode` in this chat. Rules and example: the `folio-artifacts` skill |
| `save_base` | Create a `.base` (`path`, e.g. `views/tasks.base`) or replace one (`id`, optional `etag`) from whole `yaml`; invalid YAML comes back with a line number; returns `id`, `path`, `etag` and a preview of the first view. Syntax and an example: the `folio-bases` skill |

## What you can build (AGENT mode)

| Page kind | Create | Change |
|---|---|---|
| Document | `create_page` | `update_page`, `set_page_properties` |
| Board | `create_board`, `convert_canvas_to_board` | `update_board`, `board_ops` |
| Data table | `folio_table_create` (or `create_page` `kind: 'table'`) | rows: `folio_table_insert`/`update`/`delete`; columns: `folio_table_add_column`/`update_column`/`delete_column`; views: `folio_table_save_view`/`delete_view` |
| Form | `create_form` | `update_form`; its answers are rows of the paired table |
| Base | `save_base` (`path`) | `save_base` (`id`); values: `set_page_properties` on the row's page |
| Artifact (interactive HTML page) | `publish_artifact` | `publish_artifact` with its `id` (replaced whole), `set_page_properties` |
| Page from a template | `create_page_from_template` | then `update_page` to fill it |
| Template | `create_template`, `save_page_as_template` | — |
| Any page | — | `set_page_properties` (properties), `rename_tag` (a tag across the space) |

An Obsidian canvas is read-only (`read_page` gives its outline); offer
`convert_canvas_to_board` when the user wants to edit it. PDF and Office files
are uploaded by the user in the web app. Renaming, moving and deleting pages
are done by the user in the web app (no tool for them).

## Artifacts

An artifact (`kind: "artifact"`) is an interactive page — a dashboard, a
calculator, a filterable report — shown in a sandboxed frame. Markdown pages
cannot hold scripts, so when the user wants something interactive, build an
artifact with `publish_artifact` (the `folio-artifacts` skill has the rules:
one self-contained HTML, data inlined, libraries only from the CDN allowlist).
`read_page` on an artifact returns its manifest, file list and entry HTML, not
markdown; `update_page` does not work for it — replace it with
`publish_artifact` and its `id`. An artifact an external agent published (a
Claude artifact, a Cursor canvas) can be read the same way.

## Templates

A template is a page under the space's `_templates/` folder; `list_tree` and
`search_pages` never show them, `list_templates` does.

- The user asks for a page "by a template" / "like our template" / "the
  usual meeting notes": first `list_templates` for that space. If one fits
  (by title and description), `create_page_from_template` (under the
  current page or the `parentPath` they named), then fill it with
  `update_page` — read the copy first, keep its structure and only replace
  what is placeholder. No fitting template: say so and offer a plain
  `create_page`; do not invent a template.
- The user wants a page to be reusable ("make this a template"):
  `save_page_as_template` with its `id` (the original stays), and a one-line
  `description`. A brand-new template from scratch: `create_template`.
- Never put anything into `_templates/` with `create_page` — it refuses that
  folder.

## Important pitfalls (from `docs/AGENT-API.md`, checked against the code)

- **`create_page` takes ready text only for a document.** An optional
  `markdown` (only for `kind: 'doc'`, the default) is written right after the
  page is created; for `kind: 'table'` the text is ignored and an optional
  `columns` sets the starting schema. A page without `markdown` gets only the
  title as an `# H1`. The title of a page is the first `# H1` of its text:
  if your `markdown` does not open with one, the server puts `# <title>`
  above it; if it does, that heading is kept and becomes the page title (the
  `title` argument then only names the file) — check `title` in the reply.
  To change the text of an existing page, call `update_page`.
- **`update_page` works for documents only.** For a table — only
  `folio_table_*`; a board — `update_board`/`board_ops`; a form —
  `update_form`; a base — `save_base`; an artifact — `publish_artifact`
  with its `id`.
- **A form's fields are columns of its paired table.** `update_form` takes
  the WHOLE ordered list of fields: keep the `columnId` of every field that
  stays (from `read_page`), leave it out only for a new question. A field
  dropped from the list leaves its column and answers in the table.
- **The git commit is delayed** by about 90 seconds of silence in the
  space: right after a write `page_history` can look empty — that is
  expected.
- **Before changing a table always call `folio_table_schema` first.** The
  ids of columns, the types and the allowed values of `select`/`status`
  cannot be guessed reliably from the name of a column or from earlier
  experience with a "similar" table.
- **A bulk update of a table by a filter requires `limit`** — it is a
  deliberate safeguard against an unlimited group edit; `folio_table_update`
  without `rowId` and without `limit` with a filter returns an error.
- The title of a page is the first H1 of the body, not a separate field: to
  rename a page, change the H1 through `update_page`, do not look for a
  separate "title" parameter in the write.
- The frontmatter (`id`, `slug`, `order`, `icon`, `cover`, `labels`,
  `status`) is serialized by the server itself; the agent does not write it
  into the markdown by hand (see the `folio-content` skill).

## Default scope

Unless the user said otherwise, work within the page that is open now, from
the `Current context` section of the request: read and change exactly it (its `id`),
and create new things as its children (`parentPath` from the same place, the
same `space`).

The exception is search: "find", "look for", "where is…" without an explicit
address means searching everywhere the user can reach, not only in the
current space. Call `search_pages` WITHOUT `space` (it goes through all the
visible spaces at once) instead of going through the spaces by hand with
`list_spaces`.

## Rules for writing

- Write only after a direct request of the user in the current message.
- Before a write, read the current page/schema and check its `id`/structure.
- Do not make up mandatory values (for example, which columns or options
  exactly are needed) — ask the user when the choice matters.
- After a write, check the result with a reading tool and only then report
  the success.
- `isError`/an error message from a tool means that the change is not
  confirmed — tell the user exactly that, do not imitate success.
- Do not try to change access rights, tokens, users or the settings of a
  space — those routes are cookie-only and outside this MCP.
- After creating or changing a page, a board or a table ALWAYS end the
  answer with a link the user can follow:
  `[<title>](/s/<space>/p/<id>)` — take `space` and `id` from the answer of
  the tool (`space`, `id`), do not invent them. For several created pages —
  a list of links.

## Ask mode

In `ASK` only reading is available. If the user asks to change something,
explain that the chat has to be switched to `Agent`; do not call the writing
tools and do not imitate an action that was not performed.
