import type { TableColumn } from '@shared/contracts';

/**
 * Round 26 (DATA TABLES) — the fixed colour palette from spec §2.3, mapped to
 * Tailwind classes for both themes.
 *
 * Deliberately a closed record and not a template string: `bg-${color}-100`
 * is invisible to Tailwind's class scanner and would be purged out of the
 * production build, which is exactly the class of bug that ships as "chips
 * are grey on prod, colourful in dev". Every class below appears literally
 * in this file, so the scanner sees all of them.
 *
 * Arbitrary CSS is not accepted (same rule as R17's sanitizer) — an unknown
 * token falls back to `gray` rather than rendering unstyled.
 */
export type TableColor = NonNullable<NonNullable<TableColumn['options']>[number]['color']>;

/**
 * Display order for the column editor's swatch grid: neutrals first, then
 * once round the hue wheel, `none` last. 21 entries lay out as 3 × 7.
 *
 * MUST stay in step with `tableColorSchema` in shared/contracts.ts. Both maps
 * below are `Record<TableColor, …>`, so a colour added to the enum and
 * forgotten here is a compile error rather than a grey chip on production.
 */
export const TABLE_COLORS: TableColor[] = [
  'gray', 'slate', 'stone',
  'red', 'rose', 'pink', 'fuchsia', 'purple', 'violet', 'indigo',
  'blue', 'sky', 'cyan', 'teal', 'emerald', 'green', 'lime',
  'yellow', 'amber', 'orange',
  'none',
];

const CHIP_CLASS: Record<TableColor, string> = {
  gray: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-700/60 dark:text-neutral-200',
  slate: 'bg-slate-100 text-slate-800 dark:bg-slate-900/50 dark:text-slate-200',
  stone: 'bg-stone-100 text-stone-800 dark:bg-stone-900/50 dark:text-stone-200',
  red: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200',
  rose: 'bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200',
  pink: 'bg-pink-100 text-pink-800 dark:bg-pink-900/50 dark:text-pink-200',
  fuchsia: 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/50 dark:text-fuchsia-200',
  purple: 'bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-200',
  violet: 'bg-violet-100 text-violet-800 dark:bg-violet-900/50 dark:text-violet-200',
  indigo: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-200',
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200',
  sky: 'bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200',
  cyan: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/50 dark:text-cyan-200',
  teal: 'bg-teal-100 text-teal-800 dark:bg-teal-900/50 dark:text-teal-200',
  emerald: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200',
  green: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200',
  lime: 'bg-lime-100 text-lime-800 dark:bg-lime-900/50 dark:text-lime-200',
  yellow: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-200',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200',
  orange: 'bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-200',
  none: 'bg-transparent text-neutral-700 dark:text-neutral-200',
};

const SWATCH_CLASS: Record<TableColor, string> = {
  gray: 'bg-neutral-400',
  slate: 'bg-slate-500',
  stone: 'bg-stone-500',
  red: 'bg-red-500',
  rose: 'bg-rose-500',
  pink: 'bg-pink-500',
  fuchsia: 'bg-fuchsia-500',
  purple: 'bg-purple-500',
  violet: 'bg-violet-500',
  indigo: 'bg-indigo-500',
  blue: 'bg-blue-500',
  sky: 'bg-sky-500',
  cyan: 'bg-cyan-500',
  teal: 'bg-teal-500',
  emerald: 'bg-emerald-500',
  green: 'bg-green-500',
  lime: 'bg-lime-500',
  yellow: 'bg-yellow-500',
  amber: 'bg-amber-500',
  orange: 'bg-orange-500',
  none: 'bg-transparent border border-neutral-300 dark:border-neutral-600',
};

export function chipClass(color: TableColor | undefined): string {
  return CHIP_CLASS[color ?? 'gray'] ?? CHIP_CLASS.gray;
}

/** The little colour square shown next to an option in dropdowns and the ⓘ tooltip (spec §2.3). */
export function swatchClass(color: TableColor | undefined): string {
  return SWATCH_CLASS[color ?? 'gray'] ?? SWATCH_CLASS.gray;
}

/** Colour of a known option, or undefined for an out-of-list value (spec §2.4). */
export function colorForValue(column: TableColumn, value: string): TableColor | undefined {
  return column.options?.find((option) => option.value === value)?.color;
}

/** True when a cell holds a select/status label that is not in the column's option list. */
export function isOutOfList(column: TableColumn, value: string): boolean {
  if (column.type !== 'select' && column.type !== 'status') return false;
  if (value === '') return false;
  const options = column.options ?? [];
  if (options.length === 0) return false;
  return !options.some((option) => option.value === value);
}
