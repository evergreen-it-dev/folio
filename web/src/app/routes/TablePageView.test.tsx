// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { TableDoc, TableRow } from '@shared/contracts';
import { makeMockTableDoc } from '../../tables';
import { PageContent } from './PageContent';
import { SharedPageView } from '../share/SharedPageView';

/**
 * Round 26 (DATA TABLES) — SHELL-TABLES' wiring: the `kind === 'table'`
 * branch, the `?row=` deep link, and the share-token role gate.
 *
 * What is mocked, and why each one:
 *  - `../../tables/collab` — the real binding opens a WebSocket. The stub
 *    hands back a fixed TableDoc, which is exactly the contract this file
 *    cares about (the CRDT's own behaviour is COLLAB-TABLES' test zone).
 *  - `../../tables/TableGrid` — the real grid virtualises through
 *    @tanstack/react-virtual and measures element boxes, all 0×0 in jsdom, so
 *    it renders no rows and every assertion below would pass vacuously. Same
 *    stand-in as tables/TablePage.test.tsx uses, for the same reason.
 *  - `../../editor` / `../../diagrams` — heavy, and their absence is what
 *    proves a table page doesn't fall through to the prose editor.
 *  - `../auth/AuthProvider` — useSpaceRole throws outside a real
 *    <AuthProvider>, which would mean booting the whole auth gate here.
 */

const patched: unknown[] = [];
let docForCollab: TableDoc = makeMockTableDoc();

vi.mock('../../tables/collab', () => ({
  useTableCollab: () => ({ pageId: 'p1', doc: {}, provider: {}, undoManager: {}, user: {} }),
  useTableDoc: () => ({ doc: docForCollab, error: null, seeded: true }),
  useTablePatchSink: () => (patch: unknown) => patched.push(patch),
}));

vi.mock('../../tables/TableGrid', () => ({
  default: ({ rows, readOnly }: { rows: TableRow[]; readOnly?: boolean }) => (
    <div data-testid="grid" data-readonly={String(Boolean(readOnly))}>
      {rows.map((row) => (
        <div key={row.id} data-testid="grid-row" data-row-id={row.id} />
      ))}
    </div>
  ),
}));

vi.mock('../../editor', () => ({
  PageEditor: () => <div data-testid="prose-editor" />,
}));

vi.mock('../../diagrams', () => ({
  BoardEditor: () => <div data-testid="board-editor" />,
}));

vi.mock('../auth/AuthProvider', () => ({
  useSpaceRole: () => 'editor',
}));

const TABLE_META = {
  id: 'p1',
  space: 'sp',
  path: 'plan.table.md',
  title: 'Weekly plan',
  kind: 'table' as const,
};

/** Routes a request by URL, so a test can pin WHICH endpoint answered what. */
function stubFetch(routes: { match: RegExp; status?: number; body?: unknown }[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const route = routes.find((candidate) => candidate.match.test(String(input)));
      const status = route?.status ?? (route ? 200 : 404);
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(route?.body ?? { error: 'not stubbed' }),
      });
    }),
  );
}

