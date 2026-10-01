/**
 * Round 26 (DATA TABLES) — which filter operators a column of each type
 * offers, and what kind of value input each operator needs.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Adapted from tablecn — https://github.com/sadmann7/tablecn — MIT License,
 * Copyright (c) sadmann7. Specifically `src/config/data-table.ts`'s
 * per-variant operator lists and `src/lib/data-table.ts`'s
 * `getFilterOperators` / `getDefaultFilterOperator` / `getValidFilters`
 * shape: a static map from column variant → ordered operator list, with the
 * first entry doubling as the default, and incomplete rules filtered out
 * before the engine runs.
 *
 * What changed on the way in: tablecn's variants (text/number/range/date/
 * dateRange/boolean/select/multiSelect) are replaced by Folio's nine column
 * TYPES from spec §3, its Drizzle-flavoured operator names (iLike, ne,
 * inArray…) by our `tableFilterOperatorSchema` enum from
 * shared/contracts.ts, and its English labels by i18n keys — the operator
 * lists themselves are dictated by spec §3's own per-type table, which is
 * normative here and differs from tablecn's in several places (e.g. our
 * select gains has_all/has_any when `multiple`, our date gains
 * today/this_week/last_n_days). No tablecn code is copied verbatim; this is
 * the pattern, reimplemented against our contract.
 * ─────────────────────────────────────────────────────────────────────────
 */
import type { TableColumn } from '@shared/contracts';
import { tableFilterOperatorSchema } from '@shared/contracts';

export type TableFilterOperator = ReturnType<typeof tableFilterOperatorSchema.parse>;

/** What the rule row must render to the right of the operator dropdown. */
export type OperatorInput =
  | 'none'      // is_empty, is_checked, today, … — the operator IS the value
  | 'text'
  | 'number'
  | 'date'
  | 'number-range'
  | 'date-range'
  | 'option'    // single pick from column.options
  | 'options'   // multi pick from column.options
  | 'user';

const INPUT_BY_OPERATOR: Record<TableFilterOperator, OperatorInput> = {
  is: 'text',
  is_not: 'text',
  contains: 'text',
  not_contains: 'text',
  starts_with: 'text',
  is_empty: 'none',
  is_not_empty: 'none',
  gt: 'number',
  lt: 'number',
  gte: 'number',
  lte: 'number',
  between: 'number-range',
  is_any_of: 'options',
  is_none_of: 'options',
  has_all: 'options',
  has_any: 'options',
  is_checked: 'none',
  is_unchecked: 'none',
  is_me: 'none',
  today: 'none',
  this_week: 'none',
  last_n_days: 'number',
};

/**
 * Per-type operator lists — spec §3's table, column "Filters", in its order.
 * First entry is the default when a rule is created (tablecn's convention).
 */
const OPERATORS_BY_TYPE: Record<TableColumn['type'], TableFilterOperator[]> = {
  text: ['contains', 'not_contains', 'is', 'is_not', 'starts_with', 'is_empty', 'is_not_empty'],
  longtext: ['contains', 'not_contains', 'is_empty', 'is_not_empty'],
  number: ['is', 'is_not', 'gt', 'lt', 'gte', 'lte', 'between', 'is_empty'],
  date: ['is', 'lt', 'gt', 'between', 'today', 'this_week', 'last_n_days', 'is_empty'],
  checkbox: ['is_checked', 'is_unchecked'],
  select: ['is_any_of', 'is_none_of', 'is_empty', 'is_not_empty'],
  status: ['is_any_of', 'is_none_of', 'is_empty', 'is_not_empty'],
  user: ['is_any_of', 'is_none_of', 'is_me', 'is_empty'],
  link: ['contains', 'is_empty', 'is_not_empty'],
};

/**
 * The operators offered for one concrete column.
 *
 * `multiple` is a column FLAG, not a type (spec §3), so it is applied here
 * rather than by forking the type map: a multi-valued select/user additionally
 * offers "contains all" / "contains any".
 */
export function operatorsForColumn(column: TableColumn): TableFilterOperator[] {
  const base = OPERATORS_BY_TYPE[column.type] ?? OPERATORS_BY_TYPE.text;
  if (column.multiple && (column.type === 'select' || column.type === 'user')) {
    return [...base.slice(0, 2), 'has_all', 'has_any', ...base.slice(2)];
  }
  return base;
}

/** First operator of the column's list — what a freshly added rule starts on. */
export function defaultOperatorForColumn(column: TableColumn): TableFilterOperator {
  return operatorsForColumn(column)[0] ?? 'contains';
}

/** Which value editor a rule row shows. `options`/`option` collapse to a plain text box when the column has no option list. */
export function inputForOperator(operator: TableFilterOperator, column: TableColumn): OperatorInput {
  const input = INPUT_BY_OPERATOR[operator] ?? 'text';
  if (input === 'number' && column.type === 'date' && operator !== 'last_n_days') return 'date';
  if (input === 'number-range' && column.type === 'date') return 'date-range';
  if ((input === 'options' || input === 'option') && column.type === 'user') return 'user';
  if ((input === 'options' || input === 'option') && (column.options ?? []).length === 0) return 'text';
  return input;
}

/** The value a rule should carry the moment its operator changes, so it is never left mid-type. */
export function blankValueFor(operator: TableFilterOperator, column: TableColumn): unknown {
  switch (inputForOperator(operator, column)) {
    case 'none':
      return undefined;
    case 'options':
    case 'option':
    case 'user':
      return [];
    case 'number-range':
    case 'date-range':
      return ['', ''];
    default:
      return '';
  }
}
