// @vitest-environment jsdom
/**
 * QA-3 P2 #3 — clicking an ancestor crumb for a directory with no index.md
 * dead-ended: `GET /api/resolve?path=<dir>/index.md` 404'd, a toast said
 * "There is no page for …", and the URL never changed — while
 * `/s/<space>/d/<dir>` rendered that same directory perfectly well and is
 * where the sidebar's own folder row already went.
 *
 * Pinned here: the crumb resolves the DIRECTORY (so the server's own
 * index.md -> README.md fallback chain applies to it), and a 404 navigates to
 * the synthetic folder listing rather than refusing to move.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import i18next from 'i18next';
import { ToastProvider } from '../ui/Toast';
import { Breadcrumbs } from './Breadcrumbs';
import '../i18n/register';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderCrumbs(
  resolveResponse: () => Response,
  options: { pagePath?: string; tree?: unknown } = {},
) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('/api/resolve')) return resolveResponse();
      if (url.endsWith('/tree')) return jsonResponse(options.tree ?? { tree: [] });
      if (url.startsWith('/api/spaces')) return jsonResponse({ spaces: [{ slug: 'demo', name: 'Demo' }] });
      return jsonResponse({ error: 'not found' }, 404);
    }),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/s/demo/p/page-1']}>
          <LocationProbe />
          <Routes>
            <Route
              path="/s/demo/*"
              element={
                <Breadcrumbs space="demo" pagePath={options.pagePath ?? 'handbook/onboarding/day-one.md'} title="Day One" pageId="page-1" canRename={false} />
              }
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { calls };
}

const path = () => screen.getByTestId('location').textContent;

describe('Breadcrumbs — ancestor navigation', () => {
  it('uses the current parent page title instead of humanizing its old storage slug', async () => {
    renderCrumbs(
      () => jsonResponse({ id: 'parent', path: 'new-page.md' }),
      {
        pagePath: 'new-page/profiles.md',
        tree: {
          tree: [
            {
              id: 'root', space: 'demo', path: 'index.md', kind: 'doc', title: 'Demo', order: 0,
              status: 'published', updatedAt: '',
              children: [
                {
                  id: 'parent', space: 'demo', path: 'new-page.md', kind: 'doc', title: 'AI slop vs Human-likeness', order: 0,
                  status: 'published', updatedAt: '',
                  children: [{ id: 'child', space: 'demo', path: 'new-page/profiles.md', kind: 'doc', title: 'Profiles', order: 0, status: 'published', updatedAt: '', children: [] }],
                },
              ],
            },
          ],
        },
      },
    );

    expect(await screen.findByRole('button', { name: 'AI slop vs Human-likeness' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New Page' })).toBeNull();
  });

  it('asks the server to resolve the DIRECTORY, not "<dir>/index.md"', async () => {
    const { calls } = renderCrumbs(() => jsonResponse({ id: 'page-handbook', path: 'handbook/index.md' }));
    fireEvent.click(screen.getByRole('button', { name: 'Handbook' }));
    await waitFor(() => expect(calls.some((c) => c.startsWith('/api/resolve'))).toBe(true));
    const resolveCall = calls.find((c) => c.startsWith('/api/resolve'))!;
    expect(decodeURIComponent(resolveCall)).toContain('path=handbook');
    // The old shape — which also missed README-indexed directories.
    expect(decodeURIComponent(resolveCall)).not.toContain('handbook/index.md');
  });

  it('navigates to the resolved page when the directory has one', async () => {
    renderCrumbs(() => jsonResponse({ id: 'page-handbook', path: 'handbook/index.md' }));
    fireEvent.click(screen.getByRole('button', { name: 'Handbook' }));
    await waitFor(() => expect(path()).toBe('/s/demo/p/page-handbook'));
  });

  it('falls through to the folder listing when the directory has no page (was: a toast and no navigation)', async () => {
    renderCrumbs(() => jsonResponse({ error: 'page not found' }, 404));
    fireEvent.click(screen.getByRole('button', { name: 'Onboarding' }));
    await waitFor(() => expect(path()).toBe('/s/demo/d/handbook/onboarding'));
  });

  it('keeps the toast for a real failure, localized rather than raw English (QA-3 #9)', async () => {
    renderCrumbs(() => jsonResponse({ error: 'requires viewer+ role in this space' }, 403));
    fireEvent.click(screen.getByRole('button', { name: 'Handbook' }));
    await waitFor(() => expect(screen.getByText(/Needs the “Viewer” role/)).toBeTruthy());
    expect(path()).toBe('/s/demo/p/page-1');
  });
});
