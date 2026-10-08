/**
 * Round 23 (EXPORT), Stage 3 — DOCX from the markdown AST via the `docx` npm
 * library.
 *
 * WHY NOT PANDOC (orchestrator's decision, DEV-PLAN R23): pandoc is another
 * ~180 MB of binary for one format, when the mapping of
 * headings/lists/tables/images is something this codebase already knows. The
 * documented, honest cost of that choice — say it out loud to the owner —
 * is that DOCX gets a BASE style mapping and the space's export CSS does NOT
 * apply to it. Word styling and CSS are not the same model, and pretending
 * otherwise would produce a document that looks almost-right and is wrong.
 *
 * Two format-specific rules from the spec are implemented here:
 *  - data tables become NATIVE Word tables with the header row marked
 *    repeating (`tableHeader: true`), R23 addendum 4;
 *  - boards are RASTERIZED to PNG with the same chromium the PDF path uses
 *    ("SVG in DOCX is unreliable", R23 addendum 3) and inserted with the board
 *    page's title as a caption. If chromium is unavailable the board
 *    degrades to its caption plus a link — the DOCX still builds.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  Node,
  Nodes,
  Parent,
  PhrasingContent,
  RootContent,
  Table as MdTable,
  TableCell as MdTableCell,
  TableRow as MdTableRow,
} from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  HighlightColor as DocxHighlightColor,
  ImageRun,
  LevelFormat,
  Packer,
  PageBreak,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
  convertInchesToTwip,
} from 'docx';
import * as storage from '../storage.js';
import type { PageIndexEntry } from '../storage.js';
import { rasterizeSvg } from './pdf.js';
import {
  groupLegacyMarkupSpans,
  isHighlightGroup,
  splitHighlightMarkers,
  type HighlightColor,
  type HighlightItem,
  type HighlightTextAdapter,
} from '../../shared/highlight.js';
import { remarkUnderline } from '../../shared/underline.js';
import { DECODED_STATUS_RE, STATUS_PALETTE, cleanStatusLabel, parseStatusAttrs, resolveStatusColor } from '../../shared/status.js';

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkUnderline);

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

const ORDERED_REFERENCE = 'folio-ordered';
/** Body width of an A4 page at the margins below, in twips — what a full-width image/table may occupy. */
const CONTENT_WIDTH_TWIPS = convertInchesToTwip(6.1);
const CONTENT_WIDTH_PX = 620;

/** One of docx's own `HighlightColor` names ("yellow", "cyan", …) — see `DOCX_HIGHLIGHT_BY_TOKEN` below for how our 8-token palette maps onto them. */
type DocxHighlightName = (typeof DocxHighlightColor)[keyof typeof DocxHighlightColor];

interface InlineStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  underline?: { type: typeof UnderlineType.SINGLE };
  code?: boolean;
  highlight?: DocxHighlightName;
}

/**
 * docx's `TextRun.highlight` only accepts a fixed enum of names (see
 * `node_modules/docx`'s own `HighlightColor`) — none literally "teal",
 * "purple", or "orange", and only the LIGHT ones are usable as a highlight
 * a reader can still read black text through (a `dark*` entry renders as
 * near-solid ink). teal and blue both land on the closest light option,
 * "cyan"; purple and red both land on "magenta"; orange has no light
 * equivalent at all, so it falls back to "yellow", same as the default.
 * Two tokens sharing one Word colour is an accepted, documented loss —
 * this file's own top comment already says DOCX gets a base style mapping,
 * not a byte-for-byte match of the web palette.
 */
const DOCX_HIGHLIGHT_BY_TOKEN: Record<HighlightColor, DocxHighlightName> = {
  yellow: DocxHighlightColor.YELLOW,
  green: DocxHighlightColor.GREEN,
  teal: DocxHighlightColor.CYAN,
  blue: DocxHighlightColor.CYAN,
  purple: DocxHighlightColor.MAGENTA,
  red: DocxHighlightColor.MAGENTA,
  orange: DocxHighlightColor.YELLOW,
  gray: DocxHighlightColor.LIGHT_GRAY,
};

