/**
 * Round 17 — the normative syntax of folio's extended tables, in one place,
 * shared verbatim by the reading renderer (markdown/) and the editable grid
 * (editor/). Nothing here knows about hast, mdast or CodeMirror: it reads and
 * writes pipe rows and one metadata line, and computes the merge layout.
 *
 * THE IRON RULE (DEV-PLAN round 17): whatever we write to the file has to stay
 * a valid GFM pipe table — github/gitlab must show it as an ordinary table,
 * without our extensions but also without debris. Everything below is chosen to
 * survive a plain remark-gfm/cmark-gfm parse (see tableSyntax.test.ts and
 * gfmCompat.test.ts, which prove it against a pipeline with none of our
 * plugins in it):
 *
 * 1. **colspan** — MultiMarkdown-compatible: a cell is continued by the empty
 *    cells to its right, written as *tight* pipes: `| Header |||` spans three
 *    columns. Tight is the whole distinction — `| a |  | c |` (a pipe, spaces,
 *    a pipe) is an ordinary empty cell and stays one. GFM shows empty cells;
 *    no text is lost and the grid keeps its shape.
 * 2. **rowspan** — our extension, which MMD-7 has no syntax for: a cell whose
 *    entire content is `^^` continues the cell above it. GFM shows a literal
 *    `^^`, which is legible, and the data is intact.
 * 3. **cell background / column width** — a metadata line
 *    `[//]: # (folio-table: bg=A1:yellow; w=1:30%,2:70%)`, which is a link
 *    reference definition: every CommonMark implementation consumes it and
 *    renders nothing at all.
 *
 *    PLACEMENT — this is where the implementation deviates from the letter of
 *    the DEV-PLAN, deliberately, to keep the iron rule. The plan puts that line
 *    "right under the header delimiter". Measured against four independent
 *    parsers (remark-gfm, marked, pandoc's gfm reader, @lezer/markdown), a line
 *    inside the table body is NOT a definition there — it is a table row, and
 *    github would print `[//]: # (folio-table: …)` as the first row of the
 *    table. So we WRITE it above the table, followed by a blank line:
 *
 *        [//]: # (folio-table: bg=A1:yellow)
 *
 *        | A | B |
 *        | - | - |
 *
 *    That is the only placement all four parsers agree on: pandoc's gfm reader
 *    refuses to see a table at all when a non-blank line sits directly above
 *    the header, so the no-blank-line variant is out too. The legacy
 *    under-the-delimiter placement is still READ (and repaired on the next
 *    edit) so a file hand-written to the plan's letter still works here.
 * 4. **alignment** — plain GFM (`:---`, `:---:`, `---:`). Not our business.
 *
 * Addressing in the metadata line is spreadsheet-shaped: `A1` is the first cell
 * of the first BODY row, and a header cell is written with an `H` prefix and no
 * number (`HA`, `HB`). That grammar is a hard contract with the round-16b
 * Confluence importer, which writes these lines too. Internally rows are
 * numbered the way the editor numbers them (`-1` = header, `0…` = body rows)
 * and columns from 0; `cellKey`/`parseCellKey` translate.
 */

/* ------------------------------------------------------------- palette --- */

/**
 * The fixed background palette. Arbitrary CSS is deliberately not accepted:
 * these become class names, and the reading-mode sanitizer does not (and must
 * not) pass inline styles.
 *
 * The set is sized against the case this round is accepted on — a Confluence
 * "card" layout of five columns, each with its own pastel fill (pink, mint,
 * yellow, sky, periwinkle). `red` is that pastel pink, and `teal`/`orange`
 * round the set out so a Confluence import has a token for every fill it
 * commonly uses instead of collapsing three of them onto one colour.
 */
export const BG_TOKENS = [
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'red',
  'orange',
  'gray',
] as const;
export type BgToken = (typeof BG_TOKENS)[number];

/** How far a table may break out of the prose column. */
export const TABLE_DISPLAYS = ['narrow', 'medium', 'full'] as const;
export type TableDisplay = (typeof TABLE_DISPLAYS)[number];

export function isTableDisplay(value: string): value is TableDisplay {
  return (TABLE_DISPLAYS as readonly string[]).includes(value);
}

/** Written by the palette's "no background" entry; never stored. */
export const BG_NONE = 'none';

export function isBgToken(value: string): value is BgToken {
  return (BG_TOKENS as readonly string[]).includes(value);
}

