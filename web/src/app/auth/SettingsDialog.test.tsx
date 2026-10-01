// @vitest-environment jsdom
/**
 * Round 28 — "Personal settings" moved the four personal controls out of
 * the user menu into a dialog of their own and added the one field the menu
 * never had: your own display name.
 *
 * These tests drive the REAL UserMenu inside the REAL AuthProvider (only
 * `fetch` is stubbed), because the two things worth guarding here are exactly
 * the seams a component-in-isolation test would mock away: that the menu
 * item actually opens the dialog, and that a saved name propagates back
 * through ['auth', 'state'] into the menu's own label and avatar initials.
 * The moved UsernameField keeps its own pre-move test file
 * (UsernameField.test.tsx) — the 409 case is re-checked here only in its new
 * setting (inside the modal portal), not re-litigated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import type { User } from '@shared/contracts';
import { SettingsProvider } from '../settings';
import { ToastProvider } from '../ui/Toast';
import { AuthProvider } from './AuthProvider';
import { UserMenu } from './UserMenu';
import '../i18n/register';

// The whole app is Russian-language today (see pipeline.test.ts's own note)
// — pin the test's i18next instance so string assertions check real copy.
beforeEach(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear(); // SettingsProvider persists width/theme here
});

const BASE_USER: User = {
  id: 'u1',
  email: 'ann@folio.local',
  name: 'Anna Lee',
  isAdmin: false,
  createdAt: '2024-01-01T00:00:00.000Z',
  username: 'ann',
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

/**
 * Routes the three endpoints this screen touches: GET /api/auth/state (the
 * AuthProvider gate), GET /api/me/stars (its boot prefetch) and PATCH
 * /api/me/preferences. The PATCHed fields are folded into the stored user so
 * the auth/state refetch that the save triggers returns the NEW value — i.e.
 * the live-update path is real here, not simulated.
 */
function stubApi(options: { user?: User; failPreferences?: { status: number; error: string } } = {}) {
  let user: User = { ...BASE_USER, ...options.user };
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/auth/state') return Promise.resolve(jsonResponse({ needsSetup: false, user, memberships: {} }));
    if (url === '/api/me/stars') return Promise.resolve(jsonResponse({ spaces: [], pages: [], emojis: [] }));
    if (url === '/api/me/preferences') {
      if (options.failPreferences) {
        return Promise.resolve(jsonResponse({ error: options.failPreferences.error }, options.failPreferences.status));
      }
      user = { ...user, ...(JSON.parse(String(init?.body)) as Partial<User>) };
      return Promise.resolve(jsonResponse(user));
    }
    return Promise.resolve(jsonResponse({ error: `unexpected ${url}` }, 500));
  });
  vi.stubGlobal('fetch', fetchMock);
  const preferenceCalls = () => fetchMock.mock.calls.filter(([url]) => url === '/api/me/preferences');
  return { fetchMock, preferenceCalls };
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

/** Waits for the auth gate to resolve, then opens the menu and its "Settings" item. */
async function openSettings() {
  fireEvent.click(await screen.findByRole('button', { name: 'User menu' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Settings' }));
  return screen.getByRole('dialog', { name: 'Personal settings' });
}

describe('SettingsDialog (round 28)', () => {
  it('opens from the user menu and shows all five personal controls', async () => {
    stubApi();
    renderMenu();

    // The personal block is gone from the dropdown itself — one item now.
    fireEvent.click(await screen.findByRole('button', { name: 'User menu' }));
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(screen.queryByLabelText('Username (@…)')).toBeNull();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Settings' }));

    const dialog = screen.getByRole('dialog', { name: 'Personal settings' });
    expect(dialog).toBeTruthy();
    // 1-2: the two identity fields (name is new this round).
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Anna Lee');
    expect((screen.getByLabelText('Username (@…)') as HTMLInputElement).value).toBe('ann');
    // 3-5: the three preference segmented controls, moved verbatim.
    expect(screen.getByText('Width')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Narrow' })).toBeTruthy();
    expect(screen.getByText('Theme')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'System' })).toBeTruthy();
    expect(screen.getByText('Language')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'English' })).toBeTruthy();
  });

  it('PATCHes the trimmed name and updates the menu label and avatar initials without a reload', async () => {
    const { fetchMock, preferenceCalls } = stubApi();
    renderMenu();
    await openSettings();

    const input = screen.getByLabelText('Name');
    fireEvent.change(input, { target: { value: '  Anna Kim  ' } });
    fireEvent.blur(input);

    await waitFor(() => expect(preferenceCalls()).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/me/preferences',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Anna Kim' }) }),
    );

    // The save invalidates ['auth', 'state']; the refetch returns the new
    // name, so the menu's own label and initials re-render from it.
    expect(await screen.findByText('Anna Kim')).toBeTruthy();
    expect(screen.getByText('AK')).toBeTruthy();
    expect(screen.queryByText('Anna Lee')).toBeNull();
    expect(screen.queryByText('AL')).toBeNull();
  });

  it('does not PATCH when the name is unchanged after trimming', async () => {
    const { preferenceCalls } = stubApi();
    renderMenu();
    await openSettings();

    const input = screen.getByLabelText('Name');
    fireEvent.change(input, { target: { value: '  Anna Lee  ' } });
    fireEvent.blur(input);

    await Promise.resolve(); // give an accidental async call a chance to fire before asserting it didn't
    expect(preferenceCalls()).toHaveLength(0);
    expect((input as HTMLInputElement).value).toBe('Anna Lee');
  });

  it('rejects an empty (or whitespace-only) name client-side: no PATCH, a toast, and the saved name back in the field', async () => {
    const { preferenceCalls } = stubApi();
    renderMenu();
    await openSettings();

    const input = screen.getByLabelText('Name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe("Name can't be empty"));
    expect(preferenceCalls()).toHaveLength(0);
    expect(input.value).toBe('Anna Lee');
    expect(screen.getByText('Anna Lee')).toBeTruthy(); // menu label untouched
  });

  it('Escape in a field reverts that field only — the dialog itself stays open', async () => {
    const { preferenceCalls } = stubApi();
    renderMenu();
    await openSettings();

    const input = screen.getByLabelText('Name') as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: 'Anna Kim' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(input.value).toBe('Anna Lee');
    // Modal closes on Escape via its own document-level listener; the field
    // stops propagation, so the first press only reverts the draft.
    expect(screen.queryByRole('dialog', { name: 'Personal settings' })).toBeTruthy();
    await Promise.resolve();
    expect(preferenceCalls()).toHaveLength(0);

    // Counter-check, so the assertion above can't pass for the wrong reason:
    // the SAME event from a control that does NOT stop propagation does reach
    // the Modal's document listener and closes the dialog.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Narrow' }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Personal settings' })).toBeNull());
  });

  it('reverts and toasts when the server refuses the name', async () => {
    stubApi({ failPreferences: { status: 500, error: 'boom' } });
    renderMenu();
    await openSettings();

    const input = screen.getByLabelText('Name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Anna Kim' } });
    fireEvent.blur(input);

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe("Couldn't save the name"));
    expect(input.value).toBe('Anna Lee');
  });

  it('keeps the username 409 path working now that the field lives in the dialog', async () => {
    stubApi({ failPreferences: { status: 409, error: 'this username is already taken' } });
    renderMenu();
    await openSettings();

    const input = screen.getByLabelText('Username (@…)') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'bob' } });
    fireEvent.blur(input);

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('That username is already taken'));
    await waitFor(() => expect(input.value).toBe('ann'));
  });
});
