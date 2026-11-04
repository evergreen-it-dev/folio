/**
 * `outputSchema` of every MCP tool (spec 2025-06-18, "Structured content"). The tools answer in two forms at
 * once: `structuredContent` (validated by the SDK against these schemas) and the same data as JSON text in
 * `content`, which older clients and models without structured-output support still read.
 *
 * The root of an output schema must be an object, so a tool whose natural answer is an array wraps it under one
 * named key (`{ spaces: [...] }`); the text form keeps the bare array it always had.
 *
 * Every object is loose (extra keys allowed) and anything the server could not promise on every code path is
 * optional: a schema that is stricter than the data would turn a working call into an error. `kind`/`status`
 * are plain strings for the same reason — the enums live in shared/contracts.ts and can grow.
 */
import { z } from 'zod';

export const pageMetaOutput = z.looseObject({
  id: z.string().describe('Page id'),
  space: z.string().describe('Space slug the page belongs to'),
  path: z.string().describe('Path relative to the space root'),
  kind: z.string().describe('Page kind: doc, board, table, form, base, canvas, artifact, pdf or office'),
  title: z.string().describe('Page title'),
  order: z.number().describe('Position among its siblings'),
  status: z.string().describe('Page status'),
  updatedAt: z.string().describe('Last change, ISO timestamp'),
  icon: z.string().optional().describe('Emoji icon, if the page has one'),
  cover: z.string().optional().describe('Cover image URL, if the page has one'),
});

const commentPersonOutput = z.looseObject({ name: z.string(), username: z.string().nullable().describe('Handle used in @mentions') }).nullable().describe('null when the account was deleted');

const commentThreadOutput = z.looseObject({
  id: z.string().describe('Thread id — pass it to reply_comment'),
  status: z.string().describe('open or resolved'),
  quotedText: z.string().describe('The text of the page the thread is attached to'),
  createdBy: commentPersonOutput,
  createdAt: z.string().describe('ISO timestamp'),
  resolvedBy: commentPersonOutput,
  resolvedAt: z.string().nullable().describe('ISO timestamp; null while open'),
  comments: z
    .array(
      z.looseObject({
        id: z.string().describe('Comment id'),
        author: commentPersonOutput,
        body: z.string().describe('The comment text'),
        createdAt: z.string().describe('ISO timestamp'),
        editedAt: z.string().nullable().describe('ISO timestamp; null when never edited'),
      }),
    )
    .describe('Oldest first; the first is the opening comment'),
});

const pageList = (key: string, what: string) => ({ [key]: z.array(pageMetaOutput).describe(what) });

const linkRefOutput = z.looseObject({
  targetPath: z.string().describe('What the link points at, relative to the space root'),
  targetPageId: z.string().nullable().describe('Id of the target page; null when it is not a page you can see'),
  syntax: z.string().describe('md, wikilink, embed, image, html or reference'),
  kind: z.string().describe('page, asset, external or unresolved'),
  fragment: z.string().nullable().describe('#heading or #^block part, as written'),
  fragmentKind: z.string().nullable().describe('heading or block'),
  fragmentResolved: z.boolean().nullable().describe('Whether the heading/block exists on the target page'),
  displayText: z.string().nullable().describe('Link text, alt text or wikilink alias'),
  line: z.number().describe('Line in this page'),
  context: z.string().describe('The source line, trimmed'),
});

const columnOutput = z.looseObject({
  id: z.string().describe('Column id — what the folio_table_* tools take as a key'),
  name: z.string().describe('Column title'),
  type: z.string().describe('Column type (text, number, select, status, date, checkbox, ...)'),
  description: z.string().optional().describe('Hint shown in the column header'),
  options: z.array(z.looseObject({})).optional().describe('Allowed values of a select or status column'),
});

const formOutput = z
  .looseObject({
    title: z.string().describe('Form title'),
    description: z.string().optional().describe('Text shown above the questions'),
    public: z.boolean().describe('Accepts answers from anyone with a share link of the form'),
    submitButton: z.string().optional().describe('Label of the submit button'),
    fields: z
      .array(
        z.looseObject({
          columnId: z.string().describe('Column of the paired table the answer goes to'),
          label: z.string().describe('The question'),
          help: z.string().optional().describe('Hint under the question'),
          required: z.boolean().describe('The form cannot be sent without it'),
          kind: z.string().describe('Column type: text, longtext, number, date, checkbox, select, status, user or link'),
        }),
      )
      .describe('The questions, in order'),
    table: z.looseObject({ id: z.string().nullable().describe('Page id of the paired table (null when it cannot be found)'), path: z.string() }).describe('The data table the answers are rows of'),
  })
  .describe('The form definition');

