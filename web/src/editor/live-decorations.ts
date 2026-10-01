/**
 * Pure core of the live-preview mode: turns a markdown syntax tree snapshot into
 * a flat list of decoration *specs*. Nothing here touches the DOM or CodeMirror's
 * view layer, which keeps it unit-testable in plain node.
 *
 * The view layer (live-preview.ts) maps these specs onto real Decorations.
 */
import type { SyntaxNode, SyntaxNodeRef, Tree } from '@lezer/common';
import { isBgToken, isTableAttrLine } from '../markdown/tableSyntax';

/** Minimal slice of `@codemirror/state`'s Text that the computation needs. */
export interface DocLine {
  readonly from: number;
  readonly to: number;
  readonly number: number;
  readonly text: string;
}
export interface DocText {
  readonly length: number;
  readonly lines: number;
  sliceString(from: number, to?: number): string;
  lineAt(pos: number): DocLine;
  line(n: number): DocLine;
}

export interface Span {
  readonly from: number;
  readonly to: number;
}

/** GFM alert kinds, lowercased exactly like `markdown/alerts.ts` writes them. */
export const CALLOUT_TYPES = ['note', 'tip', 'important', 'warning', 'caution'] as const;
export type CalloutType = (typeof CALLOUT_TYPES)[number];

/** Inline-level specs — none of these may cover a line break. */
export type InlineSpec =
  /** Marker text folded away (replaced with nothing). */
  | { kind: 'hide'; from: number; to: number }
  /** Styling only, text stays visible. */
  | { kind: 'mark'; from: number; to: number; cls: string }
  /** Whole-line styling; `pos` is always a line start. */
  | { kind: 'line'; pos: number; cls: string }
  /** `[ ]` / `[x]` replaced by a real checkbox. */
  | { kind: 'task'; from: number; to: number; checked: boolean }
  /** `[!NOTE]` replaced by the alert's icon + name, the way reading mode heads it. */
  | { kind: 'callout'; from: number; to: number; type: CalloutType };

/** Block-level specs — these affect vertical layout and must come from a StateField. */
export type BlockSpec =
  | { kind: 'mermaid'; from: number; to: number; code: string }
  | { kind: 'image'; from: number; to: number; alt: string; src: string; width?: string }
  | { kind: 'table'; from: number; to: number; source: string }
  | { kind: 'html'; from: number; to: number; html: string }
  | { kind: 'pagetree'; from: number; to: number; depth: number }
  /** `<details>` spread over several blocks, collapsed into one disclosure widget. */
  | ({ kind: 'details' } & DetailsBlock);

export interface ComputeOptions {
  doc: DocText;
  tree: Tree;
  /** Current selection ranges; a node the selection touches keeps its source visible. */
  selection: readonly Span[];
  /** Ranges to scan — the visible ranges for inline specs, the whole doc for blocks. */
  ranges: readonly Span[];
  /** When false only styling is emitted (source mode): no folding, no widgets. */
  live: boolean;
}

/** True when any selection range overlaps or abuts [from, to]. */
export function touches(selection: readonly Span[], from: number, to: number): boolean {
  for (const range of selection) if (range.from <= to && range.to >= from) return true;
  return false;
}

const HEADING = /^(ATX|Setext)Heading([1-6])$/;

/** Node names we descend into while looking for block constructs. */
const BLOCK_CONTAINERS = new Set([
  'Document',
  'Paragraph',
  'Blockquote',
  'BulletList',
  'OrderedList',
  'ListItem',
  'Task',
]);

function childrenNamed(node: SyntaxNode, name: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) out.push(child);
  }
  return out;
}

/**
 * Inline decorations: marker folding, syntax-mark styling and per-line classes.
 * Scans only `ranges` (the viewport) so large documents stay cheap.
 */
/**
 * Inline HTML this editor renders rather than shows as source: the two tags the
 * formatting toolbar writes for the formats markdown has no syntax for. Both
 * are what GitHub renders too — see format.ts for why these and not `<u>`/`==`.
 */
const INLINE_HTML: Record<string, string> = {
  ins: 'cm-md-ins',
  u: 'cm-md-ins',
  mark: 'cm-md-mark',
};

interface HtmlTagRef {
  from: number;
  to: number;
  name: string;
  closing: boolean;
}

const HTML_TAG = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\s*>$/;

function readHtmlTag(text: string, from: number, to: number): HtmlTagRef | null {
  const match = HTML_TAG.exec(text);
  if (!match) return null;
  const name = match[2].toLowerCase();
  if (!(name in INLINE_HTML)) return null;
  return { from, to, name, closing: match[1] === '/' };
}

