# Changelog

Notable changes to Folio. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
