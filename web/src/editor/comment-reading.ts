/**
 * Inline comments in Reading mode.
 *
 * Reading mode mounts no CodeMirror view: the page is rendered markdown, whose
 * text does not line up with the Y.Text offsets the anchors speak (`**bold**`,
 * link destinations, table pipes…). Reading text and source are therefore matched
 * by their letters and digits only — the "skeleton" — which markdown syntax
 * almost never touches. A range in either one becomes the same run of skeleton
 * characters in the other; when that run occurs more than once, the n-th
 * occurrence is taken, n counted in the side the range came from.
 *
 * It is a heuristic by design (a rendered table of contents or a footnote
 * repeats text the source holds once), and it errs toward "no highlight" and
 * "ask the reader to switch to Live edit" rather than toward a wrong range.
 *
 * Highlights use the CSS Custom Highlight API where it exists: painting needs no
 * DOM changes, so it cannot disturb the markdown renderer's own tree.
 */
import { stripFrontmatter } from '../markdown/frontmatter';

export interface Skeleton {
  /** Lower-cased letters and digits of the text. */
  s: string;
  /** Index in the text each skeleton character came from. */
  at: number[];
}

const KEPT = /[\p{L}\p{N}]/u;

export function skeleton(text: string): Skeleton {
  let s = '';
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (!KEPT.test(text[i])) continue;
    for (const c of text[i].toLowerCase()) {
      s += c;
      at.push(i);
    }
  }
  return { s, at };
}

/** How many times `needle` starts in `hay` before index `limit`. */
export function countBefore(hay: string, needle: string, limit: number): number {
  let count = 0;
  for (let from = hay.indexOf(needle); from >= 0 && from < limit; from = hay.indexOf(needle, from + 1)) count++;
  return count;
}

/** Start of the n-th occurrence (0-based); the last one when there are fewer; -1 when there is none. */
export function nthMatch(hay: string, needle: string, n: number): number {
  let found = -1;
  let seen = 0;
  for (let from = hay.indexOf(needle); from >= 0; from = hay.indexOf(needle, from + 1)) {
    found = from;
    if (seen++ === n) break;
  }
  return found;
}

