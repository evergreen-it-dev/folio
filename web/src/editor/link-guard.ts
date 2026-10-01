/**
 * Keeps a folded inline construct's markup intact while its markers are
 * hidden in live mode: `[text](url)`, `**strong**`/`__strong__`,
 * `*em*`/`_em_`, `~~strike~~`, `` `code` ``, and the two HTML formats the
 * formatting toolbar writes, `<ins>`/`<u>` and `<mark>`.
 *
 * `live-preview.ts` hides every one of those markers with `Decoration.replace`
 * and makes them atomic, so the caret can no longer rest strictly *inside*
 * one — but a caret sitting at the *boundary* between the visible text and a
 * hidden marker is still a perfectly legal position (it has to be: that is
 * where the visible text itself starts/ends and stays editable). That
 * boundary looks exactly like "end of line" (or "start of line") once the
 * marker on that side is folded away, so a plain Enter/Backspace/Delete there
 * still splits or partially eats the construct's raw markdown — the owner's
 * screenshot: a Backspace at what looked like the start of a word ate only
 * the opening `**`, stranding the closing one. This module intercepts those
 * three keys, at a boundary only: Enter is redirected to the near edge of
 * the WHOLE construct, so a newline never splits the marker pair;
 * Backspace/Delete eat one VISIBLE character on the far side of the marker
 * (`constructDeleteGuard`), and the pair itself goes only once nothing is
 * left between its markers (`emptyConstructCleanup`). A Backspace at the
 * visual start of an ATX heading gets the same care (`headingBackspaceGuard`).
 * A space typed at the inner edge of a folded format lands outside the pair
 * (`edgeSpaceGuard`): next to a space a `**` is no longer a marker.
 *
 * Two different lookups feed the same guard, because the constructs come in
 * two shapes:
 *  - `[…](…)`, `**…**`, `*…*`, `~~…~~`, `` `…` `` are each ONE syntax node
 *    with exactly two marker children (`LinkMark`/`EmphasisMark`/
 *    `StrikethroughMark`/`CodeMark`) — `constructNodeAt` + `foldedSpan`.
 *  - `<ins>…</ins>`/`<u>…</u>`/`<mark>…</mark>` are not a node at all: two
 *    sibling `HTMLTag` leaves that `live-decorations.ts` pairs up itself —
 *    `htmlPairAt` repeats that exact pairing (open/close stack keyed by tag
 *    name) so it can only ever agree with what is actually folded.
 */
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, Prec, Transaction, findClusterBreak, type Extension, type Text } from '@codemirror/state';
import { keymap, type Command } from '@codemirror/view';
import type { SyntaxNode, Tree } from '@lezer/common';
import { nearestLinkEdge } from './gfm-table';
import { CALLOUT_TYPES } from './live-decorations';
import { liveModeFacet } from './live-preview';

const CALLOUT_LABEL = new RegExp(`^!(${CALLOUT_TYPES.join('|')})$`, 'i');

/** The outer span of a folded construct, and where its visible text sits inside it. */
interface FoldedSpan {
  outerFrom: number;
  outerTo: number;
  innerFrom: number;
  innerTo: number;
}

/**
 * Syntax-tree constructs whose folded pair is exactly two marker children of
 * the named type, with the visible text between the first and the last of
 * them — every inline construct live mode hides this way except the two HTML
 * formats (`htmlPairAt`, below: not one syntax node, so not this shape).
 */
const MARK_CHILD: Record<string, string> = {
  Link: 'LinkMark',
  StrongEmphasis: 'EmphasisMark',
  Emphasis: 'EmphasisMark',
  Strikethrough: 'StrikethroughMark',
  InlineCode: 'CodeMark',
  Highlight: 'HighlightMark',
};

/** Finds the nearest ancestor of a foldable kind whose span contains `pos` (inclusive of its edges). */
function constructNodeAt(tree: Tree, pos: number): SyntaxNode | null {
  for (const side of [-1, 1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name in MARK_CHILD && node.from <= pos && pos <= node.to) return node;
    }
  }
  return null;
}

