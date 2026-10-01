// @vitest-environment jsdom
/**
 * R23 tail — child navigation in the public share view. What must hold, per
 * the round's checklist: the payload's subtree renders as a compact tree,
 * navigating it stays inside /share/:token (client routing + the ?page=
 * fetch, never a session route), the current page is highlighted, and a
 * child arrives read-only.
 *
 * The heavy leaf surfaces (markdown renderer, CM6 editor, excalidraw) are
 * mocked — they have their own suites; this one is about the share shell's
 * routing/fetch/navigation behavior around them.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { SharedPagePayload } from '@shared/contracts';

vi.mock('../../markdown', () => ({
  Markdown: ({ markdown }: { markdown: string }) => <div data-testid="markdown-body">{markdown}</div>,
}));
vi.mock('../../editor', () => ({
  // data-readonly exposes the prop the fix/doc-share-role tests below assert
  // on — every other existing test only checks for the testid's presence.
  PageEditor: ({ readOnly }: { readOnly?: boolean }) => (
    <div data-testid="page-editor" data-readonly={readOnly ? 'true' : 'false'} />
  ),
}));
vi.mock('../../diagrams', () => ({
  BoardEditor: () => <div data-testid="board-editor" />,
}));

const { SharedPageView } = await import('./SharedPageView');

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CHILDREN = [
  {
    id: 'c1',
    space: 'sp',
    path: 'manual/chapter.md',
    title: 'Chapter one',
    children: [{ id: 'g1', space: 'sp', path: 'manual/chapter/deep.md', title: 'Deep', children: [] }],
  },
  { id: 'b1', space: 'sp', path: 'manual/board.excalidraw.svg', title: 'Board', children: [] },
];

function docPayload(overrides: Partial<SharedPagePayload['page']>, extra: Partial<SharedPagePayload> = {}): SharedPagePayload {
  return {
    mode: 'view',
    spaceName: 'Space',
    page: {
      id: 'root1',
      space: 'sp',
      path: 'manual.md',
      title: 'Manual',
      kind: 'doc',
      markdown: '# Manual\n\nRoot body.',
      status: 'ok',
      updatedAt: '2026-08-27T00:00:00Z',
      ...overrides,
    } as SharedPagePayload['page'],
    ...extra,
  };
}

const WITH_TREE: Partial<SharedPagePayload> = { children: CHILDREN, rootPageId: 'root1' };

/** Routes fetch by full URL — the same stub-fetch idiom as PageTree.test.tsx, keyed per endpoint. */
function stubFetchByUrl(payloads: Record<string, SharedPagePayload>) {
  const fetchMock = vi.fn((input: unknown) => {
    const url = String(input);
    const payload = payloads[url];
    if (!payload) {
      return Promise.resolve({ ok: false, status: 404, statusText: '', json: () => Promise.resolve({ error: 'share link not found' }) });
    }
    return Promise.resolve({ ok: true, status: 200, statusText: '', json: () => Promise.resolve(payload) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderShare(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/share/:token" element={<SharedPageView />} />
          <Route path="/share/:token/p/:pageId" element={<SharedPageView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SharedPageView — subtree navigation', () => {
  it('renders the compact tree next to the root page, root row highlighted, child rows linking under /share/:token', async () => {
    stubFetchByUrl({ '/api/share/t1': docPayload({}, WITH_TREE) });
    renderShare('/share/t1');

    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());
    expect(screen.getByTestId('markdown-body').textContent).toContain('Root body.');

    // Two nav copies exist (sm+ aside and the <md <details>) — assert on the aside's.
    const nav = screen.getAllByRole('navigation', { name: 'Pages' })[0];
    const links = Array.from(nav.querySelectorAll('a'));
    const hrefs = links.map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/share/t1'); // the root row
    expect(hrefs).toContain('/share/t1/p/c1');
    expect(hrefs).toContain('/share/t1/p/g1'); // grandchild nested in, not flattened away
    expect(hrefs).toContain('/share/t1/p/b1');

    const current = links.find((a) => a.getAttribute('aria-current') === 'page');
    expect(current?.getAttribute('href')).toBe('/share/t1'); // root highlighted
    expect(current?.textContent).toContain('Manual'); // labeled with the ROOT page's title
  });

  it('clicking a child navigates client-side, fetches ?page=<id>, shows the child, and moves the highlight', async () => {
    const fetchMock = stubFetchByUrl({
      '/api/share/t1': docPayload({}, WITH_TREE),
      '/api/share/t1?page=c1': docPayload(
        { id: 'c1', path: 'manual/chapter.md', title: 'Chapter one', markdown: '# Chapter\n\nChild body.' },
        WITH_TREE,
      ),
    });
    renderShare('/share/t1');
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    const nav = screen.getAllByRole('navigation', { name: 'Pages' })[0];
    fireEvent.click(Array.from(nav.querySelectorAll('a')).find((a) => a.getAttribute('href') === '/share/t1/p/c1')!);

    await waitFor(() => expect(screen.getByTestId('markdown-body').textContent).toContain('Child body.'));
    expect(fetchMock).toHaveBeenCalledWith('/api/share/t1?page=c1');

    const after = screen.getAllByRole('navigation', { name: 'Pages' })[0];
    const current = Array.from(after.querySelectorAll('a')).find((a) => a.getAttribute('aria-current') === 'page');
    expect(current?.getAttribute('href')).toBe('/share/t1/p/c1');
    // Nav is still there on the child page (the payload re-carries the subtree).
    expect(Array.from(after.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toContain('/share/t1');
  });

  it('a deep link straight to a child works, and its read-only pill reflects the server-forced view mode', async () => {
    stubFetchByUrl({
      '/api/share/t1?page=c1': docPayload(
        { id: 'c1', path: 'manual/chapter.md', title: 'Chapter one', markdown: '# Chapter\n\nDeep-linked child.' },
        WITH_TREE,
      ),
    });
    renderShare('/share/t1/p/c1');

    await waitFor(() => expect(screen.getByTestId('markdown-body').textContent).toContain('Deep-linked child.'));
    expect(screen.getByText(/View only/)).toBeTruthy();
    // Root row falls back to the generic label — the child payload doesn't carry the root's title.
    const nav = screen.getAllByRole('navigation', { name: 'Pages' })[0];
    const rootRow = Array.from(nav.querySelectorAll('a')).find((a) => a.getAttribute('href') === '/share/t1');
    expect(rootRow?.textContent).toContain('Root page');
  });

  it('a child BOARD renders the static view (never BoardEditor — its share plumbing saves the ROOT page)', async () => {
    stubFetchByUrl({
      '/api/share/t1?page=b1': docPayload(
        { id: 'b1', path: 'manual/board.excalidraw.svg', title: 'Board', kind: 'board', markdown: undefined, svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' },
        WITH_TREE,
      ),
    });
    renderShare('/share/t1/p/b1');

    await waitFor(() => expect(screen.getByRole('img', { name: 'Board' })).toBeTruthy());
    expect(screen.queryByTestId('board-editor')).toBeNull();
  });

  it('a single-page share (no children in the payload) renders no navigation at all — the pre-R23 layout', async () => {
    stubFetchByUrl({ '/api/share/t1': docPayload({}) });
    renderShare('/share/t1');

    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());
    expect(screen.queryByRole('navigation')).toBeNull();
  });
});

/**
 * Fix/doc-share-role: an 'edit' share link's own `mode` is a STATIC verdict
 * from GET /api/share/:token, decoupled from whatever a logged-in visitor's
 * OWN session actually grants — the doc half of the bug already fixed for
 * boards (fix/share-identity). These stub BOTH GET /api/auth/state and
 * GET /api/pages/:id/my-role directly (stubFetchByUrl above only knows the
 * SharedPagePayload shape, not these two), so they use their own fetch stub.
 */
function stubFetch(routes: Record<string, unknown>) {
  const fetchMock = vi.fn((input: unknown) => {
    const url = String(input);
    if (!(url in routes)) {
      return Promise.resolve({ ok: false, status: 404, statusText: '', json: () => Promise.resolve({ error: 'not found' }) });
    }
    return Promise.resolve({ ok: true, status: 200, statusText: '', json: () => Promise.resolve(routes[url]) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function editPayload(overrides: Partial<SharedPagePayload['page']> = {}): SharedPagePayload {
  return docPayload(overrides, { mode: 'edit' });
}

function authStatePayload(user: unknown) {
  return { needsSetup: false, user, memberships: {}, google: false };
}

describe('SharedPageView — doc edit link resolves the REAL role, not the link\'s own static mode', () => {
  it('a session that only grants viewer access forces the doc editor read-only, even though the share link itself says edit', async () => {
    stubFetch({
      '/api/share/t1': editPayload(),
      '/api/auth/state': authStatePayload({ id: 'u1', email: 'viewer@example.com', name: 'Maria', isAdmin: false, createdAt: '2026-01-01T00:00:00Z' }),
      '/api/pages/root1/my-role': { role: 'viewer' },
    });
    renderShare('/share/t1');

    await waitFor(() => expect(screen.getByTestId('page-editor')).toBeTruthy());
    expect(screen.getByTestId('page-editor').getAttribute('data-readonly')).toBe('true');
  });

  it('a logged-in user with real EDITOR access keeps their own session role — the share link\'s edit mode still works', async () => {
    stubFetch({
      '/api/share/t1': editPayload(),
      '/api/auth/state': authStatePayload({ id: 'u2', email: 'editor@example.com', name: 'Oleh', isAdmin: false, createdAt: '2026-01-01T00:00:00Z' }),
      '/api/pages/root1/my-role': { role: 'editor' },
    });
    renderShare('/share/t1');

    await waitFor(() => expect(screen.getByTestId('page-editor')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('page-editor').getAttribute('data-readonly')).toBe('false'));
  });

  it('a genuinely anonymous guest (no session) keeps working exactly as before — no session role to ask for, the link\'s own edit mode wins', async () => {
    stubFetch({
      '/api/share/t1': editPayload(),
      '/api/auth/state': authStatePayload(null),
    });
    renderShare('/share/t1');

    await waitFor(() => expect(screen.getByTestId('page-editor')).toBeTruthy());
    expect(screen.getByTestId('page-editor').getAttribute('data-readonly')).toBe('false');
  });
});
