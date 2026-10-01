/**
 * Pure display helpers for the page-history panel. PageHistoryEntry only
 * carries a full sha and an ISO date (see shared/contracts.ts) — "short
 * sha" and "relative date" are client-side presentation, computed here so
 * they're independently testable.
 */
import i18next from 'i18next';
import { t } from './i18n/register';
import './i18n/register';

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * "just now" / "5 minutes ago" / "3 hours ago" / "2 days ago", falling back
 * to a plain localized date past ~30 days. `now` is injectable for tests;
 * defaults to the real clock. Round 10: plurals resolve from `count` via
 * i18next's own CLDR-driven plural rule for the current language (ru/uk
 * both need one/few/many/other, en needs one/other — see app/i18n/*.json's
 * history.*Ago_* keys), and the date fallback follows the current language too.
 */
export function formatRelativeDate(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const diffSec = Math.round((now.getTime() - date.getTime()) / 1000);

  if (diffSec < 60) return t('history.justNow');

  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return t('history.minutesAgo', { count: diffMin });

  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return t('history.hoursAgo', { count: diffHour });

  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 30) return t('history.daysAgo', { count: diffDay });

  return date.toLocaleDateString(i18next.language, { day: 'numeric', month: 'short', year: 'numeric' });
}
