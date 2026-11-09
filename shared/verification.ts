/**
 * Page owner, verification date and review deadline (wave "verification").
 *
 * Three page properties, kept in Git like every other property (a document's
 * front matter; a board's / file's sidecar `.folio/<path>.props.yaml`):
 *
 *   owner      a username (text)
 *   verified   when the text was last confirmed to be right. "Mark as verified" writes a
 *              UTC datetime (`2026-11-09T14:32:05`) so that an edit later the same day still
 *              shows as "changed"; a plain date written by hand covers its whole day
 *   review_by  the date the next confirmation is due (date)
 *
 * THE one place where the state of a page is computed: the server (the tree,
 * read_page, fetch, the daily reminder job) and the client (the badge, the
 * panel) all call computeVerification, so they cannot disagree.
 *
 * The values are edited by hand and through Git, so nothing here trusts them:
 * a value that is not a real calendar day counts as absent (and is reported in
 * `invalid`), an owner that is not a string is ignored. Whether the owner
 * exists is not known here (that needs the users table) - callers that care
 * (the reminders) look the username up themselves.
 */

export type VerificationState = 'unverified' | 'verified' | 'changed' | 'overdue';

export const OWNER_KEY = 'owner';
export const VERIFIED_KEY = 'verified';
export const REVIEW_BY_KEY = 'review_by';
export const VERIFICATION_KEYS = [OWNER_KEY, VERIFIED_KEY, REVIEW_BY_KEY] as const;

/** The review period a "Mark as verified" click sets, in days. */
export const DEFAULT_REVIEW_DAYS = 90;

/**
 * A verification given as a datetime counts the page as changed only after
 * this much time: the click that writes it also touches the file a few
 * milliseconds later (the server puts updated_at back, this is the safety net
 * for when that could not be done), which is not an edit of the text.
 */
export const VERIFIED_GRACE_MS = 3 * 1000;

/** What the three keys hold in the file / the index row, untouched. */
export interface VerificationProps {
  owner?: unknown;
  verified?: unknown;
  review_by?: unknown;
}

/** What goes to the client and to agents. Dates are `YYYY-MM-DD`. */
export interface PageVerification {
  state: VerificationState;
  /** Username of the owner, as written in the file (lower-cased, no leading @). */
  owner?: string;
  verified?: string;
  reviewBy?: string;
  /** Whole days past `reviewBy`, for `overdue`. */
  daysOverdue?: number;
  /** Keys whose value is not a valid date and was ignored. */
  invalid?: Array<'verified' | 'review_by'>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$)/;

interface ParsedDay {
  /** `YYYY-MM-DD` */
  day: string;
  /** Milliseconds since the epoch when the value carries a time of day (not midnight UTC); null for a plain date. */
  instant: number | null;
}

/** A calendar day from a YAML value (string, or a Date the YAML reader produced); null when it is not a real day. */
export function parseDay(value: unknown): ParsedDay | null {
  if (value instanceof Date) {
    const t = value.getTime();
    if (!Number.isFinite(t)) return null;
    const iso = value.toISOString();
    const midnight = iso.endsWith('T00:00:00.000Z');
    return { day: iso.slice(0, 10), instant: midnight ? null : t };
  }
  if (typeof value !== 'string') return null;
  const m = DATE_PREFIX.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, zone] = m;
  const year = Number(y);
  const month = Number(mo);
  const dayOfMonth = Number(d);
  const probe = new Date(Date.UTC(year, month - 1, dayOfMonth));
  // 2026-02-31 rolls over to March: reject, do not guess.
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== dayOfMonth) return null;
  const day = `${y}-${mo}-${d}`;
  if (hh === undefined) return { day, instant: null };
  const hours = Number(hh);
  const minutes = Number(mm);
  const seconds = Number(ss ?? '0');
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  // The index stores a YAML date as midnight UTC: that is a plain date, not a time of day.
  if (hours === 0 && minutes === 0 && seconds === 0 && (!zone || zone === 'Z')) return { day, instant: null };
  let t = Date.UTC(year, month - 1, dayOfMonth, hours, minutes, seconds);
  if (zone && zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    t -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60 * 1000;
  }
  return { day, instant: t };
}

/** The owner username as the file spells it, normalised the way usernames are compared; null when absent or not text. */
export function parseOwner(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/^@+/, '').toLowerCase();
  return name.length > 0 && name.length <= 100 ? name : null;
}

/** Today as `YYYY-MM-DD` in UTC (dates in the files are UTC days, like everywhere else in the property code). */
export function todayDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** `day` plus `days`, as `YYYY-MM-DD`. */
export function addDays(day: string, days: number): string {
  const parsed = parseDay(day);
  const base = parsed ? Date.parse(`${parsed.day}T00:00:00Z`) : Date.now();
  return new Date(base + days * DAY_MS).toISOString().slice(0, 10);
}

/** The first moment at which an update counts as "after" the verification. */
function changedAfter(verified: ParsedDay): number {
  if (verified.instant !== null) return verified.instant + VERIFIED_GRACE_MS;
  // A plain date covers the whole day: an edit on the same day is not "after" it.
  return Date.parse(`${verified.day}T00:00:00Z`) + DAY_MS;
}

/** True when the page has any of the three keys with something in it - otherwise it carries no verification at all. */
export function hasVerificationProps(props: VerificationProps | null | undefined): boolean {
  if (!props) return false;
  return VERIFICATION_KEYS.some((key) => {
    const v = props[key];
    return v !== undefined && v !== null && v !== '';
  });
}

/**
 * The state of a page. `updatedAt` is the index row's updated_at; a bad one
 * (not a date) never makes a page "changed". Returns null when the page has
 * none of the three keys.
 */
export function computeVerification(props: VerificationProps | null | undefined, updatedAt: string | null | undefined, now: Date = new Date()): PageVerification | null {
  if (!hasVerificationProps(props)) return null;
  const owner = parseOwner(props?.owner);
  const verified = parseDay(props?.verified);
  const reviewBy = parseDay(props?.review_by);
  const invalid: Array<'verified' | 'review_by'> = [];
  const given = (v: unknown): boolean => v !== undefined && v !== null && v !== '';
  if (given(props?.verified) && !verified) invalid.push('verified');
  if (given(props?.review_by) && !reviewBy) invalid.push('review_by');

  const out: PageVerification = { state: 'unverified' };
  if (owner) out.owner = owner;
  if (verified) out.verified = verified.day;
  if (reviewBy) out.reviewBy = reviewBy.day;
  if (invalid.length > 0) out.invalid = invalid;

  const today = todayDay(now);
  if (reviewBy && reviewBy.day < today) {
    out.state = 'overdue';
    out.daysOverdue = Math.max(1, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${reviewBy.day}T00:00:00Z`)) / DAY_MS));
    return out;
  }
  if (!verified) return out;
  const updated = updatedAt ? Date.parse(updatedAt) : NaN;
  out.state = Number.isFinite(updated) && updated >= changedAfter(verified) ? 'changed' : 'verified';
  return out;
}

/** The three keys out of a front matter object (or a sidecar's data), nothing else. */
export function pickVerificationProps(data: unknown): VerificationProps {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const record = data as Record<string, unknown>;
  const out: VerificationProps = {};
  if (record.owner !== undefined) out.owner = record.owner;
  if (record.verified !== undefined) out.verified = record.verified;
  if (record.review_by !== undefined) out.review_by = record.review_by;
  return out;
}
