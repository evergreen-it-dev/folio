/**
 * The editable GFM table grid — the one and only table editor (round 21; the
 * crepe/milkdown dialog the previous round added was cut).
 *
 * The widget holds no state. Every commit re-reads the table from the document,
 * applies a pure transform from gfm-table.ts and writes the whole table back as
 * one text edit — so Yjs, undo and remote peers all see a normal text change.
 *
 * What round 21 added on top of that, all of it inside this one widget:
 *
 * - **Edge affordances.** Hovering anywhere near a border between two columns
 *   or two rows lights up a `+` that inserts there. The *hover* target is a
 *   14px band on each side of the border (the owner's complaint about the old
 *   controls was that they were impossible to hit), but only the little `+`
 *   button itself takes pointer events — the band is click-through, so text
 *   near a cell edge is still text.
 * - **`…` handles** above every column and left of every row, opening a menu
 *   with alignment, insert-before/after and delete. The old per-cell align and
 *   delete buttons are gone; those actions live here now.
 * - **Column drag.** Press a column's handle and drag it across the grid to
 *   move the whole column, cells and alignment with it.
 * - **Multi-line cells.** A cell edits as a small text block; Enter is a line
 *   break inside it, not a jump to the next row. The file still holds one pipe
 *   row per table row because the break is written as `<br>` — see gfm-table.ts.
 *   `/` inside a cell opens a mini-slash for headings and list blocks, which
 *   render semantically inside the grid without turning the table into HTML.
 *
 * Round 28 finishes that last point: a cell's list is drawn as an actual
 * `<ul>`/`<ol>` tree (`renderCell`), Enter continues it and Tab / Shift+Tab
 * change an item's level without taking the focus out of the cell, and what
 * lands in the file is the shape `markdown/tableSyntax.ts` defines — the same
 * one the reading renderer and the Confluence importer speak.
 */
import { syntaxTree } from '@codemirror/language';
import { EditorView, WidgetType } from '@codemirror/view';
import { yUndoManagerKeymap } from 'y-codemirror.next';
import { revealSource } from './editor-services';
import {
  BG_TOKENS,
  BULLET,
  HEADER_ROW,
  TASK_OPEN,
  boxAt,
  canMerge,
  canUnmerge,
  cellBg,
  cellRawToText,
  cellTextToRaw,
  columnWidths,
  deleteColumn,
  deleteRow,
  displayToRawOffset,
  enterSafeRawPos,
  insertColumn,
  insertRow,
  listContinuation,
  mergeRange,
  moveColumn,
  normalizeRange,
  parseCellLine,
  parseGfmTable,
  parseInlineSpans,
  riskyLinkSpan,
  sanitizeCellPaste,
  serializeGfmTable,
  setAlign,
  setCell,
  setColumnWidths,
  setRangeBackground,
  setTableDisplay,
  shiftCellIndent,
  splitCellLines,
  tableLayout,
  toggleCellTask,
  unmergeRange,
  type BgToken,
  type CellRange,
  type ColumnAlign,
  type GfmTable,
  type InlineTokenType,
  type TableDisplay,
  type TableLayout,
} from './gfm-table';
import { bgClass } from '../markdown/tableSyntax';
import { emojiFavouritesFacet } from './emoji-complete';
import { linkOverSelectionEdit, pastedUrl } from './format';
import { attachFieldFormatting, formatForEvent } from './format-toolbar';
import { t } from './i18n';
import { attachEmojiInput, openEmojiPicker } from './emoji-popover';
import { isBgToken } from '../markdown/tableSyntax';
import { createIcon, type IconName } from './icons';
import { tableRangeAt } from './live-decorations';
import { openMenu, type MenuEntry, type MenuHandle } from './popup-menu';
import { horizontalMove, verticalMove, type CellMove, type CellRef } from './table-nav';
import { showToast } from './toast';

type Mutation = (table: GfmTable) => GfmTable;

/** Where the caret goes when a cell opens for editing. */
type FocusMode = 'all' | number;

/** How close to a border the pointer has to get for its `+` to appear. */
const EDGE_REACH = 14;
/** Height of the column-handle strip / width of the row-handle gutter. */
const HANDLE = 16;
/** Pointer travel that turns a press on a column handle into a drag. */
const DRAG_SLOP = 4;

/**
 * `y-codemirror.next` does not export its `undo`/`redo` commands directly —
 * only `yUndoManagerKeymap`, the array that wires them to keys on the
 * document's own view. Pulled out here once so a cell whose own history is
 * spent (see `beginEdit`) can hand off to exactly the same commands the rest
 * of the editor already binds Ctrl+Z/Ctrl+Y to.
 */
const documentUndo = yUndoManagerKeymap.find((binding) => binding.key === 'Mod-z')?.run;
const documentRedo = yUndoManagerKeymap.find((binding) => binding.key === 'Mod-y')?.run;

/**
 * A freshly inserted table asks to be opened for editing. The request is
 * consumed by the widget that mounts at that position, which is the one the
 * slash command just created.
 */
let pendingInsert: { from: number; at: number; focus: CellRef } | null = null;
const INSERT_FOCUS_WINDOW_MS = 2000;

export function requestTableFocus(from: number, focus: CellRef = { row: HEADER_ROW, col: 0 }): void {
  pendingInsert = { from, at: Date.now(), focus };
}

/** Dim label for an empty header cell, so a fresh table never looks collapsed. */
function headerPlaceholder(col: number): string {
  return t('table.headerPlaceholder', { n: col + 1 });
}

/* ------------------------------------------------------- cell selection -- */

/*
 * Round 17 needs a *range* of cells to merge or paint, and it must not cost a
 * new piece of chrome. So: shift-click a second cell to select the rectangle
 * between it and the last cell touched (spreadsheet behaviour), or press a row
 * or column `…` handle, which selects that whole row/column before opening its
 * menu. A plain click anywhere clears it again.
 *
 * The range lives on the widget's own dataset rather than in a module variable
 * because the grid is rebuilt from scratch after every document change: the
 * dataset survives `updateDOM`, so a selection outlives the edit it triggered
 * (paint a colour, paint another) exactly the way the pending cell focus does.
 */

function readRange(wrap: HTMLElement): CellRange | null {
  const raw = wrap.dataset.range;
  if (!raw) return null;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return { top: parts[0], left: parts[1], bottom: parts[2], right: parts[3] };
}

function writeRange(wrap: HTMLElement, range: CellRange | null): void {
  if (range) wrap.dataset.range = `${range.top},${range.left},${range.bottom},${range.right}`;
  else delete wrap.dataset.range;
}

/** The range a command should act on: the selection, or the cell in hand. */
function rangeFor(wrap: HTMLElement, fallback: CellRange): CellRange {
  return readRange(wrap) ?? fallback;
}

const cellRange = (row: number, col: number): CellRange => ({
  top: row,
  bottom: row,
  left: col,
  right: col,
});

function inRange(range: CellRange, row: number, col: number): boolean {
  return row >= range.top && row <= range.bottom && col >= range.left && col <= range.right;
}

function readAnchor(wrap: HTMLElement): { row: number; col: number } | null {
  const row = Number(wrap.dataset.anchorRow);
  const col = Number(wrap.dataset.anchorCol);
  return Number.isFinite(row) && Number.isFinite(col) && wrap.dataset.anchorRow !== undefined
    ? { row, col }
    : null;
}

function writeAnchor(wrap: HTMLElement, at: { row: number; col: number }): void {
  wrap.dataset.anchorRow = String(at.row);
  wrap.dataset.anchorCol = String(at.col);
}

/** Re-mark the selected cells in place — no re-render, so no lost focus. */
function paintSelection(wrap: HTMLElement): void {
  const range = readRange(wrap);
  for (const cell of wrap.querySelectorAll<HTMLTableCellElement>('.cm-md-grid th, .cm-md-grid td')) {
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    const rows = Number(cell.dataset.rowspan ?? 1);
    const cols = Number(cell.dataset.colspan ?? 1);
    // A merged cell counts as selected when any position it covers is.
    let hit = false;
    if (range) {
      for (let r = row; r < row + rows && !hit; r++) {
        for (let c = col; c < col + cols && !hit; c++) hit = inRange(range, r, c);
      }
    }
    if (hit) cell.dataset.selected = 'true';
    else delete cell.dataset.selected;
  }
}

export class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly lang: string,
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    // The grid renders translated button labels, so language is part of identity.
    return other.source === this.source && other.lang === this.lang;
  }

  get estimatedHeight(): number {
    return 120;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-block cm-md-table-widget';
    wrap.contentEditable = 'false';
    render(wrap, view, this.source);
    return wrap;
  }

  /**
   * Reusing the DOM (rather than letting CodeMirror rebuild the widget) is what
   * lets Tab move to the next cell across a commit: the element survives the
   * document change and picks the pending focus back up without a flicker.
   */
  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    render(dom, view, this.source);
    return true;
  }

  destroy(dom: HTMLElement): void {
    // Last moment at which the draft in an open cell still exists: CodeMirror
    // calls this before it detaches the node (`destroyDropped` runs ahead of
    // `sync` in DocView.updateInner). See `rescueCellDraft`.
    rescueCellDraft(dom);
    observers.get(dom)?.disconnect();
    observers.delete(dom);
  }
}

/* --------------------------------------------------------------- writing -- */

interface EditOptions {
  /**
   * Cell to open once the grid has been rebuilt — the same handover Tab uses,
   * see `applyPendingFocus`. Also what keeps the viewport still: a structural
   * edit that leaves focus nowhere is the one that jumps (below).
   */
  focus?: CellRef;
  /**
   * Let CodeMirror move the viewport. Only the cell editor's own commit wants
   * that: it re-opens the next cell, and walking off the end of a long table
   * with Tab is supposed to follow the caret down.
   */
  hold?: boolean;
  /**
   * Where the table starts, when the caller already knows. Only the draft
   * rescue passes it: by the time that runs its `wrap` may be out of the
   * document, and `posAtDOM` has nothing to answer with.
   */
  at?: number;
}

/** Every scroll container between the editor's content and the page. */
function scrollers(view: EditorView): HTMLElement[] {
  const out: HTMLElement[] = [];
  const start: HTMLElement | undefined = view.scrollDOM ?? view.dom;
  for (let node: HTMLElement | null = start ?? null; node; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth) out.push(node);
    if (node === node.ownerDocument.body) break;
  }
  return out;
}

/**
 * Hold the viewport still across a structural edit, and give it back afterwards.
 *
 * Inserting a row replaces the WHOLE table block, which throws away the height
 * CodeMirror had measured for it, and the transaction carries no selection
 * change to anchor the update on. When CodeMirror has no anchor it can trust it
 * falls back to pinning the scroller to `scrollHeight` — see ViewState.update
 * and EditorView.measure in @codemirror/view, `scrollAnchorPos < 0` ⇒
 * `scroll.scrollTop = scroll.scrollHeight`. That is the "the page jumped to the
 * bottom" the owner reported, and nothing about pressing `+` should move the
 * view at all. The scroll offsets are restored after the dispatch, again on the
 * next measure, and once more on the next frame — CodeMirror compensates
 * asynchronously and the last word has to be ours.
 */
function holdViewport(view: EditorView): () => void {
  const saved = scrollers(view).map((dom) => ({ dom, top: dom.scrollTop, left: dom.scrollLeft }));
  const win = view.dom?.ownerDocument?.defaultView ?? null;
  const pageX = win?.scrollX ?? 0;
  const pageY = win?.scrollY ?? 0;

  const restore = () => {
    for (const { dom, top, left } of saved) {
      if (dom.scrollTop !== top) dom.scrollTop = top;
      if (dom.scrollLeft !== left) dom.scrollLeft = left;
    }
    if (win && (win.scrollX !== pageX || win.scrollY !== pageY)) win.scrollTo(pageX, pageY);
  };

  return () => {
    restore();
    view.requestMeasure?.({ read: () => null, write: restore });
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
  };
}

/**
 * Re-resolve the table at commit time — remote peers may have moved it — then
 * write the regenerated markdown. Returns whether a document change was made.
 */
function applyEdit(
  view: EditorView,
  wrap: HTMLElement,
  mutate: Mutation,
  options: EditOptions = {},
): boolean {
  const at = options.at ?? view.posAtDOM(wrap);
  const range = tableRangeAt(view.state.doc, syntaxTree(view.state), at);
  if (!range) {
    showToast(view, t('table.errorMoved'));
    return false;
  }
  const source = view.state.doc.sliceString(range.from, range.to);
  const table = parseGfmTable(source);
  if (!table) {
    showToast(view, t('table.errorParse'));
    return false;
  }
  const next = serializeGfmTable(mutate(table));
  if (next === source) return false;

  if (options.focus) {
    wrap.dataset.focusRow = String(options.focus.row);
    wrap.dataset.focusCol = String(options.focus.col);
  }
  const release = options.hold === false ? null : holdViewport(view);
  try {
    view.dispatch({ changes: { from: range.from, to: range.to, insert: next } });
  } finally {
    release?.();
    // The request belongs to the render this edit causes; a widget CodeMirror
    // chose not to re-render must not pick it up three edits later.
    if (options.focus) {
      delete wrap.dataset.focusRow;
      delete wrap.dataset.focusCol;
    }
  }
  return true;
}

/* ---------------------------------------------------------- draft rescue -- */

