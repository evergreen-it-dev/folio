/**
 * Warm-up on panel open (warm.ts, warmSlots.ts, cursorRuntime.ts). Real PostgreSQL (per-file schema), real routes
 * through Fastify inject; only the Cursor SDK is mocked. Every agent the mock hands out is recorded, so "a warm run
 * makes no second resume/create" and "warm never sends" are plain assertions.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { User } from '../../shared/contracts.js';

// --- Mocks (hoisted above the imports below) ---------------------------------

const sdkMock = vi.hoisted(() => {
  const run = {
    supports: () => false,
    wait: async () => {
      const next = sdkMock.nextResult;
      sdkMock.nextResult = null;
      return next ?? { status: 'finished', result: 'Stub reply' };
    },
    cancel: async () => {},
  };
  const agents: Array<{ reload: () => Promise<void>; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
  const makeAgent = () => {
    const agent = { reload: async () => {}, send: vi.fn(async () => run), close: vi.fn(async () => {}) };
    agents.push(agent);
    return agent;
  };
  return {
    modelsListKeys: [] as string[],
    meKeys: [] as string[],
    agentKeys: [] as string[],
    nextResult: null as null | Record<string, unknown>,
    agents,
    me: vi.fn(async (options: { apiKey: string }) => {
      sdkMock.meKeys.push(options.apiKey);
      if (!options.apiKey.startsWith('good-')) throw new Error('invalid api key');
      // The name must not contain the key itself, or "the response never contains the key" could not be asserted.
      return { apiKeyName: `name-of-${options.apiKey.slice('good-'.length)}`, userEmail: 'owner@cursor.test' };
    }),
    modelsList: vi.fn(async (options: { apiKey: string }) => {
      sdkMock.modelsListKeys.push(options.apiKey);
      return [{ id: 'auto', displayName: 'Auto', description: null }];
    }),
    resume: vi.fn(async (_id: string, options: { apiKey: string }) => {
      sdkMock.agentKeys.push(options.apiKey);
      return makeAgent();
    }),
    create: vi.fn(async (options: { apiKey: string }) => {
      sdkMock.agentKeys.push(options.apiKey);
      return makeAgent();
    }),
    configure: vi.fn(),
  };
});

vi.mock('@cursor/sdk', () => ({
  Cursor: { configure: sdkMock.configure, me: sdkMock.me, models: { list: sdkMock.modelsList } },
  JsonlLocalAgentStore: class {},
  Agent: { resume: sdkMock.resume, create: sdkMock.create },
}));

// Writes ~/.cursor/cli-config.json — must never run from a test.
vi.mock('./cursorCliConfig.js', () => ({ ensureAssistantCursorPermissions: vi.fn() }));

// cursorRuntime.ts gates on Node >= 22.13 (what the real SDK needs). The SDK is mocked here, so on an older
// Node the version is faked for the duration of this file.
const realNodeVersions = process.versions;
{
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    Object.defineProperty(process, 'versions', { value: { ...process.versions, node: '22.13.0' }, configurable: true });
  }
}

const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-warm-ws-'));
const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-warm-state-'));
process.env.CURSOR_AGENT_WORKSPACE_ROOT = workspaceRoot;
process.env.CURSOR_AGENT_STATE_DIR = stateDir;
// Keys are encrypted for real; no operator key until a test sets one. Load .env first so it cannot add either back later.
const { loadEnv } = await import('../env.js');
loadEnv();
const realFolioSecret = process.env.FOLIO_SECRET;
const realCursorKey = process.env.CURSOR_API_KEY;
process.env.FOLIO_SECRET = 'warm-test-secret';
delete process.env.CURSOR_API_KEY;

const { setUpTestSchema, deleteTestSpace } = await import('../db/testSchema.js');
const { query } = await import('../db/pool.js');
const authStore = await import('../auth/store.js');
const storage = await import('../storage.js');
const session = await import('../auth/session.js');
const { HttpError } = await import('../errors.js');
const assistantStore = await import('./store.js');
const warm = await import('./warm.js');
const warmSlots = await import('./warmSlots.js');
const cursorRuntime = await import('./cursorRuntime.js');
const runTiming = await import('./runTiming.js');
const { registerAssistantRoutes } = await import('./routes.js');

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  await app.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', session.requireSession);
    registerAssistantRoutes(protectedScope);
  });
  await app.ready();
  return app;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('assistant warm-up (real PG, fastify inject, mocked Cursor SDK)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let alice: User;
  let bob: User;
  let aliceCookie: string;
  let bobCookie: string;
  const stamp = Date.now();

  const cookieFor = async (user: User): Promise<string> => `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(user.id)).token}`;
  const warmReq = (cookie: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/assistant/warm', headers: { cookie }, payload });
  const newConversation = (user: User, model = 'auto') =>
    assistantStore.insertConversation({ userId: user.id, title: 'Warm test', cursorAgentId: `agent-${Math.random()}`, model });
  const resets = () => {
    sdkMock.resume.mockClear();
    sdkMock.create.mockClear();
    sdkMock.agents.length = 0;
    sdkMock.nextResult = null;
    warm.resetWarmRateLimit();
  };
  const runInput = (user: User, conversation: Awaited<ReturnType<typeof newConversation>>, extra: Record<string, unknown> = {}) => ({
    runId: `run-${Math.random()}`,
    apiKey: 'env-key',
    user,
    conversation,
    message: 'hi',
    currentPath: null,
    space: null,
    pageId: null,
    runMode: 'ask' as const,
    ...extra,
  });
  const agentCalls = () => sdkMock.resume.mock.calls.length + sdkMock.create.mock.calls.length;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const mk = (name: string) => authStore.createUser({ email: `warm-${name}-${stamp}@test.local`, name: `User ${name}`, passwordHash: 'x', isAdmin: false });
    [alice, bob] = await Promise.all([mk('alice'), mk('bob')]);
    [aliceCookie, bobCookie] = await Promise.all([cookieFor(alice), cookieFor(bob)]);
    process.env.CURSOR_API_KEY = 'env-key';
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    await warmSlots.closeAllWarmSlots();
    await teardownSchema();
    const restore = (name: string, value: string | undefined) => (value === undefined ? delete process.env[name] : (process.env[name] = value));
    restore('FOLIO_SECRET', realFolioSecret);
    restore('CURSOR_API_KEY', realCursorKey);
    Object.defineProperty(process, 'versions', { value: realNodeVersions, configurable: true });
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  afterEach(async () => {
    delete process.env.ASSISTANT_WARM;
    await warmSlots.closeAllWarmSlots();
  });

  it('warm then run: no second resume/create, timing warm=hit, and warm itself never sends', async () => {
    resets();
    const conversation = await newConversation(alice);
    const res = await warmReq(aliceCookie, { conversationId: conversation.id, runMode: 'ask' });
    expect(res.statusCode).toBe(202);
    await waitUntil(() => agentCalls() === 1);
    await waitUntil(() => warmSlots.warmSlotCount() === 1);
    expect(sdkMock.agents[0]!.send).not.toHaveBeenCalled();

    const seen: string[] = [];
    const reply = await cursorRuntime.runCursorAssistant(runInput(alice, conversation, { onWarm: (w: string) => seen.push(w) }));
    expect(reply).toBe('Stub reply');
    expect(agentCalls()).toBe(1);
    expect(seen).toEqual(['hit']);
    expect(sdkMock.agents).toHaveLength(1);
    expect(sdkMock.agents[0]!.send).toHaveBeenCalledTimes(1);
    // the finished run parked the agent for the next message instead of closing it
    expect(sdkMock.agents[0]!.close).not.toHaveBeenCalled();
    expect(warmSlots.warmSlotCount()).toBe(1);
  });

  it('timing snapshot carries warm', async () => {
    const timing = runTiming.createRunTiming();
    expect(timing.snapshot().warm).toBe('off');
    timing.setWarm('hit');
    expect(timing.snapshot().warm).toBe('hit');
  });

  it('a cold run reports miss', async () => {
    resets();
    const conversation = await newConversation(alice);
    const seen: string[] = [];
    await cursorRuntime.runCursorAssistant(runInput(alice, conversation, { onWarm: (w: string) => seen.push(w) }));
    expect(seen).toEqual(['miss']);
    expect(agentCalls()).toBe(1);
  });

  it('fingerprint mismatch: the warm agent is closed unused and the run goes cold', async () => {
    resets();
    const conversation = await newConversation(alice);
    cursorRuntime.warmCursorConversation({ ...runInput(alice, conversation), apiKey: 'other-key' });
    await waitUntil(() => agentCalls() === 1);
    await waitUntil(() => warmSlots.warmSlotCount() === 1);
    const seen: string[] = [];
    await cursorRuntime.runCursorAssistant(runInput(alice, conversation, { onWarm: (w: string) => seen.push(w) }));
    expect(seen).toEqual(['miss']);
    expect(agentCalls()).toBe(2);
    expect(sdkMock.agents[0]!.close).toHaveBeenCalledTimes(1);
    expect(sdkMock.agents[0]!.send).not.toHaveBeenCalled();
    expect(sdkMock.agents[1]!.send).toHaveBeenCalledTimes(1);
  });

  it('two parallel runs: only one takes the warm slot', async () => {
    resets();
    const conversation = await newConversation(alice);
    cursorRuntime.warmCursorConversation(runInput(alice, conversation));
    await waitUntil(() => warmSlots.warmSlotCount() === 1);
    const seen: string[] = [];
    const onWarm = (w: string) => seen.push(w);
    await Promise.all([
      cursorRuntime.runCursorAssistant(runInput(alice, conversation, { onWarm })),
      cursorRuntime.runCursorAssistant(runInput(alice, conversation, { onWarm })),
    ]);
    expect(seen.sort()).toEqual(['hit', 'miss']);
    expect(agentCalls()).toBe(2); // the warm one plus one cold
  });

  it('ASSISTANT_WARM=0 is a no-op, and a run reports off', async () => {
    resets();
    process.env.ASSISTANT_WARM = '0';
    const conversation = await newConversation(alice);
    const res = await warmReq(aliceCookie, { conversationId: conversation.id });
    expect(res.statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 100));
    expect(agentCalls()).toBe(0);
    expect(warmSlots.warmSlotCount()).toBe(0);
    const seen: string[] = [];
    await cursorRuntime.runCursorAssistant(runInput(alice, conversation, { onWarm: (w: string) => seen.push(w) }));
    expect(seen).toEqual(['off']);
  });

  it("the endpoint rejects another user's conversation and prepares nothing", async () => {
    resets();
    const conversation = await newConversation(alice);
    const res = await warmReq(bobCookie, { conversationId: conversation.id });
    expect(res.statusCode).toBe(404);
    await new Promise((r) => setTimeout(r, 50));
    expect(agentCalls()).toBe(0);
    expect(warmSlots.warmSlotCount()).toBe(0);
  });

  it('the endpoint is idempotent and rate limited: a repeat does not prepare a second agent', async () => {
    resets();
    const conversation = await newConversation(alice);
    expect((await warmReq(aliceCookie, { conversationId: conversation.id })).statusCode).toBe(202);
    await waitUntil(() => agentCalls() === 1);
    expect((await warmReq(aliceCookie, { conversationId: conversation.id })).statusCode).toBe(202);
    warm.resetWarmRateLimit(); // past the rate limit the equal slot still makes it a no-op
    expect((await warmReq(aliceCookie, { conversationId: conversation.id })).statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 100));
    expect(agentCalls()).toBe(1);
  });

  it('without a conversation only the modules are warmed (no agent)', async () => {
    resets();
    expect((await warmReq(aliceCookie, {})).statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 100));
    expect(agentCalls()).toBe(0);
  });

  it('a warm slot expires by TTL and its agent is closed', async () => {
    resets();
    process.env.ASSISTANT_WARM_TTL_MS = '150';
    try {
      const conversation = await newConversation(alice);
      cursorRuntime.warmCursorConversation(runInput(alice, conversation));
      await waitUntil(() => sdkMock.agents.length === 1);
      await waitUntil(() => sdkMock.agents[0]!.close.mock.calls.length === 1);
      expect(warmSlots.warmSlotCount()).toBe(0);
    } finally {
      delete process.env.ASSISTANT_WARM_TTL_MS;
    }
  });

  it('a finished run parks its agent: the next run reuses it (no second resume/create, hit) even after the title changed', async () => {
    resets();
    const conversation = await newConversation(alice);
    await cursorRuntime.runCursorAssistant(runInput(alice, conversation));
    expect(agentCalls()).toBe(1);
    expect(sdkMock.agents[0]!.close).not.toHaveBeenCalled();
    expect(warmSlots.warmSlotCount()).toBe(1);
    const seen: string[] = [];
    await cursorRuntime.runCursorAssistant(runInput(alice, { ...conversation, title: 'Renamed after first message' }, { onWarm: (w: string) => seen.push(w) }));
    expect(seen).toEqual(['hit']);
    expect(agentCalls()).toBe(1);
    expect(sdkMock.agents[0]!.send).toHaveBeenCalledTimes(2);
  });

  it('a cancelled or failed run does not park', async () => {
    resets();
    const conversation = await newConversation(alice);
    sdkMock.nextResult = { status: 'cancelled' };
    await expect(cursorRuntime.runCursorAssistant(runInput(alice, conversation))).rejects.toThrow();
    expect(sdkMock.agents[0]!.close).toHaveBeenCalledTimes(1);
    expect(warmSlots.warmSlotCount()).toBe(0);
    sdkMock.nextResult = { status: 'error', error: { message: 'boom' } };
    await expect(cursorRuntime.runCursorAssistant(runInput(alice, conversation))).rejects.toThrow('boom');
    expect(sdkMock.agents[1]!.close).toHaveBeenCalledTimes(1);
    expect(warmSlots.warmSlotCount()).toBe(0);
  });

  it('ASSISTANT_WARM=0 does not park', async () => {
    resets();
    process.env.ASSISTANT_WARM = '0';
    const conversation = await newConversation(alice);
    await cursorRuntime.runCursorAssistant(runInput(alice, conversation));
    expect(sdkMock.agents[0]!.close).toHaveBeenCalledTimes(1);
    expect(warmSlots.warmSlotCount()).toBe(0);
  });

  it('a parked agent is closed by the TTL', async () => {
    resets();
    process.env.ASSISTANT_WARM_TTL_MS = '150';
    try {
      const conversation = await newConversation(alice);
      await cursorRuntime.runCursorAssistant(runInput(alice, conversation));
      expect(warmSlots.warmSlotCount()).toBe(1);
      await waitUntil(() => sdkMock.agents[0]!.close.mock.calls.length === 1);
      expect(warmSlots.warmSlotCount()).toBe(0);
    } finally {
      delete process.env.ASSISTANT_WARM_TTL_MS;
    }
  });
});
