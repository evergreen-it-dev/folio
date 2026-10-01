// @vitest-environment jsdom
/**
 * Drag-and-drop in the sidebar page tree, through the REAL PageTree/TreeRow
 * (no stand-in components): the reorder algorithm itself is covered in
 * reorderPages.test.ts, so what these assert is the wiring — which rows are
 * draggable, which drops the handlers refuse outright, and the exact
 * requests a drop turns into.
 *
 * jsdom cannot really drag: there is no pointer, and every element reports a
 * zero-sized rect. So the events are dispatched by hand (with a stubbed row
 * rect, which is what makes `clientY` mean "top quarter" / "middle" /
 * "bottom quarter" at all) and the assertions are on the effects. The FEEL
 * of the drag — the cursor, the drag image, whether the indicator lands
 * where the eye expects — still needs a human with a mouse.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import { ToastProvider } from '../ui/Toast';
import { PageTree } from './PageTree';
import '../i18n/register';

// The tree row's "create from template" hook reads the session; nothing in
// these tests depends on who the user is.
vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'u1', name: 'Test User', email: 't@t.local', isAdmin: false, createdAt: '' },
    memberships: {},
    logout: () => {},
    loggingOut: false,
  }),
  useSpaceRole: () => 'editor' as const,
}));

beforeEach(async () => {
  await i18next.changeLanguage('en');
});

// --- fixture ---------------------------------------------------------------
// Root index page wrapping three top-level rows (getTopLevelNodes unwraps it):
//   Alpha            alpha.md              order 10
//   Beta             beta.md               order 20
//   Guides           guides/       (folder pseudo-node) -> One   guides/one.md
//   Manual           manual/index.md       order 40      -> Deep  manual/deep.md
const node = (over: Record<string, unknown>) => ({
  space: 'sp',
  kind: 'doc',
  order: 0,
  status: 'published',
  updatedAt: '',
  children: [],
  ...over,
});

const TREE = {
  tree: [
    node({
      id: 'root',
      path: 'index.md',
      title: 'Root',
      children: [
        node({ id: 'a', path: 'alpha.md', title: 'Alpha', order: 10 }),
        node({ id: 'b', path: 'beta.md', title: 'Beta', order: 20 }),
        node({
          id: 'dir:guides',
          path: 'guides',
          kind: 'folder',
          title: 'Guides',
          children: [node({ id: 'g1', path: 'guides/one.md', title: 'One' })],
        }),
        node({
          id: 'manual',
          path: 'manual/index.md',
          title: 'Manual',
          order: 40,
          children: [node({ id: 'deep', path: 'manual/deep.md', title: 'Deep' })],
        }),
      ],
    }),
  ],
};

// --- harness ---------------------------------------------------------------

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** Records every request and answers by URL. `failPut` makes order PUTs 400. */
function stubFetch(options: { failPut?: boolean } = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/templates')) {
        // Endpoint not live in this fixture -> useTemplates falls back to the
        // already-cached tree, exactly as it does against a real server.
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: 'not found' }) });
      }
      if (method === 'PUT' && options.failPut) {
        return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: 'the server refused' }) });
      }
      if (method === 'GET') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(TREE) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }),
  );
  return calls;
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastProvider>{children}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** Every row starts expanded, so nested rows are reachable as drop targets. */
function renderTree() {
  window.localStorage.setItem('folio:expanded:sp', JSON.stringify(['dir:guides', 'manual']));
  return render(
    <Wrapper>
      <PageTree space="sp" activeId={undefined} activeFolderPath={undefined} canEdit />
    </Wrapper>,
  );
}

const rowFor = (title: string) => screen.getAllByText(title)[0].closest('[role="button"]') as HTMLElement;

/**
 * jsdom has no DragEvent and no layout, so drags are dispatched as bubbling
 * MouseEvents (React reads `clientY`/`dataTransfer` off the native event,
 * not off the constructor) against a stubbed 100px-tall row rect.
 */
function makeDataTransfer() {
  return { setData: vi.fn(), getData: vi.fn(), effectAllowed: '', dropEffect: '' };
}

function fireDrag(el: HTMLElement, type: string, clientY = 0, dataTransfer: unknown = makeDataTransfer()) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  // Through fireEvent (not a bare dispatchEvent) so React's act() flush runs
  // between events — a dragover otherwise reads the state from BEFORE the
  // dragstart that set it.
  fireEvent(el, event);
  return event;
}

/** Top quarter / middle / bottom quarter of the stubbed rect. */
const TOP = 10;
const MIDDLE = 50;
const BOTTOM = 90;

