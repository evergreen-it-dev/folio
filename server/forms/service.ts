/**
 * Round FORMS — the submit path: `POST /api/forms/:id/submit` (server/
 * forms/routes.ts) is a thin wrapper around this module, same "thin route +
 * directly-testable module function" split server/tables/routes.ts documents
 * for its own zone.
 *
 * The one invariant this module exists to enforce: a submission is ALWAYS
 * appended through server/tables/service.ts#insertRows — never a second,
 * parallel writer of the paired table's file. insertRows itself already
 * goes through the live-document path when a collab room is open
 * (collab.editTableDoc) and falls back to a direct file write otherwise
 * (server/tables/service.ts's own module doc comment) — this module doesn't
 * need to know which; that's exactly the point of reusing it.
 */
import { badRequest, notFound } from '../errors.js';
import * as storage from '../storage.js';
import type { PageIndexEntry } from '../storage.js';
import * as tables from '../tables/service.js';
import * as collab from '../collab.js';
import { SUBMITTED_AT_COLUMN_ID, SUBMITTER_COLUMN_ID, formatSubmittedAt, systemColumns, validateSubmission } from '../../shared/forms/index.js';
import type { FormDoc, SubmissionError } from '../../shared/forms/index.js';

export class FormValidationError extends Error {
  constructor(public readonly errors: SubmissionError['errors']) {
    super('form submission failed validation');
  }
}

/**
 * Resolves the paired table's page id from a form's `table`
 * (space-root-relative) frontmatter field — self-healing when that stored
 * path has gone stale (a move or slug rename touching either side of the
 * pair, or an ancestor directory of either, none of which ever rewrite
 * `table:`; see storage.resolvePairedTableEntry's own doc comment for the
 * full mechanics and why the pair's TREE position is what the fallback
 * trusts instead). Only throws 404 when the table is genuinely gone —
 * neither at the stored path nor findable by tree position — which really
 * is a dangling reference, not a "try again" case.
 */
export async function resolvePairedTableId(formEntry: PageIndexEntry, tableRelPath: string): Promise<string> {
  const tableEntry = await storage.resolvePairedTableEntry(formEntry, tableRelPath);
  if (!tableEntry) throw notFound(`the table paired with this form was not found (looked for "${tableRelPath}")`);
  if (tableEntry.relPath !== tableRelPath) {
    // Found by tree position, not by the stored path: heal it so the next
    // resolution is the cheap exact-path lookup again. Best-effort — see
    // healFormTablePath's own doc comment for why a failure here must never
    // surface to the caller, who already has the id it asked for.
    await storage.healFormTablePath(formEntry.id, tableEntry.relPath).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[forms] could not update the stale table: path in form ${formEntry.id}:`, err);
    });
  }
  return tableEntry.id;
}

/**
 * Owner ask (22.09.2026, sidebar screenshot): renaming a FORM should carry
 * its default-titled paired table's TITLE along — a table nested under a
 * freshly-renamed form was still showing "New form", the name it got at
 * creation. Called from both places a form rename lands — the REST rename
 * route's form branch (server/routes.ts) and pageChanges.ts's undo path's
 * form branch — right after `storage.renameFormDirect` itself. It lives HERE
 * rather than next to renameFormDirect in server/storage.ts because it needs
 * `collab.applyH1Rename`, and storage.ts cannot import collab.ts without a
 * cycle (collab.ts already imports storage.ts); this module already imports
 * both with no cycle (collab.ts imports neither forms/service.ts nor
 * pageChanges.ts).
 *
 * Same collab-room-first ordering server/routes.ts's own table-rename branch
 * uses: `applyH1Rename` wins when the table is LIVE (its Y.Doc is the
 * authoritative copy — writing the H1 straight to the file there would get
 * clobbered by the room's next debounced flush, silently reverting the
 * rename); `renameTableFile` (a plain file write) is only the fallback for
 * when no room is open.
 *
 * ONE direction only — form -> table, never the reverse: a table can be the
 * target of several forms, so "which form's title wins" is ambiguous;
 * renaming a table must never touch any form.
 *
 * Best-effort: a missing/foreign/non-table paired entry, or any other
 * failure, is logged and swallowed — the paired table's title is cosmetic
 * next to the form rename the user actually asked for, never a reason to
 * fail it. No retro-fix for form/table pairs already sitting in spaces;
 * this only runs on the next rename.
 *
 * Owner report (22.09.2026, second round: "I renamed it and nothing happened"): this
 * used to look the table up with `getEntryIdByExactPath` — the STORED path
 * only — so for a pair whose `form.table` had gone stale it found nothing
 * and, being best-effort, returned silently. That is the same staleness
 * resolvePairedTableEntry exists to absorb (see its doc comment), and the
 * very pair the owner hit was already known to be stale — it is what broke
 * «Edit form» saving. Going through the shared resolver instead means a
 * rename can no longer be defeated by a move or slug rename, and it heals
 * the stored path on the way through.
 */
export async function renamePairedTableBestEffort(formEntry: PageIndexEntry, tableRelPath: string, title: string): Promise<void> {
  try {
    const tableEntry = await storage.resolvePairedTableEntry(formEntry, tableRelPath);
    if (!tableEntry || tableEntry.kind !== 'table') return;
    if (tableEntry.relPath !== tableRelPath) {
      await storage.healFormTablePath(formEntry.id, tableEntry.relPath).catch(() => {
        // Healing is an optimisation for the NEXT lookup; the rename below
        // already has the entry it needs — see healFormTablePath's own note.
      });
    }
    if (!(await collab.applyH1Rename(tableEntry.id, title))) {
      await storage.renameTableFile(tableEntry.id, title);
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[forms] could not rename the paired table (space=${formEntry.space}, table=${tableRelPath}):`, error);
  }
}

