# Changelog

Notable changes to Folio. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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

### Fixed

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

### Changed

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