/** What markdown writes that the rendered page does not show: link destinations, reference definitions, fence info lines. */
const UNRENDERED = [
  /\]\([^)\n]*\)/g,
  // Inline HTML tags and character references (`&nbsp;`): their letters are not on the page as such.
  /<\/?[A-Za-z][^>\n]*>/g,
  /&(?:[A-Za-z][A-Za-z0-9]*|#\d+|#[xX][0-9a-fA-F]+);/g,
  // The target of an aliased wikilink: only the alias is shown.
  /\[\[[^\]|\n]*\|/g,
  /<(?:https?:\/\/|mailto:)[^>\n]*>/g,
  /^ {0,3}\[[^\]\n]+\]:[^\n]*/gm,
  /^ {0,3}(?:`{3,}|~{3,})[^\n]*/gm,
];

/** The source's skeleton, without the parts the page never shows. Indices still point into `text`. */
function sourceSkeleton(text: string): Skeleton {
  let masked = text;
  for (const pattern of UNRENDERED) masked = masked.replace(pattern, (m) => ' '.repeat(m.length));
  return skeleton(masked);
}

/**
 * Where the skeleton run `other[from..to]` sits in `hay` (inclusive indices), the n-th occurrence being the one the
 * range came from. Exact first. When the two sides differ inside the run (the page shows a letter the source does
 * not hold, or the other way round: an alias, an entity, a widget, an include) the run's head and tail are looked
 * up on their own and the span between them is taken. A run is refused only when neither end can be found.
 */
export function alignRun(hay: string, other: string, from: number, to: number): { start: number; end: number } | null {
  const needle = other.slice(from, to + 1);
  if (!needle) return null;
  const exact = nthMatch(hay, needle, countBefore(other, needle, from));
  if (exact >= 0) return { start: exact, end: exact + needle.length - 1 };
  const len = needle.length;
  const K = Math.min(24, len >> 1);
  if (K < 4) return null;
  // Slide inward from each end: stray letters at an edge must not hide the rest.
  let head: { start: number } | null = null;
  for (let i = 0; i <= Math.min(80, len - K); i++) {
    const h = needle.slice(i, i + K);
    const at = nthMatch(hay, h, countBefore(other, h, from + i));
    if (at >= 0) {
      head = { start: Math.max(0, at - i) };
      break;
    }
  }
  let tail: { end: number } | null = null;
  for (let j = 0; j <= Math.min(80, len - K); j++) {
    const t = needle.slice(len - K - j, len - j);
    const at = nthMatch(hay, t, countBefore(other, t, from + len - K - j));
    if (at >= 0) {
      tail = { end: Math.min(hay.length - 1, at + K - 1 + j) };
      break;
    }
  }
  if (head && tail) {
    if (tail.end < head.start || tail.end - head.start > len + (len >> 1) + 40) return null;
    return { start: head.start, end: tail.end };
  }
  if (head) return { start: head.start, end: Math.min(hay.length - 1, head.start + len - 1) };
  if (tail) return { start: Math.max(0, tail.end - len + 1), end: tail.end };
  return null;
}

/**
 * Reading-mode UI that sits inside the prose but is not the document: its text is never in the source. Currently
 * the collapsible sections' toggle and "N hidden blocks" stub, the table pin/toggle buttons (icon-only today) and
 * the lightbox toolbar. Anything else that injects text into the prose should carry `data-reading-chrome`.
 */
export const READING_CHROME =
  'script,style,[hidden],[aria-hidden="true"],.folio-title-slot,[data-reading-chrome],.folio-collapsible-stub,.folio-collapse-toggle,.folio-table-pin,[data-table-pin],[data-table-toggle],.folio-lightbox__toolbar';

interface DomSkeleton {
  s: string;
  /** Where each skeleton character sits: text node and offset. */
  points: { node: Text; offset: number }[];
}

function domSkeleton(root: Node): DomSkeleton {
  let s = '';
  const points: DomSkeleton['points'] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest(READING_CHROME) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const sk = skeleton(node.data);
    s += sk.s;
    for (const index of sk.at) points.push({ node, offset: index });
  }
  return { s, points };
}

const MARKUP = '*_~`';
const PUNCT = /[^\p{L}\p{N}\s]/u;

/** The punctuation written right after `end` in `text`, markup characters between its marks skipped. */
function punctuationAfter(text: string, end: number, limit: number): string {
  let out = '';
  for (let p = end; p < limit; p++) {
    const ch = text[p];
    if (MARKUP.includes(ch)) continue;
    if (!PUNCT.test(ch)) break;
    out += ch;
  }
  return out;
}

/** A range in the source (editor coordinates) as the same run of letters in the rendered page. */
function domRangeFor(dom: DomSkeleton, src: Skeleton, markdown: string, shift: number, from: number, to: number): Range | null {
  const lo = src.at.findIndex((index) => index + shift >= from);
  let hi = -1;
  for (let k = src.at.length - 1; k >= 0; k--) {
    if (src.at[k] + shift < to) {
      hi = k;
      break;
    }
  }
  if (lo < 0 || hi < lo) return null;
  const found = alignRun(dom.s, src.s, lo, hi);
  if (!found) return null;
  const first = dom.points[found.start];
  const last = dom.points[found.end];
  // Punctuation the source range covers after its last letter is part of the selection.
  const lastAt = src.at[found.end] + shift;
  let end = last.offset + 1;
  if (to > lastAt + 1) {
    const want = punctuationAfter(markdown, lastAt + 1, to);
    for (const ch of want) {
      if (last.node.data[end] === ch) end++;
      else break;
    }
  }
  const range = document.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, end);
  return range;
}

/** DOM ranges for source ranges; a thread whose text is not on the page is left out. */
export function rangesInRendered(
  root: Node,
  markdown: string,
  items: readonly { id: string; from: number; to: number }[],
): Map<string, Range> {
  const out = new Map<string, Range>();
  if (items.length === 0) return out;
  // The properties block is not rendered, so its letters must not be counted.
  const shift = markdown.length - stripFrontmatter(markdown).length;
  const src = sourceSkeleton(markdown.slice(shift));
  const dom = domSkeleton(root);
  for (const item of items) {
    const range = domRangeFor(dom, src, markdown, shift, item.from, item.to);
    if (range) out.set(item.id, range);
  }
  return out;
}

/** The part of the source the reader selected in the rendered page, or null when it cannot be told. */
export function sourceRangeOfSelection(root: Node, markdown: string, selected: Range): { from: number; to: number } | null {
  const dom = domSkeleton(root);
  // A character is selected when both its edges lie inside the range.
  const inside = (k: number) => {
    const { node, offset } = dom.points[k];
    return selected.comparePoint(node, offset) === 0 && selected.comparePoint(node, offset + 1) === 0;
  };
  let first = -1;
  let last = -1;
  for (let k = 0; k < dom.points.length; k++) {
    if (!inside(k)) continue;
    if (first < 0) first = k;
    last = k;
  }
  if (first < 0) return null;
  const shift = markdown.length - stripFrontmatter(markdown).length;
  const src = sourceSkeleton(markdown.slice(shift));
  const found = alignRun(src.s, dom.s, first, last);
  if (!found) return null;
  // A drag that ends after the line's "?" selected it: include the trailing punctuation (and only what was selected).
  const lastPoint = dom.points[last];
  let trail = '';
  for (let j = lastPoint.offset + 1; j < lastPoint.node.length; j++) {
    const ch = lastPoint.node.data[j];
    if (!PUNCT.test(ch) || selected.comparePoint(lastPoint.node, j + 1) !== 0) break;
    trail += ch;
  }
  let to = shift + src.at[found.end] + 1;
  for (const ch of trail) {
    let at = to;
    while (MARKUP.includes(markdown[at] ?? '')) at++;
    if (markdown[at] !== ch) break;
    to = at + 1;
  }
  return { from: shift + src.at[found.start], to };
}

/* ---------------------------------------------------------------- painting -- */

const HIGHLIGHT = 'folio-comment';
const HIGHLIGHT_ACTIVE = 'folio-comment-active';

interface HighlightRegistry {
  set(name: string, value: unknown): void;
  delete(name: string): void;
}

function registry(): { registry: HighlightRegistry; Highlight: new (...ranges: Range[]) => unknown } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const ctor = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return css?.highlights && ctor ? { registry: css.highlights, Highlight: ctor } : null;
}

