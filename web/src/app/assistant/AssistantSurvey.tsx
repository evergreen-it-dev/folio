import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { AssistantSurveyAnswer } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { useToast } from '../ui/Toast';
import '../i18n/register';

/** How long the "Thanks!" line stays before the card goes away. */
export const SURVEY_THANKS_MS = 2500;

type Phase = 'ask' | 'comment' | 'thanks';

export interface AssistantSurveyCardProps {
  conversationId: string;
  /** The assistant message the survey is asked after (`AssistantConversation.surveyDue.afterMessageId`). */
  afterMessageId: string;
  /** The first answer is saved: the panel keeps the card on screen even though the server no longer reports the survey as due. */
  onEngaged: () => void;
  /** The card is done (thanks shown, or the survey was dismissed): remove it. */
  onFinished: () => void;
}

const ANSWER_BUTTONS: Array<{ answer: Exclude<AssistantSurveyAnswer, 'skipped'>; labelKey: string }> = [
  { answer: 'solved', labelKey: 'solved' },
  { answer: 'partly', labelKey: 'partly' },
  { answer: 'not_solved', labelKey: 'notSolved' },
];

/**
 * The periodic "Did the assistant solve your question?" card shown after the
 * last answer. The answer is sent at once; "Partly"/"No" then offer an optional
 * one-line comment that goes in a second POST with the same `afterMessageId`
 * (the server upserts on that key, so the comment lands on the same row).
 */
export function AssistantSurveyCard({ conversationId, afterMessageId, onEngaged, onFinished }: AssistantSurveyCardProps) {
  const { t } = useTranslation('app');
  const showToast = useToast();
  const errorText = useApiErrorText();
  const [phase, setPhase] = useState<Phase>('ask');
  const [answer, setAnswer] = useState<AssistantSurveyAnswer | null>(null);
  const [comment, setComment] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (phase !== 'thanks') return;
    const timer = setTimeout(onFinished, SURVEY_THANKS_MS);
    return () => clearTimeout(timer);
    // onFinished is a fresh closure on every panel render; the timer must not restart with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  async function send(nextAnswer: AssistantSurveyAnswer, text: string | null): Promise<boolean> {
    setPending(true);
    try {
      await api.submitAssistantSurvey(conversationId, { afterMessageId, answer: nextAnswer, comment: text });
      return true;
    } catch (error) {
      showToast(errorText(error, 'assistant.chat.survey.failed'));
      return false;
    } finally {
      setPending(false);
    }
  }

  async function choose(next: AssistantSurveyAnswer) {
    if (pending) return;
    if (!(await send(next, null))) return;
    setAnswer(next);
    onEngaged();
    if (next === 'skipped') onFinished();
    else setPhase(next === 'solved' ? 'thanks' : 'comment');
  }

  async function sendComment() {
    const text = comment.trim();
    if (pending || !answer || !text) return;
    if (await send(answer, text)) setPhase('thanks');
  }

  return (
    <div
      role="group"
      aria-label={t('assistant.chat.survey.question')}
      className="mr-auto w-full max-w-[88%] rounded-xl border border-dashed border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
    >
      {phase === 'thanks' ? (
        <p role="status" className="text-xs text-neutral-500 dark:text-neutral-400">
          {t('assistant.chat.survey.thanks')}
        </p>
      ) : phase === 'comment' ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void sendComment();
          }}
        >
          <input
            type="text"
            value={comment}
            maxLength={2000}
            autoFocus
            onChange={(event) => setComment(event.target.value)}
            placeholder={t('assistant.chat.survey.commentPlaceholder')}
            aria-label={t('assistant.chat.survey.commentPlaceholder')}
            className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          />
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              disabled={pending}
              onClick={() => setPhase('thanks')}
              className="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              {t('assistant.chat.survey.skipComment')}
            </button>
            <button
              type="submit"
              disabled={pending || !comment.trim()}
              className="rounded-md bg-neutral-900 px-2.5 py-1 text-xs text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
            >
              {t('assistant.chat.survey.send')}
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-neutral-700 dark:text-neutral-200">{t('assistant.chat.survey.question')}</p>
            <button
              type="button"
              disabled={pending}
              onClick={() => void choose('skipped')}
              aria-label={t('assistant.chat.survey.skip')}
              title={t('assistant.chat.survey.skip')}
              className="-mr-1 -mt-0.5 shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-50 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
            >
              <X size={13} />
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {ANSWER_BUTTONS.map(({ answer: value, labelKey }) => (
              <button
                key={value}
                type="button"
                disabled={pending}
                onClick={() => void choose(value)}
                className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                {t(`assistant.chat.survey.${labelKey}`)}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
