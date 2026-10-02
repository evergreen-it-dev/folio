/**
 * Assistant analytics: answer feedback, the periodic survey, the built-in
 * report_unanswered_question tool and the admin read side. Real PostgreSQL
 * (per-file schema), real routes via Fastify inject; no Cursor SDK is involved
 * (the routes under test never reach it).
 */
import { randomUUID } from 'node:crypto';
import type { SDKCustomTool } from '@cursor/sdk';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AdminAssistantConversationDetail,
  AdminAssistantConversationsResponse,
  AdminAssistantUnansweredResponse,
  ApiTokenScope,
  AssistantConversation,
  User,
} from '../../shared/contracts.js';
import { ASSISTANT_SURVEY_EVERY } from '../../shared/contracts.js';
import { setUpTestSchema } from '../db/testSchema.js';
import { query } from '../db/pool.js';
import { HttpError } from '../errors.js';
import * as authStore from '../auth/store.js';
import * as session from '../auth/session.js';
import * as assistantStore from './store.js';
import { registerAssistantRoutes } from './routes.js';
import { registerAssistantAdminRoutes } from './adminRoutes.js';
import { buildAssistantTools } from './tools.js';

const toolCallContext = {} as Parameters<SDKCustomTool['execute']>[1];

describe('assistant analytics (real PG, fastify inject)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  const stamp = Date.now();

  let alice: User;
  let bob: User;
  let admin: User;
  let aliceCookie: string;
  let bobCookie: string;
  let adminCookie: string;
  let adminPat: string;

  const cookieFor = async (user: User): Promise<string> => `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(user.id)).token}`;

  async function newConversation(user: User, title = 'T') {
    return assistantStore.insertConversation({ userId: user.id, title, cursorAgentId: `agent-${randomUUID()}`, model: 'auto' });
  }

  /** A finished turn: user message + run row (with space) + assistant message linked to the run. */
  async function addTurn(conversationId: string, user: User, opts: { space?: string | null; question?: string } = {}) {
    const userMessage = await assistantStore.insertMessage(conversationId, 'user', opts.question ?? 'How do I deploy?');
    const answer = await assistantStore.insertMessage(conversationId, 'assistant', 'Like this.');
    const runId = randomUUID();
    await query(
      `INSERT INTO ai_runs (id, conversation_id, user_id, run_mode, status, space, user_message_id, message_id)
       VALUES ($1, $2, $3, 'ask', 'done', $4, $5, $6)`,
      [runId, conversationId, user.id, opts.space ?? null, userMessage.id, answer.id],
    );
    return { userMessage, answer, runId };
  }

  const chat = async (cookie: string, conversationId: string) =>
    (await app.inject({ method: 'GET', url: `/api/assistant/chat?conversationId=${conversationId}`, headers: { cookie } })).json() as AssistantConversation;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const mk = (name: string, isAdmin: boolean) => authStore.createUser({ email: `an-${name}-${stamp}@test.local`, name: `An ${name}`, passwordHash: 'x', isAdmin });
    [alice, bob, admin] = await Promise.all([mk('alice', false), mk('bob', false), mk('admin', true)]);
    [aliceCookie, bobCookie, adminCookie] = await Promise.all([cookieFor(alice), cookieFor(bob), cookieFor(admin)]);
    adminPat = (await authStore.createApiToken(admin.id, 'an', ['read', 'write'] as ApiTokenScope[])).token;

    const app_ = Fastify();
    app_.decorateRequest('authUser', null);
    app_.setErrorHandler((err, _request, reply) => {
      if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
      return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
    });
    await app_.register(fastifyCookieModule.default);
    await app_.register(async (protectedScope) => {
      protectedScope.addHook('onRequest', session.requireSession);
      registerAssistantRoutes(protectedScope);
      registerAssistantAdminRoutes(protectedScope);
    });
    await app_.ready();
    app = app_;
  });

  afterAll(async () => {
    await app?.close();
    await teardownSchema();
  });

  describe('feedback', () => {
    it('is owner-only, assistant-only, and upserts / deletes the rating', async () => {
      const conv = await newConversation(alice);
      const { userMessage, answer } = await addTurn(conv.id, alice);
      const put = (cookie: string, id: string, rating: 'up' | 'down' | null) =>
        app.inject({ method: 'PUT', url: `/api/assistant/messages/${id}/feedback`, payload: { rating }, headers: { cookie } });

      const up = await put(aliceCookie, answer.id, 'up');
      expect(up.statusCode).toBe(200);
      expect(up.json()).toEqual({ messageId: answer.id, rating: 'up' });
      expect((await chat(aliceCookie, conv.id)).messages.find((m) => m.id === answer.id)?.feedback).toBe('up');

      await put(aliceCookie, answer.id, 'down');
      expect((await chat(aliceCookie, conv.id)).messages.find((m) => m.id === answer.id)?.feedback).toBe('down');
      const rows = await query<{ n: string }>('SELECT COUNT(*) AS n FROM ai_message_feedback WHERE message_id = $1', [answer.id]);
      expect(Number(rows[0]!.n)).toBe(1);

      // not the owner, a user message, an unknown id: all 404 and nothing written
      expect((await put(bobCookie, answer.id, 'up')).statusCode).toBe(404);
      expect((await put(aliceCookie, userMessage.id, 'up')).statusCode).toBe(404);
      expect((await put(aliceCookie, randomUUID(), 'up')).statusCode).toBe(404);
      expect((await app.inject({ method: 'PUT', url: `/api/assistant/messages/${answer.id}/feedback`, payload: { rating: 'meh' }, headers: { cookie: aliceCookie } })).statusCode).toBe(400);
      expect((await chat(aliceCookie, conv.id)).messages.find((m) => m.id === answer.id)?.feedback).toBe('down');

      const cleared = await put(aliceCookie, answer.id, null);
      expect(cleared.json()).toEqual({ messageId: answer.id, rating: null });
      expect((await chat(aliceCookie, conv.id)).messages.find((m) => m.id === answer.id)?.feedback).toBeNull();
    });
  });

  describe('survey', () => {
    const postSurvey = (cookie: string, conversationId: string, body: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/api/assistant/conversations/${conversationId}/survey`, payload: body, headers: { cookie } });

    it(`is due after ${ASSISTANT_SURVEY_EVERY} answers, cleared by a survey, due again after ${ASSISTANT_SURVEY_EVERY} more`, async () => {
      const conv = await newConversation(alice);
      const answers: string[] = [];
      for (let i = 0; i < ASSISTANT_SURVEY_EVERY - 1; i += 1) answers.push((await addTurn(conv.id, alice)).answer.id);
      expect((await chat(aliceCookie, conv.id)).surveyDue).toBeNull();

      answers.push((await addTurn(conv.id, alice)).answer.id);
      expect((await chat(aliceCookie, conv.id)).surveyDue).toEqual({ afterMessageId: answers.at(-1) });

      const res = await postSurvey(aliceCookie, conv.id, { afterMessageId: answers.at(-1), answer: 'partly', comment: '  half  ' });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ ok: true });
      expect((await chat(aliceCookie, conv.id)).surveyDue).toBeNull();
      const saved = await query<{ answer: string; comment: string }>('SELECT answer, comment FROM ai_conversation_surveys WHERE conversation_id = $1', [conv.id]);
      expect(saved).toEqual([{ answer: 'partly', comment: 'half' }]);

      for (let i = 0; i < ASSISTANT_SURVEY_EVERY - 1; i += 1) answers.push((await addTurn(conv.id, alice)).answer.id);
      expect((await chat(aliceCookie, conv.id)).surveyDue).toBeNull();
      answers.push((await addTurn(conv.id, alice)).answer.id);
      expect((await chat(aliceCookie, conv.id)).surveyDue).toEqual({ afterMessageId: answers.at(-1) });

      // a skip counts as a survey too; answering the same message again replaces the answer
      await postSurvey(aliceCookie, conv.id, { afterMessageId: answers.at(-1), answer: 'skipped' });
      expect((await chat(aliceCookie, conv.id)).surveyDue).toBeNull();
      await postSurvey(aliceCookie, conv.id, { afterMessageId: answers.at(-1), answer: 'solved' });
      const all = await query<{ n: string }>('SELECT COUNT(*) AS n FROM ai_conversation_surveys WHERE conversation_id = $1', [conv.id]);
      expect(Number(all[0]!.n)).toBe(2);
    });

    it('rejects a foreign conversation (404) and a message that is not an assistant message of it (400)', async () => {
      const conv = await newConversation(alice);
      const other = await newConversation(alice);
      const turn = await addTurn(conv.id, alice);
      const otherTurn = await addTurn(other.id, alice);

      expect((await postSurvey(bobCookie, conv.id, { afterMessageId: turn.answer.id, answer: 'solved' })).statusCode).toBe(404);
      expect((await postSurvey(aliceCookie, conv.id, { afterMessageId: turn.userMessage.id, answer: 'solved' })).statusCode).toBe(400);
      expect((await postSurvey(aliceCookie, conv.id, { afterMessageId: otherTurn.answer.id, answer: 'solved' })).statusCode).toBe(400);
      expect((await postSurvey(aliceCookie, conv.id, { afterMessageId: turn.answer.id, answer: 'great' })).statusCode).toBe(400);
    });
  });

  describe('report_unanswered_question tool', () => {
    it('writes a row with run, space and user in both modes and caps at 3 per run', async () => {
      const conv = await newConversation(alice);
      const { runId } = await addTurn(conv.id, alice, { space: 'docs' });
      const context = { runId, conversationId: conv.id, space: 'docs', pageId: 'page-1' };

      for (const mode of ['ask', 'agent'] as const) {
        const handle = await buildAssistantTools(alice, mode, context);
        expect(handle.tools.report_unanswered_question, mode).toBeDefined();
        await handle.close();
      }

      const handle = await buildAssistantTools(alice, 'ask', context);
      const report = handle.tools.report_unanswered_question!;
      const tool = { execute: (args: Record<string, string>) => report.execute(args, toolCallContext) };
      try {
        const first = await tool.execute({ question: 'How do I rotate the key?', reason: 'no_answer', missing: 'no runbook' });
        expect(first).toBe('Recorded. Continue answering the user.');
        const rows = await query<Record<string, string | null>>('SELECT * FROM ai_unanswered_questions WHERE run_id = $1', [runId]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          conversation_id: conv.id,
          user_id: alice.id,
          space: 'docs',
          page_id: 'page-1',
          question: 'How do I rotate the key?',
          reason: 'no_answer',
          missing: 'no runbook',
        });

        expect(await tool.execute({ question: 'Second', reason: 'low_confidence' })).toBe('Recorded. Continue answering the user.');
        expect(await tool.execute({ question: 'Third', reason: 'low_confidence' })).toBe('Recorded. Continue answering the user.');
        expect(await tool.execute({ question: 'Fourth', reason: 'low_confidence' })).toBe('Already recorded.');
        const count = await query<{ n: string }>('SELECT COUNT(*) AS n FROM ai_unanswered_questions WHERE run_id = $1', [runId]);
        expect(Number(count[0]!.n)).toBe(3);

        // invalid input is an error result, not a throw
        const bad = await tool.execute({ question: '', reason: 'nope' });
        expect(bad).toMatchObject({ isError: true });
      } finally {
        await handle.close();
      }
    });

    it('returns an error result (does not throw) when the database write fails', async () => {
      const handle = await buildAssistantTools(alice, 'ask', { runId: randomUUID(), conversationId: randomUUID(), space: null, pageId: null });
      try {
        // the conversation does not exist: the FK violation must come back as isError
        const result = await handle.tools.report_unanswered_question!.execute({ question: 'Q', reason: 'no_answer' }, toolCallContext);
        expect(result).toMatchObject({ isError: true });
      } finally {
        await handle.close();
      }
    });
  });

  describe('admin endpoints', () => {
    let convAlice: string;
    let convBob: string;
    let aliceAnswer: string;

    beforeAll(async () => {
      const a = await newConversation(alice, 'alice docs');
      const t = await addTurn(a.id, alice, { space: 'admin-docs', question: 'Alice question one' });
      await addTurn(a.id, alice, { space: 'admin-docs', question: 'Alice question two' });
      const b = await newConversation(bob, 'bob ops');
      await addTurn(b.id, bob, { space: 'admin-ops', question: 'Bob question' });
      convAlice = a.id;
      convBob = b.id;
      aliceAnswer = t.answer.id;

      await query('INSERT INTO ai_message_feedback (message_id, user_id, rating) VALUES ($1, $2, $3)', [t.answer.id, alice.id, 'down']);
      await query(`INSERT INTO ai_conversation_surveys (conversation_id, user_id, after_message_id, answer) VALUES ($1, $2, $3, 'not_solved')`, [a.id, alice.id, t.answer.id]);
      await query(
        `INSERT INTO ai_unanswered_questions (conversation_id, run_id, user_id, space, question, reason, missing)
         VALUES ($1, $2, $3, 'admin-docs', 'Where is the SLA?', 'no_answer', 'no SLA page')`,
        [a.id, t.runId, alice.id],
      );
      await query(
        `INSERT INTO ai_unanswered_questions (conversation_id, user_id, space, question, reason) VALUES ($1, $2, 'admin-ops', 'Who is on call?', 'low_confidence')`,
        [b.id, bob.id],
      );
    });

    const getAs = (cookie: string | undefined, url: string, pat?: string) =>
      app.inject({ method: 'GET', url, headers: { ...(cookie ? { cookie } : {}), ...(pat ? { authorization: `Bearer ${pat}` } : {}) } });

    it('refuses a non-admin and a PAT (even an admin one) on every admin route', async () => {
      for (const url of ['/api/admin/assistant/conversations', `/api/admin/assistant/conversations/${convAlice}`, '/api/admin/assistant/unanswered']) {
        expect((await getAs(aliceCookie, url)).statusCode, `${url} non-admin`).toBe(403);
        expect((await getAs(undefined, url, adminPat)).statusCode, `${url} PAT`).toBe(403);
      }
    });

    it('lists conversations with counts and filters by space and user', async () => {
      const all = (await getAs(adminCookie, '/api/admin/assistant/conversations')).json() as AdminAssistantConversationsResponse;
      expect(all.total).toBeGreaterThanOrEqual(2);
      expect(all.spaces).toEqual(expect.arrayContaining(['admin-docs', 'admin-ops']));
      expect(all.users.map((u) => u.id)).toEqual(expect.arrayContaining([alice.id, bob.id]));
      const row = all.items.find((i) => i.conversationId === convAlice)!;
      expect(row).toMatchObject({
        space: 'admin-docs',
        firstQuestion: 'Alice question one',
        questions: 2,
        likes: 0,
        dislikes: 1,
        surveys: { solved: 0, partly: 0, notSolved: 1 },
        unanswered: 1,
        user: { id: alice.id },
      });

      const bySpace = (await getAs(adminCookie, '/api/admin/assistant/conversations?space=admin-ops')).json() as AdminAssistantConversationsResponse;
      expect(bySpace.items.map((i) => i.conversationId)).toEqual([convBob]);
      expect(bySpace.total).toBe(1);

      const byUser = (await getAs(adminCookie, `/api/admin/assistant/conversations?userId=${bob.id}`)).json() as AdminAssistantConversationsResponse;
      expect(byUser.items.map((i) => i.conversationId)).toEqual([convBob]);
      expect(byUser.items.every((i) => i.user.id === bob.id)).toBe(true);
      const both = (await getAs(adminCookie, `/api/admin/assistant/conversations?userId=${bob.id}&space=admin-docs`)).json() as AdminAssistantConversationsResponse;
      expect(both.total).toBe(0);

      const paged = (await getAs(adminCookie, '/api/admin/assistant/conversations?limit=1&offset=1')).json() as AdminAssistantConversationsResponse;
      expect(paged.items).toHaveLength(1);
      expect(paged.total).toBe(all.total);

      const today = new Date().toISOString().slice(0, 10);
      const inRange = (await getAs(adminCookie, `/api/admin/assistant/conversations?from=${today}&to=${today}`)).json() as AdminAssistantConversationsResponse;
      expect(inRange.total).toBe(all.total);
      const future = (await getAs(adminCookie, '/api/admin/assistant/conversations?from=2999-01-01')).json() as AdminAssistantConversationsResponse;
      expect(future.total).toBe(0);

      expect((await getAs(adminCookie, '/api/admin/assistant/conversations?limit=500')).statusCode).toBe(400);
      expect((await getAs(adminCookie, '/api/admin/assistant/conversations?userId=nope')).statusCode).toBe(400);
    });

    it('opens a conversation in full with feedback, space, surveys and unanswered, and 404s a missing one', async () => {
      const detail = (await getAs(adminCookie, `/api/admin/assistant/conversations/${convAlice}`)).json() as AdminAssistantConversationDetail;
      expect(detail.user.id).toBe(alice.id);
      expect(detail.messages).toHaveLength(4);
      expect(detail.messages.every((m) => m.space === 'admin-docs')).toBe(true);
      expect(detail.messages.find((m) => m.id === aliceAnswer)?.feedback).toBe('down');
      expect(detail.messages.filter((m) => m.role === 'user').every((m) => m.feedback === null)).toBe(true);
      expect(detail.surveys).toMatchObject([{ afterMessageId: aliceAnswer, answer: 'not_solved' }]);
      expect(detail.unanswered).toMatchObject([{ question: 'Where is the SLA?', reason: 'no_answer', space: 'admin-docs' }]);

      expect((await getAs(adminCookie, `/api/admin/assistant/conversations/${randomUUID()}`)).statusCode).toBe(404);
      expect((await getAs(adminCookie, '/api/admin/assistant/conversations/not-a-uuid')).statusCode).toBe(404);

      // opening someone else's dialog leaves an audit entry (written fire-and-forget)
      let audited = 0;
      for (let i = 0; i < 50 && audited === 0; i += 1) {
        const rows = await query<{ n: string }>(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'assistant.conversation_viewed' AND target = $1 AND actor_id = $2`, [convAlice, admin.id]);
        audited = Number(rows[0]!.n);
        if (audited === 0) await new Promise((r) => setTimeout(r, 20));
      }
      expect(audited).toBeGreaterThan(0);
    });

    it('lists unanswered questions with filters', async () => {
      const all = (await getAs(adminCookie, '/api/admin/assistant/unanswered')).json() as AdminAssistantUnansweredResponse;
      expect(all.total).toBeGreaterThanOrEqual(2);
      expect(all.items.map((i) => i.question)).toEqual(expect.arrayContaining(['Where is the SLA?', 'Who is on call?']));
      expect(all.spaces).toEqual(expect.arrayContaining(['admin-docs', 'admin-ops']));

      const byReason = (await getAs(adminCookie, '/api/admin/assistant/unanswered?reason=low_confidence&space=admin-ops')).json() as AdminAssistantUnansweredResponse;
      expect(byReason.items.map((i) => i.question)).toEqual(['Who is on call?']);
      const bySpace = (await getAs(adminCookie, '/api/admin/assistant/unanswered?space=admin-docs')).json() as AdminAssistantUnansweredResponse;
      expect(bySpace.items).toMatchObject([{ question: 'Where is the SLA?', missing: 'no SLA page', user: { id: alice.id } }]);
      const byUser = (await getAs(adminCookie, `/api/admin/assistant/unanswered?userId=${bob.id}`)).json() as AdminAssistantUnansweredResponse;
      expect(byUser.total).toBe(1);
      expect((await getAs(adminCookie, '/api/admin/assistant/unanswered?reason=other')).statusCode).toBe(400);
    });
  });
});
