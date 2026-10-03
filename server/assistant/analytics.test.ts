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
  AdminAssistantAccess,
  AdminAssistantConversationDetail,
  AdminAssistantConversationViews,
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


  /** audit_log is written fire-and-forget: wait until `n` rows of `conversation_viewed` for the conversation exist. */
  async function waitForViews(conversationId: string, n: number) {
    for (let i = 0; i < 100; i += 1) {
      const rows = await query<{ n: string }>(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'assistant.conversation_viewed' AND target = $1`, [conversationId]);
      if (Number(rows[0]!.n) >= n) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('audit rows did not appear');
  }

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
      for (const url of ['/api/admin/assistant/access', '/api/admin/assistant/conversations', `/api/admin/assistant/conversations/${convAlice}`, '/api/admin/assistant/unanswered']) {
        expect((await getAs(aliceCookie, url)).statusCode, `${url} non-admin`).toBe(403);
        expect((await getAs(undefined, url, adminPat)).statusCode, `${url} PAT`).toBe(403);
      }
    });

    it('lists conversations with counts and filters by space and user', async () => {
      const all = (await getAs(adminCookie, '/api/admin/assistant/conversations')).json() as AdminAssistantConversationsResponse;
      expect(all.scope).toBe('instance');
      expect(all.total).toBeGreaterThanOrEqual(2);
      // no row in `spaces` for these slugs (never created in this schema): name null = "deleted"
      expect(all.spaces).toEqual(expect.arrayContaining([{ slug: 'admin-docs', name: null }, { slug: 'admin-ops', name: null }]));
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
      expect(detail.hiddenMessages).toBe(0);
      expect(detail.messages.every((m) => m.space === 'admin-docs')).toBe(true);
      expect(detail.messages.find((m) => m.id === aliceAnswer)?.feedback).toBe('down');
      expect(detail.messages.filter((m) => m.role === 'user').every((m) => m.feedback === null)).toBe(true);
      expect(detail.surveys).toMatchObject([{ afterMessageId: aliceAnswer, answer: 'not_solved' }]);
      expect(detail.unanswered).toMatchObject([{ question: 'Where is the SLA?', userQuestion: 'Alice question one', reason: 'no_answer', space: 'admin-docs' }]);

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

    it('lists who opened a conversation, newest first, without auditing the read itself', async () => {
      const viewsOf = async (id: string) => (await getAs(adminCookie, `/api/admin/assistant/conversations/${id}/views`)).json() as AdminAssistantConversationViews;
      const fresh = await newConversation(alice, 'views');
      await addTurn(fresh.id, alice, { space: 'admin-docs', question: 'Views question' });
      expect((await viewsOf(fresh.id)).items).toEqual([]);

      expect((await getAs(adminCookie, `/api/admin/assistant/conversations/${fresh.id}`)).statusCode).toBe(200);
      await waitForViews(fresh.id, 1);
      // the same dialog opened with an upper-case id is still the same conversation in the log
      expect((await getAs(adminCookie, `/api/admin/assistant/conversations/${fresh.id.toUpperCase()}`)).statusCode).toBe(200);
      await waitForViews(fresh.id, 2);

      const views = await viewsOf(fresh.id);
      expect(views.total).toBe(2);
      expect(views.items).toHaveLength(2);
      expect(views.items.every((v) => v.user?.id === admin.id && v.user.email === admin.email)).toBe(true);
      expect(Date.parse(views.items[0]!.at)).toBeGreaterThanOrEqual(Date.parse(views.items[1]!.at));

      // reading the log wrote nothing
      await viewsOf(fresh.id);
      await new Promise((r) => setTimeout(r, 100));
      const count = await query<{ n: string }>(`SELECT COUNT(*) AS n FROM audit_log WHERE target = $1`, [fresh.id]);
      expect(Number(count[0]!.n)).toBe(2);

      // an account deleted since: the entry stays, the user is null
      const gone = await authStore.createUser({ email: `an-gone-${stamp}@test.local`, name: 'An gone', passwordHash: 'x', isAdmin: true });
      await query(`INSERT INTO audit_log (actor_id, action, target) VALUES ($1, 'assistant.conversation_viewed', $2)`, [gone.id, fresh.id]);
      await query('DELETE FROM users WHERE id = $1', [gone.id]);
      const after = await viewsOf(fresh.id);
      expect(after.total).toBe(3);
      expect(after.items.filter((v) => v.user === null)).toHaveLength(1);

      expect((await getAs(adminCookie, `/api/admin/assistant/conversations/${randomUUID()}/views`)).statusCode).toBe(404);
      expect((await getAs(adminCookie, '/api/admin/assistant/conversations/not-a-uuid/views')).statusCode).toBe(404);
    });

    it('lists unanswered questions with filters', async () => {
      const all = (await getAs(adminCookie, '/api/admin/assistant/unanswered')).json() as AdminAssistantUnansweredResponse;
      expect(all.total).toBeGreaterThanOrEqual(2);
      expect(all.items.map((i) => i.question)).toEqual(expect.arrayContaining(['Where is the SLA?', 'Who is on call?']));
      expect(all.spaces).toEqual(expect.arrayContaining([{ slug: 'admin-docs', name: null }, { slug: 'admin-ops', name: null }]));

      const byReason = (await getAs(adminCookie, '/api/admin/assistant/unanswered?reason=low_confidence&space=admin-ops')).json() as AdminAssistantUnansweredResponse;
      expect(byReason.items.map((i) => i.question)).toEqual(['Who is on call?']);
      const bySpace = (await getAs(adminCookie, '/api/admin/assistant/unanswered?space=admin-docs')).json() as AdminAssistantUnansweredResponse;
      // question = the assistant's restatement; userQuestion = the person's own message of the run (null without a run)
      expect(bySpace.items).toMatchObject([{ question: 'Where is the SLA?', userQuestion: 'Alice question one', missing: 'no SLA page', user: { id: alice.id } }]);
      const bobItems = (await getAs(adminCookie, `/api/admin/assistant/unanswered?userId=${bob.id}`)).json() as AdminAssistantUnansweredResponse;
      expect(bobItems.items).toMatchObject([{ question: 'Who is on call?', userQuestion: null }]);
      const byUser = (await getAs(adminCookie, `/api/admin/assistant/unanswered?userId=${bob.id}`)).json() as AdminAssistantUnansweredResponse;
      expect(byUser.total).toBe(1);
      expect((await getAs(adminCookie, '/api/admin/assistant/unanswered?reason=other')).statusCode).toBe(400);
    });
  });
  describe('space admin scope', () => {
    let s1: string;
    let s2: string;
    let s3: string;
    let spaceAdmin: User;
    let s2Admin: User;
    let editor: User;
    let viewer: User;
    let disabledAdmin: User;
    let spaceAdminCookie: string;
    let s2AdminCookie: string;
    let editorCookie: string;
    let viewerCookie: string;
    let disabledCookie: string;
    let spaceAdminPat: string;

    // conversation of alice: S1 turn, S2 turn, a pre-migration pair (no run), a later S1 turn
    let convMixed: string;
    let convS2Only: string;
    let convBobS1: string;
    let s1Answer1: string;
    let s2Answer: string;
    let preAnswer: string;

    const getAs = (cookie: string | undefined, url: string, pat?: string) =>
      app.inject({ method: 'GET', url, headers: { ...(cookie ? { cookie } : {}), ...(pat ? { authorization: `Bearer ${pat}` } : {}) } });
    const listAs = async (cookie: string, qs = '') => (await getAs(cookie, `/api/admin/assistant/conversations${qs}`)).json() as AdminAssistantConversationsResponse;
    const unansweredAs = async (cookie: string, qs = '') => (await getAs(cookie, `/api/admin/assistant/unanswered${qs}`)).json() as AdminAssistantUnansweredResponse;

    beforeAll(async () => {
      s1 = `sa-one-${stamp}`;
      s2 = `sa-two-${stamp}`;
      s3 = `sa-three-${stamp}`;
      for (const slug of [s1, s2, s3]) await query('INSERT INTO spaces (slug, name) VALUES ($1, $2)', [slug, `Name ${slug}`]);

      const mk = (name: string) => authStore.createUser({ email: `sa-${name}-${stamp}@test.local`, name: `Sa ${name}`, passwordHash: 'x', isAdmin: false });
      [spaceAdmin, s2Admin, editor, viewer, disabledAdmin] = await Promise.all([mk('admin1'), mk('admin2'), mk('editor'), mk('viewer'), mk('disabled')]);
      // spaceAdmin: admin of S1 and S3 (S3 gets trashed below), only an editor in S2
      await authStore.setMembership(s1, spaceAdmin.id, 'admin');
      await authStore.setMembership(s3, spaceAdmin.id, 'admin');
      await authStore.setMembership(s2, spaceAdmin.id, 'editor');
      await authStore.setMembership(s2, s2Admin.id, 'admin');
      await authStore.setMembership(s1, editor.id, 'editor');
      await authStore.setMembership(s1, viewer.id, 'viewer');
      await authStore.setMembership(s1, disabledAdmin.id, 'admin');
      [spaceAdminCookie, s2AdminCookie, editorCookie, viewerCookie, disabledCookie] = await Promise.all(
        [spaceAdmin, s2Admin, editor, viewer, disabledAdmin].map(cookieFor),
      );
      spaceAdminPat = (await authStore.createApiToken(spaceAdmin.id, 'sa', ['read', 'write'] as ApiTokenScope[])).token;

      const c = await newConversation(alice, 'mixed');
      const t1 = await addTurn(c.id, alice, { space: s1, question: 'S1 question' });
      const t2 = await addTurn(c.id, alice, { space: s2, question: 'S2 question secret' });
      // pre-migration messages: no run row, no space
      await assistantStore.insertMessage(c.id, 'user', 'Old question without a space');
      const pre = await assistantStore.insertMessage(c.id, 'assistant', 'Old answer without a space');
      const t3 = await addTurn(c.id, alice, { space: s1, question: 'S1 second question' });
      convMixed = c.id;
      s1Answer1 = t1.answer.id;
      s2Answer = t2.answer.id;
      preAnswer = pre.id;

      await query('INSERT INTO ai_message_feedback (message_id, user_id, rating) VALUES ($1, $2, $3), ($4, $2, $5), ($6, $2, $5)', [
        t1.answer.id, alice.id, 'up', t2.answer.id, 'down', pre.id,
      ]);
      await query(
        `INSERT INTO ai_conversation_surveys (conversation_id, user_id, after_message_id, answer, comment) VALUES
           ($1, $2, $3, 'solved', 'fine'), ($1, $2, $4, 'not_solved', 'secret S2 comment'), ($1, $2, $5, 'partly', 'secret old comment')`,
        [c.id, alice.id, t1.answer.id, t2.answer.id, pre.id],
      );
      await query(
        `INSERT INTO ai_unanswered_questions (conversation_id, run_id, user_id, space, question, reason) VALUES
           ($1, $2, $3, $4, 'S1 report', 'no_answer'),
           ($1, $5, $3, $6, 'S2 report secret', 'no_answer'),
           ($1, NULL, $3, NULL, 'Null space report secret', 'low_confidence'),
           ($1, $7, $3, $4, 'S1 later report', 'low_confidence')`,
        [c.id, t1.runId, alice.id, s1, t2.runId, s2, t3.runId],
      );

      const d = await newConversation(alice, 'only s2');
      await addTurn(d.id, alice, { space: s2, question: 'Only S2 question' });
      convS2Only = d.id;
      await query(`INSERT INTO ai_unanswered_questions (conversation_id, user_id, space, question, reason) VALUES ($1, $2, $3, 'S2 only report', 'no_answer')`, [d.id, alice.id, s2]);

      const b = await newConversation(bob, 'bob s1');
      await addTurn(b.id, bob, { space: s1, question: 'Bob S1 question' });
      convBobS1 = b.id;

      // S3 is trashed: the spaces row goes, memberships cascade; its runs stay in ai_runs
      const t = await newConversation(alice, 'trashed space');
      await addTurn(t.id, alice, { space: s3, question: 'Trashed space question' });
      await query('DELETE FROM spaces WHERE slug = $1', [s3]);

      await authStore.updateUser(disabledAdmin.id, { disabled: true });
    });

    it('/access returns the scope: spaces for a space admin (trashed space excluded), instance for an instance admin, 403 for the rest', async () => {
      const get = async (cookie: string) => getAs(cookie, '/api/admin/assistant/access');
      expect((await get(spaceAdminCookie)).json() as AdminAssistantAccess).toEqual({ scope: 'spaces', spaces: [s1] });
      expect((await get(s2AdminCookie)).json() as AdminAssistantAccess).toEqual({ scope: 'spaces', spaces: [s2] });
      expect((await get(adminCookie)).json() as AdminAssistantAccess).toEqual({ scope: 'instance', spaces: [] });
      for (const [name, cookie] of [['editor', editorCookie], ['viewer', viewerCookie], ['alice', aliceCookie]] as const) {
        expect((await get(cookie)).statusCode, name).toBe(403);
      }
    });

    it('refuses an editor, a viewer, a PAT of a space admin and a disabled space admin on every route', async () => {
      const urls = ['/api/admin/assistant/access', '/api/admin/assistant/conversations', `/api/admin/assistant/conversations/${convMixed}`, `/api/admin/assistant/conversations/${convMixed}/views`, '/api/admin/assistant/unanswered'];
      for (const url of urls) {
        expect((await getAs(editorCookie, url)).statusCode, `${url} editor`).toBe(403);
        expect((await getAs(viewerCookie, url)).statusCode, `${url} viewer`).toBe(403);
        expect((await getAs(undefined, url, spaceAdminPat)).statusCode, `${url} PAT`).toBe(403);
        expect((await getAs(disabledCookie, url)).statusCode, `${url} disabled`).toBe(401);
        expect((await getAs(undefined, url)).statusCode, `${url} anonymous`).toBe(401);
      }
    });

    it('lists only conversations with a run in the admin\'s spaces, with counters over the visible part', async () => {
      const res = await listAs(spaceAdminCookie);
      expect(res.scope).toBe('spaces');
      expect(res.items.map((i) => i.conversationId).sort()).toEqual([convMixed, convBobS1].sort());
      expect(res.total).toBe(2);
      // filter options: only the admin's spaces / users with a visible conversation
      expect(res.spaces).toEqual([{ slug: s1, name: `Name ${s1}` }]);
      expect(res.users.map((u) => u.id).sort()).toEqual([alice.id, bob.id].sort());

      const row = res.items.find((i) => i.conversationId === convMixed)!;
      expect(row).toMatchObject({
        space: s1,
        firstQuestion: 'S1 question',
        questions: 2,
        likes: 1,
        dislikes: 0,
        surveys: { solved: 1, partly: 0, notSolved: 0 },
        unanswered: 2,
        user: { id: alice.id },
      });
      // the dates describe the visible part, not the whole conversation
      expect(new Date(row.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(row.createdAt).getTime());

      // the instance admin sees the same conversation in full
      const full = (await listAs(adminCookie)).items.find((i) => i.conversationId === convMixed)!;
      expect(full).toMatchObject({
        space: s1,
        questions: 4,
        likes: 1,
        dislikes: 2,
        surveys: { solved: 1, partly: 1, notSolved: 1 },
        unanswered: 4,
      });
      expect(JSON.stringify(res)).not.toMatch(/secret|Only S2|Trashed space/);
    });

    it('filters by user and by an own space; a space outside the admin\'s spaces is 403 (not an empty list)', async () => {
      expect((await listAs(spaceAdminCookie, `?userId=${bob.id}`)).items.map((i) => i.conversationId)).toEqual([convBobS1]);
      expect((await listAs(spaceAdminCookie, `?space=${s1}`)).total).toBe(2);
      for (const space of [s2, s3, 'admin-docs', 'no-such-space']) {
        expect((await getAs(spaceAdminCookie, `/api/admin/assistant/conversations?space=${space}`)).statusCode, space).toBe(403);
        expect((await getAs(spaceAdminCookie, `/api/admin/assistant/unanswered?space=${space}`)).statusCode, space).toBe(403);
      }
      // the S2-only conversation belongs to the S2 admin, who in turn sees nothing of S1
      const s2List = await listAs(s2AdminCookie);
      expect(s2List.items.map((i) => i.conversationId).sort()).toEqual([convMixed, convS2Only].sort());
      const s2Row = s2List.items.find((i) => i.conversationId === convMixed)!;
      expect(s2Row).toMatchObject({ space: s2, firstQuestion: 'S2 question secret', questions: 1, dislikes: 1, surveys: { notSolved: 1, solved: 0, partly: 0 }, unanswered: 1 });
      expect(JSON.stringify(s2List)).not.toContain('S1 question');
      // pagination applies to the visible set
      const paged = await listAs(spaceAdminCookie, '?limit=1&offset=1');
      expect(paged.items).toHaveLength(1);
      expect(paged.total).toBe(2);
      expect((await listAs(spaceAdminCookie, '?from=2999-01-01')).total).toBe(0);
    });

    it('opens only the visible part of a conversation and reports how many messages are hidden', async () => {
      const res = await getAs(spaceAdminCookie, `/api/admin/assistant/conversations/${convMixed}`);
      expect(res.statusCode).toBe(200);
      const detail = res.json() as AdminAssistantConversationDetail;
      expect(detail.messages.map((m) => m.content)).toEqual(['S1 question', 'Like this.', 'S1 second question', 'Like this.']);
      expect(detail.messages.every((m) => m.space === s1)).toBe(true);
      expect(detail.hiddenMessages).toBe(4);
      expect(detail.messages.find((m) => m.id === s1Answer1)?.feedback).toBe('up');
      expect(detail.surveys).toMatchObject([{ afterMessageId: s1Answer1, answer: 'solved', comment: 'fine' }]);
      expect(detail.unanswered.map((u) => u.question).sort()).toEqual(['S1 later report', 'S1 report']);
      expect(detail.user.id).toBe(alice.id);
      const ids = detail.messages.map((m) => m.id);
      expect(ids).not.toContain(s2Answer);
      expect(ids).not.toContain(preAnswer);
      expect(res.body).not.toMatch(/secret|Old question|Old answer|S2 /);
      expect(res.body).not.toContain(s2);

      // the instance admin still sees everything, nothing hidden
      const full = (await getAs(adminCookie, `/api/admin/assistant/conversations/${convMixed}`)).json() as AdminAssistantConversationDetail;
      expect(full.messages).toHaveLength(8);
      expect(full.hiddenMessages).toBe(0);
      expect(full.surveys).toHaveLength(3);
      expect(full.unanswered).toHaveLength(4);

      // no visible run → 404, exactly like a missing conversation (S2-only, the trashed space, unknown, bad id)
      expect((await getAs(spaceAdminCookie, `/api/admin/assistant/conversations/${convS2Only}`)).statusCode).toBe(404);
      const trashed = await query<{ id: string }>(`SELECT conversation_id AS id FROM ai_runs WHERE space = $1`, [s3]);
      expect((await getAs(spaceAdminCookie, `/api/admin/assistant/conversations/${trashed[0]!.id}`)).statusCode).toBe(404);
      expect((await getAs(spaceAdminCookie, `/api/admin/assistant/conversations/${randomUUID()}`)).statusCode).toBe(404);
      expect((await getAs(spaceAdminCookie, '/api/admin/assistant/conversations/not-a-uuid')).statusCode).toBe(404);

      // the audit entry records the scope
      let meta: { scope?: string } | null = null;
      for (let i = 0; i < 50 && !meta; i += 1) {
        const rows = await query<{ meta: { scope?: string } | null }>(
          `SELECT meta FROM audit_log WHERE action = 'assistant.conversation_viewed' AND target = $1 AND actor_id = $2`,
          [convMixed, spaceAdmin.id],
        );
        meta = rows[0]?.meta ?? null;
        if (!meta) await new Promise((r) => setTimeout(r, 20));
      }
      expect(meta).toEqual({ scope: 'spaces' });
    });

    it('lists unanswered reports of the admin\'s spaces only (null-space and other spaces hidden)', async () => {
      const res = await unansweredAs(spaceAdminCookie);
      expect(res.scope).toBe('spaces');
      expect(res.items.map((i) => i.question).sort()).toEqual(['S1 later report', 'S1 report']);
      expect(Object.fromEntries(res.items.map((i) => [i.question, i.userQuestion]))).toEqual({ 'S1 report': 'S1 question', 'S1 later report': 'S1 second question' });
      expect(res.total).toBe(2);
      expect(res.spaces).toEqual([{ slug: s1, name: `Name ${s1}` }]);
      expect(res.users.map((u) => u.id)).toEqual([alice.id]);
      expect((await unansweredAs(spaceAdminCookie, `?space=${s1}&reason=low_confidence`)).items.map((i) => i.question)).toEqual(['S1 later report']);
      expect((await unansweredAs(spaceAdminCookie, `?userId=${bob.id}`)).total).toBe(0);

      const s2Res = await unansweredAs(s2AdminCookie);
      expect(s2Res.items.map((i) => i.question).sort()).toEqual(['S2 only report', 'S2 report secret']);

      const instance = await unansweredAs(adminCookie);
      expect(instance.scope).toBe('instance');
      expect(instance.items.map((i) => i.question)).toEqual(expect.arrayContaining(['Null space report secret', 'S2 report secret', 'S1 report']));
    });

    it('returns the space name beside the slug everywhere; a trashed space has a null name', async () => {
      const asInstance = await listAs(adminCookie, '?limit=200');
      expect(asInstance.spaces).toEqual(expect.arrayContaining([{ slug: s1, name: `Name ${s1}` }, { slug: s3, name: null }]));
      const bySlug = new Map(asInstance.items.map((i) => [i.space, i.spaceName]));
      expect(bySlug.get(s1)).toBe(`Name ${s1}`);
      expect(bySlug.get(s3)).toBeNull();

      const detail = (await getAs(spaceAdminCookie, `/api/admin/assistant/conversations/${convMixed}`)).json() as AdminAssistantConversationDetail;
      expect(detail.messages.filter((m) => m.space).every((m) => m.spaceName === `Name ${s1}`)).toBe(true);
      expect(detail.unanswered.every((u) => u.spaceName === `Name ${s1}`)).toBe(true);
      expect((await listAs(spaceAdminCookie)).items.every((i) => i.spaceName === `Name ${s1}`)).toBe(true);
      expect((await unansweredAs(spaceAdminCookie)).items.every((i) => i.spaceName === `Name ${s1}`)).toBe(true);
    });

    it('shows a space admin who opened a visible conversation (instance admins included) and 404s one they cannot see', async () => {
      // an instance admin and the space admin each open the mixed conversation
      expect((await getAs(adminCookie, `/api/admin/assistant/conversations/${convMixed}`)).statusCode).toBe(200);
      expect((await getAs(spaceAdminCookie, `/api/admin/assistant/conversations/${convMixed}`)).statusCode).toBe(200);
      await waitForViews(convMixed, 2);
      const views = (await getAs(spaceAdminCookie, `/api/admin/assistant/conversations/${convMixed}/views`)).json() as AdminAssistantConversationViews;
      const who = views.items.map((v) => v.user?.id);
      expect(who).toEqual(expect.arrayContaining([admin.id, spaceAdmin.id]));

      // convS2Only has no run in the space admin's space: indistinguishable from a missing one, log included
      expect((await getAs(spaceAdminCookie, `/api/admin/assistant/conversations/${convS2Only}/views`)).statusCode).toBe(404);
      expect((await getAs(spaceAdminCookie, `/api/admin/assistant/conversations/${randomUUID()}/views`)).statusCode).toBe(404);
      expect((await getAs(s2AdminCookie, `/api/admin/assistant/conversations/${convBobS1}/views`)).statusCode).toBe(404);
      expect((await getAs(s2AdminCookie, `/api/admin/assistant/conversations/${convS2Only}/views`)).statusCode).toBe(200);
    });

    it('never hands a space admin the user message of a run from another space, even when the report itself is in their space', async () => {
      const c = await newConversation(alice, 'cross-space report');
      const turn = await addTurn(c.id, alice, { space: s2, question: 'Secret S2 wording' });
      await query(
        `INSERT INTO ai_unanswered_questions (conversation_id, run_id, user_id, space, question, reason) VALUES ($1, $2, $3, $4, 'Cross-space restatement', 'no_answer')`,
        [c.id, turn.runId, alice.id, s1],
      );
      try {
        const own = (await unansweredAs(spaceAdminCookie)).items.find((i) => i.question === 'Cross-space restatement');
        expect(own).toBeDefined();
        expect(own!.userQuestion).toBeNull();
        const asInstance = (await unansweredAs(adminCookie)).items.find((i) => i.question === 'Cross-space restatement');
        expect(asInstance!.userQuestion).toBe('Secret S2 wording');
        expect(JSON.stringify(await unansweredAs(spaceAdminCookie))).not.toContain('Secret S2 wording');
      } finally {
        await query('DELETE FROM ai_conversations WHERE id = $1', [c.id]);
      }
    });
  });
});
