import { describe, expect, it } from 'vitest';
import { cellHasList, formatCellLines, parseCellLines, splitCellBreaks } from './tableSyntax';

describe('round 28: lists inside a table cell', () => {
  it('reads bullets, numbers and nesting out of one cell', () => {
    // Both the round-17 bullet and plain ASCII markers have to read the same.
    const lines = parseCellLines('• collect requirements<br>- agree<br>  • by email<br>1. then<br>an ordinary line');
    expect(lines.map((l) => ({ depth: l.depth, marker: l.marker, text: l.text }))).toEqual([
      { depth: 1, marker: 'ul', text: 'collect requirements' },
      { depth: 1, marker: 'ul', text: 'agree' },
      { depth: 2, marker: 'ul', text: 'by email' },
      { depth: 1, marker: 'ol', text: 'then' },
      { depth: 0, marker: null, text: 'an ordinary line' },
    ]);
  });

  it('round-trips', () => {
    const src = '• a<br>  • b<br>1. c<br>plain';
    expect(formatCellLines(parseCellLines(src))).toBe(src);
  });

  it('treats a cell with no markers as plain lines', () => {
    expect(cellHasList('first line<br>second')).toBe(false);
    expect(parseCellLines('first<br>second').every((l) => l.marker === null)).toBe(true);
  });

  it('does not mistake a dash inside prose for a bullet', () => {
    // no space after the dash -> not a marker; an em-dash mid-sentence likewise
    expect(cellHasList('-5 degrees')).toBe(false);
    expect(cellHasList('term — two weeks')).toBe(false);
  });

  it('accepts the <br> spellings a real file contains', () => {
    expect(splitCellBreaks('a<br>b<br/>c<BR />d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps inline markdown inside the item untouched', () => {
    expect(parseCellLines('- **bold** and a [link](x.md)')[0].text).toBe('**bold** and a [link](x.md)');
  });
});

describe('round 28 contract gaps closed after the renderer zone reported them', () => {
  it('knows round 21 checklists, so an edit no longer demotes them to prose', () => {
    const src = '[ ] not done<br>[x] done';
    const lines = parseCellLines(src);
    expect(lines.map((l) => [l.marker, l.checked])).toEqual([
      ['task', false],
      ['task', true],
    ]);
    expect(formatCellLines(lines)).toBe(src); // the round-trip that used to lose them
  });

  it('renumbers ordered runs so a plain GFM reader sees 1. 2. 3., not 1. 1. 1.', () => {
    const lines = parseCellLines('5. five<br>9. nine<br>2. two');
    expect(lines.map((l) => l.ordinal)).toEqual([5, 9, 2]);
    expect(formatCellLines(lines)).toBe('1. five<br>2. nine<br>3. two');
  });

  it('restarts numbering after the run is broken, and per nesting level', () => {
    const src = '1. one<br>  1. nested<br>  2. more<br>2. two<br>ordinary<br>1. a new list';
    expect(formatCellLines(parseCellLines(src))).toBe(src);
  });

  it('reports the marker width so a hast renderer can cut the prefix exactly', () => {
    const [bullet, nested, task, plain] = parseCellLines('• a<br>  1. b<br>[x] c<br>plain');
    expect(bullet.markerWidth).toBe(2); // "• "
    expect(nested.markerWidth).toBe(5); // "  1. "
    expect(task.markerWidth).toBe(4); // "[x] "
    expect(plain.markerWidth).toBe(0);
  });
});

describe('round 28: markers the editor and importers actually write', () => {
  it('accepts the legacy · bullet the round-17 editor has always taken', () => {
    // Refusing it is not cosmetic: the line becomes a paragraph, and the next
    // edit writes that demotion back to the file.
    const lines = parseCellLines('· an old marker<br>  · nested');
    expect(lines.map((l) => [l.marker, l.depth, l.text])).toEqual([
      ['ul', 1, 'an old marker'],
      ['ul', 2, 'nested'],
    ]);
    expect(formatCellLines(lines)).toBe('• an old marker<br>  • nested'); // normalised on write
  });

  it('reads a checklist both bare and GFM-style behind a bullet', () => {
    expect(parseCellLines('[x] done')[0]).toMatchObject({ marker: 'task', checked: true });
    expect(parseCellLines('- [ ] not done')[0]).toMatchObject({ marker: 'task', checked: false, depth: 1 });
    expect(parseCellLines('  - [x] nested')[0]).toMatchObject({ marker: 'task', checked: true, depth: 2 });
    // and the bullet-prefixed form normalises to the one the editor writes
    expect(formatCellLines(parseCellLines('- [ ] a<br>- [x] b'))).toBe('[ ] a<br>[x] b');
  });
});
