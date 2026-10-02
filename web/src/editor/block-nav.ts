/**
 * Arrow-key navigation across live-mode block widgets (tables, mermaid,
 * images, `<details>`, HTML blocks, `::pagetree`) and a GFM callout's folded
 * `[!NOTE]` label line.
 *
 * Every block above is a `Decoration.replace({ block: true })` widget (see
 * `blockWidgets` in live-preview.ts). A callout's label line is not a block
 * widget — the callout's body stays ordinary editable text — but the label
 * itself is an inline `Decoration.replace` that fills the WHOLE line save for
 * the hidden `> ` prefix, so for the purposes of vertical motion it behaves
 * the same way: nothing useful lives there to land the caret on.
 *
 * Plain cursor motion (`view.moveVertically`/`moveByChar` — the exact
 * primitives `@codemirror/commands`'s own arrow-key bindings use, see that
 * package's `cursorByLine`/`cursorByChar`) can still land a position strictly
 * inside one of those spans: nothing stops it, because a block decoration is
 * not an atomic RANGE, it is a chunk of vertical space with its own DOM, and
 * `EditorView.atomicRanges` only ever covers the callout label's own two
 * characters' worth of text (live-preview.ts) — the position right at either
 * of its edges is still legal, and still reads, visually, as "on the label".
 *
 * Landing inside a TABLE's block-replaced range is worse than cosmetic:
 * `collectTable` (live-decorations.ts) folds a table only while the selection
 * does not `touches()` its span — so a caret merely passing through on its
 * way somewhere else was enough to blow the fold and reveal the raw
 * `| a | b |` markdown (the owner's screenshot: Right-arrow near a table).
 *
 * The fix: every arrow key is intercepted at the highest precedence. The
 * position CodeMirror's OWN command would produce is computed with the same
 * public primitive it uses (so declining — returning `false` — is exactly as
 * if this extension were not here at all). Only when that position would land
 * inside a block widget or a callout's label line is anything redirected:
 *
 *  - Up/Down into a TABLE opens it for editing instead — the first (header)
 *    cell coming from above, the last row's first cell coming from below,
 *    the same way pressing Enter already walks a cell up or down a row.
 *  - Up/Down into anything else (mermaid, image, `<details>`, HTML,
 *    `::pagetree`) or onto a callout's label line steps CLEAN OVER it,
 *    landing on the nearest real line on the far side.
 *  - Left/Right never enter a table (no cell concept maps onto "one
 *    character over"); every block widget is just a single stop to step
 *    over, same as the "anything else" case above.
 *
 * A document position therefore never rests inside any of them, so the fold
 * is never broken by mere cursor travel — a deliberate click into the
 * callout's body, or the table widget's own "Source" button, is still how
 * raw markdown gets revealed on purpose.
 *
 * `verticalTarget`/`horizontalTarget` below are the pure decision core — kept
 * separate from the `view.moveVertically`/`moveByChar` calls that feed them,
 * table-nav.ts style, so the redirection logic is checkable without a real
 * layout (jsdom has no `getClientRects`, so `moveVertically` itself cannot be
 * driven end-to-end in a DOM test — see block-nav.test.ts).
 */
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { EditorSelection, EditorState, Prec, type Extension, type Line, type Text } from '@codemirror/state';
import { EditorView, keymap, type Command } from '@codemirror/view';
import { HEADER_ROW, parseGfmTable } from './gfm-table';
import { computeBlockSpecs, computeInlineSpecs, type BlockSpec } from './live-decorations';
import { liveModeFacet } from './live-preview';
import { openTableCellAt } from './table-widget';

/** Generous cap on how many back-to-back widgets/label lines one key press
 * will step over — real documents never chain anywhere near this many, it is
 * only there so a pathological shape can't spin the loop forever. */
const MAX_HOPS = 40;

/** Every live-mode block widget. Whole-document: block layout isn't
 * viewport-bound either (see `buildBlockDecorations` in live-preview.ts). */
function blockSpecsOf(view: EditorView): BlockSpec[] {
  const state = view.state;
  return computeBlockSpecs({
    doc: state.doc,
    tree: syntaxTree(state),
    selection: state.selection.ranges,
    ranges: [{ from: 0, to: state.doc.length }],
    live: true,
  });
}

