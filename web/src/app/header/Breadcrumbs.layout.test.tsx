// @vitest-environment jsdom
/**
 * QA-3 P1 #1 — "breadcrumbs at 900–1150px lose the title of the current page".
 *
 * jsdom has no layout engine, so the ACTUAL proof of this fix is the
 * puppeteer measurement in `.qa/qa3-shfix2-1.mjs` (real
 * getBoundingClientRect at 375/900/1024/1150/1280/1440 against the running
 * dev server). What is worth pinning HERE is the flexbox contract that the
 * bug was, so a future edit can't silently reintroduce it:
 *
 *   Flexbox splits NEGATIVE free space in proportion to each item's
 *   `flex-shrink × flex-basis`. The title crumb was `flex-1` — `flex: 1 1 0%`
 *   — so its share of that split was 1×0 = 0. It could not shrink, but it
 *   could not claim any width either: at 1024px it measured 8px wide (its
 *   px-1 padding) with 0px of visible text, while the ancestor trail beside
 *   it kept 159px of a 171px <nav>.
 *
 * The two invariants below are exactly what inverts that:
 *   1. the title crumb must NOT be flex-basis:0 (`flex-1`) — `flex-auto`
 *      grows the same way but asks for its own content width;
 *   2. the ancestor trail must shrink far harder than the title
 *      (`shrink-[999]`) and must clip its own shrink-resistant children
 *      (`overflow-hidden`) rather than painting them over the title.
 */
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import { ToastProvider } from '../ui/Toast';
import { Breadcrumbs } from './Breadcrumbs';
import '../i18n/register';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderCrumbs({ canRename = true }: { canRename?: boolean } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ spaces: [] }) }) as unknown as Response),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <Breadcrumbs
            space="demo"
            pagePath="docs/architecture/deep-page-with-a-very-long-title.md"
            title="A deep third-level page with quite a long title"
            pageId="p1"
            canRename={canRename}
          />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  const nav = screen.getByRole('navigation');
  return { nav, trail: nav.firstElementChild!, title: nav.lastElementChild! };
}

describe('Breadcrumbs — width priority: the current page title outranks its ancestors', () => {
  it('gives the title crumb a content-sized flex basis, never flex-1 (basis 0)', () => {
    const { title } = renderCrumbs();
    expect(title.className).toContain('flex-auto');
    // `flex-1` is `flex: 1 1 0%` — the exact shape of the bug.
    expect(title.className.split(/\s+/)).not.toContain('flex-1');
  });

  it('keeps the same contract for the read-only (non-renamable) title crumb', () => {
    const { title } = renderCrumbs({ canRename: false });
    expect(title.className).toContain('flex-auto');
    expect(title.className.split(/\s+/)).not.toContain('flex-1');
  });

  it('makes the ancestor trail shrink far harder than the title, and clip its own children', () => {
    const { trail } = renderCrumbs();
    expect(trail.className).toContain('shrink-[999]');
    expect(trail.className).toContain('overflow-hidden');
    expect(trail.className).toContain('min-w-0');
    // A floor, so collapsing the trail never removes the way back to the space home.
    expect(trail.className).toContain('md:min-w-[3.5rem]');
  });

  it('lets every ancestor segment collapse (they used to be shrink-0 and dumped the whole squeeze on the title)', () => {
    const { trail } = renderCrumbs();
    const segments = Array.from(trail.children).slice(1, -1); // between the home crumb and the trailing "/"
    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) {
      expect(segment.className.split(/\s+/)).not.toContain('shrink-0');
      expect(segment.className).toContain('min-w-0');
      expect(segment.className).toContain('overflow-hidden');
    }
  });

  it('names the space-home crumb on the button itself, so a collapsed trail is still a usable target', () => {
    renderCrumbs();
    // The visible label can ellipsize to nothing; the accessible name must not.
    expect(screen.getByRole('button', { name: 'demo' })).toBeTruthy();
  });
});
