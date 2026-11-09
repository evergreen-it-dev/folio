/**
 * Page owner, verification date and review deadline - the server side
 * (the state itself is computed in shared/verification.ts).
 *
 *   updateVerification   the "Mark as verified" button and the owner / deadline fields:
 *                        a merge into the page's properties through the same writer as
 *                        the properties panel (properties.ts), then the three types are
 *                        declared in `.folio/properties.json`
 *   runReviewReminders   the daily job: pages whose review_by has passed get a
 *                        `review_due` notification - to the owner, else to the space's
 *                        admins - at most once a week per page
 *
 * The weekly limit is read from the `notifications` table, not from memory: a restart
 * (a deploy is a restart) must not make every overdue page ring again.
 */
import type { PropertyType } from '../shared/contracts.js';
import {
  addDays,
  computeVerification,
  DEFAULT_REVIEW_DAYS,
  OWNER_KEY,
  parseDay,
  parseOwner,
  pickVerificationProps,
  REVIEW_BY_KEY,
  todayDay,
  VERIFIED_KEY,
  type PageVerification,
} from '../shared/verification.js';
import { query, queryOne } from './db/pool.js';
import { badRequest } from './errors.js';
import { deliverToPage } from './notifications/dispatch.js';
import * as notificationStore from './notifications/store.js';
import { mergePropertyPatch, propertiesStoreOf, readPageProperties, savePageProperties } from './properties.js';
import { readDeclaredTypes, writeSpacePropertyTypes } from './propertyTypes.js';
import * as storage from './storage.js';
import type { PageIndexEntry } from './storage.js';

/** How often one page may remind: the weekly limit. */
export const REVIEW_REMINDER_INTERVAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const VERIFICATION_TYPES: Record<string, PropertyType> = {
  [OWNER_KEY]: 'text',
  [VERIFIED_KEY]: 'datetime',
  [REVIEW_BY_KEY]: 'date',
};

/** What the owner / deadline fields and the button can ask for. */
export interface VerificationPatch {
  /** A username to make the owner, or null to remove the owner. */
  owner?: string | null;
  /** The next review day (`YYYY-MM-DD`), or null to remove the deadline. */
  reviewBy?: string | null;
  /** Stamp `verified` with today and move `review_by` forward. */
  markVerified?: boolean;
  /** With markVerified: days until the next review. Default: the page's previous period, else 90. */
  reviewDays?: number;
}

export interface VerificationResult {
  written: boolean;
  verification: PageVerification | null;
}