/** Line numbers holding a folded `[!NOTE]`-style callout marker — see the module doc. */
function calloutLabelLines(view: EditorView): Set<number> {
  const state = view.state;
  if (!state.facet(liveModeFacet)) return new Set();
  const specs = computeInlineSpecs({
    doc: state.doc,
    tree: syntaxTree(state),
    selection: state.selection.ranges,
    ranges: [{ from: 0, to: state.doc.length }],
    live: true,
  });
  const lines = new Set<number>();
  for (const spec of specs) if (spec.kind === 'callout') lines.add(state.doc.lineAt(spec.from).number);
  return lines;
}

function blockAt(specs: readonly BlockSpec[], pos: number): BlockSpec | null {
  for (const spec of specs) if (pos >= spec.from && pos <= spec.to) return spec;
  return null;
}

/** Where a table widget starting at `from` should open, entering from `forward`'s direction. */
export interface TableEntry {
  from: number;
  ref: { row: number; col: number };
}

export type VerticalTarget = { pos: number } | { table: TableEntry };

/**
 * The pure redirection decision for a vertical arrow press: `landed` is the
 * position `view.moveVertically` produced (or would produce). `null` means
 * no redirection is needed — the caller should let that position, or
 * CodeMirror's own command, stand exactly as computed.
 */
export function verticalTarget(
  doc: Text,
  blocks: readonly BlockSpec[],
  labelLines: ReadonlySet<number>,
  landed: number,
  forward: boolean,
): VerticalTarget | null {
  let pos = landed;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const block = blockAt(blocks, pos);
    if (block) {
      if (block.kind === 'table') {
        const table = parseGfmTable(block.source);
        const lastRow = table && table.rows.length > 0 ? table.rows.length - 1 : HEADER_ROW;
        return { table: { from: block.from, ref: { row: forward ? HEADER_ROW : lastRow, col: 0 } } };
      }
      pos = forward ? Math.min(doc.length, block.to + 1) : Math.max(0, block.from - 1);
      continue;
    }
    const lineNo = doc.lineAt(pos).number;
    if (labelLines.has(lineNo)) {
      const line = doc.line(lineNo);
      pos = forward ? Math.min(doc.length, line.to + 1) : Math.max(0, line.from - 1);
      continue;
    }
    break;
  }
  return pos === landed ? null : { pos };
}

/** Same idea for Left/Right: table or not, a block is always just stepped over. */
export function horizontalTarget(
  doc: Text,
  blocks: readonly BlockSpec[],
  landed: number,
  forward: boolean,
): number | null {
  let pos = landed;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const block = blockAt(blocks, pos);
    if (!block) break;
    pos = forward ? Math.min(doc.length, block.to + 1) : Math.max(0, block.from - 1);
  }
  return pos === landed ? null : pos;
}

function verticalArrow(forward: boolean): Command {
  return (view) => {
    const { state } = view;
    if (!state.facet(liveModeFacet)) return false;
    const range = state.selection.main;
    if (!range.empty) return false; // selection extension keeps the default behaviour

    const blocks = blockSpecsOf(view);
    const labelLines = calloutLabelLines(view);
    if (blocks.length === 0 && labelLines.size === 0) return false;

    const moved = view.moveVertically(range, forward);
    if (moved.head === range.head) return false; // top/bottom of the document

    const target = verticalTarget(state.doc, blocks, labelLines, moved.head, forward);
    if (!target) return false;

    if ('table' in target) {
      if (openTableCellAt(view, target.table.from, target.table.ref)) return true;
      // Widget DOM not found (view mid-render) — decline rather than getting
      // stuck; the next natural key press tries again.
      return false;
    }

    view.dispatch({
      selection: EditorSelection.cursor(target.pos, undefined, undefined, moved.goalColumn),
      scrollIntoView: true,
    });
    return true;
  };
}

function horizontalArrow(forward: boolean): Command {
  return (view) => {
    const { state } = view;
    if (!state.facet(liveModeFacet)) return false;
    const range = state.selection.main;
    if (!range.empty) return false;

    const blocks = blockSpecsOf(view);
    if (blocks.length === 0) return false;

    const moved = view.moveByChar(range, forward);
    if (moved.head === range.head) return false;

    const pos = horizontalTarget(state.doc, blocks, moved.head, forward);
    if (pos === null) return false;

    view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: true });
    return true;
  };
}

/**
 * Where a caret that landed on a folded table goes instead. `insertLine` means
 * there is no line on that side at all (the table ends the document) and one
 * has to be made.
 *
 * A pointer says which side it was on: CodeMirror resolves a click beside the
 * widget to the table's nearer end, so the upper half means the line above and
 * the lower half the line below. The keyboard (`cameFrom` — where the caret
 * was) says which way it was going, and it has to keep going that way:
 * PageDown that lands in the upper half of a long table would otherwise be
 * sent back up, and never get past it.
 */