export function computeInlineSpecs({ doc, tree, ranges, live }: ComputeOptions): InlineSpec[] {
  const specs: InlineSpec[] = [];
  // Collected during the walk, paired afterwards: an opening tag and its match
  // are siblings in the tree, not parent and child.
  const htmlTags: HtmlTagRef[] = [];
  // Callouts found so far in this pass. A Blockquote is always entered before
  // the QuoteMarks and the `[!NOTE]` Link inside it, so by the time those are
  // visited the enclosing callout (if any) is already known.
  const callouts: Callout[] = [];
  const calloutAt = (from: number, to: number): Callout | null => {
    for (const callout of callouts) if (callout.from <= from && to <= callout.to) return callout;
    return null;
  };
  // A node straddling two visible ranges is visited twice; keys keep the set clean.
  const seen = new Set<string>();
  const add = (key: string, spec: InlineSpec) => {
    if (seen.has(key)) return;
    seen.add(key);
    specs.push(spec);
  };

  const addLine = (pos: number, cls: string) => add(`l${pos}:${cls}`, { kind: 'line', pos, cls });
  const addMark = (from: number, to: number, cls: string) =>
    add(`m${from}-${to}:${cls}`, { kind: 'mark', from, to, cls });
  const hide = (from: number, to: number) => {
    // CodeMirror forbids plugin-provided replacements that swallow a line break
    // (a link destination split over two lines can produce one), so drop those.
    if (to <= from || to > doc.lineAt(from).to) return;
    add(`h${from}-${to}`, { kind: 'hide', from, to });
  };
  /**
   * Live mode is visually stable: moving the caret never expands storage
   * markers and therefore never shifts the text under the pointer. Authors who
   * need to edit Markdown syntax explicitly have the Source mode.
   */
  const foldMarker = (node: SyntaxNodeRef, owner: SyntaxNode | null) => {
    if (!live || !owner) return;
    hide(node.from, node.to);
  };

  for (const range of ranges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        const name = node.name;

        const heading = HEADING.exec(name);
        if (heading) {
          addLine(doc.lineAt(node.from).from, `cm-md-h${heading[2]}`);
          return true;
        }

        switch (name) {
          case 'HeaderMark': {
            addMark(node.from, node.to, 'cm-md-marker');
            const owner = node.node.parent;
            // Setext underlines are a line of their own — folding them would leave a
            // blank line behind, so only ATX `#` prefixes/suffixes are folded.
            if (!live || !owner || !owner.name.startsWith('ATXHeading')) return false;
            if (node.from === owner.from) {
              let end = node.to;
              while (end < owner.to && doc.sliceString(end, end + 1) === ' ') end++;
              hide(node.from, end);
            } else {
              let start = node.from;
              while (start > owner.from && doc.sliceString(start - 1, start) === ' ') start--;
              hide(start, node.to);
            }
            return false;
          }

          case 'EmphasisMark':
          case 'StrikethroughMark':
          case 'HighlightMark':
            addMark(node.from, node.to, 'cm-md-marker');
            foldMarker(node, node.node.parent);
            return false;

          // `==text==` / `==text=={.green}` (highlight-syntax.ts): the text
          // between the marks gets the highlight class, coloured when a
          // `HighlightAttr` sibling sits flush against the node's end.
          case 'Highlight': {
            const marks = childrenNamed(node.node, 'HighlightMark');
            if (marks.length >= 2 && marks[1].from > marks[0].to) {
              const next = node.node.nextSibling;
              const attr = next?.name === 'HighlightAttr' && next.from === node.to ? next : null;
              const token = attr ? /^\{\.([a-z]+)\}$/.exec(doc.sliceString(attr.from, attr.to))?.[1] : undefined;
              const cls = token && isBgToken(token) ? `cm-md-mark cm-md-mark--${token}` : 'cm-md-mark';
              addMark(marks[0].to, marks[1].from, cls);
            }
            return true;
          }

          case 'HighlightAttr': {
            addMark(node.from, node.to, 'cm-md-marker');
            const prev = node.node.prevSibling;
            if (live && prev?.name === 'Highlight' && prev.to === node.from) hide(node.from, node.to);
            return false;
          }

          case 'CodeMark': {
            const owner = node.node.parent;
            if (owner?.name !== 'InlineCode') return false; // fence markers stay visible
            addMark(node.from, node.to, 'cm-md-marker');
            foldMarker(node, owner);
            return false;
          }

          case 'Blockquote': {
            const callout = readCallout(doc, node.node);
            if (!callout) return true;
            callouts.push(callout);
            // Frame, tint and radius are drawn per line — the whole quote is one
            // box only as far as the CSS makes consecutive lines look like one.
            const firstLine = doc.lineAt(callout.from).number;
            const lastLine = doc.lineAt(callout.to).number;
            const from = doc.lineAt(Math.max(callout.from, range.from)).number;
            const to = doc.lineAt(Math.min(callout.to, range.to)).number;
            for (let n = from; n <= to; n++) {
              const pos = doc.line(n).from;
              addLine(pos, `cm-md-callout cm-md-callout-${callout.type}`);
              if (n === firstLine) addLine(pos, 'cm-md-callout-first');
              if (n === lastLine) addLine(pos, 'cm-md-callout-last');
            }
            if (live) {
              add(`c${callout.markerFrom}`, {
                kind: 'callout',
                from: callout.markerFrom,
                to: callout.markerTo,
                type: callout.type,
              });
            }
            return true;
          }

          case 'Link': {
            // `[!NOTE]` parses as a shortcut-reference link. Inside a callout
            // that range belongs to the label widget, not to link styling —
            // and two replacements over one range is asking for it.
            const owner = calloutAt(node.from, node.to);
            if (owner && node.from === owner.markerFrom && node.to === owner.markerTo) return false;
            const marks = childrenNamed(node.node, 'LinkMark');
            if (marks.length < 2) return true;
            const labelFrom = marks[0].to;
            const labelTo = marks[1].from;
            if (labelTo <= labelFrom) return true; // empty label — keep the source
            addMark(labelFrom, labelTo, 'cm-md-link');
            if (live) {
              hide(node.from, labelFrom);
              hide(labelTo, node.to);
            }
            return true;
          }

          case 'URL': {
            // GFM autolink: a bare `https://…` with no `[label](url)` markup
            // around it. As a child of Link it's the destination inside
            // `(...)`, already styled and folded by the `Link` case above —
            // only style it here when it stands on its own in the text.
            if (node.node.parent?.name === 'Link') return false;
            addMark(node.from, node.to, 'cm-md-link');
            return false;
          }

          case 'QuoteMark': {
            const owner = calloutAt(node.from, node.to);
            // A callout draws its own frame; the plain-quote rule would fight it.
            if (!owner) addLine(doc.lineAt(node.from).from, 'cm-md-quote');
            addMark(node.from, node.to, 'cm-md-quote-mark');
            // Inside a callout the `>` prefixes are pure syntax — folded away like
            // every other marker, and back the moment the caret enters the block.
            if (live && owner) {
              const lineEnd = doc.lineAt(node.from).to;
              const gap = node.to < lineEnd && doc.sliceString(node.to, node.to + 1) === ' ';
              hide(node.from, gap ? node.to + 1 : node.to);
            }
            return false;
          }

          case 'ListMark':
            addMark(node.from, node.to, 'cm-md-list-mark');
            return false;

          case 'TaskMarker': {
            if (!live) return false;
            const marker = doc.sliceString(node.from, node.to);
            add(`t${node.from}`, { kind: 'task', from: node.from, to: node.to, checked: marker[1] !== ' ' });
            return false;
          }

          case 'HTMLTag': {
            const tag = readHtmlTag(doc.sliceString(node.from, node.to), node.from, node.to);
            if (tag) htmlTags.push(tag);
            return false;
          }

          case 'HorizontalRule':
            addLine(doc.lineAt(node.from).from, 'cm-md-hr');
            return false;

          case 'FencedCode':
          case 'CodeBlock': {
            const first = doc.lineAt(Math.max(node.from, range.from)).number;
            const last = doc.lineAt(Math.min(node.to, range.to)).number;
            for (let n = first; n <= last; n++) addLine(doc.line(n).from, 'cm-md-code-line');
            return false;
          }

          case 'Table': {
            const first = doc.lineAt(Math.max(node.from, range.from)).number;
            const last = doc.lineAt(Math.min(node.to, range.to)).number;
            for (let n = first; n <= last; n++) addLine(doc.line(n).from, 'cm-md-table-line');
            return false;
          }

          case 'LinkReference': {
            // Round 17: a table's metadata line is a link reference definition
            // to every markdown parser (which is exactly why it renders as
            // nothing anywhere else). In source mode it should still read as
            // part of the table it belongs to.
            const line = doc.lineAt(node.from);
            if (isTableAttrLine(line.text)) {
              addLine(line.from, 'cm-md-table-line');
              return false;
            }
            return true;
          }

          default:
            return true;
        }
      },
    });
  }

  // `<ins>`/`<mark>` pairs: markers dimmed always, folded away (and the content
  // styled) in live mode, exactly the way `**` and `~~` behave. Unpaired tags
  // stay plain source — half a construct is not one.
  const openTags: HtmlTagRef[] = [];
  // A node straddling two visible ranges is visited twice; the pairing stack
  // only works over a clean, ordered list.
  const seenTags = new Set<number>();
  htmlTags.sort((a, b) => a.from - b.from);
  for (const tag of htmlTags) {
    if (seenTags.has(tag.from)) continue;
    seenTags.add(tag.from);
    addMark(tag.from, tag.to, 'cm-md-marker');
    if (!tag.closing) {
      openTags.push(tag);
      continue;
    }
    let at = -1;
    for (let i = openTags.length - 1; i >= 0; i--) {
      if (openTags[i].name === tag.name) {
        at = i;
        break;
      }
    }
    if (at === -1) continue;
    const start = openTags[at];
    openTags.length = at;
    // An empty pair carries no text to style, and a zero-length mark is an
    // error in CodeMirror.
    if (tag.from > start.to) addMark(start.to, tag.from, INLINE_HTML[tag.name]);
    if (!live) continue;
    hide(start.from, start.to);
    hide(tag.from, tag.to);
  }

  return specs;
}