interface DocxContext {
  space: string;
  baseUrl: string;
  /** Images already read/rasterized, keyed by their resolved absolute path. */
  imageCache: Map<string, { data: Buffer; width: number; height: number } | null>;
}

// ---------------------------------------------------------------------------
// inline
// ---------------------------------------------------------------------------

/** `splitHighlightMarkers`'s view of an mdast node: only a `text` node has text of its own; everything else (including a `strong`/`emphasis`/... node) is an opaque atom to it. */
const mdastHighlightAdapter: HighlightTextAdapter<PhrasingContent> = {
  getText: (node) => (node.type === 'text' ? node.value : undefined),
  makeText: (value) => ({ type: 'text', value }) as PhrasingContent,
};

const MARK_OPEN_RE = /^<mark(?:\s[^>]*)?>$/i;
const MARK_CLOSE_RE = /^<\/mark\s*>$/i;

/**
 * This processor never runs remark-rehype/rehype-raw (see file top comment
 * and shared/highlight.ts's own doc comment on why), so a legacy
 * `<mark>text</mark>` survives parsing as two literal `html`-type mdast
 * siblings around ordinary text, not as one parsed element — this is what
 * `groupLegacyMarkupSpans` needs to recognise which is which.
 */
function markTag(node: PhrasingContent): 'open' | 'close' | undefined {
  if (node.type !== 'html') return undefined;
  const value = node.value.trim();
  if (MARK_OPEN_RE.test(value)) return 'open';
  if (MARK_CLOSE_RE.test(value)) return 'close';
  return undefined;
}

/**
 * Entry point for a run of sibling `PhrasingContent` — a paragraph's,
 * heading's, table cell's, or list item's inline content, AND (via the
 * `strong`/`emphasis`/`delete`/`link`/fallback cases in `runsFor` below,
 * which all call back into this instead of `runsFor` directly) every
 * nested run too, so `**bold ==x== text**` is caught just as well as a
 * bare `==x==`. Resolves BOTH highlight spellings — legacy `<mark>` first
 * (it's unambiguous, no flanking rule), then `==`/`=={.token}` on what's
 * left, so a `==` span is free to sit next to (never inside) a legacy one —
 * before handing the result to `renderHighlightItems`.
 */
function renderInline(nodes: readonly PhrasingContent[], style: InlineStyle): (TextRun | ExternalHyperlink)[] {
  const items = splitHighlightMarkers(groupLegacyMarkupSpans(nodes, markTag), mdastHighlightAdapter);
  return renderHighlightItems(items, style);
}

/** Splits a resolved `HighlightItem` list back into plain-node batches (rendered via `runsFor`) and highlight groups (recursed into with the group's docx `highlight` colour folded into `style`). */
function renderHighlightItems(
  items: readonly HighlightItem<PhrasingContent>[],
  style: InlineStyle,
): (TextRun | ExternalHyperlink)[] {
  const out: (TextRun | ExternalHyperlink)[] = [];
  let batch: PhrasingContent[] = [];
  const flush = (): void => {
    if (batch.length === 0) return;
    out.push(...runsFor(batch, style));
    batch = [];
  };
  for (const item of items) {
    if (isHighlightGroup(item)) {
      flush();
      out.push(...renderHighlightItems(item.children, { ...style, highlight: DOCX_HIGHLIGHT_BY_TOKEN[item.token] }));
    } else {
      batch.push(item);
    }
  }
  flush();
  return out;
}

/**
 * A text node's runs. Ordinary text is one run; a `:status[Text]{color=…}` tag
 * inside it (this processor has no remark-directive, so it is still text here)
 * becomes a small bold, capitalised run on the lozenge's own background colour
 * — the Word equivalent of the badge, readable even where shading is dropped.
 */
