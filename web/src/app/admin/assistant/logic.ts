import type { AdminAssistantMessage, AdminAssistantSurveyEntry, AdminAssistantUnansweredItem } from '@shared/contracts';

/** The filter state of one analytics list (every value is a raw input value; '' = not set). */
export interface AnalyticsFilters {
  space: string;
  userId: string;
  reason: string;
  from: string;
  to: string;
  offset: number;
}

export const EMPTY_FILTERS: AnalyticsFilters = { space: '', userId: '', reason: '', from: '', to: '', offset: 0 };

export const PAGE_SIZE = 50;

/** The analytics page opened on one dialog. */
export function conversationHref(conversationId: string): string {
  return `/admin/assistant?tab=conversations&conversation=${encodeURIComponent(conversationId)}`;
}

export interface DialogAnnotations {
  /** Survey answers keyed by the assistant message they were given after. */
  surveysAfter: Map<string, AdminAssistantSurveyEntry[]>;
  /** Unanswered-question reports keyed by the assistant message that closed the run they were raised in. */
  unansweredAfter: Map<string, AdminAssistantUnansweredItem[]>;
  /** Things that could not be tied to a message (a survey for a deleted message, a report of a run that never saved an answer). */
  trailingSurveys: AdminAssistantSurveyEntry[];
  trailingUnanswered: AdminAssistantUnansweredItem[];
}

/**
 * Ties the survey answers and unanswered-question reports to the dialog.
 * A survey names its message (`afterMessageId`). A report has only a timestamp,
 * raised by the assistant while it was working on a run, so it belongs to the
 * first assistant message saved at or after that moment — the answer of that run.
 */
export function annotateDialog(
  messages: AdminAssistantMessage[],
  surveys: AdminAssistantSurveyEntry[],
  unanswered: AdminAssistantUnansweredItem[],
): DialogAnnotations {
  const messageIds = new Set(messages.map((m) => m.id));
  const assistantMessages = messages.filter((m) => m.role === 'assistant').map((m) => ({ id: m.id, at: Date.parse(m.createdAt) }));

  const surveysAfter = new Map<string, AdminAssistantSurveyEntry[]>();
  const trailingSurveys: AdminAssistantSurveyEntry[] = [];
  for (const entry of surveys) {
    if (!messageIds.has(entry.afterMessageId)) {
      trailingSurveys.push(entry);
      continue;
    }
    surveysAfter.set(entry.afterMessageId, [...(surveysAfter.get(entry.afterMessageId) ?? []), entry]);
  }

  const unansweredAfter = new Map<string, AdminAssistantUnansweredItem[]>();
  const trailingUnanswered: AdminAssistantUnansweredItem[] = [];
  for (const item of [...unanswered].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
    const at = Date.parse(item.createdAt);
    const target = assistantMessages.find((m) => m.at >= at);
    if (!target) {
      trailingUnanswered.push(item);
      continue;
    }
    unansweredAfter.set(target.id, [...(unansweredAfter.get(target.id) ?? []), item]);
  }

  return { surveysAfter, unansweredAfter, trailingSurveys, trailingUnanswered };
}
