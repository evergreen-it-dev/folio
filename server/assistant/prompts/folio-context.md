# Folio context for the agent

Live data always matters more than this description and is read through the
tools of the `folio-mcp` skill. This file is only a map of entities, to find
your way around without guessing the structure once more.

## Space

A space is a separate git repository: a top-level node, roughly like a
"project" or a "department". It has a slug (the part of the URL), a name, a
number of pages and the role of the current user in it (`viewer` / `editor`
/ `admin`).

The page tree of a space maps onto the file structure of the git mirror one
to one: a directory is a parent page with an `index.md`, child pages are
files or subdirectories next to it. `index.md` is both the directory page
and, in effect, the "table of contents" of the section.

## Page

Every page has:

- `id` — a stable identifier; all tools (`read_page`, `update_page`, ...)
  address a page by it, not by the title or the path;
- `space` — the slug of the space;
- `path` — the path in the tree of the space;
- `kind` — the kind of the page:
  - `doc` — a markdown document (the most frequent kind);
  - `board` — an Excalidraw board (`read_page` returns an `svg` for it
    through the public REST/MCP, and for the agent a structured `scene`, the
    elements of the scene, instead of an SVG string; see the `folio-boards`
    skill);
  - `table` — a data table (a separate format, its own set of
    `folio_table_*` tools; see the `folio-tables` skill);
- `title` — **not a separate field that can be written freely**: it is the
  first H1 of the body of the document. Renaming a page is an edit of the
  H1, not of a separate title;
- the order among siblings and the emoji icon/cover are service fields of
  the frontmatter (`order`, `icon`, `cover`); the server manages them itself,
  the agent does not write them by hand.

## Access rights

- The base role is set by the space: `viewer` (reading), `editor` (writing),
  `admin`.
- The page-level ACL can only **narrow** access to a particular page
  relative to the space (the `restricted` mode) — not widen it. A
  restriction is not inherited automatically by child pages.
- The tools of the agent inherit exactly the role and the scope of the
  current user: a refusal means that the user does not see or edit this
  page right now either — do not try to work around it with another tool.
- Public share links (`/share/<token>.md`) are a separate explicit channel
  of access outside the ordinary role; the agent does not create them
  itself unless the user directly asked.

## Git and the delayed commit

- An ordinary write (through `update_page`, `folio_table_*`) changes the
  file at once, but the git commit is published about **90 seconds of
  silence later** in the space. So `page_history` right after an edit can
  look as if nothing changed — that is expected, not an error.
- History (`page_history`, `page_at_sha`) reads exactly the git commit
  history of the page: sha, author, date, message.

## Data tables (kind: table)

A separate kind of page next to the document and the board: a grid with a
schema of columns (types, hints, lists of values for select/status), rows
and tab views (filter/sort/hidden columns), stored as one `.table.md` file
in git. The detailed contract is in the `folio-tables` skill; before any
write into a table always read its real schema first.

## Boards (kind: board)

An Excalidraw board is a page in the tree too, like a document. It is
created and edited through `create_board`/`update_board` with the compact
`sketch` DSL (nodes/arrows) or, for a pinpoint edit of an already existing
scene, with the full `scene`. The detailed contract is in the `folio-boards`
skill.