function textRuns(value: string, style: InlineStyle): TextRun[] {
  const font = style.code ? 'Consolas' : undefined;
  if (!value.includes(':status[')) return [new TextRun({ text: value, ...style, font })];
  const runs: TextRun[] = [];
  let last = 0;
  for (const match of value.matchAll(DECODED_STATUS_RE)) {
    const label = cleanStatusLabel(match[1]);
    if (!label) continue;
    if (match.index > last) runs.push(new TextRun({ text: value.slice(last, match.index), ...style, font }));
    const palette = STATUS_PALETTE[resolveStatusColor(parseStatusAttrs(match[2]))];
    runs.push(
      new TextRun({
        text: `\u00A0${label}\u00A0`,
        ...style,
        bold: true,
        allCaps: true,
        size: 17,
        color: palette.fg.slice(1),
        shading: { type: ShadingType.CLEAR, fill: palette.bg.slice(1), color: 'auto' },
      }),
    );
    last = match.index + match[0].length;
  }
  if (last < value.length) runs.push(new TextRun({ text: value.slice(last), ...style, font }));
  return runs;
}

function runsFor(nodes: readonly PhrasingContent[], style: InlineStyle): (TextRun | ExternalHyperlink)[] {
  const out: (TextRun | ExternalHyperlink)[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push(...textRuns(node.value, style));
        break;
      case 'inlineCode':
        out.push(new TextRun({ text: node.value, ...style, font: 'Consolas' }));
        break;
      case 'strong':
        out.push(...renderInline(node.children, { ...style, bold: true }));
        break;
      case 'emphasis':
        out.push(...renderInline(node.children, { ...style, italics: true }));
        break;
      case 'delete':
        out.push(...renderInline(node.children, { ...style, strike: true }));
        break;
      case 'underline':
        out.push(...renderInline(node.children, { ...style, underline: { type: UnderlineType.SINGLE } }));
        break;
      case 'break':
        out.push(new TextRun({ text: '', break: 1 }));
        break;
      case 'link': {
        const children = renderInline(node.children, { ...style }).filter((c): c is TextRun => c instanceof TextRun);
        const label = children.length > 0 ? children : [new TextRun({ text: node.url })];
        // In-document `#anchor` links have no Word target here (the collated
        // document has no bookmarks) — render them as plain text rather than
        // as a hyperlink that goes nowhere.
        if (node.url.startsWith('#')) out.push(...label);
        else out.push(new ExternalHyperlink({ children: label.map((r) => r), link: node.url }));
        break;
      }
      case 'html':
        break; // our own `<a id>` anchors and any other raw HTML: no Word equivalent (a legacy <mark> never reaches here — renderInline's groupLegacyMarkupSpans already consumed it)
      default:
        if ('children' in node) out.push(...renderInline((node as Parent).children as PhrasingContent[], style));
        else if ('value' in node) out.push(new TextRun({ text: String((node as { value: unknown }).value), ...style }));
    }
  }
  return out;
}

function plainText(node: Node): string {
  if ('value' in node && typeof (node as { value: unknown }).value === 'string') return (node as { value: string }).value;
  if ('children' in node) return ((node as Parent).children as Nodes[]).map(plainText).join('');
  return '';
}

// ---------------------------------------------------------------------------
// images
// ---------------------------------------------------------------------------