export type TableEscape = { pos: number } | { insertLine: number } | null;

export function tableEscape(
  docLength: number,
  table: { from: number; to: number },
  head: number,
  cameFrom?: number,
): TableEscape {
  const above = table.from > 0 ? table.from - 1 : null;
  const below = table.to < docLength ? table.to + 1 : null;
  const down = cameFrom === undefined ? head - table.from > table.to - head : cameFrom < table.from;
  if (down) {
    if (below !== null) return { pos: below };
    // Below the last table of the page is where the author goes to keep
    // writing — and without a line there, there would be no way to.
    return { insertLine: docLength };
  }
  if (above !== null) return { pos: above };
  // Nothing above the first table of the page. A pointer settles for the line
  // below; a caret that was moving up is not turned around.
  return cameFrom === undefined && below !== null ? { pos: below } : null;
}

/**
 * A pointer never leaves the caret on a folded table.
 *
 * A click INSIDE the grid belongs to the widget. A click in the few pixels
 * of margin around it does not: CodeMirror resolves it to the nearest
 * document position, which is the table's own first or last character — and
 * a caret there `touches()` the table, so `collectTable` unfolds it into
 * `| a | b |` source (the owner, 24.09 and again 29.09.2026: "I click somewhere
 * near a table, and it turns into source mode"). The author pointed NEXT TO the
 * table, so next to the table is where the caret goes.
 *
 * Only a table that is folded in the state the click arrives in: once the
 * source has been revealed on purpose (the widget's own «Source» button,
 * `revealSource` — a plain selection, no user event), clicks inside it place
 * the caret like in any other text.
 *
 * The keyboard gets the same treatment where the arrows above do not already
 * decide (PageDown, Cmd-End, a selection the browser reports by itself) — a
 * caret is a caret, and the table unfolds just the same.
 */
const tablePointerGuard = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection || tr.docChanged || !tr.isUserEvent('select')) return tr;
  const state = tr.startState;
  if (!state.facet(liveModeFacet)) return tr;
  const selection = tr.newSelection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return tr;
  const head = selection.main.head;
  // Nearly every caret move is nowhere near a table: ask the tree first, and
  // only work the blocks out for the few that are. The block a table folds
  // into starts up to two lines ABOVE its first row — the `[//]: #
  // (folio-table: …)` metadata line and the blank line under it (see
  // `tableBlockStart`) — and that line is where a click above a table with
  // colours or widths lands, so the two lines below the caret are asked too.
  const tree = syntaxTree(state);
  const line = state.doc.lineAt(head);
  const around = [head];
  for (let number = line.number + 1; number <= Math.min(state.doc.lines, line.number + 2); number++) {
    around.push(state.doc.line(number).from);
  }
  const nearTable = around.some((pos) =>
    ([-1, 1] as const).some((side) => {
      for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
        if (node.name === 'Table') return true;
      }
      return false;
    }),
  );
  if (!nearTable) return tr;
  const table = computeBlockSpecs({
    doc: state.doc,
    tree,
    selection: state.selection.ranges,
    ranges: [{ from: 0, to: state.doc.length }],
    live: true,
  }).find((spec) => spec.kind === 'table' && head >= spec.from && head <= spec.to);
  if (!table) return tr;

  const cameFrom = tr.isUserEvent('select.pointer') ? undefined : state.selection.main.head;
  const escape = tableEscape(state.doc.length, table, head, cameFrom);
  if (!escape) return tr;
  if ('pos' in escape) return [tr, { selection: EditorSelection.cursor(escape.pos), sequential: true }];
  if (state.readOnly) return tr;
  return [
    tr,
    {
      changes: { from: escape.insertLine, insert: '\n' },
      selection: EditorSelection.cursor(escape.insertLine + 1),
      sequential: true,
    },
  ];
});

/**
 * Text typed on the line right under a folded table keeps a blank line between
 * them.
 *
 * The caret rests there on purpose: it is where `tablePointerGuard` sends a
 * click beside the table, and the blank line under the last row is where the
 * author goes to keep writing. But GFM ends a table only at a blank line, and
 * a line without pipes directly after the last row is read as one more ROW —
 * so the first character typed there (an emoji from the OS picker or the `((`
 * list, a letter) joined the table, put the caret inside the block and
 * unfolded the grid into `[//]: # (folio-table: …)` and pipe rows (the owner,
 * 02.10.2026: "I insert an emoji into a table and it breaks at once").
 *
 * The blank line that separates stays, and what was typed goes onto a line of
 * its own below it — the same document the author would have written with a
 * second Enter. Only the author's own input (`input…`): a peer's change comes
 * through Yjs and is written back to the shared text as it is, and a
 * composition is not moved from under the IME (`tableCompositionGuard` below
 * makes the room BEFORE one starts). Source mode is plain text and keeps GFM's
 * rule.
 */
