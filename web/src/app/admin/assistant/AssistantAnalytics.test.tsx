// @vitest-environment jsdom
/**
 * /admin/assistant — the instance-admin gate, the conversations list (rows,
 * counters, filters going to the query string, pagination), the "questions
 * without an answer" tab (reason filter, link into the dialog) and the dialog
 * view (ratings, survey answers and unanswered reports placed in the thread).
 * The HTTP layer is a fetch stub; server behaviour lives in server tests.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type {
  AdminAssistantConversationDetail,
  AdminAssistantConversationRow,
  AdminAssistantConversationsResponse,
  AdminAssistantUnansweredItem,
  AdminAssistantUnansweredResponse,
} from '@shared/contracts';
import { AssistantAnalytics } from './AssistantAnalytics';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ADMIN_USER = { id: 'admin-1', name: 'Admin One', email: 'admin@t.local', isAdmin: true, createdAt: '' };
const NON_ADMIN_USER = { id: 'u-2', name: 'Regular', email: 'reg@t.local', isAdmin: false, createdAt: '' };

let currentUser = ADMIN_USER;
vi.mock('../../auth/AuthProvider', () => ({
  useAuth: () => ({ user: currentUser, memberships: {}, logout: () => {}, loggingOut: false }),
}));

const OLHA = { id: 'u-olha', name: 'Olha', email: 'olha@t.local' };
const IVAN = { id: 'u-ivan', name: 'Ivan', email: 'ivan@t.local' };
const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const LONG_QUESTION = 'How do I give a contractor read-only access to one space without letting them see the others? '.repeat(3).trim();

const ROWS: AdminAssistantConversationRow[] = [
  {
    conversationId: C1,
    user: OLHA,
    space: 'eng',
    firstQuestion: LONG_QUESTION,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:10:00.000Z',
    questions: 4,
    likes: 2,
    dislikes: 1,
    surveys: { solved: 1, partly: 1, notSolved: 0 },
    unanswered: 2,
  },
  {
    conversationId: C2,
    user: IVAN,
    space: null,
    firstQuestion: 'Where is the trash?',
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:05:00.000Z',
    questions: 1,
    likes: 0,
    dislikes: 0,
    surveys: { solved: 0, partly: 0, notSolved: 0 },
    unanswered: 0,
  },
];

const UNANSWERED: AdminAssistantUnansweredItem[] = [
  {
    id: 'r1',
    conversationId: C1,
    user: OLHA,
    space: 'eng',
    pageId: null,
    question: 'Can guests be limited to one folder?',
    reason: 'no_answer',
    missing: 'Folder-level sharing is not documented',
    createdAt: '2026-10-01T10:02:00.000Z',
  },
  {
    id: 'r2',
    conversationId: C2,
    user: IVAN,
    space: 'wiki',
    pageId: null,
    question: 'Does the export keep comments?',
    reason: 'low_confidence',
    missing: null,
    createdAt: '2026-09-30T10:01:00.000Z',
  },
];

const DETAIL: AdminAssistantConversationDetail = {
  conversationId: C1,
  user: OLHA,
  title: 'Contractor access',
  model: 'auto',
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:10:00.000Z',
  messages: [
    { id: 'm1', role: 'user', content: 'Can guests be limited to one folder?', createdAt: '2026-10-01T10:01:00.000Z', feedback: null, space: 'eng' },
    { id: 'm2', role: 'assistant', content: 'I could **not** find that.', createdAt: '2026-10-01T10:02:30.000Z', feedback: 'down', space: 'eng' },
    { id: 'm3', role: 'user', content: 'Thanks anyway', createdAt: '2026-10-01T10:05:00.000Z', feedback: null, space: 'eng' },
    { id: 'm4', role: 'assistant', content: 'You are welcome.', createdAt: '2026-10-01T10:05:05.000Z', feedback: 'up', space: 'eng' },
  ],
  surveys: [{ afterMessageId: 'm2', answer: 'not_solved', comment: 'No folder-level rights', createdAt: '2026-10-01T10:03:00.000Z' }],
  unanswered: [UNANSWERED[0]!],
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

/** Mimics the server's contract closely enough for the UI: filter options always reflect the FULL data set. */
function stubApi(options: { total?: number } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const [path, query = ''] = url.split('?');
    const params = new URLSearchParams(query);
    const spaces = ['eng', 'wiki'];
    const users = [OLHA, IVAN];
    if (path === '/api/admin/assistant/conversations') {
      const items = ROWS.filter((r) => (!params.get('space') || r.space === params.get('space')) && (!params.get('userId') || r.user.id === params.get('userId')));
      const body: AdminAssistantConversationsResponse = { items, total: options.total ?? items.length, spaces, users };
      return jsonResponse(body);
    }
    if (path === `/api/admin/assistant/conversations/${C1}`) return jsonResponse(DETAIL);
    if (path.startsWith('/api/admin/assistant/conversations/')) return jsonResponse({ error: 'not found' }, 404);
    if (path === '/api/admin/assistant/unanswered') {
      const items = UNANSWERED.filter((r) => !params.get('reason') || r.reason === params.get('reason'));
      const body: AdminAssistantUnansweredResponse = { items, total: items.length, spaces, users };
      return jsonResponse(body);
    }
    return jsonResponse({ error: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function listCalls(fetchMock: ReturnType<typeof stubApi>, path: string): URLSearchParams[] {
  return fetchMock.mock.calls
    .map(([input]) => String(input))
    .filter((url) => url.split('?')[0] === path)
    .map((url) => new URLSearchParams(url.split('?')[1] ?? ''));
}

function renderPage(initialEntry = '/admin/assistant') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AssistantAnalytics />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AssistantAnalytics', () => {
  it('shows the no-access message to a non-admin and calls nothing', () => {
    currentUser = NON_ADMIN_USER;
    const fetchMock = stubApi();
    renderPage();
    expect(screen.getByText("You don't have access to this page.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    currentUser = ADMIN_USER;
  });

  it('lists conversations with counters, a truncated question with the full text in the tooltip, and badges', async () => {
    currentUser = ADMIN_USER;
    stubApi();
    renderPage();
    const link = await screen.findByTitle(LONG_QUESTION);
    expect(link.className).toContain('line-clamp-2');
    const row = link.closest('tr')!;
    expect(within(row).getByText('Olha')).toBeTruthy();
    expect(within(row).getByText('olha@t.local')).toBeTruthy();
    expect(within(row).getByText('eng')).toBeTruthy();
    expect(within(row).getByText('4')).toBeTruthy();
    expect(within(row).getByText('Solved 1')).toBeTruthy();
    expect(within(row).getByText('Partly 1')).toBeTruthy();
    expect(within(row).getByText('2', { selector: 'span.bg-red-50' })).toBeTruthy();
    expect(screen.getByText('Where is the trash?')).toBeTruthy();
  });

  it('sends the chosen filters to the server and goes back to the first page', async () => {
    currentUser = ADMIN_USER;
    const fetchMock = stubApi({ total: 120 });
    renderPage();
    await screen.findByText('Where is the trash?');
    expect(listCalls(fetchMock, '/api/admin/assistant/conversations')[0]!.get('limit')).toBe('50');

    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    await waitFor(() => expect(listCalls(fetchMock, '/api/admin/assistant/conversations').some((p) => p.get('offset') === '50')).toBe(true));

    fireEvent.change(await screen.findByLabelText('Space'), { target: { value: 'eng' } });
    await waitFor(() => {
      const last = listCalls(fetchMock, '/api/admin/assistant/conversations').at(-1)!;
      expect(last.get('space')).toBe('eng');
      expect(last.get('offset')).toBe('0');
    });
    fireEvent.change(screen.getByLabelText('User'), { target: { value: IVAN.id } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-31' } });
    await waitFor(() => {
      const last = listCalls(fetchMock, '/api/admin/assistant/conversations').at(-1)!;
      expect(last.get('userId')).toBe(IVAN.id);
      expect(last.get('from')).toBe('2026-09-01');
      expect(last.get('to')).toBe('2026-10-31');
    });
  });

  it('shows the empty state', async () => {
    currentUser = ADMIN_USER;
    const fetchMock = vi.fn(async () => jsonResponse({ items: [], total: 0, spaces: [], users: [] }));
    vi.stubGlobal('fetch', fetchMock);
    renderPage();
    expect(await screen.findByText('No conversations yet.')).toBeTruthy();
  });

  it('shows the unanswered tab with reasons, the missing text, filters and a link to the dialog', async () => {
    currentUser = ADMIN_USER;
    const fetchMock = stubApi();
    renderPage('/admin/assistant?tab=unanswered');
    expect(await screen.findByText('Can guests be limited to one folder?')).toBeTruthy();
    expect(screen.getByText('Folder-level sharing is not documented')).toBeTruthy();
    expect(screen.getByText('Does the export keep comments?')).toBeTruthy();
    // Badge texts (the reason <select> has the same labels, so look at the table).
    const table = screen.getByRole('table');
    expect(within(table).getByText('No answer')).toBeTruthy();
    expect(within(table).getByText('Not sure')).toBeTruthy();
    const links = screen.getAllByRole('link', { name: 'Open conversation' });
    expect(links[0]!.getAttribute('href')).toBe(`/admin/assistant?tab=conversations&conversation=${C1}`);

    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'low_confidence' } });
    await waitFor(() => expect(listCalls(fetchMock, '/api/admin/assistant/unanswered').at(-1)!.get('reason')).toBe('low_confidence'));
    await waitFor(() => expect(screen.queryByText('Can guests be limited to one folder?')).toBeNull());
  });

  it('opens a dialog from a row and shows ratings, the survey answer and the unanswered report in place', async () => {
    currentUser = ADMIN_USER;
    stubApi();
    renderPage();
    // Clicking anywhere on the row opens the dialog.
    fireEvent.click((await screen.findByText('olha@t.local')).closest('tr')!);
    expect(await screen.findByText('Contractor access')).toBeTruthy();
    expect(screen.getByText('(olha@t.local)')).toBeTruthy();
    // Assistant markdown is rendered, not shown raw.
    expect(document.querySelector('.folio-chat-md strong')?.textContent).toBe('not');
    expect(screen.getByText('Survey: Not solved')).toBeTruthy();
    expect(screen.getByText('No folder-level rights')).toBeTruthy();
    expect(screen.getByText('Question without an answer')).toBeTruthy();
    expect(screen.getByText('Folder-level sharing is not documented', { exact: false })).toBeTruthy();
    expect(screen.getByText('Helpful')).toBeTruthy();
    expect(screen.getAllByText('Not helpful').length).toBeGreaterThan(0);
  });
});
