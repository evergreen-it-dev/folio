// @vitest-environment jsdom
/**
 * A page that did not open: 404 and 403 are different answers and get
 * different screens (they used to share one «404 + Request access» view).
 *  - 404 -> NotFound: the page is not there, nothing to ask for.
 *  - 403 -> NoAccess: it exists; the request-access button appears only when
 *    the caller has no role in the route's space.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import i18next from 'i18next';
import type { SpaceRole } from '@shared/contracts';
import { ApiError, api } from '../api';
import { PageView } from './PageView';
import '../i18n/register';

// Only the error screens are under test; the editors are heavy and irrelevant.
vi.mock('../../editor', () => ({ PageEditor: () => null }));
vi.mock('../../diagrams', () => ({ BoardEditor: () => null }));
vi.mock('../Shell', () => ({ useSetHeaderInfo: () => undefined }));

const role = vi.hoisted(() => ({ current: undefined as SpaceRole | undefined }));
vi.mock('../auth/AuthProvider', () => ({
  useSpaceRole: () => role.current,
  useAuthOptional: () => ({ user: { isAdmin: false } }),
}));

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

beforeEach(() => {
  role.current = undefined;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/s/secret/p/page-1']}>
        <Routes>
          <Route path="/s/:space/p/:id" element={<PageView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PageContent, a page that did not open', () => {
  it('404 -> the plain 404 screen: no rights hint, no request button', async () => {
    vi.spyOn(api, 'getPage').mockRejectedValue(new ApiError(404, 'page not found'));
    renderPage();
    await waitFor(() => expect(screen.getByText('404')).toBeTruthy());
    expect(screen.getByText(/wasn't found/)).toBeTruthy();
    expect(screen.queryByText(/access/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request access' })).toBeNull();
  });

  it('403 without a role in the space -> "no access" with the request button, not a 404', async () => {
    vi.spyOn(api, 'getPage').mockRejectedValue(new ApiError(403, 'requires viewer+ role on this page'));
    renderPage();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'No access' })).toBeTruthy());
    expect(screen.queryByText('404')).toBeNull();
    expect(screen.getByText(/You don't have access to the space “secret”/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request access' })).toBeTruthy();
  });

  it('403 for a member of the space -> the page is restricted; the request is for the PAGE (its id is passed down)', async () => {
    role.current = 'editor';
    vi.spyOn(api, 'getPage').mockRejectedValue(new ApiError(403, 'requires viewer+ role on this page'));
    const state = vi.spyOn(api, 'getPageAccessRequestState').mockResolvedValue({ pending: false });
    renderPage();
    await waitFor(() => expect(screen.getByText(/open only to specific people/)).toBeTruthy());
    expect(screen.queryByText('404')).toBeNull();
    expect(await screen.findByRole('button', { name: 'Request access' })).toBeTruthy();
    expect(state).toHaveBeenCalledWith('page-1');
  });
});