/**
 * Block widgets: mermaid fences, standalone image lines, GFM tables and
 * multi-fragment `<details>` disclosures. Only emitted in live mode and only
 * while the selection is outside the block, so moving the cursor in always
 * reveals the plain markdown source. A mermaid fence whose source *is* revealed
 * gets a preview widget below it instead.
 */
export function computeBlockSpecs({ doc, tree, selection, ranges, live }: ComputeOptions): BlockSpec[] {
  if (!live) return [];
  const specs: BlockSpec[] = [];

  // Multi-fragment `<details>` goes first, because it swallows whole top-level
  // blocks: a table or an image inside the body would otherwise get its own
  // replacement *inside* the disclosure's range, and overlapping block
  // decorations take CodeMirror down. Claimed ranges are skipped outright below.
  const claimed: Span[] = [];
  for (const details of collectDetailsBlocks(doc, tree)) {
    // Caret inside: the whole construct falls back to plain markdown source,
    // and the blocks in its body behave exactly as they did before it existed.
    if (touches(selection, details.from, details.to)) continue;
    specs.push({ kind: 'details', ...details });
    claimed.push({ from: details.from, to: details.to });
  }

  for (const range of ranges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        // Never the Document node itself — a claim covering the whole document
        // would otherwise end the scan before it starts.
        if (node.name !== 'Document' && covered(claimed, node.from, node.to)) return false;
        if (node.name === 'FencedCode') {
          collectMermaid(doc, node.node, selection, specs);
          return false;
        }
        if (node.name === 'Image') {
          collectImage(doc, node.node, selection, specs);
          return false;
        }
        if (node.name === 'Table') {
          collectTable(doc, node.node, selection, specs);
          return false;
        }
        if (node.name === 'HTMLBlock') {
          collectHtml(doc, node.node, selection, specs);
          return false;
        }
        if (node.name === 'Paragraph' && collectPagetree(doc, node.node, selection, specs)) {
          return false; // the whole paragraph became a pagetree widget
        }
        return BLOCK_CONTAINERS.has(node.name);
      },
    });
  }

  return specs;
}

