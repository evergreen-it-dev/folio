/**
 * GFM table model: parse pipe rows into a grid, mutate it, serialise it back to
 * markdown. Entirely pure — the editable grid widget owns no state of its own,
 * it just reads the document, applies one of these transforms and writes the
 * whole table back as a single text edit.
 *
 * Round 17 gives the model a second layer: cells merged across columns (tight
 * `||`) and rows (`^^`), plus the `[//]: # (folio-table: …)` metadata line that
 * carries cell backgrounds and column widths. The *syntax* of both lives in
 * markdown/tableSyntax.ts, which the reading renderer shares verbatim; this
 * file only knows how to edit it. Both extras are optional on `GfmTable`:
 * absent means "an ordinary table", which is what a table without a metadata
 * line and without merges parses back to — so nothing downstream has to care.
 */

import {
  EMPTY_ATTRS,
  ROW_SPAN,
  cellKey as attrCellKey,
  cloneAttrs,
  computeLayout,
  fitRow,
  formatCellLines,
  formatTableAttrLine,
  hasAttrs,
  isDelimiterRow as isDelimiterCells,
  isRowSpan,
  isTableAttrLine,
  parseCellKey,
  parseTableAttrLine,
  splitPipeRow,
  unescapeTableCell,
  type BgToken,
  type CellBox,
  type CellLine as ListLine,
  type TableAttrs,
  type TableLayout,
} from '../markdown/tableSyntax';

export type { BgToken, CellBox, TableAttrs, TableLayout };
export { BG_TOKENS, ROW_SPAN, isRowSpan } from '../markdown/tableSyntax';

export type ColumnAlign = 'left' | 'center' | 'right' | null;

export interface GfmTable {
  header: string[];
  align: ColumnAlign[];
  rows: string[][];
  /**
   * Round 17, colspan layer: `spanLeft[r][c]` is true when that cell continues
   * the one to its left. Row 0 is the header, `r + 1` matches `rows[r]`.
   * Undefined when the table has no merged columns at all.
   */
  spanLeft?: boolean[][];
  /** Round 17: the metadata line's contents. Undefined when there is none. */
  attrs?: TableAttrs;
}

/** Row index used to address the header row in cell operations. */
export const HEADER_ROW = -1;

/** Grid row (header = 0) for a cell row (header = HEADER_ROW). */
const gridRow = (row: number): number => row + 1;