/**
 * Mirrors the matching case in `live-decorations.ts`: only a construct with
 * both its marker children AND a non-empty inside actually gets folded (see
 * `foldMarker`/the `Link` case there), and a `[!NOTE]`-style callout marker
 * is excluded — it's replaced by its own label widget, not folded like a
 * plain link, so it carries none of this trap. Neither variant reaches the
 * caret trap this module guards against, so both fall through to normal
 * editing.
 *
 * `marks[1]`, deliberately not the LAST mark: `StrongEmphasis`/`Emphasis`/
 * `Strikethrough`/`InlineCode` always have exactly two `getChildren(markName)`
 * results (open, close), but `Link` has FOUR — `[`, `]`, `(`, `)`, all tagged
 * `LinkMark` — and marks[1] is the `]` that actually ends the visible label;
 * the last one is the closing `)` of the URL.
 */
function foldedSpan(node: SyntaxNode, doc: Text): FoldedSpan | null {
  const markName = MARK_CHILD[node.name];
  if (!markName) return null;
  const marks = node.getChildren(markName);
  if (marks.length < 2) return null;
  const innerFrom = marks[0].to;
  const innerTo = marks[1].from;
  if (innerTo <= innerFrom) return null;
  if (node.name === 'Link' && CALLOUT_LABEL.test(doc.sliceString(innerFrom, innerTo))) return null;
  // `==text=={.green}`: the colour attribute is a sibling flush after the node
  // (highlight-syntax.ts) and belongs to the construct as far as folding goes.
  let outerTo = node.to;
  if (node.name === 'Highlight') {
    const next = node.nextSibling;
    if (next?.name === 'HighlightAttr' && next.from === node.to) outerTo = next.to;
  }
  return { outerFrom: node.from, outerTo, innerFrom, innerTo };
}

/** One `<ins>`/`<u>`/`<mark>` pair — the same tag vocabulary `live-decorations.ts`'s `INLINE_HTML` folds. */
const HTML_FOLDED = new Set(['ins', 'u', 'mark']);
const HTML_TAG = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\s*>$/;

interface HtmlTagRef {
  from: number;
  to: number;
  name: string;
  closing: boolean;
}

function readHtmlTag(text: string, from: number, to: number): HtmlTagRef | null {
  const match = HTML_TAG.exec(text);
  if (!match) return null;
  const name = match[2].toLowerCase();
  if (!HTML_FOLDED.has(name)) return null;
  return { from, to, name, closing: match[1] === '/' };
}

/**
 * The `<ins>`/`<u>`/`<mark>` pair whose folded span covers `pos`, if any.
 * Repeats `live-decorations.ts`'s own open/close pairing (a stack keyed by
 * tag name, matched in document order) rather than sharing it: that pass
 * walks the viewport's decorations, this one answers a single caret
 * position, and duplicating the ~10 lines of stack logic is simpler than
 * threading a whole-document result back out of a view-only computation.
 */
function htmlPairAt(tree: Tree, doc: Text, pos: number): FoldedSpan | null {
  const tags: HtmlTagRef[] = [];
  tree.iterate({
    enter: (node) => {
      if (node.name !== 'HTMLTag') return;
      const tag = readHtmlTag(doc.sliceString(node.from, node.to), node.from, node.to);
      if (tag) tags.push(tag);
    },
  });

  const openStack: HtmlTagRef[] = [];
  for (const tag of tags) {
    if (!tag.closing) {
      openStack.push(tag);
      continue;
    }
    let at = -1;
    for (let i = openStack.length - 1; i >= 0; i--) {
      if (openStack[i].name === tag.name) {
        at = i;
        break;
      }
    }
    if (at === -1) continue;
    const start = openStack[at];
    openStack.length = at;
    if (pos >= start.from && pos <= tag.to) {
      return { outerFrom: start.from, outerTo: tag.to, innerFrom: start.to, innerTo: tag.from };
    }
  }
  return null;
}