/** Describes a mermaid fence well enough to rewrite it as one text edit. */
export interface MermaidFence {
  /** Whole-block range, first line start to last line end. */
  from: number;
  to: number;
  /** Verbatim opening/closing fence lines, so info strings survive a rewrite. */
  open: string;
  close: string;
  code: string;
}

function readMermaidFence(doc: DocText, node: SyntaxNode): MermaidFence | null {
  // An unterminated fence has a single CodeMark; rendering it would swallow the
  // line the author is still typing.
  if (childrenNamed(node, 'CodeMark').length < 2) return null;
  const info = node.getChild('CodeInfo');
  if (!info) return null;
  const lang = doc.sliceString(info.from, info.to).trim().split(/\s+/)[0].toLowerCase();
  if (lang !== 'mermaid') return null;

  const first = doc.lineAt(node.from);
  const last = doc.lineAt(node.to);
  if (first.from !== node.from) return null; // indented or quoted fence — keep the source
  if (last.from === first.from) return null;

  const text = node.getChild('CodeText');
  return {
    from: first.from,
    to: last.to,
    open: doc.sliceString(first.from, first.to),
    close: doc.sliceString(last.from, last.to),
    code: text ? doc.sliceString(text.from, text.to) : '',
  };
}

function collectMermaid(doc: DocText, node: SyntaxNode, selection: readonly Span[], out: BlockSpec[]): void {
  const fence = readMermaidFence(doc, node);
  if (!fence) return;

  // Caret inside the fence: plain markdown source, nothing else. Round 21 took
  // away the preview that used to hang under it — a click on a diagram now goes
  // straight to the visual editor, so the "source plus preview" halfway state
  // was only ever reached by typing a fence out or arrowing into one, and in
  // both cases the author is looking at the code they are writing.
  if (touches(selection, fence.from, fence.to)) return;
  out.push({ kind: 'mermaid', from: fence.from, to: fence.to, code: fence.code });
}

