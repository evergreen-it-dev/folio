# Limitations

Deliberate limits and known gaps, so that you do not spend time looking for
what is not there.

## Platform

- **PostgreSQL and Redis are required.** Page content lives in Git, but the
  index, access rights and collaborative-editing state live in PostgreSQL.
- **No serverless hosting.** Folio needs a long-running process, a persistent
  disk and WebSocket connections.
- **No end-to-end encryption of content, and no LDAP.** Sign-in is by email and
  password, or single sign-on through any OpenID Connect provider (Keycloak,
  Authentik, Entra ID, Okta, Google) or SAML 2.0 IdP. User groups can be
  managed by hand, synced from the identity provider's groups claim / attribute
  at sign-in (not continuously: a change reaches Folio at the person's next
  sign-in, and Entra ID's "too many groups" overage is not resolved through
  Graph), or provisioned over SCIM. No nested groups and no group @mentions.
- **SCIM 2.0: the subset identity providers use.** Users and groups with
  `eq` / `and` filters and paging; no bulk operations, sorting, ETags or
  passwords. DELETE deactivates an account and archives a group, never deletes.
  A provisioned person is recognized at first sign-in by the provider's id or by
  the SCIM email, never by other means; accounts are not created at first
  sign-in while SCIM is on.
- **SAML: SP-initiated sign-in with signed assertions only.** Encrypted
  assertions, signed sign-in requests and single logout are not supported;
  IdP-initiated sign-in is off unless an administrator turns it on. SAML has no
  "email verified" flag, so existing accounts are linked only when the IdP is
  marked authoritative for the allowed domains.
- **The built-in AI assistant needs a Cursor subscription** and sends the
  pages it works with to that service. The key can be a person's own, or one an
  administrator provides for a space or for the whole instance. Other providers
  are not supported yet. Without a key the rest of Folio works normally.
- **The public demo is shared and resets daily.** It is at
  <https://demo.foliowiki.online>: one login for everyone, data reset every
  24 hours. Tokens, Git and import, share links, invitations and the AI
  assistant are turned off there. The Folio Handbook is published on the demo as
  a website (<https://demo.foliowiki.online/public/folio-handbook>) and its
  administrator can try "Publish as website" on it, without a subdomain or a
  custom domain; everything resets daily. Don't enter personal data or API keys. The
  demo uses the optional analytics hook: anonymous events (page kinds, space
  slugs), never page content; your own installation sends nothing.
- **The shared page timer lives in one server process.** Its state is kept in
  memory, like the live editing rooms, so a restart clears running timers, and
  several server processes would each hold their own copy. It is not shown to
  share-link guests or on public sites.
- **One agent per space.** `.agent` customizes the assistant for a space; a
  space cannot have several differently configured agents.

## Content

1. **File names are Latin only**: the slug is `^[a-z0-9][a-z0-9-]*$`. A page
   title in any script is fine; the file cannot be renamed that way.
2. **A reader sees a whiteboard as a static picture** — the Excalidraw editor
   is not enabled for them.
3. **PDF and Office files are not editable and not searchable by content** —
   by title only. **Obsidian canvases (`.canvas`) are view only**: no card can
   be added, moved or edited in Folio, and a share link or a public site shows
   the canvas read-only too. Search sees their text cards, group labels, web
   page URLs and connection labels, never the names of the files their cards
   point at. A web page card shows its URL, not the page; a PDF card a preview
   of the file; a canvas over 8 MB is not shown, and only the first 5,000 cards
   and 10,000 connections of one are. When a page a canvas points at is renamed
   or moved in Folio, the canvas's file cards (and the links in its text cards)
   follow in every space, an Obsidian vault included, the way the wikilinks of
   notes do; only the changed path strings are rewritten. A card whose file was
   moved outside Folio is not found — paths in a canvas are matched exactly,
   never by name. "Convert to Folio board" loses what a
   whiteboard cannot carry: Markdown formatting (plain text), text longer than
   its card (cut with "…"), the content of note cards (a title and a link stay),
   images over 1.5 MB (4 MB in all) and audio/video (linked cards), web page
   previews, group background images, nested groups (each becomes its own
   frame) and the curve of connections (right-angled arrows).
4. **A child page cannot be opened wider than its parent**: page restrictions
   are inherited and a child's own restriction can only narrow them. A page
   moved out from under a restricted page is open to the space again. The
   restriction of a space's root page applies to that page only (space
   membership closes a whole space).
   An image or attachment stored in the repository is protected through the
   pages that link to it: it is hidden from a member only while every page
   linking to it is closed to them, and a file no page links to is open to
   every member of the space.
