// @vitest-environment jsdom
/**
 * The "Assistant analytics" item of the user menu: an instance admin always has it
 * (admin section, no extra request); a space admin gets it when the access query
 * (GET /api/admin/assistant/access) succeeds; everyone else does not — and a refused
 * query must leave the menu exactly as it was. The real UserMenu runs inside the real
 * AuthProvider, only `fetch` is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import type { AdminAssistantAccess, User } from '@shared/contracts';
import { SettingsProvider } from '../settings';
import { ToastProvider } from '../ui/Toast';
import { AuthProvider } from './AuthProvider';
import { UserMenu } from './UserMenu';
import '../i18n/register';

beforeEach(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const USER: User = { id: 'u1', email: 'ann@folio.local', name: 'Anna Lee', isAdmin: false, createdAt: '2024-01-01T00:00:00.000Z', username: 'ann' };

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

function stubApi(options: { isAdmin?: boolean; access: AdminAssistantAccess | 'forbidden' }) {
  const user: User = { ...USER, isAdmin: options.isAdmin ?? false };
  const fetchMock = vi.fn((url: string) => {
    if (url === '/api/auth/state') return Promise.resolve(jsonResponse({ needsSetup: false, user, memberships: {} }));
    if (url === '/api/me/stars') return Promise.resolve(jsonResponse({ spaces: [], pages: [], emojis: [] }));
    if (url === '/api/admin/assistant/access') {
      return Promise.resolve(options.access === 'forbidden' ? jsonResponse({ error: 'requires instance or space admin' }, 403) : jsonResponse(options.access));
    }
    return Promise.resolve(jsonResponse({ error: `unexpected ${url}` }, 500));
  });
  vi.stubGlobal('fetch', fetchMock);
  const accessCalls = () => fetchMock.mock.calls.filter(([url]) => url === '/api/admin/assistant/access').length;
  return { accessCalls };
}

function renderMenu() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SettingsProvider>
          <ToastProvider>
            <AuthProvider>
              <UserMenu />
            </AuthProvider>
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openMenu() {
  fireEvent.click(await screen.findByRole('button', { name: 'User menu' }));
  await screen.findByRole('menuitem', { name: 'Settings' });
}

describe('UserMenu: Assistant analytics item', () => {
  it('shows it to a space admin whose access query succeeds, next to the assistant settings (no Administration heading)', async () => {
    const { accessCalls } = stubApi({ access: { scope: 'spaces', spaces: ['eng'] } });
    renderMenu();
    await waitFor(() => expect(accessCalls()).toBe(1));
    await openMenu();
    expect(await screen.findByRole('menuitem', { name: 'Assistant analytics' })).toBeTruthy();
    expect(screen.queryByText('Administration')).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Users' })).toBeNull();
  });

  it('hides it when the access query is refused (403)', async () => {
    const { accessCalls } = stubApi({ access: 'forbidden' });
    renderMenu();
    await waitFor(() => expect(accessCalls()).toBe(1));
    await openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Assistant analytics' })).toBeNull();
    // the rest of the menu is intact
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeTruthy();
  });

  it('shows it to an instance admin without asking the access endpoint', async () => {
    const { accessCalls } = stubApi({ isAdmin: true, access: { scope: 'instance', spaces: [] } });
    renderMenu();
    await openMenu();
    expect(await screen.findByRole('menuitem', { name: 'Assistant analytics' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Users' })).toBeTruthy();
    expect(accessCalls()).toBe(0);
  });
});
