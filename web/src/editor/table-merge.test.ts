/**
 * Round 17 — the table model's second layer: merged cells and the
 * `[//]: # (folio-table: …)` metadata line.
 *
 * Everything here is about what lands in the FILE. The compatibility side of
 * that (a plain remark-gfm still sees an ordinary table) is proven in
 * markdown/tableExtensions.test.ts; these tests hold the writing end of the
 * same contract: tight pipes for a colspan, `^^` for a rowspan, the metadata
 * line above the table with a blank line under it, and structural edits that
 * keep the metadata pointing at the cells it was pointing at.
 */
import { describe, expect, it } from 'vitest';
import {
  HEADER_ROW,
  boxAt,
  canMerge,
  canUnmerge,
  cellBg,
  columnWidths,
  deleteColumn,
  deleteRow,
  expandRange,
  insertColumn,
  insertRow,
  mergeRange,
  moveColumn,
  parseGfmTable,
  serializeGfmTable,
  setCell,
  setColumnWidths,
  setRangeBackground,
  shiftCellIndent,
  tableLayout,
  unmergeRange,
  type CellRange,
  type GfmTable,
} from './gfm-table';

const parse = (lines: string[]): GfmTable => parseGfmTable(lines.join('\n'))!;

const GRID = ['| a | b | c |', '| --- | --- | --- |', '| 1 | 2 | 3 |', '| 4 | 5 | 6 |'];

const range = (top: number, left: number, bottom: number, right: number): CellRange => ({
  top,
  left,
  bottom,
  right,
});

describe('colspan: tight pipes', () => {
  it('reads a run of tight pipes as one cell reaching right', () => {
    const table = parse(['| a | b | c |', '| - | - | - |', '| wide |||']);
    const box = boxAt(tableLayout(table), 0, 0)!;
    expect(box.colSpan).toBe(3);
    expect(table.rows[0][0]).toBe('wide');
  });

  it('does NOT read a spaced empty cell as a merge', () => {
    const table = parse(['| a | b | c |', '| - | - | - |', '| x |   | z |']);
    expect(boxAt(tableLayout(table), 0, 0)!.colSpan).toBe(1);
    expect(table.spanLeft).toBeUndefined();
  });

  it('writes the merge back as tight pipes', () => {
    const merged = mergeRange(parse(GRID), range(0, 0, 0, 2));
    expect(serializeGfmTable(merged).split('\n')[2]).toBe('| 1<br>2<br>3 |||');
  });

  it('round-trips', () => {
    const source = serializeGfmTable(mergeRange(parse(GRID), range(0, 0, 0, 2)));
    expect(serializeGfmTable(parse(source.split('\n')))).toBe(source);
  });
});

describe('rowspan: ^^', () => {
  it('merges a cell into the one above it', () => {
    const table = parse(['| a | b |', '| - | - |', '| tall | 2 |', '| ^^ | 5 |']);
    const layout = tableLayout(table);
    const box = boxAt(layout, 0, 0)!;
    expect(box.rowSpan).toBe(2);
    expect(boxAt(layout, 1, 0)).toBe(box);
  });

  it('keeps ^^ literal in the first body row — the header is never merged into', () => {
    const table = parse(['| a | b |', '| - | - |', '| ^^ | 2 |']);
    expect(boxAt(tableLayout(table), 0, 0)!.rowSpan).toBe(1);
    expect(table.rows[0][0]).toBe('^^');
  });

  it('keeps ^^ literal when the cell above spans different columns', () => {
    const table = parse(['| a | b |', '| - | - |', '| wide ||', '| ^^ | y |']);
    expect(boxAt(tableLayout(table), 0, 0)!.colSpan).toBe(2);
    expect(boxAt(tableLayout(table), 1, 0)!.rowSpan).toBe(1);
  });

  it('writes a vertical merge as ^^ and keeps the text in the top cell', () => {
    const merged = mergeRange(parse(GRID), range(0, 0, 1, 0));
    expect(serializeGfmTable(merged).split('\n').slice(2)).toEqual([
      '| 1<br>4 | 2   | 3   |',
      '| ^^     | 5   | 6   |',
    ]);
  });

  it('refuses to straddle the header: a range covering both keeps the body', () => {
    const merged = mergeRange(parse(GRID), range(HEADER_ROW, 0, 1, 0));
    expect(merged.header[0]).toBe('a');
    expect(merged.rows[1][0]).toBe('^^');
  });
});

