// @vitest-environment jsdom
/**
 * Fix/doc-share-role: useCollabSession's own identity resolution — the doc
 * half of the same bug boards already got fixed for (fix/share-identity).
 *
 * `/share/:token` mounts OUTSIDE <AuthProvider> (see App.tsx's AppRoutes
 * split and app/collabIdentity.ts's own docblock), so useAuthOptional() reads
 * null there regardless of whether the visitor actually has a session
 * cookie. Before this fix, useCollabSession only ever consulted
 * useAuthOptional() — so a logged-in teammate opening a doc share link while
 * still signed in to Folio showed up to collaborators as a random anonymous
 * "Adjective Animal", same bug diagrams/boardCollab.ts's useBoardCollabSession
 * had. The fix: fall back to useOptionalSessionUser(), which asks
 * GET /api/auth/state directly instead of reading AuthProvider's context.
 *
 * y-websocket is mocked out entirely — this is about identity resolution,
 * not the wire protocol (server/shareCollab.test.ts covers that end to end
 * against a real socket).
 *
 * The second half is offline mode (app/collabOffline.ts, the rules themselves
 * are tested there): what the hook does with them — a signed-in session opens
 * its socket only after the on-disk copy is in, a page created offline never
 * connects until the server has it (and then connects the SAME provider), and
 * a share link is left exactly as it was.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { AuthState } from '@shared/contracts';
import { emitLocalPageSynced } from '../app/offline/events';
import { isDocDirty, resetDirtyDocsForTests } from '../app/offline/dirtyDocs';
import { createLocalPage, localPageMeta, removeLocalPage, resetLocalPagesForTests } from '../app/offline/localPages';

/** Every provider the mocked y-websocket has built, newest last — the hook never hands its provider out before the session is ready, tests need to see the options it was built with. */
const providers = vi.hoisted(() => ({ created: [] as Array<{ options: Record<string, unknown>; connect: ReturnType<typeof vi.fn>; wsconnected: boolean }> }));

vi.mock('../app/auth/AuthProvider', () => ({
  // Simulates rendering on /share/:token: the real useAuthOptional() reads
  // context that simply does not exist there (no <AuthProvider> mounted).
  useAuthOptional: () => null,
}));