/*
 * Round 28 (QA-3). A cell editor is a `<textarea>` living inside the widget's
 * DOM, and until it commits, what the author typed exists ONLY there. That was
 * fine as long as the only way to end an edit was to move focus, because the
 * browser fires `blur` first and the commit runs while CodeMirror is idle.
 *
 * It is not fine when something else tears the widget down while the cell is
 * still open — switching to source mode is the loud case (`modeCompartment`
 * reconfigures the SAME view, so nothing else in the app notices), but so are
 * a language change, a remote edit landing on the table, and every table
 * toolbar button, which suppresses the field's blur on purpose so the grid
 * still knows which cell it is acting on.
 *
 * All of those go through `EditorView.update`, and there the draft is caught
 * between two walls:
 *
 *  - Anything CodeMirror calls us from — `updateDOM`, `destroy` — runs inside
 *    `DocView.updateInner`, where `view.dispatch` is illegal ("Calls to
 *    EditorView.update are not allowed while an update is in progress") and
 *    `view.posAtDOM` reads a half-rebuilt `docView` (that is the
 *    `Cannot read properties of undefined (reading 'dom')` the QA run saw).
 *  - The `blur` the teardown provokes is later still: Blink drops focus in
 *    `WillRemoveChild`, i.e. from inside the very same `updateInner`, and it
 *    does it while the node is still attached — which is why the old
 *    `if (field.isConnected)` guard let it straight through.
 *
 * So the draft is *rescued*, not committed, at the point where it still
 * exists: `render` (about to replace the widget's children) and
 * `TableWidget.destroy` (called by `destroyDropped`, ahead of the `sync` that
 * detaches the node) both hand it to `keep` below, which closes the editor —
 * making the blur that follows a no-op — and parks the value. `rescueExtension`
 * then writes it from an update listener, which CodeMirror runs after
 * `updateState` is back to Idle and the DOM is whole again.
 *
 * The one thing the listener cannot recompute is *where* the table was: by
 * then the widget may be gone from the document. So a session remembers the
 * position `posAtDOM` gave while the view was idle, the listener re-reads it
 * on every update the editor survives, and a rescue maps it through the
 * changes of the update that killed it.
 */

interface CellSession {
  view: EditorView;
  wrap: HTMLElement;
  ref: CellRef;
  /** Cell markdown as the editor opened; an unchanged draft is not worth rescuing. */
  original: string;
  /** The table's document position, or null while we have had no safe chance to read it. */
  anchor: number | null;
  /** The draft as markdown, read straight off the field. */
  read: () => string;
  /** `beginEdit`'s own teardown: settles the editor so the coming blur does nothing. */
  close: () => void;
}

interface RescuedDraft {
  wrap: HTMLElement;
  ref: CellRef;
  value: string;
  anchor: number;
}

/** At most one open cell editor per grid — it is the focused element. */
const openCells = new Map<HTMLElement, CellSession>();
/** At most one rescued draft per view, for the same reason. */
const rescuedDrafts = new WeakMap<EditorView, RescuedDraft>();

/**
 * True while `render` is running. `render` reaches `beginEdit` through
 * `applyPendingFocus` (that is how Tab lands in the next cell), and on the
 * `updateDOM` path that whole chain runs inside CodeMirror's update — so the
 * position such a session starts with is not one `posAtDOM` can be trusted
 * for. It is left null and the update listener fills it in a moment later.
 */
let rendering = false;

function safePosAtDOM(view: EditorView, dom: HTMLElement): number | null {
  if (!dom.isConnected) return null;
  try {
    return view.posAtDOM(dom);
  } catch {
    return null;
  }
}

/** Register an open cell editor so a teardown can save what is in it. */
function trackCell(session: CellSession): void {
  openCells.set(session.wrap, session);
}

function untrackCell(wrap: HTMLElement): void {
  openCells.delete(wrap);
}

/**
 * Close the cell editor open on this grid, if any, and park its draft for
 * `tableCellRescue` to write. Safe to call from inside a CodeMirror update:
 * it touches nothing but the widget's own DOM.
 */
function rescueCellDraft(wrap: HTMLElement): void {
  const session = openCells.get(wrap);
  if (!session) return;
  const value = session.read();
  const { anchor, ref, view } = session;
  session.close(); // also untracks, and settles the editor against the blur
  if (value === session.original || anchor === null) return;
  rescuedDrafts.set(view, { wrap, ref, value, anchor });
}

/**
 * Keeps cell positions current and writes rescued drafts, both once the view
 * is idle again. Part of `livePreview`, so every editor that can show a table
 * grid has it.
 */
export const tableCellRescue = EditorView.updateListener.of((update) => {
  for (const session of openCells.values()) {
    if (session.view !== update.view) continue;
    const at = safePosAtDOM(update.view, session.wrap);
    if (at !== null) session.anchor = at;
  }

  const draft = rescuedDrafts.get(update.view);
  if (!draft) return;
  rescuedDrafts.delete(update.view);
  applyEdit(
    update.view,
    draft.wrap,
    (table) => setCell(table, draft.ref.row, draft.ref.col, draft.value),
    {
      at: update.changes.mapPos(draft.anchor, 1),
      // A grid that is still on screen has usually just opened a cell of its
      // own (a toolbar `+` asks for one). Rewriting the table would close it
      // again and leave the author nowhere, so hand that cell back.
      focus: openCells.get(draft.wrap)?.ref,
    },
  );
});

/* --------------------------------------------------------------- drawing -- */

/** One ResizeObserver per mounted widget, disconnected when CodeMirror drops it. */
const observers = new WeakMap<HTMLElement, ResizeObserver>();

/**
 * A press anywhere on the widget that no control claims — the frame's
 * padding, the gap right of a narrow grid, the bar's empty stretch — must not
 * move the browser's selection: CodeMirror reads that as a caret at the
 * widget's position and unfolds the whole grid back to markdown source (the
 * owner, 24.09.2026: "I clicked somewhere on the table — it went into source").
 * Cells and buttons already prevent their own presses; this catches the
 * rest. Attached once — the element survives re-renders (see `updateDOM`).
 */
function guardWidgetPress(wrap: HTMLElement): void {
  if (wrap.dataset.pressGuard) return;
  wrap.dataset.pressGuard = 'true';
  wrap.addEventListener('mousedown', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target || target.closest('.cm-md-cellinput, button, input, [contenteditable="true"]')) return;
    event.preventDefault();
  });
}

function render(wrap: HTMLElement, view: EditorView, source: string): void {
  guardWidgetPress(wrap);
  // Before `replaceChildren` throws an open cell editor away with the rest of
  // the grid — see the draft-rescue section.
  rescueCellDraft(wrap);
  const table = parseGfmTable(source);
  wrap.replaceChildren();

  if (!table) {
    const fallback = document.createElement('pre');
    fallback.className = 'cm-md-table-fallback';
    fallback.textContent = source;
    wrap.appendChild(fallback);
    return;
  }

  // Grid size is stamped here rather than counted off the DOM: a merged header
  // row has fewer `<th>`s than the table has columns, and cell navigation must
  // still know the real shape.
  wrap.dataset.cols = String(table.header.length);
  wrap.dataset.rows = String(table.rows.length);
  wrap.dataset.display = table.attrs?.display ?? 'narrow';

  const scroll = document.createElement('div');
  scroll.className = 'cm-md-table-scroll';

  const frame = document.createElement('div');
  frame.className = 'cm-md-table-frame';
  frame.appendChild(buildGrid(view, wrap, table));

  const overlay = document.createElement('div');
  overlay.className = 'cm-md-table-overlay';
  frame.appendChild(overlay);

  scroll.appendChild(frame);
  wrap.appendChild(scroll);
  wrap.appendChild(buildBar(view, wrap, table));

  mountControls(view, wrap, frame, overlay, table);
  rendering = true;
  try {
    applyPendingFocus(view, wrap);
  } finally {
    rendering = false;
  }
}

/**
 * One stable toolbar under the grid instead of a floating overlay: it cannot
 * cover a header cell or the column controls, and it does not jump around as
 * the table grows.
 */
function buildBar(view: EditorView, wrap: HTMLElement, table: GfmTable): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'cm-md-table-bar';

  bar.appendChild(
    barButton('plus', t('table.addRow'), t('table.addRowTitle'), () =>
      applyEdit(view, wrap, (table) => insertRow(table, table.rows.length - 1), {
        focus: { row: gridSize(wrap).rows, col: 0 },
      }),
    ),
  );
  bar.appendChild(
    barButton('plus', t('table.addColumn'), t('table.addColumnTitle'), () =>
      applyEdit(view, wrap, (table) => insertColumn(table, table.header.length - 1), {
        focus: { row: HEADER_ROW, col: gridSize(wrap).cols },
      }),
    ),
  );

  const spacer = document.createElement('span');
  spacer.className = 'cm-md-table-bar__spacer';
  bar.appendChild(spacer);

  const widthGroup = document.createElement('span');
  widthGroup.className = 'cm-md-table-widths';
  widthGroup.setAttribute('role', 'group');
  widthGroup.setAttribute('aria-label', t('table.widthGroup'));
  const current = table.attrs?.display ?? 'narrow';
  const widths: Array<{ display: TableDisplay; icon: IconName; label: string }> = [
    { display: 'narrow', icon: 'widthNarrow', label: t('table.widthNarrow') },
    { display: 'medium', icon: 'widthMedium', label: t('table.widthMedium') },
    { display: 'full', icon: 'widthFull', label: t('table.widthFull') },
  ];
  for (const { display, icon, label } of widths) {
    const button = barButton(icon, label, label, () => {
      if (current !== display) applyEdit(view, wrap, (next) => setTableDisplay(next, display));
    });
    button.classList.add('cm-md-table-widthbtn');
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(current === display));
    widthGroup.appendChild(button);
  }
  bar.appendChild(widthGroup);

  bar.appendChild(
    barButton('code', t('table.source'), t('table.sourceTitle'), () => revealSource(view, wrap)),
  );
  return bar;
}