describe('merge and unmerge', () => {
  it('folds every non-empty cell of the rectangle into the survivor', () => {
    const merged = mergeRange(parse(GRID), range(0, 0, 1, 1));
    expect(merged.rows[0][0]).toBe('1<br>2<br>4<br>5');
  });

  it('unmerge restores the grid, leaving the text where it is', () => {
    const merged = mergeRange(parse(GRID), range(0, 0, 1, 1));
    const back = unmergeRange(merged, range(0, 0, 0, 0));
    expect(back.spanLeft).toBeUndefined();
    expect(back.rows).toEqual([
      ['1<br>2<br>4<br>5', '', '3'],
      ['', '', '6'],
    ]);
    expect(serializeGfmTable(back).split('\n')[3]).toBe('|                  |     | 6   |');
  });

  it('knows when either is worth offering', () => {
    const table = parse(GRID);
    expect(canMerge(table, range(0, 0, 0, 0))).toBe(false);
    expect(canMerge(table, range(0, 0, 1, 1))).toBe(true);
    expect(canUnmerge(table, range(0, 0, 1, 1))).toBe(false);
    expect(canUnmerge(mergeRange(table, range(0, 0, 1, 1)), range(0, 0, 0, 0))).toBe(true);
  });

  it('grows a range that would cut a merged cell in half', () => {
    const merged = mergeRange(parse(GRID), range(0, 0, 1, 1));
    expect(expandRange(merged, range(0, 1, 0, 2))).toEqual(range(0, 0, 1, 2));
  });

  it('typing into a continuation cell makes it a cell again', () => {
    const merged = mergeRange(parse(GRID), range(0, 0, 0, 2));
    const typed = setCell(merged, 0, 1, 'back');
    expect(boxAt(tableLayout(typed), 0, 0)!.colSpan).toBe(1);
  });
});

describe('the metadata line', () => {
  const WITH_ATTRS = [
    '[//]: # (folio-table: bg=HA:yellow,A1:green; w=1:30%,2:70%)',
    '',
    ...GRID,
  ];

  it('is read from above the table', () => {
    const table = parse(WITH_ATTRS);
    expect(cellBg(table, HEADER_ROW, 0)).toBe('yellow');
    expect(cellBg(table, 0, 0)).toBe('green');
    expect([...columnWidths(table)]).toEqual([
      [0, '30%'],
      [1, '70%'],
    ]);
  });

  it('is written above the table, with a blank line after it', () => {
    const written = serializeGfmTable(parse(WITH_ATTRS)).split('\n');
    expect(written[0]).toBe('[//]: # (folio-table: bg=HA:yellow,A1:green; w=1:30%,2:70%)');
    expect(written[1]).toBe('');
    expect(written[2]).toBe('| a   | b   | c   |');
  });

  it('is moved out of the body when a file uses the DEV-PLAN placement', () => {
    const legacy = [
      '| a | b | c |',
      '| --- | --- | --- |',
      '[//]: # (folio-table: bg=A1:blue)',
      '| 1 | 2 | 3 |',
    ];
    const table = parse(legacy);
    expect(table.rows).toHaveLength(1);
    expect(cellBg(table, 0, 0)).toBe('blue');
    expect(serializeGfmTable(table).split('\n')[0]).toBe('[//]: # (folio-table: bg=A1:blue)');
  });

  it('disappears entirely once nothing is painted', () => {
    const table = setRangeBackground(parse(WITH_ATTRS), range(HEADER_ROW, 0, HEADER_ROW, 0), null);
    const cleared = setColumnWidths(setRangeBackground(table, range(0, 0, 0, 0), null), null);
    expect(cleared.attrs).toBeUndefined();
    expect(serializeGfmTable(cleared).startsWith('| a ')).toBe(true);
  });

  it('degrades to an ordinary table when it is damaged', () => {
    const table = parse(['[//]: # (folio-table: bg=??; w=)', '', ...GRID]);
    expect(table.attrs).toBeUndefined();
    expect(table.rows).toHaveLength(2);
  });

  it('paints a whole range at once, skipping cells a merge covers', () => {
    const merged = mergeRange(parse(GRID), range(0, 0, 0, 2));
    const painted = setRangeBackground(merged, range(0, 0, 0, 2), 'teal');
    expect(painted.attrs?.bg).toEqual({ A1: 'teal' });
  });
});

