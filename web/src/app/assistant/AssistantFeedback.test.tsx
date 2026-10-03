// @vitest-environment jsdom
/**
 * Assistant feedback and survey in the chat panel: 👍/👎 under a saved answer
 * (toggle, optimistic cache update, rollback with a toast on failure), the
 * periodic survey card (appears with `surveyDue`, posts the answer, optional
 * comment as a second POST) and the privacy line. The run hook is stubbed — a
 * real one would open the events stream; the HTTP layer is a fetch stub.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { AssistantConversation, AssistantSettings } from '@shared/contracts';
import { ToastProvider } from '../ui/Toast';
import { AssistantPanel } from './AssistantPanel';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

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

const CONVERSATION_ID = '9a1c1f0e-2b6e-4f7b-9d2a-1c1c1c1c1c01';
const ANSWER_ID = '9a1c1f0e-2b6e-4f7b-9d2a-1c1c1c1c1c02';
const SECOND_ANSWER_ID = '9a1c1f0e-2b6e-4f7b-9d2a-1c1c1c1c1c03';

function conversation(overrides: Partial<AssistantConversation> = {}): AssistantConversation {
  return {
    conversationId: CONVERSATION_ID,
    title: 'Chat',
    model: 'auto',
    messages: [
      { id: 'q1', role: 'user', content: 'How do I invite someone?', createdAt: '2026-10-01T10:00:00.000Z' },
      { id: ANSWER_ID, role: 'assistant', content: 'Use **Invite**.', createdAt: '2026-10-01T10:00:05.000Z', feedback: null },
    ],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

interface Stub {
  fetchMock: ReturnType<typeof vi.fn>;
  calls: (method: string, urlPart: string) => Array<{ url: string; body: unknown }>;
}

function stubApi(chat: AssistantConversation, options: { feedbackStatus?: number } = {}): Stub {
  // Like the server, remember the stored rating so a refetch after the PUT agrees with it.
  const stored = new Map<string, 'up' | 'down' | null>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (url === '/api/assistant/settings') return jsonResponse(SETTINGS);
    if (url.startsWith('/api/assistant/chat')) {
      return jsonResponse({ ...chat, messages: chat.messages.map((m) => (stored.has(m.id) ? { ...m, feedback: stored.get(m.id) } : m)) });
    }
    if (url === '/api/assistant/conversations') return jsonResponse({ items: [] });
    if (url === '/api/spaces') return jsonResponse({ spaces: [] });
    if (method === 'PUT' && url.includes('/feedback')) {
      if (options.feedbackStatus && options.feedbackStatus >= 400) return jsonResponse({ error: 'boom' }, options.feedbackStatus);
      const body = JSON.parse(String(init?.body));
      stored.set(ANSWER_ID, body.rating);
      return jsonResponse({ messageId: ANSWER_ID, rating: body.rating });
    }
    if (method === 'POST' && url.includes('/survey')) return jsonResponse({ ok: true }, 201);
    return jsonResponse({ error: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    calls: (method, urlPart) =>
      fetchMock.mock.calls
        .filter(([input, init]) => (init?.method ?? 'GET') === method && String(input).includes(urlPart))
        .map(([input, init]) => ({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined })),
  };
}

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
  return client;
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView ??= () => {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('assistant answer feedback', () => {
  it('rates an answer, then clears it by clicking the active button again', async () => {
    const stub = stubApi(conversation());
    renderPanel();
    const up = await screen.findByRole('button', { name: 'Helpful answer' });
    expect(up.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(up);
    // Optimistic: pressed before the server has answered.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Helpful answer' }).getAttribute('aria-pressed')).toBe('true'));
    await waitFor(() => expect(stub.calls('PUT', '/feedback')).toHaveLength(1));
    expect(stub.calls('PUT', `/api/assistant/messages/${ANSWER_ID}/feedback`)[0]!.body).toEqual({ rating: 'up' });

    fireEvent.click(screen.getByRole('button', { name: 'Helpful answer' }));
    await waitFor(() => expect(stub.calls('PUT', '/feedback')).toHaveLength(2));
    expect(stub.calls('PUT', '/feedback')[1]!.body).toEqual({ rating: null });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Helpful answer' }).getAttribute('aria-pressed')).toBe('false'));
  });

  it('switches from 👍 to 👎 in one click', async () => {
    const stub = stubApi(
      conversation({
        messages: [{ id: ANSWER_ID, role: 'assistant', content: 'Answer', createdAt: '2026-10-01T10:00:05.000Z', feedback: 'up' }],
      }),
    );
    renderPanel();
    const down = await screen.findByRole('button', { name: 'Not helpful' });
    expect(screen.getByRole('button', { name: 'Helpful answer' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(down);
    await waitFor(() => expect(stub.calls('PUT', '/feedback')).toHaveLength(1));
    expect(stub.calls('PUT', '/feedback')[0]!.body).toEqual({ rating: 'down' });
  });

  it('rolls the rating back and shows a toast when saving fails', async () => {
    stubApi(conversation(), { feedbackStatus: 500 });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Helpful answer' }));
    await screen.findByText(/Couldn't save your rating|boom/i, undefined, { timeout: 3000 });
    expect(screen.getByRole('button', { name: 'Helpful answer' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('shows the privacy note near the input', async () => {
    stubApi(conversation());
    renderPanel();
    expect(await screen.findByText('Administrators can review conversations with the assistant.')).toBeTruthy();
  });
});

describe('assistant survey', () => {
  it('is not shown when the conversation has no surveyDue', async () => {
    stubApi(conversation());
    renderPanel();
    await screen.findByRole('button', { name: 'Helpful answer' });
    expect(screen.queryByText('Did the assistant solve your question?')).toBeNull();
  });

  it('is not shown when surveyDue points at an older answer than the last message', async () => {
    stubApi(
      conversation({
        messages: [
          { id: ANSWER_ID, role: 'assistant', content: 'First', createdAt: '2026-10-01T10:00:05.000Z' },
          { id: 'q2', role: 'user', content: 'Again?', createdAt: '2026-10-01T10:01:00.000Z' },
        ],
        surveyDue: { afterMessageId: ANSWER_ID },
      }),
    );
    renderPanel();
    await screen.findByText('Again?');
    expect(screen.queryByText('Did the assistant solve your question?')).toBeNull();
  });

  it('posts "Yes" and thanks the user', async () => {
    const stub = stubApi(conversation({ surveyDue: { afterMessageId: ANSWER_ID } }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Yes' }));
    await screen.findByText('Thanks for your feedback!');
    const posts = stub.calls('POST', `/api/assistant/conversations/${CONVERSATION_ID}/survey`);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ afterMessageId: ANSWER_ID, answer: 'solved', comment: null });
  });

  it('posts "Not now" as skipped and hides the card without a thank-you', async () => {
    const stub = stubApi(conversation({ surveyDue: { afterMessageId: ANSWER_ID } }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByText('Did the assistant solve your question?')).toBeNull());
    expect(stub.calls('POST', '/survey')[0]!.body).toEqual({ afterMessageId: ANSWER_ID, answer: 'skipped', comment: null });
    expect(screen.queryByText('Thanks for your feedback!')).toBeNull();
  });

  it('sends the answer at once, then the comment as a second POST for the same message', async () => {
    const stub = stubApi(conversation({ surveyDue: { afterMessageId: ANSWER_ID } }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Partly' }));
    const input = await screen.findByLabelText('What was missing? (optional)');
    expect(stub.calls('POST', '/survey')).toHaveLength(1);
    expect(stub.calls('POST', '/survey')[0]!.body).toEqual({ afterMessageId: ANSWER_ID, answer: 'partly', comment: null });

    fireEvent.change(input, { target: { value: 'No screenshot' } });
    fireEvent.click(within(screen.getByRole('group', { name: 'Did the assistant solve your question?' })).getByRole('button', { name: 'Send' }));
    await screen.findByText('Thanks for your feedback!');
    const posts = stub.calls('POST', '/survey');
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual({ afterMessageId: ANSWER_ID, answer: 'partly', comment: 'No screenshot' });
  });

  it('lets the user skip the comment after "No"', async () => {
    const stub = stubApi(conversation({ surveyDue: { afterMessageId: ANSWER_ID } }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'No' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Skip comment' }));
    await screen.findByText('Thanks for your feedback!');
    expect(stub.calls('POST', '/survey')).toHaveLength(1);
    expect(stub.calls('POST', '/survey')[0]!.body).toMatchObject({ answer: 'not_solved' });
  });

  it('keeps the card for a survey that becomes due on a later answer', async () => {
    stubApi(
      conversation({
        messages: [{ id: SECOND_ANSWER_ID, role: 'assistant', content: 'Later', createdAt: '2026-10-01T10:00:05.000Z' }],
        surveyDue: { afterMessageId: SECOND_ANSWER_ID },
      }),
    );
    renderPanel();
    expect(await screen.findByText('Did the assistant solve your question?')).toBeTruthy();
  });
});
