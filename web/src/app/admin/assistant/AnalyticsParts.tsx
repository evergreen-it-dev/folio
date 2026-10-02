import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AdminAssistantFilterOptions, AdminAssistantUserRef, AssistantUnansweredReason } from '@shared/contracts';
import { PAGE_SIZE, type AnalyticsFilters } from './logic';
import '../../i18n/register';

const CONTROL_CLASS =
  'rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200';
const LABEL_CLASS = 'flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400';

export interface FilterBarProps {
  filters: AnalyticsFilters;
  /** Patch of the changed fields; the owner resets the page offset. */
  onChange: (patch: Partial<AnalyticsFilters>) => void;
  options: AdminAssistantFilterOptions | undefined;
  withReason?: boolean;
}

/** Space / user / (reason) / date-range filters shared by both analytics lists. */
export function FilterBar({ filters, onChange, options, withReason }: FilterBarProps) {
  const { t } = useTranslation('app');
  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <label className={LABEL_CLASS}>
        {t('assistantAdmin.filters.space')}
        <select value={filters.space} onChange={(e) => onChange({ space: e.target.value })} className={CONTROL_CLASS}>
          <option value="">{t('assistantAdmin.filters.allSpaces')}</option>
          {(options?.spaces ?? []).map((slug) => (
            <option key={slug} value={slug}>
              {slug}
            </option>
          ))}
        </select>
      </label>
      <label className={LABEL_CLASS}>
        {t('assistantAdmin.filters.user')}
        <select value={filters.userId} onChange={(e) => onChange({ userId: e.target.value })} className={`${CONTROL_CLASS} max-w-56`}>
          <option value="">{t('assistantAdmin.filters.allUsers')}</option>
          {(options?.users ?? []).map((user) => (
            <option key={user.id} value={user.id}>
              {user.name} ({user.email})
            </option>
          ))}
        </select>
      </label>
      {withReason && (
        <label className={LABEL_CLASS}>
          {t('assistantAdmin.filters.reason')}
          <select value={filters.reason} onChange={(e) => onChange({ reason: e.target.value })} className={CONTROL_CLASS}>
            <option value="">{t('assistantAdmin.filters.allReasons')}</option>
            {(['no_answer', 'low_confidence'] as const).map((reason) => (
              <option key={reason} value={reason}>
                {t(`assistantAdmin.reasons.${reason}`)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className={LABEL_CLASS}>
        {t('assistantAdmin.filters.from')}
        <input type="date" value={filters.from} onChange={(e) => onChange({ from: e.target.value })} className={CONTROL_CLASS} />
      </label>
      <label className={LABEL_CLASS}>
        {t('assistantAdmin.filters.to')}
        <input type="date" value={filters.to} onChange={(e) => onChange({ to: e.target.value })} className={CONTROL_CLASS} />
      </label>
    </div>
  );
}

export interface PaginationProps {
  offset: number;
  total: number;
  onOffset: (offset: number) => void;
}

export function Pagination({ offset, total, onOffset }: PaginationProps) {
  const { t } = useTranslation('app');
  if (total === 0) return null;
  const buttonClass =
    'flex items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800';
  return (
    <div className="mt-3 flex items-center justify-between gap-3 text-xs text-neutral-500 dark:text-neutral-400">
      <span>{t('assistantAdmin.pagination.range', { from: offset + 1, to: Math.min(offset + PAGE_SIZE, total), total })}</span>
      <div className="flex items-center gap-1.5">
        <button type="button" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - PAGE_SIZE))} className={buttonClass}>
          <ChevronLeft size={12} /> {t('assistantAdmin.pagination.prev')}
        </button>
        <button type="button" disabled={offset + PAGE_SIZE >= total} onClick={() => onOffset(offset + PAGE_SIZE)} className={buttonClass}>
          {t('assistantAdmin.pagination.next')} <ChevronRight size={12} />
        </button>
      </div>
    </div>
  );
}

export function UserCell({ user }: { user: AdminAssistantUserRef }) {
  return (
    <div className="min-w-0">
      <div className="truncate font-medium text-neutral-800 dark:text-neutral-200">{user.name}</div>
      <div className="truncate text-xs text-neutral-500 dark:text-neutral-400">{user.email}</div>
    </div>
  );
}

export function SpaceCell({ space }: { space: string | null }) {
  if (!space) return <span className="text-neutral-400 dark:text-neutral-500">—</span>;
  return <code className="text-xs text-neutral-500 dark:text-neutral-400">{space}</code>;
}

export function ReasonBadge({ reason }: { reason: AssistantUnansweredReason }) {
  const { t } = useTranslation('app');
  const tone =
    reason === 'no_answer'
      ? 'bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300'
      : 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300';
  return <span className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-xs ${tone}`}>{t(`assistantAdmin.reasons.${reason}`)}</span>;
}

export const TABLE_HEAD_CLASS = 'border-b border-neutral-200 text-left text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400';
export const TABLE_ROW_CLASS = 'border-b border-neutral-100 last:border-b-0 dark:border-neutral-800/60';
