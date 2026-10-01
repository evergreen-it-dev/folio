// @vitest-environment jsdom
/**
 * SHELL-agent investigation (board "Share" stuck on "Loading…"
 * forever). Orchestrator's dossier (live prod, fiber-level): react-query's
 * own cache for ['page-shares', boardId] is genuinely status:'success',
 * hasData:true, observers:1 — yet the popover DOM never leaves the loading
 * branch. Round 19's `enabled` guard (ShareButton.tsx) didn't fix it.
 * Dossier's leading suspect: ui/Menu.tsx's portal lifecycle — specifically
 * whether a key-driven remount of ShareButton (Header.tsx:
 * `key={`share-${pageId}`}`) strands an extra panel in document.body, or
 * otherwise desyncs the visible panel from the live query state.
 *
 * VERDICT (this file): REFUTED. Driving the REAL Shell + Header +
 * ShareButton + Menu (only Sidebar and useSpaceRole are stood in for,
 * exactly like Shell.headerButtons.test.tsx) with a controllable /shares
 * fetch, all three scenarios below pass cleanly:
 *   - a single mount correctly leaves the loading branch once the fetch
 *     resolves, with exactly one `[role="menu"]` panel throughout;
 *   - the EXACT key-remount Header uses (pageId change while the menu is
 *     open) leaves *zero* orphaned panels in document.body — React's portal
 *     cleanup on unmount is intact here, and the fresh instance resolves
 *     independently and correctly;
 *   - unrelated ancestor re-renders interleaved with the pending fetch don't
 *     strand the popover either.
 * A companion experiment (not kept here) also confirmed a *sibling* Suspense
 * boundary shaped exactly like BoardEditor's `<Suspense><LazyBoardCanvas/></Suspense>`
 * cannot stall ShareButton's own re-render — Suspense boundaries are scoped
 * to their own subtree, as the spec promises.
 *
 * This also directly explains the dossier's item 7 ("two panels" from a
 * crude DOM-text filter after one click): test 1 below reproduces the
 * *exact* string the dossier saw — "Can viewLoading…Can editLoading…"
 * — from a single, real `[role="menu"]` panel. Menu's own panel wrapper
 * (`role="menu"`) and ShareButton's inner `<div className="w-72 p-1">`
 * both contain that identical concatenated text, so a text-content filter
 * necessarily double-counts one panel's two nested layers. Not two panels.
 *
 * Cross-checked against the installed react-query source
 * (node_modules/@tanstack/query-core/build/modern/queryObserver.js:310):
 * `isLoading = isPending && isFetching`, i.e. `isLoading` is *definitionally*
 * false whenever `status === 'success'`. So the dossier's own cache
 * inspection (status:'success') is logically incompatible with that SAME
 * observer's `isLoading` reading true — whatever is stuck, it is not being
 * driven by the successful observer the dossier found.
 *
 * Structural note for the next hop: ShareButton only ever renders for a
 * user with edit rights on a page, and for that same user on a `kind:
 * 'board'` page, PageContent.tsx *unconditionally* also mounts BoardEditor
 * -> the lazily-loaded `@excalidraw/excalidraw` (web/src/diagrams — a
 * different zone, confirmed to hold no react-query usage, no shared query
 * keys, and no document.body/createPortal calls of its own — see this
 * agent's report). It is structurally impossible to see this bug without
 * Excalidraw mounted alongside ShareButton, which points at that
 * third-party runtime (heavy synchronous init work, or a global
 * capture-phase listener) rather than at anything in web/src/app.
 */
import { act } from 'react';
import { createContext, useContext } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import i18next from 'i18next';
import { ToastProvider } from '../ui/Toast';
import { Shell, useSetHeaderInfo } from '../Shell';
import './../i18n/register';

