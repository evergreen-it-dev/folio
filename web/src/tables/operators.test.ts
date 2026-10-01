import { describe, expect, it } from 'vitest';
import type { TableColumn } from '@shared/contracts';
import { tableFilterOperatorSchema } from '@shared/contracts';
import {
  blankValueFor,
  defaultOperatorForColumn,
  inputForOperator,
  operatorsForColumn,
} from './operators';
import { COLUMN_TYPES } from './cells/typeMeta';

/**
 * Round 26 (DATA TABLES) — the per-type operator catalogue (spec §3).
 *
 * The contract test at the bottom is the important one: every operator this
 * module can offer must exist in shared/contracts' enum, or the filter would
 * serialise into a view that the server's zod schema then rejects — a
 * failure that would only surface on save, in wave 3, far from here.
 */

function column(type: TableColumn['type'], extra: Partial<TableColumn> = {}): TableColumn {
  return { id: 'c', name: 'C', type, ...extra };
}

describe('operatorsForColumn', () => {
  it('gives every column type a non-empty list', () => {
    for (const type of COLUMN_TYPES) {
      expect(operatorsForColumn(column(type)).length).toBeGreaterThan(0);
    }
  });

  it('offers contains first for text, so a fresh rule is the useful one', () => {
    expect(defaultOperatorForColumn(column('text'))).toBe('contains');
  });

  it('gives checkbox only its two states', () => {
    expect(operatorsForColumn(column('checkbox'))).toEqual(['is_checked', 'is_unchecked']);
  });

  it('adds has_all/has_any only when the column is multi-valued', () => {
    expect(operatorsForColumn(column('select'))).not.toContain('has_all');
    expect(operatorsForColumn(column('select', { multiple: true }))).toContain('has_all');
    expect(operatorsForColumn(column('user', { multiple: true }))).toContain('has_any');
  });

  it('does not add has_all to a multi-flagged type that has no such notion', () => {
    // `multiple` is only meaningful for select/user (spec §3).
    expect(operatorsForColumn(column('text', { multiple: true }))).not.toContain('has_all');
  });

  it('offers the relative-date operators on date columns (spec §3)', () => {
    const operators = operatorsForColumn(column('date'));
    expect(operators).toContain('today');
    expect(operators).toContain('this_week');
    expect(operators).toContain('last_n_days');
  });

  it('offers is_me on user columns', () => {
    expect(operatorsForColumn(column('user'))).toContain('is_me');
  });
});

describe('inputForOperator', () => {
  it('needs no value editor for the self-contained operators', () => {
    expect(inputForOperator('is_empty', column('text'))).toBe('none');
    expect(inputForOperator('is_checked', column('checkbox'))).toBe('none');
    expect(inputForOperator('today', column('date'))).toBe('none');
  });

  it('uses a date input for date comparisons but a number for last_n_days', () => {
    expect(inputForOperator('gt', column('date'))).toBe('date');
    expect(inputForOperator('last_n_days', column('date'))).toBe('number');
    expect(inputForOperator('between', column('date'))).toBe('date-range');
  });

  it('uses a numeric range for a number between', () => {
    expect(inputForOperator('between', column('number'))).toBe('number-range');
  });

  it('falls back to a text box when a select column has no options yet', () => {
    expect(inputForOperator('is_any_of', column('select'))).toBe('text');
    expect(
      inputForOperator('is_any_of', column('select', { options: [{ value: 'A', color: 'gray' }] })),
    ).toBe('options');
  });

  it('routes user columns to the user picker', () => {
    expect(inputForOperator('is_any_of', column('user'))).toBe('user');
  });
});

describe('blankValueFor', () => {
  it('gives each input kind a value of the right shape', () => {
    expect(blankValueFor('is_empty', column('text'))).toBeUndefined();
    expect(blankValueFor('contains', column('text'))).toBe('');
    expect(blankValueFor('between', column('number'))).toEqual(['', '']);
    expect(
      blankValueFor('is_any_of', column('select', { options: [{ value: 'A', color: 'gray' }] })),
    ).toEqual([]);
  });
});

describe('contract with shared/contracts', () => {
  it('every offered operator is a member of tableFilterOperatorSchema', () => {
    // Guards against this zone inventing an operator the server would reject
    // at save time, in another wave, far from this code.
    for (const type of COLUMN_TYPES) {
      for (const multiple of [false, true]) {
        for (const operator of operatorsForColumn(column(type, { multiple }))) {
          expect(() => tableFilterOperatorSchema.parse(operator)).not.toThrow();
        }
      }
    }
  });
});