const cellValueOutput = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]);
const rowOutput = z.looseObject({
  id: z.string().describe('Row id'),
  values: z.record(z.string(), cellValueOutput).describe('Cell values keyed by column id'),
});

type TreeNodeOutput = z.infer<typeof pageMetaOutput> & { children: TreeNodeOutput[] };
const treeNodeOutput: z.ZodType<TreeNodeOutput> = z.lazy(() =>
  pageMetaOutput.extend({ children: z.array(treeNodeOutput).describe('Child pages') }),
);

export interface TagNodeOutput {
  tag: string;
  name: string;
  pages: number;
  total: number;
  children: TagNodeOutput[];
}
const tagNodeOutput: z.ZodType<TagNodeOutput> = z.lazy(() =>
  z.looseObject({
    tag: z.string().describe('The whole tag, lowercase, hierarchy as a/b — what tag: searches and rename_tag take'),
    name: z.string().describe('Last segment of the tag'),
    pages: z.number().describe('Pages the caller can open that carry exactly this tag'),
    total: z.number().describe('Pages the caller can open that carry this tag or one of its children'),
    children: z.array(tagNodeOutput).describe('Child tags (tag/…)'),
  }),
);

const propertiesStateOutput = {
  properties: z.record(z.string(), z.unknown()).describe('The page\'s properties after the call, as the API returns them (dates as text)'),
  types: z.record(z.string(), z.string()).describe('Effective type of each key: text, number, checkbox, date, datetime, list, tags, aliases'),
  foreign: z.array(z.string()).describe('Folio-owned keys (order, status, icon, cover, id) holding a value Folio would not write itself; they are kept as they are'),
  readOnly: z.array(z.string()).describe('Keys that cannot be edited (id of a document)'),
};