5. **Only `[text](path)` links and images and Obsidian wikilinks (`[[…]]`) are
   rewritten** when a page is moved or renamed; HTML tags (`<img>`, `<a>`) and
   reference-style links (`[x]: path`) are left as they are. The page index
   does see them, so after such a move they show up among the space's
   unresolved links.
6. **Search has no stemming** — a compromise for several languages at once:
   different forms of a word are different words.
7. **Whiteboard reactions live in the board's live state, not in its file.**
   They are saved in the database with the board's real-time snapshot, not in
   the `.excalidraw.svg` file, so they are not in Git history and do not
   travel with the repository.
8. **A space over a whole repository writes an `id` into each page** — unless
   it is a light-footprint space. Without a root path, Folio adds an `id` to the
   front matter of every Markdown page that lacks one and keeps `<slug>.folio`
   in the repository root. Other tools' front matter keys are kept. A space
   bound to a folder (`docs/`) writes neither: ids stay in Folio's index. So
   does a space made from a repository that already has its own files (an
   Obsidian vault, a notes repo, a wiki: light by default when the space is
   created, unless the repository already was a Folio space) and any space
   where an administrator ticks "Light footprint". A space created earlier without it is not switched on its own.
9. **Obsidian markup is read, not written.** Wikilinks and embeds
   (`[[Note]]`, `![[image.png]]`, `![[Note#Heading]]`), `%%comments%%`, `#tags`,
   block ids (`^id`), `$formulas$` and callouts of any type are drawn in
   Reading, Live and Source and printed in PDF/DOCX, but the files are never
   rewritten to use them: the `[[` picker in the editor still inserts a plain
   relative link, and wikilinks are only ever rewritten when the page they
   point at is renamed or moved — never "while we are at it". Not supported:
   Dataview and `query` blocks, community
   plugins, an inline PDF viewer or audio/video player for `![[file.pdf]]` (a
   link to the file instead), per-type callout colours and icons (Obsidian's
   types map onto five looks), and Obsidian's rule that an unclosed `%%` hides
   the rest of the note (it stays text here). In the Live editor an image embed written as `![[image.png]]` shows as its name, not as the picture (Reading, PDF and DOCX show the picture; `![](image.png)` is a picture everywhere), and a note embed is not drawn inline while editing. Space files (attachments, `assets/`) are indexed as files, not as pages: they are
   not in the tree or in search, an attachment is found by name with Obsidian's rules
   and a missing one is listed among unresolved links. A `.base` file is a
   page (see "Obsidian Bases" below) and a `.canvas` is a view-only page (see 3). Properties are written only in Folio's own format: a Folio key
   with a foreign value is shown as such and never overwritten (`status` is not a
   Folio key in a vault: any value is an ordinary property there), and `labels:` is
   kept: new tags are written as `tags:`, an existing `labels:` is only edited in place.
   The properties of a board, a PDF or an Office file live in a sidecar under
   `.folio/`; it follows the page when the page is renamed, moved, deleted or
   restored in Folio, but not when the file is renamed or moved outside Folio (in
   git or on disk) — the sidecar then stays at the old path until it is moved by
   hand. Space files that are not pages (images and other attachments) have no
   properties.
