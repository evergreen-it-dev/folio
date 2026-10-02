// @vitest-environment jsdom
/**
 * The client half of the "tree changed" signal, without any component: what
 * `requestTreeRefresh` / `requestAllTreeRefresh` do to the query cache and
 * when. The wiring through the real `/events` socket and the real sidebar is
 * in PageTree.live.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver, focusManager, onlineManager } from '@tanstack/react-query';
import { TREE_REFRESH_JITTER_MS, cancelPendingTreeRefreshes, requestAllTreeRefresh, requestTreeRefresh } from './treeLive';

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('requestTreeRefresh', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cancelPendingTreeRefreshes();
    vi.useRealTimers();
  });

  it('invalidates the tree query of that space only, after a short random delay', () => {
    const client = makeClient();
    const spy = vi.spyOn(client, 'invalidateQueries');

    requestTreeRefresh(client, 'sp');
    expect(spy).not.toHaveBeenCalled(); // never synchronously: a whole instance must not refetch in the same tick

    vi.advanceTimersByTime(TREE_REFRESH_JITTER_MS);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['tree', 'sp'] });
  });

  it('a burst of signals for one space is one invalidation; another space keeps its own', () => {
    const client = makeClient();
    const spy = vi.spyOn(client, 'invalidateQueries');

    for (let i = 0; i < 20; i++) requestTreeRefresh(client, 'sp');
    requestTreeRefresh(client, 'other');
    vi.advanceTimersByTime(TREE_REFRESH_JITTER_MS);

    const keys = spy.mock.calls.map((call) => JSON.stringify((call[0] as { queryKey: unknown }).queryKey)).sort();
    expect(keys).toEqual([JSON.stringify(['tree', 'other']), JSON.stringify(['tree', 'sp'])]);
  });

  it('a signal that arrives after the previous one fired is a new invalidation', () => {
    const client = makeClient();
    const spy = vi.spyOn(client, 'invalidateQueries');

    requestTreeRefresh(client, 'sp');
    vi.advanceTimersByTime(TREE_REFRESH_JITTER_MS);
    requestTreeRefresh(client, 'sp');
    vi.advanceTimersByTime(TREE_REFRESH_JITTER_MS);

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not touch unrelated queries (notifications, spaces, pages)', () => {
    const client = makeClient();
    client.setQueryData(['notifications'], { items: [], unread: 0 });
    client.setQueryData(['spaces'], { spaces: [] });
    client.setQueryData(['tree', 'sp'], { tree: [] });
    client.setQueryData(['tree', 'other'], { tree: [] });

    requestTreeRefresh(client, 'sp');
    vi.advanceTimersByTime(TREE_REFRESH_JITTER_MS);

    const stale = (key: unknown[]) => client.getQueryState(key)?.isInvalidated;
    expect(stale(['tree', 'sp'])).toBe(true);
    expect(stale(['tree', 'other'])).toBe(false);
    expect(stale(['notifications'])).toBe(false);
    expect(stale(['spaces'])).toBe(false);
  });
});

describe('requestAllTreeRefresh (the socket came back after a break)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cancelPendingTreeRefreshes();
    vi.useRealTimers();
  });

  it('marks every cached tree stale at once but refetches only the ones somebody is looking at, once each, after the delay', async () => {
    const client = makeClient();
    const fetched: string[] = [];
    const queryFn = (space: string) => () => {
      fetched.push(space);
      return Promise.resolve({ tree: [] });
    };
    // 'open' has a mounted observer, 'background' is only cached (a space the user visited earlier).
    await client.prefetchQuery({ queryKey: ['tree', 'background'], queryFn: queryFn('background') });
    const observer = new QueryObserver(client, { queryKey: ['tree', 'open'], queryFn: queryFn('open') });
    const stop = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    fetched.length = 0;

    requestAllTreeRefresh(client);
    expect(client.getQueryState(['tree', 'background'])?.isInvalidated).toBe(true); // stale immediately, fetched when it is next shown
    expect(fetched).toEqual([]); // nothing hits the server in the same tick

    await vi.advanceTimersByTimeAsync(TREE_REFRESH_JITTER_MS);
    expect(fetched).toEqual(['open']);
    stop();
  });
});

/**
 * The client state machine over a LONG session — the live check found the first dozen signals fine and
 * later ones not reaching the server. Nothing in this module may accumulate: every isolated signal, however
 * many came before, is one request within the spread; and a signal is never swallowed by the one before it.
 */