function barButton(
  icon: IconName,
  label: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cm-md-table-barbtn';
  button.title = title;
  button.appendChild(createIcon(icon));
  const text = document.createElement('span');
  text.textContent = label;
  button.appendChild(text);
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

function buildGrid(view: EditorView, wrap: HTMLElement, table: GfmTable): HTMLTableElement {
  const grid = document.createElement('table');
  grid.className = 'cm-md-grid';
  if (table.attrs?.layout === 'columns') grid.classList.add('cm-md-grid--columns');

  const layout = tableLayout(table);
  const widths = columnWidths(table);
  const selection = readRange(wrap);

  // A `<colgroup>` is always emitted, widths or not: it is also what the
  // overlay measures columns off, and a merged header row no longer has one
  // `<th>` per column to measure instead.
  const group = document.createElement('colgroup');
  for (let col = 0; col < table.header.length; col++) {
    const element = document.createElement('col');
    const width = widths.get(col);
    if (width) element.style.width = width;
    group.appendChild(element);
  }
  grid.appendChild(group);
  if (widths.size > 0) grid.dataset.sized = 'true';
  if (
    widths.size === table.header.length &&
    [...widths.values()].every((width) => /^\d{1,4}px$/.test(width))
  ) {
    grid.dataset.pixelSized = 'true';
  }

  const emit = (host: HTMLElement, row: number, cells: readonly string[], tag: 'th' | 'td') => {
    cells.forEach((text, col) => {
      const box = boxAt(layout, row, col);
      if (!box || box.row !== row + 1 || box.col !== col) return; // covered
      const cell = document.createElement(tag);
      if (box.colSpan > 1) cell.colSpan = box.colSpan;
      if (box.rowSpan > 1) cell.rowSpan = box.rowSpan;
      prepareCell(cell, view, wrap, row, col, text, table.align[col], {
        bg: cellBg(table, row, col),
        rowSpan: box.rowSpan,
        colSpan: box.colSpan,
        selected: selection ? inRange(selection, row, col) : false,
      });
      host.appendChild(cell);
    });
  };

  const head = document.createElement('tr');
  emit(head, HEADER_ROW, table.header, 'th');
  const thead = document.createElement('thead');
  thead.appendChild(head);
  grid.appendChild(thead);

  const tbody = document.createElement('tbody');
  table.rows.forEach((cells, row) => {
    const tr = document.createElement('tr');
    emit(tr, row, cells, 'td');
    tbody.appendChild(tr);
  });
  grid.appendChild(tbody);

  return grid;
}

/* ------------------------------------------------------ handles and edges -- */

interface Box {
  start: number;
  size: number;
}

interface Geometry {
  cols: Box[];
  rows: Box[];
  /** Column borders, left to right: `cols.length + 1` of them. */
  colEdges: number[];
  /** Row borders under the header, top to bottom: `rows.length + 1` of them. */
  rowEdges: number[];
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Column boxes from the borders that were actually measured, interpolating the
 * rest. `edges[i]` is the border left of column `i`; `edges[count]` is the
 * table's right-hand side. Null when the outer two are unknown — that is a grid
 * nothing has laid out yet, and a guess would be worse than no geometry.
 */
function boxesFromEdges(edges: (number | null)[], count: number): Box[] | null {
  if (count === 0 || edges[0] === null || edges[count] === null) return null;
  for (let index = 1; index < count; index++) {
    if (edges[index] !== null) continue;
    // A column merged away in every single row has no border of its own; split
    // the span it lives inside evenly rather than collapsing it onto nothing.
    let next = index + 1;
    while (next < count && edges[next] === null) next++;
    const from = edges[index - 1] as number;
    const to = edges[next] as number;
    for (let at = index; at < next; at++) {
      edges[at] = from + ((to - from) * (at - index + 1)) / (next - index + 1);
    }
    index = next - 1;
  }
  const boxes: Box[] = [];
  for (let col = 0; col < count; col++) {
    const start = edges[col] as number;
    boxes.push({ start, size: (edges[col + 1] as number) - start });
  }
  return boxes;
}

/**
 * Where each column starts and how wide it is.
 *
 * Round 17 moved this onto the `<colgroup>`, because a merged header row has
 * fewer `<th>`s than the table has columns. That was the regression behind "the
 * column `+` does nothing": a `<col>` generates no box of its own, so several
 * engines measure it as zero — and the `<th>` fallback beside it deliberately
 * gave up the moment the header carried a merge, which is precisely when the
 * colgroup was reached for. Every column border then collapsed onto x=0, the
 * `+` buttons piled up on each other off to the left of the table, and the one
 * that happened to be on top inserted at the wrong index (or was unreachable,
 * because the hover test only ever lit up the border nearest x=0).
 *
 * So measure the CELLS — every row of them, not just the header. A cell says
 * which column it starts at and how far it reaches (`data-col`/`data-colspan`),
 * so one unmerged cell anywhere in the table pins that column exactly, and the
 * merged ones still pin the borders they do cover. The `<colgroup>` stays on as
 * the last resort for a grid with nothing measurable on screen (and for jsdom,
 * where everything is zero anyway).
 */
function columnBoxes(frame: HTMLElement, left: number, count: number): Box[] {
  const edges = new Array<number | null>(count + 1).fill(null);

  for (const cell of frame.querySelectorAll<HTMLTableCellElement>('.cm-md-grid th, .cm-md-grid td')) {
    const col = Number(cell.dataset.col);
    const span = Math.max(1, Number(cell.dataset.colspan) || 1);
    if (!Number.isFinite(col) || col < 0 || col > count) continue;
    const rect = cell.getBoundingClientRect();
    if (rect.width <= 0) continue;
    if (edges[col] === null) edges[col] = rect.left - left;
    const right = Math.min(col + span, count);
    if (edges[right] === null) edges[right] = rect.right - left;
  }

  return (
    boxesFromEdges(edges, count) ??
    [...frame.querySelectorAll<HTMLTableColElement>('colgroup col')].map((col) => {
      const rect = col.getBoundingClientRect();
      return { start: rect.left - left, size: rect.width };
    })
  );
}

function measure(frame: HTMLElement): Geometry | null {
  const grid = frame.querySelector<HTMLTableElement>('.cm-md-grid');
  if (!grid) return null;
  const base = frame.getBoundingClientRect();
  const box = grid.getBoundingClientRect();

  // The `<colgroup>` is the one place that always has exactly one entry per
  // column, merges or not — it counts them even when it cannot measure them.
  const cols = columnBoxes(frame, base.left, frame.querySelectorAll('colgroup col').length);
  const rows = [...frame.querySelectorAll<HTMLTableRowElement>('tbody tr')].map((tr) => {
    const rect = tr.getBoundingClientRect();
    return { start: rect.top - base.top, size: rect.height };
  });
  if (cols.length === 0) return null;

  const head = frame.querySelector<HTMLTableSectionElement>('thead');
  const headRect = head?.getBoundingClientRect();
  const bodyTop = rows.length > 0 ? rows[0].start : (headRect?.bottom ?? box.bottom) - base.top;

  return {
    cols,
    rows,
    colEdges: [cols[0].start, ...cols.map((col) => col.start + col.size)],
    rowEdges: [bodyTop, ...rows.map((row) => row.start + row.size)],
    top: box.top - base.top,
    bottom: box.bottom - base.top,
    left: box.left - base.left,
    right: box.right - base.left,
  };
}

/**
 * Build the hover/handle overlay and wire the pointer tracking that decides
 * which affordance is live. Re-run from scratch on every render and on every
 * resize — it is pure geometry over the grid that is already on screen.
 */
function mountControls(
  view: EditorView,
  wrap: HTMLElement,
  frame: HTMLElement,
  overlay: HTMLElement,
  table: GfmTable,
): void {
  let geometry: Geometry | null = null;
  let colZones: HTMLElement[] = [];
  let rowZones: HTMLElement[] = [];
  let dropline: HTMLElement | null = null;
  /** Where the pointer last was over the frame, in client coordinates. */
  let pointer: { x: number; y: number } | null = null;

  const clearActive = () => {
    for (const zone of [...colZones, ...rowZones]) delete zone.dataset.active;
  };

  const layout = () => {
    geometry = measure(frame);
    overlay.replaceChildren();
    colZones = [];
    rowZones = [];
    dropline = null;
    if (!geometry) return;
    const geo = geometry;

    const strip = geo.top - HANDLE + 2;

    geo.cols.forEach((col, index) => {
      const handle = document.createElement('div');
      handle.className = 'cm-md-handle cm-md-handle--col';
      handle.style.left = `${col.start}px`;
      handle.style.width = `${col.size}px`;
      handle.style.top = `${strip}px`;
      handle.appendChild(
        handleButton(t('table.columnMenu', { n: index + 1 }), (event) =>
          startColumnPress(event, index),
        ),
      );
      overlay.appendChild(handle);
    });

    geo.rows.forEach((row, index) => {
      const handle = document.createElement('div');
      handle.className = 'cm-md-handle cm-md-handle--row';
      handle.style.top = `${row.start}px`;
      // A row every cell of which is swallowed by a rowspan from above has no
      // box of its own; keep its handle reachable so it can still be deleted.
      handle.style.height = `${Math.max(row.size, HANDLE)}px`;
      handle.style.left = `${geo.left - HANDLE - 1}px`;
      handle.appendChild(
        handleButton(t('table.rowMenu', { n: index + 1 }), (event) => {
          // Pressing a handle selects that row — unless a range that already
          // includes it is up, which is the shift-click flow and must survive.
          if (!covers(index)) selectRow(index);
          openRowMenu(event, index);
        }),
      );
      overlay.appendChild(handle);
    });

    geo.colEdges.forEach((x, index) => {
      const zone = edgeZone('col', t('table.insertColumnHere'), () => addColumn(index - 1));
      zone.style.left = `${x - EDGE_REACH}px`;
      zone.style.width = `${EDGE_REACH * 2}px`;
      zone.style.top = `${strip}px`;
      zone.style.height = `${geo.bottom - strip}px`;
      // Inner borders resize a pair of columns. Narrow and full-width tables
      // also expose the same outer right handle: narrow is capped at the prose
      // column, while full width may grow past its viewport and scroll.
      const display = table.attrs?.display ?? 'narrow';
      const outer =
        index === geo.cols.length && (display === 'narrow' || display === 'full')
          ? 'right'
          : null;
      if (outer || (index > 0 && index < geo.cols.length)) {
        const line = zone.querySelector<HTMLElement>('.cm-md-edge__line');
        if (line) {
          line.dataset.resize = 'true';
          line.title = outer ? t('table.tableWidth') : t('table.columnWidth', { n: index });
          line.addEventListener('mousedown', (event) => startResize(event, index - 1, outer));
        }
      }
      colZones.push(zone);
      overlay.appendChild(zone);
    });

    geo.rowEdges.forEach((y, index) => {
      const zone = edgeZone('row', t('table.insertRowHere'), () => addRow(index - 1));
      zone.style.top = `${y - EDGE_REACH}px`;
      zone.style.height = `${EDGE_REACH * 2}px`;
      zone.style.left = `${geo.left - HANDLE - 1}px`;
      zone.style.width = `${geo.right - geo.left + HANDLE + 1}px`;
      rowZones.push(zone);
      overlay.appendChild(zone);
    });

    dropline = document.createElement('div');
    dropline.className = 'cm-md-dropline';
    dropline.style.top = `${strip}px`;
    dropline.style.height = `${geo.bottom - strip}px`;
    overlay.appendChild(dropline);

    // The zones were just rebuilt under a pointer that did not move: light the
    // border it is resting on again, at its new place.
    if (pointer) activate(pointer.x, pointer.y);
  };

  /** Nearest border to the pointer wins, columns first on a tie. */
  const activate = (clientX: number, clientY: number) => {
    if (!geometry) return;
    const base = frame.getBoundingClientRect();
    const x = clientX - base.left;
    const y = clientY - base.top;
    clearActive();

    // A border is only a candidate while the pointer is beside the grid on the
    // other axis — otherwise every stray move over the page would light one up.
    const besideRows = x >= geometry.left - HANDLE - 2 && x <= geometry.right + EDGE_REACH;
    const besideCols = y >= geometry.top - HANDLE && y <= geometry.bottom + EDGE_REACH;

    const nearest = (edges: number[], at: number) => {
      let best = -1;
      let distance = EDGE_REACH + 1;
      edges.forEach((edge, index) => {
        const gap = Math.abs(edge - at);
        if (gap < distance) {
          distance = gap;
          best = index;
        }
      });
      return { index: best, distance };
    };

    const col = besideCols ? nearest(geometry.colEdges, x) : { index: -1, distance: Infinity };
    const row = besideRows ? nearest(geometry.rowEdges, y) : { index: -1, distance: Infinity };

    if (col.index >= 0 && col.distance <= row.distance) {
      colZones[col.index]?.setAttribute('data-active', 'true');
    } else if (row.index >= 0) {
      rowZones[row.index]?.setAttribute('data-active', 'true');
    }
  };

  const onMove = (event: MouseEvent) => {
    pointer = { x: event.clientX, y: event.clientY };
    activate(event.clientX, event.clientY);
  };

  const onLeave = () => {
    pointer = null;
    clearActive();
  };

  /* ---------------------------------------------------- structural edits -- */

  /*
   * Both inserts name the cell the caret should land in afterwards. That is not
   * only a courtesy — an edit that leaves focus nowhere is exactly the one whose
   * viewport jumps (see `holdViewport`), and Tab-into-a-new-row has always
   * behaved this way. Both indices are the ones `insertRow`/`insertColumn`
   * clamp to, so the target is the new row/column even at the table's edges.
   */

  const addRow = (afterRow: number): boolean =>
    applyEdit(view, wrap, (current) => insertRow(current, afterRow), {
      focus: { row: Math.min(Math.max(afterRow + 1, 0), table.rows.length), col: 0 },
    });

  const addColumn = (afterCol: number): boolean =>
    applyEdit(view, wrap, (current) => insertColumn(current, afterCol), {
      focus: {
        row: HEADER_ROW,
        col: Math.min(Math.max(afterCol + 1, 0), table.header.length),
      },
    });

  /* -------------------------------------------------------- selection -- */

  /** True when the current selection already includes this row / column. */
  const covers = (row?: number, col?: number): boolean => {
    const range = readRange(wrap);
    if (!range) return false;
    if (row !== undefined) return row >= range.top && row <= range.bottom;
    return col !== undefined && col >= range.left && col <= range.right;
  };

  const selectColumn = (col: number) => {
    writeRange(wrap, { top: HEADER_ROW, bottom: table.rows.length - 1, left: col, right: col });
    writeAnchor(wrap, { row: HEADER_ROW, col });
    paintSelection(wrap);
  };

  const selectRow = (row: number) => {
    writeRange(wrap, { top: row, bottom: row, left: 0, right: table.header.length - 1 });
    writeAnchor(wrap, { row, col: 0 });
    paintSelection(wrap);
  };

  /* ------------------------------------------------------------- menus -- */

  const alignItem = (label: string, align: ColumnAlign, col: number): MenuEntry => ({
    label,
    selected: table.align[col] === align,
    onSelect: () => applyEdit(view, wrap, (current) => setAlign(current, col, align)),
  });

  /**
   * Merge / unmerge, offered only when they would do something. Both act on
   * the selection — which, after pressing a handle, is that whole row or
   * column, so "merge this row into one banner cell" is two clicks.
   */
  const mergeItems = (fallback: CellRange): MenuEntry[] => {
    const range = rangeFor(wrap, fallback);
    const items: MenuEntry[] = [];
    if (canMerge(table, range)) {
      items.push({
        label: t('table.merge'),
        icon: 'merge',
        onSelect: () => {
          applyEdit(view, wrap, (current) => mergeRange(current, range));
        },
      });
    }
    if (canUnmerge(table, range)) {
      items.push({
        label: t('table.unmerge'),
        icon: 'split',
        onSelect: () => {
          applyEdit(view, wrap, (current) => unmergeRange(current, range));
        },
      });
    }
    return items.length > 0 ? [...items, 'separator'] : items;
  };

  /** The fixed background palette as one swatch strip. */
  const backgroundRow = (fallback: CellRange): MenuEntry => {
    const range = rangeFor(wrap, fallback);
    const current = cellBg(table, range.top, range.left);
    return {
      kind: 'swatches',
      label: t('table.background'),
      items: [
        ...BG_TOKENS.map((token) => ({
          label: t(`table.bg.${token}`),
          className: `cm-md-swatch ${bgClass(token)}`,
          selected: current === token,
          onSelect: () =>
            applyEdit(view, wrap, (currentTable) => setRangeBackground(currentTable, range, token)),
        })),
        {
          label: t('table.bg.none'),
          className: 'cm-md-swatch cm-md-swatch--none',
          selected: current === null,
          onSelect: () =>
            applyEdit(view, wrap, (currentTable) => setRangeBackground(currentTable, range, null)),
        },
      ],
    };
  };

  const widthItems = (): MenuEntry[] =>
    columnWidths(table).size === 0
      ? []
      : [
          {
            label: t('table.resetWidth'),
            onSelect: () => applyEdit(view, wrap, (current) => setColumnWidths(current, null)),
          },
        ];

  const openColumnMenu = (event: MouseEvent, col: number) => {
    openMenu({
      x: event.clientX,
      y: event.clientY + 6,
      ariaLabel: t('table.columnMenu', { n: col + 1 }),
      items: [
        alignItem(t('table.alignLeft'), 'left', col),
        alignItem(t('table.alignCenter'), 'center', col),
        alignItem(t('table.alignRight'), 'right', col),
        alignItem(t('table.alignNone'), null, col),
        'separator',
        ...mergeItems({ top: HEADER_ROW, bottom: table.rows.length - 1, left: col, right: col }),
        backgroundRow({ top: HEADER_ROW, bottom: table.rows.length - 1, left: col, right: col }),
        'separator',
        {
          label: t('table.insertColumnBefore'),
          icon: 'plus',
          onSelect: () => addColumn(col - 1),
        },
        {
          label: t('table.insertColumnAfter'),
          icon: 'plus',
          onSelect: () => addColumn(col),
        },
        ...widthItems(),
        'separator',
        {
          label: t('table.deleteColumn'),
          icon: 'close',
          danger: true,
          onSelect: () => applyEdit(view, wrap, (current) => deleteColumn(current, col)),
        },
      ],
    });
  };

  const openRowMenu = (event: MouseEvent, row: number) => {
    const whole: CellRange = { top: row, bottom: row, left: 0, right: table.header.length - 1 };
    openMenu({
      x: event.clientX,
      y: event.clientY + 6,
      ariaLabel: t('table.rowMenu', { n: row + 1 }),
      items: [
        ...mergeItems(whole),
        backgroundRow(whole),
        'separator',
        {
          label: t('table.insertRowAbove'),
          icon: 'plus',
          onSelect: () => addRow(row - 1),
        },
        {
          label: t('table.insertRowBelow'),
          icon: 'plus',
          onSelect: () => addRow(row),
        },
        'separator',
        {
          label: t('table.deleteRow'),
          icon: 'close',
          danger: true,
          onSelect: () => applyEdit(view, wrap, (current) => deleteRow(current, row)),
        },
      ],
    });
  };

  /* ------------------------------------------------------- context menu -- */

  const removeRow = (row: number): MenuEntry => ({
    label: t('table.deleteRow'),
    icon: 'close',
    danger: true,
    onSelect: () => applyEdit(view, wrap, (current) => deleteRow(current, row)),
  });

  const removeColumn = (col: number): MenuEntry => ({
    label: t('table.deleteColumn'),
    icon: 'close',
    danger: true,
    onSelect: () => applyEdit(view, wrap, (current) => deleteColumn(current, col)),
  });

  /**
   * The right-click menu on a cell: everything the two handle menus carry,
   * delivered at the pointer. Aiming at an 11px `…` handle to reach any of it
   * was the owner's complaint, and a right-click has nothing else to do inside
   * a grid that is not editable text.
   *
   * What it acts on is the SELECTION when the click landed inside one — so
   * shift-click a rectangle, right-click it, merge or paint it — and the cell
   * under the pointer otherwise, which then becomes the selection so the menu
   * and the highlight can never disagree about what is about to change.
   */
  /**
   * The "Emoji…" entry (owner, 24.09.2026: "add inserting an emoji through the
   * right click too"): the same grid picker the `((` trigger and the toolbar use,
   * anchored at the pointer. The menu has already committed and closed the
   * cell by the time a glyph is picked, so the cell is reopened and the
   * emoji typed into it at the caret the author had (or at the end when the
   * cell was not open) — and it stays open for whatever comes next.
   */
  const insertEmojiAt = (row: number, col: number, caret: number | null, emoji: string) => {
    const cell = wrap.querySelector<HTMLTableCellElement>(`[data-row="${row}"][data-col="${col}"]`);
    if (!cell) return;
    beginEdit(view, wrap, cell, caret ?? 0);
    const field = cell.querySelector<HTMLTextAreaElement>('.cm-md-cellinput');
    if (!field) return;
    const at = Math.min(caret ?? field.value.length, field.value.length);
    field.setRangeText(emoji, at, at, 'end');
    field.dispatchEvent(new InputEvent('input', { bubbles: true, data: emoji }));
    field.focus();
  };

  const openCellMenu = (event: MouseEvent, row: number, col: number) => {
    const here = cellRange(row, col);
    const selection = readRange(wrap);
    // Where the author's caret was, if the menu was opened from inside this
    // very cell's editor — `insertEmojiAt` puts the glyph back there.
    const openField = wrap.querySelector<HTMLTextAreaElement>('.cm-md-cellinput');
    const openCell = openField?.closest<HTMLTableCellElement>('th, td');
    const caret =
      openField && openCell && Number(openCell.dataset.row) === row && Number(openCell.dataset.col) === col
        ? openField.selectionStart
        : null;
    if (!selection || !inRange(selection, row, col)) {
      // `preventDefault` on the press means an open editor never loses focus by
      // itself; commit it before the menu acts on a different cell.
      wrap.querySelector<HTMLTextAreaElement>('.cm-md-cellinput')?.blur();
      writeRange(wrap, here);
      writeAnchor(wrap, { row, col });
      paintSelection(wrap);
    }

    // `mergeItems`/`backgroundRow` resolve the selection themselves; the insert
    // and delete entries need its edges, which is what a right-click on a
    // three-row selection means by "insert a row below".
    const range = rangeFor(wrap, here);

    openMenu({
      x: event.clientX,
      y: event.clientY + 4,
      ariaLabel: t('table.cellMenu'),
      items: [
        ...mergeItems(here),
        backgroundRow(here),
        'separator',
        // Nothing goes above the header — that is where the column handles are.
        ...(range.top > HEADER_ROW
          ? [
              {
                label: t('table.insertRowAbove'),
                icon: 'plus' as IconName,
                onSelect: () => addRow(range.top - 1),
              },
            ]
          : []),
        {
          label: t('table.insertRowBelow'),
          icon: 'plus',
          onSelect: () => addRow(range.bottom),
        },
        {
          label: t('table.insertColumnBefore'),
          icon: 'plus',
          onSelect: () => addColumn(range.left - 1),
        },
        {
          label: t('table.insertColumnAfter'),
          icon: 'plus',
          onSelect: () => addColumn(range.right),
        },
        'separator',
        alignItem(t('table.alignLeft'), 'left', col),
        alignItem(t('table.alignCenter'), 'center', col),
        alignItem(t('table.alignRight'), 'right', col),
        alignItem(t('table.alignNone'), null, col),
        'separator',
        {
          label: t('table.emoji'),
          icon: 'smile',
          onSelect: () =>
            openEmojiPicker({
              x: event.clientX,
              y: event.clientY,
              favourites: view.state.facet(emojiFavouritesFacet),
              onPick: (emoji) => insertEmojiAt(row, col, caret, emoji),
              onClose: () => undefined,
            }),
        },
        'separator',
        // Both are left out where they could only be a no-op: the header is not
        // a row that can go, and the last column cannot either.
        ...(row > HEADER_ROW ? [removeRow(row)] : []),
        ...(table.header.length > 1 ? [removeColumn(col)] : []),
      ],
    });
  };

  const onContextMenu = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    // The open cell editor gets the same menu (the owner, 24.09.2026: "a right
    // click on a table — an analog of the column menu"): a cell opens on its very first click,
    // so "right-click the cell I am in" was the common case — and it used to
    // get the browser's own menu instead. `openCellMenu` commits the draft
    // before the menu acts on the cell.
    if (!target) return;
    const cell = target.closest<HTMLTableCellElement>('.cm-md-grid th, .cm-md-grid td');
    if (!cell || !frame.contains(cell)) return;
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    if (!Number.isFinite(row) || !Number.isFinite(col)) return;
    event.preventDefault();
    event.stopPropagation();
    openCellMenu(event, row, col);
  };

  /* -------------------------------------------------------- column drag -- */

  /** Which column the pointer is over, clamped to the grid. */
  const columnAt = (clientX: number): number => {
    if (!geometry) return 0;
    const x = clientX - frame.getBoundingClientRect().left;
    for (let index = 0; index < geometry.cols.length; index++) {
      const col = geometry.cols[index];
      if (x < col.start + col.size) return index;
    }
    return geometry.cols.length - 1;
  };

  const startColumnPress = (event: MouseEvent, col: number) => {
    if (!geometry) return;
    const startX = event.clientX;
    let dragging = false;
    let target = col;

    const markDragged = (on: boolean) => {
      frame
        .querySelectorAll<HTMLElement>(`[data-col="${col}"]`)
        .forEach((cell) => (on ? cell.setAttribute('data-dragging', 'true') : cell.removeAttribute('data-dragging')));
    };

    const move = (moveEvent: MouseEvent) => {
      if (!dragging && Math.abs(moveEvent.clientX - startX) < DRAG_SLOP) return;
      if (!dragging) {
        dragging = true;
        frame.dataset.dragging = 'true';
        markDragged(true);
      }
      target = columnAt(moveEvent.clientX);
      if (dropline && geometry) {
        const edge = geometry.colEdges[target <= col ? target : target + 1];
        dropline.style.left = `${edge - 1}px`;
        dropline.dataset.active = 'true';
      }
    };

    const up = () => {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      delete frame.dataset.dragging;
      markDragged(false);
      if (dropline) delete dropline.dataset.active;
      if (dragging) {
        if (target !== col) applyEdit(view, wrap, (current) => moveColumn(current, col, target));
      } else {
        if (!covers(undefined, col)) selectColumn(col);
        openColumnMenu(event, col);
      }
    };

    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
  };

  /* ------------------------------------------------------ column width -- */

  /**
   * An inner border redistributes a fixed-width pair. An outer border scales
   * the whole table, preserving the proportions the author already chose, and
   * writes every column in pixels so reading mode can reproduce a table that
   * is either narrower than the prose column or wider than the viewport.
   *
   * Only the preview is live; one edit lands on mouse-up.
   */
  const startResize = (
    event: MouseEvent,
    leftCol: number,
    outer: 'right' | null = null,
  ) => {
    if (!geometry) return;
    const sizes = geometry.cols.map((col) => col.size);
    const total = sizes.reduce((sum, size) => sum + size, 0);
    if (
      total <= 0 ||
      leftCol < 0 ||
      leftCol >= sizes.length ||
      (!outer && leftCol + 1 >= sizes.length)
    ) return;

    event.preventDefault();
    event.stopPropagation();

    const columns = [...frame.querySelectorAll<HTMLElement>('colgroup col')];
    const grid = frame.querySelector<HTMLElement>('.cm-md-grid');
    const startX = event.clientX;
    const pair = outer ? 0 : sizes[leftCol] + sizes[leftCol + 1];
    const MIN = 40;
    const display = table.attrs?.display ?? 'narrow';
    const outerMax =
      outer && display === 'narrow'
        ? Math.max(MIN * sizes.length, frame.getBoundingClientRect().width - geometry.left - 2)
        : Number.POSITIVE_INFINITY;
    let next = sizes.slice();
    let moved = false;

    const move = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      if (!moved && Math.abs(delta) < 2) return;
      moved = true;
      frame.dataset.resizing = 'true';
      if (outer) {
        const requested = total + delta;
        const nextTotal = Math.min(outerMax, Math.max(MIN * sizes.length, requested));
        const scale = nextTotal / total;
        next = sizes.map((size) => size * scale);
        if (grid) {
          grid.dataset.sized = 'true';
          grid.dataset.pixelSized = 'true';
          grid.style.width = `${Math.round(nextTotal)}px`;
        }
        columns.forEach((col, index) => {
          col.style.width = `${Math.round(next[index])}px`;
        });
        return;
      }
      const left = Math.min(Math.max(sizes[leftCol] + delta, MIN), Math.max(MIN, pair - MIN));
      next = sizes.slice();
      next[leftCol] = left;
      next[leftCol + 1] = pair - left;
      if (grid) grid.dataset.sized = 'true';
      columns.forEach((col, index) => {
        col.style.width = `${((next[index] / total) * 100).toFixed(2)}%`;
      });
    };

    const up = () => {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      delete frame.dataset.resizing;
      if (!moved) return;
      const widths = new Map<number, string>();
      next.forEach((size, index) => {
        widths.set(
          index,
          outer
            ? `${Math.min(9999, Math.max(1, Math.round(size)))}px`
            : `${Math.min(100, Math.max(1, Math.round((size / total) * 100)))}%`,
        );
      });
      applyEdit(view, wrap, (current) => setColumnWidths(current, widths));
    };

    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
  };

  frame.addEventListener('mousemove', onMove);
  frame.addEventListener('mouseleave', onLeave);
  frame.addEventListener('contextmenu', onContextMenu);

  layout();
  // `toDOM` runs before the element is in the document, so the first real
  // measurement has to wait for a frame; the observer keeps it honest after
  // that (a wrapping cell, a font load, the window resizing).
  requestAnimationFrame(() => {
    if (frame.isConnected) layout();
  });
  if (typeof ResizeObserver !== 'undefined') {
    observers.get(wrap)?.disconnect();
    const observer = new ResizeObserver(() => layout());
    observer.observe(frame);
    // The frame alone is not enough: borders move inside a frame that keeps
    // its size. The owner, 29.09.2026: going from one open cell to another
    // made one row shorter and another taller by the same amount, the frame
    // never resized, and the handles and the insert line stayed on the old
    // borders. Typing does the same to columns — they trade width inside a
    // grid that is always 100% wide. So every row and every cell is watched;
    // one callback covers however many of them changed.
    for (const part of frame.querySelectorAll('.cm-md-grid tr, .cm-md-grid th, .cm-md-grid td')) {
      observer.observe(part);
    }
    observers.set(wrap, observer);
  }
}