/**
 * Round 17: a table's `[//]: # (folio-table: …)` metadata line sits ABOVE the
 * table (markdown/tableSyntax.ts explains why that placement and no other), so
 * the block the widget replaces has to start there — otherwise the line would
 * hang above the grid as a stray paragraph and the next edit would rewrite the
 * table without it. Returns the table's own first line when there is none.
 */
export function tableBlockStart(doc: DocText, tableFrom: number): number {
  const first = doc.lineAt(tableFrom);
  for (let number = first.number - 1; number >= Math.max(1, first.number - 2); number--) {
    const line = doc.line(number);
    if (line.text.trim() === '') continue; // the blank line we write between them
    return isTableAttrLine(line.text) ? line.from : first.from;
  }
  return first.from;
}

/**
 * CommonMark's lazy-continuation rule (§5.2): a line that carries neither a
 * blockquote's `>` marker nor a blank line before it keeps extending the
 * PARAGRAPH still open inside that blockquote — including a pipe-table's
 * header row. remark-gfm (the reading pipeline, markdown/strayTable.ts)
 * honours this and renders the swallowed lines as plain text of that
 * paragraph; CM's own GFM table extension does not — the moment a line lacks
 * `>` it just closes the Blockquote node and opens a fresh top-level Table
 * node right after it, which is indistinguishable from a real table UNLESS
 * this shape (an immediately-preceding, immediately-adjacent Blockquote whose
 * last block was a Paragraph) is checked for.
 *
 * Only a Paragraph can be lazily continued: a list or a heading closes the
 * blockquote outright, and a table right after THAT is a genuine new
 * top-level block — hence the check on the blockquote's last child, not just
 * "table right after a blockquote".
 */
function isLazyBlockquoteContinuation(doc: DocText, node: SyntaxNode): boolean {
  const prev = node.prevSibling;
  if (!prev || prev.name !== 'Blockquote') return false;
  const last = prev.lastChild;
  if (!last || last.name !== 'Paragraph' || last.to !== prev.to) return false;
  // Adjacent lines only: a blank line between the callout's text and the
  // table properly closes the blockquote, and what follows is a fresh block —
  // exactly the "table after a blank line inside the callout" case, which
  // stays a real table.
  return doc.lineAt(node.from).number === doc.lineAt(prev.to).number + 1;
}

function collectTable(doc: DocText, node: SyntaxNode, selection: readonly Span[], out: BlockSpec[]): void {
  // Top level only: a table nested in a quote or list keeps its markdown source.
  if (node.parent?.name !== 'Document') return;
  // A pipe table that markdown does not consider a table at all (lazy
  // continuation of an open callout/blockquote paragraph, owner report) keeps
  // its markdown source too — drawing a grid here is disagreeing with reading
  // mode, which already marks this text `.folio-stray-table` instead.
  if (isLazyBlockquoteContinuation(doc, node)) return;
  const first = doc.lineAt(node.from);
  const last = doc.lineAt(node.to);
  if (first.from !== node.from) return;

  const from = tableBlockStart(doc, node.from);
  if (touches(selection, from, last.to)) return;

  out.push({
    kind: 'table',
    from,
    to: last.to,
    source: doc.sliceString(from, last.to),
  });
}

function collectImage(doc: DocText, node: SyntaxNode, selection: readonly Span[], out: BlockSpec[]): void {
  const line = doc.lineAt(node.from);
  if (doc.lineAt(node.to).from !== line.from) return; // multi-line image syntax
  // Only images that make up a whole line become block widgets; inline images
  // inside a sentence stay as source.
  if (doc.sliceString(line.from, node.from).trim() !== '') return;
  if (doc.sliceString(node.to, line.to).trim() !== '') return;
  if (touches(selection, line.from, line.to)) return;

  const marks = childrenNamed(node, 'LinkMark');
  const url = node.getChild('URL');
  if (!url || marks.length < 2) return;

  out.push({
    kind: 'image',
    from: line.from,
    to: line.to,
    alt: doc.sliceString(marks[0].to, marks[1].from),
    src: doc.sliceString(url.from, url.to),
  });
}

const HTML_OPEN = /^<([a-zA-Z][a-zA-Z0-9-]*)[\s>/]/;
const HTML_IMAGE = /^<img\s+([^>]*?)\/?\s*>$/i;
const HTML_ATTRIBUTE = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

