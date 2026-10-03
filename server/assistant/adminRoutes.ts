/**
 * AI assistant analytics for instance admins and space admins — /api/admin/assistant/*.
 * Cookie session only (a PAT is refused with 403 by requireCookieAuth). An
 * instance admin sees everything; a space admin (explicit membership role
 * `admin`) sees only what happened in the spaces they administer; anyone else
 * gets 403 (see resolveAnalyticsScope). Read-only: the dialogs of other people
 * are opened here, so opening one is audited.
 * All filtering, counting, paging AND the visibility rules happen in SQL — a
 * space admin's queries never select a row (or a message body) outside their
 * spaces, nothing is fetched and filtered in JS.
 *
 * Visibility for a space admin (SQL predicate `visibleMessage`): a run is
 * visible when `ai_runs.space` is one of their spaces; a message is visible when
 * it is the user message or the answer of a visible run (and belongs to the
 * run's own conversation). Messages of other spaces and pre-migration messages
 * without a run/space are hidden. A conversation is listed when it has at least
 * one visible run. Everything computed for a row (space, first question,
 * counters, createdAt/updatedAt) is over the visible part only.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  AdminAssistantAccess,
  AdminAssistantConversationDetail,
  AdminAssistantConversationRow,
  AdminAssistantConversationViews,
  AdminAssistantConversationsResponse,
  AdminAssistantFilterOptions,
  AdminAssistantMessage,
  AdminAssistantSpaceRef,
  AdminAssistantSurveyEntry,
  AdminAssistantUnansweredItem,
  AdminAssistantUnansweredResponse,
  AdminAssistantUserRef,
  AssistantFeedbackRating,
  AssistantSurveyAnswer,
  AssistantUnansweredReason,
  User,
} from '../../shared/contracts.js';
import * as session from '../auth/session.js';
import * as authStore from '../auth/store.js';
import { forbidden, notFound } from '../errors.js';
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

/** Current names of the given space slugs; a slug without a row (the space was deleted) is absent from the map. */
async function loadSpaceNames(slugs: Iterable<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set([...slugs].filter((s): s is string => Boolean(s)))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const rows = await query<{ slug: string; name: string }>('SELECT slug, name FROM spaces WHERE slug = ANY($1::text[])', [unique]);
  for (const row of rows) out.set(row.slug, row.name);
  return out;
}

function userRef(row: { user_id: string; user_name: string; user_email: string }): AdminAssistantUserRef {
  return { id: row.user_id, name: row.user_name, email: row.user_email };
}

/**
 * Who the caller is for the analytics: an instance admin (everything), a space admin of
 * the listed spaces (only those), or 403. Cookie auth only (a PAT → 403, as before). A
 * disabled user never reaches here (requireSession rejects them) but is refused anyway.
 * Space admin = explicit membership role `admin` in an existing space — an instance admin's
 * own memberships do not matter (they are `instance` scope).
 */
export async function resolveAnalyticsScope(request: FastifyRequest): Promise<{ user: User } & AdminAssistantAccess> {
  session.requireCookieAuth(request);
  const user = request.authUser!;
  if (user.disabled) throw forbidden('requires instance or space admin');
  if (user.isAdmin) return { user, scope: 'instance', spaces: [] };
  const spaces = await authStore.listAdminSpaceSlugs(user.id);
  if (spaces.length === 0) throw forbidden('requires instance or space admin');
  return { user, scope: 'spaces', spaces };
}

/**
 * SQL: is message `m` (an `ai_messages` alias, `$n` = the admin's space slugs as text[]) visible
 * to a space admin — the user message or the answer of a run started in one of their spaces.
 */
function visibleMessage(m: string, spacesParam: string): string {
  return `EXISTS (SELECT 1 FROM ai_runs vr
                   WHERE vr.conversation_id = ${m}.conversation_id
                     AND vr.space = ANY(${spacesParam}::text[])
                     AND (vr.user_message_id = ${m}.id OR vr.message_id = ${m}.id))`;
}

