// @vitest-environment jsdom
/**
 * Component-level coverage for the two things pipeline.test.ts's
 * string-level assertions can't reach: the real fetch-and-highlight cycle
 * (round 15's @mentions) and genuine browser interactivity (round 16's
 * details/summary staying natively clickable through the sanitizer).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { MentionableUser } from '@shared/contracts';
import { Markdown } from './index';
import { clearMentionIndex } from './mentionIndex';

const USERS: MentionableUser[] = [{ username: 'ann', name: 'Ann Lee' }];

function stubFetch(users: MentionableUser[] = USERS) {
  const fn = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ users }) });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderMarkdown(markdown: string, extra: { shareToken?: string; pageId?: string } = {}) {
  // A QueryClientProvider is only needed once `pageId` is set (it gates
  // <Backlinks>'s own useQuery, see index.tsx) — added unconditionally here
  // since it's harmless when unused and keeps this one helper usable by
  // every describe block in this file.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Markdown markdown={markdown} space="eng" pagePath="a.md" {...extra} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * jsdom never actually lays anything out — every element's scrollWidth and
 * clientWidth report 0, so a real "does this table overflow" measurement
 * (tableFit.ts's measureWideTables) always reads "not wide" unless stubbed.
 * Stubbing on HTMLElement.prototype (rather than per-node, which would need
 * to run AFTER mount but BEFORE the mount effect — not achievable from
 * outside render(), which flushes effects synchronously) makes every
 * wrapper measure as wide for the tests below; restored afterEach so it
 * can't leak into unrelated tests in this file.
 */
function stubWideTables() {
  // jsdom's real scrollWidth/clientWidth getters live on Element.prototype,
  // not HTMLElement.prototype — Object.getOwnPropertyDescriptor(HTMLElement.
  // prototype, 'scrollWidth') is undefined before this runs, so there is no
  // prior descriptor to restore. `delete` instead, to drop the own property
  // this adds and fall back through the prototype chain to the real one.
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, value: 900 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 300 });
  return () => {
    delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  };
}

beforeEach(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearMentionIndex();
});

describe('<Markdown> @mentions (round 15)', () => {
  it('shows no pill until the mentionable list has loaded, then lights up only the known handle', async () => {
    stubFetch();
    const { container } = renderMarkdown('ping @ann and @ghost');
    expect(container.querySelector('.folio-mention')).toBeNull(); // nothing known yet

    await waitFor(() => expect(container.querySelector('.folio-mention')).not.toBeNull());
    const pills = [...container.querySelectorAll('.folio-mention')];
    expect(pills).toHaveLength(1);
    expect(pills[0]?.textContent).toBe('@ann');
    expect(pills[0]?.getAttribute('title')).toBe('Ann Lee');
    // The unknown handle is still on the page, just never wrapped.
    expect(container.querySelector('.folio-markdown')?.textContent).toContain('@ghost');
  });

  it('never requests the mentionable list for an anonymous share guest', async () => {
    const fetchMock = stubFetch();
    const { container } = renderMarkdown('ping @ann', { shareToken: 'tok123' });
    await waitFor(() => expect(container.querySelector('.folio-markdown')?.textContent).toContain('ping'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector('.folio-mention')).toBeNull();
  });
});

describe('<Markdown> details/summary (round 16)', () => {
  it('toggles open on a summary click — native disclosure behaviour survives the sanitizer', async () => {
    stubFetch();
    const { container } = renderMarkdown('<details><summary>More</summary>\n\nhidden text\n\n</details>');
    const details = await waitFor(() => {
      const el = container.querySelector('details');
      if (!el) throw new Error('not rendered yet');
      return el;
    });
    expect(details.open).toBe(false);
    fireEvent.click(details.querySelector('summary')!);
    expect(details.open).toBe(true);
  });
});

describe('<Markdown> link resolution hints i18n', () => {
  // Both hint messages used to be hardcoded literals in index.tsx. Asserting
  // the dictionary value of a pinned language is what makes these fail
  // against a hardcoded literal — same reasoning as Backlinks.test.tsx.
  beforeEach(async () => {
    await i18next.changeLanguage('en');
  });

  it('shows the localized "page not found" hint, not a hardcoded one, when /api/resolve fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        String(url).includes('/api/resolve')
          ? Promise.resolve({ ok: false, status: 404 })
          : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ users: [] }) }),
      ),
    );
    const { container, getByText } = renderMarkdown('[Onboarding](onboarding.md)');
    const link = container.querySelector<HTMLAnchorElement>('a[data-folio-link]')!;
    fireEvent.click(link);
    await waitFor(() => expect(getByText('Page not found: onboarding.md')).toBeTruthy());
  });

  it('shows the localized "unavailable via this link" hint, not a hardcoded one, for an anonymous share guest', async () => {
    stubFetch();
    const { container, getByText } = renderMarkdown('[Onboarding](onboarding.md)', { shareToken: 'tok123' });
    const link = container.querySelector<HTMLAnchorElement>('a[data-folio-link]')!;
    fireEvent.click(link);
    await waitFor(() => expect(getByText("This page isn't available via this link")).toBeTruthy());
  });
});

