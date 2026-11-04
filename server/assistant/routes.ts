/**
 * AI assistant (Cursor SDK) — /api/assistant/* routes, cookie-session only
 * (session.requireCookieAuth first in every handler — a PAT must never reach
 * this: see shared/contracts.ts's own comment on the AI-assistant section).
 * Registered inside index.ts's protectedScope, next to registerPageChangeRoutes.
 *
 * 05.09.2026 — a run is now a server-side task (runs.ts's RunManager), not
 * something that lives and dies inside one HTTP request: POST /runs starts
 * it and returns immediately, GET /runs/:runId/events is a pure subscriber
 * (a dropped connection here does NOT cancel the run — see runs.ts's doc
 * comment). POST /chat/stream is kept as a thin backward-compatible wrapper
 * around the same startRun()/subscribe() pair.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  ActiveAssistantRunResponse,
  AssistantFeedbackResponse,
  AssistantConnectionCheck,
  AssistantConversation,
  AssistantConversationsResponse,
  AssistantKeySource,
  AssistantMessage,
  AssistantModelsResponse,
  AssistantRunEvent,
  AssistantSettings,
  AssistantStreamEvent,
  SendAssistantMessageBody,
  StartAssistantRunResponse,
  User,
} from '../../shared/contracts.js';
import {
  assistantFeedbackBodySchema,
  assistantSurveyBodySchema,
  saveAssistantKeyBodySchema,
  sendAssistantMessageBodySchema,
  updateAssistantModelBodySchema,
} from '../../shared/contracts.js';
import * as session from '../auth/session.js';
import { assertNotDemo } from '../demo.js';
import { badRequest, conflict, forbidden, notFound, HttpError } from '../errors.js';
import { parseBody, queryString } from '../validate.js';
import { hasSecretConfigured } from '../secretCrypto.js';
import * as storage from '../storage.js';
import { recordAudit } from '../audit.js';
import * as assistantStore from './store.js';
import type { AssistantConversationRow, AssistantMessageRow, AssistantSettingsRow } from './store.js';
import * as runs from './runs.js';
import * as analytics from './analytics.js';
import { authorizeAssistantNavigation, requireAssistantSpaceAccess } from './access.js';
import { cursorRuntimeAvailable, listCursorModels, verifyCursorApiKey } from './cursorRuntime.js';
import * as sharedKeys from './sharedKeys.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ndjsonHeaders = {
  'content-type': 'application/x-ndjson; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
} as const;

/** The one answer to "no key anywhere" for a run start / model change; generic because the key can come from several places. */
const NO_KEY_MESSAGE = 'No Folio AI key is configured — add your own key in account settings or ask an administrator';

/** `?space=<slug>` on the settings routes: optional, trimmed, bounded. */
const keySpaceQuerySchema = z.object({ space: z.string().trim().max(200).optional() });

/**
 * The space level of the key lookup for a read-style route: the slug from
 * `?space=` only when the caller may read that space (viewer+, the same gate as
 * a run — requireAssistantSpaceAccess). An unknown slug and a space the caller
 * cannot see are both just "no space level" (null), never an error, so the
 * answer cannot be used to probe which private slugs exist.
 */
