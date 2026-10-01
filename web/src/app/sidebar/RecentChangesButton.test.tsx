// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import { ToastProvider } from '../ui/Toast';
import { RecentChangesButton } from './RecentChangesButton';
import '../i18n/register';

const change = {
  id: '17',
  action: 'page.rename' as const,
  pageId: 'page-1',
  space: 'demo',
  before: { title: 'Old title', path: 'page.md', parentPath: '', slug: 'page', updatedAt: '2026-09-04T10:00:00.000Z' },
  after: { title: 'New title', path: 'page.md', parentPath: '', slug: 'page', updatedAt: '2026-09-04T10:01:00.000Z' },
  at: '2026-09-04T10:01:00.000Z',
};

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderButton(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/s/demo/p/page-1']}>
          <RecentChangesButton space="demo" />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('RecentChangesButton', () => {
  it('shows "was → became" on hover and undoes the chosen action', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/spaces/demo/changes?limit=10') {
        return new Response(JSON.stringify({ changes: [change] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === '/api/spaces/demo/changes/17/undo' && init?.method === 'POST') {
        return new Response(JSON.stringify({ undone: change, page: { id: 'page-1', space: 'demo', path: 'page.md', kind: 'doc', title: 'Old title', order: 1, status: 'published', updatedAt: change.before.updatedAt } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    });
    renderButton(fetchMock);

    const trigger = await screen.findByRole('button', { name: 'Undo' });
    fireEvent.mouseEnter(trigger);
    expect(await screen.findByText('My recent changes')).toBeTruthy();
    expect(screen.getByText('Old title → New title')).toBeTruthy();

    fireEvent.click(screen.getByTitle('Undo this change'));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/changes/17/undo') && (init as RequestInit)?.method === 'POST')).toBe(true);
    });
    expect(await screen.findByText('Latest change undone')).toBeTruthy();
  });
});
