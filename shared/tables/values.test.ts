import { describe, expect, it } from 'vitest';
import type { TableColumn } from '../contracts.js';
import {
  convertColumnType,
  convertMultipleToSingle,
  decodeCell,
  defaultCellValue,
  encodeCell,
  formatLinkValue,
  getOutOfListLabels,
  isEmptyCellValue,
  parseLinkValue,
} from './values.js';

function col(partial: Partial<TableColumn> & { id: string; type: TableColumn['type'] }): TableColumn {
  return { name: partial.id, ...partial } as TableColumn;
}

describe('values: encode/decode round trip per column type (empty | ordinary | edge case)', () => {
  it('text', () => {
    const c = col({ id: 'a', type: 'text' });
    expect(decodeCell(c, encodeCell(c, null))).toBeNull();
    expect(decodeCell(c, encodeCell(c, 'Hello world'))).toBe('Hello world');
    // edge: contains a literal pipe (escaping is codec.ts's job, not values.ts's)
    expect(encodeCell(c, 'a | b')).toBe('a | b');
    expect(decodeCell(c, 'a | b')).toBe('a | b');
  });

  it('longtext', () => {
    const c = col({ id: 'a', type: 'longtext' });
    expect(decodeCell(c, encodeCell(c, null))).toBeNull();
    expect(decodeCell(c, encodeCell(c, 'one line'))).toBe('one line');
    // edge: embedded newlines AND a pipe
    const edge = 'line one\nline two | with pipe\nline three';
    const encoded = encodeCell(c, edge);
    expect(encoded).toBe('line one<br>line two | with pipe<br>line three');
    expect(encoded.includes('\n')).toBe(false);
    expect(decodeCell(c, encoded)).toBe(edge);
  });

  it('number', () => {
    const c = col({ id: 'a', type: 'number' });
    expect(decodeCell(c, encodeCell(c, null))).toBeNull();
    expect(decodeCell(c, encodeCell(c, 42))).toBe(42);
    // edge: negative, decimal, precision boundary
    expect(encodeCell(c, -1234.5)).toBe('-1234.5');
    expect(decodeCell(c, '-1234.5')).toBe(-1234.5);
    const withPrecision = col({ id: 'a', type: 'number', precision: 2 });
    expect(encodeCell(withPrecision, 1)).toBe('1.00');
    expect(decodeCell(withPrecision, '1.00')).toBe(1);
    expect(encodeCell(withPrecision, 1.005)).toBe((1.005).toFixed(2));
  });

  it('date', () => {
    const c = col({ id: 'a', type: 'date' });
    expect(decodeCell(c, encodeCell(c, null))).toBeNull();
    expect(decodeCell(c, encodeCell(c, '2026-08-26'))).toBe('2026-08-26');
    const withTime = col({ id: 'a', type: 'date', time: true });
    expect(decodeCell(withTime, encodeCell(withTime, '2026-08-26T14:30'))).toBe('2026-08-26T14:30');
  });

  it('checkbox', () => {
    const c = col({ id: 'a', type: 'checkbox' });
    expect(encodeCell(c, false)).toBe('[ ]');
    expect(decodeCell(c, '[ ]')).toBe(false);
    expect(encodeCell(c, true)).toBe('[x]');
    expect(decodeCell(c, '[x]')).toBe(true);
    // edge: case-insensitive recognition of [X]
    expect(decodeCell(c, '[X]')).toBe(true);
    expect(decodeCell(c, '')).toBe(false);
  });

  it('select (single)', () => {
    const c = col({ id: 'a', type: 'select', options: [{ value: 'A', color: 'blue' }, { value: 'B', color: 'green' }] });
    expect(decodeCell(c, encodeCell(c, null))).toBeNull();
    expect(decodeCell(c, encodeCell(c, 'A'))).toBe('A');
    // edge: value not in options list — preserved as-is (§2.4)
    expect(decodeCell(c, 'Zzz')).toBe('Zzz');
  });

  it('select (multiple)', () => {
    const c = col({ id: 'a', type: 'select', multiple: true, options: [{ value: 'a, b', color: 'blue' }, { value: 'c', color: 'green' }] });
    expect(decodeCell(c, encodeCell(c, []))).toEqual([]);
    expect(decodeCell(c, encodeCell(c, ['c']))).toEqual(['c']);
    // edge: a label containing a comma must be quoted, per spec §2.4
    const encoded = encodeCell(c, ['a, b', 'c']);
    expect(encoded).toBe('"a, b", c');
    expect(decodeCell(c, encoded)).toEqual(['a, b', 'c']);
  });

  it('status', () => {
    const c = col({ id: 'a', type: 'status', options: [{ value: 'DONE', color: 'green' }] });
    expect(decodeCell(c, encodeCell(c, null))).toBeNull();
    expect(decodeCell(c, encodeCell(c, 'DONE'))).toBe('DONE');
    // edge: unrecognized status label preserved as-is
    expect(decodeCell(c, 'WEIRD')).toBe('WEIRD');
  });

  it('user (single)', () => {
    const c = col({ id: 'a', type: 'user' });
    expect(decodeCell(c, encodeCell(c, null))).toBeNull();
    expect(encodeCell(c, 'sk')).toBe('@sk');
    expect(decodeCell(c, '@sk')).toBe('sk');
    // edge: handle already includes '@' when passed in
    expect(encodeCell(c, '@sk')).toBe('@sk');
  });

  it('user (multiple)', () => {
    const c = col({ id: 'a', type: 'user', multiple: true });
    expect(decodeCell(c, encodeCell(c, []))).toEqual([]);
    const encoded = encodeCell(c, ['sk', 'va']);
    expect(encoded).toBe('@sk, @va');
    expect(decodeCell(c, encoded)).toEqual(['sk', 'va']);
  });

  it('link', () => {
    const c = col({ id: 'a', type: 'link' });
    expect(decodeCell(c, encodeCell(c, null))).toBeNull();
    // ordinary: bare URL
    expect(decodeCell(c, encodeCell(c, 'https://example.com'))).toBe('https://example.com');
    // edge: captioned link (markdown snippet IS the stored value — see values.ts doc comment)
    const captioned = formatLinkValue('https://example.com/x', 'Example');
    expect(captioned).toBe('[Example](https://example.com/x)');
    expect(decodeCell(c, encodeCell(c, captioned))).toBe(captioned);
    expect(parseLinkValue(captioned)).toEqual({ url: 'https://example.com/x', caption: 'Example' });
    expect(parseLinkValue('https://example.com')).toEqual({ url: 'https://example.com' });
    expect(parseLinkValue(null)).toBeNull();
  });
});