function handleButton(label: string, onPress: (event: MouseEvent) => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cm-md-handle__btn';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.appendChild(createIcon('more'));
  button.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onPress(event);
  });
  return button;
}

/**
 * A wide hover band around one border. The band itself never takes pointer
 * events — only the `+` does — so clicking text next to a cell edge still puts
 * the caret in that cell.
 */
function edgeZone(kind: 'col' | 'row', label: string, onInsert: () => void): HTMLElement {
  const zone = document.createElement('div');
  zone.className = `cm-md-edge cm-md-edge--${kind}`;

  const line = document.createElement('span');
  line.className = 'cm-md-edge__line';
  zone.appendChild(line);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cm-md-edge__btn';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.appendChild(createIcon('plus'));
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onInsert();
  });
  zone.appendChild(button);
  return zone;
}

/* ------------------------------------------------------------ cell chrome -- */

interface CellChrome {
  bg: BgToken | null;
  rowSpan: number;
  colSpan: number;
  selected: boolean;
}

function prepareCell(
  cell: HTMLTableCellElement,
  view: EditorView,
  wrap: HTMLElement,
  row: number,
  col: number,
  raw: string,
  align: ColumnAlign,
  chrome: CellChrome = { bg: null, rowSpan: 1, colSpan: 1, selected: false },
): void {
  cell.dataset.row = String(row);
  cell.dataset.col = String(col);
  cell.dataset.raw = raw;
  cell.dataset.rowspan = String(chrome.rowSpan);
  cell.dataset.colspan = String(chrome.colSpan);
  if (align) cell.style.textAlign = align;
  // The same class vocabulary the reading view uses, so one palette is defined
  // in two stylesheets rather than two palettes drifting apart.
  if (chrome.bg) cell.classList.add(bgClass(chrome.bg));
  if (chrome.selected) cell.dataset.selected = 'true';

  const content = document.createElement('div');
  content.className = 'cm-md-cell';
  renderCell(content, raw, row, col, (line) =>
    applyEdit(view, wrap, (table) => setCell(table, row, col, toggleCellTask(raw, line))),
  );
  cell.appendChild(content);

  cell.addEventListener('mousedown', (event) => {
    const target = event.target as HTMLElement;
    // The open rich editor owns its native caret and selection. Preventing a
    // nested press here would pin the caret to the point where the cell first
    // opened.
    if (target.closest('.cm-md-cellinput')) return;
    if (target.closest('button') || target.closest('input')) return;
    // Still prevented for the secondary button: without it the browser drops a
    // caret into the widget's position and CodeMirror unfolds the whole grid
    // back to markdown source, out from under the menu that is about to open.
    event.preventDefault();
    // Everything past here is the primary button's. A right-click belongs to
    // the context menu (`onContextMenu` in mountControls) and must neither open
    // the cell for editing nor throw away the selection the menu will act on.
    if (event.button !== 0) return;
    // Shift extends a selection instead of opening the cell — the only way to
    // say "these cells" without inventing a new control for it.
    if (event.shiftKey) {
      // `preventDefault` above means the open cell editor would never lose
      // focus by itself; commit it before the selection replaces it.
      wrap.querySelector<HTMLTextAreaElement>('.cm-md-cellinput')?.blur();
      const anchor = readAnchor(wrap) ?? { row, col };
      writeRange(wrap, normalizeRange(anchor, { row, col }));
      paintSelection(wrap);
      return;
    }
    writeAnchor(wrap, { row, col });
    if (readRange(wrap)) {
      writeRange(wrap, null);
      paintSelection(wrap);
    }
    // Caret where the pointer landed, so clicking into a word behaves like text.
    const focus = caretFromPoint(content, raw, event);
    // A click on another cell while one is open: `beginEdit` focuses the new
    // field, which blurs and commits the old one — and a real commit rebuilds
    // the grid, taking the new field with it, so the clicked cell never opened
    // after an edit (the owner, 24.09.2026: "I wrote into a cell and clicked
    // the neighboring one with the mouse"). Leaving it as the pending focus makes the rebuild reopen it
    // at the same caret; `commit` reads the same marks when nothing was typed.
    const open = wrap.querySelector<HTMLElement>('.cm-md-cellinput');
    if (open && !cell.contains(open)) {
      wrap.dataset.focusRow = String(row);
      wrap.dataset.focusCol = String(col);
      wrap.dataset.focusMode = String(focus);
    }
    beginEdit(view, wrap, cell, focus);
  });

  cell.addEventListener('dblclick', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('button') || target.closest('input')) return;
    // An open cell keeps the browser's own double-click — a WORD, the way any
    // text field does. It used to select the whole cell instead (the owner,
    // 24.09.2026: "the whole line gets selected, selecting one word is impossible"),
    // which also made the formatting bar useless for anything but the lot.
    if (cell.querySelector('.cm-md-cellinput')) return;
    event.preventDefault();
    beginEdit(view, wrap, cell, 'all');
  });
}