async function authorizedKeySpace(request: FastifyRequest, user: User): Promise<string | null> {
  const { space } = parseBody(keySpaceQuerySchema, request.query ?? {});
  if (!space) return null;
  try {
    await requireAssistantSpaceAccess(user, space);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
  return space;
}

type ResolvedKeySource = { source: AssistantKeySource; apiKeyName: string | null; personalKeysAllowed: boolean };

/**
 * Which level supplies the key, WITHOUT decrypting anything (so the settings
 * screen keeps working when FOLIO_SECRET is missing or was changed).
 * Precedence: personal (only while the instance policy allows personal keys) →
 * the current space's shared key → the instance-wide shared key → the operator's
 * CURSOR_API_KEY. `space` must already be authorized by the caller.
 */
async function resolveKeySource(userId: string, space: string | null, personal?: AssistantSettingsRow): Promise<ResolvedKeySource> {
  const [personalKeysAllowed, settings] = await Promise.all([sharedKeys.getPersonalKeysAllowed(), personal ?? assistantStore.getSettings(userId)]);
  if (personalKeysAllowed && settings.hasKey) return { source: 'personal', apiKeyName: settings.cursorKeyName, personalKeysAllowed };
  if (space) {
    const spaceKey = await sharedKeys.getSpaceKeyInfo(space);
    if (spaceKey.configured) return { source: 'space', apiKeyName: spaceKey.apiKeyName, personalKeysAllowed };
  }
  const instanceKey = await sharedKeys.getInstanceKeyInfo();
  if (instanceKey.configured) return { source: 'instance', apiKeyName: instanceKey.apiKeyName, personalKeysAllowed };
  if (process.env.CURSOR_API_KEY?.trim()) return { source: 'environment', apiKeyName: null, personalKeysAllowed };
  return { source: 'none', apiKeyName: null, personalKeysAllowed };
}

/** Decrypted key for a run / a model list / a check. `space` is the already-authorized space the user is working in, or null. */
export async function resolveApiKey(
  userId: string,
  space: string | null,
): Promise<{ apiKey: string; source: AssistantKeySource; apiKeyName: string | null } | null> {
  const picked = await resolveKeySource(userId, space);
  let apiKey: string | null = null;
  switch (picked.source) {
    case 'personal':
      apiKey = await assistantStore.getDecryptedCursorKey(userId);
      break;
    case 'space':
      apiKey = (await sharedKeys.getDecryptedSpaceKey(space!))?.apiKey ?? null;
      break;
    case 'instance':
      apiKey = (await sharedKeys.getDecryptedInstanceKey())?.apiKey ?? null;
      break;
    case 'environment':
      apiKey = process.env.CURSOR_API_KEY?.trim() || null;
      break;
    case 'none':
      break;
  }
  return apiKey ? { apiKey, source: picked.source, apiKeyName: picked.apiKeyName } : null;
}

async function buildSettingsResponse(userId: string, space: string | null): Promise<AssistantSettings> {
  const settings = await assistantStore.getSettings(userId);
  const picked = await resolveKeySource(userId, space, settings);
  return {
    provider: 'CURSOR',
    model: settings.modelId,
    apiKeyConfigured: picked.source !== 'none',
    apiKeySource: picked.source,
    apiKeyName: picked.apiKeyName,
    personalKeysAllowed: picked.personalKeysAllowed,
    encryptionAvailable: hasSecretConfigured(),
    runtimeAvailable: cursorRuntimeAvailable(),
  };
}

function serializeMessage(row: AssistantMessageRow): AssistantMessage {
  return { id: row.id, role: row.role, content: row.content, createdAt: row.createdAt.toISOString() };
}

/** Shared by POST /runs, POST /chat/stream: finds/creates the conversation a message belongs to (same resolution order as before this round's split: explicit id > startNew > latest). */
async function resolveConversationForMessage(userId: string, input: SendAssistantMessageBody): Promise<AssistantConversationRow> {
  let conversation = input.startNew
    ? null
    : input.conversationId
      ? await assistantStore.findConversation(input.conversationId, userId)
      : await assistantStore.findLatestConversation(userId);
  if (input.conversationId && !conversation) throw notFound('assistant conversation');
  if (!conversation) {
    const model = await assistantStore.getModel(userId);
    conversation = await assistantStore.insertConversation({
      userId,
      title: (input.displayMessage ?? input.message).slice(0, 80),
      cursorAgentId: `agent-${randomUUID()}`,
      model,
    });
  }
  return conversation;
}

/**
 * The ONE start-a-run path behind POST /runs and the compatibility POST
 * /chat/stream (they used to repeat this block, which is how a check could
 * land in one and not the other). The `space` and `pageId` in the body are
 * client claims about where the user is, and the assistant loads data keyed by
 * them (the space's `.agent` rules, the open page) — so they are authorized
 * first, before any conversation is found or created and before the key is
 * resolved: a space the caller cannot read is a 404 `space not found`, the same
 * answer as for a slug that does not exist (security review F-05). A
 * `conversationId` does not bypass it: the conversation is the caller's own
 * but is not bound to a space, so every message is checked on its own.
 */
async function startRunForRequest(request: FastifyRequest): Promise<{ runId: string; conversationId: string }> {
  const user = request.authUser!;
  if (!cursorRuntimeAvailable()) throw new HttpError(503, 'Cursor SDK requires Node.js 22.13 or newer');
  const input = parseBody(sendAssistantMessageBodySchema, request.body);
  const navigation = await authorizeAssistantNavigation(user, input);
  const conversation = await resolveConversationForMessage(user.id, input);
  const resolved = await resolveApiKey(user.id, navigation.space);
  if (!resolved) throw conflict(NO_KEY_MESSAGE);

  return runs.startRun({
    user,
    conversation,
    message: input.message,
    displayMessage: input.displayMessage,
    runMode: input.runMode,
    currentPath: input.currentPath ?? null,
    space: navigation.space,
    pageId: navigation.pageId,
    apiKey: resolved.apiKey,
  });
}

/**
 * GET .../runs/:runId/events — the NDJSON subscription to a run, shared by the
 * signed-in route and the public-site route (publicRoutes.ts), which differ
 * only in WHO may read a run: `mayRead` gets the run's owner and conversation
 * and is asked BEFORE anything is written; false (or an unknown run) is a 404
 * `assistant run not found`, never a hijacked half-open stream.
 *
 * Live run: replay of the buffer with seq > since, then live events until the
 * terminal one. A run no longer in memory (evicted after RETAIN_MS, or lost
 * across a restart): its terminal state from ai_runs, once.
 */
export async function streamRunEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  runId: string,
  since: number,
  mayRead: (run: { userId: string; conversationId: string }) => boolean | Promise<boolean>,
): Promise<void> {
  const peeked = runs.peek(runId);
  if (peeked) {
    if (!(await mayRead(peeked))) throw notFound('assistant run');
    reply.hijack();
    reply.raw.writeHead(200, ndjsonHeaders);
    let closed = false;
    // Declared before `send` and reassigned right after — runs.subscribe()
    // below calls `send` SYNCHRONOUSLY while replaying buffered events, and
    // if the replay's last event is already terminal, `send` needs to call
    // `unsubscribe()` from inside that very call. A `const unsubscribe =
    // runs.subscribe(...)` one-liner puts `unsubscribe` in the temporal
    // dead zone for exactly that synchronous replay call — `send` throwing
    // a ReferenceError there left the hijacked response hanging forever
    // (caught live in this round's own smoke test: a replay-only
    // reconnect stalled for the full curl --max-time instead of closing).
    let unsubscribe: (() => void) | null = null;
    const send = (event: AssistantRunEvent): void => {
      if (closed || reply.raw.writableEnded || reply.raw.destroyed) return;
      reply.raw.write(`${JSON.stringify(event)}\n`);
      if (event.type === 'complete' || event.type === 'stopped' || event.type === 'error') {
        closed = true;
        unsubscribe?.();
        reply.raw.end();
      }
    };
    const subscribed = runs.subscribe(runId, since, send);
    if (!subscribed) {
      // Evicted between peek() and here (mayRead may have awaited): answer from the database instead of hanging open.
      const historical = await runs.loadTerminalFromDb(runId);
      if (historical && historical.event.type !== 'ping' && historical.event.seq > since) send(historical.event);
      if (!closed && !reply.raw.writableEnded) reply.raw.end();
      return;
    }
    unsubscribe = subscribed;
    // Only unsubscribe on a dropped connection — never abort the run itself.
    request.raw.on('close', () => {
      if (!closed) {
        closed = true;
        unsubscribe?.();
      }
    });
    return;
  }

  // Not in memory: either it finished long enough ago to be evicted, or it
  // was lost across a restart (runs.recoverAfterRestart turned it into
  // 'error') — either way ai_runs still has its terminal state.
  const historical = await runs.loadTerminalFromDb(runId);
  if (!historical || !(await mayRead(historical))) throw notFound('assistant run');
  reply.hijack();
  reply.raw.writeHead(200, ndjsonHeaders);
  if (historical.event.type !== 'ping' && historical.event.seq > since) {
    reply.raw.write(`${JSON.stringify(historical.event)}\n`);
  }
  reply.raw.end();
}

