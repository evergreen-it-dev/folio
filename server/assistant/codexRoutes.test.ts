/**
 * The Codex login routes and the write-back rule, on real PostgreSQL (per-file schema), the real routes via
 * Fastify inject and the real encryption. The CLI side (codexLogin.ts) is mocked: its own behaviour is
 * tested in codexLogin.test.ts.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantCodexLoginState, AssistantSettings, User } from '../../shared/contracts.js';

const loginMock = vi.hoisted(() => ({
  start: vi.fn(),
  cancel: vi.fn(),
  check: vi.fn(),
}));

vi.mock('./codexLogin.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./codexLogin.js')>();
  return {
    ...original,
    startCodexLogin: loginMock.start,
    cancelCodexLogin: loginMock.cancel,
    getCodexLoginState: () => ({ status: 'idle' }),
    checkCodexLogin: loginMock.check,
  };
});

const { loadEnv } = await import('../env.js');
loadEnv();
process.env.FOLIO_CODEX_ENABLED = '1';
process.env.FOLIO_MINIMAX_ENABLED = '1';
const realFolioSecret = process.env.FOLIO_SECRET;
process.env.FOLIO_SECRET = 'codex-routes-test-secret';

const { setUpTestSchema } = await import('../db/testSchema.js');
const { query } = await import('../db/pool.js');
const authStore = await import('../auth/store.js');
const session = await import('../auth/session.js');
const { HttpError } = await import('../errors.js');
const sharedKeys = await import('./sharedKeys.js');
const { registerAssistantRoutes } = await import('./routes.js');
const { codexAuthStore } = await import('./codexStore.js');

const AUTH_JSON = JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: 'a.b.c', access_token: 'access-token-plain', refresh_token: 'refresh-token-plain' } });

describe('Codex login routes (real PG, fastify inject)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let owner: User;
  let cookie: string;
  const login = '/api/assistant/settings/providers/codex/login';
  const req = (method: 'GET' | 'PUT' | 'DELETE' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  const audit = (action: string) => query<{ actor_id: string; meta: Record<string, unknown> | null }>('SELECT actor_id, meta FROM audit_log WHERE action = $1', [action]);

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    owner = await authStore.createUser({ email: `codex-${Date.now()}@test.local`, name: 'Codex Owner', passwordHash: 'x', isAdmin: true });
    cookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(owner.id)).token}`;
    app = Fastify();
    app.decorateRequest('authUser', null);
    app.setErrorHandler((err, _request, reply) => {
      if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
      return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
    });
    await app.register(fastifyCookieModule.default);
    await app.register(async (scope) => {
      scope.addHook('onRequest', session.requireSession);
      registerAssistantRoutes(scope);
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await teardownSchema();
    if (realFolioSecret === undefined) delete process.env.FOLIO_SECRET;
    else process.env.FOLIO_SECRET = realFolioSecret;
  });

  beforeEach(() => {
    loginMock.start.mockReset();
    loginMock.cancel.mockReset();
    loginMock.check.mockReset();
  });

  it('refuses without FOLIO_SECRET (409) and when personal sign-ins are off (403), and starts nothing', async () => {
    delete process.env.FOLIO_SECRET;
    try {
      expect((await req('POST', login)).statusCode).toBe(409);
    } finally {
      process.env.FOLIO_SECRET = 'codex-routes-test-secret';
    }
    await sharedKeys.setPersonalKeysAllowed(false, owner.id);
    try {
      expect((await req('POST', login)).statusCode).toBe(403);
    } finally {
      await sharedKeys.setPersonalKeysAllowed(true, owner.id);
    }
    expect(loginMock.start).not.toHaveBeenCalled();
  });

  it('is cookie-only: an API token gets no sign-in', async () => {
    const response = await app.inject({ method: 'POST', url: login });
    expect(response.statusCode).toBe(401);
  });

  it('starts a login, and a finished one is stored encrypted, audited and shown as connected', async () => {
    const pending: AssistantCodexLoginState = { status: 'pending', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'AB12-CD345', expiresAt: new Date(Date.now() + 900_000).toISOString() };
    loginMock.start.mockImplementation(async (userId: string, deps: { save: (json: string, email: string | null) => Promise<void>; onConnected: () => void }) => {
      expect(userId).toBe(owner.id);
      await deps.save(AUTH_JSON, 'me@example.com');
      deps.onConnected();
      return pending;
    });
    const response = await req('POST', login);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(pending);

    const rows = await query<{ secret_enc: Buffer; label: string | null }>(`SELECT secret_enc, label FROM assistant_provider_credentials WHERE provider = 'codex' AND user_id = $1`, [owner.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe('me@example.com');
    expect(rows[0]!.secret_enc.toString('utf8')).not.toContain('access-token-plain');
    expect(await codexAuthStore(owner.id).load()).toBe(AUTH_JSON);
    await vi.waitFor(async () => expect((await audit('user.assistant_provider_connected')).some((row) => row.actor_id === owner.id && row.meta?.provider === 'codex')).toBe(true));

    const settings = (await req('GET', '/api/assistant/settings')).json() as AssistantSettings;
    expect(settings.providers.find((provider) => provider.id === 'codex')).toMatchObject({ connected: true, source: 'personal', shareable: false });
    expect(JSON.stringify(settings)).not.toContain('access-token-plain');
  });

  it('checks the sign-in through the CLI, not by the existence of a credential', async () => {
    loginMock.check.mockResolvedValueOnce(false);
    expect((await req('POST', '/api/assistant/settings/providers/codex/check')).json()).toEqual({ ok: false, apiKeyName: null });
    loginMock.check.mockResolvedValueOnce(true);
    expect((await req('POST', '/api/assistant/settings/providers/codex/check')).json()).toEqual({ ok: true, apiKeyName: null });
    expect(loginMock.check).toHaveBeenCalledWith(owner.id, expect.objectContaining({ load: expect.any(Function), save: expect.any(Function) }));
  });

  it('a refreshed sign-in is written back to the existing credential and never brings a removed one back', async () => {
    const store = codexAuthStore(owner.id);
    await store.save(AUTH_JSON.replace('refresh-token-plain', 'refresh-token-2'));
    expect(await store.load()).toContain('refresh-token-2');

    const cancel = await req('DELETE', login);
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toEqual({ status: 'idle' });
    expect(loginMock.cancel).toHaveBeenCalledWith(owner.id);

    const disconnect = await req('DELETE', '/api/assistant/settings/providers/codex/key');
    expect(disconnect.statusCode).toBe(204);
    expect(loginMock.cancel).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => expect((await audit('user.assistant_provider_disconnected')).some((row) => row.actor_id === owner.id && row.meta?.provider === 'codex')).toBe(true));
    await store.save(AUTH_JSON);
    expect(await store.load()).toBeNull();
  });
  describe('with the Codex and MiniMax flags unset', () => {
    const keyBody = { apiKey: 'sk-test-key-value' };
    beforeAll(async () => {
      await sharedKeys.setPersonalKeysAllowed(true, owner.id);
    });

    it('hides both providers, rejects their models and answers 404 on every route, with a credential row present', async () => {
      await codexSaveForTest();
      const flags = { codex: process.env.FOLIO_CODEX_ENABLED, minimax: process.env.FOLIO_MINIMAX_ENABLED };
      delete process.env.FOLIO_CODEX_ENABLED;
      delete process.env.FOLIO_MINIMAX_ENABLED;
      try {
        const settings = (await req('GET', '/api/assistant/settings')).json() as AssistantSettings;
        expect(settings.providers.map((provider) => provider.id)).toEqual(['cursor', 'anthropic']);

        const models = (await req('GET', '/api/assistant/models')).json() as { items: Array<{ id: string }> };
        expect(models.items.some((item) => /^(codex|minimax):/.test(item.id))).toBe(false);

        expect((await req('PUT', '/api/assistant/settings/model', { model: 'codex:default' })).statusCode).toBe(400);
        expect((await req('PUT', '/api/assistant/settings/model', { model: 'minimax:MiniMax-M3' })).statusCode).toBe(400);

        for (const [method, url] of [
          ['POST', login], ['GET', login], ['DELETE', login],
          ['DELETE', '/api/assistant/settings/providers/codex/key'],
          ['POST', '/api/assistant/settings/providers/codex/check'],
          ['PUT', '/api/assistant/settings/providers/minimax/key'],
          ['DELETE', '/api/assistant/settings/providers/minimax/key'],
          ['POST', '/api/assistant/settings/providers/minimax/check'],
        ] as const) {
          const response = await req(method, url, method === 'PUT' || method === 'POST' ? keyBody : undefined);
          expect([method, url, response.statusCode]).toEqual([method, url, 404]);
        }
        expect(loginMock.start).not.toHaveBeenCalled();
        expect(loginMock.check).not.toHaveBeenCalled();
      } finally {
        process.env.FOLIO_CODEX_ENABLED = flags.codex;
        process.env.FOLIO_MINIMAX_ENABLED = flags.minimax;
      }
    });

    it('lists both again when the flags are set', async () => {
      const settings = (await req('GET', '/api/assistant/settings')).json() as AssistantSettings;
      expect(settings.providers.map((provider) => provider.id)).toEqual(['cursor', 'anthropic', 'minimax', 'codex']);
    });
  });

  async function codexSaveForTest(): Promise<void> {
    const { saveCodexLogin } = await import('./codexStore.js');
    await saveCodexLogin(owner.id, AUTH_JSON, 'me@example.com');
  }
});
