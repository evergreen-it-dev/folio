// @vitest-environment jsdom
/**
 * Round 27 (access and rights) — smoke coverage for the consolidated "Access"
 * page (docs/spec-access.md §6): the instance-admin gate, the three tabs
 * rendering off one shared GET /api/access/matrix fetch, and the Matrix
 * tab's grey "viewer (all)" cell for an instance-visibility space (the one
 * piece of matrix logic that's easy to get backwards — see logic.test.ts for
 * the underlying pure-function coverage this exercises through real DOM).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { AccessMatrixResponse } from '@shared/contracts';
import { ToastProvider } from '../../ui/Toast';
import { AccessAdmin } from './AccessAdmin';

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

const MATRIX: AccessMatrixResponse = {
  users: [
    { id: 'admin-1', name: 'Admin One', email: 'admin@t.local', isAdmin: true, disabled: false },
    { id: 'u-3', name: 'Editor Person', email: 'editor@t.local', isAdmin: false, disabled: false },
    { id: 'u-4', name: 'Disabled Person', email: 'disabled@t.local', isAdmin: false, disabled: true },
  ],
  spaces: [
    { slug: 'eng', name: 'Engineering', visibility: 'private' },
    { slug: 'general', name: 'General', visibility: 'instance' },
  ],
  roles: { 'u-3': { eng: 'editor' } },
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

function stubApi(adminSpaces: unknown[] = []) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/access/matrix') return jsonResponse(MATRIX);
    if (url === '/api/admin/spaces') return jsonResponse(adminSpaces);
    if (url === '/api/users') return jsonResponse({ users: MATRIX.users.map((u) => ({ ...u, createdAt: '' })) });
    return jsonResponse({ error: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/admin/access']}>
          <AccessAdmin />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('AccessAdmin', () => {
  it('blocks a non-admin with the standard "no access" screen', () => {
    currentUser = NON_ADMIN_USER;
    stubApi();
    renderPage();
    expect(screen.getByText("You don't have access to this page.")).toBeTruthy();
  });

  it('an instance admin sees the three tabs and the People tab by default, listing every user', async () => {
    currentUser = ADMIN_USER;
    stubApi();
    renderPage();

    expect(await screen.findByText('Editor Person')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'People' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Matrix' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Spaces' })).toBeTruthy();
    // Explicit chip for the editor's one membership.
    expect(screen.getByText(/eng: Editor/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Disabled 1' })).toBeTruthy();
    expect(screen.getByText('Deactivated')).toBeTruthy();
  });

  it('Spaces tab shows repository, sync metadata, ZIP export and manual sync for a git-backed space', async () => {
    currentUser = ADMIN_USER;
    stubApi([
      {
        slug: 'docs',
        name: 'Docs',
        kind: 'remote',
        pageCount: 12,
        members: [],
        visibility: 'private',
        adminCount: 0,
        git: {
          repoUrl: 'git@example.com:team/docs.git',
          branch: 'main',
          rootPath: '',
          status: 'clean',
          ahead: 0,
          behind: 0,
          lastSyncAt: '2026-09-02T08:00:00.000Z',
          lastSyncByName: 'Admin One',
          lastSyncByEmail: 'admin@t.local',
          lastError: null,
        },
      },
    ]);
    renderPage();
    await screen.findByText('Editor Person');
    fireEvent.click(screen.getByRole('tab', { name: 'Spaces' }));

    expect((await screen.findByRole('link', { name: /example.com\/team\/docs/ })).getAttribute('href')).toBe('https://example.com/team/docs');
    // Round 02.09: space actions (ZIP export, sync) collapsed into a "more actions" menu.
    fireEvent.click(screen.getByRole('button', { name: 'Space actions' }));
    expect(screen.getByRole('menuitem', { name: 'ZIP' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Sync now' })).toBeTruthy();
    expect(screen.getByText(/Admin One/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Private' }));
    expect(screen.getByRole('heading', { name: 'Make "Docs" instance-wide?' })).toBeTruthy();
    expect(screen.queryByText(/\{\{space\}\}/)).toBeNull();
  });

  it('Matrix tab: an instance-visibility space with no explicit row renders the grey implicit-viewer cell, not a role dropdown', async () => {
    currentUser = ADMIN_USER;
    stubApi();
    renderPage();

    await screen.findByText('Editor Person');
    fireEvent.click(screen.getByRole('tab', { name: 'Matrix' }));

    await waitFor(() => expect(screen.getAllByText('viewer (all)').length).toBeGreaterThan(0));
    // Admin has no explicit role anywhere, and 'general' is instance-visible ->
    // Admin, Editor Person and Disabled Person have no explicit role in the
    // instance-visible space, so each receives an implicit viewer cell.
    expect(screen.getAllByText('viewer (all)')).toHaveLength(3);
  });

  it('switching to Spaces tab loads the admin spaces list (degrading to empty state here)', async () => {
    currentUser = ADMIN_USER;
    stubApi();
    renderPage();

    await screen.findByText('Editor Person');
    fireEvent.click(screen.getByRole('tab', { name: 'Spaces' }));

    await waitFor(() => expect(screen.getByText('No spaces yet.')).toBeTruthy());
  });
});
