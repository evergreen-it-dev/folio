// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import { UI_LANGUAGES } from '../i18n/languages';
import { Backlinks } from './Backlinks';

function stubFetch(backlinks: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ backlinks }),
    }),
  );
}

function renderBacklinks(pageId = 'p1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Backlinks pageId={pageId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<Backlinks> heading i18n', () => {
  // The bug this covers was a heading hardcoded in one language that showed
  // up wrong in every other. The heading has to follow the dictionary of the
  // language that is active, so it is read in each of them in turn: a
  // hardcoded literal can match one language at most.
  it('renders the heading from the dictionary of the active language, not a hardcoded literal', async () => {
    const headings = new Set<string>();
    for (const lang of UI_LANGUAGES) {
      await i18next.changeLanguage(lang);
      stubFetch([{ id: 'p2', space: 'eng', path: 'b.md', title: 'Beta' }]);
      renderBacklinks();
      await waitFor(() => expect(screen.getByText('Beta')).toBeTruthy());
      const heading = i18next.t('markdown:backlinks.title');
      expect(screen.getByText(heading), lang).toBeTruthy();
      headings.add(heading);
      cleanup();
    }
    expect(headings.size).toBe(UI_LANGUAGES.length);
  });
});

describe('<Backlinks> behaviour', () => {
  beforeEach(async () => {
    await i18next.changeLanguage('en');
  });

  it('renders nothing while there are no backlinks', async () => {
    stubFetch([]);
    const { container } = renderBacklinks();
    await waitFor(() => expect(container.querySelector('.folio-backlinks')).toBeNull());
  });

  it('lists each backlink page by title once loaded', async () => {
    stubFetch([
      { id: 'p2', space: 'eng', path: 'b.md', title: 'Beta' },
      { id: 'p3', space: 'eng', path: 'c.md', title: 'Gamma' },
    ]);
    renderBacklinks();
    await waitFor(() => expect(screen.getByText('Beta')).toBeTruthy());
    expect(screen.getByText('Gamma')).toBeTruthy();
    expect(screen.getByText('Backlinks')).toBeTruthy();
  });
});