describe('values: getOutOfListLabels', () => {
  const single = col({ id: 'a', type: 'select', options: [{ value: 'A', color: 'blue' }] });
  const multi = col({ id: 'a', type: 'select', multiple: true, options: [{ value: 'A', color: 'blue' }] });
  const status = col({ id: 'a', type: 'status', options: [{ value: 'DONE', color: 'green' }] });
  const text = col({ id: 'a', type: 'text' });

  it('flags a single select value not in the option list', () => {
    expect(getOutOfListLabels(single, 'A')).toEqual([]);
    expect(getOutOfListLabels(single, 'Ghost')).toEqual(['Ghost']);
    expect(getOutOfListLabels(single, null)).toEqual([]);
  });

  it('flags each out-of-list label in a multiselect value', () => {
    expect(getOutOfListLabels(multi, ['A', 'Ghost', 'Also-ghost'])).toEqual(['Ghost', 'Also-ghost']);
  });

  it('applies to status the same way', () => {
    expect(getOutOfListLabels(status, 'WEIRD')).toEqual(['WEIRD']);
  });

  it('is a no-op for non-select/status columns', () => {
    expect(getOutOfListLabels(text, 'anything')).toEqual([]);
  });
});

describe('values: convertColumnType', () => {
  it('reports converted vs cleared when narrowing text -> number', () => {
    const fromCol = col({ id: 'a', type: 'text' });
    const toCol = col({ id: 'a', type: 'number' });
    const result = convertColumnType(fromCol, toCol, ['42', 'not a number', null]);
    expect(result.values).toEqual([42, null, null]);
    expect(result.converted).toBe(1);
    expect(result.cleared).toBe(1);
  });

  it('converts number -> text losslessly', () => {
    const fromCol = col({ id: 'a', type: 'number' });
    const toCol = col({ id: 'a', type: 'text' });
    const result = convertColumnType(fromCol, toCol, [42, null]);
    expect(result.values).toEqual(['42', null]);
    expect(result.converted).toBe(1);
    expect(result.cleared).toBe(0);
  });
});

describe('values: convertMultipleToSingle', () => {
  it('keeps the first value and reports how many rows lost data', () => {
    const result = convertMultipleToSingle([['x'], ['x', 'y'], [], null as unknown as string[]]);
    expect(result.values).toEqual(['x', 'x', null, null]);
    expect(result.converted).toBe(1); // ['x'] survived cleanly
    expect(result.cleared).toBe(1); // ['x','y'] lost 'y'
  });
});

describe('values: isEmptyCellValue', () => {
  it('a checkbox is never "empty"', () => {
    expect(isEmptyCellValue(col({ id: 'a', type: 'checkbox' }), false)).toBe(false);
    expect(isEmptyCellValue(col({ id: 'a', type: 'checkbox' }), true)).toBe(false);
  });
  it('an empty multiselect array is empty', () => {
    expect(isEmptyCellValue(col({ id: 'a', type: 'select', multiple: true }), [])).toBe(true);
    expect(isEmptyCellValue(col({ id: 'a', type: 'select', multiple: true }), ['x'])).toBe(false);
  });
});

describe('defaultCellValue: what a brand-new row holds in a column nobody filled', () => {
  it('is false for a checkbox, which always has a definite state, and null for every other type without a default', () => {
    expect(defaultCellValue(col({ id: 'a', type: 'checkbox' }))).toBe(false);
    for (const type of ['text', 'longtext', 'number', 'date', 'select', 'status', 'user', 'link'] as const) {
      expect(defaultCellValue(col({ id: 'a', type }))).toBeNull();
    }
  });

  it("the column's own default wins, for any type", () => {
    expect(defaultCellValue(col({ id: 'a', type: 'checkbox', default: true }))).toBe(true);
    expect(defaultCellValue(col({ id: 'a', type: 'text', default: 'n/a' }))).toBe('n/a');
    expect(defaultCellValue(col({ id: 'a', type: 'number', default: 0 }))).toBe(0);
    expect(defaultCellValue(col({ id: 'a', type: 'checkbox', default: false }))).toBe(false);
  });

  it('an explicit null default on a checkbox is "no default": there is no null state for a checkbox', () => {
    expect(defaultCellValue(col({ id: 'a', type: 'checkbox', default: null }))).toBe(false);
    expect(defaultCellValue(col({ id: 'a', type: 'text', default: null }))).toBeNull();
  });
});
