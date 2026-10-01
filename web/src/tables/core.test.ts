import { describe, expect, it } from 'vitest';
import type { TableColumn, TableRow } from '@shared/contracts';
import {
  applyFilters,
  applySearch,
  applySort,
  cellToText,
  foldText,
  inferColumns,
  isRuleComplete,
  joinLabels,
  parseCellText,
  splitLabels,
  uniqueColumnId,
} from './core';
import { MOCK_COLUMNS, STATUS_OPTIONS } from './fixtures';

/**
 * Round 26 (DATA TABLES) — the query/inference engine this zone runs on.
 *
 * No jsdom pragma: this module is deliberately React-free and DOM-free (see
 * core.ts's header), so it tests in the default node environment.
 *
 * NOTE FOR WAVE 3: when TABLES-CORE's shared/tables/{query,values,csv}.ts
 * lands and core.ts collapses to a re-export, these tests should keep
 * passing unchanged — that is precisely their job here. Any that then fail
 * mark a real behavioural disagreement between this stand-in and the
 * normative engine, and CORE wins.
 */

const statusColumn: TableColumn = { id: 'status', name: 'Status', type: 'status', options: STATUS_OPTIONS };
const textColumn: TableColumn = { id: 'task', name: 'Task', type: 'text' };
const numberColumn: TableColumn = { id: 'n', name: 'N', type: 'number' };

function rows(...values: Record<string, unknown>[]): TableRow[] {
  return values.map((value, index) => ({ id: `r${index}`, values: value as TableRow['values'] }));
}

describe('foldText', () => {
  it('folds case and diacritics so search is insensitive to both', () => {
    expect(foldText('ÉCOLE')).toBe(foldText('école'));
    expect(foldText('naïve')).toBe(foldText('naive'));
    expect(foldText('Café')).toBe('cafe');
  });
});

describe('applyFilters', () => {
  it('leaves rows untouched when a rule has no value yet', () => {
    // The table must not blank out between picking an operator and typing
    // the value — that reads as data loss.
    const data = rows({ task: 'alpha' }, { task: 'beta' });
    const result = applyFilters(data, [textColumn], {
      op: 'and',
      rules: [{ column: 'task', operator: 'contains', value: '' }],
    });
    expect(result).toHaveLength(2);
  });

  it('applies contains, and treats is_empty as complete without a value', () => {
    const data = rows({ task: 'alpha' }, { task: '' }, { task: 'beta' });
    expect(
      applyFilters(data, [textColumn], { op: 'and', rules: [{ column: 'task', operator: 'contains', value: 'al' }] }),
    ).toHaveLength(1);
    expect(
      applyFilters(data, [textColumn], { op: 'and', rules: [{ column: 'task', operator: 'is_empty' }] }),
    ).toHaveLength(1);
  });

  it('honours the and/or joiner across rules', () => {
    const data = rows({ task: 'alpha', n: 1 }, { task: 'beta', n: 5 });
    const both = {
      rules: [
        { column: 'task', operator: 'contains' as const, value: 'alpha' },
        { column: 'n', operator: 'gt' as const, value: 3 },
      ],
    };
    expect(applyFilters(data, [textColumn, numberColumn], { op: 'and', ...both })).toHaveLength(0);
    expect(applyFilters(data, [textColumn, numberColumn], { op: 'or', ...both })).toHaveLength(2);
  });

  it('is_any_of matches a multi-valued cell against the wanted set', () => {
    const userColumn: TableColumn = { id: 'owner', name: 'Owner', type: 'user', multiple: true };
    const data = rows({ owner: ['@sk', '@va'] }, { owner: ['@dm'] });
    expect(
      applyFilters(data, [userColumn], {
        op: 'and',
        rules: [{ column: 'owner', operator: 'is_any_of', value: ['@va'] }],
      }),
    ).toHaveLength(1);
  });

  it('has_all requires every wanted value to be present', () => {
    const userColumn: TableColumn = { id: 'owner', name: 'Owner', type: 'user', multiple: true };
    const data = rows({ owner: ['@sk', '@va'] }, { owner: ['@sk'] });
    expect(
      applyFilters(data, [userColumn], {
        op: 'and',
        rules: [{ column: 'owner', operator: 'has_all', value: ['@sk', '@va'] }],
      }),
    ).toHaveLength(1);
  });

  it('ignores an unknown operator rather than emptying the table', () => {
    const data = rows({ task: 'alpha' }, { task: 'beta' });
    const result = applyFilters(data, [textColumn], {
      op: 'and',
      // A view written by a newer client, or hand-edited frontmatter.
      rules: [{ column: 'task', operator: 'no_such_operator' as never, value: 'x' }],
    });
    expect(result).toHaveLength(2);
  });

  it('compares dates as ISO strings for before/after', () => {
    const dateColumn: TableColumn = { id: 'due', name: 'Due', type: 'date' };
    const data = rows({ due: '2026-08-01' }, { due: '2026-09-01' });
    expect(
      applyFilters(data, [dateColumn], { op: 'and', rules: [{ column: 'due', operator: 'lt', value: '2026-08-15' }] }),
    ).toHaveLength(1);
  });
});

