# Limitations

Deliberate limits and known gaps, so that you do not spend time looking for
what is not there.

## Platform

- **PostgreSQL and Redis are required.** Page content lives in Git, but the
  index, access rights and collaborative-editing state live in PostgreSQL.
- **No serverless hosting.** Folio needs a long-running process, a persistent
  disk and WebSocket connections.
- **No user groups, no SSO/SCIM, no end-to-end encryption of content.**
  Sign-in is by email and password, optionally with Google.
- **The built-in AI assistant needs a Cursor subscription** and sends the
  pages it works with to that service. Other providers are not supported yet.
  Without a subscription the rest of Folio works normally.
- **One agent per space.** `.agent` customizes the assistant for a space; a
  space cannot have several differently configured agents.

## Content

1. **File names are Latin only**: the slug is `^[a-z0-9][a-z0-9-]*$`. A page
   title in any script is fine; the file cannot be renamed that way.
2. **A reader sees a whiteboard as a static picture** — the Excalidraw editor
   is not enabled for them.
3. **PDF and Office files are not editable and not searchable by content** —
   by title only.
4. **Page rights are not inherited by child pages**: restricting a parent
   leaves its children open. There is no "close the whole subtree" mode.
   An image or attachment stored in the repository is protected through the
   pages that link to it: it is hidden from a member only while every page
   linking to it is closed to them, and a file no page links to is open to
   every member of the space.
5. **Moving a page does not rewrite relative links** in its text.
6. **Search has no stemming** — a compromise for several languages at once:
   different forms of a word are different words.
7. **Front matter keeps only Folio's own keys** — `id`, `order`, `status`,
   `icon`, `cover`. Other keys written by hand are dropped the first time
   Folio rewrites the page: an edit, or the scan that assigns it an `id`.

## Git

8. **A remote repository can be connected only if it is empty** — otherwise
   the request is refused, with no silent merging of histories. To start from
   an existing repository, create the space by cloning it.
9. **History does not appear instantly** — the commit is made after about 90
   seconds of quiet. An immediate commit is available through the
   synchronization action.

## Agents

10. **Through MCP you cannot**: create an `index.md` for a folder, manage
    access rights, rename or delete a space. Those actions go through the
    interface only.

## Import

11. **Confluence import does not support every macro.** Pages, images,
    callouts, code, checkboxes and whiteboards are converted; other macros
    may be simplified or lost. Run a test import before moving a whole space.

## Offline

12. **Offline mode covers documents and whiteboards** that were opened on the
    device before. Data tables, forms, file uploads and templates need a
    connection, and so does opening Folio itself in a fresh browser session.

## Known defects

13. **Emptying the trash** may leave a folder with nested pages inside the
    service trash folder.