9a. **MDX is kept, not run.** A `.mdx` page shows its components as labelled boxes
    with their Markdown body, not as the site will draw them (no component styles,
    no switchable tabs, no imported diagrams), and `{expressions}` stay text.
    `import`/`export` lines and brace comments on their own line are hidden in
    Reading. A component is recognised by a line starting with a capitalised tag up
    to its closing tag; inline JSX, text after a closing tag on the same line and an
    unclosed component stay plain paragraph text, and lower-case HTML is Markdown's
    own. Search and backlinks see imports and tags as ordinary page text. `.markdown`
    files are still skipped (the scan logs how many).

## Git

10. **A remote repository can be connected only if it is empty** — otherwise
   the request is refused, with no silent merging of histories. To start from
   an existing repository, create the space by cloning it.
11. **History does not appear instantly** — the commit is made after about 90
   seconds of quiet. An immediate commit is available through the
   synchronization action.

## Agents

12. **Through MCP you cannot**: create an `index.md` for a folder, manage
    access rights, rename or delete a space. Those actions go through the
    interface only.

## Import

13. **Confluence import does not support every macro.** Pages, images,
    callouts, code, checkboxes and whiteboards are converted; other macros
    may be simplified or lost. Run a test import before moving a whole space.

## Offline

14. **Offline mode covers documents and whiteboards** that were opened on the
    device before. Data tables, forms, file uploads and templates need a
    connection, and so does opening Folio itself in a fresh browser session.

## Public sites