describe('applySort', () => {
  it('sorts select/status by OPTION ORDER, not alphabetically', () => {
    // The rule everyone gets wrong: alphabetically DONE < IN PROG, but the
    // preset's own order puts IN PROG (index 3) before DONE (index 4).
    const data = rows({ status: 'DONE' }, { status: 'IN PROG' }, { status: 'PLANNING' });
    const sorted = applySort(data, [statusColumn], [{ column: 'status', dir: 'asc' }]);
    expect(sorted.map((row) => row.values.status)).toEqual(['PLANNING', 'IN PROG', 'DONE']);
  });

  it('sorts an out-of-list status after every known option', () => {
    const data = rows({ status: 'ON HOLD' }, { status: 'DONE' });
    const sorted = applySort(data, [statusColumn], [{ column: 'status', dir: 'asc' }]);
    expect(sorted.map((row) => row.values.status)).toEqual(['DONE', 'ON HOLD']);
  });

  it('keeps empty values last in BOTH directions', () => {
    const data = rows({ n: 2 }, { n: null }, { n: 1 });
    expect(
      applySort(data, [numberColumn], [{ column: 'n', dir: 'asc' }]).map((row) => row.values.n),
    ).toEqual([1, 2, null]);
    expect(
      applySort(data, [numberColumn], [{ column: 'n', dir: 'desc' }]).map((row) => row.values.n),
    ).toEqual([2, 1, null]);
  });

  it('is stable, so equal rows keep their file order', () => {
    const data = rows({ n: 1, task: 'first' }, { n: 1, task: 'second' });
    const sorted = applySort(data, [numberColumn, textColumn], [{ column: 'n', dir: 'asc' }]);
    expect(sorted.map((row) => row.values.task)).toEqual(['first', 'second']);
  });

  it('falls through to the next sort level on a tie', () => {
    const data = rows({ n: 1, task: 'b' }, { n: 1, task: 'a' });
    const sorted = applySort(data, [numberColumn, textColumn], [
      { column: 'n', dir: 'asc' },
      { column: 'task', dir: 'asc' },
    ]);
    expect(sorted.map((row) => row.values.task)).toEqual(['a', 'b']);
  });
});

describe('applySearch', () => {
  it('matches across columns, case- and diacritic-insensitively', () => {
    const data = rows({ task: 'Hand over the Handover' }, { task: 'Other' });
    expect(applySearch(data, [textColumn], 'hand over')).toHaveLength(1);
  });

  it('excludes checkbox columns so "true" does not match every checked row', () => {
    const checkbox: TableColumn = { id: 'blocked', name: 'Blocked', type: 'checkbox' };
    const data = rows({ blocked: true }, { blocked: false });
    expect(applySearch(data, [checkbox], 'true')).toHaveLength(0);
  });

  it('returns everything for an empty query', () => {
    const data = rows({ task: 'a' }, { task: 'b' });
    expect(applySearch(data, [textColumn], '   ')).toHaveLength(2);
  });
});