function decodeHtmlAttribute(value: string): string {
  const textarea = typeof document === 'undefined' ? null : document.createElement('textarea');
  if (textarea) {
    textarea.innerHTML = value;
    return textarea.value;
  }
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** A standalone HTML image written by ImageWidget when a custom size is selected. */
export function parseHtmlImage(text: string): { alt: string; src: string; width?: string } | null {
  const match = HTML_IMAGE.exec(text.trim());
  if (!match) return null;
  const attrs = new Map<string, string>();
  for (const attr of match[1].matchAll(HTML_ATTRIBUTE)) {
    attrs.set(attr[1].toLowerCase(), decodeHtmlAttribute(attr[2] ?? attr[3] ?? attr[4] ?? ''));
  }
  const src = attrs.get('src');
  if (!src) return null;
  const rawWidth = attrs.get('width');
  const width = rawWidth && /^(?:[1-9]|[1-9]\d|100)%$/.test(rawWidth) ? rawWidth : undefined;
  return { alt: attrs.get('alt') ?? '', src, width };
}

/**
 * Whether an HTML block stands on its own well enough to render.
 *
 * CommonMark ends an HTML block at a blank line, so `<details>` with blank lines
 * inside arrives as several fragments (`<details><summary>…</summary>`, then a
 * paragraph, then `</details>`). Rendering a fragment would produce markup that
 * sanitisation has to guess at, so only blocks that open and close the same tag
 * become widgets here; everything else keeps its source.
 *
 * The one construct that *is* stitched back together is exactly that split
 * `<details>` — but by `collectDetailsBlocks`, into a disclosure widget with a
 * markdown body, not by feeding half-open markup to the HTML renderer.
 */
export function isSelfContainedHtmlBlock(text: string): boolean {
  const trimmed = text.trim();
  const open = HTML_OPEN.exec(trimmed);
  if (!open) return false;
  const tag = open[1].toLowerCase();
  if (trimmed.endsWith('/>') && !trimmed.includes(`</${tag}`)) return true;
  return trimmed.toLowerCase().endsWith(`</${tag}>`);
}

function collectHtml(doc: DocText, node: SyntaxNode, selection: readonly Span[], out: BlockSpec[]): void {
  // Top level only: a block nested in a list or quote carries the list/quote
  // markers on its lines, and replacing them would eat the structure.
  if (node.parent?.name !== 'Document') return;
  const first = doc.lineAt(node.from);
  const last = doc.lineAt(node.to);
  if (first.from !== node.from) return;

  const html = doc.sliceString(first.from, last.to);
  const image = parseHtmlImage(html);
  if (image) {
    if (!touches(selection, first.from, last.to)) {
      out.push({ kind: 'image', from: first.from, to: last.to, ...image });
    }
    return;
  }
  if (!isSelfContainedHtmlBlock(html)) return;
  if (touches(selection, first.from, last.to)) return;

  const details = parseSelfContainedDetails(html);
  if (details) {
    out.push({ kind: 'details', from: first.from, to: last.to, ...details });
    return;
  }

  out.push({ kind: 'html', from: first.from, to: last.to, html });
}

/* --------------------------------------------- multi-fragment <details> -- */

/**
 * A `<details>` disclosure whose body is real markdown, and which therefore
 * reaches the parser as several sibling blocks (see `isSelfContainedHtmlBlock`:
 * CommonMark ends an HTML block at a blank line). The `/expand` template writes
 * exactly this shape, because without the blank lines the body would be raw
 * HTML and markdown inside it would not render at all.
 */
export interface DetailsBlock {
  /** Whole construct: start of the `<details>` line to end of the `</details>` line. */
  from: number;
  to: number;
  /** `<summary>` text, empty when the opening fragment carries none. */
  summary: string;
  /** Markdown between the two fragments, blank edge lines trimmed off. */
  body: string;
  /** `<details open>` — the widget starts expanded, as the reading view would. */
  open: boolean;
}

const DETAILS_OPEN = /^<details(\s[^>]*)?>/i;
const DETAILS_CLOSE = /^<\/details\s*>$/i;
const DETAILS_ANY_CLOSE = /<\/details\s*>/i;
const SUMMARY = /<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>/i;
const OPEN_ATTR = /(?:^|\s)open(?:\s|=|$)/i;

/**
 * `<details>…</details>` without markdown blocks inside is left by CommonMark
 * as a single HTMLBlock. For Folio it is still an Expand, so it has to go
 * through the same compact DetailsWidget, not the big universal HTML preview.
 */
export function parseSelfContainedDetails(text: string): Omit<DetailsBlock, 'from' | 'to'> | null {
  const trimmed = text.trim();
  const opening = DETAILS_OPEN.exec(trimmed);
  if (!opening) return null;
  const closeAt = trimmed.toLowerCase().lastIndexOf('</details');
  if (closeAt < opening[0].length) return null;
  let inner = trimmed.slice(opening[0].length, closeAt);
  let summary = '';
  const found = SUMMARY.exec(inner);
  if (found) {
    summary = found[1].trim();
    inner = inner.slice(0, found.index) + inner.slice(found.index + found[0].length);
  }
  return { summary, body: inner.trim(), open: OPEN_ATTR.test(opening[1] ?? '') };
}

/**
 * Read the opening fragment of a multi-block `<details>`: the `<details>` tag,
 * an optional `<summary>`, and nothing else.
 *
 * Returns null for a fragment that also closes the tag (that one is a whole
 * HTML block and keeps going through `HtmlBlockWidget`) and for one carrying
 * extra markup — the widget renders only the summary and the markdown body, so
 * anything it cannot show has to stay visible as source instead of vanishing.
 */
export function parseDetailsOpen(text: string): { summary: string; open: boolean } | null {
  const trimmed = text.trim();
  const opening = DETAILS_OPEN.exec(trimmed);
  if (!opening) return null;
  if (DETAILS_ANY_CLOSE.test(trimmed)) return null;

  let rest = trimmed.slice(opening[0].length);
  let summary = '';
  const found = SUMMARY.exec(rest);
  if (found) {
    summary = found[1].trim();
    rest = rest.slice(0, found.index) + rest.slice(found.index + found[0].length);
  }
  if (rest.trim() !== '') return null;

  return { summary, open: OPEN_ATTR.test(opening[1] ?? '') };
}

/** True when the fragment is nothing but the closing tag. */
export function isDetailsClose(text: string): boolean {
  return DETAILS_CLOSE.test(text.trim());
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/**
 * Pair every opening `<details>` fragment with its closing one across the
 * document's top-level blocks.
 *
 * Only top level: a disclosure nested in a list or a quote carries the list or
 * quote markers on its lines, and replacing those would eat the structure — the
 * same rule `collectHtml` and `collectTable` already follow. An unpaired
 * `<details>` yields nothing, so a half-typed block keeps its source.
 */
export function collectDetailsBlocks(doc: DocText, tree: Tree): DetailsBlock[] {
  const out: DetailsBlock[] = [];

  for (let child = tree.topNode.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'HTMLBlock') continue;
    const openLine = doc.lineAt(child.from);
    if (openLine.from !== child.from) continue;
    const head = parseDetailsOpen(doc.sliceString(child.from, child.to));
    if (!head) continue;

    // Nested openers bump the depth so an inner `</details>` cannot close the
    // outer block early and leave a stray fragment behind it.
    let depth = 1;
    let close: SyntaxNode | null = null;
    for (let next = child.nextSibling; next; next = next.nextSibling) {
      if (next.name !== 'HTMLBlock') continue;
      const text = doc.sliceString(next.from, next.to);
      depth += countMatches(text, /<details\b/gi) - countMatches(text, /<\/details\b/gi);
      if (depth > 0) continue;
      // Only a bare `</details>` line ends the construct: a fragment that
      // carries more markup would be swallowed by the replacement.
      if (isDetailsClose(text)) close = next;
      break;
    }
    if (!close) continue;

    const bodyFrom = Math.min(doc.lineAt(child.to).to, doc.lineAt(close.from).from);
    out.push({
      from: openLine.from,
      to: doc.lineAt(close.to).to,
      summary: head.summary,
      body: trimBlankLines(doc.sliceString(bodyFrom, doc.lineAt(close.from).from)),
      open: head.open,
    });
    child = close; // resume after the closing fragment
  }

  return out;
}

function trimBlankLines(text: string): string {
  const lines = text.split('\n');
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

/** True when [from, to] sits wholly inside one of `spans`. */
function covered(spans: readonly Span[], from: number, to: number): boolean {
  for (const span of spans) if (span.from <= from && to <= span.to) return true;
  return false;
}

/* --------------------------------------------------------- GFM callouts -- */

/**
 * A `> [!NOTE]` blockquote: the marker line, plus the extent of the quote so the
 * frame can be drawn line by line.
 */
export interface Callout {
  type: CalloutType;
  from: number;
  to: number;
  /** The literal `[!NOTE]`, which live mode swaps for the alert's own heading. */
  markerFrom: number;
  markerTo: number;
}

/**
 * Uppercase and bracketed, alone on the quote's first line — the same shape
 * `markdown/alerts.ts` accepts, so a block that reads as a callout here reads as
 * one in the reading view too. `> !NOTE` (no brackets, as an early importer
 * wrote it) is deliberately just a quote.
 */
const CALLOUT_LINE = /^(>[ \t]?)(\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\])[ \t]*$/;

export function readCallout(doc: DocText, node: SyntaxNode): Callout | null {
  // Top level and unindented: a quote nested in a list shares its line with the
  // list marker, and a whole-line frame would be drawn around that too.
  if (node.name !== 'Blockquote' || node.parent?.name !== 'Document') return null;
  const line = doc.lineAt(node.from);
  if (line.from !== node.from) return null;

  const match = CALLOUT_LINE.exec(line.text);
  if (!match) return null;
  const markerFrom = line.from + match[1].length;
  return {
    type: match[3].toLowerCase() as CalloutType,
    from: node.from,
    to: node.to,
    markerFrom,
    markerTo: markerFrom + match[2].length,
  };
}

/** Default / clamp range for the `::pagetree{depth=N}` directive. */
export const PAGETREE_DEFAULT_DEPTH = 2;
export const PAGETREE_MIN_DEPTH = 1;
export const PAGETREE_MAX_DEPTH = 5;

const PAGETREE_LINE = /^::pagetree(?:\{([^}]*)\})?$/;
const DEPTH_ATTR = /(?:^|\s)depth\s*=\s*"?(\d+)"?/;

