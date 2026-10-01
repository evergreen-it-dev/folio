import { describe, expect, it } from 'vitest';
import type { TableColumn, TableRow } from '../contracts.js';
import { applyFilters, applySearch, applySort } from './query.js';

const cols: TableColumn[] = [
  { id: 'week', name: 'Week', type: 'select', options: [{ value: 'W8', color: 'blue' }, { value: 'W9', color: 'green' }] },
  { id: 'owner', name: 'Owner', type: 'user' },
  { id: 'status', name: 'Status', type: 'status', options: [
    { value: 'PLANNING', color: 'purple' },
    { value: 'IN PROG', color: 'blue' },
    { value: 'DONE', color: 'green' },
  ] },
  { id: 'points', name: 'Points', type: 'number' },
  { id: 'due', name: 'Due', type: 'date' },
  { id: 'name', name: 'Name', type: 'text' },
];

function row(id: string, values: Partial<Record<string, unknown>>): TableRow {
  const full: Record<string, unknown> = { week: null, owner: null, status: null, points: null, due: null, name: null, ...values };
  return { id, values: full as TableRow['values'] };
}

describe('query: applySort — select/status by option order, not alphabetical', () => {
  it('status sorts by option-list order (PLANNING, IN PROG, DONE), not alphabetically', () => {
    const rows = [row('a', { status: 'DONE' }), row('b', { status: 'PLANNING' }), row('c', { status: 'IN PROG' })];
    const sorted = applySort(rows, cols, [{ column: 'status', dir: 'asc' }]);
    expect(sorted.map((r) => r.id)).toEqual(['b', 'c', 'a']); // PLANNING, IN PROG, DONE
  });

  it('desc reverses the option order too', () => {
    const rows = [row('a', { status: 'DONE' }), row('b', { status: 'PLANNING' }), row('c', { status: 'IN PROG' })];
    const sorted = applySort(rows, cols, [{ column: 'status', dir: 'desc' }]);
    expect(sorted.map((r) => r.id)).toEqual(['a', 'c', 'b']); // DONE, IN PROG, PLANNING
  });
});

describe('query: applySort — empty values always sort last', () => {
  it('in ascending order', () => {
    const rows = [row('a', { points: null }), row('b', { points: 5 }), row('c', { points: 1 })];
    const sorted = applySort(rows, cols, [{ column: 'points', dir: 'asc' }]);
    expect(sorted.map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('in descending order — empty is STILL last, not first', () => {
    const rows = [row('a', { points: null }), row('b', { points: 5 }), row('c', { points: 1 })];
    const sorted = applySort(rows, cols, [{ column: 'points', dir: 'desc' }]);
    expect(sorted.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('query: applySort — dates compare as ISO strings', () => {
  it('orders chronologically via plain string comparison', () => {
    const rows = [row('a', { due: '2026-09-01' }), row('b', { due: '2026-08-26' }), row('c', { due: '2026-08-26T14:30' })];
    const sorted = applySort(rows, cols, [{ column: 'due', dir: 'asc' }]);
    expect(sorted.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('query: applyFilters', () => {
  const rows = [
    row('a', { status: 'DONE', name: 'Alpha', points: 10 }),
    row('b', { status: 'IN PROG', name: 'Beta', points: 3 }),
    row('c', { status: null, name: null, points: null }),
  ];

  it('is_empty / is_not_empty', () => {
    expect(applyFilters(rows, cols, { op: 'and', rules: [{ column: 'status', operator: 'is_empty' }] }).map((r) => r.id)).toEqual(['c']);
    expect(applyFilters(rows, cols, { op: 'and', rules: [{ column: 'status', operator: 'is_not_empty' }] }).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('is_any_of / is_none_of', () => {
    const anyOf = applyFilters(rows, cols, { op: 'and', rules: [{ column: 'status', operator: 'is_any_of', value: ['DONE'] }] });
    expect(anyOf.map((r) => r.id)).toEqual(['a']);
    const noneOf = applyFilters(rows, cols, { op: 'and', rules: [{ column: 'status', operator: 'is_none_of', value: ['DONE'] }] });
    expect(noneOf.map((r) => r.id)).toEqual(['b', 'c']);
  });

  it('gt/lt/gte/lte on number', () => {
    expect(applyFilters(rows, cols, { op: 'and', rules: [{ column: 'points', operator: 'gt', value: 5 }] }).map((r) => r.id)).toEqual(['a']);
    expect(applyFilters(rows, cols, { op: 'and', rules: [{ column: 'points', operator: 'lte', value: 3 }] }).map((r) => r.id)).toEqual(['b']);
  });

  it('contains is case- and diacritic-insensitive', () => {
    const withCyrillic = [row('x', { name: 'Пошук цілі' }), row('y', { name: 'Something else' })];
    const found = applyFilters(withCyrillic, cols, { op: 'and', rules: [{ column: 'name', operator: 'contains', value: 'ПОШУК' }] });
    expect(found.map((r) => r.id)).toEqual(['x']);
  });

  it('op: or combines rules with OR instead of AND', () => {
    const matched = applyFilters(rows, cols, {
      op: 'or',
      rules: [
        { column: 'status', operator: 'is', value: 'DONE' },
        { column: 'points', operator: 'lt', value: 5 },
      ],
    });
    expect(matched.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('a rule referencing an unknown column matches nothing rather than throwing', () => {
    const matched = applyFilters(rows, cols, { op: 'and', rules: [{ column: 'ghost', operator: 'is_empty' }] });
    expect(matched).toEqual([]);
  });
});

describe('query: applySearch — case- and diacritic-insensitive, Cyrillic aware', () => {
  // Cyrillic 'й' can arrive as one precomposed codepoint (U+0439) or as the
  // base letter 'и' (U+0438) + a combining breve (U+0306) — visually
  // identical, different bytes. Built via \u escapes so the two forms used
  // below are unambiguous.
  const YO_PRECOMPOSED = '\u0439';
  const YO_DECOMPOSED = '\u0438\u0306';

  const rows = [
    row('a', { name: 'Передати проєкт' }),
    row('b', { name: `${YO_PRECOMPOSED}огурт` }), // "йогурт", precomposed й
    row('c', { name: 'unrelated' }),
  ];

  it('matches regardless of case', () => {
    expect(applySearch(rows, cols, 'ПЕРЕДАТИ').map((r) => r.id)).toEqual(['a']);
  });

  it('matches a precomposed letter against its decomposed (base + combining mark) form', () => {
    const decomposedQuery = `${YO_DECOMPOSED}огурт`;
    expect(rows[1].values.name).not.toBe(decomposedQuery); // sanity: genuinely different strings
    expect(applySearch(rows, cols, decomposedQuery).map((r) => r.id)).toEqual(['b']);
  });

  it('empty query returns all rows', () => {
    expect(applySearch(rows, cols, '  ')).toEqual(rows);
  });

  it('searches numbers as text too', () => {
    const numRows = [row('x', { points: 42 }), row('y', { points: 7 })];
    expect(applySearch(numRows, cols, '42').map((r) => r.id)).toEqual(['x']);
  });
});
