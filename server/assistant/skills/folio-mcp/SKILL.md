---
name: Folio MCP
description: Read and change Folio spaces, pages, boards and data tables through the in-process MCP tools, with the current user's rights.
version: "1.0.0"
tags: [folio, mcp, tables, boards]
---

# The internal Folio MCP

Use this skill for any work with Folio spaces, pages, boards and data
tables. These are the same tools that are registered in `server/mcp.ts`
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
| `read_page` | One page by `id`: metadata + the full markdown body (doc) or the scene (board) |
| `search_pages` | Full-text search, optionally within one space |
| `get_backlinks` | The pages that link to the given one |
| `page_history` | The git commit history of a page: sha/author/date/message |
| `page_at_sha` | The content of a page at the given commit (a sha from `page_history`) |
| `folio_table_list` | The data tables of one space or of all available ones |
| `folio_table_schema` | The real columns, their types/options, the views, the number of rows |
| `folio_table_query` | The rows of a table with a filter/sort/search/limit |

## MCP tools for writing (AGENT mode only)

| Tool | Purpose |
|---|---|
| `board_ops` | Align/distribute/move/automatically lay out the elements of an EXISTING board by their ids (from `read_page`), keeping labels and arrows — for "make it tidy", "align it" |
| `create_page` | Create a page (`doc` by default, or `kind: 'table'` with a starting schema of columns) |
| `update_page` | Replace the markdown body of a document (NOT for `board`/`table`) |
| `create_board` | Create an Excalidraw board from the `sketch` DSL (or a full `scene`) — see the `folio-boards` skill |
| `update_board` | Overwrite the scene of an existing board — `sketch` or `scene` |
| `folio_table_create` | Create a data table with an explicit schema of columns |
| `folio_table_add_column` | Add a column (the type, the options for select/status) |
| `folio_table_insert` | Add rows |
| `folio_table_update` | Change values in cells — by `rowId` or by a filter (then `limit` is mandatory) |
| `folio_table_delete` | Delete rows by `rowId` |

## Important pitfalls (from `docs/AGENT-API.md`, checked against the code)

- **`create_page` takes ready text only for a document.** An optional
  `markdown` (only for `kind: 'doc'`, the default) is written right after the
  page is created; for `kind: 'table'` the text is ignored and an optional
  `columns` sets the starting schema. A page without `markdown` gets only the
  title as an `# H1`. To change the text of an existing page, call
  `update_page`.
- **`update_page` does not work for tables and boards.** For a table — only
  `folio_table_*`. For a board — only `update_board`.
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
`.folio/runtime/current-context.md`: read and change exactly it (its `id`),
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
