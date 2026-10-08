/**
 * Copy / cut in Live edit: put the selection's *markdown* on the clipboard.
 *
 * Live mode folds the syntax markers (`**`, `==`, `~~`, `` ` ``, `[`…`](url)`,
 * `<ins>`…) away, so a mouse selection over the visible word `SELECTED` in
 * `**==SELECTED==**` covers the text only; the markers sit just outside the
 * selection and CodeMirror's stock copy therefore put bare `SELECTED` on the
 * clipboard. Here the selection is mapped back to source through the syntax
 * tree: every inline construct the selection cuts into contributes the part of
 * its opening / closing marker that the selection does not already contain.
 *
 * Block prefixes (`## `, `- `, `> ` of a callout) are folded too. A selection
 * that starts at the visible start of a line and reaches the end of a line (or
 * runs on into later lines) takes the line's prefix with it; a partial selection
 * inside a line stays bare text, which is what one expects when copying a word.
 *
 * Besides `text/plain` (the markdown), `text/html` carries the rendered result
 * (copy-html.ts), so Google Docs / Slack / mail keep the formatting.
 */
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { SyntaxNode, Tree } from '@lezer/common';
import { clipboardHtml } from './copy-html';
import {
  computeInlineSpecs,
  readHtmlTag,
  type DocText,
  type HtmlTagRef,
  type Span,
} from './live-decorations';
import { liveModeFacet, pageContextFacet } from './live-preview';

/** One inline construct: where its opening and closing markers sit in the source. */
interface Layer {
  openFrom: number;
  openTo: number;
  closeFrom: number;
  closeTo: number;
  /**
   * Whitespace right inside an emphasis-like delimiter stops it from being one
   * (`** x**` is plain text), so a partial copy moves it outside the markers.
   * Code spans and links have no such rule.
   */
  trim: boolean;
}

interface LayerSpec {
  mark: string;
  trim: boolean;
}

/**
 * Lezer node name -> the child that holds its markers. The first and the last
 * such child are the opening and the closing delimiter. Adding an inline form
 * to the grammar means adding a line here (and a test).
 */
const LAYER_NODES: Record<string, LayerSpec> = {
  Emphasis: { mark: 'EmphasisMark', trim: true },
  StrongEmphasis: { mark: 'EmphasisMark', trim: true },
  Strikethrough: { mark: 'StrikethroughMark', trim: true },
  Highlight: { mark: 'HighlightMark', trim: true },
  Underline: { mark: 'UnderlineMark', trim: true },
  InlineCode: { mark: 'CodeMark', trim: false },
  Link: { mark: 'LinkMark', trim: false },
};

/** Blocks whose inline HTML pairs (`<ins>…</ins>`) we pair up when scanning. */
const INLINE_BLOCKS = /^(Paragraph|ATXHeading[1-6]|SetextHeading[12]|TableCell|TableHeader)$/;

function layerOf(node: SyntaxNode): Layer | null {
  const spec = LAYER_NODES[node.name];
  if (!spec) return null;
  const marks: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === spec.mark) marks.push(child);
  }
  if (marks.length < 2) return null;
  // A link's markers are `[`, `]`, `(`, `)`: the label sits between the first two.
  const open = marks[0];
  const close = node.name === 'Link' ? marks[1] : marks[marks.length - 1];
  if (close.from <= open.to) return null; // empty content: nothing to wrap
  let closeTo = node.to;
  // `==x=={.green}`: the colour attribute is a sibling that belongs to the closer.
  if (node.name === 'Highlight') {
    const next = node.nextSibling;
    if (next?.name === 'HighlightAttr' && next.from === node.to) closeTo = next.to;
  }
  return { openFrom: node.from, openTo: open.to, closeFrom: close.from, closeTo, trim: spec.trim };
}

function treeLayers(tree: Tree, from: number, to: number): Layer[] {
  const found = new Map<string, Layer>();
  const visit = (start: SyntaxNode | null) => {
    for (let node: SyntaxNode | null = start; node; node = node.parent) {
      const layer = layerOf(node);
      if (layer) found.set(`${layer.openFrom}:${layer.closeTo}`, layer);
    }
  };
  for (const [pos, side] of [[from, 1], [to, -1]] as const) {
    let node: SyntaxNode | null = tree.resolveInner(pos, side);
    // Standing on a colour attribute: the highlight it belongs to is the layer.
    if (node.name === 'HighlightAttr' && node.prevSibling?.name === 'Highlight') node = node.prevSibling;
    visit(node);
  }
  return [...found.values()];
}