/**
 * Gate of the space-key routes: 404 `space not found` for a slug that does not
 * exist, 403 unless the caller administers the space (an instance admin or an
 * explicit `admin` member — session.canAdministerSpace, the same rule as the
 * rest of the space administration). The key is operational data in
 * PostgreSQL, so a plain member never reads even its name.
 */
async function requireSpaceKeyAdmin(request: FastifyRequest, space: string): Promise<User> {
  const user = request.authUser!;
  if (!(await storage.spaceExists(space))) throw notFound('space');
  if (!(await session.canAdministerSpace(user, space))) throw forbidden('requires space admin');
  return user;
}

export function registerAssistantRoutes(app: FastifyInstance): void {
  app.get('/api/assistant/settings', async (request) => {
    session.requireCookieAuth(request);
    const user = request.authUser!;
    return buildSettingsResponse(user.id, await authorizedKeySpace(request, user));
  });

  app.get('/api/assistant/models', async (request) => {
    session.requireCookieAuth(request);
    const user = request.authUser!;
    const space = await authorizedKeySpace(request, user);
    const [resolved, current] = await Promise.all([resolveApiKey(user.id, space), assistantStore.getModel(user.id)]);
    let items: AssistantModelsResponse['items'] = [{ id: 'auto', label: 'Auto', description: null }];
    let error: string | null = null;
    if (resolved && cursorRuntimeAvailable()) {
      try {
        items = await listCursorModels(resolved.apiKey);
      } catch (err) {
        // The settings screen must stay usable even if Cursor's catalog is down —
        // but the reason has to be visible (it was silently swallowed before).
        error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        request.log.warn({ err }, 'assistant: Cursor model catalog failed');
      }
    } else if (!resolved) {
      error = 'no Cursor API key';
    }
    if (!items.some((item) => item.id === current)) items.push({ id: current, label: current, description: null });
    return { items, error } satisfies AssistantModelsResponse;
  });

  app.put('/api/assistant/settings/model', async (request) => {
    session.requireCookieAuth(request);
    const user = request.authUser!;
    const body = parseBody(updateAssistantModelBodySchema, request.body);
    const space = await authorizedKeySpace(request, user);
    if (body.model !== 'auto') {
      const resolved = await resolveApiKey(user.id, space);
      if (!resolved) throw conflict(NO_KEY_MESSAGE);
      if (!cursorRuntimeAvailable()) throw new HttpError(503, 'Cursor SDK requires Node.js 22.13 or newer');
      const models = await listCursorModels(resolved.apiKey);
      if (!models.some((item) => item.id === body.model)) throw badRequest('Cursor model is not available');
    }
    await assistantStore.saveModel(user.id, body.model);
    return buildSettingsResponse(user.id, space);
  });

  app.post('/api/assistant/settings/check', async (request) => {
    session.requireCookieAuth(request);
    const user = request.authUser!;
    const supplied = (request.body as { apiKey?: string } | undefined)?.apiKey?.trim();
    const apiKey = supplied || (await resolveApiKey(user.id, await authorizedKeySpace(request, user)))?.apiKey;
    if (!apiKey || !cursorRuntimeAvailable()) return { ok: false, apiKeyName: null } satisfies AssistantConnectionCheck;
    try {
      const identity = await verifyCursorApiKey(apiKey);
      return { ok: true, apiKeyName: identity.apiKeyName } satisfies AssistantConnectionCheck;
    } catch {
      return { ok: false, apiKeyName: null } satisfies AssistantConnectionCheck;
    }
  });

  app.put('/api/assistant/settings/key', async (request) => {
    assertNotDemo('Connecting an AI key');
    session.requireCookieAuth(request);
    const user = request.authUser!;
    // The instance policy: an admin who switched personal keys off means the shared key is the only one in use, so a new personal key could never be used.
    if (!(await sharedKeys.getPersonalKeysAllowed())) throw forbidden('Personal AI keys are disabled on this instance');
    if (!hasSecretConfigured()) throw conflict('FOLIO_SECRET is not configured on this server — Cursor API keys cannot be stored securely.');
    if (!cursorRuntimeAvailable()) throw new HttpError(503, 'Cursor SDK requires Node.js 22.13 or newer');
    const body = parseBody(saveAssistantKeyBodySchema, request.body);
    let identity: Awaited<ReturnType<typeof verifyCursorApiKey>>;
    try {
      identity = await verifyCursorApiKey(body.apiKey);
    } catch {
      throw badRequest('Cursor API key was not accepted');
    }
    await assistantStore.saveCursorKey(user.id, body.apiKey, identity.apiKeyName, identity.email);
    recordAudit(user.id, 'user.cursor_connected', user.id, { source: 'assistant' });
    return { ok: true, apiKeyName: identity.apiKeyName } satisfies AssistantConnectionCheck;
  });

  app.delete('/api/assistant/settings/key', async (request, reply) => {
    session.requireCookieAuth(request);
    const user = request.authUser!;
    await assistantStore.deleteCursorKey(user.id);
    recordAudit(user.id, 'user.cursor_disconnected', user.id, { source: 'assistant' });
    reply.status(204);
    return null;
  });

  // --- Space-wide shared key (/api/spaces/:space/assistant-key) -------------
  // One Cursor key for a whole space: set by a space admin (or an instance
  // admin), used by every member's runs in that space unless they have their
  // own key (and the instance policy allows it). Never returned, only the name.

  app.get('/api/spaces/:space/assistant-key', async (request) => {
    session.requireCookieAuth(request);
    const { space } = request.params as { space: string };
    await requireSpaceKeyAdmin(request, space);
    return sharedKeys.buildSpaceKeyInfo(space);
  });

  app.put('/api/spaces/:space/assistant-key', async (request) => {
    assertNotDemo('Connecting an AI key');
    session.requireCookieAuth(request);
    const { space } = request.params as { space: string };
    const user = await requireSpaceKeyAdmin(request, space);
    const verified = await sharedKeys.verifySharedKeyBody(request.body);
    await sharedKeys.saveSpaceKey(space, verified.apiKey, verified.apiKeyName, verified.email, user.id);
    recordAudit(user.id, 'assistant.space_key_set', space, { keyName: verified.apiKeyName });
    return sharedKeys.buildSpaceKeyInfo(space);
  });

  app.delete('/api/spaces/:space/assistant-key', async (request, reply) => {
    session.requireCookieAuth(request);
    const { space } = request.params as { space: string };
    const user = await requireSpaceKeyAdmin(request, space);
    await sharedKeys.deleteSpaceKey(space);
    recordAudit(user.id, 'assistant.space_key_removed', space);
    reply.status(204);
    return null;
  });

  app.get('/api/assistant/chat', async (request) => {
    session.requireCookieAuth(request);
    const user = request.authUser!;
    const conversationId = queryString(request.query, 'conversationId') || undefined;
    const conversation = conversationId
      ? await assistantStore.findConversation(conversationId, user.id)
      : await assistantStore.findLatestConversation(user.id);
    if (conversationId && !conversation) throw notFound('assistant conversation');
    const messages = conversation ? await assistantStore.listMessages(conversation.id) : [];
    const ratings = await analytics.listFeedback(
      messages.filter((m) => m.role === 'assistant').map((m) => m.id),
      user.id,
    );
    const surveyDue = conversation ? await analytics.computeSurveyDue(conversation.id) : null;
    return {
      conversationId: conversation?.id ?? null,
      title: conversation?.title ?? null,
      model: conversation?.model ?? null,
      messages: messages.map((m) => (m.role === 'assistant' ? { ...serializeMessage(m), feedback: ratings.get(m.id) ?? null } : serializeMessage(m))),
      surveyDue,
      activeRun: conversation ? runs.getActiveRunForConversation(conversation.id) : null,
    } satisfies AssistantConversation;
  });

  app.put('/api/assistant/messages/:messageId/feedback', async (request) => {
    session.requireCookieAuth(request);
    const user = request.authUser!;
    const { messageId } = request.params as { messageId: string };
    const body = parseBody(assistantFeedbackBodySchema, request.body);
    // A malformed id can never match a message; answering 404 avoids a uuid cast error.
    if (!UUID_RE.test(messageId) || !(await analytics.findOwnedAssistantMessage(messageId, user.id))) throw notFound('assistant message');
    await analytics.setFeedback(messageId, user.id, body.rating);
    return { messageId, rating: body.rating } satisfies AssistantFeedbackResponse;
  });

  app.post('/api/assistant/conversations/:conversationId/survey', async (request, reply) => {
    session.requireCookieAuth(request);
    const user = request.authUser!;
    const { conversationId } = request.params as { conversationId: string };
    const body = parseBody(assistantSurveyBodySchema, request.body);
    const conversation = UUID_RE.test(conversationId) ? await assistantStore.findConversation(conversationId, user.id) : null;
    if (!conversation) throw notFound('assistant conversation');
    if (!(await analytics.isAssistantMessageOf(body.afterMessageId, conversation.id))) {
      throw badRequest('afterMessageId must be an assistant message of this conversation');
    }
    await analytics.upsertSurvey({
      conversationId: conversation.id,
      userId: user.id,
      afterMessageId: body.afterMessageId,
      answer: body.answer,
      comment: body.comment?.trim() || null,
    });
    reply.status(201);
    return { ok: true };
  });

  app.get('/api/assistant/conversations', async (request) => {
    session.requireCookieAuth(request);
    const user = request.authUser!;
    const items = (await assistantStore.listConversations(user.id)).map((conversation) => ({
      conversationId: conversation.id,
      title: conversation.title,
      model: conversation.model,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      activeRunId: runs.getActiveRunForConversation(conversation.id)?.runId ?? null,
    }));
    return { items } satisfies AssistantConversationsResponse;
  });

  // --- Continuous runs (05.09.2026) ----------------------------------------

  app.post('/api/assistant/runs', async (request, reply) => {
    assertNotDemo('The AI assistant');
    session.requireCookieAuth(request);
    const { runId, conversationId } = await startRunForRequest(request);
    reply.status(202);
    return { conversationId, runId } satisfies StartAssistantRunResponse;
  });

  app.get('/api/assistant/runs/:runId/events', async (request, reply) => {
    session.requireCookieAuth(request);
    const user = request.authUser!;
    const { runId } = request.params as { runId: string };
    const since = Number(queryString(request.query, 'since')) || 0;
    await streamRunEvents(request, reply, runId, since, (run) => run.userId === user.id);
  });

  app.get('/api/assistant/runs/active', async (request) => {
    session.requireCookieAuth(request);
    return { run: runs.getActiveRunForUser(request.authUser!.id) } satisfies ActiveAssistantRunResponse;
  });

  app.post('/api/assistant/runs/:runId/stop', async (request, reply) => {
    session.requireCookieAuth(request);
    const { runId } = request.params as { runId: string };
    const stopped = await runs.stop(runId, request.authUser!.id);
    if (!stopped) throw notFound('active assistant run');
    reply.status(202);
    return { stopped: true };
  });

  // --- Backward-compatible wrapper: same request, same response shape -----

  app.post('/api/assistant/chat/stream', async (request, reply) => {
    assertNotDemo('The AI assistant');
    session.requireCookieAuth(request);
    // Everything that can refuse (space/page access, key, runtime) happens in
    // here, BEFORE the response is hijacked below — a refusal is a plain JSON
    // error status, never a half-open NDJSON stream.
    const { runId, conversationId } = await startRunForRequest(request);

    reply.hijack();
    reply.raw.writeHead(200, ndjsonHeaders);
    const write = (event: AssistantStreamEvent): void => {
      if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(`${JSON.stringify(event)}\n`);
    };
    write({ type: 'conversation', conversationId });

    let closed = false;
    // See the /runs/:runId/events handler's own comment above: `unsubscribe`
    // must exist (even if not yet assigned) before `onEvent` can be called,
    // because runs.subscribe() below invokes it synchronously while
    // replaying — here that replay always includes at least the just-emitted
    // 'starting' status, and could include the terminal event too if the run
    // (mocked or genuinely instant) already finished by the time this
    // subscribes.
    let unsubscribe: (() => void) | null = null;
    const onEvent = (event: AssistantRunEvent): void => {
      if (closed || event.type === 'ping') return;
      const { seq: _seq, ...rest } = event;
      write(rest as AssistantStreamEvent);
      if (event.type === 'complete' || event.type === 'stopped' || event.type === 'error') {
        closed = true;
        unsubscribe?.();
        reply.raw.end();
      }
    };
    unsubscribe = runs.subscribe(runId, 0, onEvent) ?? (() => {});
    // Historically this route aborted the run when the request closed — that
    // was exactly the bug this round fixes (F5/navigation/idle-proxy killing
    // a run mid-thought). Now: only unsubscribe. The run keeps going; a
    // client can pick it back up via GET /runs/:runId/events?since=.
    request.raw.on('close', () => {
      if (!closed) {
        closed = true;
        unsubscribe?.();
      }
    });
  });

  app.post('/api/assistant/chat/:conversationId/stop', async (request, reply) => {
    session.requireCookieAuth(request);
    const { conversationId } = request.params as { conversationId: string };
    const active = runs.getActiveRunForConversation(conversationId);
    if (!active) throw notFound('active assistant run');
    const stopped = await runs.stop(active.runId, request.authUser!.id);
    if (!stopped) throw notFound('active assistant run');
    reply.status(202);
    return { stopped: true };
  });
}
