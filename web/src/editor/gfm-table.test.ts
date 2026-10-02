import { describe, expect, it } from 'vitest';
import {
  BULLET,
  HEADER_ROW,
  TASK_OPEN,
  cellRawToText,
  cellTextToRaw,
  displayToRawOffset,
  listContinuation,
  moveColumn,
  moveRow,
  parseCellLine,
  parseCellLines,
  parseInlineSpans,
  sanitizeCellPaste,
  cycleAlign,
  deleteColumn,
  deleteRow,
  escapeCell,
  insertColumn,
  insertRow,
  isDelimiterRow,
  parseGfmTable,
  parseInline,
  serializeGfmTable,
  setAlign,
  setCell,
  setTableDisplay,
  shiftCellIndent,
  splitCellLines,
  splitTableRow,
  toggleCellTask,
  unescapeCell,
  type GfmTable,
} from './gfm-table';

const SIMPLE = ['| Name | Qty |', '| --- | ---: |', '| Bolt | 12 |', '| Nut | 3 |'].join('\n');

describe('splitTableRow', () => {
  it('splits on pipes and trims cells', () => {
    expect(splitTableRow('| a | b | c |')).toEqual(['a', 'b', 'c']);
  });

  it('accepts rows without leading and trailing pipes', () => {
    expect(splitTableRow('a | b')).toEqual(['a', 'b']);
  });

  it('treats an escaped pipe as content', () => {
    expect(splitTableRow('| a \\| b | c |')).toEqual(['a | b', 'c']);
  });

  it('reads ==highlight== with its colour token, and the legacy <mark>', () => {
    expect(parseInline('a ==h=={.red} b')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'mark', text: 'h', color: 'red' },
      { type: 'text', text: ' b' },
    ]);
    expect(parseInline('==h==')).toEqual([{ type: 'mark', text: 'h' }]);
    expect(parseInline('<mark>h</mark>')).toEqual([{ type: 'mark', text: 'h' }]);
  });

  it('keeps a trailing escaped pipe inside the cell', () => {
    expect(splitTableRow('| a\\| |')).toEqual(['a|']);
  });

  it('leaves inline-markdown escapes alone', () => {
    expect(splitTableRow('| a \\* b |')).toEqual(['a \\* b']);
  });
});

describe('isDelimiterRow', () => {
  it('recognises alignment rows', () => {
    expect(isDelimiterRow(['---', ':--', '--:', ':-:'])).toBe(true);
    expect(isDelimiterRow(['---', 'x'])).toBe(false);
    expect(isDelimiterRow([])).toBe(false);
  });
});

describe('parseGfmTable', () => {
  it('reads header, alignment and rows', () => {
    expect(parseGfmTable(SIMPLE)).toEqual({
      header: ['Name', 'Qty'],
      align: [null, 'right'],
      rows: [
        ['Bolt', '12'],
        ['Nut', '3'],
      ],
    });
  });

  it('pads short rows and truncates long ones', () => {
    const table = parseGfmTable(['| a | b |', '| - | - |', '| 1 |', '| 1 | 2 | 3 |'].join('\n'));
    expect(table?.rows).toEqual([
      ['1', ''],
      ['1', '2'],
    ]);
  });

  it('rejects text that is not a table', () => {
    expect(parseGfmTable('just a line')).toBeNull();
    expect(parseGfmTable('| a | b |\n| x | y |')).toBeNull();
  });

  it('accepts a header-only table', () => {
    expect(parseGfmTable('| a |\n| --- |')).toEqual({ header: ['a'], align: [null], rows: [] });
  });
});

describe('serializeGfmTable', () => {
  it('pads columns so the raw markdown stays readable', () => {
    expect(serializeGfmTable(parseGfmTable(SIMPLE)!)).toBe(
      ['| Name | Qty |', '| ---- | --: |', '| Bolt | 12  |', '| Nut  | 3   |'].join('\n'),
    );
  });

  it('renders every alignment marker', () => {
    const table: GfmTable = { header: ['a', 'b', 'c', 'd'], align: [null, 'left', 'center', 'right'], rows: [] };
    expect(serializeGfmTable(table).split('\n')[1]).toBe('| --- | :-- | :-: | --: |');
  });
});

