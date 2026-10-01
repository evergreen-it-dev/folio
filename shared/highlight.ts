/**
 * `==highlight==` / `==highlight=={.token}` — the markdown-friendly inline
 * highlight format, and the legacy `<mark>text</mark>` it replaces (round:
 * highlight-as-markdown). Plain TS, no DOM — importable from both `web`
 * (the reading pipeline, `web/src/markdown/pipeline.ts`) and `server` (PDF
 * print and DOCX export, `server/export/print.ts` / `docx.ts`), which is
 * exactly why this file lives in `shared/` rather than `web/src/markdown/`.
 *
 * PALETTE: the eight tokens below are a deliberate byte-for-byte copy of
 * `BG_TOKENS` in `web/src/markdown/tableSyntax.ts` (the table-cell
 * background palette), NOT an import from it — `shared/` must not reach
 * into `web/`. Keep the two lists in sync by hand if the palette ever
 * changes; a mismatch would only mean a highlight colour falls back to
 * `yellow`, never a crash.
 *
 * ARCHITECTURE: `splitHighlightMarkers` below is a single, tree-shape
 * agnostic core (generic over `TNode`) that both consumers reuse:
 *   - `rehypeHighlight()` in this file drives it over hast nodes for the
 *     reading pipeline AND the PDF print pipeline (both run remark-rehype +
 *     rehype-raw, so `<mark>` from legacy HTML already arrives as a real
 *     hast `Element` by the time this plugin runs — it needs no special
 *     handling, it's simply an opaque atom like any other element, see
 *     "existing marks are opaque" below);
 *   - `server/export/docx.ts` drives the SAME core over mdast
 *     `PhrasingContent` nodes, because its own processor never runs
 *     remark-rehype at all (it renders straight from the markdown AST) —
 *     there `<mark>`/`</mark>` survive as literal `html` nodes, which is
 *     why docx.ts additionally pairs those up itself before calling this
 *     core (see `groupLegacyMarkupSpans` below, also exported for it).
 *   Writing the open/close + flanking-whitespace logic once here, tested
 *   once in highlight.test.ts, is the whole point — duplicating it by hand
 *   in docx.ts would be one more place for the two rules (GFM-flanking `==`
 *   vs bare-tag legacy `<mark>`) to quietly drift apart.
 */

/* ------------------------------------------------------------------ palette */

/** Exact copy of `BG_TOKENS` (tableSyntax.ts) — see file doc comment above. */
export const HIGHLIGHT_COLORS = ['yellow', 'green', 'teal', 'blue', 'purple', 'red', 'orange', 'gray'] as const;

export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

/** `==text==` with no `{.token}` renders as this colour. */
export const DEFAULT_HIGHLIGHT_COLOR: HighlightColor = 'yellow';

export function isHighlightColor(value: string): value is HighlightColor {
  return (HIGHLIGHT_COLORS as readonly string[]).includes(value);
}

/**
 * An unrecognised token (typo, or a palette word removed later) falls back
 * to the default colour rather than failing the whole render — same spirit
 * as an unknown `@handle` staying plain text in mentions.ts. `null`/
 * `undefined` (no `{.token}` written at all) is the ordinary default case,
 * not an error.
 */
export function resolveHighlightColor(token: string | null | undefined): HighlightColor {
  if (token && isHighlightColor(token)) return token;
  return DEFAULT_HIGHLIGHT_COLOR;
}

/**
 * The class names a highlight span renders as, everywhere: reading mode,
 * and (kept here for the editor to reuse later, so the two sides never
 * invent different class names) any live-preview surface. Always both
 * `folio-hl` (the shared base — hover affordances, print rules, … can hang
 * off just this one) and `folio-hl-<token>` (the actual colour), even for
 * the default: `folio-hl folio-hl-yellow`, never a bare `folio-hl`.
 */
export function highlightClass(token: string | null | undefined): string {
  return `folio-hl folio-hl-${resolveHighlightColor(token)}`;
}

/* --------------------------------------------------------------- regex pieces */

/**
 * Splits a plain string around every *candidate* `==` marker, keeping the
 * markers themselves (capturing group) so the caller can tell text pieces
 * and markers apart in the result of `String.prototype.split`.
 *
 * A run of three-or-more `=` never matches on either side — `(?<!=)`/`(?!=)`
 * reject any `=` that has another `=` touching it — so `===text===` is left
 * completely alone (not even partially split); only an EXACT pair counts as
 * a marker. This is the "exactly two `=`" rule from the spec, applied at
 * the tokenizing stage rather than after the fact.
 */
