import { describe, expect, it } from 'vitest';
import type { TableColumn, TableRow, TableView } from '../contracts.js';

import { dumpTableYaml, isTableYamlParseError, parseTableYaml, type TableYamlDoc } from './yaml.js';

const columns: TableColumn[] = [
  { id: 'week', name: 'Week', type: 'select', options: [{ value: 'W8', color: 'blue' }] },
  { id: 'owner', name: 'Owner', type: 'user' },
];

const views: TableView[] = [
  {
    id: 'all',
    name: 'All entries',
    columns: { hidden: [], order: [], width: {} },
    sort: [],
    filter: { op: 'and', rules: [] },
    frozen: 0,
    rowHeight: 'short',
  },
];

const rows: TableRow[] = [
  { id: 'r7k2mq4a', values: { week: 'W8', owner: 'sk' } },
  { id: 'r7k2mq4b', values: { week: null, owner: null } },
];

const doc: TableYamlDoc = {
  meta: { id: '01JCXYZ8Q0W3M4E5R6', version: 1, rowIds: 'column' },
  columns,
  views,
  rows,
};

describe('yaml: canonical dump/parse round trip (spec §10)', () => {
  it('export -> import gives back an identical table', () => {
    const text = dumpTableYaml(doc);
    const parsed = parseTableYaml(text);
    expect(isTableYamlParseError(parsed)).toBe(false);
    if (isTableYamlParseError(parsed)) throw new Error(parsed.message);
    expect(parsed).toEqual(doc);
  });

  it('round-trips long descriptions without lossy line-folding', () => {
    const longDescription = 'A'.repeat(200) + ' a column description, long enough to check lineWidth: -1';
    const withDescription: TableYamlDoc = {
      ...doc,
      columns: [{ ...columns[0], description: longDescription }, columns[1]],
    };
    const parsed = parseTableYaml(dumpTableYaml(withDescription));
    expect(isTableYamlParseError(parsed)).toBe(false);
    if (isTableYamlParseError(parsed)) throw new Error(parsed.message);
    expect(parsed.columns[0].description).toBe(longDescription);
  });
});

describe('yaml: error handling', () => {
  it('malformed YAML syntax returns a TableParseError', () => {
    const result = parseTableYaml('meta: [1, 2\ncolumns: []');
    expect(isTableYamlParseError(result)).toBe(true);
  });

  it('valid YAML that does not match the table shape returns a TableParseError', () => {
    const result = parseTableYaml('foo: bar\n');
    expect(isTableYamlParseError(result)).toBe(true);
  });

  it('a column with an invalid id fails validation', () => {
    const bad: TableYamlDoc = { ...doc, columns: [{ ...columns[0], id: 'NOT VALID' }] };
    const result = parseTableYaml(dumpTableYaml(bad));
    expect(isTableYamlParseError(result)).toBe(true);
  });
});