/** The folded construct (of any kind this module knows) whose span covers `pos`, if any. */
function foldedConstructAt(tree: Tree, doc: Text, pos: number): FoldedSpan | null {
  const node = constructNodeAt(tree, pos);
  if (node) {
    const span = foldedSpan(node, doc);
    if (span) return span;
  }
  return htmlPairAt(tree, doc, pos);
}

/**
 * Where a newline at `pos` should actually land: unchanged unless `pos` is
 * strictly inside a folded construct's span, in which case it snaps to
 * whichever end of the construct is closer — keeping the whole thing on one
 * side.
 *
 * "Closer" is measured against the *visible text*, not the raw span
 * (`nearestLinkEdge`, shared with the table-cell version of this same guard
 * in gfm-table.ts): a link's URL is usually much longer than its label, so a
 * tie-break against the raw span would almost always push backward, before
 * the construct, even for a caret sitting right at the visible text's tail
 * end (the position that looks exactly like "end of line" once the trailing
 * marker is folded away).
 */
function enterSafePos(tree: Tree, doc: Text, pos: number): number {
  const span = foldedConstructAt(tree, doc, pos);
  if (!span || pos <= span.outerFrom || pos >= span.outerTo) return pos;
  return nearestLinkEdge(pos, span.innerFrom, span.innerTo, span.outerFrom, span.outerTo);
}

/** Constructs whose markers can simply be closed and reopened around a line break. */
const SPLITTABLE = new Set(['StrongEmphasis', 'Emphasis', 'Strikethrough', 'Highlight']);

/**
 * The chain of folded constructs whose VISIBLE text strictly contains `pos`,
 * innermost first, as the marker text each one opens and closes with — or
 * null when any of them cannot be split (a link's closer carries the URL, a
 * code span has no business spanning lines): those keep the edge-snapping
 * rule.
 */
interface SplitChain {
  /** Innermost first. */
  marks: { open: string; close: string }[];
  /** The innermost run's visible text — what the two halves are cut out of. */
  innerFrom: number;
  innerTo: number;
}

function splittableChainAt(tree: Tree, doc: Text, pos: number): SplitChain | null {
  const marks: SplitChain['marks'] = [];
  let inner: { from: number; to: number } | null = null;
  for (let node = constructNodeAt(tree, pos); node; node = node.parent) {
    if (!(node.name in MARK_CHILD)) continue;
    const span = foldedSpan(node, doc);
    if (!span || pos <= span.innerFrom || pos >= span.innerTo) break;
    if (!SPLITTABLE.has(node.name)) return null;
    marks.push({ open: doc.sliceString(span.outerFrom, span.innerFrom), close: doc.sliceString(span.innerTo, span.outerTo) });
    inner ??= { from: span.innerFrom, to: span.innerTo };
  }
  const html = htmlPairAt(tree, doc, pos);
  if (html && pos > html.innerFrom && pos < html.innerTo) {
    marks.push({ open: doc.sliceString(html.outerFrom, html.innerFrom), close: doc.sliceString(html.innerTo, html.outerTo) });
    inner ??= { from: html.innerFrom, to: html.innerTo };
  }
  return marks.length > 0 && inner ? { marks, innerFrom: inner.from, innerTo: inner.to } : null;
}

/**
 * Enter, above the markdown package's own list-continuation binding.
 *
 * Inside the visible text of a bold/italic/strike/`<ins>`/`<mark>` run the
 * break SPLITS it: the markers are closed before the newline and reopened
 * after it, so both halves keep their format — the owner, 24.09.2026:
 * "the caret is in the middle of bold, Enter — the piece after the caret must
 * move to a new line, and instead the whole block moved". Nested runs close innermost-first and
 * reopen outermost-first, so `***a|b***` becomes two complete `***…***`.
 *
 * At a construct's edge, or inside a link or code span, the caret is pushed
 * to the safe edge of the whole construct instead (`enterSafePos`), so a
 * newline never lands between a marker pair. Either way the newline itself
 * comes from `insertNewlineContinueMarkup`, so list continuation still works.
 */