/** A space filter outside the admin's spaces is refused outright (403, not an empty list) so the filter cannot be used to probe other spaces. */
function assertSpaceFilterAllowed(scope: AdminAssistantAccess, space: string | undefined): void {
  if (scope.scope === 'spaces' && space !== undefined && !scope.spaces.includes(space)) {
    throw forbidden('you do not administer this space');
  }
}

async function filterOptions(source: 'conversations' | 'unanswered', scope: AdminAssistantAccess): Promise<AdminAssistantFilterOptions> {
  const spaceOnly = scope.scope === 'spaces';
  const spacesParam = spaceOnly ? [scope.spaces] : [];
  const spaces =
    source === 'unanswered'
      ? await query<{ space: string }>(
          `SELECT DISTINCT space FROM ai_unanswered_questions WHERE space IS NOT NULL ${spaceOnly ? 'AND space = ANY($1::text[])' : ''} ORDER BY space`,
          spacesParam,
        )
      : await query<{ space: string }>(
          `SELECT DISTINCT space FROM ai_runs WHERE space IS NOT NULL ${spaceOnly ? 'AND space = ANY($1::text[])' : ''} ORDER BY space`,
          spacesParam,
        );
  let userIds: string;
  if (source === 'unanswered') {
    userIds = `SELECT DISTINCT user_id FROM ai_unanswered_questions ${spaceOnly ? 'WHERE space = ANY($1::text[])' : ''}`;
  } else {
    userIds = spaceOnly
      ? 'SELECT DISTINCT c.user_id FROM ai_conversations c WHERE c.id IN (SELECT conversation_id FROM ai_runs WHERE space = ANY($1::text[]))'
      : 'SELECT DISTINCT user_id FROM ai_conversations';
  }
  const users = await query<{ id: string; name: string; email: string }>(
    `SELECT u.id, u.name, u.email FROM users u WHERE u.id IN (${userIds}) ORDER BY lower(u.name), u.email`,
    spacesParam,
  );
  const names = await loadSpaceNames(spaces.map((r) => r.space));
  const spaceRefs: AdminAssistantSpaceRef[] = spaces
    .map((r) => ({ slug: r.space, name: names.get(r.space) ?? null }))
    .sort((a, b) => (a.name ?? a.slug).localeCompare(b.name ?? b.slug, undefined, { sensitivity: 'base' }) || a.slug.localeCompare(b.slug));
  return { spaces: spaceRefs, users: users.map((u) => ({ id: u.id, name: u.name, email: u.email })) };
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
  user_question: string | null;
  reason: AssistantUnansweredReason;
  missing: string | null;
  created_at: Date;
}