function insideSpace(spaceDir: string, candidate: string): boolean {
  const rel = path.relative(spaceDir, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Reads the intrinsic size out of a PNG header, so an inserted image keeps its aspect ratio. */
function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function loadImage(ctx: DocxContext, url: string): Promise<{ data: Buffer; width: number; height: number } | null> {
  const prefixes = [`${ctx.baseUrl}/files/${ctx.space}/`, `/files/${ctx.space}/`];
  const prefix = prefixes.find((p) => url.startsWith(p));
  if (!prefix) return null; // remote images are not fetched — same policy as the PDF path

  let relPath: string;
  try {
    relPath = decodeURIComponent(url.slice(prefix.length).split('#')[0].split('?')[0]);
  } catch {
    return null;
  }
  const spaceDir = storage.getSpaceDir(ctx.space);
  const abs = path.resolve(spaceDir, relPath);
  if (!insideSpace(spaceDir, abs)) return null;

  const cached = ctx.imageCache.get(abs);
  if (cached !== undefined) return cached;

  let result: { data: Buffer; width: number; height: number } | null = null;
  try {
    if (relPath.endsWith('.excalidraw.svg') || relPath.endsWith('.svg')) {
      // R23 addendum 3: SVG in DOCX is unreliable, so the board goes through
      // the same chromium the PDF path already needs, at 2x for legible labels.
      const svg = await fs.readFile(abs, 'utf8');
      const png = await rasterizeSvg(svg.replace(/^(?:\s*<!--\s*folio-[a-z-]+:[^>]*-->)+\s*/i, ''));
      if (png) {
        const size = pngSize(png) ?? { width: CONTENT_WIDTH_PX, height: 400 };
        result = { data: png, ...size };
      }
    } else if (/\.png$/i.test(relPath)) {
      const data = await fs.readFile(abs);
      const size = pngSize(data) ?? { width: CONTENT_WIDTH_PX, height: 400 };
      result = { data, ...size };
    }
    // Other bitmap formats are skipped rather than guessed at: docx needs a
    // declared type AND real pixel dimensions, and inventing either produces
    // a document Word renders wrong.
  } catch {
    result = null;
  }

  ctx.imageCache.set(abs, result);
  return result;
}

function scaleToWidth(size: { width: number; height: number }): { width: number; height: number } {
  if (size.width <= CONTENT_WIDTH_PX) return size;
  const ratio = CONTENT_WIDTH_PX / size.width;
  return { width: CONTENT_WIDTH_PX, height: Math.max(1, Math.round(size.height * ratio)) };
}

// ---------------------------------------------------------------------------
// blocks
// ---------------------------------------------------------------------------

async function tableFor(node: MdTable): Promise<Table> {
  const rows = node.children;
  const columnCount = Math.max(...rows.map((r) => r.children.length), 1);

  const docxRows = rows.map((row: MdTableRow, rowIndex: number) => {
    const cells: TableCell[] = [];
    for (let i = 0; i < columnCount; i++) {
      const cell = row.children[i] as MdTableCell | undefined;
      const runs = cell ? renderInline(cell.children as PhrasingContent[], {}) : [];
      cells.push(
        new TableCell({
          width: { size: Math.floor(100 / columnCount), type: WidthType.PERCENTAGE },
          children: [new Paragraph({ children: runs.length > 0 ? runs : [new TextRun({ text: '' })] })],
        }),
      );
    }
    return new TableRow({
      children: cells,
      // The spec's actual requirement: Word must repeat this row on every page.
      tableHeader: rowIndex === 0,
    });
  });

  return new Table({
    rows: docxRows,
    width: { size: CONTENT_WIDTH_TWIPS, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: 'D4D4D8' },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: 'D4D4D8' },
      left: { style: BorderStyle.SINGLE, size: 2, color: 'D4D4D8' },
      right: { style: BorderStyle.SINGLE, size: 2, color: 'D4D4D8' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'D4D4D8' },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: 'D4D4D8' },
    },
  });
}

async function listParagraphs(node: RootContent & Parent, ctx: DocxContext, depth: number, ordered: boolean): Promise<(Paragraph | Table)[]> {
  const out: (Paragraph | Table)[] = [];
  for (const item of node.children) {
    if (item.type !== 'listItem') continue;
    let first = true;
    for (const child of item.children) {
      if (child.type === 'list') {
        out.push(...(await listParagraphs(child, ctx, depth + 1, child.ordered === true)));
        continue;
      }
      const inner = await blockFor(child, ctx);
      for (const block of inner) {
        if (block instanceof Paragraph && first) {
          first = false;
          out.push(
            new Paragraph({
              children: child.type === 'paragraph' ? renderInline(child.children, {}) : [new TextRun({ text: plainText(child) })],
              ...(ordered
                ? { numbering: { reference: ORDERED_REFERENCE, level: Math.min(depth, 4) } }
                : { bullet: { level: Math.min(depth, 4) } }),
            }),
          );
        } else {
          out.push(block);
        }
      }
    }
  }
  return out;
}