describe('structural edits keep the metadata pointing at the right cells', () => {
  const painted = (): GfmTable =>
    setColumnWidths(
      setRangeBackground(parse(GRID), range(0, 1, 0, 1), 'red'),
      new Map([
        [0, '20%'],
        [1, '80%'],
      ]),
    );

  it('inserting a column shifts the cells to its right', () => {
    const next = insertColumn(painted(), -1); // a new first column
    expect(cellBg(next, 0, 2)).toBe('red');
    expect([...columnWidths(next)]).toEqual([
      [1, '20%'],
      [2, '80%'],
    ]);
  });

  it('deleting a column drops its own entries and shifts the rest', () => {
    const next = deleteColumn(painted(), 0);
    expect(cellBg(next, 0, 0)).toBe('red');
    expect([...columnWidths(next)]).toEqual([[0, '80%']]);
  });

  it('inserting and deleting rows shift the rows below', () => {
    const grown = insertRow(painted(), -1); // a new first body row
    expect(cellBg(grown, 1, 1)).toBe('red');
    expect(cellBg(deleteRow(grown, 0), 0, 1)).toBe('red');
  });

  it('deleting a painted row drops that paint', () => {
    expect(deleteRow(painted(), 0).attrs?.bg).toEqual({});
  });

  it('moving a column takes its colour and width with it', () => {
    const next = moveColumn(painted(), 1, 2);
    expect(cellBg(next, 0, 2)).toBe('red');
    expect([...columnWidths(next)]).toEqual([
      [0, '20%'],
      [2, '80%'],
    ]);
  });

  it('deleting the row above a ^^ hands it that row’s text', () => {
    const table = parse(['| a |', '| - |', '| tall |', '| ^^ |']);
    expect(deleteRow(table, 0).rows).toEqual([['tall']]);
  });

  it('deleting the cell a colspan starts at promotes its continuation', () => {
    const merged = mergeRange(parse(GRID), range(0, 0, 0, 1));
    const next = deleteColumn(merged, 0);
    expect(next.spanLeft).toBeUndefined();
  });
});

describe('column widths', () => {
  it('only accepts values the metadata line can carry', () => {
    const table = setColumnWidths(
      parse(GRID),
      new Map([
        [0, '30%'],
        [1, '120px'],
      ]),
    );
    expect(serializeGfmTable(table).split('\n')[0]).toBe('[//]: # (folio-table: w=1:30%,2:120px)');
  });

  it('drops nonsense on the way back in', () => {
    const table = parse(['[//]: # (folio-table: w=1:200%,2:9rem,3:40%)', '', ...GRID]);
    expect([...columnWidths(table)]).toEqual([[2, '40%']]);
  });
});

describe('nested list lines in a cell', () => {
  it('indents and outdents a list line, and stops at three levels', () => {
    expect(shiftCellIndent('• one', 1)).toBe('  • one');
    expect(shiftCellIndent('  • one', 1)).toBe('    • one');
    expect(shiftCellIndent('    • one', 1)).toBe('    • one');
    expect(shiftCellIndent('  [ ] task', -1)).toBe('[ ] task');
    expect(shiftCellIndent('• one', -1)).toBe('• one');
  });

  it('leaves a plain line alone, so Tab still moves to the next cell', () => {
    expect(shiftCellIndent('just text', 1)).toBeNull();
  });
});
