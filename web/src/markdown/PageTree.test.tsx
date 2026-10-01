// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import { PageTree } from './PageTree';

// Pinned rather than left to the standalone fallback's own default, so
// these assertions check the language they are written against.
beforeEach(async () => {
  await i18next.changeLanguage('en');
});

function mockFetchOnce(response: { ok: boolean; status?: number; body?: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 404),
      json: () => Promise.resolve(response.body ?? {}),
    }),
  );
}

function renderTree(pageId: string, depth: number) {
  return render(
    <MemoryRouter>
      <PageTree pageId={pageId} depth={depth} />
    </MemoryRouter>,
  );
}

describe('PageTree', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows a loading state, then the fetched children', async () => {
    mockFetchOnce({
      ok: true,
      body: {
        children: [
          { id: 'p1', space: 'sp', path: 'a.md', title: 'Alpha', children: [] },
          { id: 'p2', space: 'sp', path: 'b.md', title: 'Beta', icon: '🚀', children: [] },
        ],
      },
    });
    renderTree('root', 2);
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.getByText(/🚀/)).toBeTruthy();
  });

  it('renders nested children indented under their parent', async () => {
    mockFetchOnce({
      ok: true,
      body: {
        children: [
          {
            id: 'p1',
            space: 'sp',
            path: 'a.md',
            title: 'Parent',
            children: [{ id: 'p1a', space: 'sp', path: 'a/child.md', title: 'Child', children: [] }],
          },
        ],
      },
    });
    renderTree('root', 2);
    await waitFor(() => expect(screen.getByText('Parent')).toBeTruthy());
    expect(screen.getByText('Child')).toBeTruthy();
  });

  it('shows the empty state for a page with no children', async () => {
    mockFetchOnce({ ok: true, body: { children: [] } });
    renderTree('root', 2);
    await waitFor(() => expect(screen.getByText('No child pages')).toBeTruthy());
  });

  it('degrades to the empty state on a 404 (endpoint not live yet) instead of crashing', async () => {
    mockFetchOnce({ ok: false, status: 404 });
    renderTree('root', 2);
    await waitFor(() => expect(screen.getByText('No child pages')).toBeTruthy());
  });

  it('degrades to the empty state on a 401/403 (e.g. an anonymous share guest)', async () => {
    mockFetchOnce({ ok: false, status: 403 });
    renderTree('root', 2);
    await waitFor(() => expect(screen.getByText('No child pages')).toBeTruthy());
  });

  it('degrades to the empty state on a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network down')),
    );
    renderTree('root', 2);
    await waitFor(() => expect(screen.getByText('No child pages')).toBeTruthy());
  });

  it('requests the given depth in the query string', async () => {
    mockFetchOnce({ ok: true, body: { children: [] } });
    renderTree('page-123', 4);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/pages/page-123/subtree?depth=4')));
  });
});
