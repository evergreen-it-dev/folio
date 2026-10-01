// @vitest-environment jsdom
/**
 * Trash round — the /trash page: the list with its "what/type/where/who/when"
 * columns, restore (including the conflict case, whose toast MUST show the
 * ACTUAL -restored path from the response, not the original), the hard
 * "permanently" confirm before a permanent delete, and the
 * kind filter. Server behavior itself is covered in
 * server/trash/service.test.ts — here the fetch layer is stubbed.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { TrashItemInfo, TrashListResponse, TrashRestoreResponse } from '@shared/contracts';
import { ToastProvider } from '../ui/Toast';
import { TrashPage } from './TrashPage';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ADMIN_USER = { id: 'admin-1', name: 'Admin One', email: 'admin@t.local', isAdmin: true, createdAt: '' };

vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ user: ADMIN_USER, memberships: {}, logout: () => {}, loggingOut: false }),
}));

const ALL_ITEMS: TrashItemInfo[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    space: 'eng',
    pageId: 'p1',
    kind: 'doc',
    origPath: 'notes/plan.md',
    title: 'Work plan',
    deletedBy: { id: 'u1', name: 'Olha' },
    deletedAt: '2026-08-20T10:00:00.000Z',
    childrenCount: 0,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    space: 'wiki',
    pageId: 'p2',
    kind: 'folder',
    origPath: 'docs',
    title: 'Documentation',
    deletedBy: null,
    deletedAt: '2026-08-21T10:00:00.000Z',
    childrenCount: 3,
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

/** Mimics the server's filter/paginate contract closely enough for the UI test: `spaces` always reflects the FULL set (unaffected by filters), `items`/`total` reflect the filtered+paged set. */
function buildTrashResponse(url: string, allItems: TrashItemInfo[]): TrashListResponse {
  const params = new URLSearchParams(url.split('?')[1] ?? '');
  const space = params.get('space');
  const kind = params.get('kind');
  const from = params.get('from');
  const to = params.get('to');
  const limit = Number(params.get('limit') ?? '100');
  const offset = Number(params.get('offset') ?? '0');
  const fromTs = from ? Date.parse(from) : Number.NaN;
  const toTs = to ? Date.parse(to) + 24 * 60 * 60 * 1000 : Number.NaN;
  const filtered = allItems.filter((item) => {
    if (space && item.space !== space) return false;
    if (kind && item.kind !== kind) return false;
    const ts = Date.parse(item.deletedAt);
    if (!Number.isNaN(fromTs) && ts < fromTs) return false;
    if (!Number.isNaN(toTs) && ts >= toTs) return false;
    return true;
  });
  const spaces = [...new Set(allItems.map((i) => i.space))].sort();
  return { items: filtered.slice(offset, offset + limit), total: filtered.length, spaces };
}

function stubApi(overrides?: { allItems?: TrashItemInfo[]; restore?: TrashRestoreResponse }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/trash/settings')) {
      return jsonResponse({ retentionDays: null });
    }
    if (method === 'POST' && /\/api\/trash\/[^/]+\/restore$/.test(url)) {
      return jsonResponse(overrides?.restore ?? { restoredPath: 'notes/plan.md', pageId: 'p1', space: 'eng', renamed: false });
    }
    if (method === 'DELETE' && url.startsWith('/api/trash/')) {
      return jsonResponse({ ok: true });
    }
    if (url.startsWith('/api/trash')) {
      return jsonResponse(buildTrashResponse(url, overrides?.allItems ?? ALL_ITEMS));
    }
    return jsonResponse({ error: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/trash']}>
          <TrashPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('TrashPage', () => {
  it('lists items with what/kind/where/who/when — and an honest "unknown" for a backfilled deleter', async () => {
    stubApi();
    renderPage();

    expect(await screen.findByText('Work plan')).toBeTruthy();
    expect(screen.getByText('Documentation')).toBeTruthy();
    // kind labels appear both as filter <option>s and as table cells — assert the CELLS
    expect(screen.getAllByText('Page').some((el) => el.tagName === 'TD')).toBe(true);
    expect(screen.getAllByText('Folder').some((el) => el.tagName === 'TD')).toBe(true);
    expect(screen.getByText('eng/notes/plan.md')).toBeTruthy();
    expect(screen.getByText('Olha')).toBeTruthy();
    expect(screen.getByText('unknown')).toBeTruthy();
    expect(screen.getByText('+3 pages')).toBeTruthy();
  });

  it('restore: success toast shows the restored path and links to the page', async () => {
    const fetchMock = stubApi();
    renderPage();
    await screen.findByText('Work plan');

    fireEvent.click(screen.getAllByRole('button', { name: /Restore/ })[0]);

    expect(await screen.findByText('Restored: notes/plan.md')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Open' });
    expect(link.getAttribute('href')).toBe('/s/eng/p/p1');
    expect(fetchMock.mock.calls.some(([u, init]) => String(u) === `/api/trash/${ALL_ITEMS[0].id}/restore` && init?.method === 'POST')).toBe(true);
  });

  it('restore with a path conflict: the toast tells the truth — the ACTUAL -restored path, not the original', async () => {
    stubApi({ restore: { restoredPath: 'notes/plan-restored.md', pageId: 'p1', space: 'eng', renamed: true } });
    renderPage();
    await screen.findByText('Work plan');

    fireEvent.click(screen.getAllByRole('button', { name: /Restore/ })[0]);

    expect(await screen.findByText('The path was taken — restored alongside as: notes/plan-restored.md')).toBeTruthy();
  });

  it('permanent delete goes through the hard confirm carrying "permanently", then calls DELETE', async () => {
    const fetchMock = stubApi();
    renderPage();
    await screen.findByText('Documentation');

    fireEvent.click(screen.getAllByRole('button', { name: /Delete forever/ })[0]);
    expect(await screen.findByText(/permanently/)).toBeTruthy();
    expect(screen.getByText(/"Work plan"/)).toBeTruthy();

    const confirmButtons = screen.getAllByRole('button', { name: 'Delete forever' });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]); // the dialog's own confirm

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u, init]) => String(u) === `/api/trash/${ALL_ITEMS[0].id}` && init?.method === 'DELETE')).toBe(true),
    );
  });

  it('kind filter narrows the list', async () => {
    stubApi();
    renderPage();
    await screen.findByText('Work plan');

    fireEvent.change(screen.getByDisplayValue('All types'), { target: { value: 'folder' } });

    // Filtering is server-side now (round 03.09.2026 pagination) — the change re-fetches.
    await waitFor(() => expect(screen.queryByText('Work plan')).toBeNull());
    expect(await screen.findByText('Documentation')).toBeTruthy();
  });

  it('shows the empty state when the trash has nothing', async () => {
    stubApi({ allItems: [] });
    renderPage();
    expect(await screen.findByText('The trash is empty.')).toBeTruthy();
  });
});
