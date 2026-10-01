import { describe, expect, it } from 'vitest';
import type { TableColumn, TableRow } from '@shared/contracts';
import { exportFilename, serializeExport, toDelimited, toMarkdown } from './export';
import { makeMockTableDoc } from './fixtures';

/**
 * Round 26 (DATA TABLES) — export serialisers (spec §10).
 *
 * The quoting/escaping cases below are the ones that corrupt a spreadsheet
 * silently rather than failing loudly, which is why each gets its own test:
 * an unquoted comma shifts every later column by one, and an unescaped pipe
 * ends a markdown cell early.
 */

const doc = makeMockTableDoc();

const columns: TableColumn[] = [
  { id: 'a', name: 'A', type: 'text' },
  { id: 'b', name: 'B', type: 'text' },
];

function rows(...values: Record<string, unknown>[]): TableRow[] {
  return values.map((value, index) => ({ id: `r${index}`, values: value as TableRow['values'] }));
}

describe('CSV (RFC 4180)', () => {
  it('quotes a field containing the delimiter and doubles embedded quotes', () => {
    const csv = toDelimited(
      { doc, columns, rows: rows({ a: 'x, y', b: 'say "hi"' }) },
      ',',
    );
    expect(csv).toContain('"x, y"');
    expect(csv).toContain('"say ""hi"""');
  });

  it('quotes a field containing a newline, so the row is not split', () => {
    const csv = toDelimited({ doc, columns, rows: rows({ a: 'one\ntwo', b: '' }) }, ',');
    expect(csv).toContain('"one\ntwo"');
  });

  it('quotes the HEADER too — a column named with a comma would shift every column', () => {
    const csv = toDelimited(
      { doc, columns: [{ id: 'a', name: 'Goal, Subgoal', type: 'text' }], rows: [] },
      ',',
    );
    expect(csv.split('\r\n')[0]).toBe('"Goal, Subgoal"');
  });

  it('leaves a plain field unquoted', () => {
    const csv = toDelimited({ doc, columns, rows: rows({ a: 'plain', b: 'also' }) }, ',');
    expect(csv).toContain('plain,also');
  });

  it('uses CRLF line endings', () => {
    const csv = toDelimited({ doc, columns, rows: rows({ a: '1', b: '2' }) }, ',');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('appends the id column only when asked (spec §10)', () => {
    const withIds = toDelimited({ doc, columns, rows: rows({ a: '1', b: '2' }), includeIds: true }, ',');
    expect(withIds.split('\r\n')[0]).toBe('A,B,id');
    const without = toDelimited({ doc, columns, rows: rows({ a: '1', b: '2' }) }, ',');
    expect(without.split('\r\n')[0]).toBe('A,B');
  });

  it('does not quote a comma-containing field in TSV, where a tab is the delimiter', () => {
    const tsv = toDelimited({ doc, columns, rows: rows({ a: 'x, y', b: '' }) }, '\t');
    expect(tsv).toContain('x, y');
  });
});

describe('Markdown', () => {
  it('escapes a pipe so the cell does not end early', () => {
    const md = toMarkdown({ doc, columns, rows: rows({ a: 'a|b', b: 'c' }) });
    expect(md).toContain('a\\|b');
  });

  it('converts newlines to <br>, matching the file convention', () => {
    const md = toMarkdown({ doc, columns, rows: rows({ a: 'one\ntwo', b: '' }) });
    expect(md).toContain('one<br>two');
  });

  it('emits a GFM alignment row reflecting the column align', () => {
    const md = toMarkdown({
      doc,
      columns: [{ id: 'n', name: 'N', type: 'number', align: 'right' }],
      rows: [],
    });
    expect(md.split('\n')[1]).toBe('| ---: |');
  });
});

describe('serializeExport', () => {
  it('produces parseable JSON with the canonical shape', () => {
    const json = JSON.parse(serializeExport('json', { doc, rows: doc.rows, columns: doc.columns }));
    expect(Object.keys(json).sort()).toEqual(['columns', 'meta', 'rows', 'views']);
    expect(json.rows).toHaveLength(doc.rows.length);
  });

  it('emits YAML with quoted strings, so a value like NO cannot parse as a boolean', () => {
    const yaml = serializeExport('yaml', { doc, rows: doc.rows, columns: doc.columns });
    expect(yaml).toContain('meta:');
    expect(yaml).toContain('rows:');
    expect(yaml).toContain('"01JCXYZ8Q0W3M4E5R6"');
  });

  it('escapes a double quote when emitting YAML', () => {
    const yaml = serializeExport('yaml', {
      doc,
      columns: [{ id: 'a', name: 'A', type: 'text' }],
      rows: rows({ a: 'say "hi"' }),
    });
    expect(yaml).toContain('\\"hi\\"');
  });
});

describe('exportFilename', () => {
  it('slugifies the title and appends the format', () => {
    expect(exportFilename('Weekly plan', 'csv')).toBe('Weekly-plan.csv');
  });

  it('strips characters no filesystem accepts', () => {
    expect(exportFilename('a/b:c*d?', 'md')).toBe('a-b-c-d-.md');
  });

  it('falls back to a name rather than producing a bare extension', () => {
    expect(exportFilename('   ', 'json')).toBe('table.json');
  });
});