A space set to public is readable by anyone, without an account
([how it works](FEATURES.md#publish-a-space-as-a-website), [setup](INSTALL.md#public-sites)).

15. **Site appearance has limits.** The PDF settings cannot be previewed
    before they are saved: "Test PDF" saves the tab first, and a save is a
    commit in the repository. The sanitizer for `.folio/site.css` removes
    `@import` and every `url()` that is not a `data:` image or font or a file in
    `.folio/assets/`, so external fonts and images do not load: put the files in
    `.folio/assets/` (up to 1 MB a file, 5 MB in total). `site.css` is CSS only:
    no JavaScript, and analytics or other third-party snippets are not allowed.
    A page's own SEO fields (`description`, `image`, `unlisted`) are front matter
    keys edited by hand. The site answers on every address it has and only
    declares the primary one as canonical; it does not redirect the others. The
    footer "Powered by Folio" cannot be changed. To keep a page out of search
    engines, set `unlisted: true` in its front matter (it stays readable to
    anyone with the link), switch indexing off for the site, or restrict the
    page; the public demo is never indexed.
16. **Rate limits are counted per server process.** The limits on downloads
    (`PUBLIC_EXPORT_PER_MINUTE`) and on questions to Folio AI, and the cache
    that maps hosts to sites, live in the memory of the process: a restart
    resets them, and a second process would count on its own. Public search and
    the other read routes have no per-address limit at all; a site that
    attracts traffic you do not control needs a rate limit in the reverse proxy
    or a CDN in front of it.
17. **Folio AI on a public site needs a key of the space or of the instance**
    (or `CURSOR_API_KEY`). Visitors have no key of their own, and whoever owns
    the key pays for their questions. Runs are Ask mode only. The space's
    `.agent` rules are part of every run, so a visitor can get them paraphrased:
    keep secrets out of them. A conversation belongs to the browser that
    started it; there is no sign-in on the site.
18. **Subdomains and custom domains are set up by the operator.** DNS records,
    certificates (a wildcard certificate for subdomains) and the reverse proxy
    rules are outside Folio, and the bundled HTTPS proxy serves only
    `FOLIO_DOMAIN` until you add blocks to its `Caddyfile`.
19. **A public site is read-only and anonymous.** No comments, page history,
    backlinks or notifications; a form can be viewed but not submitted; a
    whiteboard is a picture. A reader on a subdomain or a custom domain stays
    anonymous even when signed in on the main address.
20. **Publishing settings live in the database, not in Git.** Who can see the
    site, its subdomain and domain, downloads, Folio AI, indexing and the
    primary address are not in a clone or an export of the repository. They can
    be changed only from the browser, by a space or instance administrator: not
    with an API token. The public demo allows it for the Folio Handbook, without
    a subdomain or a custom domain. The look of the site
    (`.folio/`) is in the repository and changes with a commit; it is edited by
    space administrators, and an instance administrator who is not a member of
    the space can change the publishing settings but not those files.

## Chat previews

Link previews in Slack and Microsoft Teams ([setup](CHAT-PREVIEWS.md)).

21. **One card for the whole conversation.** A preview is built with the Folio
    access of the person who shared the link and is seen by everyone in the
    channel. A page restricted to specific people therefore shows its title only,
    even to readers who could open it; Teams cards are not refreshed per viewer.
22. **A preview is a snapshot** of the page when the link was shared; it is not
    updated afterwards.
23. **One Slack workspace and one Teams tenant per instance.** Slack uses a single
    bot token (no Enterprise Grid org-wide install); Teams is registered as a
    single-tenant bot. Slack accepts five link domains, so an instance with many
    custom site domains previews only the first ones.
24. **Connecting needs the desktop or web client** of Teams (Teams mobile
    unfurls only links that need no sign-in), and an `https` `PUBLIC_URL`
    reachable from the internet. Cards are in English.

## Known defects

25. **Emptying the trash** may leave a folder with nested pages inside the
    service trash folder.

## Graph view

22. **The graph view has limits.** A graph shows at most 10,000 pages: in a
    larger space the 10,000 most recently changed pages you can open are kept,
    and the view says so and suggests the local graph. There is no time-lapse
    animation, no saved layouts or pinned nodes (positions are computed again on
    every open), no 3D, and no graph on public sites or share links. The local
    graph is only in the side panel of a document; tables, boards and forms
    have no such panel, so open their neighbourhood from the space's graph. A
    link to a page you cannot open is left out entirely, so a graph can look
    sparser to you than to an administrator. Through MCP, `get_graph` returns
    300 pages by default and at most 2,000. Folder colours are assigned by how
    often a folder occurs in the current view, so the same folder can have a
    different colour in the global and in a local graph. A Folio page URL counts
    as a link only on the instance's own host (`PUBLIC_URL`) or root-relative
    (`/s/…`); a link to the same instance under another address, a share link
    (`/share/…`) and a public-site address (`/public/…`, a site's own domain)
    stay external links. Pages of another space appear only as targets of this
    space's links (the space graph) or as direct neighbours (the local graph);
    the graph does not walk on through them. When a page of another space is
    deleted or restored, links to it from here catch up at this space's next
    index update (a save or a scan here). Tree lines come from the page tree and
    are not links: they never count as backlinks.

## Obsidian Bases

26. **Bases are supported in part.** A `.base` file opens as a page with a table,
    cards or list view, and its filters, formulas, grouping, sorting and
    summaries work, but Folio does not implement all of Obsidian. Not supported:
    `kanban` and `map` views and views from plugins (they show a notice and fall
    back to a table), `html()`, `image()`, `icon()` and plugin functions (a
    formula column using one shows "formula not supported"; a filter statement
    using one is ignored, with a warning on the page), attachments as rows (only
    pages are rows), `![[x.base]]` embeds, and a base across several spaces.
    Dates are computed in UTC, so a relative date such as `today()` follows UTC,
    not the viewer's time zone. A regular expression with nested quantifiers or
    back-references is refused, and a very expensive formula is stopped by a
    per-query budget. A query looks at 5,000 candidate pages at most (the first
    ones by path, with a warning once past that), shows 200 rows at a time ("Show
    more"), and a `.base` file over 256 KB is refused. Rows are the pages you can
    open, so the same base can show fewer rows to you than to an administrator.
27. **Editing cells has limits.** You can change a cell only on a page you can
    edit, and only a note property: never a `file.*` or a `formula.*` column, and
    never a Folio key that holds a foreign value (for example `status: deprecated`
    on a document in a native space; in a vault `status` is an ordinary property). A `base` code block inside a document is read-only; to edit cells
    open the base page itself. The visual editor keeps unchanged parts of the file
    byte for byte, but a filter it cannot express as a rule stays a raw
    expression you edit as text, and formulas have no autocomplete yet. Share
    links and public sites show a note instead of a base, because a base exposes
    page properties; through MCP, `query_base` is refused on public sites and
    returns at most 500 rows per call (100 by default).

## Artifacts

An artifact is an interactive page made by an agent
([how it works](FEATURES.md), [publishing over MCP](MCP.md#publish_artifact)).

28. **Folio shows finished pages; it does not build them.** There is no JSX or
    TSX runtime in Folio: an agent sends one self-contained HTML page (a React
    artifact or a Cursor canvas has to be built into such a page that loads React
    from a CDN), and the original source is kept next to it as a file. A page that
    needs a build step, or components that only exist inside Claude or Cursor
    (`cursor/canvas`, shadcn), does not run until it is rewritten.
29. **What an artifact can reach is narrow on purpose.** The frame has no
    cookies and no Folio API; requests to hosts other than the CDN allowlist
    (cdnjs, jsDelivr, unpkg, Tailwind, jQuery, esm.sh, Google Fonts) are blocked, so
    data must be inlined or shipped as files of the artifact. `window.storage` and
    `localStorage` work; `window.claude.complete`, network calls to your own
    services and connectors do not, and a page that expects them says "works
    partially". State is stored per reader (up to 5 MB per page); the shared part is
    read only for guests of a share link and for public sites, and a guest's own
    state stays in their browser.
30. **Share links of claude.ai and Cursor are not downloaded.** Folio only
    fetches direct `https` links to an `.html`, `.zip`, `.svg` or `.md` file. For
    a Claude artifact paste its embed code (it is shown in a frame of the
    original host, not copied) or, better, ask the agent to publish it with
    `publish_artifact`.
31. **Artifacts are replaced, not edited.** There is no editor for the page
    inside Folio (the bundle's files are viewed with "Show source"), no comments,
    and no versions in the interface; Git keeps the history, and the page-level
    properties are the only part edited in place. Search finds an artifact by its
    title, properties and the visible text of its entry page (the first 100 KB),
    not by what a script draws later. A bundle is limited to 500 files and 50 MB,
    a download from a link to 20 MB, and an MCP request to 25 MB.

## Side-by-side comparison

Side by side view of pages and versions ([how it works](FEATURES.md)).

32. **Side-by-side comparison holds five columns, and highlights text only.** Highlighting is
    block by block: a paragraph that moved shows as changed, and a very large
    page is not highlighted (the column says so). Only version columns are marked,
    never the live ones. A table or base version shows its file text with changed
    lines marked; a whiteboard or a file version is a preview without marks, and
    version columns are read-only. The list of columns lives in the browser, and
    the link carries only ids, so each reader sees it with their own access.

## Sessions and audit log

33. **Sessions have a fixed lifetime and the log has limits.** A session ends
    `FOLIO_SESSION_TTL_DAYS` after sign-in (it is not extended while you work),
    and "last active" is updated at most every 5 minutes. The address shown for a
    session is the client's real one only with `TRUST_PROXY` set; otherwise it is
    the proxy's. Audit entries are written fire-and-forget (a database failure
    does not stop the action), are never pruned or signed, and only instance
    administrators can read them. The CSV export stops at 100,000 rows (the file
    ends with a line saying so). Actions that are not audited today, such as
    ordinary page edits in the editor, do not appear in the log.