beforeAll(async () => {
  // Matches the dossier's own observed copy ("Share" / "Loading…").
  await i18next.changeLanguage('en');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

// Tracks every harness() created by the running test so afterEach can tear
// all of them down even when the test threw *before* reaching its own
// h.cleanup() call — otherwise a failing assertion leaks that harness's
// mounted tree (portal included) into document.body for every test that
// runs afterward in this file, corrupting their own DOM-wide assertions
// (menuPanels() etc. would count leftover panels from a previous, already-
// failed test as if they were new evidence of duplication).
const activeRoots: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const { root, container } of activeRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

vi.mock('../auth/AuthProvider', () => ({
  useSpaceRole: () => 'editor' as const,
  // Shell's subtree reaches useAuth(); a plain non-admin stand-in is all this test needs.
  useAuth: () => ({ user: { id: 'u1', name: 'Test User', email: 't@t.local', isAdmin: false, createdAt: '' }, memberships: {}, logout: () => {}, loggingOut: false }),
}));

vi.mock('../sidebar/Sidebar', () => ({
  Sidebar: () => null,
}));

function FakePageContent({ pageId }: { pageId: string | null }) {
  useSetHeaderInfo(pageId ? { pageId, pagePath: `${pageId}.md`, title: `Board ${pageId}` } : null);
  return null;
}

const CurrentPageIdContext = createContext<string | null>(null);
function RoutedFakePageContent() {
  const pageId = useContext(CurrentPageIdContext);
  return <FakePageContent pageId={pageId} />;
}

function harness() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(['spaces'], { spaces: [{ slug: 'test-space', name: 'Test Space', pageCount: 5 }] });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  activeRoots.push({ root, container });

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

  return { container, queryClient, renderWith };
}

/** Stubs global fetch; each call to a given URL parks its own resolver so tests can settle requests one at a time, independently. */
function stubFetch() {
  const pending = new Map<string, Array<(value: unknown) => void>>();
  const fetchMock = vi.fn((url: string) => {
    return new Promise((resolve) => {
      const list = pending.get(url) ?? [];
      list.push(resolve);
      pending.set(url, list);
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    resolveShares(url: string, shares: unknown[] = []) {
      const list = pending.get(url);
      const resolve = list?.shift();
      if (!resolve) throw new Error(`no pending fetch for ${url}`);
      resolve({ ok: true, status: 200, json: () => Promise.resolve({ shares }) });
    },
  };
}

function shareTrigger(container: HTMLElement) {
  return container.querySelector('[aria-label="Share"]') as HTMLButtonElement | null;
}

function menuPanels() {
  return document.body.querySelectorAll('[role="menu"]');
}

/** Generous macrotask+microtask flush — rules out "just needed one more tick" before calling anything a genuine stuck-forever bug. */
async function flushAll() {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

describe('ShareButton on a real Header/Shell tree — board loading-forever regression', () => {
  it('single mount: leaves the loading branch and shows exactly one live panel once GET .../shares resolves', async () => {
    const h = harness();
    const { resolveShares } = stubFetch();

    h.renderWith('board-1');
    const trigger = shareTrigger(h.container);
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger!.click();
    });

    expect(menuPanels().length).toBe(1);
    expect(document.body.textContent).toContain('Loading');

    await act(async () => {
      resolveShares('/api/pages/board-1/shares');
      await flushAll();
    });

    expect(menuPanels().length).toBe(1);
    expect(document.body.textContent).not.toContain('Loading');
    expect(document.body.textContent).toContain('Create link');
  });

  it("key-remount (pageId changes while the menu is open, mirroring Header's key={`share-${pageId}`}): no orphan panel survives in body, and the fresh instance still resolves", async () => {
    const h = harness();
    const { resolveShares } = stubFetch();

    h.renderWith('board-A');
    const triggerA = shareTrigger(h.container);
    await act(async () => {
      triggerA!.click();
    });
    expect(menuPanels().length).toBe(1);
    expect(document.body.textContent).toContain('Loading'); // board-A still pending

    // Simulate navigating to a different board while board-A's popover was open:
    // Header's key={`share-${pageId}`} forces React to unmount the old ShareButton
    // (and its Menu, panel included) and mount a brand new one for board-B.
    await act(async () => {
      h.renderWith('board-B');
    });

    // The old (board-A) panel must not survive the remount as an orphan.
    expect(menuPanels().length).toBe(0);

    // board-A's own fetch resolving LATE (a slow response landing after
    // navigation) must not resurrect/mutate anything now that its owner is gone.
    await act(async () => {
      resolveShares('/api/pages/board-A/shares');
      await flushAll();
    });
    expect(menuPanels().length).toBe(0);

    const triggerB = shareTrigger(h.container);
    await act(async () => {
      triggerB!.click();
    });
    expect(menuPanels().length).toBe(1);
    expect(document.body.textContent).toContain('Loading'); // board-B's own fresh query

    await act(async () => {
      resolveShares('/api/pages/board-B/shares');
      await flushAll();
    });

    expect(menuPanels().length).toBe(1);
    expect(document.body.textContent).not.toContain('Loading');
    expect(document.body.textContent).toContain('Create link');
  });

  it('unrelated ancestor re-renders while the shares fetch is in flight do not strand the panel on the loading branch', async () => {
    const h = harness();
    const { resolveShares } = stubFetch();

    h.renderWith('board-1');
    const trigger = shareTrigger(h.container);
    await act(async () => {
      trigger!.click();
    });
    expect(document.body.textContent).toContain('Loading');

    // Re-render the whole tree several times (e.g. Shell's own collapsed/
    // switcher state, or an unrelated parent) *before* the fetch settles.
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        h.renderWith('board-1');
      });
    }

    await act(async () => {
      resolveShares('/api/pages/board-1/shares');
      await flushAll();
    });

    expect(menuPanels().length).toBe(1);
    expect(document.body.textContent).not.toContain('Loading');
    expect(document.body.textContent).toContain('Create link');
  });
});