describe('requestTreeRefresh over a long session (a mounted tree, fake clock)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cancelPendingTreeRefreshes();
    focusManager.setFocused(undefined);
    onlineManager.setOnline(true);
    vi.useRealTimers();
  });

  /** A mounted tree observer whose fetch takes `fetchMs` and returns the number of the fetch that produced it. */
  function mountTree(client: QueryClient, fetchMs = 20) {
    const starts: number[] = [];
    let counter = 0;
    const observer = new QueryObserver(client, {
      queryKey: ['tree', 'sp'],
      queryFn: () => {
        counter += 1;
        const mine = counter;
        starts.push(Date.now());
        return new Promise<number>((resolve) => setTimeout(() => resolve(mine), fetchMs));
      },
    });
    const stop = observer.subscribe(() => {});
    return { starts, stop, data: () => client.getQueryData<number>(['tree', 'sp']) };
  }

  it('three hundred isolated signals over a simulated two hours are three hundred requests, each within the spread', async () => {
    const client = makeClient();
    const tree = mountTree(client);
    await vi.advanceTimersByTimeAsync(100);
    const base = tree.starts.length;

    for (let i = 0; i < 300; i++) {
      const signalAt = Date.now();
      requestTreeRefresh(client, 'sp');
      await vi.advanceTimersByTimeAsync(TREE_REFRESH_JITTER_MS + 50);
      expect(tree.starts.length, `signal ${i} did not reach the server`).toBe(base + i + 1);
      expect(tree.starts[base + i] - signalAt).toBeLessThanOrEqual(TREE_REFRESH_JITTER_MS);
      await vi.advanceTimersByTimeAsync(24_000);
    }
    tree.stop();
  });

  it('a signal that arrives while the previous refetch is still in flight is not lost: the last fetch starts after it and its data is the data shown', async () => {
    const client = makeClient();
    const tree = mountTree(client, 1000);
    await vi.advanceTimersByTimeAsync(1200);
    const base = tree.starts.length;

    requestTreeRefresh(client, 'sp');
    await vi.advanceTimersByTimeAsync(TREE_REFRESH_JITTER_MS + 10); // fetch #1 is now in flight (1 s long)
    expect(tree.starts.length).toBe(base + 1);
    await vi.advanceTimersByTimeAsync(300);
    const secondSignalAt = Date.now();
    requestTreeRefresh(client, 'sp'); // the change this one announces may not be in fetch #1
    await vi.advanceTimersByTimeAsync(5000);

    expect(tree.starts.length).toBe(base + 2);
    expect(tree.starts[base + 1]).toBeGreaterThanOrEqual(secondSignalAt);
    expect(tree.data()).toBe(base + 2);
    tree.stop();
  });

  it('a tab that is mounted but not focused (hidden, in the background) still refetches', async () => {
    const client = makeClient();
    const tree = mountTree(client);
    await vi.advanceTimersByTimeAsync(100);
    const base = tree.starts.length;

    focusManager.setFocused(false);
    requestTreeRefresh(client, 'sp');
    await vi.advanceTimersByTimeAsync(TREE_REFRESH_JITTER_MS + 50);
    expect(tree.starts.length).toBe(base + 1);
    tree.stop();
  });

  it('after a failed refetch the next signal still refetches (an error does not wedge the query)', async () => {
    const client = makeClient();
    let fail = false;
    let calls = 0;
    const observer = new QueryObserver(client, {
      queryKey: ['tree', 'sp'],
      retry: false,
      queryFn: async () => {
        calls += 1;
        if (fail) throw new Error('502 while the server restarts');
        return calls;
      },
    });
    const stop = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(100);

    fail = true;
    requestTreeRefresh(client, 'sp');
    await vi.advanceTimersByTimeAsync(TREE_REFRESH_JITTER_MS + 50);
    const afterFailure = calls;
    fail = false;
    requestTreeRefresh(client, 'sp');
    await vi.advanceTimersByTimeAsync(TREE_REFRESH_JITTER_MS + 50);
    expect(calls).toBe(afterFailure + 1);
    expect(client.getQueryData(['tree', 'sp'])).toBe(calls);
    stop();
  });

  it('a signal that arrives while the app is offline refetches when it comes back, not never', async () => {
    const client = makeClient();
    client.mount(); // what QueryClientProvider does: it wires the online manager to the paused fetches
    const tree = mountTree(client);
    await vi.advanceTimersByTimeAsync(100);
    const base = tree.starts.length;

    onlineManager.setOnline(false);
    requestTreeRefresh(client, 'sp');
    await vi.advanceTimersByTimeAsync(TREE_REFRESH_JITTER_MS + 50);
    onlineManager.setOnline(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(tree.starts.length).toBeGreaterThanOrEqual(base + 1);
    tree.stop();
    client.unmount();
  });
});