describe('PageTree drag and drop', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      height: 100,
      bottom: 100,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('makes page rows draggable but never a folder pseudo-node (it has no page id to move)', async () => {
    stubFetch();
    renderTree();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());

    expect(rowFor('Alpha').getAttribute('draggable')).toBe('true');
    expect(rowFor('Manual').getAttribute('draggable')).toBe('true');
    expect(rowFor('Guides').getAttribute('draggable')).toBe('false');
  });

  it('drops a row after its neighbour as a plain swap of the two order values, with no move request', async () => {
    const calls = stubFetch();
    renderTree();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());

    const dt = makeDataTransfer();
    fireDrag(rowFor('Alpha'), 'dragstart', 0, dt);
    expect(dt.setData).toHaveBeenCalled(); // Firefox refuses a drag without it
    fireDrag(rowFor('Beta'), 'dragover', BOTTOM);
    fireDrag(rowFor('Beta'), 'drop', BOTTOM);

    await waitFor(() => expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(2));
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([
      // minimal: only the two rows that actually traded places, moved row first
      { url: '/api/pages/a', method: 'PUT', body: { order: 20 } },
      { url: '/api/pages/b', method: 'PUT', body: { order: 10 } },
    ]);
  });

  it('drops a row INTO a folder as one move plus the orders that append it there', async () => {
    const calls = stubFetch();
    renderTree();
    await waitFor(() => expect(screen.getByText('One')).toBeTruthy());

    fireDrag(rowFor('Alpha'), 'dragstart');
    // Anywhere on a folder row means "into" — it has no order of its own to
    // sit before or after, so its edges are not dead zones.
    fireDrag(rowFor('Guides'), 'dragover', TOP);
    fireDrag(rowFor('Guides'), 'drop', TOP);

    await waitFor(() => expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(3));
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([
      // the SAME endpoint the "Move" dialog uses, not a new one
      { url: '/api/pages/a/move', method: 'POST', body: { toParentPath: 'guides' } },
      { url: '/api/pages/g1', method: 'PUT', body: { order: 10 } },
      { url: '/api/pages/a', method: 'PUT', body: { order: 20 } },
    ]);
  });

  it('refuses a drop into the dragged page\'s own subtree — no request at all', async () => {
    const calls = stubFetch();
    renderTree();
    await waitFor(() => expect(screen.getByText('Deep')).toBeTruthy());

    fireDrag(rowFor('Manual'), 'dragstart');
    // "Manual" is manual/index.md; "Deep" lives inside manual/.
    const over = fireDrag(rowFor('Deep'), 'dragover', TOP);
    // Left un-prevented on purpose: the browser then shows a "no drop"
    // cursor instead of accepting something we would refuse afterwards.
    expect(over.defaultPrevented).toBe(false);
    fireDrag(rowFor('Deep'), 'drop', TOP);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('refuses a drop onto the dragged row itself', async () => {
    const calls = stubFetch();
    renderTree();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());

    fireDrag(rowFor('Alpha'), 'dragstart');
    const over = fireDrag(rowFor('Alpha'), 'dragover', BOTTOM);
    expect(over.defaultPrevented).toBe(false);
    fireDrag(rowFor('Alpha'), 'drop', BOTTOM);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('accepts a legal drop by preventing the dragover default (what turns the row into a drop target)', async () => {
    stubFetch();
    renderTree();
    await waitFor(() => expect(screen.getByText('Beta')).toBeTruthy());

    fireDrag(rowFor('Alpha'), 'dragstart');
    const over = fireDrag(rowFor('Beta'), 'dragover', BOTTOM);
    expect(over.defaultPrevented).toBe(true);
  });

  it('surfaces a failed drop as a toast and refetches the tree, so nothing is left showing a position the server does not have', async () => {
    const calls = stubFetch({ failPut: true });
    renderTree();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    const treeReadsBefore = calls.filter((c) => c.url.includes('/tree')).length;

    fireDrag(rowFor('Alpha'), 'dragstart');
    fireDrag(rowFor('Beta'), 'dragover', BOTTOM);
    fireDrag(rowFor('Beta'), 'drop', BOTTOM);

    // QA-3 #9: the server's own wording still reaches the user, but now inside a
    // localized frame (errorText.ts -> errors.status.badRequest) instead of being
    // pasted raw into a Russian/Ukrainian UI — hence a substring match.
    await waitFor(() => expect(screen.getByText(/the server refused/)).toBeTruthy());
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/tree')).length).toBeGreaterThan(treeReadsBefore));
  });

  it('keeps the accessible path: Move up / Move down / Move are still in the row menu', async () => {
    stubFetch();
    renderTree();
    await waitFor(() => expect(screen.getByText('Beta')).toBeTruthy());

    const menus = screen.getAllByLabelText('More actions');
    menus[1].click(); // Beta's "…" — a middle row, so neither arrow is disabled
    await waitFor(() => expect(screen.getByText('Move up')).toBeTruthy());
    expect(screen.getByText('Move down')).toBeTruthy();
    expect(screen.getByText('Move')).toBeTruthy();
  });
});

// The owner, 01.10.2026: "add duplicate, so it duplicates the whole tree if there is one".
describe('PageTree — Duplicate in the row menu', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('asks the server for a copy next to the page, named apart from the original', async () => {
    const calls = stubFetch();
    renderTree();
    await waitFor(() => expect(screen.getByText('Manual')).toBeTruthy());

    // «Manual» is a page WITH a child: one request covers the whole tree — the
    // server copies the subtree, there is nothing for the client to walk.
    const more = rowFor('Manual').querySelector('[aria-label="More actions"]') as HTMLElement;
    fireEvent.click(more);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));

    await waitFor(() => {
      const posts = calls.filter((c) => c.method === 'POST');
      expect(posts).toEqual([{ url: '/api/pages/manual/duplicate', method: 'POST', body: { title: 'Manual (copy)' } }]);
    });
    // The tree is read again, so the copy shows up without a reload.
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/tree')).length).toBeGreaterThan(1));
  });

  it('a folder without a page of its own has nothing to duplicate — no menu at all', async () => {
    stubFetch();
    renderTree();
    await waitFor(() => expect(screen.getByText('Guides')).toBeTruthy());
    expect(rowFor('Guides').querySelector('[aria-label="More actions"]')).toBeNull();
  });
});