const constructEnterGuard: Command = (view) => {
  const { state } = view;
  if (!state.facet(liveModeFacet)) return false;
  const tree = syntaxTree(state);

  const main = state.selection.main;
  if (state.selection.ranges.length === 1 && main.empty) {
    const chain = splittableChainAt(tree, state.doc, main.head);
    // Whitespace next to the cut would end up hugging a marker (`**bold **`),
    // which GFM refuses to read as emphasis — so the cut is made between the
    // words, and a cut that would leave either half empty snaps instead.
    let closeAt = main.head;
    let openFrom = main.head;
    while (chain && closeAt > chain.innerFrom && /\s/.test(state.doc.sliceString(closeAt - 1, closeAt))) closeAt--;
    while (chain && openFrom < chain.innerTo && /\s/.test(state.doc.sliceString(openFrom, openFrom + 1))) openFrom++;
    if (chain && closeAt > chain.innerFrom && openFrom < chain.innerTo) {
      const closers = chain.marks.map((c) => c.close).join('');
      const openers = [...chain.marks].reverse().map((c) => c.open).join('');
      view.dispatch({
        changes: { from: closeAt, to: openFrom, insert: closers },
        selection: EditorSelection.cursor(closeAt + closers.length),
        userEvent: 'input',
      });
      if (!insertNewlineContinueMarkup(view)) view.dispatch(view.state.replaceSelection('\n'), { userEvent: 'input' });
      const at = view.state.selection.main.head;
      view.dispatch({
        changes: { from: at, insert: openers },
        selection: EditorSelection.cursor(at + openers.length),
        scrollIntoView: true,
        userEvent: 'input',
      });
      return true;
    }
  }

  let changed = false;
  const ranges = state.selection.ranges.map((range) => {
    if (!range.empty) return range;
    const pos = enterSafePos(tree, state.doc, range.head);
    if (pos === range.head) return range;
    changed = true;
    return EditorSelection.cursor(pos);
  });
  if (!changed) return false;
  view.dispatch({ selection: EditorSelection.create(ranges, state.selection.mainIndex) });
  return insertNewlineContinueMarkup(view);
};

/**
 * One grapheme cluster back from / forward of `pos`, or the line break when
 * `pos` sits at the line's edge — what `deleteCharBackward`/`Forward` would
 * take, so a guarded press eats exactly what an unguarded one does.
 */
function clusterBefore(doc: Text, pos: number): number {
  const line = doc.lineAt(pos);
  if (pos === line.from) return Math.max(0, pos - 1);
  return line.from + findClusterBreak(line.text, pos - line.from, false);
}

function clusterAfter(doc: Text, pos: number): number {
  const line = doc.lineAt(pos);
  if (pos === line.to) return Math.min(doc.length, pos + 1);
  return line.from + findClusterBreak(line.text, pos - line.from, true);
}

/**
 * A line prefix that is nothing but block markup — list bullet, task box,
 * quote `>` or ATX `#`s — which the markdown keymap (`deleteMarkupBackward`)
 * and `headingBackspaceGuard` below know how to take back as a unit.
 */
const BLOCK_MARKUP_PREFIX = /^\s*(?:(?:[-*+]|\d+[.)])(?:\s+\[[ xX]\])?|>|#{1,6})\s+$/;

/**
 * A Backspace/Delete at the boundary of a folded construct. The marker is
 * invisible, so the two legal caret positions on either side of it are the
 * SAME spot to the eye, and the key must do what it looks like it does — eat
 * one visible character — never half of the markup and never (the owner,
 * 24.09.2026: "I put the caret before bold, Backspace — the whole text was gone")
 * the whole construct:
 *
 *  - Backspace right after the opening marker (the visual start of the text)
 *    removes the character BEFORE the construct, as if the caret had been in
 *    front of the marker; right after the closing marker (the visual end) it
 *    removes the construct's last visible character.
 *  - Delete mirrors that: right before the opening marker it removes the
 *    first visible character; right before the closing marker it removes the
 *    character AFTER the construct.
 *
 * When the last visible character goes the construct is empty, and
 * `emptyConstructCleanup` drops the now-pointless marker pair in the same
 * transaction — the old "delete the whole thing" outcome survives only as
 * that natural end state. Mid-text presses are untouched.
 *
 * One deliberate hand-off: Backspace at the visual start of a construct that
 * opens the line's text, with only block markup in front of it (`- **x**`,
 * `# **x**`), moves the caret in front of the marker and RETURNS FALSE, so
 * the heading guard / `deleteMarkupBackward` take the markup back as a unit
 * instead of this guard eating the one space that made it markup.
 */
