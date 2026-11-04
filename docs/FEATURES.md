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
| Obsidian canvas | `*.canvas` (JSON Canvas 1.0) | no, view only; can be converted into a whiteboard |
| Obsidian base | `*.base` (Bases YAML) | yes: views and filters are configured, a row's properties are edited in the cells |
| Artifact | `<name>.artifact/` (a folder with `index.html`) | no, replaced as a whole; interactive, in a sandboxed frame |

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

**Obsidian markup is read, not written.** A vault's notes look right in Folio:
the files are never changed, Folio only draws what is already in the text, in
Reading, Live and Source alike.

- `[[Note]]`, `[[Note|alias]]`, `[[Note#Heading]]`, `[[Note#^block]]` and
  `[[#Heading]]` are links to pages, resolved through the page index (the
  "shortest path" rules of Obsidian, case-insensitive) with one request per
  page, not per link. A click opens the page and scrolls to the heading or the
  block. A link to a page that does not exist is dashed; an editor gets
  "Create page “Note”" (a file `Note.md` in the current folder). The same on a
  public site, without the create offer.
- `![[photo.png|300]]` is an image with a width (`300x200` adds a height);
  `![[report.pdf]]` is a link to the file; `![[Note]]`, `![[Note#Heading]]` and
  `![[Note#^block]]` embed that note, section or block, read-only, under a link
  to its source. The server checks the reader's rights for the embedded page
  (`GET /api/pages/:id/embed`, with a public twin for public sites); embeds nest
  up to 3 levels, and a cycle (a page embedding the page it is already shown
  in) is cut with a note.
- Callouts: `> [!type]`, `> [!type]+` / `-` (foldable, `+` starts open),
  `> [!type] Title`, nested, any type in any case — an unknown type is drawn as a
  note, and GitHub's five alerts are the same component (Obsidian's `info`,
  `faq`, `danger` ... map onto the five looks).
- `%%comments%%` (inline and block) are hidden in Reading and in PDF/DOCX
  export, dimmed in Live, visible in Source, and left out of search. An unclosed
  `%%` stays text. A comment is not a way to keep something secret: the text
  stays in the file, in Git and in MCP.
- A `^block-id` at the end of a paragraph is a hidden anchor; `#tag` and `#a/b`
  are chips (a click opens Cmd+K with the query `tag:<tag>`; on a public site a tag is plain text); `$inline$` and `$$display$$` formulas are drawn with
  KaTeX, loaded only on pages that have one (invalid TeX stays as text).
- In PDF and DOCX a wikilink prints as its text, an embedded note as
  "[embedded: Note]", an embedded image as the image, a callout as a quote with
  its title, tags as `#tag`, and a formula as its TeX in code.

**Text formatting** — toolbar buttons and hotkeys: `**bold**`, `*italic*`,
`~~strike~~`, `==highlight==` (with a colour: `==text=={.green}`), `++underline++`.
Underline is markdown rather than an HTML tag pair, so it nests with bold and
italic in any order; old `<ins>`/`<u>` on existing pages still render underlined.

**Status tags** — a small coloured badge inside a sentence, like a Confluence
status lozenge: `:status[Done]{color=green}`. Six colours (grey, blue, green,
yellow, red, purple; grey is the default). Insert one from the toolbar, the
selection bar or the `/` menu, and click it to change the text or the colour.
The text is stored as typed and shown in capitals. Tags work in table cells,
are found by search under their text, are drawn as badges in PDF and DOCX
export, and arrive from a Confluence import as the same tag.

**Copy and paste** — copying or cutting in Live edit keeps the formatting: the
clipboard holds the selection as Markdown (plain text) and as rendered HTML, so
a pasted result keeps bold, links, highlights and status tags in Slack, Google
Docs or mail. Pasting such HTML into Folio turns it back into Markdown.

Also in the editor: pasting from Excel and Google Docs keeps tables and
formatting; `[[` picks a page (an ordinary relative link is written to disk,
not a private dialect); `@` mentions a person; an outline panel on the right;
a page cover and icon; image attachments.

A link to a Folio page is shown in Reading mode as the **page title**, not as
a URL.

**Templates.** A template is any page in the space's `_templates/` folder: a
document, whiteboard, data table, form, base, or a whole page with subpages.
"From template…" in the "+" menu (space root and every tree row) opens a picker
(with a filter when there are more than six) and copies the template, with its
subpages, properties and icon, to the chosen place. In documents `{{date}}`,
`{{author}}` and `{{title}}` are filled in; any other `{{…}}` stays as written.
"Make template" in a page's context menu (not for the space root, and disabled
offline) opens a dialog for the template name (prefilled with the page title),
an optional description and, when the page has children, "Include subpages",
then copies the page into `_templates/`; the Templates section expands and a
toast offers "Open". The description is a second line in the picker and a
tooltip in the sidebar; pages created from the template do not get it. Editors
also get a "Templates" section in the sidebar (collapsed, with a count) whose
"+" opens the same dialog for a blank template, and where they rename or delete
one; an open template is marked "Template" in the breadcrumbs. The folder is
hidden from the page tree, graph, tags, bases and public sites (search still
finds it). A new empty space starts with Meeting notes, How-to and Decision
record in the creator's language (English or Ukrainian); a space cloned from Git
gets none. Limits: `{{title}}` is filled only in documents (not tables or
forms); templates need a connection (offline mode does not cover them); two
templates with the same title show their file names in the tree. Copies are
fast: a page write re-indexes only the paths it touched. Agents use templates
over MCP too: `list_templates`, `create_page_from_template`,
`save_page_as_template` and `create_template` (see [MCP.md](MCP.md)); the
assistant in Agent mode has the same four.

## 3. Working together

Real-time collaborative editing (Yjs) works for **documents, tables and
whiteboards**: changes appear in every open tab at once, and you see who else
is present.

Authorship reaches the Git commit: the history shows who changed the page.

**Comments on text.** In a document, select a passage and press **Comment** (in
Live edit or Reading) to start a thread; the passage is highlighted and the
**Comments** panel lists open threads, resolved ones behind "Show resolved".
Anyone who can see the page can comment and reply; the author edits or deletes
their own comments; the person who started a thread or a page editor resolves
and reopens it. The thread follows its text and shows the quote if the passage
is deleted. Comments are stored in the database (migration 060), not in the
Markdown file: they are not in Git, exports or published sites. The MCP tools
`list_comments`, `add_comment` and `reply_comment` give agents the same access.

