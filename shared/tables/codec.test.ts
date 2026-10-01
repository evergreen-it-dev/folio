import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import type { TableColumn, TableDoc, TableRow, TableView } from '../contracts.js';
import { isTableParseError, parseTableFile, serializeTableFile } from './codec.js';

const ALL_NINE_COLUMNS: TableColumn[] = [
  { id: 'text_c', name: 'Text', type: 'text' },
  { id: 'longtext_c', name: 'Longtext', type: 'longtext' },
  { id: 'number_c', name: 'Number', type: 'number', precision: 1 },
  { id: 'date_c', name: 'Date', type: 'date' },
  { id: 'checkbox_c', name: 'Done', type: 'checkbox' },
  {
    id: 'select_c',
    name: 'Select',
    type: 'select',
    multiple: true,
    options: [
      { value: 'Discovery', color: 'blue' },
      { value: 'Delivery, extra', color: 'green' },
    ],
  },
  {
    id: 'status_c',
    name: 'Status',
    type: 'status',
    options: [
      { value: 'IN PROG', color: 'blue' },
      { value: 'DONE', color: 'green' },
    ],
  },
  { id: 'user_c', name: 'Owner', type: 'user' },
  { id: 'link_c', name: 'Link', type: 'link' },
];

const ALL_NINE_VIEWS: TableView[] = [
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

function makeDoc(overrides: Partial<TableDoc> = {}): TableDoc {
  const rows: TableRow[] = [
    {
      id: 'r7k2mq4a',
      values: {
        text_c: 'Hello | world',
        longtext_c: 'line one\nline two',
        number_c: -1234.5,
        date_c: '2026-08-26',
        checkbox_c: true,
        select_c: ['Discovery', 'Delivery, extra'],
        status_c: 'IN PROG',
        user_c: 'sk',
        link_c: '[Folio](https://example.com/folio)',
      },
    },
    {
      id: 'r7k2mq4b',
      values: {
        text_c: null,
        longtext_c: null,
        number_c: null,
        date_c: null,
        checkbox_c: false,
        select_c: [],
        status_c: null,
        user_c: null,
        link_c: null,
      },
    },
  ];

  return {
    meta: { id: '01JCXYZ8Q0W3M4E5R6', version: 1, rowIds: 'column' },
    head: '\n# Weekly plan\n\nOptional descriptive text above the table.\n\n',
    tail: '\nThe text below the table is kept too.\n',
    columns: ALL_NINE_COLUMNS,
    views: ALL_NINE_VIEWS,
    rows,
    ...overrides,
  };
}

describe('codec: round trip', () => {
  it('parse(serialize(doc)) deep-equals doc, including head/tail byte-for-byte', () => {
    const doc = makeDoc();
    const file = serializeTableFile(doc);
    const reparsed = parseTableFile(file);
    expect(isTableParseError(reparsed)).toBe(false);
    if (isTableParseError(reparsed)) throw new Error(reparsed.message);
    expect(reparsed).toEqual(doc);
    // explicit byte-for-byte checks on the prose, per the brief
    expect(reparsed.head).toBe(doc.head);
    expect(reparsed.tail).toBe(doc.tail);
  });

  it('round-trips with empty head and tail', () => {
    const doc = makeDoc({ head: '', tail: '' });
    const reparsed = parseTableFile(serializeTableFile(doc));
    expect(isTableParseError(reparsed)).toBe(false);
    if (isTableParseError(reparsed)) throw new Error(reparsed.message);
    expect(reparsed).toEqual(doc);
  });

  it('round-trips with zero data rows', () => {
    const doc = makeDoc({ rows: [] });
    const reparsed = parseTableFile(serializeTableFile(doc));
    expect(isTableParseError(reparsed)).toBe(false);
    if (isTableParseError(reparsed)) throw new Error(reparsed.message);
    expect(reparsed.rows).toEqual([]);
  });

  it('rowIds: none omits the id column and reassigns fresh ids on parse (documented limitation, spec §2.5)', () => {
    const doc = makeDoc({ meta: { id: '01JCXYZ8Q0W3M4E5R6', version: 1, rowIds: 'none' } });
    const file = serializeTableFile(doc);
    expect(file).not.toContain('| id |');
    const reparsed = parseTableFile(file);
    expect(isTableParseError(reparsed)).toBe(false);
    if (isTableParseError(reparsed)) throw new Error(reparsed.message);
    // values survive by position even though ids are regenerated
    expect(reparsed.rows.map((r) => r.values)).toEqual(doc.rows.map((r) => r.values));
    expect(reparsed.rows[0].id).not.toBe(doc.rows[0].id);
    expect(new Set(reparsed.rows.map((r) => r.id)).size).toBe(reparsed.rows.length);
  });
});

describe('codec: GFM compatibility (spec §2.1 — R17 rule)', () => {
  it('the serialized file is a valid GFM table with the same row/column count', async () => {
    const doc = makeDoc();
    const file = serializeTableFile(doc);

    const tree = unified().use(remarkParse).use(remarkGfm).parse(file);
    let tableNode: { children: unknown[] } | undefined;
    visit(tree, 'table', (node) => {
      tableNode = node as { children: unknown[] };
    });
    expect(tableNode).toBeDefined();
    // header row + 2 data rows = 3 rows total
    expect(tableNode!.children.length).toBe(1 + doc.rows.length);
    const headerRow = tableNode!.children[0] as { children: unknown[] };
    // 9 data columns + 1 hidden id column
    expect(headerRow.children.length).toBe(doc.columns.length + 1);
  });

  it('is still a valid GFM table when rowIds is none (no id column)', () => {
    const doc = makeDoc({ meta: { id: '01JCXYZ8Q0W3M4E5R6', version: 1, rowIds: 'none' } });
    const file = serializeTableFile(doc);
    const tree = unified().use(remarkParse).use(remarkGfm).parse(file);
    let tableNode: { children: unknown[] } | undefined;
    visit(tree, 'table', (node) => {
      tableNode = node as { children: unknown[] };
    });
    expect(tableNode).toBeDefined();
    const headerRow = tableNode!.children[0] as { children: unknown[] };
    expect(headerRow.children.length).toBe(doc.columns.length);
  });
});

describe('codec: escaping', () => {
  it('escapes a literal | in a cell as \\|', () => {
    const doc = makeDoc();
    const file = serializeTableFile(doc);
    expect(file).toContain('Hello \\| world');
  });

  it('converts longtext newlines to <br>', () => {
    const doc = makeDoc();
    const file = serializeTableFile(doc);
    expect(file).toContain('line one<br>line two');
    expect(file).not.toMatch(/line one\nline two/);
  });

  it('quotes a multiselect label containing a comma', () => {
    const doc = makeDoc();
    const file = serializeTableFile(doc);
    expect(file).toContain('Discovery, "Delivery, extra"');
  });
});

describe('codec: row ids', () => {
  it('a row with no id in the file gets a freshly generated 8-char id, and no row is dropped', () => {
    const doc = makeDoc();
    const columns = doc.columns;
    const file = [
      '---',
      'folio: table',
      'version: 1',
      'id: 01JCXYZ8Q0W3M4E5R6',
      `columns: ${JSON.stringify(columns)}`,
      `views: ${JSON.stringify(doc.views)}`,
      'options:',
      '  rowIds: column',
      '---',
      '',
      '<!-- folio:table:begin -->',
      '',
      `| ${columns.map((c) => c.name).join(' | ')} | id |`,
      `| ${columns.map(() => '---').join(' | ')} | --- |`,
      `| ${columns.map(() => 'x').join(' | ')} |  |`,
      '',
      '<!-- folio:table:end -->',
      '',
    ].join('\n');
    const parsed = parseTableFile(file);
    expect(isTableParseError(parsed)).toBe(false);
    if (isTableParseError(parsed)) throw new Error(parsed.message);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].id).toMatch(/^[a-z0-9]{8}$/);
  });

  it('an unrecognized select value is preserved as-is, not dropped or nulled', () => {
    const doc = makeDoc();
    doc.rows[0].values.status_c = 'TOTALLY_UNKNOWN';
    const file = serializeTableFile(doc);
    const parsed = parseTableFile(file);
    expect(isTableParseError(parsed)).toBe(false);
    if (isTableParseError(parsed)) throw new Error(parsed.message);
    expect(parsed.rows[0].values.status_c).toBe('TOTALLY_UNKNOWN');
  });
});

