// @vitest-environment jsdom
/**
 * The personal-key modal under the instance key policy: with `personalKeysAllowed: false` the
 * key form is gone and a note says the shared key serves everyone (the model choice stays);
 * with personal keys allowed the form is there. The HTTP layer is a fetch stub.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { AssistantSettings } from '@shared/contracts';
import { ToastProvider } from '../ui/Toast';
import '../i18n/register';
import { AssistantSettingsModal } from './AssistantSettingsModal';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

const SETTINGS: AssistantSettings = {
  provider: 'CURSOR',
  model: 'auto',
  apiKeyConfigured: true,
  apiKeySource: 'instance',
  apiKeyName: 'Team key',
  personalKeysAllowed: false,
  encryptionAvailable: true,
  runtimeAvailable: true,
  cursorRuntimeAvailable: true,
  routeProvider: 'cursor',
  providers: [],
};

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

function stubSettings(settings: AssistantSettings) {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/assistant/settings')) return jsonResponse(settings);
    if (url.startsWith('/api/assistant/models')) return jsonResponse({ items: [{ id: 'auto', label: 'Auto', description: null }] });
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderModal(space: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <AssistantSettingsModal space={space} onClose={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AssistantSettingsModal under the personal-key policy', () => {
  it('hides the key form and explains the shared key when personal keys are disabled', async () => {
    stubSettings(SETTINGS);
    renderModal('docs');

    expect(await screen.findByText('This instance uses a shared Folio AI key managed by an administrator.')).toBeTruthy();
    expect(screen.getByText('Shared key of this instance')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Paste a Cursor API key')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check & connect' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check saved key' })).toBeNull();
    // The model choice keeps working.
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeTruthy();
    // The chat's space is passed on, so a space key can be reported as the source.
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/assistant/settings?space=docs')).toBe(true);
  });

  it('shows the key form when personal keys are allowed', async () => {
    stubSettings({ ...SETTINGS, apiKeySource: 'space', personalKeysAllowed: true });
    renderModal(null);

    expect(await screen.findByPlaceholderText('Paste a Cursor API key')).toBeTruthy();
    expect(screen.getByText('Shared key of this space')).toBeTruthy();
    expect(screen.queryByText('This instance uses a shared Folio AI key managed by an administrator.')).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/assistant/settings')).toBe(true);
  });
});