/**
 * QA-3 P2 #6 — "+ Add a page" on a LEAF row used to post
 * `parentPath: dirname(node.path)`, which for a root-level `alpha.md` is ''
 * — a sibling at the space root, not a child — while the mutation was named
 * createChild and its onSuccess expanded the row as if a child had appeared
 * under it. Through the UI, a leaf page could not be given a child at all.
 */
describe('PageTree — "+" creates a real child', () => {
  async function addDocFrom(rowTitle: string) {
    const row = rowFor(rowTitle);
    const plus = row.querySelector('[aria-label="Add a page"]') as HTMLElement;
    fireEvent.click(plus);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New page' }));
  }

  const createCalls = (calls: Call[]) => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/pages'));

  it('a leaf page gets its child in its OWN same-named folder, not beside itself', async () => {
    const calls = stubFetch();
    renderTree();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());

    await addDocFrom('Alpha');

    await waitFor(() => expect(createCalls(calls).length).toBe(1));
    expect((createCalls(calls)[0].body as { parentPath: string }).parentPath).toBe('alpha');
  });

  it('a nested leaf page gets a folder nested next to it', async () => {
    const calls = stubFetch();
    renderTree();
    await waitFor(() => expect(screen.getByText('Deep')).toBeTruthy());

    await addDocFrom('Deep');

    await waitFor(() => expect(createCalls(calls).length).toBe(1));
    expect((createCalls(calls)[0].body as { parentPath: string }).parentPath).toBe('manual/deep');
  });

  it('a directory index page is unchanged — its children ARE its directory', async () => {
    const calls = stubFetch();
    renderTree();
    await waitFor(() => expect(screen.getAllByText('Manual').length).toBeGreaterThan(0));

    await addDocFrom('Manual');

    await waitFor(() => expect(createCalls(calls).length).toBe(1));
    expect((createCalls(calls)[0].body as { parentPath: string }).parentPath).toBe('manual');
  });
});

/**
 * Owner ask (10.09.2026): a restore-from-trash (or any structural change)
 * done in ANOTHER tab wasn't visible here without an F5 — the QueryClient's
 * `refetchOnWindowFocus: false` default (App.tsx) meant nothing ever asked
 * the server again. Fix is `refetchOnWindowFocus: true` on the tree query
 * itself (PageTree.tsx), point-config rather than global. This test doesn't
 * click anything in the tree — it swaps what the GET answers with and fires
 * the 'visibilitychange'/'focus' events react-query's focus manager listens
 * for, then asserts the new row shows up on its own.
 */
describe('PageTree — refetches on window focus (picks up changes made elsewhere)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('shows a page restored from trash in another tab once this tab regains focus, with no manual refetch', async () => {
    let restored = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if ((init?.method ?? 'GET') !== 'GET') {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
        }
        if (url.endsWith('/templates')) {
          return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: 'not found' }) });
        }
        const tree = restored
          ? {
              tree: [
                {
                  ...TREE.tree[0],
                  children: [
                    ...TREE.tree[0].children,
                    node({ id: 'restored', path: 'restored.md', title: 'Restored', order: 50 }),
                  ],
                },
              ],
            }
          : TREE;
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(tree) });
      }),
    );

    renderTree();
    await waitFor(() => expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0));
    expect(screen.queryByText('Restored')).toBeNull();

    // The "other tab" restores the page; this tab's cache doesn't know yet.
    restored = true;
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    fireEvent(document, new Event('visibilitychange'));
    fireEvent(window, new Event('focus'));

    await waitFor(() => expect(screen.getAllByText('Restored').length).toBeGreaterThan(0));
  });
});
