import { describe, expect, it } from 'vitest';
import type { TableColumn, TableRow } from '../contracts.js';
import {
  gridToTableValues,
  inferColumns,
  parseCsv,
  parseDelimited,
  parseTsv,
  stringifyCsv,
  stringifyTsv,
  tableToGrid,
} from './csv.js';
import { NO_WORDS, YES_WORDS } from './booleanWords.js';

describe('csv: RFC 4180 parse/stringify round trip', () => {
  it('round-trips plain fields', () => {
    const grid = [
      ['Week', 'Owner', 'Task'],
      ['W8', '@sk', 'Hand over the rollout project'],
    ];
    const text = stringifyCsv(grid);
    expect(parseCsv(text)).toEqual(grid);
  });

  it('quotes and round-trips a field containing the delimiter, a quote, and a newline', () => {
    const grid = [['a, b', 'she said "hi"', 'line1\nline2']];
    const text = stringifyCsv(grid);
    expect(text).toContain('"a, b"');
    expect(parseCsv(text)).toEqual(grid);
  });

  it('TSV uses tabs and survives a field containing a comma', () => {
    const grid = [['a,b', 'c']];
    const text = stringifyTsv(grid);
    expect(text).toBe('a,b\tc\r\n');
    expect(parseTsv(text)).toEqual(grid);
  });

  it('parses CRLF and bare LF line endings the same way', () => {
    expect(parseDelimited('a,b\r\nc,d\r\n')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseDelimited('a,b\nc,d\n')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('handles a doubled quote inside a quoted field', () => {
    expect(parseCsv('"she said ""hi"""\n')).toEqual([['she said "hi"']]);
  });
});

describe('csv: TableRow[] <-> grid', () => {
  const cols: TableColumn[] = [
    { id: 'week', name: 'Week', type: 'text' },
    { id: 'status', name: 'Status', type: 'status', options: [{ value: 'DONE', color: 'green' }] },
  ];
  const rows: TableRow[] = [{ id: 'r1', values: { week: 'W8', status: 'DONE' } }];

  it('tableToGrid produces a header + data rows, id omitted by default', () => {
    const grid = tableToGrid(cols, rows);
    expect(grid).toEqual([['Week', 'Status'], ['W8', 'DONE']]);
  });

  it('tableToGrid includes the id column when asked', () => {
    const grid = tableToGrid(cols, rows, { includeId: true });
    expect(grid).toEqual([['Week', 'Status', 'id'], ['W8', 'DONE', 'r1']]);
  });

  it('gridToTableValues decodes data rows back by column position', () => {
    const values = gridToTableValues(cols, [['W9', 'IN PROG']]);
    expect(values).toEqual([{ week: 'W9', status: 'IN PROG' }]);
  });
});

describe('csv: inferColumns (spec §10.1)', () => {
  it('infers status from the preset labels', () => {
    const rows = [['Status'], ...Array(21).fill(['DONE']), ['IN PROG']];
    const [col] = inferColumns(rows);
    expect(col.type).toBe('status');
  });

  it('infers user from @handle values', () => {
    const rows = [['Owner'], ['@sk'], ['@va'], ['@sk']];
    const [col] = inferColumns(rows);
    expect(col.type).toBe('user');
  });

  it('infers date from ISO and dd.mm.yyyy formats', () => {
    const rows = [['Due'], ['2026-08-26'], ['26.08.2026']];
    const [col] = inferColumns(rows);
    expect(col.type).toBe('date');
  });

  it('infers number, keeping decimal precision in mind', () => {
    const rows = [['Points'], ['1'], ['2.5'], ['-3']];
    const [col] = inferColumns(rows);
    expect(col.type).toBe('number');
  });

  it('infers checkbox from [x]/[ ]/true/false/yes/no and the localized words', () => {
    const rows = [['Done'], ['[x]'], ['[ ]'], ['true'], ['false'], ...YES_WORDS.map((word) => [word]), ...NO_WORDS.map((word) => [word])];
    const [col] = inferColumns(rows);
    expect(col.type).toBe('checkbox');
  });

  it('infers link from URLs', () => {
    const rows = [['Ref'], ['https://example.com/a'], ['https://example.com/b']];
    const [col] = inferColumns(rows);
    expect(col.type).toBe('link');
  });

  it('infers select when distinct values <= 12, rows >= 20, and label length <= 40', () => {
    const values = ['Discovery', 'Delivery', 'QA'];
    const rows = [['Stage'], ...Array.from({ length: 20 }, (_, i) => [values[i % values.length]])];
    const [col] = inferColumns(rows);
    expect(col.type).toBe('select');
    expect(col.options?.length).toBe(3);
  });

  it('does NOT infer select when there are fewer than 20 rows, even with few distinct values', () => {
    const rows = [['Stage'], ['A'], ['B'], ['A']];
    const [col] = inferColumns(rows);
    expect(col.type).not.toBe('select');
  });

  it('infers longtext when a value has embedded newlines or exceeds 120 chars', () => {
    const long = 'x'.repeat(121);
    const rows = [['Notes'], [long]];
    const [col] = inferColumns(rows);
    expect(col.type).toBe('longtext');
  });

  it('falls back to text when nothing else matches', () => {
    const rows = [['Misc'], ['just some free text'], ['another one']];
    const [col] = inferColumns(rows);
    expect(col.type).toBe('text');
  });

  it('an all-empty column defaults to text', () => {
    const rows = [['Empty'], [''], ['']];
    const [col] = inferColumns(rows);
    expect(col.type).toBe('text');
  });

  it('generates stable, unique, spec-shaped column ids from header names', () => {
    const rows = [['Week Plan', 'Week Plan'], ['a', 'b']];
    const cols = inferColumns(rows);
    expect(cols[0].id).toMatch(/^[a-z0-9_]{1,32}$/);
    expect(cols[1].id).toMatch(/^[a-z0-9_]{1,32}$/);
    expect(cols[0].id).not.toBe(cols[1].id);
  });
});
