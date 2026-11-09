// @vitest-environment jsdom
/**
 * The "Models and connections" part of the settings modal: MiniMax / Claude keys, the Codex
 * sign-in (code on screen, polling that stops once connected), the personal-key policy and the
 * model select grouped by provider. The HTTP layer is a fetch stub.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { AssistantCodexLoginState, AssistantModelOption, AssistantProviderStatus, AssistantSettings } from '@shared/contracts';
import { ToastProvider } from '../ui/Toast';
import '../i18n/register';
import { AssistantSettingsModal } from './AssistantSettingsModal';
import { CODEX_POLL_MS } from './ProviderConnections';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

const PROVIDERS: AssistantProviderStatus[] = [
  { id: 'cursor', label: 'Cursor', connected: false, source: 'none', keyName: null, shareable: true },
  { id: 'anthropic', label: 'Claude (API key)', connected: false, source: 'none', keyName: null, shareable: true },
  { id: 'minimax', label: 'MiniMax', connected: false, source: 'none', keyName: null, shareable: true },
  { id: 'codex', label: 'Codex (ChatGPT)', connected: false, source: 'none', keyName: null, shareable: false },
];

const SETTINGS: AssistantSettings = {
  provider: 'CURSOR',
  model: 'auto',
  apiKeyConfigured: false,
  apiKeySource: 'none',
  apiKeyName: null,
  personalKeysAllowed: true,
  encryptionAvailable: true,
  runtimeAvailable: true,
  cursorRuntimeAvailable: true,
  routeProvider: null,
  providers: PROVIDERS,
};

const AUTO: AssistantModelOption = { id: 'auto', label: 'Auto', description: null };

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) } as Response;
}

interface Stub {
  settings: AssistantSettings;
  models: AssistantModelOption[];
  login?: () => AssistantCodexLoginState;
}

let fetchMock: ReturnType<typeof vi.fn>;

function stub({ settings, models, login }: Stub) {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (url.includes('/providers/codex/login')) return jsonResponse(login ? login() : { status: 'idle' });
    if (url.includes('/providers/') && method !== 'GET') return jsonResponse({ ok: true, apiKeyName: 'k' });
    if (url.startsWith('/api/assistant/settings')) return jsonResponse(settings);
    if (url.startsWith('/api/assistant/models')) return jsonResponse({ items: models });
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <AssistantSettingsModal space={null} onClose={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function calls(match: string, method: string) {
  return fetchMock.mock.calls.filter(([url, init]) => String(url).includes(match) && ((init as RequestInit | undefined)?.method ?? 'GET') === method);
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('provider keys', () => {
  it('saves a Claude key and forgets a saved personal MiniMax key', async () => {
    stub({
      settings: { ...SETTINGS, providers: PROVIDERS.map((p) => (p.id === 'minimax' ? { ...p, connected: true, source: 'personal', keyName: 'work' } : p)) },
      models: [AUTO],
    });
    renderModal();

    const claude = await screen.findByRole('region', { name: 'Claude (API key)' });
    expect(within(claude).getByText(/console\.anthropic\.com/)).toBeTruthy();
    expect(within(claude).getByText(/Claude subscription/)).toBeTruthy();
    fireEvent.change(within(claude).getByPlaceholderText('Paste an Anthropic API key'), { target: { value: ' sk-ant-1 ' } });
    fireEvent.click(within(claude).getByRole('button', { name: 'Check & connect' }));
    await waitFor(() => expect(calls('/providers/anthropic/key', 'PUT')).toHaveLength(1));
    expect(JSON.parse(String((calls('/providers/anthropic/key', 'PUT')[0][1] as RequestInit).body))).toEqual({ apiKey: 'sk-ant-1' });

    const minimax = screen.getByRole('region', { name: 'MiniMax' });
    expect(within(minimax).getByText(/My key/)).toBeTruthy();
    fireEvent.click(within(minimax).getByRole('button', { name: 'Forget my key' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Forget my key' })).getByRole('button', { name: 'Forget my key' }));
    await waitFor(() => expect(calls('/providers/minimax/key', 'DELETE')).toHaveLength(1));
  });

  it('hides the key forms and the Codex sign-in when personal keys are disabled', async () => {
    stub({ settings: { ...SETTINGS, personalKeysAllowed: false }, models: [AUTO] });
    renderModal();

    await screen.findByRole('region', { name: 'MiniMax' });
    expect(screen.queryByPlaceholderText('Paste a MiniMax API key')).toBeNull();
    expect(screen.queryByPlaceholderText('Paste an Anthropic API key')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in with ChatGPT' })).toBeNull();
  });
});

describe('Codex sign-in', () => {
  it('shows the code and stops polling once connected', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let polls = 0;
    stub({
      settings: SETTINGS,
      models: [AUTO],
      login: () => {
        polls += 1;
        // POST (poll 1) starts the login, the first GET still waits, the second one is connected.
        if (polls === 1) return { status: 'pending', userCode: 'ABCD-1234', verificationUrl: 'https://auth.example/device', expiresAt: new Date(Date.now() + 600_000).toISOString() };
        return polls === 2 ? { status: 'pending' } : { status: 'connected' };
      },
    });
    renderModal();

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with ChatGPT' }));
    expect(await screen.findByText('ABCD-1234')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Open the sign-in page' });
    expect(link.getAttribute('href')).toBe('https://auth.example/device');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(calls('/providers/codex/login', 'GET')).toHaveLength(0);

    await act(() => vi.advanceTimersByTimeAsync(CODEX_POLL_MS));
    expect(calls('/providers/codex/login', 'GET')).toHaveLength(1);
    expect(screen.getByText('ABCD-1234')).toBeTruthy(); // a poll without a code keeps the one on screen
    await act(() => vi.advanceTimersByTimeAsync(CODEX_POLL_MS));
    expect(calls('/providers/codex/login', 'GET')).toHaveLength(2);
    await waitFor(() => expect(screen.queryByText('ABCD-1234')).toBeNull());

    await act(() => vi.advanceTimersByTimeAsync(CODEX_POLL_MS * 3));
    expect(calls('/providers/codex/login', 'GET')).toHaveLength(2);
  });
});

describe('model select', () => {
  it('groups models by provider and keeps a saved model of a disconnected provider', async () => {
    stub({
      settings: {
        ...SETTINGS,
        model: 'minimax:MiniMax-M3',
        apiKeyConfigured: true,
        providers: PROVIDERS.map((p) => (p.id === 'cursor' || p.id === 'anthropic' ? { ...p, connected: true, source: 'personal' as const } : p)),
      },
      models: [
        AUTO,
        { id: 'gpt-5', label: 'GPT-5', description: null, provider: 'cursor' },
        { id: 'anthropic:claude-opus-5-5', label: 'Claude Opus 5.5', description: null, provider: 'anthropic' },
      ],
    });
    renderModal();

    const select = (await screen.findByRole('combobox', { name: 'Model' })) as HTMLSelectElement;
    await waitFor(() => expect(select.querySelectorAll('optgroup').length).toBe(3));
    const labels = Array.from(select.querySelectorAll('optgroup')).map((group) => group.label);
    expect(labels).toEqual(['Cursor', 'Claude (API key)', 'Unavailable']);
    expect(select.value).toBe('minimax:MiniMax-M3');
    expect(screen.getByRole('status').textContent).toContain('provider is disconnected');
    expect(within(select).getByRole('option', { name: 'Claude Opus 5.5' })).toBeTruthy();
  });
});

describe('optional providers (off by default on the server)', () => {
  it('shows no MiniMax or Codex text when the server lists neither', async () => {
    stub({ settings: { ...SETTINGS, providers: PROVIDERS.filter((p) => p.id === 'cursor' || p.id === 'anthropic') }, models: [AUTO] });
    renderModal();
    await screen.findByRole('region', { name: 'Claude (API key)' });
    expect(screen.queryByRole('region', { name: 'MiniMax' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Codex (ChatGPT)' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/minimax|codex|chatgpt/i);
  });

  it('shows the Codex card with its warning when the server lists it', async () => {
    stub({ settings: SETTINGS, models: [AUTO] });
    renderModal();
    const codex = await screen.findByRole('region', { name: 'Codex (ChatGPT)' });
    expect(within(codex).getByText(/OpenAI has not confirmed this use on shared servers/)).toBeTruthy();
    expect(within(codex).getByText(/Device-code sign-in must be enabled/)).toBeTruthy();
  });
});