/**
 * Parse a `::pagetree{depth=N}` leaf directive line. Returns the clamped depth,
 * or null when the line is not exactly that directive. Trailing/leading spaces
 * are tolerated; anything else on the line (prose around it) makes it not a
 * standalone directive, so it stays as source.
 */
export function parsePagetreeLine(lineText: string): { depth: number } | null {
  const match = PAGETREE_LINE.exec(lineText.trim());
  if (!match) return null;
  const attrs = match[1] ?? '';
  const depthMatch = DEPTH_ATTR.exec(attrs);
  const raw = depthMatch ? Number.parseInt(depthMatch[1], 10) : PAGETREE_DEFAULT_DEPTH;
  const depth = Math.max(PAGETREE_MIN_DEPTH, Math.min(PAGETREE_MAX_DEPTH, raw));
  return { depth };
}

function collectPagetree(
  doc: DocText,
  node: SyntaxNode,
  selection: readonly Span[],
  out: BlockSpec[],
): boolean {
  // Top level only, and the directive must be the whole paragraph — a directive
  // indented into a list or wrapped in prose keeps its source.
  if (node.parent?.name !== 'Document') return false;
  const line = doc.lineAt(node.from);
  if (line.from !== node.from || line.to !== node.to) return false;

  const parsed = parsePagetreeLine(line.text);
  if (!parsed) return false;
  // Still a directive even while the cursor sits on it — just shown as source;
  // returning true keeps the paragraph from being descended into either way.
  if (touches(selection, line.from, line.to)) return true;

  out.push({ kind: 'pagetree', from: line.from, to: line.to, depth: parsed.depth });
  return true;
}

