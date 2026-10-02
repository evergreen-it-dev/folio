// @vitest-environment jsdom
/**
 * The sidebar tree and the `/events` socket together, through the REAL
 * NotificationsHost, the REAL socket subscriber and the REAL PageTree/TreeRow:
 * only `WebSocket` and `fetch` are stubs. What this pins down is the user's
 * view of the feature —
 *  - a "tree changed" frame for the space on screen makes the new page appear
 *    without a reload and without a focus change;
 *  - a frame for another space does not make the visible space refetch, and
 *    a visible space's frame does not refetch the other space;
 *  - a burst of frames is one refetch;
 *  - a row that is being renamed keeps its text and its focus while the tree
 *    underneath it is replaced;
 *  - a socket that came back after a break refetches each watched tree once.
 *
 * The server half (who gets the frame, what is in it) is server/treeSignal.test.ts.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import { ToastProvider } from '../ui/Toast';
import { NotificationsHost } from '../notifications/NotificationsHost';
import { api } from '../api';
import { cancelPendingTreeRefreshes } from './treeLive';
import { PageTree } from './PageTree';
import '../i18n/register';

vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'u1', name: 'Test User', email: 't@t.local', isAdmin: false, createdAt: '' },
    memberships: {},
    logout: () => {},
    loggingOut: false,
  }),
  useSpaceRole: () => 'editor' as const,
}));

vi.setConfig({ testTimeout: 20_000 });

beforeEach(async () => {
  await i18next.changeLanguage('en');
});

const node = (over: Record<string, unknown>) => ({
  space: 'sp',
  kind: 'doc',
  order: 0,
  status: 'published',
  updatedAt: '',
  children: [],
  ...over,
});

function treeWith(extra: Array<Record<string, unknown>> = []) {
  return {
    tree: [
      node({
        id: 'root',
        path: 'index.md',
        title: 'Root',
        children: [node({ id: 'a', path: 'alpha.md', title: 'Alpha', order: 10 }), node({ id: 'b', path: 'beta.md', title: 'Beta', order: 20 }), ...extra],
      }),
    ],
  };
}

/** A socket the test drives by hand: nothing connects anywhere. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  close() {
    this.onclose?.();
  }
  open() {
    this.onopen?.();
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

interface Server {
  treeGets: Record<string, number>;
  /** How many GETs of a space's tree happened since the app settled (see `ready` in the tests). */
  since(space: string): number;
  /** Declare "the app has settled" now: later counts are relative to this moment. */
  mark(): void;
  /** Replace what GET /api/spaces/sp/tree answers from now on. */
  setSpTree(tree: unknown): void;
}

function stubServer(): Server {
  let spTree: unknown = treeWith();
  let marked: Record<string, number> = {};
  const server: Server = {
    treeGets: {},
    since: (space) => (server.treeGets[space] ?? 0) - (marked[space] ?? 0),
    mark: () => (marked = { ...server.treeGets }),
    setSpTree: (tree) => (spTree = tree),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const respond = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      if (method !== 'GET') return respond({});
      // The real server has this endpoint; answering it keeps useTemplates from adding a second observer of the tree query.
      if (url.endsWith('/templates')) return respond({ templates: [] });
      if (url.endsWith('/api/notifications')) return respond({ items: [], unread: 0 });
      if (url.endsWith('/api/spaces')) return respond({ spaces: [] });
      const treeMatch = /\/api\/spaces\/([^/]+)\/tree$/.exec(url);
      if (treeMatch) {
        const space = treeMatch[1];
        server.treeGets[space] = (server.treeGets[space] ?? 0) + 1;
        return respond(space === 'sp' ? spTree : { tree: [node({ id: 'o', space: 'other', path: 'index.md', title: 'Other Root' })] });
      }
      return respond({});
    }),
  );
  return server;
}

/** A second, non-sidebar consumer of another space's tree — the move/copy dialog or the quick switcher keep such queries alive. */
function OtherSpaceProbe() {
  const { data } = useQuery({ queryKey: ['tree', 'other'], queryFn: () => api.getTree('other') });
  return <div data-testid="other-probe">{data ? 'loaded' : 'loading'}</div>;
}

function renderApp(): QueryClient {
  window.localStorage.setItem('folio:expanded:sp', JSON.stringify([]));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastProvider>{children}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  render(
    <Wrapper>
      <NotificationsHost />
      <PageTree space="sp" activeId={undefined} activeFolderPath={undefined} canEdit />
      <OtherSpaceProbe />
    </Wrapper>,
  );
  return client;
}

const rowFor = (title: string) => screen.getAllByText(title)[0].closest('[role="button"]') as HTMLElement;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const REFRESH_WAIT = { timeout: 8000 };