describe('codec: git-diff friendliness (spec §2.6 acceptance criterion)', () => {
  it('changing one cell changes exactly one line of the serialized file', () => {
    const doc = makeDoc();
    const before = serializeTableFile(doc).split('\n');

    const changed = makeDoc();
    changed.rows[0].values.text_c = 'A brand new value';
    const after = serializeTableFile(changed).split('\n');

    expect(after.length).toBe(before.length);
    const diffLines = before.filter((line, i) => line !== after[i]);
    expect(diffLines).toHaveLength(1);
  });

  it('adding one row adds exactly one line', () => {
    const doc = makeDoc();
    const before = serializeTableFile(doc).split('\n');

    const withExtraRow = makeDoc();
    withExtraRow.rows.push({
      id: 'r7k2mq4c',
      values: {
        text_c: 'New row', longtext_c: null, number_c: null, date_c: null,
        checkbox_c: false, select_c: [], status_c: null, user_c: null, link_c: null,
      },
    });
    const after = serializeTableFile(withExtraRow).split('\n');

    expect(after.length).toBe(before.length + 1);
  });
});

describe('codec: malformed frontmatter never silently drops rows — returns TableParseError instead', () => {
  it('missing folio: table marker', () => {
    const result = parseTableFile('---\nfoo: 1\n---\nbody');
    expect(isTableParseError(result)).toBe(true);
  });

  it('broken YAML syntax', () => {
    const result = parseTableFile('---\nfoo: [1, 2\n---\nbody');
    expect(isTableParseError(result)).toBe(true);
  });

  it('invalid column definition (bad id pattern)', () => {
    const file = [
      '---',
      'folio: table',
      'version: 1',
      'id: x',
      'columns:',
      '  - id: "NOT VALID"',
      '    name: Bad',
      '    type: text',
      'views: []',
      'options:',
      '  rowIds: column',
      '---',
      '<!-- folio:table:begin -->',
      '| Bad | id |',
      '| --- | --- |',
      '| v | r0000001 |',
      '<!-- folio:table:end -->',
    ].join('\n');
    const result = parseTableFile(file);
    expect(isTableParseError(result)).toBe(true);
    if (isTableParseError(result)) expect(result.message.toLowerCase()).toContain('columns');
  });

  it('missing begin/end markers', () => {
    const doc = makeDoc();
    const file = serializeTableFile(doc).replace('<!-- folio:table:end -->', '');
    const result = parseTableFile(file);
    expect(isTableParseError(result)).toBe(true);
  });

  it('a data row with the wrong number of cells fails the whole parse rather than being dropped', () => {
    const doc = makeDoc();
    const file = serializeTableFile(doc).replace(/\| r7k2mq4a \|$/m, '| extra | r7k2mq4a |');
    const result = parseTableFile(file);
    expect(isTableParseError(result)).toBe(true);
  });

  it('a blank line inside the table block (would split it into two GFM tables) fails the parse', () => {
    const file = [
      '---',
      'folio: table',
      'version: 1',
      'id: x',
      'columns: []',
      'views: []',
      'options:',
      '  rowIds: none',
      '---',
      '<!-- folio:table:begin -->',
      '| id |',
      '| --- |',
      '',
      '| oops |',
      '<!-- folio:table:end -->',
    ].join('\n');
    const result = parseTableFile(file);
    expect(isTableParseError(result)).toBe(true);
  });
});