function toUnansweredItem(row: RawUnansweredRow, names: Map<string, string>): AdminAssistantUnansweredItem {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    user: userRef(row),
    space: row.space,
    spaceName: row.space ? (names.get(row.space) ?? null) : null,
    pageId: row.page_id,
    question: row.question,
    userQuestion: row.user_question,
    reason: row.reason,
    missing: row.missing,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * The unanswered-report rows. `user_question` is the user's own message of the run that raised the report
 * (ai_runs.user_message_id); reports without a run (run deleted, older rows) get null and the UI falls back to
 * the assistant's restatement. `spacesParam` = the `$n` holding a space admin's slugs (a space admin gets the message
 * only when that run started in one of their spaces — the rule of `visibleMessage`); a NULL value there, or no
 * param at all, means an instance admin and restricts nothing.
 */
function unansweredSelect(spacesParam: string | null): string {
  const scope = spacesParam ? `AND (${spacesParam}::text[] IS NULL OR r.space = ANY(${spacesParam}::text[]))` : '';
  return `
  SELECT q.id, q.conversation_id, q.user_id, u.name AS user_name, u.email AS user_email,
         q.space, q.page_id, q.question, q.reason, q.missing, q.created_at,
         (SELECT m.content FROM ai_runs r
            JOIN ai_messages m ON m.id = r.user_message_id AND m.conversation_id = r.conversation_id
           WHERE r.id = q.run_id ${scope}) AS user_question
    FROM ai_unanswered_questions q
    JOIN users u ON u.id = q.user_id`;
}

interface RawConversationRow {
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
}

function toConversationRow(row: RawConversationRow, names: Map<string, string>): AdminAssistantConversationRow {
  return {
    conversationId: row.id,
    user: userRef(row),
    space: row.space,
    spaceName: row.space ? (names.get(row.space) ?? null) : null,
    firstQuestion: row.first_question ?? '',
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    questions: Number(row.questions),
    likes: Number(row.likes),
    dislikes: Number(row.dislikes),
    surveys: { solved: Number(row.solved), partly: Number(row.partly), notSolved: Number(row.not_solved) },
    unanswered: Number(row.unanswered),
  };
}

interface ConversationListInput {
  space?: string;
  userId?: string;
  from: string | null;
  toExclusive: string | null;
  limit: number;
  offset: number;
}

/** Instance admin: every conversation, over the whole dialog. */
async function listConversationsInstance(q: ConversationListInput): Promise<{ total: number; rows: RawConversationRow[] }> {
  const params = [q.space ?? null, q.userId ?? null, q.from, q.toExclusive];
  const where = `
      WHERE ($1::text IS NULL OR EXISTS (SELECT 1 FROM ai_runs r WHERE r.conversation_id = c.id AND r.space = $1::text))
        AND ($2::uuid IS NULL OR c.user_id = $2::uuid)
        AND ($3::timestamptz IS NULL OR c.updated_at >= $3::timestamptz)
        AND ($4::timestamptz IS NULL OR c.updated_at < $4::timestamptz)`;
  const [totalRow, rows] = await Promise.all([
    queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM ai_conversations c ${where}`, params),
    query<RawConversationRow>(
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
  ]);
  return { total: Number(totalRow?.n ?? 0), rows };
}

/**
 * Space admin: only conversations with a run in one of `spaces`, every field over the visible part.
 * `$1` = the admin's spaces, `$2` = optional space filter (already checked against `$1`).
 * createdAt/updatedAt are the earliest/latest visible activity (a visible run's start or a visible
 * message), NOT the conversation's own timestamps — those would leak when the hidden part was active.
 * The date range and the ordering use that visible updatedAt.
 */
async function listConversationsSpaces(spaces: string[], q: ConversationListInput): Promise<{ total: number; rows: RawConversationRow[] }> {
  const params = [spaces, q.space ?? null, q.userId ?? null, q.from, q.toExclusive];
  const from = `
      FROM ai_conversations c
      JOIN users u ON u.id = c.user_id
      CROSS JOIN LATERAL (
        SELECT MIN(t) AS first_at, MAX(t) AS last_at FROM (
          SELECT vr.started_at AS t FROM ai_runs vr WHERE vr.conversation_id = c.id AND vr.space = ANY($1::text[])
          UNION ALL
          SELECT m.created_at AS t FROM ai_messages m WHERE m.conversation_id = c.id AND ${visibleMessage('m', '$1')}
        ) x
      ) a
      WHERE c.id IN (SELECT conversation_id FROM ai_runs WHERE space = ANY($1::text[]))
        AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM ai_runs r WHERE r.conversation_id = c.id AND r.space = $2::text))
        AND ($3::uuid IS NULL OR c.user_id = $3::uuid)
        AND ($4::timestamptz IS NULL OR a.last_at >= $4::timestamptz)
        AND ($5::timestamptz IS NULL OR a.last_at < $5::timestamptz)`;
  const [totalRow, rows] = await Promise.all([
    queryOne<{ n: string }>(`SELECT COUNT(*) AS n ${from}`, params),
    query<RawConversationRow>(
      `SELECT c.id, c.user_id, u.name AS user_name, u.email AS user_email, a.first_at AS created_at, a.last_at AS updated_at,
                (SELECT r.space FROM ai_runs r WHERE r.conversation_id = c.id AND r.space = ANY($1::text[]) ORDER BY r.started_at ASC, r.id LIMIT 1) AS space,
                (SELECT m.content FROM ai_messages m WHERE m.conversation_id = c.id AND m.role = 'user' AND ${visibleMessage('m', '$1')} ORDER BY m.created_at ASC, m.id LIMIT 1) AS first_question,
                (SELECT COUNT(*) FROM ai_messages m WHERE m.conversation_id = c.id AND m.role = 'user' AND ${visibleMessage('m', '$1')}) AS questions,
                (SELECT COUNT(*) FROM ai_message_feedback f JOIN ai_messages m ON m.id = f.message_id WHERE m.conversation_id = c.id AND f.rating = 'up' AND ${visibleMessage('m', '$1')}) AS likes,
                (SELECT COUNT(*) FROM ai_message_feedback f JOIN ai_messages m ON m.id = f.message_id WHERE m.conversation_id = c.id AND f.rating = 'down' AND ${visibleMessage('m', '$1')}) AS dislikes,
                (SELECT COUNT(*) FROM ai_conversation_surveys s JOIN ai_messages m ON m.id = s.after_message_id WHERE s.conversation_id = c.id AND s.answer = 'solved' AND ${visibleMessage('m', '$1')}) AS solved,
                (SELECT COUNT(*) FROM ai_conversation_surveys s JOIN ai_messages m ON m.id = s.after_message_id WHERE s.conversation_id = c.id AND s.answer = 'partly' AND ${visibleMessage('m', '$1')}) AS partly,
                (SELECT COUNT(*) FROM ai_conversation_surveys s JOIN ai_messages m ON m.id = s.after_message_id WHERE s.conversation_id = c.id AND s.answer = 'not_solved' AND ${visibleMessage('m', '$1')}) AS not_solved,
                (SELECT COUNT(*) FROM ai_unanswered_questions x WHERE x.conversation_id = c.id AND x.space = ANY($1::text[])) AS unanswered
           ${from}
          ORDER BY a.last_at DESC, c.id
          LIMIT ${q.limit} OFFSET ${q.offset}`,
      params,
    ),
  ]);
  return { total: Number(totalRow?.n ?? 0), rows };
}

/** The audit action written when an admin opens a dialog (see the conversation route). */
export const CONVERSATION_VIEWED_ACTION = 'assistant.conversation_viewed';
const VIEWS_PAGE_SIZE = 50;

/** Can the caller see this conversation at all? Instance admin: it exists. Space admin: it has a run in one of their spaces (the 404 rule of the dialog). */
async function conversationVisible(access: AdminAssistantAccess, conversationId: string): Promise<boolean> {
  const row =
    access.scope === 'spaces'
      ? await queryOne<{ ok: number }>('SELECT 1 AS ok FROM ai_runs WHERE conversation_id = $1 AND space = ANY($2::text[]) LIMIT 1', [conversationId, access.spaces])
      : await queryOne<{ ok: number }>('SELECT 1 AS ok FROM ai_conversations WHERE id = $1', [conversationId]);
  return Boolean(row);
}

export function registerAssistantAdminRoutes(app: FastifyInstance): void {
  app.get('/api/admin/assistant/access', async (request) => {
    const { scope, spaces } = await resolveAnalyticsScope(request);
    // Names for display only; the access decision stays with the slugs. A slug without a row cannot be an administered space (listAdminSpaceSlugs joins spaces), the fallback is just defensive.
    const names = await loadSpaceNames(spaces);
    return { scope, spaces, spaceRefs: spaces.map((slug) => ({ slug, name: names.get(slug) ?? slug })) } satisfies AdminAssistantAccess;
  });

  app.get('/api/admin/assistant/conversations', async (request) => {
    const access = await resolveAnalyticsScope(request);
    const q = parseBody(conversationsQuerySchema, request.query ?? {});
    assertSpaceFilterAllowed(access, q.space);
    const range = dayRange(q.from, q.to);
    const input: ConversationListInput = { space: q.space, userId: q.userId, from: range.from, toExclusive: range.toExclusive, limit: q.limit, offset: q.offset };

    const [{ total, rows }, options] = await Promise.all([
      access.scope === 'spaces' ? listConversationsSpaces(access.spaces, input) : listConversationsInstance(input),
      filterOptions('conversations', access),
    ]);
    const names = await loadSpaceNames(rows.map((r) => r.space));
    return { ...options, items: rows.map((r) => toConversationRow(r, names)), total, scope: access.scope } satisfies AdminAssistantConversationsResponse;
  });

  app.get('/api/admin/assistant/conversations/:conversationId', async (request) => {
    const access = await resolveAnalyticsScope(request);
    const { conversationId } = request.params as { conversationId: string };
    if (!UUID_RE.test(conversationId)) throw notFound('assistant conversation');
    const spaceOnly = access.scope === 'spaces';

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
      spaceOnly
        ? // Visible part only: no visible run → no row → 404 (indistinguishable from a missing conversation).
          // created/updated = earliest/latest visible activity, as in the list.
          `SELECT c.id, c.user_id, u.name AS user_name, u.email AS user_email, c.title, c.model, a.first_at AS created_at, a.last_at AS updated_at
             FROM ai_conversations c
             JOIN users u ON u.id = c.user_id
             CROSS JOIN LATERAL (
               SELECT MIN(t) AS first_at, MAX(t) AS last_at FROM (
                 SELECT vr.started_at AS t FROM ai_runs vr WHERE vr.conversation_id = c.id AND vr.space = ANY($2::text[])
                 UNION ALL
                 SELECT m.created_at AS t FROM ai_messages m WHERE m.conversation_id = c.id AND ${visibleMessage('m', '$2')}
               ) x
             ) a
            WHERE c.id = $1 AND a.last_at IS NOT NULL`
        : `SELECT c.id, c.user_id, u.name AS user_name, u.email AS user_email, c.title, c.model, c.created_at, c.updated_at
             FROM ai_conversations c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
      spaceOnly ? [conversationId, access.spaces] : [conversationId],
    );
    if (!conversation) throw notFound('assistant conversation');

    const [messageRows, totalMessages, surveyRows, unansweredRows] = await Promise.all([
      query<{
        id: string;
        role: 'user' | 'assistant';
        content: string;
        created_at: Date;
        rating: AssistantFeedbackRating | null;
        space: string | null;
      }>(
        spaceOnly
          ? // space = the space of a VISIBLE run only (never the name of another space).
            `SELECT m.id, m.role, m.content, m.created_at, f.rating,
                    (SELECT r.space FROM ai_runs r
                      WHERE r.conversation_id = m.conversation_id AND r.space = ANY($2::text[]) AND (r.user_message_id = m.id OR r.message_id = m.id)
                      ORDER BY r.started_at ASC, r.id LIMIT 1) AS space
               FROM ai_messages m
               LEFT JOIN ai_message_feedback f ON f.message_id = m.id
              WHERE m.conversation_id = $1 AND ${visibleMessage('m', '$2')}
              ORDER BY m.created_at ASC, m.id`
          : `SELECT m.id, m.role, m.content, m.created_at, f.rating,
                    (SELECT r.space FROM ai_runs r WHERE r.user_message_id = m.id OR r.message_id = m.id ORDER BY r.started_at ASC LIMIT 1) AS space
               FROM ai_messages m
               LEFT JOIN ai_message_feedback f ON f.message_id = m.id
              WHERE m.conversation_id = $1
              ORDER BY m.created_at ASC, m.id`,
        spaceOnly ? [conversationId, access.spaces] : [conversationId],
      ),
      queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM ai_messages WHERE conversation_id = $1', [conversationId]),
      query<{ after_message_id: string; answer: AssistantSurveyAnswer; comment: string | null; created_at: Date }>(
        spaceOnly
          ? `SELECT s.after_message_id, s.answer, s.comment, s.created_at
               FROM ai_conversation_surveys s
               JOIN ai_messages m ON m.id = s.after_message_id AND m.conversation_id = s.conversation_id
              WHERE s.conversation_id = $1 AND ${visibleMessage('m', '$2')}
              ORDER BY s.created_at ASC, s.id`
          : 'SELECT after_message_id, answer, comment, created_at FROM ai_conversation_surveys WHERE conversation_id = $1 ORDER BY created_at ASC, id',
        spaceOnly ? [conversationId, access.spaces] : [conversationId],
      ),
      query<RawUnansweredRow>(
        spaceOnly
          ? `${unansweredSelect('$2')} WHERE q.conversation_id = $1 AND q.space = ANY($2::text[]) ORDER BY q.created_at ASC, q.id`
          : `${unansweredSelect(null)} WHERE q.conversation_id = $1 ORDER BY q.created_at ASC, q.id`,
        spaceOnly ? [conversationId, access.spaces] : [conversationId],
      ),
    ]);

    // target is the lowercase uuid, so the "who opened it" lookup finds it however the id was spelled in the URL
    recordAudit(access.user.id, CONVERSATION_VIEWED_ACTION, conversationId.toLowerCase(), { scope: access.scope });

    const names = await loadSpaceNames([...messageRows.map((m) => m.space), ...unansweredRows.map((r) => r.space)]);
    const messages: AdminAssistantMessage[] = messageRows.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.created_at.toISOString(),
      feedback: m.role === 'assistant' ? m.rating : null,
      space: m.space,
      spaceName: m.space ? (names.get(m.space) ?? null) : null,
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
      unanswered: unansweredRows.map((r) => toUnansweredItem(r, names)),
      hiddenMessages: Math.max(0, Number(totalMessages?.n ?? 0) - messages.length),
    } satisfies AdminAssistantConversationDetail;
  });

  // Who opened this dialog, from the audit log. Not itself audited (reading the access log is not reading the dialog).
  app.get('/api/admin/assistant/conversations/:conversationId/views', async (request) => {
    const access = await resolveAnalyticsScope(request);
    const { conversationId } = request.params as { conversationId: string };
    if (!UUID_RE.test(conversationId) || !(await conversationVisible(access, conversationId))) throw notFound('assistant conversation');
    const [rows, totalRow] = await Promise.all([
      query<{ at: Date; user_id: string | null; user_name: string | null; user_email: string | null }>(
        `SELECT a.at, u.id AS user_id, u.name AS user_name, u.email AS user_email
           FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
          WHERE a.action = $1 AND a.target = $2
          ORDER BY a.at DESC, a.id DESC
          LIMIT ${VIEWS_PAGE_SIZE}`,
        [CONVERSATION_VIEWED_ACTION, conversationId.toLowerCase()],
      ),
      queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM audit_log WHERE action = $1 AND target = $2', [CONVERSATION_VIEWED_ACTION, conversationId.toLowerCase()]),
    ]);
    return {
      items: rows.map((r) => ({
        user: r.user_id ? { id: r.user_id, name: r.user_name ?? '', email: r.user_email ?? '' } : null,
        at: r.at.toISOString(),
      })),
      total: Number(totalRow?.n ?? 0),
    } satisfies AdminAssistantConversationViews;
  });

  app.get('/api/admin/assistant/unanswered', async (request) => {
    const access = await resolveAnalyticsScope(request);
    const q = parseBody(unansweredQuerySchema, request.query ?? {});
    assertSpaceFilterAllowed(access, q.space);
    const range = dayRange(q.from, q.to);
    // $6 = the admin's spaces, or null for an instance admin. A report without a space (null)
    // matches no slug, so it is hidden from space admins automatically.
    const params = [q.space ?? null, q.userId ?? null, q.reason ?? null, range.from, range.toExclusive, access.scope === 'spaces' ? access.spaces : null];
    const where = `
      WHERE ($1::text IS NULL OR q.space = $1::text)
        AND ($2::uuid IS NULL OR q.user_id = $2::uuid)
        AND ($3::text IS NULL OR q.reason = $3::text)
        AND ($4::timestamptz IS NULL OR q.created_at >= $4::timestamptz)
        AND ($5::timestamptz IS NULL OR q.created_at < $5::timestamptz)
        AND ($6::text[] IS NULL OR q.space = ANY($6::text[]))`;

    const [totalRow, rows, options] = await Promise.all([
      queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM ai_unanswered_questions q ${where}`, params),
      query<RawUnansweredRow>(`${unansweredSelect('$6')} ${where} ORDER BY q.created_at DESC, q.id LIMIT ${q.limit} OFFSET ${q.offset}`, params),
      filterOptions('unanswered', access),
    ]);
    const names = await loadSpaceNames(rows.map((r) => r.space));
    return { ...options, items: rows.map((r) => toUnansweredItem(r, names)), total: Number(totalRow?.n ?? 0), scope: access.scope } satisfies AdminAssistantUnansweredResponse;
  });
}
