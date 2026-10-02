import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ArrowLeft, ThumbsDown, ThumbsUp } from 'lucide-react';
import type { AdminAssistantMessage, AdminAssistantSurveyEntry, AdminAssistantUnansweredItem } from '@shared/contracts';
import { ApiError, api } from '../../api';
import { formatDateTime } from '../../formatDate';
import { AssistantMessageContent } from '../../assistant/AssistantMessageContent';
import { ReasonBadge } from './AnalyticsParts';
import { annotateDialog } from './logic';
import '../../i18n/register';

function SurveyNote({ entry }: { entry: AdminAssistantSurveyEntry }) {
  const { t, i18n } = useTranslation('app');
  const tone =
    entry.answer === 'solved'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200'
      : entry.answer === 'skipped'
        ? 'border-neutral-200 bg-neutral-50 text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300'
        : entry.answer === 'partly'
          ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200'
          : 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200';
  return (
    <div className={`mx-auto w-full max-w-[88%] rounded-lg border px-3 py-1.5 text-xs ${tone}`}>
      <span className="font-medium">{t('assistantAdmin.conversation.survey', { answer: t(`assistantAdmin.surveyAnswers.${entry.answer}`) })}</span>
      <span className="ml-2 opacity-70">{formatDateTime(entry.createdAt, i18n.language)}</span>
      {entry.comment && <p className="mt-0.5 whitespace-pre-wrap break-words">{entry.comment}</p>}
    </div>
  );
}

function UnansweredNote({ item }: { item: AdminAssistantUnansweredItem }) {
  const { t } = useTranslation('app');
  return (
    <div className="mx-auto w-full max-w-[88%] rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100">
      <div className="flex flex-wrap items-center gap-2">
        <AlertCircle size={13} className="shrink-0" aria-hidden="true" />
        <span className="font-medium">{t('assistantAdmin.conversation.unanswered')}</span>
        <ReasonBadge reason={item.reason} />
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words">{item.question}</p>
      {item.missing && (
        <p className="mt-1 whitespace-pre-wrap break-words opacity-80">
          <span className="font-medium">{t('assistantAdmin.conversation.missing')}:</span> {item.missing}
        </p>
      )}
    </div>
  );
}

function Bubble({ message }: { message: AdminAssistantMessage }) {
  const { t, i18n } = useTranslation('app');
  const isUser = message.role === 'user';
  return (
    <div className={`flex max-w-[88%] flex-col gap-0.5 ${isUser ? 'ml-auto items-end' : 'mr-auto items-start'}`}>
      <div
        className={`rounded-xl px-3 py-2 text-sm ${
          isUser
            ? 'whitespace-pre-wrap break-words bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
            : 'border border-neutral-200 bg-neutral-50 text-neutral-800 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-100'
        }`}
      >
        {isUser ? message.content : <AssistantMessageContent text={message.content} />}
      </div>
      <div className="flex items-center gap-2 text-[11px] text-neutral-400 dark:text-neutral-500">
        <span>{formatDateTime(message.createdAt, i18n.language)}</span>
        {message.space && <code>{message.space}</code>}
        {!isUser && message.feedback === 'up' && (
          <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
            <ThumbsUp size={12} className="fill-current" aria-hidden="true" />
            {t('assistantAdmin.conversation.ratedUp')}
          </span>
        )}
        {!isUser && message.feedback === 'down' && (
          <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
            <ThumbsDown size={12} className="fill-current" aria-hidden="true" />
            {t('assistantAdmin.conversation.ratedDown')}
          </span>
        )}
      </div>
    </div>
  );
}

/** One dialog, read-only: the messages as in the chat, with ratings, survey answers and unanswered reports placed where they happened. */
export function ConversationView({ conversationId }: { conversationId: string }) {
  const { t, i18n } = useTranslation('app');
  const navigate = useNavigate();
  const location = useLocation();
  const { data, isLoading, error } = useQuery({
    queryKey: ['assistant-admin', 'conversation', conversationId],
    queryFn: () => api.getAdminAssistantConversation(conversationId),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });
  const notFound = error instanceof ApiError && error.status === 404;

  const annotations = useMemo(
    () => (data ? annotateDialog(data.messages, data.surveys, data.unanswered) : null),
    [data],
  );
  const spaces = useMemo(() => [...new Set((data?.messages ?? []).map((m) => m.space).filter((s): s is string => Boolean(s)))], [data]);

  return (
    <>
      <div className="mb-4 flex items-center gap-2">
        {/* Back to wherever the admin came from (the list or the unanswered tab); a deep link has no history to return to. */}
        <Link
          to="/admin/assistant?tab=conversations"
          onClick={(event) => {
            if (location.key !== 'default') {
              event.preventDefault();
              navigate(-1);
            }
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <ArrowLeft size={13} /> {t('assistantAdmin.conversation.back')}
        </Link>
      </div>

      {isLoading && <p className="text-sm text-neutral-400">{t('ui.loading')}</p>}
      {notFound && <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('assistantAdmin.conversation.notFound')}</p>}
      {error && !notFound && <p className="text-sm text-red-600 dark:text-red-400">{t('assistantAdmin.loadFailed')}</p>}

      {data && annotations && (
        <>
          <dl className="mb-5 grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg border border-neutral-200 p-3 text-sm sm:grid-cols-2 dark:border-neutral-800">
            <div>
              <dt className="text-xs text-neutral-500 dark:text-neutral-400">{t('assistantAdmin.columns.user')}</dt>
              <dd className="text-neutral-900 dark:text-neutral-100">
                {data.user.name} <span className="text-neutral-500 dark:text-neutral-400">({data.user.email})</span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500 dark:text-neutral-400">{t('assistantAdmin.columns.space')}</dt>
              <dd className="text-neutral-900 dark:text-neutral-100">{spaces.length > 0 ? spaces.join(', ') : '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500 dark:text-neutral-400">{t('assistantAdmin.conversation.started')}</dt>
              <dd className="text-neutral-900 dark:text-neutral-100">{formatDateTime(data.createdAt, i18n.language)}</dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500 dark:text-neutral-400">{t('assistantAdmin.conversation.updated')}</dt>
              <dd className="text-neutral-900 dark:text-neutral-100">{formatDateTime(data.updatedAt, i18n.language)}</dd>
            </div>
            {data.title && (
              <div className="sm:col-span-2">
                <dt className="text-xs text-neutral-500 dark:text-neutral-400">{t('assistantAdmin.conversation.title')}</dt>
                <dd className="break-words text-neutral-900 dark:text-neutral-100">{data.title}</dd>
              </div>
            )}
          </dl>

          <div className="flex flex-col gap-2.5">
            {data.messages.map((message) => (
              <div key={message.id} className="flex flex-col gap-2">
                <Bubble message={message} />
                {annotations.unansweredAfter.get(message.id)?.map((item) => <UnansweredNote key={item.id} item={item} />)}
                {annotations.surveysAfter.get(message.id)?.map((entry) => <SurveyNote key={`${entry.afterMessageId}-${entry.createdAt}`} entry={entry} />)}
              </div>
            ))}
            {annotations.trailingUnanswered.map((item) => (
              <UnansweredNote key={item.id} item={item} />
            ))}
            {annotations.trailingSurveys.map((entry) => (
              <SurveyNote key={`${entry.afterMessageId}-${entry.createdAt}`} entry={entry} />
            ))}
          </div>
        </>
      )}
    </>
  );
}
