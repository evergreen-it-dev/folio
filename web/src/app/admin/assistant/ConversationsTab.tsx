import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import type { AdminAssistantConversationRow } from '@shared/contracts';
import { api } from '../../api';
import { formatDateTime } from '../../formatDate';
import { FilterBar, Pagination, SpaceCell, TABLE_HEAD_CLASS, TABLE_ROW_CLASS, UserCell } from './AnalyticsParts';
import { PAGE_SIZE, conversationHref, type AnalyticsFilters } from './logic';
import '../../i18n/register';

function SurveySummary({ surveys }: { surveys: AdminAssistantConversationRow['surveys'] }) {
  const { t } = useTranslation('app');
  const chips = [
    { key: 'solved', count: surveys.solved, tone: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300' },
    { key: 'partly', count: surveys.partly, tone: 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300' },
    { key: 'notSolved', count: surveys.notSolved, tone: 'bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300' },
  ].filter((chip) => chip.count > 0);
  if (chips.length === 0) return <span className="text-neutral-400 dark:text-neutral-500">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((chip) => (
        <span key={chip.key} className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs ${chip.tone}`}>
          {t(`assistantAdmin.surveyShort.${chip.key}`)} {chip.count}
        </span>
      ))}
    </div>
  );
}

export interface ConversationsTabProps {
  filters: AnalyticsFilters;
  onChange: (patch: Partial<AnalyticsFilters>) => void;
  onOffset: (offset: number) => void;
}

/** The "Conversations" list: one row per dialog with the signals gathered on it. */
export function ConversationsTab({ filters, onChange, onOffset }: ConversationsTabProps) {
  const { t, i18n } = useTranslation('app');
  const navigate = useNavigate();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['assistant-admin', 'conversations', filters],
    queryFn: () =>
      api.listAdminAssistantConversations({
        space: filters.space || undefined,
        userId: filters.userId || undefined,
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
      <FilterBar filters={filters} onChange={onChange} options={data} />

      {isLoading && <p className="text-sm text-neutral-400">{t('ui.loading')}</p>}
      {isError && <p className="text-sm text-red-600 dark:text-red-400">{t('assistantAdmin.loadFailed')}</p>}
      {!isLoading && !isError && items.length === 0 && <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('assistantAdmin.empty')}</p>}

      {items.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[960px] text-sm">
            <thead>
              <tr className={TABLE_HEAD_CLASS}>
                <th className="px-3 py-2 font-medium">{t('assistantAdmin.columns.date')}</th>
                <th className="px-3 py-2 font-medium">{t('assistantAdmin.columns.user')}</th>
                <th className="px-3 py-2 font-medium">{t('assistantAdmin.columns.space')}</th>
                <th className="px-3 py-2 font-medium">{t('assistantAdmin.columns.firstQuestion')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('assistantAdmin.columns.questions')}</th>
                <th className="px-3 py-2 font-medium">{t('assistantAdmin.columns.ratings')}</th>
                <th className="px-3 py-2 font-medium">{t('assistantAdmin.columns.survey')}</th>
                <th className="px-3 py-2 font-medium">{t('assistantAdmin.columns.unanswered')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr
                  key={row.conversationId}
                  onClick={() => navigate(conversationHref(row.conversationId))}
                  className={`${TABLE_ROW_CLASS} cursor-pointer align-top hover:bg-neutral-50 dark:hover:bg-neutral-900`}
                >
                  <td className="whitespace-nowrap px-3 py-2 text-neutral-600 dark:text-neutral-300">{formatDateTime(row.updatedAt, i18n.language)}</td>
                  <td className="max-w-48 px-3 py-2">
                    <UserCell user={row.user} />
                  </td>
                  <td className="px-3 py-2">
                    <SpaceCell space={row.space} />
                  </td>
                  <td className="max-w-md px-3 py-2">
                    <Link
                      to={conversationHref(row.conversationId)}
                      onClick={(e) => e.stopPropagation()}
                      title={row.firstQuestion}
                      className="line-clamp-2 break-words text-neutral-900 hover:underline dark:text-neutral-100"
                    >
                      {row.firstQuestion}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-neutral-600 dark:text-neutral-300">{row.questions}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-neutral-600 dark:text-neutral-300">
                    <span className="inline-flex items-center gap-3 tabular-nums">
                      <span className="inline-flex items-center gap-1" title={t('assistantAdmin.likes')}>
                        <ThumbsUp size={12} aria-hidden="true" />
                        <span aria-label={t('assistantAdmin.likes')}>{row.likes}</span>
                      </span>
                      <span className="inline-flex items-center gap-1" title={t('assistantAdmin.dislikes')}>
                        <ThumbsDown size={12} aria-hidden="true" />
                        <span aria-label={t('assistantAdmin.dislikes')}>{row.dislikes}</span>
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <SurveySummary surveys={row.surveys} />
                  </td>
                  <td className="px-3 py-2">
                    {row.unanswered > 0 ? (
                      <span className="inline-block rounded bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-700 tabular-nums dark:bg-red-950/60 dark:text-red-300">
                        {row.unanswered}
                      </span>
                    ) : (
                      <span className="text-neutral-400 dark:text-neutral-500">—</span>
                    )}
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