async function blockFor(node: RootContent, ctx: DocxContext): Promise<(Paragraph | Table)[]> {
  switch (node.type) {
    case 'heading':
      return [new Paragraph({ heading: HEADING_LEVELS[Math.min(node.depth, 6) - 1], children: renderInline(node.children, {}) })];

    case 'paragraph': {
      // A paragraph that is nothing but an image becomes the image block,
      // with the image's alt text as the caption underneath (that alt text is
      // the board page's title — see markdown.ts's board section).
      const only = node.children.length === 1 ? node.children[0] : undefined;
      if (only && only.type === 'image') {
        const loaded = await loadImage(ctx, only.url);
        const caption = only.alt ?? '';
        if (!loaded) {
          return [
            new Paragraph({
              children: [new ExternalHyperlink({ children: [new TextRun({ text: caption || only.url, italics: true })], link: only.url })],
            }),
          ];
        }
        const size = scaleToWidth(loaded);
        const blocks: Paragraph[] = [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new ImageRun({ type: 'png', data: loaded.data, transformation: size })],
          }),
        ];
        if (caption) {
          blocks.push(
            new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: caption, italics: true, size: 18 })] }),
          );
        }
        return blocks;
      }
      return [new Paragraph({ children: renderInline(node.children, {}) })];
    }

    case 'code':
      return node.value
        .split('\n')
        .map((line) => new Paragraph({ children: [new TextRun({ text: line, font: 'Consolas', size: 18 })], shading: { fill: 'F4F4F5' } }));

    case 'blockquote': {
      const inner: (Paragraph | Table)[] = [];
      for (const child of node.children) {
        if (child.type === 'paragraph') {
          inner.push(new Paragraph({ indent: { left: convertInchesToTwip(0.35) }, children: renderInline(child.children, { italics: true }) }));
        } else {
          inner.push(...(await blockFor(child, ctx)));
        }
      }
      return inner;
    }

    case 'list':
      return listParagraphs(node, ctx, 0, node.ordered === true);

    case 'table':
      return [await tableFor(node)];

    case 'thematicBreak':
      // Spec: "between pages — a separator (`---` in MD, a page break in PDF/DOCX)".
      return [new Paragraph({ children: [new PageBreak()] })];

    case 'html':
      return []; // `<a id>` anchors etc. — no Word equivalent

    default:
      if ('children' in node) {
        const inner: (Paragraph | Table)[] = [];
        for (const child of (node as Parent).children as RootContent[]) inner.push(...(await blockFor(child, ctx)));
        return inner;
      }
      return [];
  }
}

// ---------------------------------------------------------------------------
// document
// ---------------------------------------------------------------------------

export interface RenderDocxOptions {
  markdown: string;
  entry: PageIndexEntry;
  baseUrl: string;
}

export async function renderDocx(opts: RenderDocxOptions): Promise<Buffer> {
  const tree = parser.parse(opts.markdown);
  const ctx: DocxContext = { space: opts.entry.space, baseUrl: opts.baseUrl, imageCache: new Map() };

  const children: (Paragraph | Table)[] = [];
  for (const node of tree.children) children.push(...(await blockFor(node, ctx)));
  if (children.length === 0) children.push(new Paragraph({ children: [new TextRun({ text: '' })] }));

  const doc = new Document({
    title: opts.entry.title,
    numbering: {
      config: [
        {
          reference: ORDERED_REFERENCE,
          levels: [0, 1, 2, 3, 4].map((level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: convertInchesToTwip(0.35 * (level + 1)), hanging: convertInchesToTwip(0.22) } } },
          })),
        },
      ],
    },
    sections: [
      {
        properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
        children,
      },
    ],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}
