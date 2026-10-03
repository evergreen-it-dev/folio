// @vitest-environment jsdom
/**
 * /admin/assistant — the access gate (instance admin, space admin with a scope
 * note and the hidden-messages note, everyone else "no access"), the conversations list (rows,
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
  AdminAssistantAccess,
  AdminAssistantConversationDetail,
  AdminAssistantConversationRow,
  AdminAssistantConversationViews,
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
    spaceName: 'Engineering',
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
    spaceName: null,
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
    spaceName: 'Engineering',
    pageId: null,
    question: 'Can guests be limited to one folder?',
    userQuestion: 'can i give a guest access to just 1 folder??',
    reason: 'no_answer',
    missing: 'Folder-level sharing is not documented',
    createdAt: '2026-10-01T10:02:00.000Z',
  },
  {
    id: 'r2',
    conversationId: C2,
    user: IVAN,
    space: 'wiki',
    spaceName: null,
    pageId: null,
    question: 'Does the export keep comments?',
    userQuestion: null,
    reason: 'low_confidence',
    missing: 'See [Export notes](/s/wiki/p/export-1) and **comments** [bad](javascript:window.__xss=1) <img src=x onerror="window.__xss=1">',
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
    { id: 'm1', role: 'user', content: 'Can guests be limited to one folder?', createdAt: '2026-10-01T10:01:00.000Z', feedback: null, space: 'eng', spaceName: 'Engineering' },
    { id: 'm2', role: 'assistant', content: 'I could **not** find that.', createdAt: '2026-10-01T10:02:30.000Z', feedback: 'down', space: 'eng', spaceName: 'Engineering' },
    { id: 'm3', role: 'user', content: 'Thanks anyway', createdAt: '2026-10-01T10:05:00.000Z', feedback: null, space: 'eng', spaceName: 'Engineering' },
    { id: 'm4', role: 'assistant', content: 'You are welcome.', createdAt: '2026-10-01T10:05:05.000Z', feedback: 'up', space: 'eng', spaceName: 'Engineering' },
  ],
  surveys: [{ afterMessageId: 'm2', answer: 'not_solved', comment: 'No folder-level rights', createdAt: '2026-10-01T10:03:00.000Z' }],
  unanswered: [UNANSWERED[0]!],
  hiddenMessages: 0,
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

/** Mimics the server's contract closely enough for the UI: filter options always reflect the FULL data set. */
function stubApi(options: { total?: number; access?: AdminAssistantAccess | 'forbidden'; hiddenMessages?: number; views?: AdminAssistantConversationViews | 'fail' } = {}) {
  const access = options.access ?? { scope: 'instance', spaces: [] };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const [path, query = ''] = url.split('?');
    const params = new URLSearchParams(query);
    const spaces = [{ slug: 'eng', name: 'Engineering' }, { slug: 'wiki', name: null }];
    const users = [OLHA, IVAN];
    if (path === '/api/admin/assistant/access') return access === 'forbidden' ? jsonResponse({ error: 'requires instance or space admin' }, 403) : jsonResponse(access);
    if (path === '/api/admin/assistant/conversations') {
      const items = ROWS.filter((r) => (!params.get('space') || r.space === params.get('space')) && (!params.get('userId') || r.user.id === params.get('userId')));
      const body: AdminAssistantConversationsResponse = { items, total: options.total ?? items.length, spaces, users, scope: access === 'forbidden' ? 'instance' : access.scope };
      return jsonResponse(body);
    }
    if (path === `/api/admin/assistant/conversations/${C1}/views`) {
      if (options.views === 'fail') return jsonResponse({ error: 'boom' }, 500);
      return jsonResponse(options.views ?? { items: [{ user: OLHA, at: '2026-10-02T09:00:00.000Z' }], total: 1 });
    }
    if (path === `/api/admin/assistant/conversations/${C1}`) return jsonResponse({ ...DETAIL, hiddenMessages: options.hiddenMessages ?? 0 });
    if (path.startsWith('/api/admin/assistant/conversations/')) return jsonResponse({ error: 'not found' }, 404);
    if (path === '/api/admin/assistant/unanswered') {
      const items = UNANSWERED.filter((r) => !params.get('reason') || r.reason === params.get('reason'));
      const body: AdminAssistantUnansweredResponse = { items, total: items.length, spaces, users, scope: 'instance' };
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
  it('shows the no-access message when the access query is refused and loads nothing else', async () => {
    const fetchMock = stubApi({ access: 'forbidden' });
    renderPage();
    expect(await screen.findByText("You don't have access to this page.")).toBeTruthy();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(['/api/admin/assistant/access']);
    expect(screen.queryByText(/You see conversations from the spaces/)).toBeNull();
  });

  it('shows no scope note to an instance admin', async () => {
    stubApi();
    renderPage();
    await screen.findByText('Where is the trash?');
    expect(screen.queryByText(/You see conversations from the spaces/)).toBeNull();
  });

  it('tells a space admin which spaces they see, under the title', async () => {
    stubApi({ access: { scope: 'spaces', spaces: ['eng', 'wiki'] } });
    renderPage();
    expect(await screen.findByText('You see conversations from the spaces you administer: eng, wiki.')).toBeTruthy();
    expect(await screen.findByText('Where is the trash?')).toBeTruthy();
  });

  it('tells a space admin how many messages of a dialog are hidden, and says nothing when none are', async () => {
    stubApi({ access: { scope: 'spaces', spaces: ['eng'] }, hiddenMessages: 3 });
    renderPage(`/admin/assistant?conversation=${C1}`);
    expect(await screen.findByText('3 messages outside your spaces are hidden.')).toBeTruthy();
    expect(screen.getByText('Contractor access')).toBeTruthy();
    cleanup();

    stubApi({ access: { scope: 'spaces', spaces: ['eng'] }, hiddenMessages: 1 });
    renderPage(`/admin/assistant?conversation=${C1}`);
    expect(await screen.findByText('1 message outside your spaces is hidden.')).toBeTruthy();
    cleanup();

    stubApi({ access: { scope: 'spaces', spaces: ['eng'] }, hiddenMessages: 0 });
    renderPage(`/admin/assistant?conversation=${C1}`);
    await screen.findByText('Contractor access');
    expect(screen.queryByText(/outside your spaces/)).toBeNull();
  });

  it('lists conversations with counters, a truncated question with the full text in the tooltip, and badges', async () => {
    stubApi();
    renderPage();
    const link = await screen.findByTitle(LONG_QUESTION);
    expect(link.className).toContain('line-clamp-2');
    const row = link.closest('tr')!;
    expect(within(row).getByText('Olha')).toBeTruthy();
    expect(within(row).getByText('olha@t.local')).toBeTruthy();
    expect(within(row).getByText('Engineering')).toBeTruthy();
    expect(within(row).getByText('4')).toBeTruthy();
    expect(within(row).getByText('Solved 1')).toBeTruthy();
    expect(within(row).getByText('Partly 1')).toBeTruthy();
    expect(within(row).getByText('2', { selector: 'span.bg-red-50' })).toBeTruthy();
    expect(screen.getByText('Where is the trash?')).toBeTruthy();
  });

  it('sends the chosen filters to the server and goes back to the first page', async () => {
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith('/api/admin/assistant/access') ? jsonResponse({ scope: 'instance', spaces: [] }) : jsonResponse({ items: [], total: 0, spaces: [], users: [], scope: 'instance' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderPage();
    expect(await screen.findByText('No conversations yet.')).toBeTruthy();
  });

  it('shows the unanswered tab with reasons, the missing text, filters and a link to the dialog', async () => {
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

  it('shows space names (slug in the tooltip, as the filter value) and marks a deleted space', async () => {
    stubApi();
    renderPage('/admin/assistant?tab=unanswered');
    const table = await screen.findByRole('table');
    const name = within(table).getByText('Engineering');
    expect(name.getAttribute('title')).toBe('eng');
    expect(within(table).queryByText('eng')).toBeNull();
    // A space without a row any more: the slug, marked as deleted.
    expect(within(table).getByText('wiki')).toBeTruthy();
    expect(within(table).getByText('(deleted)')).toBeTruthy();

    const select = screen.getByLabelText('Space') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => [o.value, o.textContent]);
    expect(options).toEqual([['', 'All spaces'], ['eng', 'Engineering'], ['wiki', 'wiki (deleted)']]);
  });

  it("shows the person's own words as the question and the assistant's restatement as a second line (restatement only for old rows)", async () => {
    stubApi();
    renderPage('/admin/assistant?tab=unanswered');
    const own = await screen.findByText('can i give a guest access to just 1 folder??');
    const cell = own.closest('td')!;
    expect(within(cell).getByText('Can guests be limited to one folder?')).toBeTruthy();
    expect(within(cell).getByText("Assistant's wording:")).toBeTruthy();
    // No userQuestion (older report): the restatement is the question, no second line.
    const oldCell = screen.getByText('Does the export keep comments?').closest('td')!;
    expect(within(oldCell).queryByText("Assistant's wording:")).toBeNull();
    expect(screen.getAllByText("Assistant's wording:")).toHaveLength(1);
  });

  it('renders the "what\'s missing" Markdown as safe HTML: links open in a new tab, no raw syntax, no injected markup', async () => {
    stubApi();
    renderPage('/admin/assistant?tab=unanswered');
    const link = await screen.findByRole('link', { name: 'Export notes' });
    expect(link.getAttribute('href')).toBe('/s/wiki/p/export-1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    const table = screen.getByRole('table');
    expect(table.querySelector('strong')?.textContent).toBe('comments');
    expect(table.textContent).not.toContain('](');
    expect(table.textContent).not.toContain('**');
    // A javascript: URL loses its href; an HTML tag in the text is dropped, not rendered.
    expect(table.querySelector('a[href^="javascript"]')).toBeNull();
    expect(table.querySelector('img')).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it('opens a dialog from a row and shows ratings, the survey answer and the unanswered report in place', async () => {
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

  it('shows who opened the conversation and when, with deleted accounts and an "earlier" count', async () => {
    const fetchMock = stubApi({
      views: {
        items: [
          { user: IVAN, at: '2026-10-03T08:30:00.000Z' },
          { user: null, at: '2026-10-02T09:00:00.000Z' },
        ],
        total: 5,
      },
    });
    renderPage(`/admin/assistant?tab=conversations&conversation=${C1}`);
    const section = (await screen.findByText('Who opened this conversation')).closest('section')!;
    expect(await within(section).findByText('Ivan')).toBeTruthy();
    expect(within(section).getByText('(ivan@t.local)')).toBeTruthy();
    expect(within(section).getByText('Deleted user')).toBeTruthy();
    expect(within(section).getByText('and 3 earlier openings')).toBeTruthy();
    expect(within(section).getAllByRole('listitem')).toHaveLength(2);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(`/api/admin/assistant/conversations/${C1}/views`);
  });

  it('says so when the access log cannot be loaded, without breaking the dialog', async () => {
    stubApi({ views: 'fail' });
    renderPage(`/admin/assistant?tab=conversations&conversation=${C1}`);
    expect(await screen.findByText('Could not load the list of openings.')).toBeTruthy();
    expect(screen.getByText('Contractor access')).toBeTruthy();
  });
});