/**
 * Cells *display* inline markdown and the small line structures; editing always
 * works on the raw text. Each rendered line carries its index so a click can be
 * mapped back to an offset in the cell's text.
 *
 * Round 28 draws a run of list lines as a REAL `<ul>`/`<ol>` tree, nested the
 * way the file's two-space indents say — that is the round's visible half: the
 * owner's complaint was that a cell holding a list *looked* like one line of
 * text with dashes in it. Bullets, numbering and each level's glyph now come
 * from the browser, which also means the depth is not capped by however many
 * indent rules the stylesheet happens to carry.
 *
 * Every item still keeps the flat `.cm-md-cell-line` identity (`data-line`,
 * `data-kind`, `data-indent`) it had before the tree: that is what maps a click
 * back to an offset in the raw text (`caretFromPoint`) and what the checkbox
 * uses to address its own line.
 */
function renderCell(
  host: HTMLElement,
  raw: string,
  row: number,
  col: number,
  onToggleTask: (line: number) => void,
): void {
  if (!raw) {
    if (row === HEADER_ROW) {
      const hint = document.createElement('span');
      hint.className = 'cm-md-cell-placeholder';
      hint.textContent = headerPlaceholder(col);
      host.appendChild(hint);
    } else {
      host.appendChild(document.createTextNode(' '));
    }
    return;
  }

  /** Lists currently open, outermost first: `stack[i]` holds depth `i + 1`. */
  const stack: { list: HTMLElement; ordered: boolean }[] = [];

  /** A nested list belongs INSIDE the item above it, the way HTML nests lists. */
  const openList = (ordered: boolean, start: number): void => {
    const list = document.createElement(ordered ? 'ol' : 'ul');
    list.className = 'cm-md-cell-list';
    // The browser numbers the items; the file's own numbers only matter when a
    // run does not start at 1 — an import can do that, and until its cell is
    // edited (`formatCellLines` renumbers each run) it should still read as 3, 4.
    if (ordered && Number.isFinite(start) && start > 1) list.setAttribute('start', String(start));

    const parent = stack.length > 0 ? stack[stack.length - 1].list : null;
    const last = parent?.lastElementChild;
    (last?.tagName === 'LI' ? (last as HTMLElement) : (parent ?? host)).appendChild(list);
    stack.push({ list, ordered });
  };

  /** The list an item of this depth goes in, opening/closing lists to get there. */
  const listAt = (depth: number, ordered: boolean, start: number): HTMLElement => {
    while (stack.length > depth) stack.pop();
    // A number after a bullet at the same depth starts a new list rather than
    // continuing one that would then have two kinds of marker in it.
    if (stack.length === depth && stack[depth - 1].ordered !== ordered) stack.pop();
    while (stack.length < depth) openList(ordered && stack.length === depth - 1, start);
    return stack[stack.length - 1].list;
  };

  splitCellLines(raw).forEach((source, index) => {
    const parsed = parseCellLine(source);
    const item = parsed.kind === 'bullet' || parsed.kind === 'task' || parsed.kind === 'ordered';
    const heading = /^heading([1-3])$/.exec(parsed.kind);
    const line = document.createElement(item ? 'li' : heading ? `h${heading[1]}` : 'div');
    line.className = 'cm-md-cell-line';
    line.dataset.line = String(index);
    line.dataset.kind = parsed.kind;
    if (parsed.marker) line.dataset.marker = parsed.marker;
    if (parsed.indent > 0) line.dataset.indent = String(parsed.indent);

    if (parsed.kind === 'task') {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'cm-md-cell-check';
      box.checked = parsed.checked;
      box.setAttribute('aria-label', t(parsed.checked ? 'task.done' : 'task.notDone'));
      box.addEventListener('mousedown', (event) => event.stopPropagation());
      box.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggleTask(index);
      });
      line.appendChild(box);
    }

    const text = document.createElement('span');
    text.className = 'cm-md-cell-text';
    renderInline(text, parsed.text);
    line.appendChild(text);

    if (!item) {
      // A paragraph line ends every list above it — what follows is a new one.
      stack.length = 0;
      host.appendChild(line);
      return;
    }
    // A checklist item is a bullet as far as the tree is concerned; its box
    // replaces the marker (the stylesheet takes it off), like GFM's own.
    listAt(
      parsed.indent + 1,
      parsed.kind === 'ordered',
      Number.parseInt(parsed.marker.trimStart(), 10),
    ).appendChild(line);
  });
}

/** How each inline token is drawn in a cell. Anything missing becomes a span. */
const INLINE_TAGS: Partial<Record<InlineTokenType, string>> = {
  code: 'code',
  strong: 'strong',
  em: 'em',
  del: 'del',
};

const INLINE_CLASSES: Partial<Record<InlineTokenType, string>> = {
  link: 'cm-md-link',
  ins: 'cm-md-ins',
  mark: 'cm-md-mark',
};

function renderInline(host: HTMLElement, text: string): void {
  if (!text) {
    host.dataset.empty = 'true';
    host.appendChild(document.createTextNode(' '));
    return;
  }
  for (const token of parseInlineSpans(text)) {
    if (token.type === 'text') {
      host.appendChild(document.createTextNode(token.text));
      continue;
    }
    const node = document.createElement(INLINE_TAGS[token.type] ?? 'span');
    node.dataset.sourceFrom = String(token.from);
    node.dataset.sourceTo = String(token.to);
    const cls = INLINE_CLASSES[token.type];
    if (cls) node.className = cls;
    if (token.type === 'link' && token.target !== undefined) node.dataset.target = token.target;
    if (token.type === 'mark' && token.color && isBgToken(token.color)) {
      node.classList.add(`cm-md-mark--${token.color}`);
      node.dataset.color = token.color;
    }
    node.textContent = token.text;
    host.appendChild(node);
  }
}

/**
 * Translate a click in the *rendered* cell into an offset in the cell's
 * editable text: which rendered line was hit, how far into its visible text the
 * pointer landed, and where that is once markers (`**`, backticks, the list
 * prefix) are counted back in.
 */
function caretFromPoint(content: HTMLElement, raw: string, event: MouseEvent): FocusMode {
  const lines = splitCellLines(raw);
  const hit = (event.target as HTMLElement).closest<HTMLElement>('.cm-md-cell-line');
  const index = hit ? Number(hit.dataset.line) : lines.length - 1;
  if (!Number.isFinite(index) || index < 0 || index >= lines.length) return 'all';

  let base = 0;
  for (let i = 0; i < index; i++) base += lines[i].length + 1;

  const parsed = parseCellLine(lines[index]);
  const text = hit?.querySelector<HTMLElement>('.cm-md-cell-text');
  const display = text ? displayOffsetAt(text, event.clientX, event.clientY) : null;
  if (display === null) return base + lines[index].length;
  return base + parsed.marker.length + displayToRawOffset(parsed.text, display);
}

/** Character offset in the rendered text under the given viewport point. */
function displayOffsetAt(content: HTMLElement, x: number, y: number): number | null {
  const doc = content.ownerDocument;
  let range: Range | null = null;

  const legacy = doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
  const modern = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };

  if (typeof legacy.caretRangeFromPoint === 'function') {
    range = legacy.caretRangeFromPoint(x, y);
  } else if (typeof modern.caretPositionFromPoint === 'function') {
    const position = modern.caretPositionFromPoint(x, y);
    if (position) {
      range = doc.createRange();
      range.setStart(position.offsetNode, position.offset);
    }
  }

  if (!range || !content.contains(range.startContainer)) return null;
  const measureRange = doc.createRange();
  measureRange.selectNodeContents(content);
  measureRange.setEnd(range.startContainer, range.startOffset);
  return measureRange.toString().length;
}

/* --------------------------------------------------------------- editing -- */

/**
 * The cell drawn at a position — the anchor itself when that position is inside
 * a merged one, so navigation that walks into a covered cell lands on the cell
 * the author can actually see.
 */
function findCell(wrap: HTMLElement, ref: CellRef): HTMLTableCellElement | null {
  const exact = wrap.querySelector<HTMLTableCellElement>(
    `[data-row="${ref.row}"][data-col="${ref.col}"]`,
  );
  if (exact) return exact;

  for (const cell of wrap.querySelectorAll<HTMLTableCellElement>('.cm-md-grid th, .cm-md-grid td')) {
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    const rows = Number(cell.dataset.rowspan ?? 1);
    const cols = Number(cell.dataset.colspan ?? 1);
    if (ref.row >= row && ref.row < row + rows && ref.col >= col && ref.col < col + cols) return cell;
  }
  return null;
}

/**
 * The table's real shape. Counted off the widget's own dataset rather than the
 * DOM: a merged header row has fewer `<th>`s than the table has columns.
 */
