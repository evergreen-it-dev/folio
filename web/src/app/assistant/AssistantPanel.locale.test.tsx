// @vitest-environment jsdom
/**
 * The Ask / Agent mode switch of the chat panel is translated (it used to show
 * the English words in uk and ru).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { AssistantSettings } from '@shared/contracts';
import { ToastProvider } from '../ui/Toast';
import '../i18n/register';
import { AssistantPanel } from './AssistantPanel';

vi.mock('./runState', () => ({
  useAssistantRun: () => ({
    activeRun: null,
    streamText: '',
    step: null,
    isRunning: false,
    reconnecting: false,
    lastMessage: null,
    start: vi.fn(),
    stop: vi.fn(),
    setPanelOpen: () => {},
  }),
}));

const SETTINGS: AssistantSettings = {
  provider: 'CURSOR',
  model: 'auto',
  apiKeyConfigured: true,
  apiKeySource: 'personal',
  apiKeyName: 'k',
  encryptionAvailable: true,
  runtimeAvailable: true,
};

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView ??= () => {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/assistant/settings') return jsonResponse(SETTINGS);
      if (url.startsWith('/api/assistant/chat')) return jsonResponse({ conversationId: null, title: '', model: 'auto', messages: [] });
      if (url === '/api/assistant/conversations') return jsonResponse({ items: [] });
      if (url === '/api/spaces') return jsonResponse({ spaces: [] });
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await i18next.changeLanguage('en');
});

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <AssistantPanel open onClose={() => {}} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

// Written as escapes: the public repository allows Cyrillic only in data files, and ru.json is not
// part of it at all (those cases skip themselves when the bundle is absent).
const UK_ASK = '\u0417\u0430\u043f\u0438\u0442\u0430\u0442\u0438'; // uk "Ask"
const RU_ASK = '\u0421\u043f\u0440\u043e\u0441\u0438\u0442\u044c'; // ru "Ask"
const AGENT = '\u0410\u0433\u0435\u043d\u0442'; // uk and ru "Agent"

describe('AssistantPanel mode switch labels', () => {
  it.each([
    ['en', 'Ask', 'Agent'],
    ['uk', UK_ASK, AGENT],
    ['ru', RU_ASK, AGENT],
  ])('renders %s labels', async (lang, ask, agent) => {
    if (lang !== 'en' && !i18next.hasResourceBundle(lang, 'app')) return;
    await i18next.changeLanguage(lang);
    renderPanel();
    expect(await screen.findByRole('button', { name: ask })).toBeTruthy();
    expect(screen.getByRole('button', { name: agent })).toBeTruthy();
    if (lang !== 'en') {
      expect(screen.queryByRole('button', { name: 'Ask' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Agent' })).toBeNull();
    }
  });
});
