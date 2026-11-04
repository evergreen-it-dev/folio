// @vitest-environment jsdom
/**
 * An address that points at nothing never ends in a blank screen:
 *  - the id used to mean a page that exists (server: findMovedPage) -> the address bar moves to that page;
 *  - otherwise "moved or removed", with a search and the way back to the space;
 *  - a page that is open when its id disappears gets the same screen (the alive probe sees the 404);
 *  - a failed background refetch (no network, 5xx) leaves an open page alone.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import i18next from 'i18next';
import type { PageDoc, PageMeta } from '@shared/contracts';
import { ApiError, api } from '../api';
import { PageView } from './PageView';
import '../i18n/register';

vi.mock('../../editor', () => ({ PageEditor: () => <div>EDITOR</div> }));
vi.mock('../../diagrams', () => ({ BoardEditor: () => null }));
vi.mock('../Shell', () => ({ useSetHeaderInfo: () => undefined }));
vi.mock('../auth/AuthProvider', () => ({ useSpaceRole: () => 'viewer' }));

beforeAll(async () => {
  await i18next.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderAt(url: string, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Where />
        <Routes>
          <Route path="/s/:space/p/:id" element={<PageView />} />
          <Route path="/s/:space" element={<div>SPACE HOME</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

const doc = (id: string): PageDoc =>
  ({ id, space: 'demo', path: 'a.md', kind: 'doc', title: 'A page', markdown: '# A page\n', updatedAt: '2026-01-01T00:00:00Z' }) as unknown as PageDoc;

describe('a page address that points at nothing', () => {
  it('an old id that meant another page: the address moves to it', async () => {
    vi.spyOn(api, 'getPage').mockImplementation(async (id: string) => {
      if (id === 'NEW') return doc('NEW');
      throw new ApiError(404, 'page not found');
    });
    vi.spyOn(api, 'getMovedPage').mockResolvedValue({ id: 'NEW', space: 'demo', path: 'a.md', title: 'A page' } as unknown as PageMeta);
    vi.spyOn(api, 'getMyPageRole').mockResolvedValue({ role: 'viewer' });
    renderAt('/s/demo/p/OLD');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/s/demo/p/NEW'));
    await waitFor(() => expect(screen.getByText('EDITOR')).toBeTruthy());
  });

  it('nothing it could have meant: a message with a search and a link to the space, not a blank page', async () => {
    vi.spyOn(api, 'getPage').mockRejectedValue(new ApiError(404, 'page not found'));
    vi.spyOn(api, 'getMovedPage').mockRejectedValue(new ApiError(404, 'page not found'));
    renderAt('/s/demo/p/OLD');
    await waitFor(() => expect(screen.getByText('This page moved or was removed')).toBeTruthy());
    expect(screen.getByRole('searchbox', { name: 'Search this space' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to demo' }).getAttribute('href')).toBe('/s/demo');
  });

  it('a page that is open when it disappears gets the same message', async () => {
    let present = true;
    vi.spyOn(api, 'getPage').mockImplementation(async (id: string) => {
      if (present) return doc(id);
      throw new ApiError(404, 'page not found');
    });
    vi.spyOn(api, 'getMovedPage').mockRejectedValue(new ApiError(404, 'page not found'));
    const probe = vi.spyOn(api, 'getMyPageRole').mockResolvedValue({ role: 'viewer' });
    const client = renderAt('/s/demo/p/OPEN');
    await waitFor(() => expect(screen.getByText('EDITOR')).toBeTruthy());
    // The instance is reset: the next probe is a 404.
    present = false;
    probe.mockRejectedValue(new ApiError(404, 'page not found'));
    await client.refetchQueries({ queryKey: ['page-alive', 'OPEN'] });
    await waitFor(() => expect(screen.getByText('This page moved or was removed')).toBeTruthy());
    expect(screen.queryByText('EDITOR')).toBeNull();
  });

  it('a failed background refetch (server unreachable) does not take an open page away', async () => {
    let healthy = true;
    vi.spyOn(api, 'getPage').mockImplementation(async (id: string) => {
      if (healthy) return doc(id);
      throw new ApiError(502, 'bad gateway');
    });
    vi.spyOn(api, 'getMyPageRole').mockResolvedValue({ role: 'viewer' });
    const client = renderAt('/s/demo/p/OPEN');
    await waitFor(() => expect(screen.getByText('EDITOR')).toBeTruthy());
    healthy = false;
    await client.refetchQueries({ queryKey: ['page', 'OPEN'] });
    expect(screen.getByText('EDITOR')).toBeTruthy();
  });
});