function gridSize(wrap: HTMLElement): { cols: number; rows: number } {
  const cols = Number(wrap.dataset.cols);
  const rows = Number(wrap.dataset.rows);
  return {
    cols: Number.isFinite(cols) && cols > 0 ? cols : wrap.querySelectorAll('thead th').length,
    rows: Number.isFinite(rows) ? rows : wrap.querySelectorAll('tbody tr').length,
  };
}

/** The line the caret sits on, as offsets into `value`. */
function lineAround(value: string, caret: number): { from: number; to: number; text: string } {
  const from = value.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
  const next = value.indexOf('\n', caret);
  const to = next === -1 ? value.length : next;
  return { from, to, text: value.slice(from, to) };
}

/** Visible-character offset inside an inline-markdown source string. */
function rawToDisplayOffset(raw: string, rawOffset: number): number {
  const wanted = Math.max(0, Math.min(rawOffset, raw.length));
  let visible = 0;
  for (const span of parseInlineSpans(raw)) {
    if (wanted >= span.to) {
      visible += span.text.length;
      continue;
    }
    if (wanted <= span.from) return visible;
    const source = raw.slice(span.from, span.to);
    const contentAt = source.indexOf(span.text);
    const inside = Math.max(0, wanted - span.from - Math.max(0, contentAt));
    return visible + Math.min(inside, span.text.length);
  }
  return visible;
}

/** Text-node boundary at a visible offset, for restoring a rich-cell caret. */
function domPointAt(host: HTMLElement, offset: number): { node: Node; offset: number } {
  const walker = host.ownerDocument.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let left = Math.max(0, offset);
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (left <= length) return { node, offset: left };
    left -= length;
    node = walker.nextNode();
  }
  return { node: host, offset: host.childNodes.length };
}

/** Markdown produced by the semantic inline DOM used inside an edited cell. */
function inlineSource(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof HTMLElement)) return '';
  const inner = Array.from(node.childNodes, inlineSource).join('');
  if (node.classList.contains('cm-md-link')) return `[${inner}](${node.dataset.target ?? 'url'})`;
  switch (node.tagName) {
    case 'STRONG':
    case 'B':
      return `**${inner}**`;
    case 'EM':
    case 'I':
      return `*${inner}*`;
    case 'DEL':
    case 'S':
      return `~~${inner}~~`;
    case 'CODE':
      return `\`${inner}\``;
    case 'INS':
    case 'U':
      return `<ins>${inner}</ins>`;
    case 'MARK':
      // Written back as `==…==` (format.ts) — a legacy `<mark>` cell comes out
      // in the markdown form the first time it is edited.
      return node.dataset.color ? `==${inner}=={.${node.dataset.color}}` : `==${inner}==`;
    default:
      return inner;
  }
}

/** A line's own structural children: the task box, the text span, a nested list. Anything else in there was put by the browser. */
const LINE_PARTS = new Set(['cm-md-cell-text', 'cm-md-cell-check', 'cm-md-cell-list', 'cm-md-cell-line']);

function isStrayNode(node: Node): boolean {
  if (!(node instanceof HTMLElement)) return node.nodeType === Node.TEXT_NODE;
  for (const cls of LINE_PARTS) if (node.classList.contains(cls)) return false;
  return true;
}

/**
 * Chrome drops an inline element the moment its last character is deleted:
 * backspace a cell's text down to nothing and the `.cm-md-cell-text` span is
 * GONE, so everything typed next lands straight in the line element — where
 * `editableCellText` never looked. The model kept saying "" while the line
 * plainly showed the text; the owner, 24.09.2026: "I typed text, pressed Enter —
 * everything was gone from the cell", and "(( in a table sometimes does not fire" was the
 * same thing seen from the emoji dropdown (it reads the same `value`).
 *
 * Called before every read-back: rebuilds the span where the browser removed
 * it and moves stray nodes — of a line, or of the root between lines — into
 * the span they belong to, keeping the caret on the very node it was in.
 */
function adoptStrayNodes(rich: HTMLElement): void {
  const doc = rich.ownerDocument;
  const selection = doc.getSelection();
  const saved =
    selection && selection.rangeCount > 0 && rich.contains(selection.anchorNode) && rich.contains(selection.focusNode)
      ? {
          anchor: selection.anchorNode!,
          anchorOffset: selection.anchorOffset,
          focus: selection.focusNode!,
          focusOffset: selection.focusOffset,
        }
      : null;
  let touched: HTMLElement | null = null;

  const textOf = (line: HTMLElement): HTMLElement => {
    let text = Array.from(line.children).find((child) => child.classList.contains('cm-md-cell-text')) as
      | HTMLElement
      | undefined;
    if (!text) {
      text = doc.createElement('span');
      text.className = 'cm-md-cell-text';
      const check = Array.from(line.children).find((child) => child.classList.contains('cm-md-cell-check'));
      if (check) check.after(text);
      else line.prepend(text);
    }
    return text;
  };

  const adopt = (line: HTMLElement, strays: Node[]) => {
    if (strays.length === 0) return;
    const text = textOf(line);
    const before = strays.filter((node) => text.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING);
    const after = strays.filter((node) => !before.includes(node));
    text.prepend(...before);
    text.append(...after);
    touched = text;
  };

  for (const line of Array.from(rich.querySelectorAll<HTMLElement>('.cm-md-cell-line'))) {
    adopt(line, Array.from(line.childNodes).filter(isStrayNode));
  }
  // Root-level leftovers go to the line they sit next to — after the line
  // above them, or into the first line when nothing precedes them.
  const rootStrays = Array.from(rich.childNodes).filter(isStrayNode);
  if (rootStrays.length > 0) {
    const lines = Array.from(rich.querySelectorAll<HTMLElement>('.cm-md-cell-line'));
    if (lines.length > 0) {
      for (const node of rootStrays) {
        const above = lines.filter((line) => line.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING).pop();
        adopt(above ?? lines[0], [node]);
      }
    }
  }

  if (!touched || !saved || !selection) return;
  try {
    if (saved.anchor.nodeType === Node.TEXT_NODE && saved.focus.nodeType === Node.TEXT_NODE) {
      selection.setBaseAndExtent(saved.anchor, saved.anchorOffset, saved.focus, saved.focusOffset);
    } else {
      const range = doc.createRange();
      range.selectNodeContents(touched);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  } catch {
    /* a node the browser has since discarded — the next keystroke re-reads the caret anyway */
  }
}

/** Turn the rich cell DOM back into the same plain text the old textarea held. */
function editableCellText(field: HTMLElement): string {
  const lines = Array.from(field.querySelectorAll<HTMLElement>('.cm-md-cell-line'));
  if (lines.length === 0) return field.textContent ?? '';
  return lines
    .map((line) => {
      const text = line.querySelector<HTMLElement>('.cm-md-cell-text');
      // No span at all (see `adoptStrayNodes`): the line's own text nodes are
      // the next best thing — never silently "".
      const rendered = text
        ? Array.from(text.childNodes, inlineSource).join('')
        : Array.from(line.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent ?? '')
            .join('');
      const body = text?.dataset.empty === 'true' && rendered === ' ' ? '' : rendered;
      const indent = '  '.repeat(Number(line.dataset.indent ?? 0));
      switch (line.dataset.kind) {
        case 'bullet':
          return `${indent}${BULLET}${body}`;
        case 'ordered':
          return `${indent}${line.dataset.marker || '1. '}${body}`;
        case 'task': {
          const checked = line.querySelector<HTMLInputElement>('.cm-md-cell-check')?.checked;
          return `${indent}${checked ? '[x] ' : TASK_OPEN}${body}`;
        }
        case 'heading1':
        case 'heading2':
        case 'heading3':
          // `renderCell` draws these as real `<h1>`-`<h3>` elements with no
          // visible `#` — without the marker, a keystroke on any other line
          // (which reruns this whole read-back) silently downgrades the
          // heading to a plain paragraph the next time the cell commits.
          return `${line.dataset.marker ?? ''}${body}`;
        default:
          return body;
      }
    })
    .join('\n');
}

/** Raw-text offset represented by one DOM selection endpoint. */
function rawOffsetAtDom(field: HTMLElement, value: string, node: Node, offset: number): number {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const line = element?.closest<HTMLElement>('.cm-md-cell-line');
  const sourceLines = value.split('\n');
  if (!line || !field.contains(line)) return offset <= 0 ? 0 : value.length;
  const index = Number(line.dataset.line ?? 0);
  const source = sourceLines[index] ?? '';
  const parsed = parseCellLine(source);
  let base = 0;
  for (let i = 0; i < index; i++) base += (sourceLines[i]?.length ?? 0) + 1;
  const text = line.querySelector<HTMLElement>('.cm-md-cell-text');
  if (!text || !text.contains(node)) return base + parsed.marker.length;
  const sourceElement = element?.closest<HTMLElement>('[data-source-from]');
  if (sourceElement && text.contains(sourceElement)) {
    const spanFrom = Number(sourceElement.dataset.sourceFrom ?? 0);
    const spanTo = Number(sourceElement.dataset.sourceTo ?? spanFrom);
    const chunk = parsed.text.slice(spanFrom, spanTo);
    const visible = sourceElement.textContent ?? '';
    const contentStart = Math.max(0, chunk.indexOf(visible));
    const range = field.ownerDocument.createRange();
    range.selectNodeContents(sourceElement);
    try {
      range.setEnd(node, offset);
      return base + parsed.marker.length + spanFrom + contentStart + range.toString().length;
    } catch {
      return base + parsed.marker.length + spanFrom + contentStart;
    }
  }
  const range = field.ownerDocument.createRange();
  range.selectNodeContents(text);
  try {
    range.setEnd(node, offset);
  } catch {
    return base + source.length;
  }
  return base + parsed.marker.length + displayToRawOffset(parsed.text, range.toString().length);
}

/** DOM selection endpoint represented by a raw-text offset. */
function domPointAtRaw(field: HTMLElement, value: string, rawOffset: number): { node: Node; offset: number } {
  const lines = value.split('\n');
  const wanted = Math.max(0, Math.min(rawOffset, value.length));
  let base = 0;
  let index = 0;
  for (; index < lines.length - 1; index++) {
    const end = base + lines[index].length;
    if (wanted <= end) break;
    base = end + 1;
  }
  const source = lines[index] ?? '';
  const parsed = parseCellLine(source);
  const inside = Math.max(0, wanted - base - parsed.marker.length);
  const text = field.querySelector<HTMLElement>(`.cm-md-cell-line[data-line="${index}"] .cm-md-cell-text`);
  return text ? domPointAt(text, rawToDisplayOffset(parsed.text, inside)) : { node: field, offset: 0 };
}

/**
 * A contenteditable cell with the value/selection API the former textarea
 * exposed. The table code and its keyboard/emoji/formatting helpers keep one
 * markdown model, while the author sees semantic bold, highlight, links and
 * lists instead of their storage markers.
 */
function createCellInput(raw: string, row: number, col: number): HTMLTextAreaElement {
  const rich = document.createElement('div');
  rich.className = 'cm-md-cellinput';
  rich.contentEditable = 'true';
  rich.tabIndex = 0;
  rich.spellcheck = true;
  rich.setAttribute('role', 'textbox');
  rich.setAttribute('aria-multiline', 'true');

  const field = rich as unknown as HTMLTextAreaElement;
  let value = cellRawToText(raw);
  let storedFrom = 0;
  let storedTo = 0;
  let ignoreSyntheticInput = false;

  const render = () => {
    rich.replaceChildren();
    const isBlank = value === '';
    // Unlike the commit serializer, the editing surface must preserve a blank
    // first/last line: that is where the caret lives immediately after Enter.
    renderCell(rich, isBlank ? ' ' : value.split('\n').join('<br>'), row, col, () => undefined);
    if (isBlank) {
      // `renderCell` takes this substitute space as real text (it is not the
      // empty string), so it never gets `renderInline`'s own `data-empty`
      // placeholder tag the way a blank line made by Enter does. Tag it here
      // too — `reclaimPlaceholder` (below) is what a real keystroke needs to
      // find it and strip it back out instead of stranding it as a trailing
      // space in the caret's own line.
      const text = rich.querySelector<HTMLElement>('.cm-md-cell-text');
      if (text) text.dataset.empty = 'true';
    }
    rich.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
      input.contentEditable = 'false';
      input.tabIndex = -1;
    });
  };

  /**
   * A line that opened blank carries one placeholder space so the browser has
   * somewhere to put the caret (`render`, `renderInline`) — marked
   * `data-empty="true"` either way. The caret lands *before* that space
   * (`domPointAtRaw` on an empty line resolves to offset 0), so the browser's
   * own native contenteditable typing inserts new characters ahead of it,
   * stranding the placeholder as a trailing space nobody typed. Harmless once
   * committed (`cellTextToRaw` trims every line), but it corrupts the raw
   * `value` this shim hands back for every keystroke in between — including
   * the very next Enter, which reads the line's text to decide whether it is
   * a list item to continue. Called once per real keystroke, before that text
   * is read back off the DOM: on the placeholder's first real content, it
   * removes exactly the one leftover space and un-tags the line so a
   * genuinely typed trailing space is never touched again after that.
   *
   * Rewriting a text node's content also collapses the browser's own
   * selection to its start, which would otherwise throw the caret from right
   * after what the author just typed back to the front of the line — so a
   * selection anchored in the node being trimmed is put back where it was
   * (clamped to the shorter length) rather than left to that default.
   */
  const reclaimPlaceholders = (): void => {
    const selection = rich.ownerDocument.getSelection();
    rich.querySelectorAll<HTMLElement>('.cm-md-cell-text[data-empty="true"]').forEach((span) => {
      if (span.textContent === ' ') return; // still genuinely empty
      let node: Node | null = span.lastChild;
      while (node && node.nodeType !== Node.TEXT_NODE) node = node.lastChild;
      delete span.dataset.empty;
      if (!node || !node.textContent?.endsWith(' ')) return;
      const restoreAt =
        selection && selection.isCollapsed && selection.anchorNode === node ? selection.anchorOffset : null;
      node.textContent = node.textContent.slice(0, -1);
      if (restoreAt === null || !selection) return;
      const range = rich.ownerDocument.createRange();
      range.setStart(node, Math.min(restoreAt, node.textContent.length));
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    });
  };

  const readSelection = (): { from: number; to: number } => {
    const selection = rich.ownerDocument.getSelection();
    if (!selection || selection.rangeCount === 0 || !rich.contains(selection.anchorNode) || !rich.contains(selection.focusNode)) {
      return { from: storedFrom, to: storedTo };
    }
    const anchor = rawOffsetAtDom(rich, value, selection.anchorNode!, selection.anchorOffset);
    const focus = rawOffsetAtDom(rich, value, selection.focusNode!, selection.focusOffset);
    storedFrom = Math.min(anchor, focus);
    storedTo = Math.max(anchor, focus);
    return { from: storedFrom, to: storedTo };
  };

  const setSelection = (from: number, to: number) => {
    storedFrom = Math.max(0, Math.min(from, value.length));
    storedTo = Math.max(storedFrom, Math.min(to, value.length));
    const selection = rich.ownerDocument.getSelection();
    if (!selection || !rich.isConnected) return;
    const start = domPointAtRaw(rich, value, storedFrom);
    const end = domPointAtRaw(rich, value, storedTo);
    const range = rich.ownerDocument.createRange();
    try {
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch {
      /* A concurrent render removed a boundary; the stored offsets still survive. */
    }
  };

  Object.defineProperty(field, 'value', {
    configurable: true,
    get: () => value,
    set: (next: string) => {
      value = String(next);
      render();
    },
  });
  Object.defineProperty(field, 'selectionStart', {
    configurable: true,
    get: () => readSelection().from,
    set: (next: number) => setSelection(next, readSelection().to),
  });
  Object.defineProperty(field, 'selectionEnd', {
    configurable: true,
    get: () => readSelection().to,
    set: (next: number) => setSelection(readSelection().from, next),
  });
  field.setSelectionRange = (from: number, to: number) => setSelection(from, to);
  field.select = () => setSelection(0, value.length);
  field.setRangeText = ((
    replacement: string,
    start?: number,
    end?: number,
    mode: SelectionMode = 'preserve',
  ) => {
    const before = readSelection();
    const from = start ?? before.from;
    const to = end ?? before.to;
    value = value.slice(0, from) + replacement + value.slice(to);
    render();
    ignoreSyntheticInput = true;
    const insertedEnd = from + replacement.length;
    if (mode === 'select') setSelection(from, insertedEnd);
    else if (mode === 'start') setSelection(from, from);
    else if (mode === 'end') setSelection(insertedEnd, insertedEnd);
    else {
      const delta = replacement.length - (to - from);
      const map = (at: number) => (at <= from ? at : at >= to ? at + delta : insertedEnd);
      setSelection(map(before.from), map(before.to));
    }
  }) as HTMLTextAreaElement['setRangeText'];

  // Native contenteditable input has already changed the semantic DOM. Read it
  // back without re-rendering, so the browser's caret remains exactly where it
  // landed; every programmatic edit above still goes through `render()`.
  const readBack = () => {
    adoptStrayNodes(rich);
    reclaimPlaceholders();
    value = editableCellText(rich);
    readSelection();
  };
  rich.addEventListener('input', (event) => {
    if (!event.isTrusted && ignoreSyntheticInput) {
      ignoreSyntheticInput = false;
      return;
    }
    ignoreSyntheticInput = false;
    // An IME composition (the OS emoji panel, a dead key, a phone keyboard's
    // word under construction) owns the text node it is writing into: the
    // read-back above rewrites nodes (`reclaimPlaceholders` strips the
    // placeholder space out of the very node being composed), which cancels the
    // composition — the next update then starts a new one and the text lands
    // twice, an emoji in an empty cell as `😀😀`, "ab" as "aab". Until the
    // composition ends the model only READS the DOM; `compositionend` does the tidy-up.
    if ((event as InputEvent).isComposing) {
      value = editableCellText(rich);
      readSelection();
      return;
    }
    readBack();
  });
  rich.addEventListener('compositionend', readBack);
  render();
  return field;
}

