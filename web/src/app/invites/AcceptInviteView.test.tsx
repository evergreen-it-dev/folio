// @vitest-environment jsdom
/**
 * 08.09.2026 (owner request): registration sometimes gets "@username" pasted
 * into the handle field — that used to fail client-side validation before
 * the request ever reached the server (which, as of this round, already
 * accepts and normalizes a leading '@' via usernameSchema/normalizeUsername
 * in shared/contracts.ts). This exercises the real form: typing "@Ivan.K"
 * must enable the submit button (not be rejected by stale client-side
 * regex) and must send the normalized "ivan.k" to the accept-invite
 * endpoint, not the raw "@Ivan.K".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import i18next from 'i18next';
import { SettingsProvider } from '../settings';
import { AcceptInviteView } from './AcceptInviteView';
import '../i18n/register';

beforeEach(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const INVITE_INFO = { valid: true, email: null, spaces: [], invitedBy: 'Admin' };

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

function stubFetch() {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/auth/state') return jsonResponse({ needsSetup: false, user: null, memberships: {} });
    if (url === '/api/invite/tok123') return jsonResponse(INVITE_INFO);
    if (url === '/api/invite/tok123/accept') {
      return jsonResponse({ needsSetup: false, user: { id: 'u1', name: 'Ann', email: 'ann@test.local', isAdmin: false }, memberships: {} });
    }
    throw new Error(`unexpected fetch: ${url} ${JSON.stringify(init)}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderView() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <MemoryRouter initialEntries={['/invite/tok123']}>
          <Routes>
            <Route path="/invite/:token" element={<AcceptInviteView />} />
          </Routes>
        </MemoryRouter>
      </SettingsProvider>
    </QueryClientProvider>,
  );
}

/** Fills every required field except the username, and picks a theme (also required for canSubmit). */
async function fillRequiredFieldsExceptUsername() {
  const nameInput = await screen.findByLabelText('Name');
  fireEvent.change(nameInput, { target: { value: 'Ann' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ann@test.local' } });
  fireEvent.change(screen.getByLabelText('Password (at least 8 characters)'), { target: { value: 'password123' } });
  fireEvent.click(screen.getByRole('button', { name: 'Light' }));
}

describe('AcceptInviteView — @username handling', () => {
  it('accepts a leading "@" and sends the normalized handle to the server', async () => {
    const fetchMock = stubFetch();
    renderView();
    await fillRequiredFieldsExceptUsername();

    const usernameInput = screen.getByPlaceholderText('username');
    fireEvent.change(usernameInput, { target: { value: '@Ivan.K' } });

    const submitButton = screen.getByRole('button', { name: 'Accept and log in' }) as HTMLButtonElement;
    await waitFor(() => expect(submitButton.disabled).toBe(false));

    fireEvent.click(submitButton);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/invite/tok123/accept', expect.anything()));
    const acceptCall = fetchMock.mock.calls.find((c) => c[0] === '/api/invite/tok123/accept')!;
    const body = JSON.parse((acceptCall[1] as RequestInit).body as string);
    expect(body.username).toBe('ivan.k');
  });

  it('rejects a bare "@" and a single letter as too short, but accepts "@ab"', async () => {
    stubFetch();
    renderView();
    await fillRequiredFieldsExceptUsername();

    const usernameInput = screen.getByPlaceholderText('username');
    const submitButton = screen.getByRole('button', { name: 'Accept and log in' }) as HTMLButtonElement;

    fireEvent.change(usernameInput, { target: { value: '@' } });
    expect(submitButton.disabled).toBe(true);

    fireEvent.change(usernameInput, { target: { value: 'a' } });
    expect(submitButton.disabled).toBe(true);

    fireEvent.change(usernameInput, { target: { value: '@ab' } });
    await waitFor(() => expect(submitButton.disabled).toBe(false));
  });

  it('shows the "will be saved as" hint only when normalization actually changes the value', async () => {
    stubFetch();
    renderView();
    await fillRequiredFieldsExceptUsername();

    const usernameInput = screen.getByPlaceholderText('username');

    fireEvent.change(usernameInput, { target: { value: 'ivan.k' } });
    expect(screen.queryByText(/Will be saved as/)).toBeNull();

    fireEvent.change(usernameInput, { target: { value: '@Ivan.K' } });
    expect(screen.getByText('Will be saved as @ivan.k')).toBeTruthy();
  });
});

describe('AcceptInviteView — existing session', () => {
  it('offers primary Continue and secondary Sign out, then accepts into the current account', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/auth/state') {
        return jsonResponse({
          needsSetup: false,
          user: { id: 'u-existing', name: 'Sergii', email: 'sergii@test.local', isAdmin: false },
          memberships: {},
        });
      }
      if (url === '/api/invite/tok123') {
        return jsonResponse({ ...INVITE_INFO, spaces: [{ space: 'team', name: 'Team', role: 'editor' }] });
      }
      if (url === '/api/invite/tok123/accept-existing') {
        return jsonResponse({
          needsSetup: false,
          user: { id: 'u-existing', name: 'Sergii', email: 'sergii@test.local', isAdmin: false },
          memberships: { team: 'editor' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderView();

    const continueButton = await screen.findByRole('button', { name: 'Continue' });
    const signOutButton = screen.getByRole('button', { name: 'Sign out' });
    expect(continueButton.className).toContain('bg-neutral-900');
    expect(signOutButton.className).toContain('border-neutral-300');
    expect(signOutButton.className).not.toContain('bg-neutral-900');

    fireEvent.click(continueButton);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/invite/tok123/accept-existing', expect.anything()),
    );
  });
});
