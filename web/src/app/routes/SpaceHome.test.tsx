// @vitest-environment jsdom
/**
 * QA-3 P1 #2 — `/s/<slug>` said "Space not found" for any space whose
 * root has a README.md and no index.md, i.e. for every space made from an
 * ordinary git repository. The space existed, its tree was in the sidebar,
 * and `GET /api/spaces/<slug>/tree` was answering with README.md as the root
 * node — only `GET /api/resolve?path=index.md` 404'd, and SpaceHome turned
 * that page-level 404 into a claim about the SPACE.
 *
 * These pin both halves of the fix: the 404 is now resolved against the tree
 * (README root -> render it; no root page at all -> the synthetic root
 * listing), and the "no such space" screen appears only when the tree
 * endpoint agrees the space is gone.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import i18next from 'i18next';
import { ToastProvider } from '../ui/Toast';
import { SpaceHome } from './SpaceHome';
import '../i18n/register';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
});

// PageContent runs its own page fetch and a whole renderer; the only thing
// under test here is WHICH page id SpaceHome decides to render.
vi.mock('./PageContent', () => ({
  PageContent: ({ id }: { id: string }) => <div data-testid="page-content">{id}</div>,
}));

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

const README_NODE = {
  id: 'page-readme',
  space: 'repo-space',
  path: 'README.md',
  kind: 'doc',
  title: 'Repo Space',
  order: 0,
  status: 'published',
  updatedAt: '',
  children: [],
};

const FOLDER_NODE = {
  id: 'dir:docs',
  space: 'repo-space',
  path: 'docs',
  kind: 'folder',
  title: 'Docs',
  order: 0,
  status: 'published',
  updatedAt: '',
  children: [],
};

function stub({ resolve, tree }: { resolve: () => Response; tree: () => Response }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/resolve')) return resolve();
      if (url.includes('/tree')) return tree();
      return jsonResponse({ error: 'not found' }, 404);
    }),
  );
}

function renderHome() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/s/repo-space']}>
          <Routes>
            <Route path="/s/:space" element={<SpaceHome />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('SpaceHome', () => {
  it('renders index.md when the space has one (unchanged behaviour)', async () => {
    stub({
      resolve: () => jsonResponse({ id: 'page-index', path: 'index.md' }),
      tree: () => jsonResponse({ tree: [] }),
    });
    renderHome();
    await waitFor(() => expect(screen.getByTestId('page-content').textContent).toBe('page-index'));
  });

  it('falls back to the root README when there is no index.md — no "space not found"', async () => {
    stub({
      resolve: () => jsonResponse({ error: 'page not found' }, 404),
      tree: () => jsonResponse({ tree: [README_NODE] }),
    });
    renderHome();
    await waitFor(() => expect(screen.getByTestId('page-content').textContent).toBe('page-readme'));
    expect(screen.queryByText(/not found/i)).toBeNull();
  });

  it('shows the synthetic root listing when the root has no page of its own at all', async () => {
    stub({
      resolve: () => jsonResponse({ error: 'page not found' }, 404),
      tree: () => jsonResponse({ tree: [FOLDER_NODE] }),
    });
    renderHome();
    await waitFor(() => expect(screen.getByText('Docs')).toBeTruthy());
    expect(screen.queryByTestId('page-content')).toBeNull();
    // The lie the bug report is about.
    expect(screen.queryByText(/Space "repo-space" not found/)).toBeNull();
  });

  it('still says the space is missing when the TREE endpoint also 404s', async () => {
    stub({
      resolve: () => jsonResponse({ error: 'space not found' }, 404),
      tree: () => jsonResponse({ error: 'space not found' }, 404),
    });
    renderHome();
    await waitFor(() => expect(screen.getByText(/Space "repo-space" not found/)).toBeTruthy());
  });

  it('shows the 404 screen with an access hint on 403 — no raw English error (QA-3 #9, 07.09 owner)', async () => {
    stub({
      resolve: () => jsonResponse({ error: 'requires viewer+ role in this space' }, 403),
      tree: () => jsonResponse({ tree: [] }),
    });
    renderHome();
    await waitFor(() => expect(screen.getByText('404')).toBeTruthy());
    expect(screen.queryByText(/requires viewer\+ role/)).toBeNull();
    expect(screen.getByText(/might not have access/)).toBeTruthy();
  });

  it('localizes a non-404/403 server error instead of printing its English text', async () => {
    stub({
      resolve: () => jsonResponse({ error: 'boom' }, 500),
      tree: () => jsonResponse({ tree: [] }),
    });
    renderHome();
    await waitFor(() => expect(screen.getByText(/Could not open the space/)).toBeTruthy());
    expect(screen.getByText(/Server error/)).toBeTruthy();
  });
});