describe('<Markdown> table fit/scroll toggle', () => {
  const TABLE_MD = '| A | B |\n| --- | --- |\n| 1 | 2 |';
  let restoreWidths: () => void;

  beforeEach(() => {
    restoreWidths = stubWideTables();
  });

  afterEach(() => {
    restoreWidths();
    localStorage.clear();
  });

  it('measures a wide table as --wide, defaults it to --fit, and gives the toggle an accessible name', () => {
    stubFetch();
    const { container } = renderMarkdown(TABLE_MD, { pageId: 'p-fit-1' });
    const wrap = container.querySelector('.folio-table-wrap')!;
    expect(wrap.classList.contains('folio-table-wrap--wide')).toBe(true);
    expect(wrap.classList.contains('folio-table-wrap--fit')).toBe(true);
    const button = wrap.querySelector('[data-table-toggle]')!;
    expect(button.getAttribute('aria-label')).toBe('Show original column widths (scroll)');
  });

  it('leaves a table without --fit when it never measures as wide (nothing to fit)', () => {
    restoreWidths(); // fall back to jsdom's default 0/0 — never overflows
    stubFetch();
    const { container } = renderMarkdown(TABLE_MD, { pageId: 'p-fit-narrow' });
    const wrap = container.querySelector('.folio-table-wrap')!;
    expect(wrap.classList.contains('folio-table-wrap--wide')).toBe(false);
    expect(wrap.classList.contains('folio-table-wrap--fit')).toBe(false);
  });

  it('clicking the toggle switches the table to scroll mode and persists the choice for this page', () => {
    stubFetch();
    const { container } = renderMarkdown(TABLE_MD, { pageId: 'p-fit-2' });
    const button = container.querySelector<HTMLButtonElement>('[data-table-toggle]')!;
    const wrap = button.closest('.folio-table-wrap')!;
    expect(wrap.classList.contains('folio-table-wrap--fit')).toBe(true);

    fireEvent.click(button);

    expect(wrap.classList.contains('folio-table-wrap--fit')).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Fit table to container width');
    expect(JSON.parse(localStorage.getItem('folio:tableScroll:p-fit-2') ?? '[]')).toEqual([0]);

    // Clicking again switches it back to fit.
    fireEvent.click(button);
    expect(wrap.classList.contains('folio-table-wrap--fit')).toBe(true);
    expect(JSON.parse(localStorage.getItem('folio:tableScroll:p-fit-2') ?? '[]')).toEqual([]);
  });

  it('reads a previously-saved scroll choice back on a fresh mount, instead of defaulting to fit', () => {
    stubFetch();
    const first = renderMarkdown(TABLE_MD, { pageId: 'p-fit-3' });
    fireEvent.click(first.container.querySelector<HTMLButtonElement>('[data-table-toggle]')!);
    expect(JSON.parse(localStorage.getItem('folio:tableScroll:p-fit-3') ?? '[]')).toEqual([0]);

    // A genuinely fresh mount — simulating a reload of the same page — must
    // pick the override up from localStorage rather than re-defaulting to fit.
    cleanup();
    stubFetch();
    const second = renderMarkdown(TABLE_MD, { pageId: 'p-fit-3' });
    const wrap = second.container.querySelector('.folio-table-wrap')!;
    expect(wrap.classList.contains('folio-table-wrap--wide')).toBe(true);
    expect(wrap.classList.contains('folio-table-wrap--fit')).toBe(false);
    expect(wrap.querySelector('[data-table-toggle]')!.getAttribute('aria-label')).toBe(
      'Fit table to container width',
    );
  });

  it('keyboard: Enter on the focused toggle activates it, same as a pointer click', async () => {
    const fetchMock = stubFetch();
    const user = userEvent.setup();
    const { container } = renderMarkdown(TABLE_MD, { pageId: 'p-fit-4' });

    // Let the (unrelated) @mentions fetch this component always fires on
    // mount fully settle before interacting — user.keyboard() awaits between
    // key events, and the mentionable-list arriving mid-sequence would
    // trigger a real re-render (mentionsVersion is a genuine `rendered`
    // dependency) that recreates this table's DOM subtree from scratch,
    // detaching the very button the reader just focused. Nothing about the
    // toggle itself is flaky here — this only guards the test against a race
    // with a completely unrelated feature.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => {});

    const button = container.querySelector<HTMLButtonElement>('[data-table-toggle]')!;
    const wrap = button.closest('.folio-table-wrap')!;
    expect(wrap.classList.contains('folio-table-wrap--fit')).toBe(true);

    button.focus();
    await user.keyboard('{Enter}');

    expect(wrap.classList.contains('folio-table-wrap--fit')).toBe(false);
    expect(JSON.parse(localStorage.getItem('folio:tableScroll:p-fit-4') ?? '[]')).toEqual([0]);
  });

  it('a table with explicit column widths (folio-table-sized) keeps them and never gets a toggle', () => {
    stubFetch();
    const md = '[//]: # (folio-table: w=1:30%,2:30%)\n\n| a | b |\n| - | - |\n| x | y |';
    const { container } = renderMarkdown(md, { pageId: 'p-fit-sized' });
    const wrap = container.querySelector('.folio-table-wrap')!;
    expect(wrap.querySelector('table')?.classList.contains('folio-table-sized')).toBe(true);
    expect(wrap.querySelector('colgroup')).not.toBeNull();
    expect(wrap.querySelector('[data-table-toggle]')).toBeNull();
    // Never marked wide/fit either — the toggle machinery has nothing to do
    // with this table at all.
    expect(wrap.classList.contains('folio-table-wrap--wide')).toBe(false);
    expect(wrap.classList.contains('folio-table-wrap--fit')).toBe(false);
  });
});