function constructDeleteGuard(forward: boolean): Command {
  return (view) => {
    const { state } = view;
    if (state.readOnly || !state.facet(liveModeFacet)) return false;
    const tree = syntaxTree(state);
    const doc = state.doc;
    let handled = false;
    let handOff: number | null = null;
    const tr = state.changeByRange((range) => {
      if (!range.empty) return { range };
      const pos = range.head;
      const span = foldedConstructAt(tree, doc, pos);
      if (!span) return { range };
      let from: number;
      let to: number;
      let head: number;
      if (forward) {
        if (pos === span.outerFrom) {
          from = span.innerFrom;
          to = clusterAfter(doc, from);
          head = from;
        } else if (pos === span.innerTo) {
          from = span.outerTo;
          to = clusterAfter(doc, from);
          head = pos;
        } else return { range };
      } else if (pos === span.innerFrom) {
        to = span.outerFrom;
        const line = doc.lineAt(to);
        if (to > line.from && BLOCK_MARKUP_PREFIX.test(doc.sliceString(line.from, to))) {
          handOff = to;
          return { range };
        }
        from = clusterBefore(doc, to);
        head = pos - (to - from);
      } else if (pos === span.outerTo) {
        to = span.innerTo;
        from = clusterBefore(doc, to);
        head = from;
      } else return { range };
      handled = true;
      if (from === to) return { range };
      return { changes: { from, to }, range: EditorSelection.cursor(head) };
    });
    if (handOff !== null) {
      view.dispatch({ selection: EditorSelection.cursor(handOff) });
      return false;
    }
    if (!handled) return false;
    if (tr.changes.empty) return true;
    view.dispatch(state.update(tr, {
      scrollIntoView: true,
      userEvent: forward ? 'delete.forward' : 'delete.backward',
    }));
    return true;
  };
}

/** The `ATXHeadingN` node that owns the line starting at `lineFrom`, if that line is one. */
function atxHeadingAt(tree: Tree, lineFrom: number): SyntaxNode | null {
  for (let node: SyntaxNode | null = tree.resolveInner(lineFrom, 1); node; node = node.parent) {
    if (node.name.startsWith('ATXHeading')) return node.from === lineFrom ? node : null;
  }
  return null;
}

/**
 * Backspace at the visual start of an ATX heading (the owner, 24.09.2026:
 * "the caret is before a heading, Backspace — the formatting is gone"). The
 * folded `# ` makes the line's first two caret positions look identical, and
 * a plain Backspace at either one broke the heading: after the marker it ate
 * the space (`#Title` — literal text with a stray `#`), before it it glued
 * the heading onto the previous line. Now:
 *
 *  - a blank line above is what gets removed — the heading moves up, intact;
 *  - otherwise the heading turns into a plain paragraph (the block editors'
 *    convention), and only a SECOND Backspace joins it to the line above.
 *
 * Line 1 is the page title (protected-title.ts) and is left alone.
 */
