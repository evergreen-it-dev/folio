import { describe, expect, it } from 'vitest';
import type { TableColumn, TableRow } from '@shared/contracts';
import { applySearch, foldText, inferColumns, uniqueColumnId } from './core';

/**
 * The same rules as in core.test.ts, on Ukrainian text: folding has to work
 * on Cyrillic letters, and a column named in Cyrillic still needs an id from
 * the [a-z0-9_] alphabet.
 */
describe('tables core: Cyrillic text', () => {
  const textColumn: TableColumn = { id: 'task', name: 'Task', type: 'text' };
  const rows = (...values: Array<TableRow['values']>): TableRow[] =>
    values.map((value, index) => ({ id: `r${index}`, values: value }));

  it('folds case and diacritics', () => {
    expect(foldText('ЙОГО')).toBe(foldText('його'));
    expect(foldText('їжак')).toBe(foldText('іжак'));
  });

  it('searches case-insensitively', () => {
    const data = rows({ task: 'Передати проєкт' }, { task: 'Інше' });
    expect(applySearch(data, [textColumn], 'передати')).toHaveLength(1);
  });

  it('detects checkboxes from the localized words', () => {
    const result = inferColumns([['Done'], ['так'], ['ні'], ['yes']]);
    expect(result[0]?.type).toBe('checkbox');
  });

  it('transliterates a column name into the id alphabet', () => {
    expect(uniqueColumnId('Тиждень', 0, new Set())).toMatch(/^[a-z0-9_]{1,32}$/);
  });
});