function blockOf(tree: Tree, pos: number): SyntaxNode | null {
  let node: SyntaxNode | null = tree.resolveInner(pos, 1);
  while (node && !INLINE_BLOCKS.test(node.name)) node = node.parent;
  return node;
}

/** `<ins>…</ins>` / `<mark>…</mark>` pairs around the selection, paired the way live-decorations pairs them. */
function htmlLayers(doc: DocText, tree: Tree, from: number, to: number): Layer[] {
  const first = blockOf(tree, from);
  const last = blockOf(tree, to);
  const scanFrom = Math.min(first?.from ?? doc.lineAt(from).from, last?.from ?? Infinity);
  const scanTo = Math.max(first?.to ?? doc.lineAt(to).to, last?.to ?? 0);
  const tags: HtmlTagRef[] = [];
  tree.iterate({
    from: scanFrom,
    to: scanTo,
    enter: (node) => {
      if (node.name !== 'HTMLTag') return;
      const tag = readHtmlTag(doc.sliceString(node.from, node.to), node.from, node.to);
      if (tag) tags.push(tag);
    },
  });
  tags.sort((a, b) => a.from - b.from);
  const layers: Layer[] = [];
  const open: HtmlTagRef[] = [];
  for (const tag of tags) {
    if (!tag.closing) {
      open.push(tag);
      continue;
    }
    let at = -1;
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i].name === tag.name) {
        at = i;
        break;
      }
    }
    if (at === -1) continue;
    const start = open[at];
    open.length = at;
    if (tag.from <= start.to) continue;
    layers.push({ openFrom: start.from, openTo: start.to, closeFrom: tag.from, closeTo: tag.to, trim: false });
  }
  return layers;
}

/** A `:status[…]` badge is one atom: a selection edge inside it snaps outward. */
function snapToAtoms(tree: Tree, from: number, to: number): Span {
  const snap = (pos: number): SyntaxNode | null => {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, 0); node; node = node.parent) {
      if (node.name === 'StatusTag') return node.from < pos && pos < node.to ? node : null;
    }
    return null;
  };
  return { from: snap(from)?.from ?? from, to: snap(to)?.to ?? to };
}

/**
 * Markdown for the source range [from, to]: the plain slice, plus the markers
 * of every inline construct the range cuts into. `tree` must cover the range.
 */
export function inlineMarkdown(doc: DocText, tree: Tree, from: number, to: number): string {
  ({ from, to } = snapToAtoms(tree, from, to));
  let core = doc.sliceString(from, to);
  if (from >= to) return core;

  // Outermost first: the enclosing construct opens earlier (and closes later).
  const layers = [...treeLayers(tree, from, to), ...htmlLayers(doc, tree, from, to)].sort(
    (a, b) => a.openFrom - b.openFrom || b.closeTo - a.closeTo,
  );

  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    // The range does not reach this construct's content (e.g. it ends inside the opener).
    if (to <= layer.openTo || from >= layer.closeFrom) continue;
    const prefix = from > layer.openFrom ? doc.sliceString(layer.openFrom, Math.min(from, layer.openTo)) : '';
    const suffix = to < layer.closeTo ? doc.sliceString(Math.max(to, layer.closeFrom), layer.closeTo) : '';
    if (!prefix && !suffix) continue;
    if (layer.trim) {
      // `** x**` is not bold: whitespace between a delimiter we add and the text moves outside it.
      const wholeOpen = prefix.length === layer.openTo - layer.openFrom;
      const wholeClose = suffix.length === layer.closeTo - layer.closeFrom;
      const lead = wholeOpen && prefix ? /^\s*/.exec(core)![0] : '';
      const trail = wholeClose && suffix ? /\s*$/.exec(core)![0] : '';
      if (lead.length + trail.length >= core.length) continue; // only whitespace: nothing to format
      core = core.slice(0, core.length - trail.length);
      core = lead + prefix + core.slice(lead.length) + suffix + trail;
    } else {
      core = prefix + core + suffix;
    }
  }
  return core;
}