/** Declares owner / verified / review_by in the space's types file, unless the space already types them. Never throws: a missing declaration is only a missing hint. */
export async function ensureVerificationTypes(space: string, actor: { name: string; email: string }): Promise<void> {
  try {
    const declared = await readDeclaredTypes(space);
    const missing = Object.keys(VERIFICATION_TYPES).filter((key) => declared.types[key] === undefined);
    if (missing.length === 0) return;
    const types: Record<string, PropertyType> = { ...declared.types };
    for (const key of missing) types[key] = VERIFICATION_TYPES[key];
    await writeSpacePropertyTypes(space, actor, types);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[verification] could not declare the property types in ${space}:`, err);
  }
}

/** A day count between two `YYYY-MM-DD` days; null when either is not a day. */
function daysBetween(from: unknown, to: unknown): number | null {
  const a = parseDay(from);
  const b = parseDay(to);
  if (!a || !b) return null;
  return Math.round((Date.parse(`${b.day}T00:00:00Z`) - Date.parse(`${a.day}T00:00:00Z`)) / DAY_MS);
}

/**
 * Writes the owner / deadline / verification of one page. The caller has checked
 * that the user may edit the page and that the token may write.
 */
export async function updateVerification(entry: PageIndexEntry, user: Parameters<typeof savePageProperties>[1], patch: VerificationPatch, now: Date = new Date()): Promise<VerificationResult> {
  if (propertiesStoreOf(entry.kind) === 'none') throw badRequest('this page has no properties');
  const current = await readPageProperties(entry, true);
  if (!current.canEdit) throw badRequest('the properties of this page cannot be edited (its front matter or sidecar cannot be parsed); fix it in the file first');

  const props: Record<string, unknown> = {};
  if (patch.owner !== undefined) {
    if (patch.owner === null || patch.owner.trim() === '') props[OWNER_KEY] = null;
    else {
      const username = parseOwner(patch.owner);
      if (!username) throw badRequest('owner must be a username');
      if (!(await activeUsersByUsername([username])).has(username)) throw badRequest(`no active user with the username "${username}"`);
      props[OWNER_KEY] = username;
    }
  }
  if (patch.reviewBy !== undefined) {
    if (patch.reviewBy === null) props[REVIEW_BY_KEY] = null;
    else {
      const day = parseDay(patch.reviewBy);
      if (!day) throw badRequest('reviewBy must be a date, YYYY-MM-DD');
      props[REVIEW_BY_KEY] = day.day;
    }
  }
  if (patch.markVerified) {
    const today = todayDay(now);
    props[VERIFIED_KEY] = now.toISOString().slice(0, 19);
    if (patch.reviewBy === undefined) {
      const previous = daysBetween(current.properties[VERIFIED_KEY], current.properties[REVIEW_BY_KEY]);
      const days = patch.reviewDays ?? (previous !== null && previous > 0 ? previous : DEFAULT_REVIEW_DAYS);
      if (!Number.isInteger(days) || days < 1 || days > 3650) throw badRequest('reviewDays must be a whole number of days, 1 to 3650');
      props[REVIEW_BY_KEY] = addDays(today, days);
    }
  }
  if (Object.keys(props).length === 0) return { written: false, verification: storage.toPageMeta(await storage.requireEntry(entry.id)).verification ?? null };

  const result = await savePageProperties(entry, user, { properties: mergePropertyPatch(entry.kind, current.properties, props), etag: current.etag }, { source: 'verification' });
  if (result.written) await ensureVerificationTypes(entry.space, { name: user.name, email: user.email });
  const fresh = await storage.requireEntry(entry.id);
  return { written: result.written, verification: storage.toPageMeta(fresh).verification ?? null };
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

export interface ReminderRun {
  /** Pages with a review_by on them. */
  checked: number;
  overdue: number;
  /** Overdue pages skipped because they already reminded within the week. */
  throttled: number;
  /** Pages for which at least one notification row was created. */
  reminded: number;
  /** Rows created in all. */
  notifications: number;
  /** Overdue pages nobody could be told about (no owner and no space admin who can read them). */
  unreachable: number;
}

interface CandidateRow {
  id: string;
  space_slug: string;
  frontmatter: unknown;
  updated_at: string;
}

/** Usernames -> ids of the active, non-system accounts that have them. A name nobody has is simply absent. */
async function activeUsersByUsername(usernames: string[]): Promise<Map<string, string>> {
  if (usernames.length === 0) return new Map();
  const rows = await query<{ id: string; username: string }>('SELECT id, username FROM users WHERE username = ANY($1::text[]) AND NOT disabled AND NOT is_system', [usernames]);
  return new Map(rows.map((r) => [r.username.toLowerCase(), r.id]));
}

let running = false;

/**
 * One pass of the daily job. Safe to run at any time and any number of times:
 * a page that reminded in the last 7 days is skipped, whoever asks.
 */
export async function runReviewReminders(now: Date = new Date()): Promise<ReminderRun> {
  const run: ReminderRun = { checked: 0, overdue: 0, throttled: 0, reminded: 0, notifications: 0, unreachable: 0 };
  if (running) return run;
  running = true;
  try {
    // Not a date comparison in SQL: the value is hand-edited and a bad date would fail the whole query.
    const rows = await query<CandidateRow>(
      `SELECT id, space_slug, frontmatter, updated_at
         FROM pages_index
        WHERE jsonb_typeof(frontmatter) = 'object'
          AND frontmatter ? 'review_by'
          AND kind <> 'folder'
          AND path NOT LIKE '\\_templates/%'
          AND COALESCE(status, 'published') <> 'archived'`,
    );
    run.checked = rows.length;

    const due: Array<{ row: CandidateRow; verification: PageVerification }> = [];
    for (const row of rows) {
      const verification = computeVerification(pickVerificationProps(row.frontmatter), new Date(row.updated_at).toISOString(), now);
      if (verification?.state === 'overdue') due.push({ row, verification });
    }
    run.overdue = due.length;
    if (due.length === 0) return run;

    const since = new Date(now.getTime() - REVIEW_REMINDER_INTERVAL_DAYS * DAY_MS);
    const recent = await query<{ page_id: string }>(
      `SELECT DISTINCT page_id FROM notifications WHERE kind = 'review_due' AND page_id = ANY($1::text[]) AND created_at > $2`,
      [due.map((d) => d.row.id), since.toISOString()],
    );
    const alreadyReminded = new Set(recent.map((r) => r.page_id));
    const owners = await activeUsersByUsername([...new Set(due.map((d) => d.verification.owner).filter((o): o is string => !!o))]);

    for (const { row, verification } of due) {
      if (alreadyReminded.has(row.id)) {
        run.throttled += 1;
        continue;
      }
      try {
        const payload = { reviewBy: verification.reviewBy, daysOverdue: verification.daysOverdue, ...(verification.owner ? { owner: verification.owner } : {}) };
        const ownerId = verification.owner ? owners.get(verification.owner) : undefined;
        // The owner first; a missing, disabled or no longer reading owner leaves the page with the space's admins.
        let told = ownerId ? await deliverToPage([ownerId], 'review_due', row.id, payload) : [];
        if (told.length === 0) told = await deliverToPage(await notificationStore.listSpaceAdminIds(row.space_slug), 'review_due', row.id, { ...payload, toAdmins: true });
        if (told.length > 0) {
          run.reminded += 1;
          run.notifications += told.length;
        } else {
          run.unreachable += 1;
        }
      } catch (err) {
        // One page's failure must not stop the others; it is tried again tomorrow.
        // eslint-disable-next-line no-console
        console.error(`[verification] reminder for ${row.id} failed:`, err);
      }
    }
    return run;
  } finally {
    running = false;
  }
}

const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;

/** Starts the daily reminder job (the pattern of collab.ts's backup pruning; one process, so no duplicates). The first pass waits for the boot scan. */
export function startReviewReminders(): void {
  const tick = (): void => {
    void runReviewReminders()
      .then((run) => {
        if (run.overdue > 0) {
          // eslint-disable-next-line no-console
          console.log(`[verification] review reminders: ${run.overdue} overdue, ${run.reminded} reminded (${run.notifications} notifications), ${run.throttled} within the week, ${run.unreachable} unreachable`);
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[verification] review reminders failed:', err);
      });
  };
  setTimeout(tick, FIRST_RUN_DELAY_MS).unref();
  setInterval(tick, DAY_MS).unref();
}

/** For tests and tools: how many review_due rows a page has had in the last `days`. */
export async function countRecentReviewReminders(pageId: string, days = REVIEW_REMINDER_INTERVAL_DAYS): Promise<number> {
  const row = await queryOne<{ count: string }>(`SELECT COUNT(*) FROM notifications WHERE kind = 'review_due' AND page_id = $1 AND created_at > now() - make_interval(days => $2)`, [pageId, days]);
  return Number(row?.count ?? '0');
}
