# Folio features

What Folio does today. Everything listed here works in the code; the limits
and exceptions are collected in [LIMITATIONS.md](LIMITATIONS.md).

## 1. The idea

Folio is a wiki whose **source of truth is a Git repository**, not a database.
Each space is a separate Git repository or a folder inside one. A page is a
file:

| Page kind | File | Editable |
|---|---|---|
| Document | `*.md` | yes, together |
| Whiteboard | `*.excalidraw.svg` | yes, together |
| Data table | `*.table.md` | yes, together |
| Form | `*.form.md` | yes |
| PDF | `*.pdf` | no, view only |
| Office | `*.docx`, `*.xlsx`, `*.pptx` | no, view only |

PostgreSQL stores the index, access rights, the activity history and the state
of collaborative editing — but not the content itself. Any page can be read
and changed directly in Git, and Folio picks the change up.

The title of a document is its **first `#` heading**, not the file name. PDF
and Office files are the exception: their title is the file name with the
extension.

## 2. Editor

Three modes, switched at the top right:

- **Reading** — the default when any link is opened;
- **Live edit** — editing with the markup rendered as you type;
- **Source** — plain Markdown.

A reader without edit rights sees Reading only.

**What can be inserted** (with `/` or the toolbar): headings, lists (bulleted,
numbered, checklist), a table, a code block, a **Mermaid diagram** (with a
visual editor), an image, a link, a quote, **callouts** (`> [!NOTE]`, `tip`,
`important`, `warning`), a collapsible details block, emoji, a divider, and
`::pagetree` — a live tree of child pages right in the text.

Also in the editor: pasting from Excel and Google Docs keeps tables and
formatting; `[[` picks a page (an ordinary relative link is written to disk,
not a private dialect); `@` mentions a person; an outline panel on the right;
a page cover and icon; image attachments.

A link to a Folio page is shown in Reading mode as the **page title**, not as
a URL.

## 3. Working together

Real-time collaborative editing (Yjs) works for **documents, tables and
whiteboards**: changes appear in every open tab at once, and you see who else
is present.

Authorship reaches the Git commit: the history shows who changed the page.

## 4. Offline mode

Folio keeps working when the connection does not.

- **Documents and whiteboards you have opened on the device stay editable**
  without a connection.
- **A page or a whiteboard can be created offline.** It appears in the tree at
  once, marked as not yet synchronized, and opens and edits like any other.
- **Everything is kept on the device** — in the browser's storage — and
  **reaches the server by itself** when the connection returns: at the same
  address, with the same content, without duplicates.
- **Edits made offline are not lost** if you go to another page or close the
  tab: they are sent even if that page is never opened again.
- **An indicator in the header**: "Offline", "Weak connection", "Not synced:
  N", "Syncing…". While everything is fine it is not shown. A click opens the
  list of what is waiting and a "Sync now" button.
- If the server refuses to create the page (no rights, the space was deleted),
  the page stays on the device with the reason and a "Retry" button.
- The editor for whiteboards is fetched ahead of time, a few seconds after
  Folio opens, so a board can be created offline even if none was opened
  before.

Need a connection: data tables, forms, file uploads, templates, and a page
that was never opened on this device. Folio itself is loaded from the server,
so a browser closed without a connection cannot open it again until the
connection is back.

## 5. Git

- A space can be created empty, **cloned from a remote repository**, or
  connected to a repository later. Several spaces can live in one repository
  in different folders.
- Edits are written to disk immediately, and **the commit is made after about
  90 seconds of quiet** in the space. Right after saving, the history may
  still be empty.
- The synchronization state is visible in the interface: local, clean,
  syncing, ahead, behind, conflict, error — with the number of commits and who
  synchronized last.
- **Conflicts** are listed for the whole space.
- **"Take the version from Git"** — one button that brings the space into
  exact agreement with the remote branch. It is destructive by design (local
  changes are discarded), but the state is first saved into a backup branch
  `folio-backup/<timestamp>`, so it can be rolled back.
- **Page history**: the list of commits and a view of any revision.
- Separately from Git there is **undo for structural actions** (create, copy,
  rename, move, delete) — your own only, and only if nothing has changed
  since.

## 6. Access

- **Roles in a space**: `admin`, `editor`, `viewer`.
- **Space visibility**: `private` (explicit members only) or `instance` (any
  active user may view).
- **Rights on a single page** can be narrower than the role in the space.
- **The instance administrator does not see the content of spaces** they are
  not a member of: they manage users and invitations, but the pages are closed
  to them. They can grant access to themselves — and that is written to the
  audit log and shown with a mark.
- **Invitations** — links with preset roles, an expiry date and a usage limit.
  A signed-in person can accept one with the current account, or sign out to
  use another account.
- **Access requests**: a user who runs into a 403 sends a request; the space
  administrators are notified and decide.

## 7. Sharing outside

A link to a page for people without an account: view or edit, optionally
"with child pages". There is also a `.md` form of the link that returns plain
Markdown — convenient for external agents.

"With child pages" never includes a page that has its own access
restrictions, nor anything below it: such a page is shared only by a link
made for that page itself. This is checked on every visit, so restricting a
page later also removes it from links that already exist. Of the space's
files, a guest gets only those of the pages the link covers and the images
and attachments those pages embed or link to. A link is a credential, so
links are listed, created and revoked only in the browser, never with an API
token.

Edits made by a guest through such a link reach Git with the matching
authorship.