export const outputSchemas = {
  list_spaces: {
    spaces: z
      .array(
        z.looseObject({
          slug: z.string().describe('Space slug'),
          name: z.string().describe('Space name'),
          pageCount: z.number().describe('Number of pages in the space'),
          myRole: z.string().optional().describe("The caller's own role in the space: viewer, editor or admin"),
        }),
      )
      .describe('Spaces the caller can see'),
  },
  list_tree: { tree: z.array(treeNodeOutput).describe('Top-level pages of the space; each carries its children') },
  read_page: {
    ...pageMetaOutput.shape,
    markdown: z.string().optional().describe('Document body as Markdown (doc pages)'),
    svg: z.string().optional().describe('Raw SVG source (board pages when no layout summary applies)'),
    scene: z.record(z.string(), z.unknown()).nullable().optional().describe('Board layout summary: shapes, arrows, texts, frames, layout rows/cols, bounds; null when the board has no readable scene'),
    note: z.string().optional().describe('Why the content is not returned (PDF/Office file, unreadable board)'),
    outline: z.string().optional().describe('Obsidian canvas pages (kind "canvas"): a readable Markdown outline — groups with their cards (text, notes, files, links; geometry and colour), then the connections. Read-only'),
    form: formOutput.optional().describe('Form pages (kind "form"): settings, fields and the paired table'),
    etag: z.string().optional().describe('Form pages: pass it to update_form'),
    artifact: z
      .looseObject({
        manifest: z.looseObject({}).describe('artifact.yaml as read: type, title, icon, entry, source, embed, capabilities'),
        properties: z.record(z.string(), z.unknown()).describe('Page properties (the manifest\'s own keys)'),
        files: z.array(z.looseObject({ path: z.string(), size: z.number() })).describe('Files of the artifact'),
        warnings: z.array(z.string()),
        entryTruncated: z.boolean().describe('True when entryHtml was cut'),
      })
      .optional()
      .describe('Artifact pages (kind "artifact"): an interactive HTML page; replace it with publish_artifact'),
    entryHtml: z.string().optional().describe('Artifact pages: the HTML of the entry page'),
  },
  page: pageMetaOutput.shape,
  list_templates: {
    templates: z.array(pageMetaOutput.extend({ description: z.string().optional().describe('What the template is for, when it has a description') })).describe('Templates of the space'),
  },
  board_ops: {
    summary: z.string().describe('What the operations changed'),
    elements: z.record(z.string(), z.unknown()).describe('Layout summary of the board after the operations'),
  },
  search_pages: {
    hits: z
      .array(
        z.looseObject({
          id: z.string().describe('Page id'),
          space: z.string().describe('Space slug'),
          path: z.string().describe('Path relative to the space root'),
          title: z.string().describe('Page title'),
          snippet: z.string().describe('Matching excerpt'),
          kind: z.string().optional().describe('Page kind: doc, board, table, form, pdf, office or canvas'),
          tags: z.array(z.string()).optional().describe('Normalized tags of the page (lowercase, hierarchy as a/b)'),
        }),
      )
      .describe('Matching pages, best first (operator-only queries: most recently changed first)'),
  },
  search: {
    results: z
      .array(z.looseObject({ id: z.string().describe('Page id — pass it to fetch'), title: z.string().describe('Page title'), url: z.string().describe('Link to the page in Folio') }))
      .describe('Matching pages'),
  },
  fetch: {
    id: z.string().describe('Page id'),
    title: z.string().describe('Page title'),
    text: z.string().describe('Page content as Markdown'),
    url: z.string().describe('Link to the page in Folio'),
    metadata: z.looseObject({ space: z.string(), path: z.string(), kind: z.string(), updatedAt: z.string() }).describe('Space, path, kind and last change of the page'),
  },
  resolve_folio_url: {
    ...pageMetaOutput.shape,
    parentPathForChildren: z.string().describe('Pass as parentPath to create_page to add a child under this page'),
    note: z.string().describe('Reminder to work within this page'),
  },
  get_backlinks: {
    backlinks: z
      .array(
        pageMetaOutput.extend({
          syntax: z.string().optional().describe('How the link is written: md, wikilink, embed, image, html or reference'),
          fragment: z.string().nullable().optional().describe('The #heading or #^block part of the link, as written'),
          line: z.number().optional().describe('Line of the link in the source page'),
          context: z.string().optional().describe('The source line, trimmed (at most 300 characters)'),
        }),
      )
      .describe('Links into the given page, one entry per link, with the source page'),
  },
  get_page_metadata: {
    id: z.string().describe('Page id'),
    space: z.string().describe('Space slug'),
    path: z.string().describe('Path relative to the space root'),
    title: z.string().describe('Page title'),
    headings: z
      .array(z.looseObject({ level: z.number(), text: z.string(), slug: z.string().describe('Anchor of the heading (#slug)'), line: z.number() }))
      .describe('Headings in document order'),
    blocks: z.array(z.looseObject({ blockId: z.string().describe('The id after ^'), line: z.number() })).describe('Block ids (^id) of the page'),
    tags: z
      .array(z.looseObject({ tag: z.string(), source: z.string().describe('body (#tag) or frontmatter (tags/labels)'), line: z.number().nullable() }))
      .describe('Tags, lowercased, without #'),
    properties: z.record(z.string(), z.unknown()).describe('The whole front matter of the page'),
    links: z.array(linkRefOutput).describe('Outgoing links in document order'),
    backlinkCount: z.number().describe('Links into this page from pages the caller can see'),
    metaVersion: z.number().describe('Version of the parser that indexed the page'),
  },
  list_unresolved_links: {
    links: z
      .array(
        z.looseObject({
          sourceId: z.string().describe('Id of the page holding the link'),
          sourcePath: z.string(),
          sourceTitle: z.string(),
          targetPath: z.string().describe('What the link points at'),
          syntax: z.string(),
          fragment: z.string().nullable(),
          line: z.number(),
          context: z.string(),
        }),
      )
      .describe('Unresolved links, sorted by target path, then source path'),
    total: z.number().describe('Unresolved links in the space before limit/offset'),
  },
  list_orphans: {
    pages: z
      .array(z.looseObject({ id: z.string(), path: z.string(), title: z.string(), updatedAt: z.string() }))
      .describe('Pages nothing the caller can see links to'),
  },
  get_graph: {
    nodes: z
      .array(
        z.looseObject({
          id: z.string().describe('Page id, or tag:<tag> / file:<path> / ghost:<path> for a tag, a space file, a link target that does not exist'),
          title: z.string(),
          kind: z.string().describe('Page kind (doc, board, table, pdf, office, form), or tag, file, unresolved'),
          path: z.string().optional(),
          tags: z.array(z.string()).optional(),
          degree: z.number().describe('Distinct neighbours in this answer'),
        }),
      )
      .describe('Pages the caller can open, plus tag, file and unresolved nodes when asked for'),
    edges: z
      .array(z.looseObject({ source: z.string(), target: z.string(), count: z.number().describe('Links of the source to the target') }))
      .describe('Links between the nodes, source -> target'),
    totalPages: z.number().describe('Readable pages in scope before the limit'),
    truncated: z.boolean().describe('True when pages were left out because of the limit'),
    limit: z.number(),
    center: z.string().optional().describe('The page the neighbourhood is around'),
  },
  list_tags: {
    tags: z.array(tagNodeOutput).describe('Tag tree of the space, in alphabetical order; a tag without pages of its own is listed when a child has some'),
    totalTags: z.number().describe('Tags matching the prefix, before the limit'),
    truncated: z.boolean().describe('True when tags were left out because of the limit'),
  },
  rename_tag: {
    from: z.string().describe('The tag that was renamed, normalized'),
    to: z.string().describe('Its new name, normalized'),
    pagesChanged: z.number().describe('Pages whose tags were rewritten (body #tags, tags:/labels: front matter, sidecars)'),
    pagesSkipped: z.number().describe('Pages that carry the tag, that the caller can open but not edit (or that could not be written); they keep the old tag. Pages the caller cannot open are not counted'),
  },
  set_page_properties: {
    id: z.string().describe('Page id'),
    written: z.boolean().describe('False when the properties already were as asked: nothing was written'),
    changedKeys: z.array(z.string()).describe('Keys set or removed by this call'),
    etag: z.string().nullable().describe('Etag of the properties after the call — pass it to the next set_page_properties; null when the page has no front matter'),
    ...propertiesStateOutput,
  },
  list_properties: {
    properties: z
      .array(
        z.looseObject({
          key: z.string().describe('Property name'),
          type: z.string().describe('text, number, checkbox, date, datetime, list, tags or aliases'),
          declared: z.boolean().describe('True when the space declares this type (.folio/properties.json or .obsidian/types.json); false when it is inferred from the values'),
          pages: z.number().describe('Pages the caller can open that have this property'),
          samples: z.array(z.unknown()).describe('A few of the most common values'),
        }),
      )
      .describe('Properties of the space, most used first'),
    source: z.string().describe('Where the declared types came from: folio, obsidian or none'),
    truncated: z.boolean().describe('True when keys were left out because of the cap'),
  },
  save_base: {
    id: z.string().describe('Page id of the base'),
    space: z.string(),
    path: z.string().describe('Path of the .base file relative to the space root'),
    created: z.boolean().describe('True when a new base was created, false when an existing one was updated'),
    written: z.boolean().describe('False when the file already held exactly this YAML'),
    etag: z.string().describe('Etag of the file now — pass it as etag on the next update'),
    warnings: z.array(z.string()).describe('Parts of the YAML that were read leniently (a view or filter of an unknown shape is ignored by the reader); the file keeps them as written'),
    preview: z.looseObject({}).describe('The first view answered the way query_base does, at most 10 rows: view, views, columns, rows, total, truncated, warnings, error?'),
  },
  query_base: {
    view: z.string().nullable().describe('The view answered (null: the base has no views, a default table)'),
    views: z.array(z.looseObject({ name: z.string(), type: z.string(), supported: z.boolean() })).describe('The views of the base'),
    columns: z.array(z.looseObject({ id: z.string(), label: z.string() })).describe('Property ids (note.x / file.x / formula.x) and their display names'),
    rows: z
      .array(z.looseObject({ id: z.string().describe('Page id'), title: z.string(), path: z.string(), values: z.record(z.string(), z.unknown()) }))
      .describe('One page per row, values by column id'),
    groups: z.array(z.looseObject({ key: z.unknown(), count: z.number() })).optional(),
    summaries: z.record(z.string(), z.unknown()).optional(),
    total: z.number().describe('Rows after the filters, before offset/limit'),
    truncated: z.boolean().describe('More pages matched than a base evaluates'),
    warnings: z.array(z.string()),
    error: z.string().optional().describe('The base file could not be read'),
  },
  list_comments: {
    threads: z.array(commentThreadOutput).describe('Comment threads of the page, oldest first'),
    canComment: z.boolean().describe('Whether the caller may add comments and replies'),
    canModerate: z.boolean().describe('Whether the caller may resolve any thread and delete any comment (an editor of the page)'),
  },
  check_page_writing_rules: {
    hasRules: z.boolean().describe('Whether the space has a writing-rules page (.agent/writing-rules.md) this caller can read'),
    space: z.string().describe('Space slug'),
    page: z.looseObject({ id: z.string(), title: z.string(), path: z.string(), markdown: z.string().describe('The page text; empty for a page that is not a document') }),
    rules: z
      .looseObject({ id: z.string().describe('Id of the rules page'), path: z.string(), title: z.string(), markdown: z.string().describe('The rules, as written by the team') })
      .nullable()
      .describe('null when the space has no writing rules'),
    instructions: z.string().describe('How to apply the rules to the page'),
  },
  add_comment: { thread: commentThreadOutput.describe('The new thread') },
  reply_comment: {
    comment: z.looseObject({
      id: z.string().describe('Comment id'),
      threadId: z.string(),
      body: z.string(),
      createdAt: z.string().describe('ISO timestamp'),
    }),
  },
  page_history: {
    revisions: z
      .array(
        z.looseObject({
          sha: z.string().describe('Commit sha — pass it to page_at_sha'),
          author: z.string().describe('Commit author'),
          date: z.string().describe('Commit date, ISO timestamp'),
          message: z.string().describe('Commit message'),
        }),
      )
      .describe('Revisions of the page, newest first'),
  },
  page_at_sha: {
    markdown: z.string().optional().describe('Body at that revision (doc and table pages)'),
    svg: z.string().optional().describe('Raw SVG at that revision (board pages)'),
    file: z.looseObject({ path: z.string(), ext: z.string(), size: z.number() }).optional().describe('Path, extension and size of a PDF/Office file at that revision'),
  },
  folio_table_list: pageList('tables', 'Data table pages'),
  folio_table_schema: {
    meta: z.looseObject({}).describe('Table metadata, including whether rows carry ids (rowIds mode)'),
    columns: z.array(columnOutput).describe('Columns in display order'),
    views: z.array(z.looseObject({})).describe('Saved views with their filter and sort'),
    rowCount: z.number().describe('Number of rows in the table'),
  },
  folio_table_query: {
    rows: z.array(rowOutput).optional().describe('Matching rows (format "json")'),
    columns: z.array(columnOutput).optional().describe('Columns of the table (format "json")'),
    markdown: z.string().optional().describe('Matching rows as a GFM table (format "markdown")'),
    total: z.number().describe('Rows matching the query before limit/offset'),
  },
  folio_table_insert: {
    rows: z.array(rowOutput).describe('The rows that were added, with their new ids'),
    rowCountWarning: z.string().optional().describe('Set when the table is getting large'),
  },
  folio_table_update: {
    id: z.string().optional().describe('Id of the updated row (update by rowId)'),
    values: z.record(z.string(), cellValueOutput).optional().describe('The row after the update (update by rowId)'),
    affected: z.number().optional().describe('Rows changed (update by filter)'),
  },
  folio_table_delete: { affected: z.number().describe('Rows deleted') },
  folio_table_add_column: columnOutput.shape,
  folio_table_create: pageMetaOutput.shape,
  folio_table_update_column: {
    column: columnOutput.describe('The column after the change'),
    converted: z.number().describe('Values converted to the new type'),
    cleared: z.number().describe('Values that could not be converted and were cleared'),
  },
  folio_table_delete_column: { deleted: z.string().describe('Id of the deleted column') },
  folio_table_save_view: {
    created: z.boolean().describe('True when a new view was added'),
    view: z.looseObject({ id: z.string().describe('View id'), name: z.string() }).describe('The view after the call: filter, sort, columns (hidden, order), frozen, rowHeight'),
  },
  folio_table_delete_view: { deleted: z.string().describe('Id of the deleted view') },
  form_write: {
    ...pageMetaOutput.shape,
    form: formOutput,
    etag: z.string().describe('Etag of the form now — pass it to the next update_form'),
    tableId: z.string().describe('Page id of the paired table (its rows are the answers)'),
    columnsAdded: z.array(z.string()).describe('Ids of the columns this call added to the paired table'),
  },
  convert_canvas_to_board: {
    board: pageMetaOutput.describe('The new board page'),
    report: z.looseObject({ losses: z.array(z.looseObject({ code: z.string(), count: z.number() })).describe('What the board could not carry over, by kind') }).describe('What the conversion lost'),
  },
  publish_artifact: {
    id: z.string().describe('Page id of the artifact'),
    space: z.string(),
    path: z.string().describe('Path of the artifact folder (<slug>.artifact) relative to the space root'),
    title: z.string().describe('Page title'),
    created: z.boolean().describe('True when a new artifact was created, false when an existing one was replaced'),
    url: z.string().describe('Link to the page in Folio'),
    warnings: z.array(z.string()).describe('Non-fatal notes (e.g. a capability Folio does not provide)'),
  },
} as const;
