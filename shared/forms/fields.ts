/**
 * Round FORMS — pure field <-> column mapping and submission validation.
 * No IO, no server/collab knowledge: server/forms/service.ts calls these
 * before it ever touches storage/collab, and the web field editor uses
 * `deriveFieldsFromColumns` for its own "regenerate from table" action.
 */
import type { FormField, TableCellValue, TableColumn } from '../contracts.js';

/**
 * Columns the server stamps onto every submission automatically (spec: "add
 * them to the table if missing") — never shown as fillable fields, and
 * `deriveFieldsFromColumns` skips them so re-deriving a form from its table
 * doesn't grow a "Submitted at" text box.
 */
export const SUBMITTED_AT_COLUMN_ID = 'submitted_at';
export const SUBMITTER_COLUMN_ID = 'submitter';
const SYSTEM_COLUMN_IDS: ReadonlySet<string> = new Set([SUBMITTED_AT_COLUMN_ID, SUBMITTER_COLUMN_ID]);

export function systemColumns(): TableColumn[] {
  return [
    { id: SUBMITTED_AT_COLUMN_ID, name: 'Submitted at', type: 'date', time: true },
    { id: SUBMITTER_COLUMN_ID, name: 'Submitter', type: 'text' },
  ];
}

/**
 * BUGFIX (owner repro: after a successful submit, the table row's "Submitted
 * at" cell rendered as an empty `dd.mm.yyyy, --:--` — the column WAS created
 * and the row WAS written, but the value never showed). Root cause:
 * server/forms/service.ts used to write `new Date().toISOString()`
 * (`"2026-09-21T12:34:56.789Z"` — milliseconds + a `Z` offset) straight into
 * this `date, time: true` column. `values.ts#encodeCell`/`decodeCell` do NO
 * parsing for the `date` type — a cell's stored value is whatever string was
 * put there, verbatim (see that module's own doc comment) — and the ONE
 * place a `date, time: true` value is ever consulted is
 * `web/src/tables/cells/CellComponents.tsx`'s `DateCell` (and
 * RowDetailPanel's twin), which hands it straight to an
 * `<input type="datetime-local">`. Per the HTML spec that input's `value`
 * must be a "local date and time string" — `YYYY-MM-DDTHH:mm[:ss]`, no
 * timezone designator — so a `Z`-suffixed ISO string is simply an INVALID
 * value for it: the browser silently ignores it and the input renders
 * empty, exactly the reported symptom (checked in the browser: setting an
 * `<input type="datetime-local">`'s `.value` to an ISO string with `Z`
 * leaves it blank; the same string without the `Z`/milliseconds renders
 * fine). This formats the submission time in that exact shape instead, off
 * the server's own local clock (there is no per-row timezone anywhere else
 * in the table model either — every `date`/`datetime-local` value in this
 * app is already a zone-less wall-clock string, filled in by whoever's
 * browser wrote it; this keeps a server-written one consistent with that).
 */
export function formatSubmittedAt(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** One field per non-system column, in column order — the starter mapping for "Create a form" on an existing table, and for a field-editor's "regenerate from table" action. */
export function deriveFieldsFromColumns(columns: TableColumn[]): FormField[] {
  return columns
    .filter((c) => !SYSTEM_COLUMN_IDS.has(c.id))
    .map((c) => ({ columnId: c.id, label: c.name, help: c.description, required: false, kind: c.type }));
}

export interface SubmissionOk {
  ok: true;
  values: Record<string, TableCellValue>;
}
export interface SubmissionError {
  ok: false;
  /** columnId -> human-ish reason, i18n'd by the caller (server returns the raw key, web maps it to text). */
  errors: Record<string, 'required' | 'invalid'>;
}

function isEmptyInput(raw: unknown): boolean {
  return raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0);
}

/**
 * Required-field check + per-kind coercion of a raw (JSON-from-the-wire)
 * submission into typed `TableCellValue`s ready for
 * `server/tables/service.ts#insertRows`. Never throws — a bad submission is
 * data, not a bug, so every problem comes back as `errors` for the caller
 * (server: 400; web form: inline messages) to present.
 */
export function validateSubmission(fields: readonly FormField[], input: Record<string, unknown>): SubmissionOk | SubmissionError {
  const errors: Record<string, 'required' | 'invalid'> = {};
  const values: Record<string, TableCellValue> = {};

  for (const field of fields) {
    const raw = input[field.columnId];
    if (isEmptyInput(raw)) {
      if (field.required) errors[field.columnId] = 'required';
      else values[field.columnId] = null;
      continue;
    }
    switch (field.kind) {
      case 'number': {
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(n)) {
          errors[field.columnId] = 'invalid';
          break;
        }
        values[field.columnId] = n;
        break;
      }
      case 'checkbox':
        values[field.columnId] = raw === true || raw === 'true' || raw === 'on' || raw === 1;
        break;
      case 'select':
      case 'status':
        // `multiple` isn't tracked per-field (v1 scope cut, see round report)
        // — an array from a multi-select widget is still accepted and joined
        // the same way shared/tables/values.ts's own `select(multiple)`
        // encoding does, so the row lands with a sane string either way.
        values[field.columnId] = Array.isArray(raw) ? raw.map(String) : String(raw);
        break;
      case 'user':
      case 'link':
      case 'text':
      case 'longtext':
      case 'date':
      default:
        values[field.columnId] = Array.isArray(raw) ? raw.map(String).join(', ') : String(raw);
        break;
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, values };
}
