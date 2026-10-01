// @vitest-environment jsdom
/**
 * Round 31 — the "ask for access" button from the 404 screen: it sends the
 * request and turns into text, and a 409 ("access is already there") shows
 * its own clear line, not the raw server error.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import { RequestAccessButton } from './RequestAccessButton';
import '../i18n/register';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubFetch(response: { ok: boolean; status?: number; body?: unknown }) {
  const fn = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 201 : 500),
    statusText: '',
    json: () => Promise.resolve(response.body ?? {}),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderButton() {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RequestAccessButton space="docs" />
    </QueryClientProvider>,
  );
}

describe('RequestAccessButton', () => {
  it('posts the request and turns into a "sent" line', async () => {
    const fetchMock = stubFetch({ ok: true, body: { request: { id: 'r1' } } });
    renderButton();

    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/access-requests',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ space: 'docs' }) }),
      ),
    );
    await waitFor(() => expect(screen.getByText(/Request sent/)).toBeTruthy());
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('explains a 409 in its own words instead of surfacing the server error', async () => {
    stubFetch({ ok: false, status: 409, body: { error: 'you already have access to this space' } });
    renderButton();

    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));

    await waitFor(() => expect(screen.getByText(/You already have access to this space/)).toBeTruthy());
    expect(screen.queryByText(/you already have access to this space\./)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
