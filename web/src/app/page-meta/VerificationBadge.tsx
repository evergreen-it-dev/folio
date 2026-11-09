import { useTranslation } from 'react-i18next';
import { BadgeCheck, CircleAlert, PencilLine } from 'lucide-react';
import type { PageMeta } from '@shared/contracts';
import '../i18n/register';

/** A `YYYY-MM-DD` day in the reader's language; the day is a UTC day, so it is never shifted by the time zone. */
export function formatVerificationDay(day: string, locale: string): string {
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? day : parsed.toLocaleDateString(locale, { timeZone: 'UTC' });
}

/**
 * The reader's one-line answer to "can I trust this text": verified (date, who),
 * changed after the verification, or past its review date. A page with no
 * verification, or one that was never verified, shows nothing - it does not nag.
 */
export function VerificationBadge({ verification }: { verification: PageMeta['verification'] }) {
  const { t, i18n } = useTranslation('app');
  if (!verification || verification.state === 'unverified') return null;
  const owner = verification.owner ? `@${verification.owner}` : '';
  let text: string;
  let tone: string;
  let Icon = BadgeCheck;
  if (verification.state === 'overdue') {
    text = t('verification.badge.overdue', { days: verification.daysOverdue ?? 0 });
    tone = 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200';
    Icon = CircleAlert;
  } else if (verification.state === 'changed') {
    text = t('verification.badge.changed');
    tone = 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200';
    Icon = PencilLine;
  } else {
    text = t('verification.badge.verified', { date: formatVerificationDay(verification.verified ?? '', i18n.language), owner });
    tone = 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200';
  }
  return (
    <span data-testid={`verification-badge-${verification.state}`} className={`inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs ${tone}`}>
      <Icon size={12} className="shrink-0" aria-hidden="true" />
      <span className="truncate">{text.trim()}</span>
    </span>
  );
}