export const HIGHLIGHT_MARKER_SPLIT_RE = /((?<!=)==(?!=))/;

/**
 * The optional `{.token}` immediately after a closing `==`, anchored to the
 * very start of the string it's tested against (the text right after the
 * marker). Deliberately permissive about the token's own characters — an
 * unrecognised word still matches here and still gets stripped from the
 * output, see `resolveHighlightColor`'s doc comment — this file is not the
 * place that decides validity, only the place that decides *what a valid
 * colour renders as*.
 */
export const HIGHLIGHT_TOKEN_ANNOTATION_RE = /^\{\.([a-zA-Z][a-zA-Z0-9_-]*)\}/;

/**
 * A fully self-contained `==content==` or `==content=={.token}` span
 * matched in one go, for callers that only ever need the simple
 * single-string case (no other inline markup inside the highlight — e.g.
 * a quick test assertion, or a future caller that doesn't have a tree to
 * walk). `rehypeHighlight` and `groupLegacyMarkupSpans`/docx.ts do NOT use
 * this — they need the marker/token pieces above separately, because the
 * highlighted text can be split across sibling nodes (`==**bold**==`).
 * Content must be non-empty and not start/end with whitespace — the same
 * flanking spirit as GFM `~~strike~~`.
 */
export const HIGHLIGHT_RE = /(?<!=)==(?!=)(\S(?:[^\n]*?\S)?|\S)(?<!=)==(?!=)(?:\{\.([a-zA-Z][a-zA-Z0-9_-]*)\})?/g;

/* ------------------------------------------------------------- generic core */

/** A resolved highlight span: its content, and the colour it renders as. */
export interface HighlightGroup<TNode> {
  readonly kind: 'folio-highlight-group';
  readonly token: HighlightColor;
  readonly children: readonly HighlightItem<TNode>[];
}

/** Either an ordinary tree node, or an already-resolved highlight span. */
export type HighlightItem<TNode> = TNode | HighlightGroup<TNode>;

export function isHighlightGroup<TNode>(item: HighlightItem<TNode>): item is HighlightGroup<TNode> {
  return typeof item === 'object' && item !== null && (item as { kind?: unknown }).kind === 'folio-highlight-group';
}

/** How `splitHighlightMarkers` reads/builds the one node type it actually understands: plain text. Everything else is an opaque atom to it. */
export interface HighlightTextAdapter<TNode> {
  /** Returns the node's text when it IS a plain text node, `undefined` otherwise (an element/other node is opaque — never split, never scanned into). */
  getText: (node: TNode) => string | undefined;
  /** Builds a fresh plain text node carrying `value`, same "kind" of node the tree otherwise uses. */
  makeText: (value: string) => TNode;
}

/**
 * The shared open/close + flanking-whitespace scanner. Turns a flat list of
 * siblings (already possibly containing pre-resolved `HighlightGroup`s —
 * docx.ts's legacy-`<mark>` pass runs first and hands its result in here,
 * see `groupLegacyMarkupSpans`) into the same list with every valid
 * `==...==`/`==...=={.token}` span collapsed into one `HighlightGroup`.
 *
 * Algorithm, in short (see highlight.test.ts for the cases this covers):
 * every plain-text sibling is first split into text/marker atoms at each
 * candidate `==` (via HIGHLIGHT_MARKER_SPLIT_RE); every non-text sibling
 * (an element, a pre-resolved group, …) becomes one opaque atom. A single
 * left-to-right scan then pairs markers up: a marker with no pending opener
 * tries to OPEN (valid only if what immediately follows is non-whitespace —
 * an opaque atom always counts as "content", only a text atom's own
 * leading character is checked); a marker WITH a pending opener tries to
 * CLOSE the same way against what immediately precedes it. Two markers
 * back-to-back (zero-width content) can't pair, so the first is dropped and
 * the second is retried as a fresh opener. A `==` that fails to open OR
 * close in context is left as literal `==` text — this is also how a
 * genuinely unclosed opener at the end of the list resolves, since it's
 * simply never matched by anything.
 */