describe('round trip', () => {
  it('is stable when nothing is edited', () => {
    const once = serializeGfmTable(parseGfmTable(SIMPLE)!);
    expect(serializeGfmTable(parseGfmTable(once)!)).toBe(once);
  });

  it('survives a cell edit with a pipe in it', () => {
    const edited = setCell(parseGfmTable(SIMPLE)!, 0, 0, 'Bolt | washer');
    const markdown = serializeGfmTable(edited);
    expect(markdown).toContain('Bolt \\| washer');
    expect(parseGfmTable(markdown)?.rows[0][0]).toBe('Bolt | washer');
  });

  it('keeps inline markdown in cells intact', () => {
    const edited = setCell(parseGfmTable(SIMPLE)!, HEADER_ROW, 0, '**Name** `code`');
    const reparsed = parseGfmTable(serializeGfmTable(edited));
    expect(reparsed?.header[0]).toBe('**Name** `code`');
  });

  it('does not turn an escaped asterisk into emphasis', () => {
    const source = '| a \\* b |\n| --- |';
    expect(serializeGfmTable(parseGfmTable(source)!)).toContain('a \\* b');
  });

  it('preserves the borderless columns layout metadata', () => {
    const source = '[//]: # (folio-table: layout=columns)\n\n|   |   |\n| --- | --- |\n| A | B |';
    const parsed = parseGfmTable(source);
    expect(parsed?.attrs?.layout).toBe('columns');
    expect(serializeGfmTable(parsed!)).toContain('[//]: # (folio-table: layout=columns)');
  });

  it('round-trips a table width mode and omits the default narrow mode', () => {
    const source = '[//]: # (folio-table: display=medium)\n\n' + SIMPLE;
    const parsed = parseGfmTable(source)!;
    expect(parsed.attrs?.display).toBe('medium');
    expect(serializeGfmTable(parsed)).toContain('folio-table: display=medium');

    const full = setTableDisplay(parsed, 'full');
    expect(serializeGfmTable(full)).toContain('folio-table: display=full');
    expect(setTableDisplay(full, 'narrow').attrs).toBeUndefined();
    expect(parseGfmTable('[//]: # (folio-table: display=narrow)\n\n' + SIMPLE)?.attrs).toBeUndefined();
  });
});

describe('escapeCell / unescapeCell', () => {
  it('only handles the table-level pipe escape', () => {
    expect(escapeCell('a | b')).toBe('a \\| b');
    expect(unescapeCell('a \\| b')).toBe('a | b');
    expect(escapeCell('a \\* b')).toBe('a \\* b');
  });

  it('flattens newlines, which cells cannot contain', () => {
    expect(escapeCell('a\nb')).toBe('a b');
  });
});

describe('structure edits', () => {
  const table = parseGfmTable(SIMPLE)!;

  it('inserts a row below the given index', () => {
    expect(insertRow(table, 0).rows).toEqual([['Bolt', '12'], ['', ''], ['Nut', '3']]);
  });

  it('inserts a column with a matching alignment slot', () => {
    const next = insertColumn(table, 0);
    expect(next.header).toEqual(['Name', '', 'Qty']);
    expect(next.align).toEqual([null, null, 'right']);
    expect(next.rows[0]).toEqual(['Bolt', '', '12']);
  });

  it('deletes rows and columns', () => {
    expect(deleteRow(table, 0).rows).toEqual([['Nut', '3']]);
    const narrower = deleteColumn(table, 1);
    expect(narrower.header).toEqual(['Name']);
    expect(narrower.rows).toEqual([['Bolt'], ['Nut']]);
  });

  it('refuses to delete the last column', () => {
    const single: GfmTable = { header: ['a'], align: [null], rows: [['1']] };
    expect(deleteColumn(single, 0)).toBe(single);
  });

  it('cycles alignment through the four states', () => {
    let next = { header: ['a'], align: [null], rows: [] } as GfmTable;
    const seen = [];
    for (let i = 0; i < 4; i++) {
      next = cycleAlign(next, 0);
      seen.push(next.align[0]);
    }
    expect(seen).toEqual(['left', 'center', 'right', null]);
  });

  it('writes header cells through HEADER_ROW and ignores out-of-range writes', () => {
    expect(setCell(table, HEADER_ROW, 1, 'Count').header).toEqual(['Name', 'Count']);
    expect(setCell(table, 99, 0, 'x')).toBe(table);
    expect(setCell(table, 0, 99, 'x')).toBe(table);
  });

  it('never mutates the input table', () => {
    const before = JSON.stringify(table);
    insertRow(table, 0);
    insertColumn(table, 0);
    deleteRow(table, 0);
    setCell(table, 0, 0, 'zzz');
    expect(JSON.stringify(table)).toBe(before);
  });

  it('keeps the table width mode through structural edits', () => {
    const wide = setTableDisplay(table, 'medium');
    expect(insertRow(wide, 0).attrs?.display).toBe('medium');
    expect(insertColumn(wide, 0).attrs?.display).toBe('medium');
    expect(deleteRow(wide, 0).attrs?.display).toBe('medium');
  });
});