function beginEdit(
  view: EditorView,
  wrap: HTMLElement,
  cell: HTMLTableCellElement,
  focus: FocusMode = 'all',
): void {
  if (cell.querySelector('.cm-md-cellinput')) return;
  const content = cell.querySelector<HTMLElement>('.cm-md-cell');
  if (content) content.hidden = true;

  const raw = cell.dataset.raw ?? '';
  const row = Number(cell.dataset.row);
  const col = Number(cell.dataset.col);
  const field = createCellInput(raw, row, col);
  cell.appendChild(field);

  /* --------------------------------------------------- in-cell undo/redo -- */
  /*
   * The field is a `contenteditable` div living inside the widget, outside
   * `view.contentDOM` (see the module doc above) — CodeMirror's own
   * `yUndoManagerKeymap` never sees a keystroke typed in here, which is why
   * Ctrl+Z did nothing at all while a cell was open. This keeps a small
   * linear history of the field's own text: one entry for the value the cell
   * opened with, one more each time a burst of typing settles (debounced, so
   * a fast run of keystrokes undoes as one step) or a discrete edit lands
   * through `setRangeText` (Enter, paste, emoji, the mini-slash, the bold/
   * italic toolbar — anything that is not raw contenteditable typing).
   *
   * Once that local history is exhausted — back to how the cell looked when
   * it opened, nothing left to undo inside it — the key is handed to the
   * document's own undo/redo instead of doing nothing, after committing
   * whatever (by then unchanged) value is left, so the very next Ctrl+Z
   * removes this cell's last commit rather than repeating a no-op.
   */
  const HISTORY_LIMIT = 50;
  const SNAPSHOT_DEBOUNCE_MS = 300;
  let cellHistory = [field.value];
  let cellHistoryIndex = 0;
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;

  const captureSnapshot = () => {
    if (cellHistory[cellHistoryIndex] === field.value) return;
    cellHistory = cellHistory.slice(0, cellHistoryIndex + 1);
    cellHistory.push(field.value);
    cellHistoryIndex = cellHistory.length - 1;
    if (cellHistory.length > HISTORY_LIMIT) {
      cellHistory.shift();
      cellHistoryIndex--;
    }
  };

  const scheduleSnapshot = () => {
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      captureSnapshot();
    }, SNAPSHOT_DEBOUNCE_MS);
  };

  const flushSnapshot = () => {
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
      snapshotTimer = null;
    }
    captureSnapshot();
  };

  // Every *discrete* programmatic edit (Enter, paste, emoji, slash picks,
  // the formatting toolbar) goes through the field's own `setRangeText` —
  // wrapping it here, rather than teaching each caller about history, is
  // what makes those count as one undo step apiece instead of being lost or
  // folded into whatever the debounce happens to be doing.
  type SetRangeTextFn = (replacement: string, start?: number, end?: number, mode?: SelectionMode) => void;
  const nativeSetRangeText = field.setRangeText as unknown as SetRangeTextFn;
  field.setRangeText = ((replacement: string, start?: number, end?: number, mode?: SelectionMode) => {
    nativeSetRangeText(replacement, start, end, mode);
    captureSnapshot();
  }) as HTMLTextAreaElement['setRangeText'];

  const applyHistoryValue = (next: string) => {
    field.value = next;
    const at = field.value.length;
    field.setSelectionRange(at, at);
  };

  /** Undoes one step inside the cell; false once its own history is spent. */
  const cellUndo = (): boolean => {
    flushSnapshot();
    if (cellHistoryIndex === 0) return false;
    cellHistoryIndex--;
    applyHistoryValue(cellHistory[cellHistoryIndex]);
    return true;
  };

  /** Redoes one step inside the cell; false once its own history is spent. */
  const cellRedo = (): boolean => {
    if (cellHistoryIndex >= cellHistory.length - 1) return false;
    cellHistoryIndex++;
    applyHistoryValue(cellHistory[cellHistoryIndex]);
    return true;
  };

  /**
   * Nothing to size: the field is a contenteditable block, as tall as its
   * content by itself. This used to pin `height` to `scrollHeight` — right
   * for the `<textarea>` the field once was, wrong for a `content-box` div,
   * whose `scrollHeight` already includes the padding: the padding was
   * counted twice, every cell grew by 11px the moment it was opened, and the
   * row-insert line was left hanging where the row USED to end (the owner,
   * 29.09.2026: "the line along the bottom of the cell moved — simply because
   * the current cell became taller"). Kept as a function because its callers are also
   * the places where the content just changed.
   */
  const autosize = () => {
    if (field.style.height) field.style.height = '';
  };

  // Attached before the grid's own key handling: while the emoji dropdown is
  // open it swallows Enter/Tab/arrows so they never reach cell navigation.
  const emoji = attachEmojiInput(field, view.state.facet(emojiFavouritesFacet));
  const formatting = attachFieldFormatting(field, autosize);
  let slash: MenuHandle | null = null;

  field.focus();
  if (focus === 'all') {
    field.select();
  } else {
    const at = Math.max(0, Math.min(focus, field.value.length));
    field.setSelectionRange(at, at);
  }
  autosize();

  let settled = false;
  const ref: CellRef = { row: Number(cell.dataset.row), col: Number(cell.dataset.col) };

  const close = () => {
    settled = true;
    untrackCell(wrap);
    slash?.close();
    formatting.destroy();
    emoji.destroy();
    field.remove();
    if (content) content.hidden = false;
  };

  // The draft this field holds is now the only copy of it — see the
  // draft-rescue section for what happens when the grid dies before a commit.
  // Only if the field survived being opened: `field.focus()` above blurs
  // whichever cell was open before, and that commit rewrites the table, which
  // rebuilds the grid — and this field with it — before we ever get here.
  // The cell's value as opened. A commit that ends with the same value must
  // not touch the document at all (08.09.2026, owner: "it gets in the way"): applyEdit
  // re-serializes the WHOLE table, and serializeGfmTable re-pads every column,
  // so an unpadded table produced a real document change — and therefore an
  // undo-stack entry — for merely Tab-ing through cells.
  const originalValue = cellTextToRaw(field.value);
  if (field.isConnected) {
    trackCell({
      view,
      wrap,
      ref,
      original: originalValue,
      anchor: rendering ? null : safePosAtDOM(view, wrap),
      read: () => cellTextToRaw(field.value),
      close,
    });
  }

  const commit = (move: CellMove | null) => {
    if (settled) return;
    const value = cellTextToRaw(field.value);
    close();

    const clicked = readPendingFocus(wrap);
    const target = move ? (move.kind !== 'exit' ? { row: move.row, col: move.col } : null) : clicked?.ref ?? null;
    const mode: FocusMode = move ? 'all' : clicked?.mode ?? 'all';
    if (target) {
      wrap.dataset.focusRow = String(target.row);
      wrap.dataset.focusCol = String(target.col);
      wrap.dataset.focusMode = String(mode);
    }

    // Nothing typed and no structural move: leave the document (and the undo
    // stack) untouched, and hand focus on to the next cell directly.
    const unchanged = value === originalValue && move?.kind !== 'newRow';

    // `hold: false`: this edit hands focus straight to the next cell, so the
    // caret is what the viewport should follow — Tab off the last row is meant
    // to bring the new row into view.
    const wrote = unchanged
      ? false
      : applyEdit(
          view,
          wrap,
          (table) => {
            const next = setCell(table, ref.row, ref.col, value);
            return move?.kind === 'newRow' ? insertRow(next, move.row - 1) : next;
          },
          { hold: false },
        );
    if (wrote) return; // updateDOM re-renders and picks the pending focus up

    clearPendingFocus(wrap);
    const next = target && findCell(wrap, target);
    // A clicked cell is already opening (its `beginEdit` is what blurred this
    // one): `beginEdit` finds its field and returns — the point is only that
    // focus is NOT handed back to the view from under it.
    if (next) beginEdit(view, wrap, next, mode);
    else view.focus();
  };

  /**
   * Close the cell and hand focus back to the view, WITHOUT going through
   * `commit`/`applyEdit` — used only where the field is already provably
   * identical to what is on record (`cellUndo`/`cellRedo` just returned
   * false, which by construction means `field.value === cellHistory[0]`, the
   * value the cell opened with). `applyEdit` always re-serializes the WHOLE
   * table (see the module doc), which can rewrite column padding even when
   * no cell's content actually changed — dispatching that here, right before
   * handing off to the document's own undo, would create a fresh undo step
   * out of nothing and immediately eat it undoing THAT instead of the edit
   * the author actually meant to remove.
   */
  const closeWithoutWriting = () => {
    if (settled) return;
    close();
    view.focus();
  };

  /** Enter inside a cell: a break, continuing a list when the line is one. */
  const insertBreak = (continueList: boolean) => {
    const caret = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? caret;
    const line = lineAround(field.value, caret);
    const continuation = continueList ? listContinuation(line.text) : null;

    if (continuation === '') {
      // Enter on an empty list item ends the list instead of growing it.
      field.setRangeText('', line.from, line.to, 'end');
      autosize();
      return;
    }

    // A collapsed caret can legally sit right at a folded link's label edge
    // (`rawOffsetAtDom` puts it there for what looks like the visual end/start
    // of the line) — splitting exactly there would tear `[label](url)` in
    // half. Snap the split point to the link's near edge first; see
    // `enterSafeRawPos` in gfm-table.ts.
    let from = caret;
    let to = end;
    if (caret === end) {
      const parsed = parseCellLine(line.text);
      const local = caret - line.from - parsed.marker.length;
      const safeLocal = enterSafeRawPos(parsed.text, local);
      if (safeLocal !== local) from = to = line.from + parsed.marker.length + safeLocal;
    }

    field.setRangeText(`\n${continuation ?? ''}`, from, to, 'end');
    autosize();
  };

  /**
   * Backspace/Delete right next to a folded link's hidden marker: deletes the
   * whole `[label](url)` instead of just the marker on that side, which would
   * otherwise leave `[label` or `label](url)` behind — the same trap as
   * Enter, one key press either direction. Returns false (does nothing) for
   * every other position, including mid-label, which native contenteditable
   * deletion keeps handling one character at a time.
   */
  const deleteNextToLink = (forward: boolean): boolean => {
    const caret = field.selectionStart ?? 0;
    const end = field.selectionEnd ?? caret;
    if (caret !== end) return false;
    const line = lineAround(field.value, caret);
    const parsed = parseCellLine(line.text);
    const local = caret - line.from - parsed.marker.length;
    const span = riskyLinkSpan(parsed.text, local, forward);
    if (!span) return false;
    const base = line.from + parsed.marker.length;
    field.setRangeText('', base + span.from, base + span.to, 'start');
    autosize();
    return true;
  };

  /**
   * The cell's mini-slash. It deliberately does NOT take focus: focusing it
   * would blur the textarea, which commits the cell and re-renders the grid out
   * from under the menu. The field's own keydown drives it instead.
   */
  const openSlash = (at: number) => {
    slash?.close();
    const rect = field.getBoundingClientRect();
    // Line-prefix items (bullet/task/ordered/heading): the whole line up to the
    // slash becomes the marker — the trigger only ever fires at the start of a
    // blank line (see the `input` listener below), so there is nothing else on
    // it to preserve.
    const pick = (marker: string) => {
      const line = lineAround(field.value, at);
      field.setRangeText(marker, line.from, at + 1, 'end');
      field.focus();
      autosize();
    };
    // The one INLINE item: a link is valid content anywhere in a cell, not a
    // line-level construct, so it replaces just the trigger with a placeholder
    // pair and selects the label — typing overwrites it, same as a fresh cell
    // opening under `focus: 'all'`. Every other main-menu entry (table, image,
    // callout, mermaid, divider, pagetree, `<details>`…) is a BLOCK the grid
    // has no shape for, so it is deliberately left out rather than writing
    // markdown a table cell cannot hold.
    const pickLink = () => {
      const line = lineAround(field.value, at);
      const label = t('cellSlash.linkPlaceholder');
      field.setRangeText(`[${label}](url)`, line.from, at + 1, 'end');
      field.focus();
      field.setSelectionRange(line.from + 1, line.from + 1 + label.length);
      autosize();
    };
    slash = openMenu({
      x: rect.left,
      y: rect.bottom + 4,
      ariaLabel: t('cellSlash.aria'),
      takeFocus: false,
      items: [
        { label: t('cellSlash.bullet'), icon: 'list', onSelect: () => pick(BULLET) },
        { label: t('cellSlash.task'), icon: 'checklist', onSelect: () => pick(TASK_OPEN) },
        { label: t('cellSlash.ordered'), icon: 'listOrdered', onSelect: () => pick('1. ') },
        { label: t('cellSlash.heading1'), icon: 'heading', onSelect: () => pick('# ') },
        { label: t('cellSlash.heading2'), icon: 'heading', onSelect: () => pick('## ') },
        { label: t('cellSlash.heading3'), icon: 'heading', onSelect: () => pick('### ') },
        { label: t('cellSlash.link'), icon: 'link', onSelect: pickLink },
      ],
      onClose: () => {
        slash = null;
      },
    });
  };

  field.addEventListener('input', (event) => {
    autosize();
    // Native contenteditable typing never goes through `setRangeText` (that
    // wrapper only sees the field's own programmatic edits), so it needs its
    // own path into the undo history — debounced, so one burst of keystrokes
    // undoes as a single step instead of one per character.
    scheduleSnapshot();
    const data = (event as InputEvent).data;
    // Any other keystroke means the author moved on from the mini-slash.
    if (slash) slash.close();
    if (data !== '/') return;
    const caret = field.selectionStart ?? 0;
    const line = lineAround(field.value, caret);
    // Only at the start of a line — a slash inside a sentence is just a slash.
    if (field.value.slice(line.from, caret - 1).trim() !== '') return;
    openSlash(caret - 1);
  });

  field.addEventListener('keydown', (event) => {
    // While an IME composition is open, Enter/Tab/Escape/the arrows belong to
    // the IME (they pick, confirm or cancel a candidate): `isComposing` for
    // most browsers, keyCode 229 for the one key Safari delivers after
    // `compositionend`. Reading them as cell navigation split the cell, moved
    // on to the next one or closed it from under the composition.
    if (event.isComposing || event.keyCode === 229) return;
    const { rows, cols } = gridSize(wrap);
    // The formatting hotkeys are handled by `attachFieldFormatting`; nothing
    // below may treat them as navigation.
    if (formatForEvent(event)) return;

    // Undo/redo. `preventDefault` + `stopPropagation` unconditionally, even
    // when there is nothing left in the cell's own history: the browser's
    // native contenteditable undo must never fire here (it mangles the
    // `cm-md-cell-line` structure `editableCellText` depends on), and the
    // key never reaches CodeMirror's own keymap on its own — the field sits
    // outside `view.contentDOM`, so this handler is the only thing standing
    // between the keypress and either outcome.
    const mod = (event.metaKey || event.ctrlKey) && !event.altKey;
    if (mod && (event.key === 'z' || event.key === 'Z')) {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) {
        if (!cellRedo()) {
          closeWithoutWriting();
          documentRedo?.(view);
        }
      } else if (!cellUndo()) {
        closeWithoutWriting();
        documentUndo?.(view);
      }
      return;
    }
    if (mod && !event.shiftKey && (event.key === 'y' || event.key === 'Y')) {
      event.preventDefault();
      event.stopPropagation();
      if (!cellRedo()) {
        closeWithoutWriting();
        documentRedo?.(view);
      }
      return;
    }

    // While the mini-slash is up it owns the navigation keys.
    if (slash) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        slash.move(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        slash.choose();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        slash.close();
        return;
      }
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      writeRange(wrap, null);
      paintSelection(wrap);
      view.focus();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      if (event.metaKey || event.ctrlKey) commit(verticalMove(ref, rows, 1));
      else insertBreak(!event.shiftKey);
      return;
    }

    if (event.key === 'Backspace' || event.key === 'Delete') {
      // Only claims the key at the four risky edges right next to a folded
      // link marker; everywhere else it declines and native contenteditable
      // deletion runs exactly as it always has.
      if (deleteNextToLink(event.key === 'Delete')) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      /*
       * Tab has two jobs in a table and only one key, so the caret decides
       * which: ON A LIST ITEM it changes that item's level (Shift+Tab back
       * out), ANYWHERE ELSE it keeps the meaning it has had since round 21 and
       * walks to the next cell — off the last one, that still appends a row.
       *
       * The line under the caret is the whole test, and `shiftCellIndent`
       * answers it in one place: null means "not an item", which is the signal
       * to fall through to navigation. So the gesture is only ever borrowed
       * where a list is what the author is looking at (round 28 — the reference
       * case is a Confluence "card" cell, a two-level list), and a cell of
       * ordinary text never loses its Tab.
       */
      const caret = field.selectionStart ?? 0;
      const line = lineAround(field.value, caret);
      const nested = shiftCellIndent(line.text, event.shiftKey ? -1 : 1);
      if (nested !== null) {
        if (nested !== line.text) {
          const shift = nested.length - line.text.length;
          field.setRangeText(nested, line.from, line.to, 'preserve');
          const at = Math.max(line.from, caret + shift);
          field.setSelectionRange(at, at);
          autosize();
        }
        return;
      }
      commit(horizontalMove(ref, cols, rows, event.shiftKey ? -1 : 1));
      return;
    }

    // Arrows leave the cell only from its first/last line, so a multi-line cell
    // still navigates its own text first.
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const caret = field.selectionStart ?? 0;
      if (caret !== (field.selectionEnd ?? caret)) return;
      const up = event.key === 'ArrowUp';
      const line = lineAround(field.value, caret);
      if (up ? line.from !== 0 : line.to !== field.value.length) return;
      const move = verticalMove(ref, rows, up ? -1 : 1);
      // Never grow the table by walking off its bottom edge — that is Tab's job.
      if (move.kind === 'newRow') return;
      event.preventDefault();
      event.stopPropagation();
      commit(move);
    }
  });

  field.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text/plain');
    if (text === undefined) return;
    event.preventDefault();
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    // A lone URL pasted over selected words links them instead of replacing
    // them (format.ts decides; it is the same rule the document uses).
    const url = start === end ? null : pastedUrl(text);
    const link = url ? linkOverSelectionEdit(field.value, start, end, url) : null;
    if (link) {
      const [change] = link.changes;
      field.setRangeText(change.insert, change.from, change.to, 'end');
      autosize();
      return;
    }
    field.setRangeText(sanitizeCellPaste(text), start, end, 'end');
    autosize();
  });

  // Only a real focus change commits from here. A blur that a teardown caused
  // has already been served by `rescueCellDraft`, which settled the editor, so
  // `commit` returns at its own guard — the `isConnected` test below is just
  // the cheap half of that and never was enough on its own: Blink drops focus
  // from `WillRemoveChild`, while the node is still in the document.
  field.addEventListener('blur', () => {
    if (field.isConnected) commit(null);
  });
}

