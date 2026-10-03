# Changelog

Notable changes to Folio. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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

### Fixed

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

### Changed

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

### Security

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