/**
 * The hidden prefix / suffix runs of the lines holding the range's two ends,
 * sorted by position. `bullet` glyphs count: the caret cannot rest inside them.
 */
function foldedRuns(state: EditorState, tree: Tree, from: number, to: number): Span[] {
  const doc = state.doc;
  const lines = [doc.lineAt(from), doc.lineAt(to)];
  const specs = computeInlineSpecs({
    doc,
    tree,
    selection: [],
    ranges: lines.map((line) => ({ from: line.from, to: line.to })),
    live: true,
  });
  return specs
    .filter((spec) => spec.kind === 'hide' || spec.kind === 'bullet')
    .map((spec) => ({ from: (spec as Span).from, to: (spec as Span).to }))
    .sort((a, b) => a.from - b.from);
}

/** Every position reachable from `pos` by stepping over folded runs, `pos` included. */
function foldedChain(runs: readonly Span[], pos: number, limit: number): number[] {
  const chain = [pos];
  for (let again = true; again; ) {
    again = false;
    for (const run of runs) {
      if (run.from === pos && run.to > pos && run.to <= limit) {
        pos = run.to;
        chain.push(pos);
        again = true;
        break;
      }
    }
  }
  return chain;
}

/**
 * Widens a selection to what the author would call "the whole line" when it
 * starts at a line's visible start and ends at a line's visible end, so list
 * and heading markers travel with it. Single partial selections stay as is.
 */
export function widenToBlock(state: EditorState, tree: Tree, from: number, to: number): Span {
  const doc = state.doc;
  const fromLine = doc.lineAt(from);
  const toLine = doc.lineAt(to);
  const runs = foldedRuns(state, tree, from, to);
  const reachesEnd = foldedChain(runs, to, toLine.to).some((pos) => pos >= toLine.to);
  // Any boundary of the folded prefix counts: the caret may sit before or
  // after a `**` that follows `## ` — both look like "the start of the line".
  const startsAtVisibleStart = from > fromLine.from && foldedChain(runs, fromLine.from, fromLine.to).includes(from);
  if (startsAtVisibleStart && (toLine.number > fromLine.number || reachesEnd)) {
    from = fromLine.from;
    if (reachesEnd) to = toLine.to;
  }
  return { from, to };
}

/** Markdown of one selection range in Live edit. */
export function markdownForRange(state: EditorState, from: number, to: number, tree?: Tree): string {
  const resolved = tree ?? ensureSyntaxTree(state, Math.min(state.doc.length, to + 1), 200) ?? syntaxTree(state);
  const widened = widenToBlock(state, resolved, from, to);
  return inlineMarkdown(state.doc, resolved, widened.from, widened.to);
}

function copyOrCut(event: ClipboardEvent, view: EditorView, cut: boolean): boolean {
  const state = view.state;
  if (!state.facet(liveModeFacet)) return false; // Source mode copies exactly what is selected
  const data = event.clipboardData;
  if (!data) return false;
  const ranges = state.selection.ranges;
  // An empty range means "copy the line" to CodeMirror, and a whole line is already all source.
  if (ranges.length === 0 || ranges.some((range) => range.empty)) return false;

  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const text = ranges.map((range) => markdownForRange(state, range.from, range.to, tree)).join(state.lineBreak);

  event.preventDefault();
  data.clearData();
  data.setData('text/plain', text);
  try {
    data.setData('text/html', clipboardHtml(text, state.facet(pageContextFacet)));
  } catch {
    // The HTML twin is an enhancement; the markdown alone is still a correct copy.
  }
  if (cut && !state.readOnly) {
    view.dispatch({
      changes: ranges.map((range) => ({ from: range.from, to: range.to })),
      scrollIntoView: true,
      userEvent: 'delete.cut',
    });
  }
  return true;
}

export const copyMarkdown: Extension = EditorView.domEventHandlers({
  copy: (event, view) => copyOrCut(event, view, false),
  cut: (event, view) => copyOrCut(event, view, true),
});
