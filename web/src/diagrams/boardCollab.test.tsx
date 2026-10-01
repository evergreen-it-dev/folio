// @vitest-environment jsdom
/**
 * Offline mode in the board's collab hooks (app/collabOffline.ts holds the
 * rules and is tested on its own): a signed-in board opens its socket only
 * after its on-disk copy is in the doc, a board created offline never
 * connects until the server has it — and then connects the SAME provider —
 * and a share link is left exactly as it was.
 *
 * y-websocket is mocked, as in editor/collab.test.tsx: the wire protocol is
 * not what is being asked about.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { emitLocalPageSynced } from '../app/offline/events';
import { isDocDirty, resetDirtyDocsForTests } from '../app/offline/dirtyDocs';
import { createLocalPage, localPageMeta, removeLocalPage, resetLocalPagesForTests } from '../app/offline/localPages';

vi.mock('../app/auth/AuthProvider', () => ({ useAuthOptional: () => ({ user: { id: 'u1', name: 'Ivan', username: 'ivan' } }) }));

const providers = vi.hoisted(() => ({
  created: [] as Array<{ options: Record<string, unknown>; connect: ReturnType<typeof vi.fn>; wsconnected: boolean }>,
}));

vi.mock('y-websocket', () => {
  class FakeAwareness {
    setLocalStateField() {}
    getStates() {
      return new Map();
    }
    on() {}
    off() {}
  }
  class FakeProvider {
    awareness = new FakeAwareness();
    wsconnected = false;
    wsconnecting = false;
    synced = false;
    options: Record<string, unknown>;
    private handlers = new Map<string, Set<(...args: unknown[]) => void>>();
    constructor(_url: string, _room: string, _doc: unknown, options: Record<string, unknown>) {
      this.options = options;
      providers.created.push(this);
    }
    connect = vi.fn(() => {
      this.wsconnecting = true;
      this.emit('status', { status: 'connecting' });
    });
    on(event: string, handler: (...args: unknown[]) => void) {
      const set = this.handlers.get(event) ?? new Set();
      set.add(handler);
      this.handlers.set(event, set);
    }
    off(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.get(event)?.delete(handler);
    }
    emit(event: string, ...args: unknown[]) {
      for (const handler of [...(this.handlers.get(event) ?? [])]) handler(...args);
    }
    destroy() {}
  }
  return { WebsocketProvider: FakeProvider };
});

const { useBoardCollabSession, useBoardConnectionStatus, useBoardSynced } = await import('./boardCollab');

afterEach(() => {
  cleanup();
  providers.created.length = 0;
  resetLocalPagesForTests();
  resetDirtyDocsForTests();
});

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function useBoard(pageId: string, params?: Record<string, string>, space?: string) {
  const session = useBoardCollabSession(pageId, 'ws://x/collab', params, space);
  return { session, status: useBoardConnectionStatus(session), synced: useBoardSynced(session) };
}

describe('useBoardCollabSession offline mode', () => {
  it('a share link is left exactly as it was: the socket opens at once, the session is there at once, nothing is recorded', () => {
    const { result } = renderHook(() => useBoard('board-s', { share: 'tok' }, 'eng'), { wrapper });

    expect(result.current.session).not.toBeNull();
    expect(providers.created[0].options.connect).toBe(true);
    expect(providers.created[0].connect).not.toHaveBeenCalled();
    result.current.session!.elements.set('a', 1);
    expect(isDocDirty('board-s')).toBe(false);
  });

  it('a server board: the provider starts disconnected and is connected once its on-disk copy is in; an edit made while the socket is down is recorded with its kind and space', async () => {
    const { result } = renderHook(() => useBoard('board-srv', undefined, 'eng'), { wrapper });

    expect(providers.created[0].options.connect).toBe(false);
    await waitFor(() => expect(result.current.session).not.toBeNull());
    expect(providers.created[0].connect).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('connecting');

    result.current.session!.elements.set('a', 1);
    expect(isDocDirty('board-srv')).toBe(true);
  });

  it('a local board: never connected, reports synced and offline, and connects its SAME provider once the server has created it', async () => {
    const page = await createLocalPage({ space: 'eng', parentPath: '', title: 'Offline board', kind: 'board' });
    const { result } = renderHook(() => useBoard(page.id, undefined, 'eng'), { wrapper });

    expect(providers.created[0].options.connect).toBe(false);
    await waitFor(() => expect(result.current.session).not.toBeNull());
    const before = result.current.session;
    expect(before!.startedLocal).toBe(true);
    expect(providers.created[0].connect).not.toHaveBeenCalled();
    expect(result.current.synced).toBe(true);
    expect(result.current.status).toBe('offline');

    // Drawing offline is not an "unsynced server page" — the registry covers it.
    before!.elements.set('a', 1);
    expect(isDocDirty(page.id)).toBe(false);

    await act(async () => {
      await removeLocalPage(page.id);
      emitLocalPageSynced({ ...localPageMeta(page), path: 'offline-board.excalidraw.svg', order: 3 });
    });

    expect(providers.created).toHaveLength(1);
    expect(providers.created[0].connect).toHaveBeenCalledTimes(1);
    expect(result.current.session).toBe(before);
    expect(result.current.synced).toBe(true);
    expect(result.current.status).toBe('connecting');
  });

  it('a space that arrives after the session opened does not rebuild it — and is used from then on', async () => {
    const { result, rerender } = renderHook(({ space }: { space?: string }) => useBoard('board-late', undefined, space), {
      wrapper,
      initialProps: {} as { space?: string },
    });
    await waitFor(() => expect(result.current.session).not.toBeNull());
    const before = result.current.session;

    result.current.session!.elements.set('a', 1);
    expect(isDocDirty('board-late')).toBe(false); // no space yet: skipped

    rerender({ space: 'eng' });
    expect(result.current.session).toBe(before);
    expect(providers.created).toHaveLength(1);
    result.current.session!.elements.set('b', 2);
    expect(isDocDirty('board-late')).toBe(true);
  });
});