/** Paints the ranges; the active thread's in the stronger colour. Returns the function that takes them off again. */
export function paintReadingHighlights(ranges: ReadonlyMap<string, Range>, activeId: string | null): () => void {
  const api = registry();
  if (!api) return () => {};
  const normal: Range[] = [];
  const active: Range[] = [];
  for (const [id, range] of ranges) (id === activeId ? active : normal).push(range);
  api.registry.set(HIGHLIGHT, new api.Highlight(...normal));
  api.registry.set(HIGHLIGHT_ACTIVE, new api.Highlight(...active));
  return () => {
    api.registry.delete(HIGHLIGHT);
    api.registry.delete(HIGHLIGHT_ACTIVE);
  };
}

/** The thread whose painted range contains the point (a click on a highlight), if any. */
export function threadAtPoint(ranges: ReadonlyMap<string, Range>, x: number, y: number): string | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let node: Node | null = null;
  let offset = 0;
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) {
    node = position.offsetNode;
    offset = position.offset;
  } else {
    const caret = doc.caretRangeFromPoint?.(x, y);
    if (caret) {
      node = caret.startContainer;
      offset = caret.startOffset;
    }
  }
  if (!node) return null;
  let best: { id: string; size: number } | null = null;
  for (const [id, range] of ranges) {
    if (!range.isPointInRange(node, offset)) continue;
    const size = range.toString().length;
    if (!best || size < best.size) best = { id, size };
  }
  return best?.id ?? null;
}