/**
 * The text edit behind the task-list checkbox: flips `[ ]` <-> `[x]` on the line
 * containing `lineFrom`. Returns null when the line holds no task marker, so the
 * widget can never write something the markdown doesn't already say.
 */
export function taskToggleEdit(
  lineText: string,
  lineFrom: number,
): { from: number; to: number; insert: string } | null {
  const match = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/.exec(lineText);
  if (!match) return null;
  const at = lineFrom + match[1].length + 1;
  return { from: at, to: at + 1, insert: match[2] === ' ' ? 'x' : ' ' };
}

/* ------------------------------------------------- lookups used on commit -- */

function enclosing(tree: Tree, pos: number, name: string): SyntaxNode | null {
  // Both sides, because a widget anchored at a block's very end resolves
  // forward into whatever follows it.
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name === name) return node;
    }
  }
  return null;
}

/**
 * Re-resolve the mermaid fence containing `pos`. Widgets call this at save time
 * rather than trusting the offsets they were built with, because remote peers
 * may have shifted or deleted the block in the meantime.
 */
export function mermaidFenceAt(doc: DocText, tree: Tree, pos: number): MermaidFence | null {
  const node = enclosing(tree, pos, 'FencedCode');
  return node ? readMermaidFence(doc, node) : null;
}

/**
 * Re-resolve the table containing `pos`, as whole-line bounds — the metadata
 * line above it included, both when looking up and when reporting back. `pos`
 * may itself be on that line: it is where the widget starts, so that is exactly
 * what `posAtDOM` hands back when an edit is committed.
 */
export function tableRangeAt(doc: DocText, tree: Tree, pos: number): Span | null {
  let node = enclosing(tree, pos, 'Table');
  if (!node) {
    const line = doc.lineAt(pos);
    if (!isTableAttrLine(line.text)) return null;
    // Look past the metadata line (and the blank line after it) for the table.
    for (let number = line.number + 1; number <= Math.min(doc.lines, line.number + 2); number++) {
      const next = doc.line(number);
      if (next.text.trim() === '') continue;
      node = enclosing(tree, next.from, 'Table');
      break;
    }
    if (!node) return null;
  }
  return { from: tableBlockStart(doc, node.from), to: doc.lineAt(node.to).to };
}

/**
 * True when a page has no real content yet — nothing at all, or just its H1
 * (with any amount of blank space around it). Drives the ghost hint that tells
 * a new author which keys open the block, page and emoji pickers.
 */
export function isEffectivelyEmpty(text: string): boolean {
  return text.replace(/^\s*#[ \t]+[^\n]*\n?/, '').trim() === '';
}
