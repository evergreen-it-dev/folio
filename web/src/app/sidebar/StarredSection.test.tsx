// @vitest-environment jsdom
/**
 * A dead star in the favourites.
 *
 * The owner saw an "Unavailable" line in the favourites and could neither
 * understand what it had been nor remove it. There are exactly two reasons
 * for it, and they DIFFER (server/auth/session.ts requirePageRole): the page
 * is gone — 404, or it exists but the space is somebody else's — 403. After
 * R27 (an instance admin no longer reads everything) the second case became
 * a regular outcome, not an anomaly, so they must not be mixed into one word.
 *
 * The tests hold three things: 404 and 403 say different things, and in both
 * cases the star can be removed — otherwise the line stays a dead end forever.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import { StarredSection } from './StarredSection';
import '../i18n/register';

const DEAD_ID = '01DEADPAGE00000000000000';

function stubFetch(pageStatus: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

      if (url.includes('/api/me/stars')) return json({ spaces: [], pages: [DEAD_ID], emoji: [] });
      if (url.includes('/api/spaces') && !url.includes('/tree')) return json([]);
      if (url.includes('/tree')) return json({ tree: [] });
      if (url.includes(`/api/pages/${DEAD_ID}`)) return json({ error: 'nope' }, pageStatus);
      return json({});
    }),
  );
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StarredSection space="strategy" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('StarredSection — a star whose page cannot be opened', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('says the page was DELETED on a 404, not a vague "unavailable"', async () => {
    await i18next.changeLanguage('en');
    stubFetch(404);
    renderSection();

    expect(await screen.findByText('Page deleted')).toBeTruthy();
    // Now that the trash exists, the hint has to lead to it.
    expect(screen.getByTitle(/trash/i)).toBeTruthy();
    expect(screen.queryByText('No access')).toBeNull();
  });

  it('says ACCESS is missing on a 403 — a different cause needing a different action', async () => {
    await i18next.changeLanguage('en');
    stubFetch(403);
    renderSection();

    expect(await screen.findByText('No access')).toBeTruthy();
    expect(screen.queryByText('Page deleted')).toBeNull();
  });

  it('lets the dead star be removed, so the row is never a dead end', async () => {
    await i18next.changeLanguage('en');
    stubFetch(404);
    renderSection();

    const remove = await screen.findByRole('button', { name: 'Remove from favourites' });
    fireEvent.click(remove);

    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes(`/api/me/stars/page/${DEAD_ID}`))).toBe(true);
    });
  });
});