/**
 * The class a background token renders as. Fixed by contract with the round-16b
 * Confluence importer, which stamps the very same class on the `<td>`s of the
 * complex (raw HTML) tables it writes — markdown.css is the single source of
 * truth for what each token looks like, in both themes.
 */
export function bgClass(token: BgToken): string {
  return `folio-bg-${token}`;
}

/* --------------------------------------------------------------- model --- */

export interface TableAttrs {
  /** Cell key (`A1`) → palette token. */
  bg: Record<string, BgToken>;
  /** 1-based column number → width (`30%` or `120px`). */
  width: Record<number, string>;
  /** Borderless page-layout columns; storage remains a valid GFM table. */
  layout?: 'columns';
  /** Table width relative to the prose column. `narrow` is the implicit default. */
  display?: TableDisplay;
}

export const EMPTY_ATTRS: TableAttrs = { bg: {}, width: {} };

export function cloneAttrs(attrs: TableAttrs): TableAttrs {
  return {
    bg: { ...attrs.bg },
    width: { ...attrs.width },
    ...(attrs.layout ? { layout: attrs.layout } : {}),
    ...(attrs.display ? { display: attrs.display } : {}),
  };
}

export function hasAttrs(attrs: TableAttrs): boolean {
  return (
    Object.keys(attrs.bg).length > 0 ||
    Object.keys(attrs.width).length > 0 ||
    attrs.layout !== undefined ||
    (attrs.display !== undefined && attrs.display !== 'narrow')
  );
}

/** Row index that addresses the header row, matching editor/gfm-table.ts. */
export const HEADER_ROW = -1;

/** `0 → A`, `25 → Z`, `26 → AA`. */
export function columnLabel(col: number): string {
  let out = '';
  let n = col;
  while (n >= 0) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out;
}

