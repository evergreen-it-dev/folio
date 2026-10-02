/**
 * AI assistant analytics for instance admins — /api/admin/assistant/*.
 * Cookie session + instance admin (a PAT is refused with 403 by
 * requireCookieAuth, a non-admin by requireInstanceAdmin). Read-only: the
 * dialogs of other people are opened here, so opening one is audited.
 * All filtering, counting and paging happens in SQL.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  AdminAssistantConversationDetail,
  AdminAssistantConversationRow,
  AdminAssistantConversationsResponse,
  AdminAssistantFilterOptions,
  AdminAssistantMessage,
  AdminAssistantSurveyEntry,
  AdminAssistantUnansweredItem,
  AdminAssistantUnansweredResponse,
  AdminAssistantUserRef,
  AssistantFeedbackRating,
  AssistantSurveyAnswer,
  AssistantUnansweredReason,
} from '../../shared/contracts.js';
import * as session from '../auth/session.js';
import { notFound } from '../errors.js';
import { query, queryOne } from '../db/pool.js';
import { parseBody } from '../validate.js';
import { recordAudit } from '../audit.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An ISO date (or datetime — only the day is used). Empty string = not set. */
const dayParam = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}/, 'must be an ISO date (YYYY-MM-DD)')
  .refine((v) => !Number.isNaN(Date.parse(`${v.slice(0, 10)}T00:00:00.000Z`)), 'must be a valid date')
  .optional()
  .or(z.literal('').transform(() => undefined));

const optionalText = z
  .string()
  .trim()
  .max(200)
  .optional()
  .transform((v) => v || undefined);

