import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import type { AssistantConversation, AssistantFeedbackRating } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { useToast } from '../ui/Toast';
import '../i18n/register';

export interface AssistantFeedbackVars {
  messageId: string;
  /** The rating to store; `null` removes it. */
  rating: AssistantFeedbackRating | null;
  /** What it was before the click — restored if the request fails. */
  previous: AssistantFeedbackRating | null;
}

/** Rewrites one message's rating in every cached conversation (`['assistant', 'chat', …]`). */
function patchRating(
  data: AssistantConversation | undefined,
  messageId: string,
  rating: AssistantFeedbackRating | null,
): AssistantConversation | undefined {
  if (!data || !data.messages.some((m) => m.id === messageId)) return data;
  return { ...data, messages: data.messages.map((m) => (m.id === messageId ? { ...m, feedback: rating } : m)) };
}

/**
 * Optimistic 👍/👎 mutation: the chat cache is patched at once, rolled back with
 * a toast when the request fails, and refetched when it settles so the cache
 * ends up with the server's own state. `applyLocal` mirrors the same change onto
 * messages the panel holds outside the cache (a just-finished run's answer is
 * shown from local state until the invalidated query lands).
 */
export function useAssistantFeedback(applyLocal: (messageId: string, rating: AssistantFeedbackRating | null) => void) {
  const queryClient = useQueryClient();
  const showToast = useToast();
  const errorText = useApiErrorText();

  function apply(messageId: string, rating: AssistantFeedbackRating | null) {
    queryClient.setQueriesData<AssistantConversation>({ queryKey: ['assistant', 'chat'] }, (data) => patchRating(data, messageId, rating));
    applyLocal(messageId, rating);
  }

  return useMutation({
    mutationFn: ({ messageId, rating }: AssistantFeedbackVars) => api.setAssistantFeedback(messageId, rating),
    onMutate: ({ messageId, rating }) => apply(messageId, rating),
    onError: (error, { messageId, previous }) => {
      apply(messageId, previous);
      showToast(errorText(error, 'assistant.chat.feedback.failed'));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['assistant', 'chat'] });
    },
  });
}

export interface AssistantFeedbackButtonsProps {
  rating: AssistantFeedbackRating | null;
  /** Called with the new rating: the clicked one, or `null` when the active one was clicked again. */
  onRate: (rating: AssistantFeedbackRating | null) => void;
  /** Keep the row visible without hover (the latest answer). A rated message keeps it visible too. */
  alwaysVisible?: boolean;
}

/**
 * 👍/👎 under a saved assistant answer. Muted; on a pointer device it appears on
 * hover/focus of the bubble, on touch screens it is always there.
 */
export function AssistantFeedbackButtons({ rating, onRate, alwaysVisible }: AssistantFeedbackButtonsProps) {
  const { t } = useTranslation('app');
  const visible = alwaysVisible || rating !== null;

  function button(kind: AssistantFeedbackRating) {
    const active = rating === kind;
    const label = t(`assistant.chat.feedback.${kind}`);
    const Icon = kind === 'up' ? ThumbsUp : ThumbsDown;
    return (
      <button
        type="button"
        aria-pressed={active}
        aria-label={label}
        title={label}
        onClick={() => onRate(active ? null : kind)}
        className={`rounded p-1 transition-colors max-md:p-1.5 ${
          active
            ? 'bg-neutral-200 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100'
            : 'text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300'
        }`}
      >
        <Icon size={13} className={active ? 'fill-current' : ''} aria-hidden="true" />
      </button>
    );
  }

  return (
    <div
      role="group"
      aria-label={t('assistant.chat.feedback.group')}
      className={`flex items-center gap-0.5 transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100 [@media(hover:none)]:opacity-100 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {button('up')}
      {button('down')}
    </div>
  );
}