/**
 * Re-open the cell a commit was heading for, or the first header cell of a
 * table that was just inserted. Runs synchronously when the element is already
 * in the document (the `updateDOM` path) so rapid Tab never drops a keystroke.
 */
/** The cell a commit is heading for, stamped on the wrapper by `commit`/a click — with the caret it should open at. */
function readPendingFocus(wrap: HTMLElement): { ref: CellRef; mode: FocusMode } | null {
  const { focusRow, focusCol, focusMode } = wrap.dataset;
  if (focusRow === undefined || focusCol === undefined) return null;
  const mode: FocusMode = focusMode !== undefined && focusMode !== 'all' ? Number(focusMode) : 'all';
  return { ref: { row: Number(focusRow), col: Number(focusCol) }, mode: Number.isFinite(mode) || mode === 'all' ? mode : 'all' };
}

function clearPendingFocus(wrap: HTMLElement): void {
  delete wrap.dataset.focusRow;
  delete wrap.dataset.focusCol;
  delete wrap.dataset.focusMode;
}

function applyPendingFocus(view: EditorView, wrap: HTMLElement): void {
  const pending = readPendingFocus(wrap);
  if (pending) {
    clearPendingFocus(wrap);
    openWhenReady(view, wrap, pending.ref, pending.mode);
    return;
  }

  if (!pendingInsert) return;
  if (Date.now() - pendingInsert.at > INSERT_FOCUS_WINDOW_MS) {
    pendingInsert = null;
    return;
  }
  const wanted = pendingInsert.from;
  // toDOM runs before the element is in the document, so the position check has
  // to wait until it is.
  requestAnimationFrame(() => {
    if (!pendingInsert || !wrap.isConnected) return;
    let at: number;
    try {
      at = view.posAtDOM(wrap);
    } catch {
      return;
    }
    if (at !== wanted) return;
    const focus = pendingInsert.focus;
    pendingInsert = null;
    const cell = findCell(wrap, focus);
    if (cell) beginEdit(view, wrap, cell, 'all');
  });
}

function openWhenReady(view: EditorView, wrap: HTMLElement, ref: CellRef, focus: FocusMode): void {
  const open = () => {
    const cell = findCell(wrap, ref);
    if (cell) beginEdit(view, wrap, cell, focus);
  };
  if (wrap.isConnected) open();
  else requestAnimationFrame(open);
}

/**
 * Open a specific cell of the table widget mounted at `tableFrom` — the entry
 * point block-nav.ts uses when Up/Down arrows straight into a table (see its
 * module doc). Unlike `requestTableFocus`, this widget is already mounted:
 * there is no fresh render to pick a pending focus up on, so the DOM has to be
 * found and opened directly, the same way a mouse click does. `wrap.dataset`
 * carries no id of its own, so every candidate is checked by `posAtDOM`
 * against the table's own document position — cheap, since a page rarely has
 * more than a handful of tables.
 *
 * Returns false when no mounted widget matches (should not normally happen:
 * the caller only gets here once `computeBlockSpecs` has already confirmed a
 * table sits at `tableFrom` in the current, live-mode document), so the
 * caller can fall back to a plain skip-over instead of doing nothing.
 */
export function openTableCellAt(view: EditorView, tableFrom: number, ref: CellRef): boolean {
  for (const wrap of view.dom.querySelectorAll<HTMLElement>('.cm-md-table-widget')) {
    let at: number;
    try {
      at = view.posAtDOM(wrap);
    } catch {
      continue;
    }
    if (at !== tableFrom) continue;
    const cell = findCell(wrap, ref);
    if (!cell) return false;
    beginEdit(view, wrap, cell, 'all');
    return true;
  }
  return false;
}