const tableTypingGuard = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent('input') || tr.isUserEvent('input.type.compose')) return tr;
  const state = tr.startState;
  if (!state.facet(liveModeFacet)) return tr;

  // Most typing is on a line with text on it: that is answered by the first
  // test, before anything is parsed.
  const glued: { from: number; tableEnd: number }[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const line = state.doc.lineAt(fromA);
    if (toA > line.to || line.text.trim() !== '') return;
    // The line stays blank for a space, or for Enter: nothing is glued then.
    if (inserted.line(1).text.trim() === '') return;
    const tableEnd = tableEndAbove(state, line);
    if (tableEnd !== null) glued.push({ from: line.from, tableEnd });
  });
  if (glued.length === 0) return tr;

  const folded = foldedTables(state);
  const lines = glued.filter(({ tableEnd }) => folded.some((spec) => spec.to === tableEnd));
  if (lines.length === 0) return tr;
  return [
    tr,
    {
      changes: lines.map(({ from }) => ({ from: tr.changes.mapPos(from, -1), insert: '\n' })),
      sequential: true,
    },
  ];
});

/**
 * The same, for text that arrives through an IME composition — the OS emoji
 * panel, a dead key, a phone keyboard's word under construction. The first
 * character of one is written by the browser into the line the caret is on,
 * and the text cannot be moved afterwards: replacing the DOM node the IME is
 * editing cancels the composition, so the next update starts a new one and the
 * text appears twice ("ab" became "aab" with the guard above applied to
 * compositions too). So the room is made BEFORE the composition starts: on the
 * blank line under a folded table, `compositionstart` adds the line break and
 * moves the caret down, which is the document a second Enter would have written
 * and leaves the composition an ordinary blank line to type on.
 */
const tableCompositionGuard = EditorView.domEventHandlers({
  compositionstart(_event, view) {
    const { state } = view;
    if (state.readOnly || !state.facet(liveModeFacet) || state.selection.ranges.length !== 1) return false;
    const { main } = state.selection;
    if (!main.empty) return false;
    const line = state.doc.lineAt(main.head);
    const tableEnd = tableEndAbove(state, line);
    if (tableEnd === null || !foldedTables(state).some((spec) => spec.to === tableEnd)) return false;
    view.dispatch({
      changes: { from: line.to, insert: '\n' },
      selection: EditorSelection.cursor(line.to + 1),
      userEvent: 'input',
    });
    return false;
  },
});

/** The tables folded into widgets in this state, whole document. */
function foldedTables(state: EditorState): BlockSpec[] {
  return computeBlockSpecs({
    doc: state.doc,
    tree: syntaxTree(state),
    selection: state.selection.ranges,
    ranges: [{ from: 0, to: state.doc.length }],
    live: true,
  }).filter((spec) => spec.kind === 'table');
}

/**
 * Where the table above ends (the end of its last row), when `line` is a blank
 * line directly under a table's last row — the line a typed character would
 * glue to the table on. Null for any other line, and for a table that is not
 * the whole story: whether it is FOLDED is `foldedTables`' to say.
 */
function tableEndAbove(state: EditorState, line: Line): number | null {
  if (line.number === 1 || line.text.trim() !== '') return null;
  const above = state.doc.line(line.number - 1);
  return above.text.trim() !== '' && tableEndsAt(state, above.to) ? above.to : null;
}

/** True when a top-level table's last row ends at `pos` — the end of a line. */
function tableEndsAt(state: EditorState, pos: number): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (node.name === 'Table') return node.parent?.name === 'Document' && state.doc.lineAt(node.to).to === pos;
  }
  return false;
}

/** Wired into `livePreview` at the highest precedence — see live-preview.ts. */
export const blockWidgetNav: Extension = [
  Prec.highest(
    keymap.of([
      { key: 'ArrowDown', run: verticalArrow(true) },
      { key: 'ArrowUp', run: verticalArrow(false) },
      { key: 'ArrowRight', run: horizontalArrow(true) },
      { key: 'ArrowLeft', run: horizontalArrow(false) },
    ]),
  ),
  tablePointerGuard,
  tableTypingGuard,
  tableCompositionGuard,
];