describe('parseInline', () => {
  it('splits a cell into display tokens', () => {
    expect(parseInline('a **b** and `c`')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'strong', text: 'b' },
      { type: 'text', text: ' and ' },
      { type: 'code', text: 'c' },
    ]);
  });

  it('handles emphasis, strikethrough and links', () => {
    expect(parseInline('*i* ~~d~~ [t](u)')).toEqual([
      { type: 'em', text: 'i' },
      { type: 'text', text: ' ' },
      { type: 'del', text: 'd' },
      { type: 'text', text: ' ' },
      { type: 'link', text: 't' },
    ]);
  });

  it('respects escapes instead of opening emphasis', () => {
    expect(parseInline('\\*not em\\*')).toEqual([{ type: 'text', text: '*not em*' }]);
  });

  it('returns plain text unchanged', () => {
    expect(parseInline('nothing special')).toEqual([{ type: 'text', text: 'nothing special' }]);
  });

  it('shows the toolbar’s HTML formats as formats, not as tags', () => {
    expect(parseInline('<ins>u</ins> <mark>h</mark>')).toEqual([
      { type: 'ins', text: 'u' },
      { type: 'text', text: ' ' },
      { type: 'mark', text: 'h' },
    ]);
    // `<u>` never gets written by this editor, but imported files carry it
    expect(parseInline('<u>x</u>')).toEqual([{ type: 'ins', text: 'x' }]);
  });

  it('maps a click past a hidden tag back onto the raw text', () => {
    // display "u tail" over raw "<ins>u</ins> tail"
    expect(displayToRawOffset('<ins>u</ins> tail', 1)).toBe(6);
  });
});

describe('parseInlineSpans', () => {
  it('reports the raw range each token came from', () => {
    expect(parseInlineSpans('a **b** c')).toEqual([
      { type: 'text', text: 'a ', from: 0, to: 2 },
      { type: 'strong', text: 'b', from: 2, to: 7 },
      { type: 'text', text: ' c', from: 7, to: 9 },
    ]);
  });

  it('agrees with parseInline on the token stream', () => {
    const raw = 'x `code` ~~y~~';
    expect(parseInlineSpans(raw).map(({ type, text }) => ({ type, text }))).toEqual(
      parseInline(raw),
    );
  });
});

describe('displayToRawOffset', () => {
  it('is the identity for plain text', () => {
    expect(displayToRawOffset('Frames', 0)).toBe(0);
    expect(displayToRawOffset('Frames', 3)).toBe(3);
    expect(displayToRawOffset('Frames', 6)).toBe(6);
  });

  it('skips over the markers hidden in the grid', () => {
    // display "ab c" over raw "**ab** c": display 1 sits after "a", raw index 3
    expect(displayToRawOffset('**ab** c', 1)).toBe(3);
    expect(displayToRawOffset('**ab** c', 2)).toBe(4);
  });

  it('lands past a decorated span when the click is after it', () => {
    expect(displayToRawOffset('**ab** c', 3)).toBe(7);
  });

  it('clamps out-of-range offsets', () => {
    expect(displayToRawOffset('abc', -5)).toBe(0);
    expect(displayToRawOffset('abc', 99)).toBe(3);
  });

  it('handles an empty cell', () => {
    expect(displayToRawOffset('', 0)).toBe(0);
  });
});