export function splitHighlightMarkers<TNode extends { type: string }>(
  nodes: readonly HighlightItem<TNode>[],
  adapter: HighlightTextAdapter<TNode>,
): HighlightItem<TNode>[] {
  type Atom = { kind: 'text'; value: string } | { kind: 'marker' } | { kind: 'node'; item: HighlightItem<TNode> };

  const atoms: Atom[] = [];
  for (const item of nodes) {
    const text = isHighlightGroup(item) ? undefined : adapter.getText(item);
    if (text === undefined) {
      atoms.push({ kind: 'node', item });
      continue;
    }
    for (const piece of text.split(HIGHLIGHT_MARKER_SPLIT_RE)) {
      if (piece === '') continue;
      atoms.push(piece === '==' ? { kind: 'marker' } : { kind: 'text', value: piece });
    }
  }

  const canOpen = (m: number): boolean => {
    const next = atoms[m + 1];
    if (!next) return false;
    return next.kind === 'text' ? next.value.length > 0 && !/^\s/.test(next.value) : true;
  };
  const canClose = (m: number): boolean => {
    const prev = atoms[m - 1];
    if (!prev) return false;
    return prev.kind === 'text' ? prev.value.length > 0 && !/\s$/.test(prev.value) : true;
  };

  interface Span {
    openIdx: number;
    closeIdx: number;
    token: HighlightColor;
    tokenStripAtomIdx?: number;
    tokenStripLen?: number;
  }
  const spans: Span[] = [];
  let openIdx: number | null = null;
  for (let m = 0; m < atoms.length; m++) {
    if (atoms[m].kind !== 'marker') continue;
    if (openIdx === null) {
      if (canOpen(m)) openIdx = m;
      continue;
    }
    if (m === openIdx + 1) {
      // Adjacent markers: zero-width content can't be a span. Drop the
      // earlier opener and see whether this one can open instead.
      openIdx = canOpen(m) ? m : null;
      continue;
    }
    if (!canClose(m)) continue; // trailing-whitespace content: stays open, this "==" is just literal content
    const next = atoms[m + 1];
    const annotationSource = next && next.kind === 'text' ? next.value : undefined;
    const annotation = annotationSource ? HIGHLIGHT_TOKEN_ANNOTATION_RE.exec(annotationSource) : null;
    spans.push({
      openIdx,
      closeIdx: m,
      token: resolveHighlightColor(annotation ? annotation[1] : null),
      tokenStripAtomIdx: annotation ? m + 1 : undefined,
      tokenStripLen: annotation ? annotation[0].length : undefined,
    });
    openIdx = null;
  }

  // Strip a consumed `{.token}` annotation in place — this only ever
  // shortens (or empties) one text atom, so it can't shift any index.
  for (const span of spans) {
    if (span.tokenStripAtomIdx === undefined) continue;
    const atom = atoms[span.tokenStripAtomIdx];
    if (atom.kind === 'text') atom.value = atom.value.slice(span.tokenStripLen ?? 0);
  }

  const spanByOpen = new Map(spans.map((s) => [s.openIdx, s]));
  const out: HighlightItem<TNode>[] = [];
  const pushText = (list: HighlightItem<TNode>[], value: string): void => {
    if (value === '') return;
    const last = list[list.length - 1];
    const lastText = last !== undefined && !isHighlightGroup(last) ? adapter.getText(last) : undefined;
    if (lastText !== undefined) list[list.length - 1] = adapter.makeText(lastText + value);
    else list.push(adapter.makeText(value));
  };

  let i = 0;
  while (i < atoms.length) {
    const span = spanByOpen.get(i);
    if (span) {
      const children: HighlightItem<TNode>[] = [];
      for (let j = span.openIdx + 1; j < span.closeIdx; j++) {
        const atom = atoms[j];
        if (atom.kind === 'marker') pushText(children, '=='); // a failed inner close/open: literal content
        else if (atom.kind === 'text') pushText(children, atom.value);
        else children.push(atom.item);
      }
      out.push({ kind: 'folio-highlight-group', token: span.token, children });
      i = span.closeIdx + 1;
      continue;
    }
    const atom = atoms[i];
    if (atom.kind === 'marker') pushText(out, '==');
    else if (atom.kind === 'text') pushText(out, atom.value);
    else out.push(atom.item);
    i++;
  }
  return out;
}

/**
 * Pairs up a legacy `<mark>…</mark>` written as raw HTML that never got
 * parsed into a real element — the situation `server/export/docx.ts` is in,
 * since its processor stops at mdast and never runs remark-rehype/
 * rehype-raw, so the tags survive as literal `html`-type siblings (see this
 * file's own doc comment). Meant to run BEFORE `splitHighlightMarkers` on
 * the same list — that function treats an already-built `HighlightGroup`
 * as one opaque atom, exactly like any other non-text node, so a `==` span
 * is free to wrap around (but never INTO) a legacy `<mark>` this pass
 * already resolved.
 *
 * An HTML tag, unlike `==`, is unambiguous (an opening tag can only open, a
 * closing tag can only close) and carries no flanking-whitespace rule, so
 * this is a plain, non-nesting stack: the first still-open `<mark>` pairs
 * with the next `</mark>`. An unmatched opener's buffered content is
 * emitted plain (nothing to close it with); a stray `</mark>` with nothing
 * open is simply dropped — same fate either tag already had under the
 * pre-existing `case 'html': break` this augments.
 *
 * `token` is always the default colour: the legacy tag never carried one.
 */