const headingBackspaceGuard: Command = (view) => {
  const { state } = view;
  if (state.readOnly || !state.facet(liveModeFacet)) return false;
  const tree = syntaxTree(state);
  const doc = state.doc;
  let handled = false;
  const tr = state.changeByRange((range) => {
    if (!range.empty) return { range };
    const line = doc.lineAt(range.head);
    const heading = atxHeadingAt(tree, line.from);
    if (!heading) return { range };
    const marks = heading.getChildren('HeaderMark');
    if (marks.length === 0 || marks[0].from !== line.from) return { range };
    let textFrom = marks[0].to;
    while (textFrom < line.to && doc.sliceString(textFrom, textFrom + 1) === ' ') textFrom++;
    if (range.head !== line.from && range.head !== textFrom) return { range };
    handled = true;
    if (line.number === 1) return { range };
    const prev = doc.line(line.number - 1);
    if (prev.text.trim() === '') {
      const cut = line.from - prev.from;
      return { changes: { from: prev.from, to: line.from }, range: EditorSelection.cursor(range.head - cut) };
    }
    const changes = [{ from: line.from, to: textFrom }];
    if (marks.length > 1) {
      // A closing `#` run is the same markup — it goes with the prefix.
      let start = marks[1].from;
      while (start > textFrom && doc.sliceString(start - 1, start) === ' ') start--;
      changes.push({ from: start, to: marks[1].to });
    }
    return { changes, range: EditorSelection.cursor(line.from) };
  });
  if (!handled) return false;
  if (tr.changes.empty) return true;
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'delete.backward' }));
  return true;
};

/**
 * The outermost folded construct whose visible text is EXACTLY [from, to] —
 * nested pairs (`***x***`, `<mark>**x**</mark>`) are walked outwards while
 * each one is emptied in turn, so the whole stack goes at once.
 */
function constructEmptiedBy(tree: Tree, doc: Text, from: number, to: number): FoldedSpan | null {
  let result: FoldedSpan | null = null;
  let inner = { from, to };
  for (let node = constructNodeAt(tree, from); node; node = node.parent) {
    if (!(node.name in MARK_CHILD)) continue;
    const span = foldedSpan(node, doc);
    if (!span || span.innerFrom !== inner.from || span.innerTo !== inner.to) break;
    result = span;
    inner = { from: span.outerFrom, to: span.outerTo };
  }
  const html = htmlPairAt(tree, doc, inner.from);
  if (html && html.innerFrom === inner.from && html.innerTo === inner.to) result = html;
  return result;
}

/**
 * When a deletion empties a folded construct — its last visible character
 * goes, the label is cut, a selection covering exactly the text is
 * backspaced — the marker pair goes with it, in the same transaction (one
 * undo step). Left alone, `****` or `[](url)` would sit in the page as
 * literal text: the owner, 24.09.2026, "I cut out bold text — **** stayed;
 * I removed the text — the formatting has to go too".
 */
const emptyConstructCleanup = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent('delete') || !tr.startState.facet(liveModeFacet)) return tr;
  const tree = syntaxTree(tr.startState);
  const doc = tr.startState.doc;
  const drops: { from: number; to: number }[] = [];
  tr.changes.iterChanges((fromA, toA, fromB, toB) => {
    if (fromA === toA || fromB !== toB) return;
    const span = constructEmptiedBy(tree, doc, fromA, toA);
    if (!span) return;
    drops.push({ from: tr.changes.mapPos(span.outerFrom, -1), to: tr.changes.mapPos(span.outerTo, 1) });
  });
  if (drops.length === 0) return tr;
  return [tr, { changes: drops, sequential: true }];
});

/**
 * One step outwards from `at`, if `at` is the inner edge of a folded
 * construct: its outer edge on the same side. Null when `at` is no such edge,
 * or the construct is inline code — there a space is part of the code.
 */
function stepOutOfConstruct(tree: Tree, doc: Text, at: number, start: boolean): number | null {
  const inner = start ? 'innerFrom' : 'innerTo';
  const outer = start ? 'outerFrom' : 'outerTo';
  for (let node = constructNodeAt(tree, at); node; node = node.parent) {
    if (!(node.name in MARK_CHILD)) continue;
    const span = foldedSpan(node, doc);
    if (span && span[inner] === at) return node.name === 'InlineCode' ? null : span[outer];
  }
  // `<ins>`/`<mark>` pairs take a whole-document walk to find, so only look
  // when the character on that side can be the end of a tag at all.
  const beside = start ? doc.sliceString(Math.max(0, at - 1), at) : doc.sliceString(at, Math.min(doc.length, at + 1));
  if (beside !== (start ? '>' : '<')) return null;
  const html = htmlPairAt(tree, doc, at);
  return html && html[inner] === at ? html[outer] : null;
}