const ESCAPABLE = /[\\`*_~[\]()|]/;

export { unescapeTableCell as unescapeCell };

export function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Display-time unescaping: here `\*` really does mean a literal asterisk. */
function unescapeInline(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length && ESCAPABLE.test(text[i + 1])) {
      out += text[++i];
    } else {
      out += text[i];
    }
  }
  return out;
}

/**
 * Split one table line into trimmed, unescaped cells. Leading/trailing pipes are
 * optional in GFM; `\|` inside a cell is content, not a separator. The colspan
 * layer (which of those cells are tight continuations) comes from
 * `splitPipeRow` — see tableSyntax.ts.
 */
export function splitTableRow(line: string): string[] {
  return splitPipeRow(line).cells;
}

export function isDelimiterRow(cells: string[]): boolean {
  return isDelimiterCells(cells);
}

function alignOf(cell: string): ColumnAlign {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (left) return 'left';
  if (right) return 'right';
  return null;
}

const fit = fitRow;

/* ------------------------------------------------------------- span layer -- */

/** The colspan layer as a full matrix, header first. Never shared. */
export function spanMatrix(table: GfmTable): boolean[][] {
  const width = table.header.length;
  const source = table.spanLeft ?? [];
  const out: boolean[][] = [];
  for (let r = 0; r < table.rows.length + 1; r++) out.push(fit(source[r] ?? [], width, false));
  return normalizeSpans(out);
}

/** A continuation can never be the first column — that is not a cell at all. */
function normalizeSpans(spans: boolean[][]): boolean[][] {
  for (const row of spans) if (row.length > 0) row[0] = false;
  return spans;
}

function anySpan(spans: readonly (readonly boolean[])[]): boolean {
  return spans.some((row) => row.some(Boolean));
}

/** Cell texts as one matrix, header first — the shape `computeLayout` wants. */
export function cellMatrix(table: GfmTable): string[][] {
  const width = table.header.length;
  return [fit(table.header, width, ''), ...table.rows.map((row) => fit(row, width, ''))];
}

/** The HTML-shaped grid: which cell is drawn where, and how far it reaches. */
export function tableLayout(table: GfmTable): TableLayout {
  return computeLayout(cellMatrix(table), spanMatrix(table));
}

/** The box covering a cell — the cell itself when nothing is merged. */
export function boxAt(layout: TableLayout, row: number, col: number): CellBox | null {
  return layout.grid[gridRow(row)]?.[col] ?? null;
}

export function attrsOf(table: GfmTable): TableAttrs {
  return table.attrs ?? EMPTY_ATTRS;
}

/** Background token of one cell, or null. */
export function cellBg(table: GfmTable, row: number, col: number): BgToken | null {
  return attrsOf(table).bg[attrCellKey(row, col)] ?? null;
}

/** Column widths keyed by 0-based column, only where one is set. */
export function columnWidths(table: GfmTable): Map<number, string> {
  const out = new Map<number, string>();
  for (const [key, value] of Object.entries(attrsOf(table).width)) {
    const col = Number(key) - 1;
    if (col >= 0 && col < table.header.length) out.set(col, value);
  }
  return out;
}

/* ----------------------------------------------------------------- parse -- */

/**
 * Parse a whole table block, metadata line included. Returns null when the text
 * isn't a GFM table.
 *
 * Two placements of the metadata line are accepted: our own (above the table,
 * usually with a blank line between) and the DEV-PLAN's original one (directly
 * under the header delimiter). The second is read but never written — inside
 * the table body that line is a *row* to every GFM parser, so keeping it there
 * would break the iron compatibility rule. The next edit rewrites it in place.
 */
export function parseGfmTable(source: string): GfmTable | null {
  const raw = source.split('\n');
  let attrs: TableAttrs | null = null;

  let head = 0;
  while (head < raw.length) {
    const line = raw[head];
    if (line.trim() === '') {
      head++;
      continue;
    }
    const parsed = parseTableAttrLine(line);
    if (!parsed) break;
    attrs = mergeAttrs(attrs, parsed);
    head++;
  }

  const lines = raw.slice(head).filter((line) => line.trim() !== '');
  if (lines.length < 2) return null;

  const header = splitPipeRow(lines[0]);
  const delimiter = splitPipeRow(lines[1]);
  if (!isDelimiterCells(delimiter.cells)) return null;

  const width = Math.max(header.cells.length, delimiter.cells.length);
  const body: string[][] = [];
  const spans: boolean[][] = [fit(header.spanLeft, width, false)];

  for (const line of lines.slice(2)) {
    // Legacy placement: a metadata line sitting in the body. Read it, drop the
    // row — it is metadata, not data.
    const inline = parseTableAttrLine(line);
    if (inline && isTableAttrLine(line)) {
      attrs = mergeAttrs(attrs, inline);
      continue;
    }
    const row = splitPipeRow(line);
    body.push(fit(row.cells, width, ''));
    spans.push(fit(row.spanLeft, width, false));
  }

  const table: GfmTable = {
    header: fit(header.cells, width, ''),
    align: fit(delimiter.cells.map(alignOf), width, null),
    rows: body,
  };
  return finish(table, spans, attrs ?? EMPTY_ATTRS);
}

function mergeAttrs(base: TableAttrs | null, next: TableAttrs): TableAttrs {
  if (!base) return next;
  return {
    bg: { ...base.bg, ...next.bg },
    width: { ...base.width, ...next.width },
    ...(next.layout ?? base.layout ? { layout: next.layout ?? base.layout } : {}),
  };
}

/** Attach the two optional layers, dropping them when they say nothing. */
function finish(table: GfmTable, spans: boolean[][], attrs: TableAttrs): GfmTable {
  const normalised = normalizeSpans(spans);
  if (anySpan(normalised)) table.spanLeft = normalised;
  else delete table.spanLeft;
  if (hasAttrs(attrs)) table.attrs = attrs;
  else delete table.attrs;
  return table;
}

/* ------------------------------------------------------------- serialize -- */

function delimiterCell(align: ColumnAlign, width: number): string {
  const size = Math.max(3, width);
  switch (align) {
    case 'left':
      return `:${'-'.repeat(size - 1)}`;
    case 'right':
      return `${'-'.repeat(size - 1)}:`;
    case 'center':
      return `:${'-'.repeat(size - 2)}:`;
    default:
      return '-'.repeat(size);
  }
}

/**
 * Render the grid back to markdown, padded so the raw source stays readable.
 *
 * A merged cell is written the MultiMarkdown way — the continuation columns
 * become *tight* pipes (`| Header |||`), which is what distinguishes a span
 * from a genuinely empty cell. The metadata line, when there is one, goes above
 * the table with a blank line after it: the one placement every GFM parser
 * treats as an invisible link reference definition (see tableSyntax.ts).
 */
export function serializeGfmTable(table: GfmTable): string {
  const width = table.header.length;
  const spans = spanMatrix(table);
  const escapedHeader = table.header.map(escapeCell);
  const escapedRows = table.rows.map((row) => fit(row, width, '').map(escapeCell));

  const widths: number[] = [];
  for (let col = 0; col < width; col++) {
    // A cell that reaches across columns must not stretch the one it starts in.
    const spanning = (row: number) => col + 1 < width && spans[row][col + 1];
    let max = spanning(0) ? 3 : Math.max(3, escapedHeader[col]?.length ?? 0);
    escapedRows.forEach((row, index) => {
      if (spans[index + 1][col] || spanning(index + 1)) return;
      max = Math.max(max, row[col].length);
    });
    widths.push(max);
  }

  const line = (cells: string[], spanRow: boolean[]) => {
    let out = '|';
    for (let col = 0; col < width; col++) {
      if (spanRow[col]) {
        out += '|';
        continue;
      }
      out += ` ${cells[col].padEnd(widths[col])} |`;
    }
    return out;
  };

  const none = new Array<boolean>(width).fill(false);
  const body = [
    line(escapedHeader, spans[0]),
    line(
      table.align.map((align, col) => delimiterCell(align, widths[col])),
      none,
    ),
    ...escapedRows.map((row, index) => line(row, spans[index + 1])),
  ].join('\n');

  const attrLine = formatTableAttrLine(attrsOf(table));
  return attrLine ? `${attrLine}\n\n${body}` : body;
}

/* ------------------------------------------------------------------ edits -- */

const clone = (table: GfmTable): GfmTable => {
  const next: GfmTable = {
    header: [...table.header],
    align: [...table.align],
    rows: table.rows.map((row) => [...row]),
  };
  if (table.spanLeft) next.spanLeft = table.spanLeft.map((row) => [...row]);
  if (table.attrs) next.attrs = cloneAttrs(table.attrs);
  return next;
};

/** Rewrite the metadata line's row/column references after a structural edit. */
function remapAttrs(
  attrs: TableAttrs,
  mapRow: (row: number) => number | null,
  mapCol: (col: number) => number | null,
): TableAttrs {
  const next: TableAttrs = { bg: {}, width: {} };
  if (attrs.layout) next.layout = attrs.layout;
  for (const [key, token] of Object.entries(attrs.bg)) {
    const ref = parseCellKey(key);
    if (!ref) continue;
    const row = mapRow(ref.row);
    const col = mapCol(ref.col);
    if (row === null || col === null) continue;
    next.bg[attrCellKey(row, col)] = token;
  }
  for (const [key, value] of Object.entries(attrs.width)) {
    const col = mapCol(Number(key) - 1);
    if (col === null) continue;
    next.width[col + 1] = value;
  }
  return next;
}

const same = (n: number): number => n;

const PERCENT_WIDTH = /^(\d+(?:\.\d+)?)%$/;

/** A percentage the metadata line will accept back (`validWidth`: 1…100). */
const clampPercent = (value: number): number => Math.min(100, Math.max(1, Math.round(value)));

/**
 * Keep a column-width map covering EVERY column after an insert.
 *
 * The widths are percentages of the table's width, so a map that names every
 * column except the new one hands the newcomer whatever is left of 100% —
 * nothing. The column is in the file and in the grid, and invisible: from the
 * author's chair that is indistinguishable from the `+` having done nothing at
 * all. The fresh column takes an even share and the rest are rescaled, which
 * keeps their proportions to each other and the map complete (a half-specified
 * map is what round 17 set out to stop writing in the first place).
 *
 * `at` is the new column's 0-based index; `count` the width AFTER the insert.
 * A map that never covered the whole table is left alone — it was not a layout
 * and inventing one from it would be guessing.
 */
function widenWidths(attrs: TableAttrs, at: number, count: number): void {
  const others: number[] = [];
  for (let col = 1; col <= count; col++) {
    if (col === at + 1) continue;
    if (attrs.width[col] === undefined) return;
    others.push(col);
  }
  if (others.length === 0) return;

  const percents = others.map((col) => PERCENT_WIDTH.exec(attrs.width[col])?.[1]);
  if (percents.some((value) => value === undefined)) {
    // `px` (or a mix): nothing has to add up to anything, so the newcomer just
    // matches the column it was inserted beside.
    attrs.width[at + 1] = attrs.width[at === 0 ? 2 : at];
    return;
  }

  const share = 100 / count;
  const total = percents.reduce((sum, value) => sum + Number(value), 0) || 100;
  const scale = (100 - share) / total;
  others.forEach((col, index) => {
    attrs.width[col] = `${clampPercent(Number(percents[index]) * scale)}%`;
  });
  attrs.width[at + 1] = `${clampPercent(share)}%`;
}

function rewrite(
  table: GfmTable,
  build: (draft: {
    header: string[];
    align: ColumnAlign[];
    rows: string[][];
    spans: boolean[][];
    attrs: TableAttrs;
  }) => void,
): GfmTable {
  const next = clone(table);
  const draft = {
    header: next.header,
    align: next.align,
    rows: next.rows,
    spans: spanMatrix(table),
    attrs: cloneAttrs(attrsOf(table)),
  };
  build(draft);
  next.header = draft.header;
  next.align = draft.align;
  next.rows = draft.rows;
  return finish(next, draft.spans, draft.attrs);
}

/** `row === HEADER_ROW` addresses the header. Out-of-range writes are ignored. */
export function setCell(table: GfmTable, row: number, col: number, value: string): GfmTable {
  if (col < 0 || col >= table.header.length) return table;
  if (row !== HEADER_ROW && (row < 0 || row >= table.rows.length)) return table;
  return rewrite(table, (draft) => {
    if (row === HEADER_ROW) draft.header[col] = value;
    else draft.rows[row][col] = value;
    // Typing into a continuation cell makes it a cell again.
    if (value !== '') draft.spans[gridRow(row)][col] = false;
  });
}

export function insertRow(table: GfmTable, afterRow: number): GfmTable {
  const at = Math.min(Math.max(afterRow + 1, 0), table.rows.length);
  return rewrite(table, (draft) => {
    draft.rows.splice(at, 0, new Array<string>(draft.header.length).fill(''));
    // A row landing inside a vertical merge extends it; anywhere else it is a
    // plain new row (which is also what an empty span row means).
    draft.spans.splice(gridRow(at), 0, new Array<boolean>(draft.header.length).fill(false));
    draft.attrs = remapAttrs(draft.attrs, (row) => (row >= at ? row + 1 : row), same);
  });
}

export function insertColumn(table: GfmTable, afterCol: number): GfmTable {
  const at = Math.min(Math.max(afterCol + 1, 0), table.header.length);
  return rewrite(table, (draft) => {
    draft.header.splice(at, 0, '');
    draft.align.splice(at, 0, null);
    for (const row of draft.rows) row.splice(at, 0, '');
    for (const row of draft.spans) {
      // Inserting inside a horizontal merge widens it instead of splitting it.
      row.splice(at, 0, at < row.length ? row[at] : false);
    }
    draft.attrs = remapAttrs(draft.attrs, same, (col) => (col >= at ? col + 1 : col));
    widenWidths(draft.attrs, at, draft.header.length);
  });
}

export function deleteRow(table: GfmTable, row: number): GfmTable {
  if (row < 0 || row >= table.rows.length) return table;
  return rewrite(table, (draft) => {
    const below = draft.rows[row + 1];
    // A `^^` under the row being removed would silently re-merge with whatever
    // ends up above it; hand it the departing row's text instead.
    if (below) {
      below.forEach((cell, col) => {
        if (isRowSpan(cell)) below[col] = draft.rows[row][col];
      });
    }
    draft.rows.splice(row, 1);
    draft.spans.splice(gridRow(row), 1);
    draft.attrs = remapAttrs(
      draft.attrs,
      (at) => (at === row ? null : at > row ? at - 1 : at),
      same,
    );
  });
}

/** The last column can't be removed — a table needs at least one. */
export function deleteColumn(table: GfmTable, col: number): GfmTable {
  if (col < 0 || col >= table.header.length || table.header.length <= 1) return table;
  return rewrite(table, (draft) => {
    draft.header.splice(col, 1);
    draft.align.splice(col, 1);
    for (const row of draft.rows) row.splice(col, 1);
    for (const row of draft.spans) {
      // Removing the cell a span starts at promotes its first continuation.
      if (!row[col] && row[col + 1]) row[col + 1] = false;
      row.splice(col, 1);
    }
    draft.attrs = remapAttrs(draft.attrs, same, (at) =>
      at === col ? null : at > col ? at - 1 : at,
    );
  });
}

const ALIGN_CYCLE: ColumnAlign[] = [null, 'left', 'center', 'right'];

export function cycleAlign(table: GfmTable, col: number): GfmTable {
  if (col < 0 || col >= table.align.length) return table;
  const next = clone(table);
  const at = ALIGN_CYCLE.indexOf(next.align[col]);
  next.align[col] = ALIGN_CYCLE[(at + 1) % ALIGN_CYCLE.length];
  return next;
}

/** Set one column's alignment outright — what the column handle's menu does. */
export function setAlign(table: GfmTable, col: number, align: ColumnAlign): GfmTable {
  if (col < 0 || col >= table.align.length || table.align[col] === align) return table;
  const next = clone(table);
  next.align[col] = align;
  return next;
}

function permutation(width: number, from: number, to: number): number[] {
  const order = Array.from({ length: width }, (_, i) => i);
  order.splice(to, 0, ...order.splice(from, 1));
  // order[newIndex] = oldIndex — invert it into oldIndex -> newIndex.
  const map = new Array<number>(width);
  order.forEach((old, index) => (map[old] = index));
  return map;
}

/**
 * Move a whole column (header cell, alignment and every body cell) to another
 * index — the write behind dragging a column handle. `to` is the index the
 * column ends up at *after* it has been lifted out, which is what a drop
 * target between two columns means.
 */
export function moveColumn(table: GfmTable, from: number, to: number): GfmTable {
  const width = table.header.length;
  if (from < 0 || from >= width) return table;
  const target = Math.min(Math.max(to, 0), width - 1);
  if (target === from) return table;

  return rewrite(table, (draft) => {
    const move = <T,>(values: T[]) => values.splice(target, 0, ...values.splice(from, 1));
    move(draft.header);
    move(draft.align);
    for (const row of draft.rows) move(row);
    for (const row of draft.spans) move(row);
    const map = permutation(width, from, target);
    draft.attrs = remapAttrs(draft.attrs, same, (col) => map[col] ?? col);
  });
}

/**
 * Move a row the same way — used by the row handle's menu, where "move up" is
 * the one structural edit the pipe syntax cannot express by itself.
 */
export function moveRow(table: GfmTable, from: number, to: number): GfmTable {
  if (from < 0 || from >= table.rows.length) return table;
  const target = Math.min(Math.max(to, 0), table.rows.length - 1);
  if (target === from) return table;
  return rewrite(table, (draft) => {
    draft.rows.splice(target, 0, ...draft.rows.splice(from, 1));
    draft.spans.splice(gridRow(target), 0, ...draft.spans.splice(gridRow(from), 1));
    const map = permutation(table.rows.length, from, target);
    draft.attrs = remapAttrs(draft.attrs, (row) => (row === HEADER_ROW ? row : map[row] ?? row), same);
  });
}

/* ------------------------------------------------------------ merge layer -- */

/** A rectangle of cells, in the same coordinates the widget uses. */
export interface CellRange {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export function normalizeRange(a: { row: number; col: number }, b: { row: number; col: number }): CellRange {
  return {
    top: Math.min(a.row, b.row),
    bottom: Math.max(a.row, b.row),
    left: Math.min(a.col, b.col),
    right: Math.max(a.col, b.col),
  };
}

/**
 * Grow a range until it holds whole cells: a selection that clips a merged cell
 * in half has to swallow it, or the merge it writes could not be rectangular.
 */
export function expandRange(table: GfmTable, range: CellRange): CellRange {
  const layout = tableLayout(table);
  const out = { ...range };
  for (let pass = 0; pass < 4; pass++) {
    let grew = false;
    for (let row = out.top; row <= out.bottom; row++) {
      for (let col = out.left; col <= out.right; col++) {
        const box = boxAt(layout, row, col);
        if (!box) continue;
        const top = box.row - 1;
        const bottom = box.row + box.rowSpan - 2;
        if (top < out.top) (out.top = top), (grew = true);
        if (bottom > out.bottom) (out.bottom = bottom), (grew = true);
        if (box.col < out.left) (out.left = box.col), (grew = true);
        if (box.col + box.colSpan - 1 > out.right) (out.right = box.col + box.colSpan - 1), (grew = true);
      }
    }
    if (!grew) break;
  }
  return out;
}

/** A range worth merging: more than one cell, and inside the table. */
export function canMerge(table: GfmTable, range: CellRange): boolean {
  const clamped = clampRange(table, range);
  if (!clamped) return false;
  return clamped.bottom > clamped.top || clamped.right > clamped.left;
}

/** Trim a range to the table. Nothing else — the header is a cell like any other. */
function clampCells(table: GfmTable, range: CellRange): CellRange | null {
  const out = {
    top: Math.max(Math.min(range.top, range.bottom), HEADER_ROW),
    bottom: Math.min(Math.max(range.top, range.bottom), table.rows.length - 1),
    left: Math.max(Math.min(range.left, range.right), 0),
    right: Math.min(Math.max(range.left, range.right), table.header.length - 1),
  };
  if (out.bottom < out.top || out.right < out.left) return null;
  return out;
}

function clampRange(table: GfmTable, range: CellRange): CellRange | null {
  const out = clampCells(table, range);
  if (!out) return null;
  // A merge may never straddle the header: `<thead>`/`<tbody>` are separate
  // sections and a rowspan across them has no HTML form. A range covering both
  // keeps the body — which is what "merge this column" is asking for anyway.
  if (out.top === HEADER_ROW && out.bottom > HEADER_ROW) out.top = 0;
  return out;
}

/**
 * Merge a rectangle into one cell: the continuation columns become tight pipes,
 * the rows below the top one become `^^`. Text is never thrown away — every
 * non-empty cell in the rectangle is folded into the surviving one as its own
 * line (`<br>`, the same multi-line cell form round 21 introduced).
 */
export function mergeRange(table: GfmTable, range: CellRange): GfmTable {
  const clamped = clampRange(table, expandRange(table, range));
  if (!clamped || (clamped.top === clamped.bottom && clamped.left === clamped.right)) return table;

  const cells = cellMatrix(table);
  const spans = spanMatrix(table);
  const texts: string[] = [];
  for (let row = clamped.top; row <= clamped.bottom; row++) {
    for (let col = clamped.left; col <= clamped.right; col++) {
      const text = cells[gridRow(row)][col];
      if (spans[gridRow(row)][col] || isRowSpan(text) || text.trim() === '') continue;
      texts.push(text);
    }
  }

  return rewrite(table, (draft) => {
    const write = (row: number, col: number, value: string) => {
      if (row === HEADER_ROW) draft.header[col] = value;
      else draft.rows[row][col] = value;
    };
    for (let row = clamped.top; row <= clamped.bottom; row++) {
      for (let col = clamped.left; col <= clamped.right; col++) {
        const continuation = col > clamped.left;
        draft.spans[gridRow(row)][col] = continuation;
        if (continuation) write(row, col, '');
        else if (row > clamped.top) write(row, col, ROW_SPAN);
        else write(row, col, texts.join('<br>'));
        // A background on a cell that no longer exists would resurface the
        // moment the merge is undone somewhere else; drop all but the anchor's.
        if (row !== clamped.top || col !== clamped.left) {
          delete draft.attrs.bg[attrCellKey(row, col)];
        }
      }
    }
  });
}

/** Undo the merge covering a cell. Cells come back empty, the text stays put. */
export function unmergeAt(table: GfmTable, row: number, col: number): GfmTable {
  const layout = tableLayout(table);
  const box = boxAt(layout, row, col);
  if (!box || (box.rowSpan === 1 && box.colSpan === 1)) return table;

  return rewrite(table, (draft) => {
    for (let r = box.row; r < box.row + box.rowSpan; r++) {
      for (let c = box.col; c < box.col + box.colSpan; c++) {
        draft.spans[r][c] = false;
        const at = r - 1;
        const text = at === HEADER_ROW ? draft.header[c] : draft.rows[at][c];
        if (isRowSpan(text)) {
          if (at === HEADER_ROW) draft.header[c] = '';
          else draft.rows[at][c] = '';
        }
      }
    }
  });
}

/** True when any cell of the range sits inside a merged box. */
export function canUnmerge(table: GfmTable, range: CellRange): boolean {
  const clamped = clampRange(table, range);
  if (!clamped) return false;
  const layout = tableLayout(table);
  for (let row = clamped.top; row <= clamped.bottom; row++) {
    for (let col = clamped.left; col <= clamped.right; col++) {
      const box = boxAt(layout, row, col);
      if (box && (box.rowSpan > 1 || box.colSpan > 1)) return true;
    }
  }
  return false;
}

/** Unmerge every merged box the range touches. */
export function unmergeRange(table: GfmTable, range: CellRange): GfmTable {
  const clamped = clampRange(table, range);
  if (!clamped) return table;
  let next = table;
  for (let row = clamped.top; row <= clamped.bottom; row++) {
    for (let col = clamped.left; col <= clamped.right; col++) {
      next = unmergeAt(next, row, col);
    }
  }
  return next;
}

/* --------------------------------------------------------------- metadata -- */

/**
 * Paint (or clear, with `null`) the background of every cell in a range. Unlike
 * a merge this may cover the header — painting a whole column is exactly the
 * case the round exists for.
 */
export function setRangeBackground(table: GfmTable, range: CellRange, token: BgToken | null): GfmTable {
  const clamped = clampCells(table, range);
  if (!clamped) return table;
  const layout = tableLayout(table);
  return rewrite(table, (draft) => {
    for (let row = clamped.top; row <= clamped.bottom; row++) {
      for (let col = clamped.left; col <= clamped.right; col++) {
        // Only the drawn cell can carry a colour; a covered position has no
        // element of its own in either renderer.
        const box = boxAt(layout, row, col);
        if (box && (box.row !== gridRow(row) || box.col !== col)) continue;
        const key = attrCellKey(row, col);
        if (token) draft.attrs.bg[key] = token;
        else delete draft.attrs.bg[key];
      }
    }
  });
}

/** Replace the whole width map — what a border drag commits. */
export function setColumnWidths(table: GfmTable, widths: ReadonlyMap<number, string> | null): GfmTable {
  return rewrite(table, (draft) => {
    draft.attrs.width = {};
    if (!widths) return;
    for (const [col, value] of widths) {
      if (col >= 0 && col < draft.header.length) draft.attrs.width[col + 1] = value;
    }
  });
}

/* ------------------------------------------------------------ cell lines -- */

/*
 * A GFM cell is one line of markdown, full stop: a literal newline inside it
 * would end the row. Round 21 gives cells several visual lines anyway, the way
 * every wiki does it — with `<br>`, which GFM passes through as inline HTML and
 * GitHub/GitLab render as a break. So the file keeps holding one pipe row per
 * table row, while the grid shows (and edits) a small block of text.
 *
 * `raw` below always means the markdown form (`<br>`-joined); `text` means the
 * form the cell's textarea works with (`\n`-joined).
 */

const CELL_BREAK = /<br\s*\/?>/gi;

export function splitCellLines(raw: string): string[] {
  return raw.split(CELL_BREAK);
}

export function joinCellLines(lines: readonly string[]): string {
  return lines.join('<br>');
}

/** Markdown cell -> editable text. */
export function cellRawToText(raw: string): string {
  return splitCellLines(raw).join('\n');
}

/**
 * Editable text -> markdown cell. Blank edge lines are dropped so a stray
 * trailing Enter doesn't leave a `<br>` hanging at the end of the cell.
 *
 * Leading whitespace survives on every line but the first, because that is
 * where a nested list item's indent lives (round 17). The first line cannot
 * carry one anyway: GFM trims the cell itself.
 *
 * Round 28: this is the ONE funnel from the cell editor back to the file (the
 * commit and the draft rescue both go through it), so it is also where a list
 * line is put into the normative shape — `formatCellLines`, straight out of
 * tableSyntax.ts, so the grid writes exactly what the reading renderer reads.
 * That means the ASCII markers a person types (`- `, `* `, `+ `) and a hand-made
 * three-space indent are stored as the round-28 form (`• `, two spaces a level).
 * A line that is not a list item is handed over untouched, which is what keeps
 * a cell of ordinary prose byte-identical after being opened and closed.
 */
export function cellTextToRaw(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 1 && lines[0].trim() === '') lines.shift();
  while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop();
  return formatCellLines(
    lines.map((line, index) => toListLine(index === 0 ? line.trim() : line.trimEnd())),
  );
}

/**
 * One editable line as tableSyntax's normative `CellLine`. The three item kinds
 * line up one to one (round 28 took the checklist into the contract, so it is no
 * longer ours alone); anything else is a paragraph line and is handed over
 * verbatim — `formatCellLines` writes a marker-less line's text untouched, which
 * is what keeps a cell of prose byte-identical through an edit that never
 * touched it.
 */
function toListLine(line: string): ListLine {
  const parsed = parseCellLine(line);
  const shared = { depth: parsed.indent + 1, markerWidth: parsed.marker.length, text: parsed.text };
  if (parsed.kind === 'bullet') return { ...shared, marker: 'ul' };
  if (parsed.kind === 'task') return { ...shared, marker: 'task', checked: parsed.checked };
  if (parsed.kind === 'ordered') {
    // The ordinal is what the file says; `formatCellLines` renumbers each run
    // itself, so this only has to be honest, not right.
    return { ...shared, marker: 'ol', ordinal: Number.parseInt(parsed.marker.trimStart(), 10) || 1 };
  }
  return { depth: 0, marker: null, markerWidth: 0, text: line };
}

/** The little structures a cell line can carry — see `parseCellLine`. */
export type CellLineKind = 'text' | 'bullet' | 'task' | 'ordered' | 'heading1' | 'heading2' | 'heading3';

export interface CellLine {
  kind: CellLineKind;
  /** The line without its marker. */
  text: string;
  /** Literal marker, indent included: `  • `, `[x] `, `3. ` — empty for text. */
  marker: string;
  /** Nesting level of a list line, 0 for the outermost. */
  indent: number;
  /** Only meaningful for `task`. */
  checked: boolean;
}

/** The bullet the mini-slash writes. A real character, so the file reads well. */
export const BULLET = '• ';
export const TASK_OPEN = '[ ] ';
export const TASK_DONE = '[x] ';

/**
 * One nesting step inside a cell. Two spaces, which is what every markdown
 * list uses — and which github shows as a plain (collapsed) space, so a nested
 * cell list degrades to a flat one there rather than to noise.
 */
export const INDENT_UNIT = '  ';
/** Deepest nesting Tab may *create*: three levels in all. Reading is not capped — see `indentOf`. */
export const MAX_INDENT = 2;

/**
 * Round 28 widens the bullet vocabulary to the one tableSyntax.ts accepts on
 * reading (`- * + • ◦`, plus our own legacy `·`): a Confluence import and a
 * person typing `- ` into a cell now produce a list here, not a line of text
 * with a dash in front of it. Only the *written* marker stays single — `• `,
 * which `formatCellLines` puts back on commit.
 */
const BULLET_LINE = /^([ \t]*[-*+•·◦][ \t]+)(.*)$/;
const TASK_LINE = /^([ \t]*\[([ xX])\][ \t]+)(.*)$/;
const ORDERED_LINE = /^([ \t]*(\d+)[.)][ \t]+)(.*)$/;
const HEADING_LINE = /^(#{1,3})[ \t]+(.*)$/;
const LEADING = /^[ \t]*/;

/**
 * Indent level of a marker, counted in `INDENT_UNIT`s. NOT clamped: an imported
 * list may be deeper than the three levels Tab will build, and clamping here
 * would flatten it the moment its cell is opened and committed — `cellTextToRaw`
 * writes the level this returns.
 */
function indentOf(marker: string): number {
  const lead = (LEADING.exec(marker)?.[0] ?? '').replace(/\t/g, INDENT_UNIT);
  return Math.floor(lead.length / INDENT_UNIT.length);
}

/**
 * Read one cell line's structure. Nothing here is folio-specific syntax: a
 * bullet is a bullet character, a checklist item is GFM's own `[ ]`/`[x]` and a
 * numbered item is `1.` — all of which stay readable as plain text anywhere the
 * file is opened without this editor. Leading spaces nest the item (round 17).
 */
export function parseCellLine(line: string): CellLine {
  const heading = HEADING_LINE.exec(line);
  if (heading) {
    return {
      kind: `heading${heading[1].length}` as 'heading1' | 'heading2' | 'heading3',
      marker: `${heading[1]} `,
      text: heading[2],
      indent: 0,
      checked: false,
    };
  }
  const task = TASK_LINE.exec(line);
  if (task) {
    return {
      kind: 'task',
      marker: task[1],
      text: task[3],
      indent: indentOf(task[1]),
      checked: task[2] !== ' ',
    };
  }
  const bullet = BULLET_LINE.exec(line);
  if (bullet) {
    return { kind: 'bullet', marker: bullet[1], text: bullet[2], indent: indentOf(bullet[1]), checked: false };
  }
  const ordered = ORDERED_LINE.exec(line);
  if (ordered) {
    return { kind: 'ordered', marker: ordered[1], text: ordered[3], indent: indentOf(ordered[1]), checked: false };
  }
  return { kind: 'text', marker: '', text: line, indent: 0, checked: false };
}

/**
 * Indent or outdent one list line, for Tab / Shift+Tab inside a cell. Returns
 * null when the line is not a list item — Tab then does what it always did and
 * moves to the next cell.
 *
 * The ceiling only binds what Tab *adds*: a line that already sits deeper (a
 * Confluence list can) is left where it is rather than yanked back to three,
 * because Tab pulling an item two levels *out* is the opposite of what it says.
 */
export function shiftCellIndent(line: string, delta: number): string | null {
  const parsed = parseCellLine(line);
  if (parsed.kind === 'text' || parsed.kind.startsWith('heading')) return null;
  const ceiling = Math.max(MAX_INDENT, parsed.indent);
  const level = Math.max(0, Math.min(ceiling, parsed.indent + delta));
  if (level === parsed.indent) return line;
  return INDENT_UNIT.repeat(level) + parsed.marker.replace(LEADING, '') + parsed.text;
}

export function parseCellLines(raw: string): CellLine[] {
  return splitCellLines(raw).map(parseCellLine);
}

/**
 * Flip the checkbox on one line of a cell, addressed by its line index. Returns
 * the cell unchanged when that line is not a checklist item, so the widget can
 * never write something the markdown doesn't already say.
 */
export function toggleCellTask(raw: string, index: number): string {
  const lines = splitCellLines(raw);
  const line = lines[index];
  if (line === undefined) return raw;
  const parsed = parseCellLine(line);
  if (parsed.kind !== 'task') return raw;
  const indent = LEADING.exec(parsed.marker)?.[0] ?? '';
  lines[index] = indent + (parsed.checked ? TASK_OPEN : TASK_DONE) + parsed.text;
  return joinCellLines(lines);
}

/**
 * What Enter should put at the start of the next line to continue the list the
 * caret is on. Null when the line carries no marker; the empty string when the
 * item is empty, which is the signal to clear the marker instead of adding one.
 */
export function listContinuation(line: string): string | null {
  const parsed = parseCellLine(line);
  if (parsed.kind === 'text' || parsed.kind.startsWith('heading')) return null;
  if (parsed.text.trim() === '') return '';
  const indent = LEADING.exec(parsed.marker)?.[0] ?? '';
  if (parsed.kind === 'bullet') return indent + BULLET;
  if (parsed.kind === 'task') return indent + TASK_OPEN;
  const n = Number.parseInt(parsed.marker.trimStart(), 10);
  return `${indent}${Number.isFinite(n) ? n + 1 : 1}. `;
}

/* --------------------------------------------------------- inline render -- */

export type InlineTokenType =
  | 'text'
  | 'code'
  | 'strong'
  | 'em'
  | 'del'
  | 'link'
  /** `<ins>` — underline, which markdown has no syntax for (see format.ts). */
  | 'ins'
  /** `<mark>` — highlight, likewise. */
  | 'mark';

export type InlineToken = {
  type: InlineTokenType;
  text: string;
  /** Link destination; present only for `link` tokens. */
  target?: string;
  /** Highlight palette token from `==text=={.token}`; `mark` tokens only. */
  color?: string;
};

/** An inline token plus the raw-text range it came from. */
export interface InlineSpan extends InlineToken {
  from: number;
  to: number;
}

const INLINE_RULES: { re: RegExp; type: InlineToken['type'] }[] = [
  { re: /`([^`]+)`/y, type: 'code' },
  // A bare address is a link too (the owner, 17.09: pasted a URL into a cell —
  // it was not highlighted). It stands BEFORE em/strong: otherwise a `*` or `_`
  // inside the address would be eaten by the italics rule. Trailing punctuation
  // is not part of the link — "see https://example.com." must not pull the
  // period into the href.
  { re: /(https?:\/\/[^\s<>()\[\]«»"']+[^\s<>()\[\]«»"'.,;:!?])/y, type: 'link' },
  { re: /\*\*([^*]+?)\*\*/y, type: 'strong' },
  { re: /__([^_]+?)__/y, type: 'strong' },
  { re: /~~([^~]+?)~~/y, type: 'del' },
  { re: /\*([^*]+?)\*/y, type: 'em' },
  { re: /_([^_]+?)_/y, type: 'em' },
  { re: /\[([^\]]*?)\]\(([^)]*)\)/y, type: 'link' },
  // The formatting toolbar's two HTML formats. Written by us, and shown as the
  // format rather than as tags — otherwise underlining a cell would leave
  // `<ins>` sitting there in the grid.
  { re: /<ins>([^<]*)<\/ins>/iy, type: 'ins' },
  { re: /<u>([^<]*)<\/u>/iy, type: 'ins' },
  // `==text==` / `==text=={.green}` — what the toolbar writes for highlight
  // now (format.ts); the `<mark>` form below is read for older pages only.
  { re: /==([^=\n]+?)==(?:\{\.([a-z]+)\})?/y, type: 'mark' },
  { re: /<mark>([^<]*)<\/mark>/iy, type: 'mark' },
];

/**
 * Very small inline-markdown tokenizer used to *display* table cells. Editing
 * always happens on the raw cell text, so this never has to round-trip.
 */
export function parseInlineSpans(text: string): InlineSpan[] {
  const out: InlineSpan[] = [];
  let buffer = '';
  let bufferFrom = 0;
  let i = 0;

  const flush = (end: number) => {
    if (buffer) out.push({ type: 'text', text: buffer, from: bufferFrom, to: end });
    buffer = '';
  };

  while (i < text.length) {
    if (!buffer) bufferFrom = i;
    if (text[i] === '\\' && i + 1 < text.length && ESCAPABLE.test(text[i + 1])) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }
    let matched = false;
    for (const rule of INLINE_RULES) {
      rule.re.lastIndex = i;
      const m = rule.re.exec(text);
      if (!m) continue;
      flush(i);
      out.push({
        type: rule.type,
        text: unescapeInline(m[1]),
        from: i,
        to: i + m[0].length,
        // For a markdown link the address is in m[2]; for a bare one — the text of the match itself.
        ...(rule.type === 'link' ? { target: m[2] ?? m[1] ?? '' } : {}),
        ...(rule.type === 'mark' && m[2] ? { color: m[2] } : {}),
      });
      i += m[0].length;
      matched = true;
      break;
    }
    if (matched) continue;
    buffer += text[i];
    i++;
  }

  flush(i);
  return out;
}

export function parseInline(text: string): InlineToken[] {
  return parseInlineSpans(text).map(({ type, text: value, color }) => ({ type, text: value, ...(color ? { color } : {}) }));
}

/**
 * Where a click in the *rendered* cell lands in the *raw* cell text. Markers
 * (`**`, backticks, link targets) are invisible in the grid but present in the
 * source, so a caret offset has to be translated across them.
 */
export function displayToRawOffset(raw: string, displayOffset: number): number {
  if (displayOffset <= 0) return 0;
  let seen = 0;
  for (const span of parseInlineSpans(raw)) {
    const length = span.text.length;
    if (displayOffset <= seen + length) {
      const inner = displayOffset - seen;
      const chunk = raw.slice(span.from, span.to);
      const start = chunk.indexOf(span.text);
      const base = span.from + (start < 0 ? 0 : start);
      return Math.min(base + inner, span.to);
    }
    seen += length;
  }
  return raw.length;
}

/* --------------------------------------------------------- link caret trap -- */
/*
 * A cell's markup is hidden the same way the top-level document's live mode
 * hides it (see `../editor/link-guard.ts`): `[label](url)` shows only
 * `label`, so a caret sitting right at the label's edge is a legal position
 * that LOOKS exactly like the end/start of the whole link. `insertBreak` and
 * the Backspace/Delete handling in table-widget.ts read raw caret offsets
 * straight off the DOM (`rawOffsetAtDom`) and used to split or delete right
 * there, tearing `[label](url)` apart. These three helpers are the raw-text
 * equivalent of link-guard.ts's guard — same shape, same trap, but no syntax
 * tree in common to hang one shared lookup off of, only the actual "which
 * edge is nearer" arithmetic (`nearestLinkEdge`), which both files import.
 */

/** The raw span of a link, and where its visible label sits inside it. */
interface LinkSpanBounds {
  outerFrom: number;
  outerTo: number;
  labelFrom: number;
  labelTo: number;
}

/**
 * The 'link' inline span covering or touching `pos`, if any — real
 * `[label](url)` markup only. A bare autolinked URL (the `INLINE_RULES` entry
 * above) has nothing hidden, raw and visible text are identical, so there is
 * no markup for it to corrupt and it is left out here.
 */
function linkSpanNear(text: string, pos: number): LinkSpanBounds | null {
  for (const span of parseInlineSpans(text)) {
    if (span.type !== 'link') continue;
    if (pos < span.from || pos > span.to) continue;
    if (span.to - span.from === span.text.length) continue; // bare URL
    const chunk = text.slice(span.from, span.to);
    const start = chunk.indexOf(span.text);
    const labelFrom = span.from + (start < 0 ? 0 : start);
    return { outerFrom: span.from, outerTo: span.to, labelFrom, labelTo: labelFrom + span.text.length };
  }
  return null;
}

/**
 * Where a split at `pos`, strictly inside `[outerFrom, outerTo)`, should
 * actually land: whichever end of the visible label (`[labelFrom, labelTo)`)
 * is nearer. Measured against the label rather than the outer span because
 * the destination is normally far longer than the label — a raw-span
 * tie-break would almost always (wrongly) push backward, before the link,
 * even for a caret sitting right at the label's own tail end.
 */
export function nearestLinkEdge(pos: number, labelFrom: number, labelTo: number, outerFrom: number, outerTo: number): number {
  return pos - labelFrom <= labelTo - pos ? outerFrom : outerTo;
}

/** `enterSafePos` (link-guard.ts) for a cell's raw line text instead of a syntax tree. */
export function enterSafeRawPos(text: string, pos: number): number {
  const span = linkSpanNear(text, pos);
  if (!span || pos <= span.outerFrom || pos >= span.outerTo) return pos;
  return nearestLinkEdge(pos, span.labelFrom, span.labelTo, span.outerFrom, span.outerTo);
}

/**
 * The link span Backspace (`forward: false`) or Delete (`forward: true`)
 * would otherwise tear in half at `pos` — one of the four risky edges right
 * next to a folded marker — or null everywhere else, including mid-label,
 * which stays ordinary character-at-a-time editing.
 */
export function riskyLinkSpan(text: string, pos: number, forward: boolean): { from: number; to: number } | null {
  const span = linkSpanNear(text, pos);
  if (!span) return null;
  const risky = forward
    ? pos === span.outerFrom || pos === span.labelTo
    : pos === span.labelFrom || pos === span.outerTo;
  return risky ? { from: span.outerFrom, to: span.outerTo } : null;
}

/**
 * Clean pasted text for a cell's editor. Line structure is kept — the cell
 * editor is multi-line now and `cellTextToRaw` turns those lines into `<br>`s
 * on commit — while runs of spaces and tabs inside a line are collapsed, so a
 * copy out of a spreadsheet or a rendered page doesn't drag its layout in.
 *
 * The ONE piece of leading whitespace that survives is a list item's indent
 * (round 28): pasting a nested list — the single most likely thing to arrive
 * here from Confluence or another wiki — used to land every item at level one,
 * because collapsing runs of spaces ate exactly the two-per-level indent the
 * format encodes nesting with. The indent is snapped to the contract's grid so
 * a source that indents by four, or by tabs, still comes out as clean levels.
 *
 * Pipes are deliberately left alone because `serializeGfmTable` escapes them —
 * escaping here as well would write `\\|` and split the cell on the next parse.
 */
const PASTED_ITEM = /^([ \t]*)([-*+•·◦]|\d+[.)])([ \t]+)(.*)$/;

export function sanitizeCellPaste(text: string): string {
  const raw = text.replace(/\r\n?/g, '\n').split('\n');
  const items = raw.map((line) => PASTED_ITEM.exec(line));
  // The pasted source decides how wide ONE level is — 2 spaces, 4, or a tab —
  // and a single line can't tell us. So take the smallest non-zero indent in
  // the block as one level; relative nesting is what has to survive, and it
  // does for any consistent source.
  const indents = items
    .map((m) => (m ? m[1].replace(/\t/g, '  ').length : 0))
    .filter((n) => n > 0);
  const step = indents.length > 0 ? Math.min(...indents) : 2;
  const lines = raw.map((line, i) => {
    const m = items[i];
    if (!m) return line.replace(/[^\S\n]+/g, ' ').trim();
    const columns = m[1].replace(/\t/g, '  ').length;
    const depth = Math.round(columns / step);
    return `${'  '.repeat(depth)}${m[2]} ${m[4].replace(/[^\S\n]+/g, ' ').trim()}`;
  });
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
