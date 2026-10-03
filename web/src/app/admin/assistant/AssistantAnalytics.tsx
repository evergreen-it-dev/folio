import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { ApiError } from '../../api';
import { useDocumentTitle } from '../../hooks';
import { Tabs } from '../../ui/Tabs';
import { ConversationsTab } from './ConversationsTab';
import { ConversationView } from './ConversationView';
import { UnansweredTab } from './UnansweredTab';
import { useAssistantAccess } from './useAssistantAccess';
import { EMPTY_FILTERS, type AnalyticsFilters } from './logic';
import '../../i18n/register';

type TabKey = 'conversations' | 'unanswered';
const TAB_KEYS: TabKey[] = ['conversations', 'unanswered'];

/**
 * `/admin/assistant` — analytics of the AI assistant: every conversation with
 * the signals gathered on it (👍/👎, the periodic survey, questions the
 * assistant reported it could not answer) and a list of those unanswered
 * questions. For an instance admin it covers everything; for a space admin only
 * the spaces they administer (a note under the title says so). Guarded by the
 * access query (GET /api/admin/assistant/access: 403 → "no access"); the server
 * enforces the same restriction on every endpoint. The tab and the open dialog live in
 * the URL (`?tab=`, `?conversation=`); each list's filters live here, above the
 * tabs, so they survive switching tabs and opening a dialog.
 */
export function AssistantAnalytics() {
  const { t } = useTranslation('app');
  const access = useAssistantAccess();
  useDocumentTitle(t('assistantAdmin.title'));

  if (access.isPending) {
    return <div className="flex h-full items-center justify-center p-8 text-sm text-neutral-400">{t('ui.loading')}</div>;
  }
  if (access.isError && !(access.error instanceof ApiError && access.error.status === 403)) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-red-600 dark:text-red-400">{t('assistantAdmin.loadFailed')}</div>
    );
  }
  if (access.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('admin.noAccess')}</p>
        <Link to="/" className="text-sm text-blue-600 underline underline-offset-2 dark:text-blue-400">
          {t('admin.backHome')}
        </Link>
      </div>
    );
  }

  return <AssistantAnalyticsContent spaces={access.data.scope === 'spaces' ? (access.data.spaceRefs?.map((ref) => ref.name) ?? access.data.spaces) : null} />;
}

/** `spaces` = the names (slugs from an older server) of the spaces a space admin is limited to; null for an instance admin. */
function AssistantAnalyticsContent({ spaces }: { spaces: string[] | null }) {
  const { t } = useTranslation('app');
  const [searchParams, setSearchParams] = useSearchParams();
  const [conversationFilters, setConversationFilters] = useState<AnalyticsFilters>(EMPTY_FILTERS);
  const [unansweredFilters, setUnansweredFilters] = useState<AnalyticsFilters>(EMPTY_FILTERS);

  const rawTab = searchParams.get('tab');
  const tab: TabKey = TAB_KEYS.includes(rawTab as TabKey) ? (rawTab as TabKey) : 'conversations';
  const conversationId = searchParams.get('conversation');

  function selectTab(key: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', key);
      next.delete('conversation');
      return next;
    });
  }

  // A filter change goes back to the first page; a page change keeps the filters.
  const changeFilters = (set: (update: (prev: AnalyticsFilters) => AnalyticsFilters) => void) => (patch: Partial<AnalyticsFilters>) =>
    set((prev) => ({ ...prev, ...patch, offset: 0 }));
  const changeOffset = (set: (update: (prev: AnalyticsFilters) => AnalyticsFilters) => void) => (offset: number) =>
    set((prev) => ({ ...prev, offset }));

  return (
    <div className="h-full overflow-y-auto bg-white dark:bg-neutral-950">
      <header className="flex h-14 items-center gap-2 border-b border-neutral-200 px-3 dark:border-neutral-800 md:gap-3 md:px-4">
        <Link
          to="/"
          aria-label={t('ui.back')}
          className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 max-md:min-h-10 max-md:min-w-10 dark:hover:bg-neutral-800"
        >
          <ArrowLeft size={17} />
        </Link>
        <h1 className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t('assistantAdmin.title')}</h1>
      </header>

      <main className="mx-auto max-w-6xl p-4 md:p-6">
        {spaces && (
          <p className="mb-4 text-xs text-neutral-500 dark:text-neutral-400">{t('assistantAdmin.scopeNote', { spaces: spaces.join(', ') })}</p>
        )}
        {conversationId ? (
          <ConversationView conversationId={conversationId} />
        ) : (
          <>
            <Tabs
              className="mb-4"
              active={tab}
              onSelect={selectTab}
              items={[
                { key: 'conversations', label: t('assistantAdmin.tabs.conversations') },
                { key: 'unanswered', label: t('assistantAdmin.tabs.unanswered') },
              ]}
            />
            {tab === 'conversations' ? (
              <ConversationsTab filters={conversationFilters} onChange={changeFilters(setConversationFilters)} onOffset={changeOffset(setConversationFilters)} />
            ) : (
              <UnansweredTab filters={unansweredFilters} onChange={changeFilters(setUnansweredFilters)} onOffset={changeOffset(setUnansweredFilters)} />
            )}
          </>
        )}
      </main>
    </div>
  );
}
