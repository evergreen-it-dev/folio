// @vitest-environment jsdom
/**
 * The review dialog: a stale proposal says so, shows the differences against the CURRENT text and
 * sends that text's hash with the accept; the bell words the proposal rows and opens the dialog.
 * The network is stubbed at the level of `fetch` (as in header/NotificationsBell.test.tsx).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router';
import i18next from 'i18next';
import type { NotificationListResponse } from '@shared/contracts';
import type { PageProposalDetail, PageProposalSummary } from '@shared/proposals';
import { NotificationsBell } from '../header/NotificationsBell';
import { ReviewDialog } from './ReviewDialog';
import '../i18n/register';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const summary: PageProposalSummary = {
  id: 'p1',
  space: 'docs',
  kind: 'update',
  pageId: 'page1',
  title: 'Handbook',
  parentPath: '',
  status: 'stale',
  authorId: 'u1',
  authorName: 'Agent Owner',
  tokenId: 'tok',
  source: 'mcp',
  reviewerName: null,
  reviewComment: null,
  createdAt: '2026-11-09T10:00:00.000Z',
  updatedAt: '2026-11-09T10:00:00.000Z',
  decidedAt: null,
  resultPageId: null,
};
const detail: PageProposalDetail = { ...summary, markdown: '# Handbook\n\nlimit is 5\n', currentMarkdown: '# Handbook\n\nlimit is 3 (typed)\n', currentHash: 'hash-now' };

function stub(handler: (url: string, init?: RequestInit) => unknown) {
  const fn = vi.fn((url: string, init?: RequestInit) => Promise.resolve({ ok: true, status: 200, statusText: '', json: () => Promise.resolve(handler(url, init)) }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function Where() {
  return <span data-testid="where">{useLocation().pathname + useLocation().search}</span>;
}

describe('ReviewDialog', () => {
  it('shows a stale proposal against the current text and accepts it with that text\'s hash', async () => {
    const fn = stub((url) => {
      if (url.endsWith('/api/proposals/p1')) return detail;
      if (url.includes('/proposals')) return { items: [summary], pendingCount: 1 };
      return { ...detail };
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ReviewDialog space="docs" onClose={() => {}} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/changed since this edit was proposed/i)).toBeTruthy();
    const diff = await screen.findByLabelText('Differences between the page and the proposal');
    expect(diff.textContent).toContain('- limit is 3 (typed)');
    expect(diff.textContent).toContain('+ limit is 5');

    fireEvent.click(await screen.findByRole('button', { name: 'Accept the changes anyway' }));
    await waitFor(() => expect(fn.mock.calls.some(([url, init]) => String(url).endsWith('/api/proposals/p1/decision') && init?.method === 'POST')).toBe(true));
    const post = fn.mock.calls.find(([url]) => String(url).endsWith('/decision'))!;
    expect(JSON.parse(String(post[1]?.body))).toEqual({ decision: 'accept', currentHash: 'hash-now' });
  });
});

describe('NotificationsBell, proposal rows', () => {
  it('words a proposal and opens the review on click', async () => {
    const list: NotificationListResponse = {
      unread: 1,
      items: [
        { id: 'n1', kind: 'proposal_pending', createdAt: '2026-11-09T10:00:00.000Z', readAt: null, pageId: 'page1', payload: { space: 'docs', pageTitle: 'Handbook', authorName: 'Agent Owner', proposalId: 'p1', proposalKind: 'update' } },
        { id: 'n2', kind: 'proposal_decided', createdAt: '2026-11-09T09:00:00.000Z', readAt: null, pageId: null, payload: { space: 'docs', pageTitle: 'Runbook', reviewerName: 'Ed', decision: 'rejected' } },
      ],
    };
    stub(() => list);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <NotificationsBell />
          <Where />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }));
    expect(await screen.findByText('Ed rejected your edit to “Runbook”')).toBeTruthy();
    fireEvent.click(screen.getByText('Agent Owner proposed an edit to “Handbook”'));
    expect(screen.getByTestId('where').textContent).toBe('/s/docs/p/page1?review=p1');
  });
});