## 8. Search and navigation

- **Full-text search** across documents and tables.
- **Cmd+K** — quick switch between pages.
- The space switcher has search and scrolls long lists inside its menu.
- Recent pages, favorites (a star on a space and on a page), **backlinks**.
- A **tree** with drag and drop, a templates folder for creating "from a
  template", and the `.agent` folder (see section 11). The tree updates by
  itself.
- A **welcome wizard** for someone with no space yet: choose a document, a
  whiteboard or a data table to start with, read a short overview of Folio and
  of the assistant, and the first space is created with that page open. The
  same tour is in the account menu ("Welcome tour") at any time; with spaces
  already there it creates the page in the one you were last in.
- **Duplicate** and **Copy to…** in the page menu. Duplicate puts a copy
  next to the original, child pages included; Copy to… puts it under any
  page of any space you can edit, with or without the child pages. Every
  copied page gets an identity of its own. A copy takes only what you can
  open: a page with access restrictions that hide it from you is left out
  together with everything below it and the files only such pages use, and the
  `.agent` folder is never copied for someone who is not an administrator.
  The copy of a page that has its own access rules is private to the person
  who made it.

## 9. Data tables

A table is a small database inside the wiki.

Markdown tables inside documents have narrow, medium and full-viewport width
modes. Narrow and full-width tables can be resized from their highlighted
right edge; a table wider than the viewport scrolls horizontally inside its
own container.

- **Column types**: text, long text, number, date, checkbox, select, status,
  user, link.
- **Views** — tabs with their own set and order of columns, widths, sorting by
  several columns, a filter tree (`and`/`or`) and pinned columns.
- **Filters** including "me", "today", "this week", "last N days".
- **Limits**: 20,000 rows, 80 columns, 50,000 characters in a cell, 500 options
  in a list, 50 views. A table above the row limit **opens read-only** instead
  of breaking.

## 10. Forms

A small counterpart of Google Forms that writes answers into a data table. A
form and a table are linked one to one: a form field is a table column.

A form can be made public, so that people answer without an account. That
needs **both** the "public" flag **and** a valid share link to the form.
Anonymous answers are rate-limited.

## 11. Folio AI

An assistant in the side panel with two modes: **Ask** (read only) and
**Agent** (read and write). Each person adds a Cursor API key in their account
settings, or the operator sets a shared one.

The assistant uses **the same set of tools** as external clients do through
MCP (section 12). In Ask mode the write tools are unavailable, and that is
checked on the server, not only in the interface.

**Your own agent in every space — `.agent`.** A folder of ordinary pages in
the space, visible to and editable by space administrators only. Everything in
it — the agent's role, tone, glossary, rules, templates — is added to every
assistant run in that space, in Ask and Agent modes alike. Each space can
therefore have an agent of its own, and its instructions are versioned in Git
like any other page. About 60,000 characters of instructions are used; if
there is more, whole pages at the end are left out and the assistant is told
so.

**Answer quality and analytics.** Every saved assistant answer can be rated
👍 or 👎 (one rating per answer, changeable). After every third answer in a
conversation the panel asks "Did the assistant solve your question?" (Yes,
Partly, No, Not now, with an optional comment). The assistant also records
questions it could not answer or was unsure about, with the reason ("No
answer" or "Not sure") and what was missing; it does this through a built-in
tool that never changes any data, in Ask and Agent modes alike. Instance
administrators see the results at `/admin/assistant` ("Assistant analytics" in
the account menu): a **Conversations** tab with ratings and survey counts per
conversation, and a **Questions without an answer** tab (the person's own
question first, the assistant's wording second), both filtered by space, user
and date, with space names rather than slugs. A space administrator sees the
same page limited to the spaces they administer, and only the messages of runs
in those spaces. An administrator can open a conversation; opening one is
recorded in the audit log, and the conversation page shows who opened it and
when. Everyone else does not see the page, and a personal access token is
refused there.

**Bring your own subscription.** The assistant runs on a subscription you
already have. Cursor is supported today; other providers are coming soon.

Runs live **on the server**, not in the browser tab: close the browser and the
work continues; come back and read on from where it stopped.

## 12. Integration for external tools (MCP)

The `/mcp` endpoint with a personal access token (`folio_pat_…`), scopes
`read` and `write`. 21 tools: listing spaces and trees, reading a page,
search, creating and updating pages, resolving a Folio link, backlinks,
history and reading a page at a given commit, working with whiteboards, and a
full set of operations on data tables. See [MCP.md](MCP.md).

## 13. Import, export and the rest

- **Import from Confluence**: a page or a tree, converting panels into
  callouts, code, checkboxes and images; Confluence **whiteboards** become
  Excalidraw boards.
- **File upload**: images, and also pdf/docx/xlsx/pptx — they become pages in
  the tree.
- **Export**: `md`, `pdf`, `docx`, `yaml`, print, and a zip of the whole
  space. Export with child pages and custom page headers and footers for a
  space are supported. If an export had to be cut by size, the response
  headers say so.
- **Trash** with restore. Deleting a page that has children takes them along,
  and restoring brings them back.
- **Notifications** about access requests, delivered instantly.
- **Interface languages**: English and Ukrainian; a new language is a set
  of bundle files. Content is not translated — it is data.
- **Theme**: light, dark, system.
- **Mobile**: responsive layout, a separate mobile mode for tables. There is
  no separate app.
