/**
 * Round 26 (DATA TABLES) — limit constants and validators, spec §13
 * (docs/spec-tables.md). Pure, no IO. Shared by server (write-path guards)
 * and client (UI warnings) so both agree on the exact same numbers.
 */

export const TABLE_LIMITS = {
  rows: { soft: 5_000, hard: 20_000 },
  columns: { soft: 40, hard: 80 },
  cellChars: { soft: 10_000, hard: 50_000 },
  options: { soft: 100, hard: 500 },
  views: { soft: 20, hard: 50 },
} as const;

export type TableLimitKind = keyof typeof TABLE_LIMITS;

export type LimitCheck =
  | { level: 'ok' }
  | { level: 'warn'; message: string }
  | { level: 'error'; message: string };

function checkAgainst(kind: TableLimitKind, count: number, label: string): LimitCheck {
  const { soft, hard } = TABLE_LIMITS[kind];
  if (count > hard) {
    return { level: 'error', message: `${label}: ${count} exceeds the hard limit of ${hard}` };
  }
  if (count > soft) {
    return { level: 'warn', message: `${label}: ${count} exceeds the soft limit of ${soft}` };
  }
  return { level: 'ok' };
}

/** §13 "rows in a table". */
export function checkRowCount(count: number): LimitCheck {
  return checkAgainst('rows', count, 'Rows');
}

/** §13 "columns". */
export function checkColumnCount(count: number): LimitCheck {
  return checkAgainst('columns', count, 'Columns');
}

/** §13 "characters in a cell" — pass the character length of one cell's raw text. */
export function checkCellLength(length: number): LimitCheck {
  return checkAgainst('cellChars', length, 'Cell length');
}

/** §13 "options in a list" — pass the number of options on one select/status column. */
export function checkOptionCount(count: number): LimitCheck {
  return checkAgainst('options', count, 'Options');
}

/** §13 "views". */
export function checkViewCount(count: number): LimitCheck {
  return checkAgainst('views', count, 'Views');
}

/** True once a table is over the HARD row limit — spec: open read-only, don't crash. */
export function isOverHardRowLimit(count: number): boolean {
  return count > TABLE_LIMITS.rows.hard;
}
