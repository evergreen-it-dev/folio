// @vitest-environment jsdom
/**
 * Round 22b: GitCredentialsSettings grew a "Confluence" tab alongside its
 * original Git list (same dialog, same "Git access" menu entry — see that
 * file's own doc comment for why the dialog wasn't renamed). This is the
 * wiring test — does switching tabs actually swap the content — not a
 * re-test of either list's own list/delete/notLive behavior, which already
 * have their own focused coverage (GitCredentialForm.test.tsx and
 * ConfluenceCredentialsSection.test.tsx respectively).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import { ToastProvider } from '../ui/Toast';
import { GitCredentialsSettings } from './GitCredentialsSettings';

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

function stubApi() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/me/git-credentials') return jsonResponse({ credentials: [] });
    if (url === '/api/me/confluence-credentials') return jsonResponse({ credentials: [] });
    return jsonResponse({ error: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <GitCredentialsSettings onClose={vi.fn()} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('GitCredentialsSettings — Git/Confluence tabs (round 22b)', () => {
  it('opens on the Git tab, showing the Git-specific empty state and "connect" prompt', async () => {
    stubApi();
    renderDialog();

    expect(screen.getByRole('tab', { name: 'Git' }).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(screen.getByText('No saved credentials yet.')).toBeTruthy());
    expect(screen.getByText('Connect GitLab/GitHub')).toBeTruthy();
    expect(screen.queryByText('No saved Confluence credentials yet.')).toBeNull();
  });

  it('switching to the Confluence tab swaps in that section and hides the Git list', async () => {
    stubApi();
    renderDialog();
    await waitFor(() => expect(screen.getByText('No saved credentials yet.')).toBeTruthy());

    fireEvent.click(screen.getByRole('tab', { name: 'Confluence' }));

    await waitFor(() => expect(screen.getByText('No saved Confluence credentials yet.')).toBeTruthy());
    expect(screen.queryByText('No saved credentials yet.')).toBeNull();
    expect(screen.queryByText('Connect GitLab/GitHub')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Confluence' }).getAttribute('aria-selected')).toBe('true');
  });
});