export function groupLegacyMarkupSpans<TNode extends { type: string }>(
  nodes: readonly TNode[],
  isMarkTag: (node: TNode) => 'open' | 'close' | undefined,
): HighlightItem<TNode>[] {
  const out: HighlightItem<TNode>[] = [];
  let inSpan = false;
  let buffer: TNode[] = [];
  for (const node of nodes) {
    const tag = isMarkTag(node);
    if (tag === 'open') {
      if (!inSpan) {
        inSpan = true;
        buffer = [];
      } // a nested/duplicate opener before any close: stays part of the current span rather than starting a new one
      continue;
    }
    if (tag === 'close') {
      if (inSpan) {
        out.push({ kind: 'folio-highlight-group', token: DEFAULT_HIGHLIGHT_COLOR, children: buffer });
        inSpan = false;
        buffer = [];
      }
      continue;
    }
    if (inSpan) buffer.push(node);
    else out.push(node);
  }
  if (inSpan) out.push(...buffer); // unmatched opener: nothing to wrap it in, so its content still renders plain
  return out;
}

/* -------------------------------------------------------- hast (reading/print) */

// Kept local rather than importing 'hast' at the top of the file's public
// surface — this module is also typechecked under server/tsconfig.node.json,
// which has no DOM lib; @types/hast itself needs none either, but importing
// only the pieces actually used keeps that fact easy to verify at a glance.
import type { Element, ElementContent, Root, RootContent, Text } from 'hast';

/** Tags whose text this plugin never rewrites, and never descends into. `mark` covers BOTH legacy `<mark>` (already parsed into a real element by rehype-raw before this plugin runs — see file doc comment) and any `mark` this same plugin produced a moment earlier for an EARLIER `==` span in the same document; neither gets rescanned. */
const HAST_SKIP_TAGS = new Set(['code', 'pre', 'mark']);

const hastTextAdapter: HighlightTextAdapter<RootContent> = {
  getText: (node) => (node.type === 'text' ? (node as Text).value : undefined),
  makeText: (value) => ({ type: 'text', value }) as Text,
};

function buildMarkElement(token: HighlightColor, children: ElementContent[]): Element {
  return {
    type: 'element',
    tagName: 'mark',
    properties: { className: highlightClass(token).split(' ') },
    children,
  };
}

/** Bottom-up: turns the generic `HighlightItem` list back into real hast children, building one `mark` Element per resolved group. */
function realizeHast(items: readonly HighlightItem<RootContent>[]): RootContent[] {
  const out: RootContent[] = [];
  for (const item of items) {
    if (isHighlightGroup(item)) out.push(buildMarkElement(item.token, realizeHast(item.children) as ElementContent[]));
    else out.push(item);
  }
  return out;
}

/** Depth-first, in place — same "rebuild this children array" shape used throughout web/src/markdown (mentions.ts's `walk`, collapsibleSections.ts's `groupSiblings`): precise control over how many nodes replace how many others, which a plain visit-and-mutate can't do when several siblings collapse into one. */
function walkHast(children: RootContent[]): RootContent[] {
  const realized = realizeHast(splitHighlightMarkers(children, hastTextAdapter));
  for (const node of realized) {
    if (node.type === 'element' && !HAST_SKIP_TAGS.has(node.tagName)) {
      node.children = walkHast(node.children as RootContent[]) as ElementContent[];
    }
  }
  return realized;
}

/**
 * Rehype plugin: turns `==text==` / `==text=={.token}` into
 * `<mark class="folio-hl folio-hl-<token>">text</mark>` (default token
 * `yellow` when no `{.token}` is written). Existing `<mark>` elements —
 * legacy pages, already-parsed by rehype-raw by the time this runs — are
 * left completely untouched, both the element itself and its contents.
 *
 * Must run AFTER rehype-raw (so legacy `<mark>` is already a real element,
 * not raw HTML text this plugin would otherwise have to parse itself) and
 * BEFORE rehype-sanitize (so the `mark`/`className` it produces gets vetted
 * like everything else) — see pipeline.ts's own ordering comment.
 */
export function rehypeHighlight() {
  return (tree: Root) => {
    tree.children = walkHast(tree.children);
  };
}
