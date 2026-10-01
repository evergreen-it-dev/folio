import { describe, expect, it } from 'vitest';
import type { FormField, TableColumn } from '../contracts.js';
import {
  deriveFieldsFromColumns,
  formatSubmittedAt,
  SUBMITTED_AT_COLUMN_ID,
  SUBMITTER_COLUMN_ID,
  systemColumns,
  validateSubmission,
} from './fields.js';

describe('deriveFieldsFromColumns', () => {
  const columns: TableColumn[] = [
    { id: 'name', name: 'Name', type: 'text', description: 'Full name' },
    { id: 'age', name: 'Age', type: 'number' },
    { id: SUBMITTED_AT_COLUMN_ID, name: 'Submitted at', type: 'date' },
    { id: SUBMITTER_COLUMN_ID, name: 'Submitter', type: 'text' },
  ];

  it('maps one field per non-system column, in order', () => {
    const fields = deriveFieldsFromColumns(columns);
    expect(fields).toEqual([
      { columnId: 'name', label: 'Name', help: 'Full name', required: false, kind: 'text' },
      { columnId: 'age', label: 'Age', help: undefined, required: false, kind: 'number' },
    ]);
  });

  it('systemColumns() are excluded from a re-derive', () => {
    const fields = deriveFieldsFromColumns(systemColumns());
    expect(fields).toEqual([]);
  });
});

describe('validateSubmission', () => {
  const fields: FormField[] = [
    { columnId: 'name', label: 'Name', required: true, kind: 'text' },
    { columnId: 'age', label: 'Age', required: false, kind: 'number' },
    { columnId: 'attends', label: 'Attends', required: false, kind: 'checkbox' },
  ];

  it('accepts a fully-filled submission and coerces types', () => {
    const result = validateSubmission(fields, { name: 'Ivan', age: '42', attends: 'on' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values).toEqual({ name: 'Ivan', age: 42, attends: true });
  });

  it('rejects a missing required field', () => {
    const result = validateSubmission(fields, { age: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual({ name: 'required' });
  });

  it('rejects a non-numeric value for a number field', () => {
    const result = validateSubmission(fields, { name: 'Ivan', age: 'not-a-number' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.age).toBe('invalid');
  });

  it('defaults an optional empty field to null rather than dropping it', () => {
    const result = validateSubmission(fields, { name: 'Ivan' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.age).toBeNull();
  });
});

describe('formatSubmittedAt', () => {
  // Owner repro: after submit, the table row's "Submitted at" cell rendered
  // empty (`dd.mm.yyyy, --:--`) — root cause was `new Date().toISOString()`
  // (a `Z`-suffixed, millisecond-precision UTC string) being handed straight
  // to a `date, time: true` cell, whose only reader is an
  // `<input type="datetime-local">` (web/src/tables/cells/CellComponents.tsx).
  // That input's `value` must be a LOCAL date-time string with no timezone
  // designator, or the browser silently blanks it — this pins the exact
  // shape that input actually accepts.
  it('formats as a local `YYYY-MM-DDTHH:mm:ss` string — no milliseconds, no timezone designator', () => {
    const value = formatSubmittedAt(new Date(2026, 8, 21, 15, 39, 5)); // month is 0-indexed: September
    expect(value).toBe('2026-09-21T15:39:05');
    expect(value).not.toContain('Z');
    expect(value).not.toContain('.');
  });

  it('zero-pads every single-digit component', () => {
    expect(formatSubmittedAt(new Date(2026, 0, 5, 9, 3, 7))).toBe('2026-01-05T09:03:07');
  });
});