vi.mock('y-websocket', () => {
  class FakeAwareness {
    private state: Record<string, unknown> = {};
    setLocalStateField(field: string, value: unknown) {
      this.state[field] = value;
    }
    getLocalState() {
      return this.state;
    }
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

const { useCollabSession, useConnectionStatus, useSynced } = await import('./collab');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  providers.created.length = 0;
  resetLocalPagesForTests();
  resetDirtyDocsForTests();
});

function authState(user: AuthState['user']): AuthState {
  return { needsSetup: false, user, memberships: {}, google: false };
}

function stubAuthFetch(user: AuthState['user']) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: '',
        json: () => Promise.resolve(authState(user)),
      }),
    ),
  );
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('useCollabSession identity — fix/doc-share-role', () => {
  it('a logged-in visitor rendering outside <AuthProvider> (a doc share link) gets their real name/id, not an anonymous guest', async () => {
    stubAuthFetch({
      id: 'u1',
      email: 'ivan@example.com',
      name: 'Ivan Koval',
      isAdmin: false,
      createdAt: '2026-01-01T00:00:00Z',
    });

    const { result } = renderHook(() => useCollabSession('page1', 'ws://x/collab', { share: 'tok1' }), { wrapper });

    await waitFor(() => expect(result.current).not.toBeNull());
    // The very first session opens before GET /api/auth/state has settled
    // (anonUser() fallback) — the fix is that it doesn't STAY that way: once
    // the real user resolves, the session's identity follows.
    await waitFor(() => expect(result.current!.user.id).toBe('u1'));
    expect(result.current!.user.name).toBe('Ivan Koval');
  });

  it('a genuinely anonymous guest (no session at all) still gets the random per-browser guest identity, unaffected by this fix', async () => {
    stubAuthFetch(null);

    const { result } = renderHook(() => useCollabSession('page2', 'ws://x/collab', { share: 'tok2' }), { wrapper });

    await waitFor(() => expect(result.current).not.toBeNull());
    await waitFor(() => expect(result.current!.user.id).toBeUndefined());
    expect(result.current!.user.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });
});

/** Session + the two indicators built on it, as PageEditor wires them. */
function useEditorSession(pageId: string, collabParams?: Record<string, string>, space?: string) {
  const session = useCollabSession(pageId, 'ws://x/collab', collabParams, space);
  return { session, status: useConnectionStatus(session), synced: useSynced(session) };
}

/** Lets the on-disk load (a no-op resolved promise here — jsdom has no IndexedDB) and the hook's own microtasks settle. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('useCollabSession offline mode', () => {
  it('a share link is left exactly as it was: the socket opens at once, the session is there at once, nothing is recorded', async () => {
    stubAuthFetch(null);
    const { result } = renderHook(() => useEditorSession('page-s', { share: 'tok' }, 'eng'), { wrapper });

    // Synchronously after the effect — no waiting for a disk that is never read.
    expect(result.current.session).not.toBeNull();
    expect(providers.created[0].options.connect).toBe(true);
    expect(providers.created[0].connect).not.toHaveBeenCalled();

    result.current.session!.doc.getText('content').insert(0, 'guest edit');
    expect(isDocDirty('page-s')).toBe(false);
  });

  it('a server page: the provider starts disconnected and is connected once its on-disk copy is in', async () => {
    stubAuthFetch(null);
    const { result } = renderHook(() => useEditorSession('page-srv', undefined, 'eng'), { wrapper });

    expect(providers.created[0].options.connect).toBe(false);
    await waitFor(() => expect(result.current.session).not.toBeNull());
    expect(providers.created[0].connect).toHaveBeenCalledTimes(1);
    expect(result.current.session!.startedLocal).toBeUndefined();
    // The session is only handed out once the socket has been asked to open: no flash of 'offline'.
    expect(result.current.status).toBe('connecting');
  });

  it('a local page: a disconnected provider, a session that reports synced and offline, content from the registry when nothing else can supply it', async () => {
    stubAuthFetch(null);
    const page = await createLocalPage({ space: 'eng', parentPath: '', title: 'Offline note', kind: 'doc' });
    const { result } = renderHook(() => useEditorSession(page.id, undefined, 'eng'), { wrapper });

    expect(providers.created[0].options.connect).toBe(false);
    await waitFor(() => expect(result.current.session).not.toBeNull());
    await settle();

    expect(providers.created[0].connect).not.toHaveBeenCalled();
    expect(result.current.session!.startedLocal).toBe(true);
    expect(result.current.synced).toBe(true);
    expect(result.current.status).toBe('offline');
    // No IndexedDB in jsdom: the one allowed fallback.
    expect(result.current.session!.ytext.toString()).toBe('# Offline note\n\n');
  });

  it('a local page connects its SAME provider, once, when the server has created it — same session, same doc, still synced', async () => {
    stubAuthFetch(null);
    const page = await createLocalPage({ space: 'eng', parentPath: '', title: 'Offline note', kind: 'doc' });
    const { result } = renderHook(() => useEditorSession(page.id, undefined, 'eng'), { wrapper });
    await waitFor(() => expect(result.current.session).not.toBeNull());
    const before = result.current.session;

    await act(async () => {
      await removeLocalPage(page.id);
      emitLocalPageSynced({ ...localPageMeta(page), path: 'offline-note.md', order: 3 });
    });

    expect(providers.created).toHaveLength(1);
    expect(providers.created[0].connect).toHaveBeenCalledTimes(1);
    expect(result.current.session).toBe(before);
    expect(result.current.synced).toBe(true);
    expect(result.current.status).toBe('connecting');
  });

  it('an edit made while the socket is down is recorded as unsynced with the space it was given; a local page\'s is not', async () => {
    stubAuthFetch(null);
    const server = renderHook(() => useEditorSession('page-srv', undefined, 'eng'), { wrapper });
    await waitFor(() => expect(server.result.current.session).not.toBeNull());
    server.result.current.session!.doc.getText('content').insert(0, 'typed offline');
    expect(isDocDirty('page-srv')).toBe(true);

    const page = await createLocalPage({ space: 'eng', parentPath: '', title: 'Offline note', kind: 'doc' });
    const local = renderHook(() => useEditorSession(page.id, undefined, 'eng'), { wrapper });
    await waitFor(() => expect(local.result.current.session).not.toBeNull());
    local.result.current.session!.doc.getText('content').insert(0, 'typed offline');
    expect(isDocDirty(page.id)).toBe(false);
  });

  it('a space that arrives after the session opened does not rebuild it — and is used from then on', async () => {
    stubAuthFetch(null);
    const { result, rerender } = renderHook(({ space }: { space?: string }) => useEditorSession('page-late', undefined, space), {
      wrapper,
      initialProps: {} as { space?: string },
    });
    await waitFor(() => expect(result.current.session).not.toBeNull());
    const before = result.current.session;

    result.current.session!.doc.getText('content').insert(0, 'a');
    expect(isDocDirty('page-late')).toBe(false); // no space yet: skipped

    rerender({ space: 'eng' });
    expect(result.current.session).toBe(before);
    expect(providers.created).toHaveLength(1);
    result.current.session!.doc.getText('content').insert(0, 'b');
    expect(isDocDirty('page-late')).toBe(true);
  });
});