describe('PageTree — live refresh from the /events socket', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  afterEach(() => {
    cancelPendingTreeRefreshes();
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  async function ready(server: Server) {
    renderApp();
    await waitFor(() => expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByTestId('other-probe').textContent).toBe('loaded'));
    await waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    FakeSocket.instances[0].open();
    await sleep(100);
    server.mark();
    expect(server.treeGets).toEqual({ sp: 1, other: 1 }); // one request per tree so far: nothing double-fetches on mount
    return FakeSocket.instances[0];
  }

  it('a tree frame for the visible space shows a page created elsewhere, with no reload and no focus change', async () => {
    const server = stubServer();
    const socket = await ready(server);
    expect(screen.queryByText('Gamma')).toBeNull();

    // Another client creates the page; nothing tells THIS tab except the frame.
    server.setSpTree(treeWith([node({ id: 'g', path: 'gamma.md', title: 'Gamma', order: 30 })]));
    socket.receive({ type: 'tree', space: 'sp', v: 1 });

    await waitFor(() => expect(screen.getAllByText('Gamma').length).toBeGreaterThan(0), REFRESH_WAIT);
    expect(server.since('sp')).toBe(1);
  });

  it('refetches only the space the frame names', async () => {
    const server = stubServer();
    const socket = await ready(server);

    socket.receive({ type: 'tree', space: 'sp', v: 1 });
    await waitFor(() => expect(server.since('sp')).toBe(1), REFRESH_WAIT);
    await sleep(300);
    expect(server.since('other')).toBe(0);

    socket.receive({ type: 'tree', space: 'other', v: 1 });
    await waitFor(() => expect(server.since('other')).toBe(1), REFRESH_WAIT);
    await sleep(300);
    expect(server.since('sp')).toBe(1);
  });

  it('a burst of frames is one refetch', async () => {
    const server = stubServer();
    const socket = await ready(server);

    for (let v = 1; v <= 10; v++) socket.receive({ type: 'tree', space: 'sp', v });
    await waitFor(() => expect(server.since('sp')).toBe(1), REFRESH_WAIT);
    await sleep(600);
    expect(server.since('sp')).toBe(1);
  });

  it('a frame whose counter is lower than the ones before (the server restarted, its counter began again) still refreshes', async () => {
    const server = stubServer();
    const socket = await ready(server);

    socket.receive({ type: 'tree', space: 'sp', v: 57 });
    await waitFor(() => expect(server.since('sp')).toBe(1), REFRESH_WAIT);
    socket.receive({ type: 'tree', space: 'sp', v: 1 });
    await waitFor(() => expect(server.since('sp')).toBe(2), REFRESH_WAIT);
    socket.receive({ type: 'tree', space: 'sp', v: 1 }); // the very same counter again: not a duplicate to drop
    await waitFor(() => expect(server.since('sp')).toBe(3), REFRESH_WAIT);
  });

  it('many signals one after another over a long session each reach the server', async () => {
    const server = stubServer();
    const socket = await ready(server);

    for (let i = 1; i <= 12; i++) {
      socket.receive({ type: 'tree', space: 'sp', v: i });
      await waitFor(() => expect(server.since('sp')).toBe(i), REFRESH_WAIT);
    }
  }, 40_000);

  it('ignores frames it does not understand and frames that name no space', async () => {
    const server = stubServer();
    const socket = await ready(server);

    socket.receive({ type: 'tree' });
    socket.receive({ type: 'tree', space: 42, v: 1 });
    socket.receive({ type: 'something-new', space: 'sp' });
    await sleep(700);
    expect(server.since('sp')).toBe(0);
  });

  it('does not disturb a rename in progress: the typed text and the focus survive the refetch', async () => {
    const server = stubServer();
    const socket = await ready(server);

    fireEvent.click(rowFor('Beta').querySelector('[aria-label="More actions"]') as HTMLElement);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const input = (await screen.findByDisplayValue('Beta')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Beta, half typed' } });
    expect(document.activeElement).toBe(input);

    // The tree underneath changes: a sibling appears AND the renamed row's own title moves on the server.
    server.setSpTree({
      tree: [
        node({
          id: 'root',
          path: 'index.md',
          title: 'Root',
          children: [
            node({ id: 'a', path: 'alpha.md', title: 'Alpha', order: 10 }),
            node({ id: 'b', path: 'beta.md', title: 'Beta (changed elsewhere)', order: 20 }),
            node({ id: 'g', path: 'gamma.md', title: 'Gamma', order: 30 }),
          ],
        }),
      ],
    });
    socket.receive({ type: 'tree', space: 'sp', v: 1 });

    await waitFor(() => expect(screen.getAllByText('Gamma').length).toBeGreaterThan(0), REFRESH_WAIT);
    const stillThere = screen.getByDisplayValue('Beta, half typed') as HTMLInputElement;
    expect(stillThere).toBe(input); // the very same element: not re-mounted
    expect(document.activeElement).toBe(input);
  });

  it('a socket that comes back after a break refetches each tree somebody is looking at exactly once', async () => {
    const server = stubServer();
    const socket = await ready(server);

    socket.close(); // the proxy cut it; the subscriber reconnects after its first pause
    await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 4000 });
    server.setSpTree(treeWith([node({ id: 'g', path: 'gamma.md', title: 'Gamma', order: 30 })]));
    FakeSocket.instances[1].open();

    await waitFor(() => expect(screen.getAllByText('Gamma').length).toBeGreaterThan(0), REFRESH_WAIT);
    await sleep(600);
    expect(server.since('sp')).toBe(1); // once, not once per frame, not twice
    expect(server.since('other')).toBe(1);
  }, 15_000);
});