describe('sanitizeCellPaste', () => {
  // Round 28: pasting a nested list is the likeliest paste there is here — from
  // Confluence, from another wiki — and collapsing runs of spaces used to eat
  // exactly the indent the format encodes nesting with.
  it('keeps a pasted list nested, snapping the indent to the two-space grid', () => {
    expect(sanitizeCellPaste('- one\n    - nested\n        - deeper')).toBe(
      '- one\n  - nested\n    - deeper',
    );
    expect(sanitizeCellPaste('1. one\n\t2. two')).toBe('1. one\n  2. two');
  });

  it('still collapses the layout whitespace INSIDE a pasted item', () => {
    // sole indented item -> its own indent is one level
    expect(sanitizeCellPaste('  -    many     spaces  ')).toBe('  - many spaces');
  });

  it('does not treat prose starting with a dash as an item', () => {
    expect(sanitizeCellPaste('   -5 degrees')).toBe('-5 degrees');
  });

  it('keeps pasted line structure — cells are multi-line now', () => {
    expect(sanitizeCellPaste('one\ntwo\r\nthree')).toBe('one\ntwo\nthree');
  });

  it('collapses tabs and runs of whitespace inside a line', () => {
    expect(sanitizeCellPaste('a\t\tb   c')).toBe('a b c');
  });

  it('trims the edges of the paste and of every line', () => {
    expect(sanitizeCellPaste('  padded \n')).toBe('padded');
    expect(sanitizeCellPaste('\n  a  \n  b  \n\n')).toBe('a\nb');
  });

  it('leaves pipes alone — serialization escapes them exactly once', () => {
    expect(sanitizeCellPaste('a | b')).toBe('a | b');
    // and the round trip proves double escaping never happens
    const table = parseGfmTable('| x |\n| --- |')!;
    const written = serializeGfmTable(setCell(table, HEADER_ROW, 0, sanitizeCellPaste('a | b')));
    expect(parseGfmTable(written)?.header[0]).toBe('a | b');
  });

  it('keeps inline markdown intact', () => {
    expect(sanitizeCellPaste('**bold**\nnext')).toBe('**bold**\nnext');
  });
});

