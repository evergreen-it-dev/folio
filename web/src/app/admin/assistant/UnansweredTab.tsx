import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { formatDateTime } from '../../formatDate';
import { FilterBar, Pagination, ReasonBadge, SpaceCell, TABLE_HEAD_CLASS, TABLE_ROW_CLASS, UserCell } from './AnalyticsParts';
import { PAGE_SIZE, conversationHref, type AnalyticsFilters } from './logic';
import '../../i18n/register';

export interface UnansweredTabProps {
  filters: AnalyticsFilters;
  onChange: (patch: Partial<AnalyticsFilters>) => void;
  onOffset: (offset: number) => void;
}

/** "Questions without an answer": what the assistant itself reported it could not answer or was unsure about. */
export function UnansweredTab({ filters, onChange, onOffset }: UnansweredTabProps) {
  const { t, i18n } = useTranslation('app');
  const { data, isLoading, isError } = useQuery({
    queryKey: ['assistant-admin', 'unanswered', filters],
    queryFn: () =>
      api.listAdminAssistantUnanswered({
        space: filters.space || undefined,
        userId: filters.userId || undefined,
        reason: filters.reason || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
        limit: PAGE_SIZE,
        offset: filters.offset,
      }),
    placeholderData: keepPreviousData,
  });
  const items = data?.items ?? [];

  return (
    <>
      <FilterBar filters={filters} onChange={onChange} options={data} withReason />

      {isLoading && <p className="text-sm text-neutral-400">{t('ui.loading')}</p>}
      {isError && <p className="text-sm text-red-600 dark:text-red-400">{t('assistantAdmin.loadFailed')}</p>}
      {!isLoading && !isError && items.length === 0 && <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('assistantAdmin.emptyUnanswered')}</p>}

      {items.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[960px] text-sm">
            <thead>
              <tr className={TABLE_HEAD_CLASS}>
                <th className="px-3 py-2 font-medium">{t('assistantAdmin.columns.date')}</th>
                <th className="px-3 py-2 font-medium">{t('assistantAdmin.columns.user')}</th>
                <th className="px-3 py-2 font-medium">{t('assistantAdmin.columns.space')}</th>
                <th className="px-3 py-2 font-medium">{t('assistantAdmin.columns.question')}</th>
                <th className="px-3 py-2 font-medium">{t('assistantAdmin.columns.reason')}</th>
                <th className="px-3 py-2 font-medium">{t('assistantAdmin.columns.missing')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className={`${TABLE_ROW_CLASS} align-top`}>
                  <td className="whitespace-nowrap px-3 py-2 text-neutral-600 dark:text-neutral-300">{formatDateTime(item.createdAt, i18n.language)}</td>
                  <td className="max-w-48 px-3 py-2">
                    <UserCell user={item.user} />
                  </td>
                  <td className="px-3 py-2">
                    <SpaceCell space={item.space} />
                  </td>
                  <td className="max-w-sm break-words px-3 py-2 text-neutral-900 dark:text-neutral-100">{item.question}</td>
                  <td className="px-3 py-2">
                    <ReasonBadge reason={item.reason} />
                  </td>
                  <td className="max-w-xs break-words px-3 py-2 text-neutral-600 dark:text-neutral-300">
                    {item.missing || <span className="text-neutral-400 dark:text-neutral-500">—</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <Link to={conversationHref(item.conversationId)} className="text-xs text-blue-600 underline underline-offset-2 dark:text-blue-400">
                      {t('assistantAdmin.openConversation')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination offset={filters.offset} total={data?.total ?? 0} onOffset={onOffset} />
    </>
  );
}