export function columnFromLabel(label: string): number {
  let n = 0;
  for (const ch of label.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Internal (row, col) → metadata-line key. Row 1 is the FIRST BODY ROW and the
 * header is addressed with an `H` prefix and no number (`HA`, `HB`) — the
 * addressing the round-16b Confluence importer writes, fixed by contract.
 */
export function cellKey(row: number, col: number): string {
  return row === HEADER_ROW ? `H${columnLabel(col)}` : `${columnLabel(col)}${row + 1}`;
}

const BODY_KEY = /^([A-Za-z]+)(\d+)$/;
const HEADER_KEY = /^[Hh]([A-Za-z]+)$/;

export function parseCellKey(key: string): { row: number; col: number } | null {
  const text = key.trim();

  const head = HEADER_KEY.exec(text);
  if (head) {
    const col = columnFromLabel(head[1]);
    return col >= 0 ? { row: HEADER_ROW, col } : null;
  }

  const body = BODY_KEY.exec(text);
  if (!body) return null;
  const col = columnFromLabel(body[1]);
  const row = Number.parseInt(body[2], 10) - 1;
  if (col < 0 || !Number.isFinite(row) || row < 0) return null;
  return { row, col };
}

/* ------------------------------------------------------- metadata line --- */

/**
 * The metadata line, as a link reference definition. Kept loose on the inside
 * (spacing, order, unknown keys) and strict about values — an unreadable line
 * degrades to "this table has no metadata", never to an error.
 */
export const TABLE_ATTR_LINE = /^[ \t]*\[\/\/\]:[ \t]*#[ \t]*\((?:[ \t]*)folio-table:([^)]*)\)[ \t]*$/;

const WIDTH_VALUE = /^(\d{1,3}%|\d{1,4}px)$/;

function validWidth(value: string): string | null {
  const text = value.trim();
  if (!WIDTH_VALUE.test(text)) return null;
  if (text.endsWith('%')) {
    const n = Number.parseInt(text, 10);
    if (n < 1 || n > 100) return null;
  }
  return text;
}

export function isTableAttrLine(line: string): boolean {
  return TABLE_ATTR_LINE.test(line);
}

/** Parse one metadata line. Returns null when the line isn't one at all. */
export function parseTableAttrLine(line: string): TableAttrs | null {
  const m = TABLE_ATTR_LINE.exec(line);
  if (!m) return null;

  const attrs: TableAttrs = { bg: {}, width: {} };
  for (const section of m[1].split(';')) {
    const at = section.indexOf('=');
    if (at < 0) continue;
    const key = section.slice(0, at).trim().toLowerCase();
    const body = section.slice(at + 1).trim();

    if (key === 'layout' && body.toLowerCase() === 'columns') {
      attrs.layout = 'columns';
      continue;
    }

    if (key === 'display' && isTableDisplay(body.toLowerCase())) {
      const display = body.toLowerCase() as TableDisplay;
      if (display !== 'narrow') attrs.display = display;
      continue;
    }

    for (const entry of body.split(',')) {
      const colon = entry.indexOf(':');
      if (colon < 0) continue;
      const left = entry.slice(0, colon).trim();
      const right = entry.slice(colon + 1).trim();

      if (key === 'bg') {
        const ref = parseCellKey(left);
        const token = right.toLowerCase();
        if (ref && isBgToken(token)) attrs.bg[cellKey(ref.row, ref.col)] = token;
      } else if (key === 'w') {
        const col = Number.parseInt(left, 10);
        const width = validWidth(right);
        if (Number.isFinite(col) && col >= 1 && width) attrs.width[col] = width;
      }
    }
  }
  return attrs;
}

/** Render the metadata line, or null when there is nothing to say. */
export function formatTableAttrLine(attrs: TableAttrs): string | null {
  if (!hasAttrs(attrs)) return null;
  const parts: string[] = [];

  if (attrs.layout) parts.push(`layout=${attrs.layout}`);
  if (attrs.display && attrs.display !== 'narrow') parts.push(`display=${attrs.display}`);

  const bgKeys = Object.keys(attrs.bg).sort(compareCellKeys);
  if (bgKeys.length > 0) {
    parts.push(`bg=${bgKeys.map((key) => `${key}:${attrs.bg[key]}`).join(',')}`);
  }

  const widthCols = Object.keys(attrs.width)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (widthCols.length > 0) {
    parts.push(`w=${widthCols.map((col) => `${col}:${attrs.width[col]}`).join(',')}`);
  }

  return `[//]: # (folio-table: ${parts.join('; ')})`;
}

function compareCellKeys(a: string, b: string): number {
  const left = parseCellKey(a);
  const right = parseCellKey(b);
  if (!left || !right) return a.localeCompare(b);
  return left.col - right.col || left.row - right.row;
}

/* ------------------------------------------------------------ pipe rows --- */

/**
 * Only the table-level `\|` escape is resolved here; other backslash escapes
 * belong to the cell's inline markdown and must survive untouched.
 */
export function unescapeTableCell(text: string): string {
  return text.replace(/\\\|/g, '|');
}

export interface PipeRow {
  /** Trimmed, `\|`-unescaped cell texts. */
  cells: string[];
  /** `spanLeft[i]` — cell i continues cell i-1 (a tight `||` in the source). */
  spanLeft: boolean[];
}

function endsWithUnescapedPipe(text: string): boolean {
  if (!text.endsWith('|')) return false;
  let backslashes = 0;
  for (let i = text.length - 2; i >= 0 && text[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 0;
}

/**
 * Split one table line into cells. Leading/trailing pipes are optional in GFM;
 * `\|` inside a cell is content, not a separator. A cell whose raw segment is
 * *empty* — no space between the two pipes — is a colspan continuation of the
 * cell to its left; one written with whitespace (`|   |`) is an ordinary empty
 * cell. That difference is the entire colspan syntax.
 */
export function splitPipeRow(line: string): PipeRow {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (endsWithUnescapedPipe(text)) text = text.slice(0, -1);

  const raw: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      current += ch + text[i + 1];
      i++;
      continue;
    }
    if (ch === '|') {
      raw.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  raw.push(current);

  return {
    cells: raw.map((cell) => unescapeTableCell(cell).trim()),
    spanLeft: raw.map((cell, index) => index > 0 && cell === ''),
  };
}

const DELIMITER_CELL = /^:?-+:?$/;

export function isDelimiterRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => DELIMITER_CELL.test(cell));
}

/** Pad/trim a row to the table's width, the way GFM itself normalises rows. */
export function fitRow<T>(values: readonly T[], width: number, empty: T): T[] {
  const out = values.slice(0, width);
  while (out.length < width) out.push(empty);
  return out;
}

/* ---------------------------------------------------------- merge layout -- */

/** A cell whose whole content is this continues the cell above it. */
export const ROW_SPAN = '^^';

export function isRowSpan(text: string): boolean {
  return text.trim() === ROW_SPAN;
}

export interface CellBox {
  /** Grid row of the anchor: 0 is the header row, 1… are body rows. */
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

export interface TableLayout {
  width: number;
  height: number;
  /** Anchors in document order, row by row. */
  boxes: CellBox[];
  /** `grid[row][col]` — the box covering that position (never null in range). */
  grid: CellBox[][];
}

/**
 * Turn the two merge layers into an HTML-shaped grid.
 *
 * `cells`/`spanLeft` are indexed with the HEADER AS ROW 0 — that is what makes
 * the "never merge a body row into the header" rule expressible: `^^` in the
 * first body row has nothing legal above it, so it stays literal text (which is
 * also exactly what github shows). A `^^` whose column range doesn't match the
 * box above it stays literal too, because anything else would produce an
 * unrepresentable, non-rectangular cell.
 */
export function computeLayout(
  cells: readonly (readonly string[])[],
  spanLeft: readonly (readonly boolean[])[],
): TableLayout {
  const height = cells.length;
  const width = height > 0 ? cells[0].length : 0;
  const grid: CellBox[][] = [];
  const boxes: CellBox[] = [];

  for (let row = 0; row < height; row++) {
    grid.push(new Array<CellBox>(width));
    let col = 0;
    while (col < width) {
      let span = 1;
      while (col + span < width && spanLeft[row]?.[col + span]) span++;

      const above = row >= 2 ? grid[row - 1][col] : undefined;
      const mergeable =
        above !== undefined &&
        above.col === col &&
        above.colSpan === span &&
        isRowSpan(cells[row][col] ?? '') &&
        // Never across the header/body boundary: `<thead>` and `<tbody>` are
        // different sections and a rowspan may not straddle them.
        above.row >= 1;

      if (mergeable) {
        above.rowSpan += 1;
        for (let i = 0; i < span; i++) grid[row][col + i] = above;
      } else {
        const box: CellBox = { row, col, rowSpan: 1, colSpan: span };
        boxes.push(box);
        for (let i = 0; i < span; i++) grid[row][col + i] = box;
      }
      col += span;
    }
  }

  return { width, height, boxes, grid };
}

/** True when the box starts at that position — i.e. the cell is drawn there. */
export function isAnchor(box: CellBox, row: number, col: number): boolean {
  return box.row === row && box.col === col;
}

/* -------------------------------------------------- lists inside a cell --- */

/**
 * Round 28 — a LIST inside a table cell, normatively.
 *
 * The problem it answers (QA-3, owner's call): a Confluence table whose cells
 * contain real multi-item lists could not be represented at all, so the whole
 * table fell back to raw HTML — which in the editor is an opaque block with an
 * "HTML" badge, no table tools, and one stray keystroke lands inside a tag and
 * destroys it. The owner asked for our own format to grow, not for the
 * importer to flatten lists away.
 *
 * The shape, chosen to keep the IRON RULE above intact: cell content is split
 * on `<br>`, and a line whose first non-space run is a bullet marker is a list
 * item. Nesting is two spaces per level, BEFORE the marker.
 *
 *     • collect requirements<br>• agree<br>  • by email<br>  • on a call
 *
 * `<br>` and a literal bullet character are legal GFM cell content, so github
 * shows those as separate bulleted lines: readable, and no debris. A real block
 * `<ul>` fits into a pipe table in no parser at all, and an HTML block is
 * exactly what this round exists to stop producing.
 *
 * `•` is the written marker because round 17's own acceptance fixture already
 * used it (see tableExtensions.test.ts) — this round formalises a shape the
 * format had informally, rather than inventing a second one. On READING the set
 * is deliberately wider than what we write, because three sources feed these
 * cells and each spells a bullet its own way: a human types `-`/`*`/`+`, the
 * round-17 editor has always accepted `·` (U+00B7), and an importer may emit
 * `◦`. A marker we refuse is not a cosmetic loss — the line silently becomes a
 * paragraph, and the next edit writes that demotion back to the file.
 *
 * For the same reason a checklist is accepted BOTH bare (`[ ] item`, the form
 * the editor writes) and GFM-style behind a bullet (`- [ ] item`, the form
 * anything converting from markdown produces).
 *
 * Deliberately NOT a general markdown parser: only the marker and the indent
 * are structural. Everything after the marker stays inline markdown and is
 * rendered by whatever the caller already uses for cell text.
 */
export interface CellLine {
  /** 0 for a paragraph line, 1+ for a list item (indent / 2 + 1). */
  depth: number;
  /** The item kind, or null for a plain paragraph line. */
  marker: 'ul' | 'ol' | 'task' | null;
  /** For `task` only: the state of the checkbox (round 21's `[ ]` / `[x]`). */
  checked?: boolean;
  /**
   * For `ol` only: the number the file actually carries. Kept rather than
   * discarded because inside a CELL this text is what a plain GFM renderer
   * literally prints — `1.` on every line would show github a list numbered
   * "1. 1. 1.". formatCellLines renumbers each run instead.
   */
  ordinal?: number;
  /**
   * How many characters of the raw line the indent + marker + its trailing
   * space took. A renderer working on hast has to cut exactly that prefix off
   * the first text node and leave the inline markup after it alone, and
   * deriving the width by searching for `text` is a guess this contract can
   * simply answer. 0 for a paragraph line.
   */
  markerWidth: number;
  /** The line's own text, marker and indent removed. */
  text: string;
}

/**
 * Two spaces per nesting level, exactly — a tab counts as one level too.
 * `[ ]`/`[x]` is round 21's checklist and is part of this contract, not a
 * second alphabet kept by the renderer: without it formatCellLines silently
 * demoted a checklist item to a paragraph on the next edit.
 */
const CELL_ITEM_RE = /^([ \t]*)(?:(?:[-*+•·◦][ \t]+)?\[([ xX])\]|([-*+•·◦])|(\d+)[.)])[ \t]+(.*)$/;

/** Splits raw cell text into structural lines. Never throws; unknown shapes stay paragraphs. */
export function parseCellLines(cellText: string): CellLine[] {
  return splitCellBreaks(cellText).map((raw) => {
    const m = CELL_ITEM_RE.exec(raw);
    if (!m) return { depth: 0, marker: null, markerWidth: 0, text: raw.trim() };
    const [, rawIndent, task, bullet, number, rest] = m;
    const depth = Math.floor(rawIndent.replace(/\t/g, '  ').length / 2) + 1;
    const markerWidth = raw.length - rest.length;
    if (task !== undefined) {
      return { depth, marker: 'task' as const, checked: task.toLowerCase() === 'x', markerWidth, text: rest.trim() };
    }
    if (bullet !== undefined) return { depth, marker: 'ul' as const, markerWidth, text: rest.trim() };
    return { depth, marker: 'ol' as const, ordinal: Number(number), markerWidth, text: rest.trim() };
  });
}

/** True when at least one line is a list item — the cheap check a renderer wants first. */
export function cellHasList(cellText: string): boolean {
  return parseCellLines(cellText).some((l) => l.marker !== null);
}

/** The inverse of parseCellLines: back to the single-line cell body the file stores. */
export function formatCellLines(lines: readonly CellLine[]): string {
  // Ordered runs are renumbered from 1 per (depth, contiguous run), so the
  // numbers a plain GFM renderer prints are always the right ones no matter how
  // the list was edited. A run ends at any line that is not an `ol` item of the
  // same depth.
  const counters = new Map<number, number>();
  return lines
    .map((l) => {
      if (!l.marker) counters.clear(); // a paragraph ends every run
      else {
        // Going shallower ends the deeper runs; a bullet at this depth ends the
        // numbered run at this depth. Nesting on its own does NOT: `1. / 1.1 /
        // 1.2 / 2.` has to keep counting the outer list.
        for (const d of [...counters.keys()]) if (d > l.depth) counters.delete(d);
        if (l.marker !== 'ol') counters.delete(l.depth);
      }
      if (!l.marker) return l.text;
      const indent = '  '.repeat(Math.max(0, l.depth - 1));
      if (l.marker === 'task') return `${indent}[${l.checked ? 'x' : ' '}] ${l.text}`;
      if (l.marker === 'ul') return `${indent}• ${l.text}`;
      const n = (counters.get(l.depth) ?? 0) + 1;
      counters.set(l.depth, n);
      return `${indent}${n}. ${l.text}`;
    })
    .join('<br>');
}

/**
 * Splits on the `<br>` forms a cell can legitimately hold. Kept here rather
 * than in each caller so the reading renderer and the editable grid agree on
 * what a "line" is — they already share every other rule in this file.
 */
export function splitCellBreaks(cellText: string): string[] {
  return cellText.split(/<br\s*\/?>/i);
}