function renderPage(url = '/s/sp/p/p1') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/s/:space/p/:id" element={<PageContent id="p1" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await i18next.changeLanguage('en');
  docForCollab = makeMockTableDoc();
  patched.length = 0;
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('PageContent — kind === "table"', () => {
  it('mounts the data-table surface instead of the prose editor', async () => {
    stubFetch([
      { match: /\/api\/pages\/p1$/, body: { ...TABLE_META } },
      { match: /\/mentionable$/, body: { users: [{ username: 'sk', name: 'SK' }] } },
    ]);
    renderPage();

    await waitFor(() => expect(screen.getByTestId('grid')).toBeTruthy());
    expect(screen.queryByTestId('prose-editor')).toBeNull();
    // The doc branch's outline rail must not come along: a data table has no
    // headings, so it would be a permanently empty column (see PageContent).
    // Queried by OutlinePanel's own accessible name — it renders a <nav>, so
    // a role-only check would pass whether or not it was there.
    expect(screen.queryByRole('navigation', { name: 'Outline' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show outline' })).toBeNull();
  });

  it('runs CONTROLLED off the CRDT: an edit becomes a patch, and does NOT mutate local state', async () => {
    // The substantive half of the wiring. `onPatch` being present is what
    // makes TablePage fully controlled — the alternative is its local
    // reducer in tables/patch.ts, which deliberately disagrees with the CRDT
    // on columns:delete (it drops orphaned values that the CRDT keeps so an
    // undo can restore them). "The patch came out AND the doc didn't change"
    // is exactly the pair of facts that distinguishes the two modes.
    stubFetch([
      { match: /\/api\/pages\/p1$/, body: { ...TABLE_META } },
      { match: /\/mentionable$/, body: { users: [] } },
    ]);
    renderPage();

    await waitFor(() => expect(screen.getByTestId('grid')).toBeTruthy());
    const before = screen.getAllByTestId('grid-row').length;

    fireEvent.click(screen.getByRole('button', { name: 'Row' }));

    expect(patched).toEqual([expect.objectContaining({ kind: 'rows:create' })]);
    expect(screen.getAllByTestId('grid-row')).toHaveLength(before);
  });

  it('CONTROL: the same render of a doc page does get the prose editor and the outline', async () => {
    // Without this, the two negative assertions above would pass for any
    // reason at all (a crashed render included) rather than because the table
    // branch deliberately leaves both out.
    stubFetch([
      { match: /\/api\/pages\/p1$/, body: { ...TABLE_META, kind: 'doc', path: 'plan.md', markdown: '# H\n' } },
    ]);
    renderPage();

    await waitFor(() => expect(screen.getByTestId('prose-editor')).toBeTruthy());
    expect(screen.queryByTestId('grid')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Outline' })).toBeTruthy();
  });

  it('recovers the page identity from GET /api/tables/:id when the page endpoint 400s', async () => {
    // Documents the live server gap: /api/pages/:id has no `table` arm and
    // falls through to readBoardSvg, which 400s. The fallback in
    // PageContent.fetchPage is what keeps a table reachable meanwhile.
    stubFetch([
      { match: /\/api\/pages\/p1$/, status: 400, body: { error: 'page is not a board' } },
      { match: /\/api\/tables\/p1$/, body: { meta: TABLE_META, columns: [], views: [], rows: [] } },
      { match: /\/mentionable$/, body: { users: [] } },
    ]);
    renderPage();

    await waitFor(() => expect(screen.getByTestId('grid')).toBeTruthy());
  });

  it('surfaces the original page error when the fallback is not a table either', async () => {
    stubFetch([
      { match: /\/api\/pages\/p1$/, status: 400, body: { error: 'page is not a board' } },
      { match: /\/api\/tables\/p1$/, status: 400, body: { error: 'page is not a data table' } },
    ]);
    renderPage();

    await waitFor(() => expect(screen.getByText(/page is not a board/)).toBeTruthy());
  });
});

describe('PageContent — ?row= deep link (spec §11)', () => {
  it('opens the row panel for the row named in the query string', async () => {
    stubFetch([
      { match: /\/api\/pages\/p1$/, body: { ...TABLE_META } },
      { match: /\/mentionable$/, body: { users: [] } },
    ]);
    renderPage('/s/sp/p/p1?row=r7k2mq4a');

    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Row panel' })).toBeTruthy());
  });

  it('does not open a panel — and says so — when the linked row is gone', async () => {
    stubFetch([
      { match: /\/api\/pages\/p1$/, body: { ...TABLE_META } },
      { match: /\/mentionable$/, body: { users: [] } },
    ]);
    renderPage('/s/sp/p/p1?row=deleted-row');

    await waitFor(() => expect(screen.getByTestId('grid')).toBeTruthy());
    expect(screen.getByText('The row this link points at is no longer in the table.')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Row panel' })).toBeNull();
  });

  it('drops the active view’s filters when the linked row is filtered out of it', async () => {
    stubFetch([
      { match: /\/api\/pages\/p1$/, body: { ...TABLE_META } },
      { match: /\/mentionable$/, body: { users: [] } },
    ]);
    // The fixture's second view filters to IN PROG/PLANNING; make it the only
    // view so the deep link lands inside it, and point at a DONE row.
    const doc = makeMockTableDoc();
    docForCollab = { ...doc, views: [doc.views[1]] };
    const hidden = doc.rows.find((row) => row.values.status === 'DONE');
    expect(hidden).toBeTruthy();

    renderPage(`/s/sp/p/p1?row=${hidden!.id}`);

    // Visible despite the filter, plus the "showing without filters" notice.
    // Waited for, not asserted once: dropping the filters is an effect that
    // runs AFTER the lazy grid first mounts, so "the grid exists" is not yet
    // "the deep link has been honoured".
    await waitFor(() =>
      expect(screen.getByTestId('grid').querySelector(`[data-row-id="${hidden!.id}"]`)).toBeTruthy(),
    );
    expect(screen.getByText('Show without filters')).toBeTruthy();
  });
});

describe('SharedPageView — a shared table (spec §12/§17.11)', () => {
  function renderShare(mode: 'view' | 'edit') {
    stubFetch([
      { match: /\/api\/share\/tok$/, body: { mode, page: TABLE_META, spaceName: 'Space' } },
    ]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/share/tok']}>
          <Routes>
            <Route path="/share/:token" element={<SharedPageView />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('gives a `view` token a read-only grid', async () => {
    renderShare('view');
    await waitFor(() => expect(screen.getByTestId('grid')).toBeTruthy());
    expect(screen.getByTestId('grid').getAttribute('data-readonly')).toBe('true');
    expect(screen.getByText('View only')).toBeTruthy();
  });

  it('gives an `edit` token a writable grid', async () => {
    renderShare('edit');
    await waitFor(() => expect(screen.getByTestId('grid')).toBeTruthy());
    expect(screen.getByTestId('grid').getAttribute('data-readonly')).toBe('false');
  });
});
