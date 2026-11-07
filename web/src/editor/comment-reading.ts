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
const UNRENDERED = [/\]\([^)\n]*\)/g, /<(?:https?:\/\/|mailto:)[^>\n]*>/g, /^ {0,3}\[[^\]\n]+\]:[^\n]*/gm, /^ {0,3}(?:`{3,}|~{3,})[^\n]*/gm];

/** The source's skeleton, without the parts the page never shows. Indices still point into `text`. */
function sourceSkeleton(text: string): Skeleton {
  let masked = text;
  for (const pattern of UNRENDERED) masked = masked.replace(pattern, (m) => ' '.repeat(m.length));
  return skeleton(masked);
}

interface DomSkeleton {
  s: string;
  /** Where each skeleton character sits: text node and offset. */
  points: { node: Text; offset: number }[];
}

function domSkeleton(root: Node): DomSkeleton {
  let s = '';
  const points: DomSkeleton['points'] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest('script,style,[hidden],[aria-hidden="true"],.folio-title-slot') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const sk = skeleton(node.data);
    s += sk.s;
    for (const index of sk.at) points.push({ node, offset: index });
  }
  return { s, points };
}

/** A range in the source (editor coordinates) as the same run of letters in the rendered page. */
function domRangeFor(dom: DomSkeleton, src: Skeleton, shift: number, from: number, to: number): Range | null {
  const lo = src.at.findIndex((index) => index + shift >= from);
  let hi = -1;
  for (let k = src.at.length - 1; k >= 0; k--) {
    if (src.at[k] + shift < to) {
      hi = k;
      break;
    }
  }
  if (lo < 0 || hi < lo) return null;
  const needle = src.s.slice(lo, hi + 1);
  const start = nthMatch(dom.s, needle, countBefore(src.s, needle, lo));
  if (start < 0) return null;
  const first = dom.points[start];
  const last = dom.points[start + needle.length - 1];
  const range = document.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
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
    const range = domRangeFor(dom, src, shift, item.from, item.to);
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
  const needle = dom.s.slice(first, last + 1);
  const shift = markdown.length - stripFrontmatter(markdown).length;
  const src = sourceSkeleton(markdown.slice(shift));
  const start = nthMatch(src.s, needle, countBefore(dom.s, needle, first));
  if (start < 0) return null;
  return { from: shift + src.at[start], to: shift + src.at[start + needle.length - 1] + 1 };
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