/** Adds `submitted_at`/`submitter` to the table if either is missing. Idempotent — cheap to call on every submit rather than tracked separately. */
async function ensureSystemColumns(tableId: string): Promise<void> {
  const snapshot = await tables.getTableSnapshot(tableId);
  const existingIds = new Set(snapshot.columns.map((c) => c.id));
  for (const column of systemColumns()) {
    if (!existingIds.has(column.id)) {
      // eslint-disable-next-line no-await-in-loop -- two columns, order matters for a readable diff, not worth Promise.all's parallel-write race here
      await tables.addColumn(tableId, column);
    }
  }
}

export interface SubmitFormResult {
  rowId: string;
}

/**
 * Validates `rawValues` against the form's OWN fields (never the table's
 * live columns directly — a field's `kind` is a snapshot, see FormField's
 * doc comment in shared/contracts.ts) and appends one row.
 * `submitterLabel` is the caller's job to resolve (a signed-in user's name,
 * or the literal 'anonymous') — this module is agnostic to auth.
 */
export async function submitForm(formEntry: PageIndexEntry, submitterLabel: string, rawValues: Record<string, unknown>): Promise<SubmitFormResult> {
  if (formEntry.kind !== 'form') throw badRequest('page is not a form');
  const form: FormDoc = await storage.readFreshFormDoc(formEntry.id);
  const tableId = await resolvePairedTableId(formEntry, form.table);

  const result = validateSubmission(form.fields, rawValues);
  if (!result.ok) throw new FormValidationError(result.errors);

  await ensureSystemColumns(tableId);
  const values = {
    ...result.values,
    // formatSubmittedAt, not toISOString() — see its own doc comment
    // (shared/forms/fields.ts) for the bug a bare ISO-with-`Z` string caused.
    [SUBMITTED_AT_COLUMN_ID]: formatSubmittedAt(new Date()),
    [SUBMITTER_COLUMN_ID]: submitterLabel,
  };
  const { rows } = await tables.insertRows(tableId, [values]);
  return { rowId: rows[0].id };
}
