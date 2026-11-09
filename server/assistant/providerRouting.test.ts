/** Route resolution with every store mocked: no database and no provider call. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  personalKeysAllowed: true,
  cursorPersonal: false,
  cursorSpace: false,
  cursorInstance: false,
  runtime: true,
  rows: [] as Array<{ scope: 'user' | 'space' | 'instance'; provider: string; label: string | null }>,
}));

vi.mock('./cursorRuntime.js', () => ({ cursorRuntimeAvailable: () => state.runtime }));
vi.mock('./store.js', () => ({
  getSettings: vi.fn(async (userId: string) => ({ userId, cursorKeyName: 'cursor-personal', cursorEmail: null, modelId: 'auto', hasKey: state.cursorPersonal })),
  getDecryptedCursorKey: vi.fn(async () => 'cursor-personal-secret'),
}));
vi.mock('./sharedKeys.js', () => ({
  getPersonalKeysAllowed: vi.fn(async () => state.personalKeysAllowed),
  getSpaceKeyInfo: vi.fn(async () => ({ configured: state.cursorSpace, apiKeyName: 'cursor-space' })),
  getInstanceKeyInfo: vi.fn(async () => ({ configured: state.cursorInstance, apiKeyName: 'cursor-instance' })),
  getDecryptedSpaceKey: vi.fn(async () => ({ apiKey: 'cursor-space-secret' })),
  getDecryptedInstanceKey: vi.fn(async () => ({ apiKey: 'cursor-instance-secret' })),
}));
vi.mock('./providerCredentials.js', () => ({
  listApplicableCredentials: vi.fn(async () => state.rows),
  getDecryptedProviderSecret: vi.fn(async (provider: string, target: { scope: string }) => `${provider}-${target.scope}-secret`),
}));

const { resolveAssistantRoute, resolvePublicAssistantRoute } = await import('./providerRouting.js');

const user = { id: 'user-1' };
const ANTHROPIC = 'anthropic:claude-sonnet-5-5';

beforeEach(() => {
  Object.assign(state, { personalKeysAllowed: true, cursorPersonal: false, cursorSpace: false, cursorInstance: false, runtime: true, rows: [] });
  vi.stubEnv('CURSOR_API_KEY', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('MINIMAX_API_KEY', '');
  // MiniMax and Codex are off unless an operator turns them on; these tests are about the routing when they are.
  vi.stubEnv('FOLIO_MINIMAX_ENABLED', '1');
  vi.stubEnv('FOLIO_CODEX_ENABLED', '1');
});
afterEach(() => vi.unstubAllEnvs());

describe('resolveAssistantRoute', () => {
  it('walks personal -> space -> instance -> environment', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-secret');
    expect(await resolveAssistantRoute(user, 's1', ANTHROPIC)).toMatchObject({ provider: 'anthropic', modelId: 'claude-sonnet-5-5', secret: 'env-secret', source: 'environment' });
    state.rows.push({ scope: 'instance', provider: 'anthropic', label: 'i' });
    expect(await resolveAssistantRoute(user, 's1', ANTHROPIC)).toMatchObject({ secret: 'anthropic-instance-secret', source: 'instance', keyName: 'i' });
    state.rows.push({ scope: 'space', provider: 'anthropic', label: 's' });
    expect(await resolveAssistantRoute(user, 's1', ANTHROPIC)).toMatchObject({ secret: 'anthropic-space-secret', source: 'space' });
    state.rows.push({ scope: 'user', provider: 'anthropic', label: 'p' });
    expect(await resolveAssistantRoute(user, 's1', ANTHROPIC)).toMatchObject({ secret: 'anthropic-user-secret', source: 'personal' });
    state.personalKeysAllowed = false;
    expect(await resolveAssistantRoute(user, 's1', ANTHROPIC)).toMatchObject({ source: 'space' });
  });

  it('uses the credential of a concrete model and nothing else', async () => {
    state.cursorInstance = true;
    state.rows.push({ scope: 'instance', provider: 'anthropic', label: null });
    expect(await resolveAssistantRoute(user, null, 'composer-2')).toMatchObject({ provider: 'cursor', modelId: 'composer-2', secret: 'cursor-instance-secret' });
  });

  it('a signed-in run on a provider model whose credential is gone resolves like auto', async () => {
    state.rows.push({ scope: 'instance', provider: 'anthropic', label: null });
    expect(await resolveAssistantRoute(user, null, 'minimax:MiniMax-M3')).toMatchObject({ provider: 'anthropic', modelId: 'claude-opus-5-5' });
    // On Cursor the fallback never carries a provider-prefixed model.
    state.cursorInstance = true;
    expect(await resolveAssistantRoute(user, null, 'minimax:MiniMax-M3')).toMatchObject({ provider: 'cursor', modelId: 'auto' });
    state.cursorInstance = false;
    state.rows.length = 0;
    expect(await resolveAssistantRoute(user, null, 'minimax:MiniMax-M3')).toBeNull();
  });

  it('auto prefers Cursor, then Anthropic, then MiniMax, with their default models', async () => {
    state.cursorInstance = true;
    state.rows.push({ scope: 'instance', provider: 'minimax', label: null }, { scope: 'instance', provider: 'anthropic', label: null });
    expect(await resolveAssistantRoute(user, null, 'auto')).toMatchObject({ provider: 'cursor', modelId: 'auto' });
    state.cursorInstance = false;
    expect(await resolveAssistantRoute(user, null, 'auto')).toMatchObject({ provider: 'anthropic', modelId: 'claude-opus-5-5' });
    state.rows = [{ scope: 'instance', provider: 'minimax', label: null }];
    expect(await resolveAssistantRoute(user, null, 'auto')).toMatchObject({ provider: 'minimax', modelId: 'MiniMax-M3' });
    state.rows = [];
    expect(await resolveAssistantRoute(user, null, 'auto')).toBeNull();
  });

  it('skips Cursor under auto on a server without its runtime', async () => {
    state.runtime = false;
    state.cursorInstance = true;
    state.rows.push({ scope: 'instance', provider: 'anthropic', label: null });
    expect(await resolveAssistantRoute(user, null, 'auto')).toMatchObject({ provider: 'anthropic' });
    state.rows = [];
    expect(await resolveAssistantRoute(user, null, 'auto')).toMatchObject({ provider: 'cursor' });
  });

  it('keeps Codex personal: never from another level, never when personal keys are off', async () => {
    state.rows.push({ scope: 'instance', provider: 'codex', label: null });
    expect(await resolveAssistantRoute(user, null, 'codex:default')).toBeNull();
    state.rows.push({ scope: 'user', provider: 'codex', label: null });
    expect(await resolveAssistantRoute(user, null, 'codex:default')).toMatchObject({ provider: 'codex', source: 'personal' });
    state.personalKeysAllowed = false;
    expect(await resolveAssistantRoute(user, null, 'codex:default')).toBeNull();
  });
});

describe('resolvePublicAssistantRoute', () => {
  it('prefers Cursor when it resolves', async () => {
    state.cursorSpace = true;
    state.rows.push({ scope: 'space', provider: 'anthropic', label: null });
    expect(await resolvePublicAssistantRoute(user, 's1', 'auto')).toMatchObject({ provider: 'cursor', source: 'space', secret: 'cursor-space-secret' });
  });

  it('never uses a personal credential of any provider', async () => {
    state.cursorPersonal = true;
    state.rows.push({ scope: 'user', provider: 'anthropic', label: null }, { scope: 'user', provider: 'minimax', label: null }, { scope: 'user', provider: 'codex', label: null });
    expect(await resolvePublicAssistantRoute(user, 's1', 'auto')).toBeNull();
    expect(await resolvePublicAssistantRoute(user, 's1', ANTHROPIC)).toBeNull();
    expect(await resolvePublicAssistantRoute(user, 's1', 'codex:default')).toBeNull();
    state.rows.push({ scope: 'space', provider: 'minimax', label: null });
    expect(await resolvePublicAssistantRoute(user, 's1', 'auto')).toMatchObject({ provider: 'minimax', source: 'space', secret: 'minimax-space-secret' });
  });

  it('takes the shared Anthropic key before MiniMax, down to the environment', async () => {
    vi.stubEnv('MINIMAX_API_KEY', 'mm-env');
    expect(await resolvePublicAssistantRoute(user, 's1', 'auto')).toMatchObject({ provider: 'minimax', source: 'environment', secret: 'mm-env' });
    state.rows.push({ scope: 'instance', provider: 'anthropic', label: null });
    expect(await resolvePublicAssistantRoute(user, 's1', 'auto')).toMatchObject({ provider: 'anthropic', source: 'instance' });
  });
});

describe('providers switched off (the default)', () => {
  beforeEach(() => {
    vi.stubEnv('FOLIO_MINIMAX_ENABLED', '');
    vi.stubEnv('FOLIO_CODEX_ENABLED', '');
  });

  it('never routes to MiniMax or Codex, from a credential row or an environment key', async () => {
    state.rows.push(
      { scope: 'user', provider: 'codex', label: null },
      { scope: 'user', provider: 'minimax', label: null },
      { scope: 'instance', provider: 'minimax', label: null },
    );
    vi.stubEnv('MINIMAX_API_KEY', 'mm-env');
    expect(await resolveAssistantRoute(user, null, 'auto')).toBeNull();
    expect(await resolveAssistantRoute(user, null, 'codex:default')).toBeNull();
    expect(await resolveAssistantRoute(user, null, 'minimax:MiniMax-M3')).toBeNull();
    expect(await resolvePublicAssistantRoute(user, 's1', 'auto')).toBeNull();
  });

  it('falls back like a model whose credential is gone, to Claude', async () => {
    state.rows.push({ scope: 'user', provider: 'codex', label: null }, { scope: 'instance', provider: 'minimax', label: null }, { scope: 'instance', provider: 'anthropic', label: null });
    expect(await resolveAssistantRoute(user, null, 'codex:default')).toMatchObject({ provider: 'anthropic' });
    expect(await resolveAssistantRoute(user, null, 'auto')).toMatchObject({ provider: 'anthropic' });
    expect(await resolvePublicAssistantRoute(user, 's1', 'auto')).toMatchObject({ provider: 'anthropic' });
  });
});