**Shared page timer.** Every page has a timer icon in its header (document, table,
whiteboard, form, PDF/Office, a space's home page; a folder listing has one for
the space): presets of 1, 3, 5 and 10 minutes, or a custom time (minutes and
seconds, up to 3 hours). While it runs, the header shows a live `mm:ss`
countdown, red for the last 10 seconds; click it to Pause, Resume, add a minute
or Reset. The timer belongs to the page: everyone who has the page open sees the
same countdown and reaches zero together (each browser counts to a server-time
end moment, corrected for its own clock), and at zero everyone gets a soft chime
(generated in the browser, no sound file) and a "Time is up" toast. If the
browser has not allowed sound yet, the countdown shows a muted-speaker icon and
the first click anywhere enables it; there is a per-device sound switch in the
popover. Someone who opens the page later sees the current state, and a reload
long after the end stays silent. People with the editor role on the page (the
space role and the page's own access, checked on the server) can start, pause
and reset; everyone else who can read the page only watches. The state is held
in server memory (never in the page file, Git, the shared document or the audit
log), is sent over the existing `/events` socket to the people who can read the
page, and clears itself five minutes after the end (two hours when paused).
There is also a REST API, `GET`/`POST /api/pages/:id/timer` (and
`/api/spaces/:space/timer`). Share-link guests and visitors of a public site do
not see the timer.

**Typed text is protected.** The editor and the shared document are compared
after every change and any difference is repaired, so text cannot stay on
screen only. The browser keeps a local copy of the page and deletes it only
once the server's own state shows that it holds your edits. When it does not,
the header shows **Not saved** and closing the tab asks for confirmation. A
page you may only view opens read-only. On the server, a failed write of the
page file is retried and the newer live state wins over the older file the next
time the page opens; page files are written atomically; and the text a live
page held is saved in a backup table before the server replaces all of it (a
file changed outside, an API or MCP body write, "Take the version from Git").

**Obsidian canvases (`.canvas`).** A canvas from an Obsidian vault (the open
[JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/) format) is a page of its
own in the tree, shown as it is and read-only: Folio never writes the file
while showing or indexing it. The view is an infinite canvas with pan (drag,
scroll), zoom (Ctrl/⌘ + wheel, pinch, `+` `-`, `0` for 100%) and a fit button;
the first view fits the whole canvas, between 10% and 100%. Text cards are
Markdown drawn by Folio's own reading view (Obsidian syntax included); a note
card shows the note's title and its start, or the `#heading` / `#^block` it is
narrowed to, and a double click or its label opens the note; an image, audio
or video card shows the file; a web page card shows its domain and URL (no
preview is fetched); groups are frames with their label and background image.
The six preset colours use Obsidian's palette in light and dark, hex colours
are used as written, and connections are drawn as Obsidian draws them, with
sides, arrowheads, labels and colours. A card pointing at a page you may not
open shows only "No access" — no title, no path. Text cards and group labels
are searchable, their `#tags` are the canvas's tags, and its file cards and the
links in its text cards count as links (backlinks, unresolved links). A file
that is not a valid canvas opens on a readable error; a canvas over 8 MB, or the
part of it over 5,000 cards / 10,000 connections, is not shown. Properties live
in a sidecar `.folio/<path>.props.yaml`, as for a whiteboard. **The name is the
file name, as in Obsidian:** "Rename" in the tree menu of a canvas or a base takes
any valid file name (Unicode and spaces, such as "Sprint notes"; no `/ \ : * ? " < > |`,
no leading or trailing dot, up to 200 bytes), keeps the extension, and moves the
property sidecar, the links to the file (wikilinks, Markdown links, file cards of
other canvases, in a vault too) and the page id along in one commit; a name that is
taken is refused. When a page a canvas points at is renamed or moved in Folio, its
file cards and the links in its text cards follow in every space, a vault included,
only the changed path strings rewritten. **Convert to Folio
board** (editors, in the canvas toolbar) makes a new whiteboard next to the
canvas, in one commit by you, and lists first what changes: Markdown becomes
plain text, text longer than its card is cut, note cards become a title with a
link, images over 1.5 MB (4 MB together) become linked cards, audio, video and
web page cards become links, group background images and nesting are dropped,
curved connections become right-angled arrows. The canvas itself always stays.

**Artifacts.** An artifact is an interactive page made by an agent: a Claude
artifact, a Cursor canvas or any self-contained HTML page (kind `artifact`). It
is a folder `<name>.artifact/` in the space's repository, shown as a page in the
tree: `index.html` (what is rendered), `artifact.yaml` (type, origin, the
capabilities the page expects and its properties, which the Properties panel
edits), the original source such as JSX or TSX kept as sent, and `assets/`. A
`.artifact` folder with an `index.html` and no manifest is an artifact too. The title and
icon come from the manifest.

- **Safe by construction.** The page runs in an iframe with the `sandbox`
  attribute and without `allow-same-origin`, so it has no cookies, no Folio API
  and no access to the page around it. Its files come from `/art/<token>/…`: the
  token is signed, tied to the page and the reader and valid for 12 hours, and
  the response carries a `sandbox` Content-Security-Policy. Scripts, styles and
  fonts load only from `cdnjs.cloudflare.com`, `cdn.jsdelivr.net`, `unpkg.com`,
  `cdn.tailwindcss.com`, `code.jquery.com`, `esm.sh` and Google Fonts; `fetch`
  to other hosts is blocked, so data must be inlined or shipped as files of the
  bundle.
- **State persists.** A small host bridge gives the page `window.storage` (the
  Claude artifact API: `get`, `set`, `delete`, `list`, string values, personal or
  `shared`) and a working `localStorage`. For a signed-in reader it is stored in
  the database, for a guest of a share link or a public site in the browser.
  Limits: a key up to 200 characters, a value up to 256 KB, 5 MB per reader and
  page, 5 MB shared.
- **Import.** "Artifact…" in the "+" menu: a link to an `.html`, `.zip`, `.svg`
  or `.md` file (downloaded with SSRF protection, up to 20 MB), a file from your
  computer, or pasted HTML; a Claude "Get embed code" `<iframe>` becomes an embed
  artifact. A ZIP is limited to 500 files and 50 MB unpacked. Links to claude.ai,
  claude.site and Cursor shares are never downloaded; Folio says to publish through
  MCP instead.
- **Publish over MCP.** `publish_artifact` (editor role, `write` token) creates
  an artifact under `parentPath` or, with `id`, replaces one, keeping its id,
  path, properties, title and icon. It takes one self-contained `html`, or
  `text` for `svg` / `markdown` / `mermaid` (Folio wraps it), extra `files`
  (UTF-8 or base64), `sourceCode`, a direct `url`, an `embedCode`, the `origin`
  and `sourceUrl` of the original, `capabilities` and `properties`.
  `read_page` returns the manifest, the file list and the entry HTML. See
  [MCP.md](MCP.md#publish_artifact).
- **On the page.** "Show source", "Download .zip", replace, and a "works
  partially" note when the page expects Claude calls, network access or
  connectors that Folio does not provide. Artifacts are in the tree, quick
  switcher, search (`kind:artifact`), properties and tags, the trash, Git history,
  copy and move, share links and public sites.

**Obsidian Bases (`.base`).** A base from an Obsidian vault is a page of its own
in the tree (kind `base`). It is not storage but a **query**: the file holds
filters, formulas and views, and the rows are the pages of the same space that
you may open. Access is applied inside the query, as in search and the graph:
space membership, page access, `.agent/**` for administrators only, `_templates/**`
never, no folders. Any page can be a row: documents, data tables and forms (their
front matter), whiteboards, PDFs, Office files and other bases (their sidecar
properties); attachments are not rows. The base's id lives only in the page
index and its title is the file name without `.base`; Folio never rewrites the
file while showing or indexing it. Broken YAML opens a readable error page with
the line number.

- **Views.** Table, cards (the cover comes from an `image:` property: a link to
  an image, a URL or a `#hex` colour) and list (with markers). `kanban`, `map`
  and plugin views show "not supported yet" and fall back to a table. Group by
  one property (with `groupOrder`, including rows with no value), sort by
  several keys, limit, column summaries (Average, Min, Max, Sum, Range, Median,
  Stddev, Earliest, Latest, Checked, Unchecked, Empty, Filled, Unique, plus your
  own formulas under `summaries:`), property display names, and the base's
  filters and the view's filters combined, with `and` / `or` / `not` groups
  (`not` means none of).
- **Expressions.** A safe evaluator of our own (no `eval`): arithmetic,
  comparisons, `&& || !`, date arithmetic with durations (`"1d"`, `"2w"`,
  `"1M"`), lists, objects, regular expression literals, and `this` (the base
  itself, or the document that embeds the block). Supported: the globals `if`,
  `now`, `today`, `date`, `duration`, `number`, `list`, `max`, `min`, `link`,
  `file`, `escapeHTML`, `random` and the older `taggedWith`, `inFolder`,
  `linksTo`; methods of strings, numbers, dates (`format` with Moment tokens,
  `relative`, the fields `year` to `millisecond`), lists (`filter`, `map`,
  `reduce`, `sort`, `unique`, `sum`, `mean`, `median`, and more), links, files
  (`file.name`, `path`, `folder`, `ext`, `size`, `ctime`, `mtime`, `tags`,
  `links`, `backlinks`, `hasTag`, `inFolder`, and more), objects and regular
  expressions. Not supported: `html()`, `image()`, `icon()` and plugin functions.
  A formula column using one shows "formula not supported", and a filter
  statement using one is ignored with a visible warning. Dates are computed in
  UTC (a date and time is shown in the reader's local time). Regular expressions
  with nested quantifiers or back-references are refused, and each query has an
  evaluation budget.
- **Limits.** At most 5,000 candidate pages per query (after an SQL prefilter on
  tags, folders, extension, name, `hasProperty` and the presence of a property;
  beyond that the view is marked truncated with a warning), 200 rows per page of
  results ("Show more"), an API `limit` of up to 1,000, and a file of up to
  256 KB.
- **Editing cells.** An Edit toggle on the base page. Changing a cell is a
  `PUT /api/pages/:id/properties` of **that** page (the whole map with its etag;
  on a 409 the view refreshes and says so). Only rows you can edit are
  editable (editor or above on that page; a restricted page needs its owner or
  an edit grant; a read-only token cannot), and only note properties, never
  `file.*` or `formula.*`. Folio's own keys with a foreign value are read-only
  (for example `status: deprecated` on a document in a native space; in a vault
  `status` is an ordinary property and `todo` is editable), and labels follow the rules of the
  properties API.
- **Visual editor** ("Configure", editors on the base page). Views (add, rename,
  delete, layout, column order, sort, group, summaries, limit, card image),
  filters for all views or for this view (property, operator, value rules, nested
  groups; raw expressions are kept as text), formulas and display names, and a
  raw YAML tab. Saving is `PUT /api/pages/:id/base` with an etag. The writer
  keeps unchanged top-level blocks and unchanged views byte for byte, comments
  and unknown keys included, and the write is one debounced commit authored by
  you.
- **Creating.** "+ → New base" in the sidebar and the tree, and "New base" in
  the quick switcher (the starter is one table view filtered to the folder it is
  created in). "Save as base…" in the quick switcher's search (editors, inside a
  space) turns `tag:`, `kind:`, `status:`, `in:` and `prop:` into Obsidian
  filter statements; words and phrases are dropped, and the dialog says so.
- **`base` code blocks in documents** show the same view (in Reading mode and as
  a live widget in the editor; read-only, a click reveals the source), with `this`
  meaning the document. Share links and public sites show a note instead,
  because a base exposes properties.
- **Export and search.** A base exports to Markdown as its YAML inside a `base`
  code fence; `kind:base` works in search.
- **API and MCP.** `GET /api/pages/:id/base?view=&offset=&limit=`,
  `GET /api/pages/:id/base/source`, `PUT /api/pages/:id/base` and
  `POST /api/spaces/:space/base/preview`. MCP has a read-only `query_base` tool
  (`limit` 1 to 500, default 100) and a `save_base` tool that creates a `.base`
  or replaces its YAML (invalid YAML is refused with the line number, and the
  answer carries a preview of the first view); `read_page` on a base returns
  its YAML and `fetch` renders the rows as a Markdown table. Public sites refuse
  `query_base`.
- **Not yet.** `kanban` and `map` views, editing cells inside an embedded `base`
  block, attachments as rows, `![[x.base]]` embeds, autocomplete in the formula
  editor, `html()` / `image()` / `icon()`, relative dates by the viewer's time
  zone, and a base across several spaces. Database migration 047.

**Whiteboard reactions.** Selecting a single shape in Edit mode shows a reaction
button at its selection frame; the palette has eleven emoji (yes, no and in
progress marks first), each with a name on hover. Reactions appear as chips with a count just under the
shape, click a chip to add or remove yours, and the tooltip names who reacted.
They sync in real time, two people reacting at once both keep theirs, people
with the viewer role, or anyone in View mode, see them but cannot add any, and they are not part of the
board's SVG file or Git history.

### Side-by-side comparison

Up to five pages, or older versions of a page, side by side in one view.
"Compare side by side" is in a page's context menu and "..." menu in the sidebar
(people who can only read a space get it too), in the page header, and in the
history panel for a version ("Add to side by side"). A "Side by side · N" chip at the bottom of the window
holds the list (up to five items, from any spaces you can open, kept in the
browser); "Open" shows them as equal columns at `/compare?items=…`. A column of
a current page is the page itself, with the same editor and live collaboration:
type in it and everyone on the page sees the change. In the history panel,
"Compare side by side with current" opens the page as a live column with the chosen version
next to it, read-only. With "Highlight changes" every version column is marked
against the leftmost column (the base): green for text that is new or changed,
red and struck through for text the base has and the version lacks, with a count
of changed blocks and removed fragments; "Refresh base" rereads the base and
"Synchronized scrolling" scrolls all columns together (on by default when a
version is among the columns). "Copy link" copies an address that holds only page
ids and version numbers; whoever opens it sees each column with their own rights,
and a column they cannot open shows a notice. Limits: highlighting compares text
block by block (a moved paragraph shows as changed), marks only version columns,
and skips a very large page; a table or base version shows its file text with
changed lines marked, a whiteboard or a file version is a preview without marks;
on a phone the columns scroll sideways. Columns are compact (tables and code
scroll inside their own box), and a zoom control at the bottom, or Ctrl/Cmd with
`-`, `=` and `0`, scales every column together from 50 to 125% (not boards,
canvases, artifacts or file previews). See [LIMITATIONS.md](LIMITATIONS.md).

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
- **Front matter from other tools is kept.** Folio manages only its own keys
  (`id`, `order`, `status`, `icon`, `cover`); everything else — `title`,
  `sidebar_position`, `slug`, `tags`, `description` from Docusaurus, MkDocs,
  Hugo or Jekyll, comments, lists, quoting — stays byte for byte when a page is
  saved, copied or duplicated.
- **`.mdx` pages (Nimbus, Starlight, Astro, Docusaurus) are pages like `.md`
  ones.** Connect a site's docs folder (for example `src/content/docs/`) as a
  space bound to that folder: every `.mdx` file is a page in the tree, `index.mdx`
  is a folder's own page, and the title comes from the front matter `title:`.
  Folio does not run MDX, and the editor works on the text of the file, so what
  it does not understand comes back from a save byte for byte: `import` / `export`
  lines, JSX components (`<Aside>`, `<Tabs>`, `<Card />`, nested ones, with
  Markdown inside), `{expressions}` and `{/* comments */}`. In Live edit each such
  construct is folded into one compact "MDX component" / "MDX import" block (a
  component is at most 22rem tall and fades out below that): a component is drawn
  as a box with its name, its attributes and its Markdown body (tables, lists and
  code inside included), imports as code. A click opens the block as plain text to
  edit; arrow keys step over it like over an HTML block; Source mode folds
  nothing. Reading hides the `import`/`export` lines and `{/* … */}` comment lines
  and draws components as the same boxes (a long expression attribute is shown as
  `{…}`). A line starting with a capitalised tag (or `<>`) is a component up to its
  matching closing tag; a tag with text after it on the same line, JSX inside a
  paragraph and a component that is never closed stay ordinary paragraph text.
  Lower-case HTML (`<details>`, `<dl>`) is Markdown's own and is handled as before.
  A new page gets `.mdx` only when the nearest folder that holds documents (this
  one, then its parents) holds nothing but `.mdx`; a mixed folder, a space with no
  pages and every ordinary space keep `.md`. A new `.mdx` page in a space bound to
  a folder starts with a front matter `title:` and an empty body (Nimbus and
  Starlight refuse a page without a title and ask not to repeat it in the text);
  a new `.md` page starts with `# Title`. Renaming, moving and copying keep the
  suffix, and `intro.md` and `intro.mdx` count as one name. Checked on the docs of
  Cloudflare's Nimbus demo site (17 pages): `git status` is clean after connecting,
  and editing one paragraph in Live edit commits that paragraph and nothing else.
- **A light footprint in a product repository.** When a space is bound to a
  folder of a repository (a root path such as `docs/`), Folio does not write an
  `id` into the files — not on the first scan, not when a page is created or
  edited; the id lives in Folio's index and survives moves, renames, copies and
  restores from the trash. The space's metadata file goes inside that folder as
  a dotfile, `docs/.<slug>.folio`, which site generators ignore, not into the
  repository root. Spaces that already carry ids in their files keep working
  as they are.
- **An Obsidian vault connects without changing a single file.** When the
  repository (or the folder you pick) contains `.obsidian/`, the "new space"
  dialog says so. A space made from a repository that already has files of its
  own is created with a light footprint by default, with or without
  `.obsidian/` (a gitignored `.obsidian`, a plain notes repo, a GitHub Wiki),
  even if it is the whole repository; only an empty repository and one that
  already was a Folio space (`<slug>.folio` at its root) get the native mode: no `id` is written into the files, the metadata file is
  a dotfile (`.<slug>.folio`) at the root, and `git status` stays clean after
  the scan. The "Light footprint (no ids in files)" checkbox can also be turned
  on by hand, in that dialog and later in the space menu ("Indexing & files…");
  a space bound to a sub-folder is always light. Existing spaces that carry ids
  in their files are not changed.
- **What the scan skips is set per space.** `.obsidian/`, `.trash/` and `.git/`
  (like every other dotfile or dot-folder; `.agent` at the root is the one
  exception) and the `assets` folder are always skipped. A space administrator
  can add their own entries: names of **top-level** files and folders, `*` for
  any characters, a trailing `/` for folders only (`Templates/`, `draft-*`),
  up to 50, case-insensitive. Saving a changed list re-indexes the space — pages
  under a newly skipped entry leave the index, pages under a released one enter
  it — and never touches the files. Space menu → "Indexing & files…", or
  `PATCH /api/spaces/:space/scan-settings`.
- **Obsidian wikilinks are indexed and follow renames and moves.** `[[Note]]`,
  `[[Note|alias]]`, `[[Note#Heading]]`, `[[Note#^block]]`, `![[Note]]` and
  `![[image.png]]` (outside code blocks and inline code) count as links: they
  appear in backlinks and in the unresolved-link list. They are resolved the way
  Obsidian does ("shortest path when possible"): a name without an extension
  means `name.md`; a path is tried from the page's folder, from the space root,
  and as the tail of a longer path; a bare name finds the one page of that name
  anywhere (with several, the one nearest to the page's folder); case does not
  matter; `%20` is read both literally and decoded. When a page is renamed or
  moved, the wikilinks that point at it are rewritten in the same form —
  `[[Old|alias]]` becomes `[[New|alias]]`, `#heading`, `#^block` and the `!` of
  an embed stay; a bare name is left alone when a move keeps it unambiguous, a
  `[[folder/page]]` path follows the page, and an explicit `[[../page]]` also
  follows a page that moved itself. Nothing else in the file changes. Folio
  does not create wikilinks (the `[[` picker in the editor still inserts a
  relative link), but it shows them (see section 2).
- **Page history**: the list of commits and a view of any revision. For a
  PDF or Office page each version shows its file name and size, can be
  downloaded (a PDF can also be previewed), and can be restored.
- Separately from Git there is **undo for structural actions** (create, copy,
  rename, move, delete) — your own only, and only if nothing has changed
  since.
- **Git access** (user menu): saved tokens for GitHub and GitLab are used
  automatically for repositories on the same host, and list your repositories
  in the "create space" dialog. On an instance with a GitHub OAuth App
  configured, **"Connect with GitHub"** saves github.com access in one click
  instead of pasting a token (see `INSTALL.md`).

## 6. Access

- **Roles in a space**: `admin`, `editor`, `viewer`.
- **Space visibility**: `private` (explicit members only), `instance` (any
  active user may view) or `public` (any active user may view, and anyone on
  the internet may read it as a website, see section 7).
- **Rights on a single page** can be narrower than the role in the space, and
  they are **inherited by child pages** (like Confluence view restrictions): a
  child of a restricted page is restricted too, and its own restriction can
  only narrow that. The page access dialog shows "Restricted by parent page …"
  and who can open the page; the sidebar marks restricted pages with a lock.
- **Groups**: a named set of people that gets a role in a space and access to a
  restricted page, the same way a single person does. A person's role is the
  highest of their own, their active groups' and the implicit viewer role.
  Instance administrators create and delete groups; a group's managers edit its
  membership; a space administrator grants or revokes a group's role in their
  own space. Groups can be filled from the identity provider: with group sync
  on, each single sign-on sign-in adds and removes the memberships the provider
  asserts (matched by name or an explicit table, optionally creating missing
  groups); memberships added by hand are never touched. Groups do not nest;
  "All members" is the `instance` visibility. The
  Access page has a Groups tab, and groups appear in the matrix, the space
  members dialog, page access and invitations.
- **The instance administrator does not see the content of spaces** they are
  not a member of: they manage users and invitations, but the pages are closed
  to them. They can grant access to themselves — and that is written to the
  audit log and shown with a mark.
- **Invitations** — links with preset roles, an expiry date and a usage limit.
  A signed-in person can accept one with the current account, or sign out to
  use another account.
- **Access requests**: a user who runs into a 403 sends a request; the space
  administrators are notified and decide.
- **Deactivating a person cuts off all access.** A disabled account at once loses
  its browser sessions, personal API tokens, OAuth connections of apps (Claude,
  ChatGPT, chat previews) and the open editor and notification connections. The
  audit log records `user.disable` with the number of things revoked, and
  `user.enable` when the account is switched back on; revoked credentials do not
  come back.
- **Sign-in sessions.** Everyone sees their own sessions (device, address, last
  activity) in Settings and can sign out their other devices. An instance
  administrator sees any person's sessions in the edit-user dialog and can end
  one or all of them; the audit log records `session.revoke` and
  `session.revoke_all`. The session lifetime is `FOLIO_SESSION_TTL_DAYS`
  (default 30, counted from sign-in, not extended while you work).
- **Audit log** (`/admin/audit`, instance administrators; "Audit log" in the
  account menu): a table of events filtered by actor, action prefix, target and
  date range, loaded page by page, with readable names for known actions (unknown
  ones show the action string and details as they are) and a CSV export of the
  current filter (streamed, up to 100,000 rows; the export is itself logged).
  Space administrators keep the access changes feed of their own space.
- **Single sign-on (OpenID Connect)**: Keycloak, Authentik, Microsoft Entra ID,
  Okta, Google or any other OIDC provider, configured in the interface or with
  environment variables, with a "Test connection" that shows what the provider
  sends. Email first: the login page sends an email of your organization's
  domain to its provider. Accounts can be created at first sign-in with preset
  spaces, or only invited people get in; an existing account is linked only when
  the provider has verified the email. Single sign-on can be made mandatory for
  your domains — instance administrators keep an audited emergency password
  sign-in.
- **Single sign-on (SAML 2.0)**: Microsoft Entra ID, Okta, Keycloak, Google
  Workspace, ADFS or any other SAML IdP, from its metadata URL or XML, with the
  same account rules, "Test connection" and email routing as OpenID Connect.
  Signed assertions only, bound to the sign-in the browser started, each one
  usable once. The admin screen shows Folio's entity ID, ACS URL and SP metadata
  to register at the IdP.
- **SCIM 2.0 provisioning**: Okta, Microsoft Entra ID, Keycloak (with a SCIM
  plugin), OneLogin, JumpCloud and others create, update and deactivate people
  and groups. A bearer token per provider, generated at `/admin/auth` and shown
  once; deactivation ends every session and token of the person at once;
  DELETE deactivates (never deletes) and archives groups; memberships added by
  hand in Folio are never removed; every change is in the audit log (`scim.*`).
  While SCIM is on, accounts are not created at first sign-in.

## 7. Sharing outside

A link to a page for people without an account: view or edit, optionally
"with child pages". There is also a `.md` form of the link that returns plain
Markdown — convenient for external agents.

"With child pages" never includes a page that has its own access
restrictions, nor anything below it: such a page is shared only by a link
made for that page itself. This is checked on every visit, so restricting a
page later also removes it from links that already exist.

A signed-in reader who can open the page is sent from `/share/<token>` to the
normal page in their own account, with their own rights; add `?as=guest` to
keep the guest view. Of the space's
files, a guest gets only those of the pages the link covers and the images
and attachments those pages embed or link to. A link is a credential, so
links are listed, created and revoked only in the browser, never with an API
token.

Edits made by a guest through such a link reach Git with the matching
authorship.

### Publish a space as a website

Setting a space to **public** ("Publish as website" in the space menu, for space
and instance administrators) serves it to anyone, without signing in, as a
read-only site. It is the same space, not a copy. People who are signed in read
it exactly as they read a space with `instance` visibility.

- **Three addresses.** `<PUBLIC_URL>/public/<space>` works as soon as the space
  is public. `<label>.<PUBLIC_SITES_DOMAIN>` works when the operator has set
  `PUBLIC_SITES_DOMAIN` and the administrator picked a label (lowercase
  letters, digits and hyphens). A custom domain such as `docs.example.com`
  works when the host has a CNAME to the instance and the reverse proxy routes
  it to Folio. A subdomain and a domain belong to one space each. The
  operator's part is in [INSTALL](INSTALL.md#public-sites).
- **What a visitor sees.** The page tree, breadcrumbs, search inside the space,
  documents, data tables (live, read-only), whiteboards as pictures, forms
  (view only: submitting needs a Folio account), PDF and Office files, the
  images and files that public pages use. On a phone the tree folds behind a
  menu button. The footer has "Powered by Folio" and "Sign in" links.
- **Downloads** (opt-in per space): a page as Markdown, PDF or DOCX. PDF and
  DOCX are rate limited per address (`PUBLIC_EXPORT_PER_MINUTE`, default 6); a
  visitor's search query is cut at 200 characters.
- **Ask Folio AI** (opt-in per space, see section 11).
- **Never published**: pages with their own access restrictions, the `.agent`
  folder and templates, nor anything below a restricted page (restrictions are
  inherited). A raw file is served only if a
  public page uses it. Visitors are not sent the names or cursors of the people
  editing, and there are no comments, history, backlinks or notifications on
  the site.
- **Control.** Only administrators change visibility and publishing settings,
  from the browser (an API token is refused; the public demo allows it for the
  Folio Handbook, without a subdomain or a custom domain). The
  decisions about publication (who sees the site, its addresses, downloads,
  Folio AI, indexing, the primary address) live in the database, not in Git;
  changes are written to the audit log. Moving a space back to `instance` or
  `private` takes the site down within seconds, and the settings are kept for
  the next publication.
- **Site & PDF settings and the `.folio/` folder.** How a space presents itself
  outside the app lives in the repository, in a `.folio/` folder at the root of
  the space's content (`docs/.folio/` for a space with a root path), and one
  page edits it: space menu, **Site & PDF settings…**, at `/s/<space>/settings`
  (space administrators). Tab **Site**: title, tagline, description (the
  default meta description), language, social image, favicon and logo, with a
  preview as a search result and as a link card, next to a summary of the
  publication. Tab **Site appearance**: the site's stylesheet with a live
  preview. Tab **PDF**: header, footer and print stylesheet, and a "Test PDF"
  button. The files are `site.json`, `site.css`, `export.css`, `pdf-header.html`,
  `pdf-footer.html` and `assets/` (png, jpg, webp, gif, svg, ico, woff, woff2;
  up to 1 MB a file and 5 MB in total). Each file shows its path and an "Open
  in repository" link. Every save is one commit, `settings: update
  .folio/<files>`, with only those files in it, so unsaved page edits of other
  people are not swept into it. Git is an equal editor: if a file changed in
  the repository after the page was opened, the save is refused with a 409 and
  the page shows the difference and offers the repository's version or yours.
  PDF settings from before (the `export` section of `<slug>.folio` and
  `<slug>.export.css`) are still read, and the first save of the PDF tab moves
  them into `.folio/` in one commit. The "Powered by Folio" footer is not
  configurable.
- **Site stylesheet.** `.folio/site.css` applies to the public site only, never
  inside the app. Before it is served, comments and `@import` are removed,
  `url()` keeps only `data:` images and fonts and files from `.folio/assets/`
  (anything else becomes `none`) and a file over 256 KB is not applied; the
  editor shows the same warnings. Stable selectors are `.folio-site` and
  `[data-folio-site-part="header|sidebar|main|footer|page"]`. No JavaScript and
  no third-party snippets.
- **SEO.** The server renders a `<head>` for every public page: title (page
  title, then site title), description (the page's front matter `description`,
  else the site's, else an excerpt), Open Graph (`og:site_name`, `og:url`,
  `og:image` from the front matter `image` or `cover`, else the site's social
  image), a canonical link, `lang`, the favicon, and `noindex` for a page with
  `unlisted: true`. A page that is not on the site answers with a real 404.
  `robots.txt` and `sitemap.xml` are served per host: a site's host gets its
  own sitemap and keeps crawlers out of `/s/`, `/share/` and `/api/` (except
  `/api/public/`); the main host keeps them out of the app, lists the sitemaps
  of sites served at `/public/<space>` and serves each at
  `/public/<space>/sitemap.xml`. A sitemap lists the public pages that are not
  `unlisted`, with `lastmod`. The publishing dialog has an "Allow search engines
  to index this site" switch (on by default; off means `noindex`, `Disallow: /`
  and no sitemap) and a "Primary address" (automatic: custom domain, else
  subdomain, else the address on this Folio; or one of them) that the canonical
  links and the sitemap use. The site answers on every address; only the
  canonical one is declared. In the public demo every site is `noindex`.
- **For AI agents.** Each site also serves, at its own root (the site's host, or
  `/public/<space>/` on the main host): `llms.txt`, an index in the llmstxt.org
  format (site title, summary, then every public page as
  `- [Title](<page>.md): description`, grouped by the top-level folders of the
  tree); `llms-full.txt`, the Markdown of all those pages in one file, each under
  its title and URL, cut at 200 pages or 2 MB with a comment saying so (and an
  `X-Folio-Llms-Truncated` header); and a Markdown copy of each page at its
  address plus `.md` (`/p/<id>.md`, `/index.md` for the home page), served as
  `text/markdown`. A copy is the page's Markdown without front matter, links to
  other public pages pointing at their `.md` and files as absolute URLs. Text
  pages only: documents, tables, whiteboards, canvases and bases; forms, PDF and
  Office files and artifacts are not listed. Pages with `unlisted: true` are left
  out of the two lists but their `.md` opens by link, like the page. The
  visibility rule is the HTML site's own: a restricted page (or one below it),
  `.agent` and templates are in none of these and their `.md` is a 404. Page heads
  link to the page's `.md` and to `llms.txt`. Switch it off with `"llms": false`
  in `.folio/site.json` (checkbox on the **Site** tab of Site & PDF settings; on by
  default). It is also off while "Allow search engines to index this site" is off
  and in the public demo.
- **Not yet.** There is no PDF preview before saving, no editor for the SEO
  fields of a single page (they are front matter keys), no redirect from the
  other addresses to the primary one, and no place for analytics snippets.
  Rate limits are counted per server process.

## 8. Search and navigation

- **Full-text search** across documents and tables.
- **Cmd+K** — quick switch between pages.
- The space switcher has search and scrolls long lists inside its menu.
- Recent pages, favorites (a star on a space and on a page), **backlinks**.
  The API returns one entry per link, with its syntax, anchor, line and the
  line of text around it as context.
- **A page index.** Every page is parsed once, with a real Markdown parser,
  when it is scanned and when it is saved: headings (level, text and the same
  anchor the outline uses), block ids (`^id`), tags (`#tag` and `#a/b` in the
  text, outside code and links, plus `tags:` in the front matter (`labels:` is read as a synonym; Folio never removes or moves it)),
  the whole front matter as properties, and links of every kind —
  `[text](path)`, images, `[[…]]`, `![[…]]`, HTML `<a href>` / `<img src>` and
  reference-style `[x]: path` — with their `#heading` / `#^block` anchor and
  whether that anchor exists. Links are resolved in a second step for the
  whole space, so a page created later picks up the links that were waiting
  for it, and deleting a page turns the links to it into unresolved ones
  instead of dropping them (restoring it from the trash resolves them again).
  REST: `GET /api/pages/:id/meta`, `GET /api/spaces/:space/tags`,
  `GET /api/spaces/:space/unresolved-links`, and `GET /api/spaces/:space/orphans`
  (pages nothing links to); MCP: `get_page_metadata`, `list_unresolved_links`,
  `list_orphans`. Access is applied inside the query, as in search: tag and
  backlink counts never include pages you cannot open, and a link to such a
  page looks like a link to nothing. The interface for all this comes in the
  next waves.
- **Graph view.** A "Graph" row in the sidebar, under Tags, opens a map of the
  space: pages are nodes, links between them are edges, and tags, attachments
  and unresolved links can be switched on as nodes too. A "Local graph" section
  at the top of a document's right-hand panel (next to Outline and Notes) shows
  the page and its neighbours 1 to 3 links away, following links out of it, into
  it or both, with a button to open it full size. Hover highlights a node and
  its neighbours, click opens the page (a tag node opens the search `tag:x`),
  nodes can be dragged, the wheel or a pinch zooms, and on a touch screen the
  first tap selects a node (a card with Open and Neighbours). A compact settings
  panel, remembered per space, has filters in the search grammar (words,
  `tag:`, `kind:`, `status:`, `in:`) with toggles for Tags, Attachments,
  Unresolved links and Orphans; colour groups (by top folder, page kind, tag or
  your own query); display (arrows, text fade threshold, node size by number of
  links, link thickness); and the four layout forces (center, repel, link force,
  link distance). The server builds the graph from the page index in a handful
  of queries (5,000 pages in about 150 ms), and access is applied inside the
  query, as in search: a page you cannot open is never a node, a ghost or an
  edge. Past 10,000 readable pages the most recently changed 10,000 are kept and
  the view suggests the local graph. REST: `GET /api/spaces/:space/graph` and
  `GET /api/pages/:id/graph?depth=&direction=`; MCP: `get_graph`. The graph is
  drawn on a canvas by a small layout engine that loads only when a graph is
  opened.
  Links written the Folio way count like any other: the page URL "Copy link"
  gives, a pasted page address, `/s/<space>/p/<id>` (what the assistant and MCP
  write), the space home `/s/<space>` and a folder route, root-relative or on
  the instance's own host (`PUBLIC_URL`). They feed the graph, backlinks,
  orphans, unresolved links, bases and `get_backlinks`, across spaces too: a
  page of another space that you may open appears in the graph labelled
  "space / title" in its own colour. The "Tree structure" toggle (on by
  default) adds the page tree's parent → child lines, dashed, so nested pages
  show their place even without links; in the local graph the parent, the
  children and, two steps away, the siblings are neighbours. The local graph
  panel has a visible Depth label with a hint on each button (direct links /
  through one page / through two pages) and collapses from its header.
- A **tree** with drag and drop, a templates folder for creating "from a
  template", and the `.agent` folder (see section 11). The tree updates by
  itself.
- **Moving or renaming a page keeps links working**: relative links and images
  inside the page (and its subtree) are recalculated for the new location, and
  links to it from other pages are rewritten. The change is one commit,
  `docs: move <old> -> <new>` (`docs: rename …` for a slug).
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

### Properties, tags, search operators and space files

- **Properties panel** (collapsed by default): the page's front matter keys with
  types `text`, `number`, `checkbox`, `date`, `datetime`, `list`, `tags`,
  `aliases`. Types come from `.folio/properties.json` in the repository, or from
  `.obsidian/types.json` when that file is absent. Saving rewrites only the front
  matter block; every other byte of the file stays. `id` cannot be changed, and a
  Folio key holding a value Folio would not write itself (`status: deprecated`)
  is shown as a foreign value and never overwritten (except `status` in a vault, see
  below). **Reading mode is read-only:** properties are shown there, and added,
  edited or removed in Live and Source.
- **Properties update live.** When someone else changes a page's properties — in
  the panel, in a base cell, through MCP, by renaming a tag or with a Git sync —
  everyone who has the page open and may read it sees the change without a reload,
  and the bases of that space refresh. A field you are typing into is never
  overwritten: it shows "Someone else changed this to …", Enter keeps your value,
  Esc takes theirs, and changes to other keys are merged.
- **`status` in an Obsidian vault or a repository with files of its own is an
  ordinary property:** any value (`todo`, `doing`, `In Review`), editable in the
  panel and in a base cell, typed like any other key. Folio's own page status reads
  only `draft`, `published` and `archived` from it and takes anything else as
  `published`. In a native Folio space `status` stays Folio's key (draft, published,
  archived).
- **Properties on data tables, forms, boards and files** (PDF, Office): the same
  panel, as a thin row above the page with "Properties (N)" at its top left.
  A table or a form keeps them in its own front matter, next to Folio's reserved
  keys (the table schema, the form fields): those are never shown, never edited,
  and a table or form save never drops the properties. A board or a file keeps
  them in a sidecar, `.folio/<path>.props.yaml` (`docs/report.pdf` →
  `.folio/docs/report.pdf.props.yaml`): created with the first property, deleted
  with the last, one commit per save, and it follows the page through renames,
  moves, the trash and a restore. Their tags and properties work in search
  (`tag:`, `prop:`) and in MCP `get_page_metadata`; whoever can edit the page can
  edit them.
- **Tags:** a tag tree in the sidebar (`a/b` nests), a list of a tag's pages and a
  **bulk rename** (`#tag` in the text and `tags:` in the front matter, plus the
  tags of tables, forms, boards and files, only on pages you can edit). `labels:` is a synonym of `tags:`: new tags are written as `tags:`, an existing `labels:` is only ever edited in place, never moved or removed.
- **Search:** words, `"exact phrase"`, `-word`, `tag:`, `in:folder/`, `kind:`,
  `status:`, `prop:key=value`, plus **saved searches** (up to 50 per person) in Cmd+K.
- **Space files** are indexed as files: attachments and `assets/` are not in the
  tree or in search, but links to them are resolved, counted in backlinks and
  reported when missing.

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

**A reload does not cost you the work.** While you edit a form's definition, every
change is also kept as a draft in this browser (about half a second after you stop
typing, per form and per user): title, description, submit text, every field with
its help text and "required" flag, their order, and fields you have not saved yet.
Open the form again after a reload or a crashed tab and the editor opens with a
banner, "There is an unsaved draft from 14:05", with **Restore** and **Discard**.
Closing the editor with unsaved changes (the cross, Cancel, Escape or a click outside)
asks first: keep editing, close and keep the draft, or discard it. Reloading or
closing the tab with unsaved changes shows the browser's own warning. The draft is
removed when you save. It is not sent to the server on purpose: saving a form creates
real table columns for new fields, so it stays a deliberate step.

The same goes for **filling a form in**, signed in or through a share link: answers
are kept in this browser as you type, come back after a reload with a note, "Your
answers from 14:05 were restored. Clear", and are dropped once the response is sent.
Leaving the page with unsent answers shows the browser's warning. File contents and
sensitive field types are never stored.

## 11. Folio AI

An assistant in the side panel with two modes: **Ask** (read only) and
**Agent** (read and write). Each person adds a Cursor API key in their account
settings, or an administrator provides a shared one (see "Who pays" below).

The assistant uses **the same set of tools** as external clients do through
MCP (section 12). In Ask mode the write tools are unavailable, and that is
checked on the server, not only in the interface.

While a run streams, the status line shows what the agent is doing: its
thinking with a token counter, an elapsed-time counter (after about three
seconds of silence, for example while a long page is written) and the real name
of the tool being called. The live reply keeps paragraph breaks and renders
Markdown links. The server logs the timing of each step of a run (agent ready,
first text, each tool, rounds, token totals) and stores it with the run
(`ai_runs.timing`, migration 052); no arguments or results are recorded.

**Your own agent in every space — `.agent`.** A folder of ordinary pages in
the space, visible to and editable by space administrators only. Everything in
it — the agent's role, tone, glossary, rules, templates — is added to every
assistant run in that space, in Ask and Agent modes alike. Each space can
therefore have an agent of its own, and its instructions are versioned in Git
like any other page. About 60,000 characters of instructions are used; if
there is more, whole pages at the end are left out and the assistant is told
so.

**Writing rules.** A page named `writing-rules` in `.agent` holds the team's
style rules (administrators can add a starter with "Create writing rules" in
the `.agent` section of the sidebar). It is a normal page: edit it, review it in
Git. With it in place, a page's header shows **Check against writing rules**:
the assistant, in Ask mode (read only), compares the page with every rule and
lists the findings (rule, quoted fragment, suggested rewrite) in the assistant
panel. **Fix with Agent** under the findings asks Agent mode to apply the
rewrites, touching only the quoted fragments. The button is not shown when the
space has no writing rules, and is disabled, with the reason in its tooltip,
when no Folio AI key works or another run is in progress. The MCP tool
`check_page_writing_rules` returns the rules and a page's text to an external
agent so it can lint a draft before writing. Members who are not administrators
can use the check and the tool, although they cannot open `.agent`; a rules
page restricted to named people is hidden from everyone else.

**Answer quality and analytics.** Every saved assistant answer can be rated
👍 or 👎 (one rating per answer, changeable). After every third answer in a
conversation the panel asks "Did the assistant solve your question?" (Yes,
Partly, No, Not now, with an optional comment). The assistant also records
questions it could not answer or was unsure about, with the reason ("No
answer" or "Not sure") and what was missing, with links to the pages it read;
it does this through a built-in
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

**Who pays: personal, space and instance keys.** A run uses the first key that
exists, in this order: the person's own key, the key of the space the question
is asked in, the key of the instance, `CURSOR_API_KEY` from the server
environment. A space administrator sets the key of a space (space menu, "Folio
AI key"); an instance administrator sets the instance key (the "Shared key"
tab of Assistant analytics) and can turn personal keys off so that everyone
uses the shared one: a stored personal key is then ignored and the form for
adding one is hidden. The assistant settings show
whose key is in use. Shared keys are encrypted with `FOLIO_SECRET`, never
returned by the API (only the key's name, the Cursor account and who set it
and when) and every change is written to the audit log. The public demo
cannot change them.

**Ask Folio AI on a public site.** A space administrator can let visitors of a
published space ask questions (opt-in per space; "Ask AI about this space" on
the site). Visitors are anonymous. The run is **Ask mode only**, confined to
that one space and to its public pages: it cannot write, cannot read page
history, and a page that is restricted, in `.agent` or a template is "not
found" to it, like any other page that does not exist. It uses the key of the
space, else of the instance, else `CURSOR_API_KEY`; the owner of that key pays,
and without any key the site says Folio AI is not set up. A conversation is
tied to the browser that started it by a random token (only its hash is
stored). Questions are rate limited per address and per site
(`PUBLIC_ASSISTANT_RUNS_PER_HOUR`, default 20; `PUBLIC_ASSISTANT_SPACE_RUNS_PER_HOUR`,
default 200) and appear in the analytics as "Public visitor". The space's
`.agent` rules are part of every run, public ones included: do not put
anything secret in them.

Runs live **on the server**, not in the browser tab: close the browser and the
work continues; come back and read on from where it stopped.

## 12. Integration for external tools (MCP)

The `/mcp` endpoint with a personal access token (`folio_pat_…`), scopes
`read` and `write`. 49 tools: listing spaces and trees, reading a page,
search (plus `search` and `fetch` for ChatGPT deep research), creating and updating pages, resolving a Folio link, backlinks
with context, a page's metadata (outline, tags, properties, links), a space's
unresolved links and orphan pages, the link graph of a space or a page's neighbourhood, the rows of an Obsidian base (and creating or replacing one), publishing an interactive artifact, listing a space's templates and creating pages from them or saving a page as a template, checking a page against the space's writing rules, a space's tags and property keys, renaming a tag across a space, setting a page's properties, history and reading a page at a given
commit, working with whiteboards (and converting an Obsidian canvas into one), a full set of operations on data tables (rows, columns, views), and building forms with the table their answers go to.
See [MCP.md](MCP.md).

### Link previews in Slack and Microsoft Teams

A Folio link pasted into Slack or Teams unfurls into a card: icon and title,
`Space / Parent / Page`, the first lines of text, the section headings, tags,
the last update and who made it, and for a data table its rows and columns. Each
person connects their own Folio account once, from the chat app, through
Folio's own OAuth consent screen, and the card is built with that person's
access: a page they cannot open gives a card with no title at all. Because a
preview is seen by the whole conversation, a page restricted to specific people
shows its title only. Share links and public-site pages unfurl for anyone.
People disconnect in API tokens → Chat apps; instance administrators see the
setup and every connection in Administration → Chat integrations. Setup:
[CHAT-PREVIEWS.md](CHAT-PREVIEWS.md).

## 13. Import, export and the rest

**Privacy of the installation.** Folio sends no telemetry. An optional hook for
a PostHog project of your own (`FOLIO_POSTHOG_KEY`) exists for people running
a public demo; with no key set, no analytics library is loaded and no
connection is opened. Likewise opt-in: error reporting to a Sentry project of
your own (`SENTRY_DSN`) with a "Report a problem" item in the user menu, the board help dialog's
"Found an issue?" link and the error screens; reports can carry a recording of
recent actions with all text masked (`SENTRY_REPLAY=0` turns recording off); it
never sends page content, and with no DSN set nothing is loaded or contacted
(see [INSTALL.md](INSTALL.md#optional-error-reporting-off-by-default)). **Link previews:** the front page carries Open Graph and
Twitter card tags (title, description, 1200x630 picture), neutral by default
and set with `FOLIO_OG_TITLE`, `FOLIO_OG_DESCRIPTION` and `FOLIO_OG_IMAGE`.
See [INSTALL](INSTALL.md).

- **Import from Confluence**: a page or a tree, converting panels into
  callouts, code, checkboxes, status macros (as status tags), underline and
  images; the imported root never replaces the space's home page; Confluence **whiteboards** become
  Excalidraw boards.
- **File upload**: images, and also pdf/docx/xlsx/pptx — they become pages in
  the tree.
- **Images in the repository**: a space admin can turn on "Store images in the
  repository" (space menu → Image storage). New pasted or dropped images then go
  to `assets/` in the space's folder (`docs/assets/` for a space with a root
  path), are committed with the page, and are linked by a **relative** path
  (`../assets/diagram.png`), so they also show on GitHub. By default images are
  kept in Folio's storage; images already in pages do not move.
- **Replace a file page with a new version**: the tree menu item "Replace with
  new version…", a button in the page header (editors), or a file dropped
  on the open page. The page keeps its id, link, place in the tree, access and
  stars; a different file type renames the file and rewrites links to it.
  Every replace is a commit of its own, an "Undo" toast restores the previous
  version, and the history panel restores any older one.
- **Export**: `md`, `pdf`, `docx`, `yaml`, print, and a zip of the whole
  space. Export with child pages and custom page headers and footers for a
  space are supported (set on the **PDF** tab of the space's Site & PDF
  settings, see section 7). If an export had to be cut by size, the response
  headers say so.
- **Trash** with restore. Deleting a page that has children takes them along,
  and restoring brings them back.
- **Notifications** about access requests, delivered instantly.
- **Interface languages**: English and Ukrainian; a new language is a set
  of bundle files. Content is not translated — it is data.
- **Theme**: light, dark, system.
- **Mobile**: responsive layout, a separate mobile mode for tables. There is
  no separate app.