describe('cell line breaks', () => {
  it('reads every <br> spelling as a break', () => {
    expect(splitCellLines('a<br>b<br/>c<br />d<BR>e')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('round-trips text through the markdown form', () => {
    expect(cellRawToText('one<br>two')).toBe('one\ntwo');
    expect(cellTextToRaw('one\ntwo')).toBe('one<br>two');
    expect(cellTextToRaw(cellRawToText('a<br>b<br>c'))).toBe('a<br>b<br>c');
  });

  it('drops the blank edge lines a stray Enter leaves behind', () => {
    expect(cellTextToRaw('a\nb\n')).toBe('a<br>b');
    expect(cellTextToRaw('\n\na\n')).toBe('a');
    expect(cellTextToRaw('')).toBe('');
  });

  it('stays ONE pipe row in the file, which is what keeps the table valid GFM', () => {
    const table = parseGfmTable('| a | b |\n| --- | --- |\n| x | y |')!;
    const written = serializeGfmTable(setCell(table, 0, 0, cellTextToRaw('one\ntwo')));
    expect(written.split('\n')).toHaveLength(3);
    expect(written).toContain('one<br>two');
    // and it parses straight back, breaks and all
    expect(cellRawToText(parseGfmTable(written)!.rows[0][0])).toBe('one\ntwo');
  });

  it('never lets a literal newline reach the file', () => {
    const table = parseGfmTable('| a |\n| --- |')!;
    // escapeCell is the last line of defence even if a raw newline slipped in
    expect(serializeGfmTable(setCell(table, HEADER_ROW, 0, 'a\nb')).split('\n')).toHaveLength(2);
  });
});

describe('cell line structures', () => {
  it('recognises bullets, checklist items and numbers', () => {
    expect(parseCellLine('• item')).toMatchObject({ kind: 'bullet', text: 'item' });
    expect(parseCellLine('[ ] todo')).toMatchObject({ kind: 'task', text: 'todo', checked: false });
    expect(parseCellLine('[x] done')).toMatchObject({ kind: 'task', text: 'done', checked: true });
    expect(parseCellLine('2. second')).toMatchObject({ kind: 'ordered', text: 'second' });
    expect(parseCellLine('plain')).toMatchObject({ kind: 'text', text: 'plain', marker: '' });
  });

  it('reads a whole cell line by line', () => {
    expect(parseCellLines('• a<br>[x] b').map((line) => line.kind)).toEqual(['bullet', 'task']);
  });

  it('toggles one checklist line and leaves the others alone', () => {
    expect(toggleCellTask('[ ] a<br>[ ] b', 1)).toBe('[ ] a<br>[x] b');
    expect(toggleCellTask('[x] a<br>[ ] b', 0)).toBe('[ ] a<br>[ ] b');
  });

  it('refuses to write a checkbox onto a line that has none', () => {
    expect(toggleCellTask('plain<br>[ ] b', 0)).toBe('plain<br>[ ] b');
    expect(toggleCellTask('[ ] a', 9)).toBe('[ ] a');
  });

  it('continues the list Enter was pressed in', () => {
    expect(listContinuation('• item')).toBe(BULLET);
    expect(listContinuation('[x] done')).toBe(TASK_OPEN);
    expect(listContinuation('3. third')).toBe('4. ');
    expect(listContinuation('plain')).toBeNull();
  });

  it('ends the list when Enter lands on an empty item', () => {
    expect(listContinuation('• ')).toBe('');
    expect(listContinuation('[ ] ')).toBe('');
  });
});

/* ------------------------------------- round 28: lists inside a cell -- */

/**
 * Round 28's cell lists, from the editor's side. The written shape belongs to
 * markdown/tableSyntax.ts (`formatCellLines`) — these tests pin the two things
 * this file owns: which lines are read as items, and that a cell survives the
 * trip out to the editor and back unchanged unless it really was edited.
 */
describe('round 28: cell lists', () => {
  it('reads the ASCII markers a person or an importer writes', () => {
    for (const marker of ['-', '*', '+', '•', '◦', '·']) {
      expect(parseCellLine(`${marker} item`)).toMatchObject({ kind: 'bullet', text: 'item' });
    }
    // A marker needs its space: prose keeps its dashes and its numbers.
    expect(parseCellLine('-5 degrees').kind).toBe('text');
    expect(parseCellLine('term — two weeks').kind).toBe('text');
    expect(parseCellLine('2024 was the year').kind).toBe('text');
  });

  it('normalises a hand-typed list into the round-28 shape on the way to the file', () => {
    expect(cellTextToRaw('- one\n   * two\n1) three')).toBe('• one<br>  • two<br>1. three');
  });

  it('leaves a cell that has no list byte-identical', () => {
    const prose = 'term — two weeks\n-5 degrees\n2024 was the year';
    expect(cellTextToRaw(prose)).toBe('term — two weeks<br>-5 degrees<br>2024 was the year');
    expect(cellRawToText(cellTextToRaw(prose))).toBe(prose);
  });

  it('round-trips parse -> edit -> format', () => {
    const raw = '• collect requirements<br>  • by email<br>1. then<br>an ordinary line';
    // Untouched: out and back in with nothing changed writes the same bytes.
    expect(cellTextToRaw(cellRawToText(raw))).toBe(raw);

    // Edited: one item nested a level, the rest of the cell unchanged.
    const lines = cellRawToText(raw).split('\n');
    lines[1] = shiftCellIndent(lines[1], 1)!;
    expect(cellTextToRaw(lines.join('\n'))).toBe(
      '• collect requirements<br>    • by email<br>1. then<br>an ordinary line',
    );
  });

  it('keeps a checklist item an item — box, state and level', () => {
    expect(cellTextToRaw('[ ] todo\n  [x] done')).toBe('[ ] todo<br>  [x] done');
    // A checklist line is a list line: Enter continues it, Tab nests it.
    expect(listContinuation('[x] done')).toBe(TASK_OPEN);
    expect(shiftCellIndent('[ ] todo', 1)).toBe('  [ ] todo');
    expect(cellTextToRaw('[ ] todo\n   [x] done')).toBe('[ ] todo<br>  [x] done');
  });

  it('renumbers each ordered run from one, the way the contract says', () => {
    // Nesting does not end the outer run; a paragraph does.
    expect(cellTextToRaw('3. a\n  1. n\n7. b\ntext\n9. c')).toBe(
      '1. a<br>  1. n<br>2. b<br>text<br>1. c',
    );
  });

  it('reads a list deeper than Tab builds instead of flattening it', () => {
    expect(parseCellLine('      • fourth level').indent).toBe(3);
    expect(cellTextToRaw('• a\n      • d')).toBe('• a<br>      • d');
  });

  it('will not let Tab push past three levels, nor drag a deeper item back', () => {
    expect(shiftCellIndent('• a', 1)).toBe('  • a');
    expect(shiftCellIndent('    • a', 1)).toBe('    • a');
    // An imported item at level four stays where it is; only Shift+Tab moves it.
    expect(shiftCellIndent('      • a', 1)).toBe('      • a');
    expect(shiftCellIndent('      • a', -1)).toBe('    • a');
    expect(shiftCellIndent('plain', 1)).toBeNull();
  });
});

describe('moveColumn / moveRow', () => {
  const table = parseGfmTable(
    ['| a | b | c |', '| --- | :-: | ---: |', '| 1 | 2 | 3 |'].join('\n'),
  )!;

  it('carries the header, the alignment and every body cell along', () => {
    const moved = moveColumn(table, 0, 2);
    expect(moved.header).toEqual(['b', 'c', 'a']);
    expect(moved.align).toEqual(['center', 'right', null]);
    expect(moved.rows[0]).toEqual(['2', '3', '1']);
  });

  it('swaps neighbours when dragged one place', () => {
    const moved = moveColumn(table, 1, 0);
    expect(moved.header).toEqual(['b', 'a', 'c']);
    expect(moved.rows[0]).toEqual(['2', '1', '3']);
  });

  it('clamps out-of-range drops and ignores a no-op', () => {
    expect(moveColumn(table, 0, 99).header).toEqual(['b', 'c', 'a']);
    expect(moveColumn(table, 1, 1)).toBe(table);
    expect(moveColumn(table, 9, 0)).toBe(table);
  });

  it('moves rows the same way', () => {
    const wide = parseGfmTable('| a |\n| --- |\n| 1 |\n| 2 |\n| 3 |')!;
    expect(moveRow(wide, 2, 0).rows).toEqual([['3'], ['1'], ['2']]);
    expect(moveRow(wide, 0, 0)).toBe(wide);
  });

  it('never mutates the input', () => {
    const before = JSON.stringify(table);
    moveColumn(table, 0, 2);
    moveRow(table, 0, 0);
    expect(JSON.stringify(table)).toBe(before);
  });
});

describe('setAlign', () => {
  const table = parseGfmTable('| a | b |\n| --- | --- |')!;

  it('sets one column outright', () => {
    expect(setAlign(table, 1, 'center').align).toEqual([null, 'center']);
  });

  it('is a no-op for the alignment already in force', () => {
    expect(setAlign(table, 0, null)).toBe(table);
    expect(setAlign(table, 9, 'left')).toBe(table);
  });
});

/** The owner, 17.09: pasted an address into a cell — it stayed ordinary text. */
describe('parseInlineSpans: bare addresses', () => {
  it('makes a link out of an address without markdown markup', () => {
    const url = 'https://example.com/blog/how-to-choose-a-development-team';
    const link = parseInlineSpans(`Guide - ${url}`).find((span) => span.type === 'link');

    expect(link?.target).toBe(url);
    expect(link?.text).toBe(url);
  });

  it('does not pull trailing punctuation into the address', () => {
    const link = parseInlineSpans('see https://example.com/a.').find((span) => span.type === 'link');

    expect(link?.target).toBe('https://example.com/a');
  });

  it('a markdown link stays as it was', () => {
    const link = parseInlineSpans('[here](https://example.com)').find((span) => span.type === 'link');

    expect(link?.target).toBe('https://example.com');
    expect(link?.text).toBe('here');
  });

  it('reads a <…> destination whole, parentheses and all', () => {
    const raw = 'see [page](<https://example.com/a(1)>) now';
    const spans = parseInlineSpans(raw);
    const link = spans.find((span) => span.type === 'link');

    expect(link?.text).toBe('page');
    expect(link?.target).toBe('<https://example.com/a(1)>');
    expect(raw.slice(link!.from, link!.to)).toBe('[page](<https://example.com/a(1)>)');
    expect(spans.at(-1)).toMatchObject({ type: 'text', text: ' now' });
  });
});