const filterShape = {
  space: optionalText,
  userId: z
    .string()
    .trim()
    .uuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  from: dayParam,
  to: dayParam,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

const conversationsQuerySchema = z.object(filterShape);
const unansweredQuerySchema = z.object({
  ...filterShape,
  reason: z
    .enum(['no_answer', 'low_confidence'])
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

/** `[from 00:00 UTC, to + 1 day 00:00 UTC)` as timestamps, so both ends are inclusive days. */
function dayRange(from: string | undefined, to: string | undefined): { from: string | null; toExclusive: string | null } {
  const start = from ? `${from.slice(0, 10)}T00:00:00.000Z` : null;
  let end: string | null = null;
  if (to) {
    const d = new Date(`${to.slice(0, 10)}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    end = d.toISOString();
  }
  return { from: start, toExclusive: end };
}

function userRef(row: { user_id: string; user_name: string; user_email: string }): AdminAssistantUserRef {
  return { id: row.user_id, name: row.user_name, email: row.user_email };
}

async function filterOptions(source: 'conversations' | 'unanswered'): Promise<AdminAssistantFilterOptions> {
  const spaces =
    source === 'unanswered'
      ? await query<{ space: string }>('SELECT DISTINCT space FROM ai_unanswered_questions WHERE space IS NOT NULL ORDER BY space')
      : await query<{ space: string }>('SELECT DISTINCT space FROM ai_runs WHERE space IS NOT NULL ORDER BY space');
  const table = source === 'unanswered' ? 'ai_unanswered_questions' : 'ai_conversations';
  const users = await query<{ id: string; name: string; email: string }>(
    `SELECT u.id, u.name, u.email FROM users u WHERE u.id IN (SELECT DISTINCT user_id FROM ${table}) ORDER BY lower(u.name), u.email`,
  );
  return { spaces: spaces.map((r) => r.space), users: users.map((u) => ({ id: u.id, name: u.name, email: u.email })) };
}

interface RawUnansweredRow {
  id: string;
  conversation_id: string;
  user_id: string;
  user_name: string;
  user_email: string;
  space: string | null;
  page_id: string | null;
  question: string;
  reason: AssistantUnansweredReason;
  missing: string | null;
  created_at: Date;
}

function toUnansweredItem(row: RawUnansweredRow): AdminAssistantUnansweredItem {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    user: userRef(row),
    space: row.space,
    pageId: row.page_id,
    question: row.question,
    reason: row.reason,
    missing: row.missing,
    createdAt: row.created_at.toISOString(),
  };
}

const UNANSWERED_SELECT = `
  SELECT q.id, q.conversation_id, q.user_id, u.name AS user_name, u.email AS user_email,
         q.space, q.page_id, q.question, q.reason, q.missing, q.created_at
    FROM ai_unanswered_questions q
    JOIN users u ON u.id = q.user_id`;

export function registerAssistantAdminRoutes(app: FastifyInstance): void {
  app.get('/api/admin/assistant/conversations', async (request) => {
    session.requireCookieAuth(request);
    session.requireInstanceAdmin(request);
    const q = parseBody(conversationsQuerySchema, request.query ?? {});
    const range = dayRange(q.from, q.to);
    const params = [q.space ?? null, q.userId ?? null, range.from, range.toExclusive];
    const where = `
      WHERE ($1::text IS NULL OR EXISTS (SELECT 1 FROM ai_runs r WHERE r.conversation_id = c.id AND r.space = $1::text))
        AND ($2::uuid IS NULL OR c.user_id = $2::uuid)
        AND ($3::timestamptz IS NULL OR c.updated_at >= $3::timestamptz)
        AND ($4::timestamptz IS NULL OR c.updated_at < $4::timestamptz)`;

    const [totalRow, rows, options] = await Promise.all([
      queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM ai_conversations c ${where}`, params),
      query<{
        id: string;
        user_id: string;
        user_name: string;
        user_email: string;
        space: string | null;
        first_question: string | null;
        created_at: Date;
        updated_at: Date;
        questions: string;
        likes: string;
        dislikes: string;
        solved: string;
        partly: string;
        not_solved: string;
        unanswered: string;
      }>(
        `SELECT c.id, c.user_id, u.name AS user_name, u.email AS user_email, c.created_at, c.updated_at,
                (SELECT r.space FROM ai_runs r WHERE r.conversation_id = c.id ORDER BY r.started_at ASC, r.id LIMIT 1) AS space,
                (SELECT m.content FROM ai_messages m WHERE m.conversation_id = c.id AND m.role = 'user' ORDER BY m.created_at ASC, m.id LIMIT 1) AS first_question,
                (SELECT COUNT(*) FROM ai_messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS questions,
                (SELECT COUNT(*) FROM ai_message_feedback f JOIN ai_messages m ON m.id = f.message_id WHERE m.conversation_id = c.id AND f.rating = 'up') AS likes,
                (SELECT COUNT(*) FROM ai_message_feedback f JOIN ai_messages m ON m.id = f.message_id WHERE m.conversation_id = c.id AND f.rating = 'down') AS dislikes,
                (SELECT COUNT(*) FROM ai_conversation_surveys s WHERE s.conversation_id = c.id AND s.answer = 'solved') AS solved,
                (SELECT COUNT(*) FROM ai_conversation_surveys s WHERE s.conversation_id = c.id AND s.answer = 'partly') AS partly,
                (SELECT COUNT(*) FROM ai_conversation_surveys s WHERE s.conversation_id = c.id AND s.answer = 'not_solved') AS not_solved,
                (SELECT COUNT(*) FROM ai_unanswered_questions x WHERE x.conversation_id = c.id) AS unanswered
           FROM ai_conversations c
           JOIN users u ON u.id = c.user_id
           ${where}
          ORDER BY c.updated_at DESC, c.id
          LIMIT ${q.limit} OFFSET ${q.offset}`,
        params,
      ),
      filterOptions('conversations'),
    ]);

    const items: AdminAssistantConversationRow[] = rows.map((row) => ({
      conversationId: row.id,
      user: userRef(row),
      space: row.space,
      firstQuestion: row.first_question ?? '',
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      questions: Number(row.questions),
      likes: Number(row.likes),
      dislikes: Number(row.dislikes),
      surveys: { solved: Number(row.solved), partly: Number(row.partly), notSolved: Number(row.not_solved) },
      unanswered: Number(row.unanswered),
    }));
    return { ...options, items, total: Number(totalRow?.n ?? 0) } satisfies AdminAssistantConversationsResponse;
  });

  app.get('/api/admin/assistant/conversations/:conversationId', async (request) => {
    session.requireCookieAuth(request);
    const admin = session.requireInstanceAdmin(request);
    const { conversationId } = request.params as { conversationId: string };
    if (!UUID_RE.test(conversationId)) throw notFound('assistant conversation');

    const conversation = await queryOne<{
      id: string;
      user_id: string;
      user_name: string;
      user_email: string;
      title: string | null;
      model: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT c.id, c.user_id, u.name AS user_name, u.email AS user_email, c.title, c.model, c.created_at, c.updated_at
         FROM ai_conversations c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
      [conversationId],
    );
    if (!conversation) throw notFound('assistant conversation');

    const [messageRows, surveyRows, unansweredRows] = await Promise.all([
      query<{
        id: string;
        role: 'user' | 'assistant';
        content: string;
        created_at: Date;
        rating: AssistantFeedbackRating | null;
        space: string | null;
      }>(
        `SELECT m.id, m.role, m.content, m.created_at, f.rating,
                (SELECT r.space FROM ai_runs r WHERE r.user_message_id = m.id OR r.message_id = m.id ORDER BY r.started_at ASC LIMIT 1) AS space
           FROM ai_messages m
           LEFT JOIN ai_message_feedback f ON f.message_id = m.id
          WHERE m.conversation_id = $1
          ORDER BY m.created_at ASC, m.id`,
        [conversationId],
      ),
      query<{ after_message_id: string; answer: AssistantSurveyAnswer; comment: string | null; created_at: Date }>(
        'SELECT after_message_id, answer, comment, created_at FROM ai_conversation_surveys WHERE conversation_id = $1 ORDER BY created_at ASC, id',
        [conversationId],
      ),
      query<RawUnansweredRow>(`${UNANSWERED_SELECT} WHERE q.conversation_id = $1 ORDER BY q.created_at ASC, q.id`, [conversationId]),
    ]);

    recordAudit(admin.id, 'assistant.conversation_viewed', conversationId);

    const messages: AdminAssistantMessage[] = messageRows.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.created_at.toISOString(),
      feedback: m.role === 'assistant' ? m.rating : null,
      space: m.space,
    }));
    const surveys: AdminAssistantSurveyEntry[] = surveyRows.map((s) => ({
      afterMessageId: s.after_message_id,
      answer: s.answer,
      comment: s.comment,
      createdAt: s.created_at.toISOString(),
    }));
    return {
      conversationId: conversation.id,
      user: userRef(conversation),
      title: conversation.title,
      model: conversation.model,
      createdAt: conversation.created_at.toISOString(),
      updatedAt: conversation.updated_at.toISOString(),
      messages,
      surveys,
      unanswered: unansweredRows.map(toUnansweredItem),
    } satisfies AdminAssistantConversationDetail;
  });

  app.get('/api/admin/assistant/unanswered', async (request) => {
    session.requireCookieAuth(request);
    session.requireInstanceAdmin(request);
    const q = parseBody(unansweredQuerySchema, request.query ?? {});
    const range = dayRange(q.from, q.to);
    const params = [q.space ?? null, q.userId ?? null, q.reason ?? null, range.from, range.toExclusive];
    const where = `
      WHERE ($1::text IS NULL OR q.space = $1::text)
        AND ($2::uuid IS NULL OR q.user_id = $2::uuid)
        AND ($3::text IS NULL OR q.reason = $3::text)
        AND ($4::timestamptz IS NULL OR q.created_at >= $4::timestamptz)
        AND ($5::timestamptz IS NULL OR q.created_at < $5::timestamptz)`;

    const [totalRow, rows, options] = await Promise.all([
      queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM ai_unanswered_questions q ${where}`, params),
      query<RawUnansweredRow>(`${UNANSWERED_SELECT} ${where} ORDER BY q.created_at DESC, q.id LIMIT ${q.limit} OFFSET ${q.offset}`, params),
      filterOptions('unanswered'),
    ]);
    return { ...options, items: rows.map(toUnansweredItem), total: Number(totalRow?.n ?? 0) } satisfies AdminAssistantUnansweredResponse;
  });
}