/**
 * Where a space typed at `pos` belongs: `pos` itself, or — when `pos` is the
 * inner edge of a folded construct — the outside of it.
 *
 * For bold, italic, strikethrough and `==highlight==` this is a matter of
 * the markup surviving: CommonMark's flanking rule says an opening marker
 * followed by whitespace opens nothing, and a closing one preceded by
 * whitespace closes nothing. For a link or an underline nothing breaks, but
 * the space is no more wanted inside — it would be underlined, or part of the
 * link — so every folded construct is treated alike, inline code excepted.
 *
 * At the START of the visible text the answer is always "before the opening
 * marker": a leading space inside the pair is never what was meant. At the
 * END it is "after the closing marker" only while a WORD follows the
 * construct directly (`**JSON**path`) — the space is there to part the two.
 * Anywhere else — end of line, a space, a full stop — a space at the end is
 * the middle of typing "bold more", the commonest way a bold phrase gets
 * written, and it stays inside so the phrase can go on.
 *
 * Nested pairs (`***x***`, `<ins>**x**</ins>`) are stepped out of one after
 * another, for as long as each outer edge is the next construct's inner edge.
 */
export function edgeSpacePos(tree: Tree, doc: Text, pos: number): number {
  const walk = (start: boolean): number => {
    let at = pos;
    // Bounded: real nesting is two or three deep.
    for (let depth = 0; depth < 8; depth++) {
      const next = stepOutOfConstruct(tree, doc, at, start);
      if (next === null || next === at) break;
      at = next;
    }
    return at;
  };

  const before = walk(true);
  if (before !== pos) return before;

  const after = walk(false);
  if (after === pos) return pos;
  const line = doc.lineAt(after);
  // Two code units, so a letter outside the BMP is still read whole.
  const next = doc.sliceString(after, Math.min(line.to, after + 2));
  return /^[\p{L}\p{N}]/u.test(next) ? after : pos;
}

/**
 * A space typed at the folded edge of a format — bold, italic, strikethrough,
 * highlight, underline, a link — goes OUTSIDE the pair. The owner,
 * 01.10.2026: the caret stood between `thing:` and a bold phrase, one press
 * of the space bar — and the line read `thing:** JSON path**`, asterisks and
 * all: the caret had been resting after the hidden `**`, and `** ` opens
 * nothing. "It may not be only bold" — it is every format with hidden markers.
 */
const edgeSpaceGuard = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent('input') || !tr.startState.facet(liveModeFacet)) return tr;
  // Mid-composition the browser owns where the text is; moving it would fight the IME.
  if (tr.isUserEvent('input.type.compose')) return tr;
  const state = tr.startState;
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return tr;

  let change: { at: number; text: string } | null = null;
  let single = true;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (change || fromA !== toA) single = false;
    else change = { at: fromA, text: inserted.toString() };
  });
  const typed = change as { at: number; text: string } | null;
  if (!single || !typed || !/^[ \t\u00a0]+$/.test(typed.text)) return tr;

  const target = edgeSpacePos(syntaxTree(state), state.doc, typed.at);
  if (target === typed.at) return tr;
  return {
    changes: { from: target, insert: typed.text },
    selection: EditorSelection.cursor(target + typed.text.length),
    scrollIntoView: tr.scrollIntoView,
    userEvent: tr.annotation(Transaction.userEvent),
  };
});

/** Wired into `livePreview` at the highest precedence — see live-preview.ts. */
export const linkEditingGuard: Extension = [
  Prec.highest(
    keymap.of([
      { key: 'Enter', run: constructEnterGuard },
      // Order matters: the construct guard may hand a Backspace at `# **x**`
      // over to the heading guard (see its docblock).
      { key: 'Backspace', run: constructDeleteGuard(false) },
      { key: 'Backspace', run: headingBackspaceGuard },
      { key: 'Delete', run: constructDeleteGuard(true) },
    ]),
  ),
  emptyConstructCleanup,
  edgeSpaceGuard,
];
