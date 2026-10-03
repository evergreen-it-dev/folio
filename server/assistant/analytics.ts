/**
 * AI assistant analytics — DB access for db/migrations/032_assistant_feedback.sql:
 * the owner's 👍/👎 on assistant answers, the periodic "did it solve your
 * question?" survey, and the questions the assistant reported as unanswered.
 * User-facing reads/writes live here; the admin read side is adminRoutes.ts.
 */
import { randomUUID } from 'node:crypto';
import {
  ASSISTANT_SURVEY_EVERY,
  type AssistantFeedbackRating,
  type AssistantSurveyAnswer,
  type AssistantSurveyDue,
  type AssistantUnansweredReason,
} from '../../shared/contracts.js';
import { query, queryOne } from '../db/pool.js';

/** The assistant message `messageId` if it exists, is an assistant message and belongs to a conversation of `userId`. */
export async function findOwnedAssistantMessage(messageId: string, userId: string): Promise<{ id: string; conversationId: string } | null> {
  const row = await queryOne<{ id: string; conversation_id: string }>(
    `SELECT m.id, m.conversation_id FROM ai_messages m
       JOIN ai_conversations c ON c.id = m.conversation_id
      WHERE m.id = $1 AND m.role = 'assistant' AND c.user_id = $2`,
    [messageId, userId],
  );
  return row ? { id: row.id, conversationId: row.conversation_id } : null;
}

/** Upserts the rating; `null` removes it. */
export async function setFeedback(messageId: string, userId: string, rating: AssistantFeedbackRating | null): Promise<void> {
  if (rating === null) {
    await query('DELETE FROM ai_message_feedback WHERE message_id = $1 AND user_id = $2', [messageId, userId]);
    return;
  }
  await query(
    `INSERT INTO ai_message_feedback (message_id, user_id, rating) VALUES ($1, $2, $3)
     ON CONFLICT (message_id) DO UPDATE SET rating = EXCLUDED.rating, user_id = EXCLUDED.user_id, updated_at = now()`,
    [messageId, userId, rating],
  );
}

/** The owner's ratings for the given messages, by message id. */
export async function listFeedback(messageIds: string[], userId: string): Promise<Map<string, AssistantFeedbackRating>> {
  const out = new Map<string, AssistantFeedbackRating>();
  if (messageIds.length === 0) return out;
  const rows = await query<{ message_id: string; rating: AssistantFeedbackRating }>(
    'SELECT message_id, rating FROM ai_message_feedback WHERE message_id = ANY($1::uuid[]) AND user_id = $2',
    [messageIds, userId],
  );
  for (const row of rows) out.set(row.message_id, row.rating);
  return out;
}

export async function isAssistantMessageOf(messageId: string, conversationId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM ai_messages WHERE id = $1 AND conversation_id = $2 AND role = 'assistant'`,
    [messageId, conversationId],
  );
  return Boolean(row);
}

/** One survey per (conversation, afterMessageId): answering again replaces the earlier answer. */
export async function upsertSurvey(input: {
  conversationId: string;
  userId: string;
  afterMessageId: string;
  answer: AssistantSurveyAnswer;
  comment: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO ai_conversation_surveys (id, conversation_id, user_id, after_message_id, answer, comment)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (conversation_id, after_message_id)
     DO UPDATE SET answer = EXCLUDED.answer, comment = EXCLUDED.comment, user_id = EXCLUDED.user_id`,
    [randomUUID(), input.conversationId, input.userId, input.afterMessageId, input.answer, input.comment],
  );
}

/**
 * The survey is due when at least ASSISTANT_SURVEY_EVERY assistant answers
 * came after the latest survey's message (the furthest one in the conversation) (answered or skipped), or after
 * the start of the conversation when there is none. Counted in SQL over ALL
 * the conversation's assistant messages, not just the page the chat returns.
 */
export async function computeSurveyDue(conversationId: string): Promise<AssistantSurveyDue | null> {
  const row = await queryOne<{ total: string; since_survey: string; last_id: string | null }>(
    `WITH answers AS (
       SELECT id, created_at, ROW_NUMBER() OVER (ORDER BY created_at, id) AS pos
         FROM ai_messages WHERE conversation_id = $1 AND role = 'assistant'
     ),
     last_survey AS (
       SELECT MAX(a.pos) AS pos FROM ai_conversation_surveys s
         JOIN answers a ON a.id = s.after_message_id
        WHERE s.conversation_id = $1
     )
     SELECT (SELECT COUNT(*) FROM answers) AS total,
            (SELECT COUNT(*) FROM answers) - COALESCE((SELECT pos FROM last_survey), 0) AS since_survey,
            (SELECT id FROM answers ORDER BY pos DESC LIMIT 1) AS last_id`,
    [conversationId],
  );
  if (!row || !row.last_id) return null;
  return Number(row.since_survey) >= ASSISTANT_SURVEY_EVERY ? { afterMessageId: row.last_id } : null;
}

export const MAX_UNANSWERED_REPORTS_PER_RUN = 3;

/** Inserts a report unless the run already has MAX_UNANSWERED_REPORTS_PER_RUN (checked in the same statement). Returns false when the cap was hit. */
export async function insertUnanswered(input: {
  conversationId: string;
  runId: string;
  userId: string;
  space: string | null;
  pageId: string | null;
  question: string;
  reason: AssistantUnansweredReason;
  missing: string | null;
}): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `INSERT INTO ai_unanswered_questions (id, conversation_id, run_id, user_id, space, page_id, question, reason, missing)
     SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text, $7::text, $8::text, $9::text
      WHERE (SELECT COUNT(*) FROM ai_unanswered_questions WHERE run_id = $3::uuid) < $10::int
     RETURNING id`,
    [randomUUID(), input.conversationId, input.runId, input.userId, input.space, input.pageId, input.question, input.reason, input.missing, MAX_UNANSWERED_REPORTS_PER_RUN],
  );
  return rows.length > 0;
}
