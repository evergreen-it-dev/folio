// @vitest-environment jsdom
/**
 * Round 19 QA fix (#4, orchestrator diagnosis on prod bef85b6): the "Share"
 * dropdown was reported stuck at "Loading…" forever on kind=board
 * pages, never reaching "Create link" — even though GET
 * /api/pages/:id/shares itself answers 200 instantly. DEV-PLAN.md's Round 19
 * SHELL section names a specific suspicion: "pageId does not reach
 * ShareButton through HeaderInfo from boards".
 *
 * That suspicion doesn't hold up against the actual code: PageContent.tsx
 * calls useSetHeaderInfo(data ? { pageId: data.id, ... } : null)
 * UNCONDITIONALLY, before its `if (data.kind === 'board')` branch — and
 * PageMeta.id is a required (non-optional) string in shared/contracts.ts
 * regardless of kind. So pageId reaches Header (and then ShareButton, which
 * Header only ever mounts once pageId is truthy) exactly the same way for a
 * board as for a doc; nothing in the app/ pipeline branches on `kind` at
 * all. The most likely actual contributor (see this file's second test, and
 * the SHELL agent's report): BoardCanvas.tsx (web/src/diagrams — a
 * different agent's zone) independently re-fetches the very same
 * `/api/pages/:id` URL PageContent already fetched via react-query (see
 * diagrams/boardEndpoints.ts's loadUrl), which for a board with a large
 * embedded-scene svg can compete with the shares fetch for the browser's
 * per-origin connection budget alongside the (large) lazily-loaded
 * @excalidraw/excalidraw chunk — plausible on a real network, invisible in
 * jsdom, and outside this agent's editable zone regardless.
 *
 * What IS pinned down here, defensively, both as a regression guard for the
 * one thing that actually matters (the dropdown must leave "loading" once
 * the request resolves, whatever pageId it was given) and for the `enabled`
 * guard added to ShareButton.tsx alongside this test.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import { ToastProvider } from '../ui/Toast';
import { ShareButton } from './ShareButton';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderShareButton(pageId: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ShareButton pageId={pageId} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function openDropdown() {
  fireEvent.click(screen.getByRole('button', { name: 'Share' }));
}

describe('ShareButton — board dropdown loading regression (Round 19 #4)', () => {
  it('leaves the loading state and shows "Create link" once GET .../shares resolves, for a board-shaped pageId same as any other page', async () => {
    let resolveFetch!: (value: unknown) => void;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderShareButton('board-1');
    openDropdown();

    // Two sections ("Can view" / "Can edit") both read shares.isLoading —
    // this is what "hangs on Loading…" looks like while unresolved.
    expect(screen.getAllByText('Loading…').length).toBe(2);

    resolveFetch({ ok: true, status: 200, json: () => Promise.resolve({ shares: [] }) });

    await waitFor(() => expect(screen.getAllByText('Create link').length).toBe(2));
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/api/pages/board-1/shares', expect.anything());
  });

  it('never issues the shares request for an empty pageId (the enabled guard added alongside this test)', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderShareButton('');
    openDropdown();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
