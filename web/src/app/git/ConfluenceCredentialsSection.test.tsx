// @vitest-environment jsdom
/**
 * Round 22b: the "Confluence" tab content inside GitCredentialsSettings'
 * dialog — list + delete for saved Confluence credentials, plus the
 * "not live yet" degrade on a 404 (SERVER landing this in parallel, same
 * convention as tokens/ApiTokensModal.tsx — see that file's own doc comment).
 * Rendered standalone here (not mounted inside GitCredentialsSettings) the
 * same way GitCredentialForm.test.tsx tests GitCredentialForm on its own.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import { ToastProvider } from '../ui/Toast';
import { ConfluenceCredentialsSection } from './ConfluenceCredentialsSection';

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

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ConfluenceCredentialsSection />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ConfluenceCredentialsSection', () => {
  it('shows the empty-state hint when there are no saved credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ credentials: [] })));
    renderSection();
    await waitFor(() => expect(screen.getByText('No saved Confluence credentials yet.')).toBeTruthy());
  });

  it('lists host/kind/email/date for on-prem (PAT) and cloud credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          credentials: [
            { id: 'c1', host: 'tracker.example.com', kind: 'pat', label: 'On-prem', createdAt: '2026-01-01T00:00:00Z' },
            {
              id: 'c2',
              host: 'acme.atlassian.net',
              kind: 'cloud',
              label: 'Cloud',
              email: 'me@acme.com',
              createdAt: '2026-01-02T00:00:00Z',
            },
          ],
        }),
      ),
    );
    renderSection();

    await screen.findByText('On-prem');
    expect(screen.getByText(/On-prem \(PAT\)/)).toBeTruthy();
    expect(screen.getByText(/tracker\.example\.com/)).toBeTruthy();

    expect(screen.getByText('Cloud')).toBeTruthy();
    expect(screen.getByText(/Cloud \(email \+ token\)/)).toBeTruthy();
    expect(screen.getByText(/me@acme\.com/)).toBeTruthy();
    // PAT row must NOT show an email segment at all (kind==='pat' never has one).
    expect(screen.getByText(/tracker\.example\.com/).textContent).not.toContain('@');
  });

  it('deletes a credential after confirming, and the list reflects it', async () => {
    let deleted = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === '/api/me/confluence-credentials' && method === 'GET') {
        return jsonResponse({
          credentials: deleted
            ? []
            : [{ id: 'c1', host: 'tracker.example.com', kind: 'pat', label: 'On-prem', createdAt: '2026-01-01T00:00:00Z' }],
        });
      }
      if (url === '/api/me/confluence-credentials/c1' && method === 'DELETE') {
        deleted = true;
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: 'not found' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSection();
    await screen.findByText('On-prem');

    fireEvent.click(screen.getByRole('button', { name: 'Delete credential "On-prem"' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete credential?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.getByText('No saved Confluence credentials yet.')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith('/api/me/confluence-credentials/c1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('degrades to a quiet "not live" hint on a 404 instead of an error banner or empty-state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'not found' }, 404)));
    renderSection();

    await waitFor(() => expect(screen.getByText('This feature is not available yet.')).toBeTruthy());
    expect(screen.queryByText('No saved Confluence credentials yet.')).toBeNull();
  });
});
