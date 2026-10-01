// @vitest-environment jsdom
/**
 * Round 8 follow-up (P1, reported live on prod, confirmed real on a static
 * production build — not an HMR artifact): the history/share header icon
 * buttons were reported to visually multiply, one extra surviving each page
 * navigation, reaching a count matching the page's own history-entry count.
 *
 * The coordinator's specific suspected mechanism: "HeaderInfo registration
 * timing (useSetHeaderInfo effect cleanup vs. the key={pageId} remount
 * racing — if the OLD HistoryButton's unmount runs AFTER the new one
 * registers, or if useSetHeaderInfo pushes into something that renders a
 * button per active registration)". This exercises exactly that path using
 * the REAL, unmodified Shell (which owns the only instance of
 * SetHeaderInfoContext — it isn't exported, so there's no way to test the
 * real useSetHeaderInfo hook against a stand-in provider) and the REAL
 * Header. Only Sidebar (irrelevant to this bug, and heavy — its own
 * template/git/member queries) and useSpaceRole (needs a real session) are
 * mocked.
 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { useContext, createContext } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import i18next from 'i18next';
import { ToastProvider } from './ui/Toast';
import { Shell, useSetHeaderInfo } from './Shell';
import './i18n/register';

// Round 10: header labels are i18next-driven now — pin the language so the
// aria-label selectors below (written against the Russian copy) match,
// rather than whatever the standalone fallback's own default ('uk') would
// otherwise produce.
beforeAll(async () => {
  await i18next.changeLanguage('en');
});

vi.mock('./auth/AuthProvider', () => ({
  useSpaceRole: () => 'editor' as const,
  // Shell's subtree reaches useAuth(); a plain non-admin stand-in is all this test needs.
  useAuth: () => ({ user: { id: 'u1', name: 'Test User', email: 't@t.local', isAdmin: false, createdAt: '' }, memberships: {}, logout: () => {}, loggingOut: false }),
}));

// Irrelevant to this bug and heavy (templates/git-status/member queries) —
// stubbed to isolate the header relay under test.
vi.mock('./sidebar/Sidebar', () => ({
  Sidebar: () => null,
}));

/**
 * Stands in for PageContent.tsx: the exact same
 * useSetHeaderInfo(data ? {...} : null) call, driven by a `pageId` prop the
 * test controls directly instead of a real useQuery. The query itself isn't
 * what's under suspicion — its loading -> data transition (pageId passing
 * through null on the way to a new value, exactly as PageContent's own
 * `data` does while react-query refetches for a new id) is, and this
 * reproduces that transition exactly, through the real hook.
 */
function FakePageContent({ pageId }: { pageId: string | null }) {
  useSetHeaderInfo(pageId ? { pageId, pagePath: `${pageId}.md`, title: `Page ${pageId}` } : null);
  return null;
}

// A stable pageId -> the harness renders <FakePageContent pageId={current} />
// through this so re-render() calls (rather than fresh route navigations)
// are enough to drive the SAME useSetHeaderInfo effect timing real
// navigation does — the mechanism under suspicion lives entirely in that
// hook + Header's key={pageId}, not in react-router's own remount behavior.
const CurrentPageIdContext = createContext<string | null>(null);
function RoutedFakePageContent() {
  const pageId = useContext(CurrentPageIdContext);
  return <FakePageContent pageId={pageId} />;
}

function harness() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(['spaces'], { spaces: [{ slug: 'test-space', name: 'Test Space', pageCount: 5 }] });
  for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']) {
    queryClient.setQueryData(['page-shares', id], { shares: [] });
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function renderWith(pageId: string | null) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <MemoryRouter initialEntries={['/s/test-space']}>
              <CurrentPageIdContext.Provider value={pageId}>
                <Routes>
                  <Route path="/s/:space" element={<Shell />}>
                    <Route index element={<RoutedFakePageContent />} />
                  </Route>
                </Routes>
              </CurrentPageIdContext.Provider>
            </MemoryRouter>
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
  }

  function historyButtonCount() {
    return container.querySelectorAll('[aria-label="History"]').length;
  }
  function shareButtonCount() {
    return container.querySelectorAll('[aria-label="Share"]').length;
  }

  return { renderWith, historyButtonCount, shareButtonCount, cleanup: () => root.unmount() };
}

describe('Header history/share buttons under repeated pageId changes (P1 repro)', () => {
  it('stays at exactly 1 across a plain sequential sequence of distinct pages', () => {
    const h = harness();
    h.renderWith(null);
    expect(h.historyButtonCount()).toBe(0);
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) {
      h.renderWith(id);
      expect(h.historyButtonCount()).toBe(1);
      expect(h.shareButtonCount()).toBe(1);
    }
    h.cleanup();
  });

  it('stays at exactly 1 when every navigation passes through the null "loading" gap first (real PageContent behavior)', () => {
    // The specific timing the hypothesis targets: the OLD registration's
    // cleanup (setInfo(null), from useSetHeaderInfo's own effect cleanup)
    // landing in a SEPARATE commit right before the new page's data arrives,
    // rather than a single direct A -> B transition.
    const h = harness();
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']) {
      h.renderWith(null); // loading gap, same as PageContent's data === undefined window
      expect(h.historyButtonCount()).toBeLessThanOrEqual(1);
      h.renderWith(id);
      expect(h.historyButtonCount()).toBe(1);
      expect(h.shareButtonCount()).toBe(1);
    }
    h.cleanup();
  });

  it('stays at exactly 1 bouncing back and forth between two pages 5 times (protocol step c: back/forward)', () => {
    const h = harness();
    h.renderWith('p1');
    for (let i = 0; i < 5; i++) {
      h.renderWith('p2');
      expect(h.historyButtonCount()).toBe(1);
      h.renderWith('p1');
      expect(h.historyButtonCount()).toBe(1);
    }
    h.cleanup();
  });

  it('reaches exactly 1 (not 8) after navigating through 8 distinct pages in a row, matching the reported count', () => {
    const h = harness();
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']) {
      h.renderWith(id);
    }
    expect(h.historyButtonCount()).toBe(1);
    expect(h.shareButtonCount()).toBe(1);
    h.cleanup();
  });

  it('async: stays at exactly 1 when each transition is awaited as its own commit (act(async)), not batched together', async () => {
    const h = harness();
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']) {
      await act(async () => {
        h.renderWith(null);
        await Promise.resolve();
        h.renderWith(id);
        await Promise.resolve();
      });
      expect(h.historyButtonCount()).toBe(1);
    }
    h.cleanup();
  });
});