describe('inferColumns (spec §10.1)', () => {
  it('detects the status preset', () => {
    const result = inferColumns([['Stage'], ['DONE'], ['IN PROG'], ['PLANNING']]);
    expect(result[0]?.type).toBe('status');
  });

  it('detects @handles as user, ISO dates as date and numerals as number', () => {
    const result = inferColumns([
      ['Owner', 'Due', 'Estimate'],
      ['@sk', '2026-08-21', '3'],
      ['@va', '2026-08-28', '5.5'],
    ]);
    expect(result.map((column) => column.type)).toEqual(['user', 'date', 'number']);
    // WAVE 3 ADJUDICATION (SHELL-TABLES): the wave-1 stand-in also inferred
    // `precision` from the longest fractional part in the sample; CORE's
    // inferColumns sets only id/name/type (+options for select/status) and
    // leaves precision undefined, i.e. "as typed". CORE is normative, so the
    // expectation moved rather than the engine — a number column pasted from
    // Sheets now keeps whatever precision each value was written with until
    // the user pins one in the column editor.
    expect(result[2]?.precision).toBeUndefined();
  });

  it('detects checkboxes from the word vocabulary', () => {
    const result = inferColumns([['Done'], ['yes'], ['no'], ['true']]);
    expect(result[0]?.type).toBe('checkbox');
  });

  it('falls back to text and never throws on an empty column', () => {
    const result = inferColumns([['A', 'B'], ['', 'raw material']]);
    expect(result[0]?.type).toBe('text');
    expect(result).toHaveLength(2);
  });

  it('names a headerless column rather than producing an empty id', () => {
    const result = inferColumns([['', ''], ['x', 'y']]);
    expect(result[0]?.id).toMatch(/^[a-z0-9_]{1,32}$/);
    expect(result[1]?.id).not.toBe(result[0]?.id);
  });
});

describe('uniqueColumnId', () => {
  it('squeezes any name into the [a-z0-9_] id alphabet', () => {
    expect(uniqueColumnId('Week № 1 (plan)', 0, new Set())).toMatch(/^[a-z0-9_]{1,32}$/);
  });

  it('suffixes on collision instead of overwriting', () => {
    const used = new Set<string>();
    const first = uniqueColumnId('Week', 0, used);
    const second = uniqueColumnId('Week', 1, used);
    expect(second).not.toBe(first);
    expect(second).toMatch(/_2$/);
  });
});

describe('multi-value label encoding (spec §2.4)', () => {
  it('round-trips a label containing a comma through quoting', () => {
    const labels = ['a, b', 'c'];
    expect(splitLabels(joinLabels(labels))).toEqual(labels);
  });
});

describe('parseCellText', () => {
  it('parses a decimal comma as a number', () => {
    expect(parseCellText(numberColumn, '3,5')).toBe(3.5);
  });

  it('reads the file checkbox forms', () => {
    const checkbox: TableColumn = { id: 'b', name: 'B', type: 'checkbox' };
    expect(parseCellText(checkbox, '[x]')).toBe(true);
    expect(parseCellText(checkbox, '[ ]')).toBe(false);
  });

  it('splits a multi-select cell but keeps a single-select one scalar', () => {
    const multi = MOCK_COLUMNS.find((column) => column.id === 'owner');
    const single = MOCK_COLUMNS.find((column) => column.id === 'week');
    // WAVE 3 ADJUDICATION (SHELL-TABLES): the stand-in kept the typed `@`;
    // CORE's decodeCell strips it, because the `@` is part of the FILE
    // encoding (`encodeCell` puts it back) and not of the stored handle —
    // query.ts's `is_me` strips it again before comparing, so a value that
    // kept it would compare wrong. CORE is normative.
    expect(parseCellText(multi as TableColumn, '@a, @b')).toEqual(['a', 'b']);
    expect(parseCellText(single as TableColumn, 'W8 17-21.08')).toBe('W8 17-21.08');
  });
});

describe('isRuleComplete', () => {
  it('treats valueless operators as complete', () => {
    expect(isRuleComplete({ column: 'x', operator: 'is_empty' })).toBe(true);
    expect(isRuleComplete({ column: 'x', operator: 'today' })).toBe(true);
  });

  it('treats an empty option set as incomplete', () => {
    expect(isRuleComplete({ column: 'x', operator: 'is_any_of', value: [] })).toBe(false);
  });
});

describe('cellToText', () => {
  it('renders a multi-value cell as a comma list and null as empty', () => {
    expect(cellToText(['a', 'b'])).toBe('a, b');
    expect(cellToText(null)).toBe('');
  });
});
