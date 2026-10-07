// @vitest-environment jsdom
/**
 * The offline half of a collab session (collabOffline.ts), against a fake
 * socket provider and a fake on-disk persistence — the two things whose
 * timing the rules are all about: WHEN the socket opens, WHAT is recorded as
 * unsynced, and whether the on-disk copy is deleted or kept when the session
 * ends. The hooks that use it are covered in editor/collab.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import type { WebsocketProvider } from 'y-websocket';
import type { PageMeta } from '@shared/contracts';
import type { LocalPage } from './offline/localPages';

const disk = vi.hoisted(() => ({
  /** One fake persistence per persistYDoc call, newest last. */
  created: [] as Array<{
    pageId: string;
    resolveLoaded: () => void;
    clear: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }>,
  /** When false, `whenLoaded` stays pending until a test resolves it by hand. */
  autoLoad: true,
  clearedByName: [] as string[],
}));

vi.mock('./offline/ydocPersistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./offline/ydocPersistence')>()),
  persistYDoc: (pageId: string) => {
    let resolveLoaded!: () => void;
    const whenLoaded = new Promise<void>((resolve) => (resolveLoaded = resolve));
    if (disk.autoLoad) resolveLoaded();
    const fake = { pageId, resolveLoaded, clear: vi.fn(async () => undefined), destroy: vi.fn() };
    disk.created.push(fake);
    return { whenLoaded, clear: fake.clear, destroy: fake.destroy };
  },
  clearPersistedState: async (pageId: string) => {
    disk.clearedByName.push(pageId);
  },
}));

const { attachOfflineSession, PERSISTENCE_WAIT_MS } = await import('./collabOffline');
const { createLocalPage, resetLocalPagesForTests, removeLocalPage, localPageMeta } = await import('./offline/localPages');
const { emitLocalPageSynced } = await import('./offline/events');
const { isDocDirty, markDocDirty, resetDirtyDocsForTests } = await import('./offline/dirtyDocs');

/** Just enough of WebsocketProvider for the session: an event emitter, the connection flags and `connect`. */
class FakeProvider {
  wsconnected = false;
  synced = false;
  private handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  connect = vi.fn(() => {
    this.wsconnected = true;
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
  /** The socket is up and the first sync finished. */
  becomeSynced() {
    this.wsconnected = true;
    this.synced = true;
    this.emit('sync', true);
  }
}

function attach(pageId: string, options: { kind?: 'doc' | 'board'; space?: string | undefined } = {}) {
  const doc = new Y.Doc();
  const provider = new FakeProvider();
  const session = attachOfflineSession({
    pageId,
    kind: options.kind ?? 'doc',
    doc,
    provider: provider as unknown as WebsocketProvider,
    getSpace: () => ('space' in options ? options.space : 'eng'),
  });
  return { doc, provider, session };
}

/** An update as y-indexeddb applies one: with the persistence instance as origin. */
function diskOrigin(): unknown {
  return Object.create(IndexeddbPersistence.prototype);
}

async function localDocPage(kind: 'doc' | 'board' = 'doc') {
  return createLocalPage({ space: 'eng', parentPath: '', title: 'Offline note', kind });
}

/** What the sync engine emits: the registry's provisional meta with the server's real path. */
function syncedMeta(page: LocalPage): PageMeta {
  return { ...localPageMeta(page), path: 'offline-note.md', order: 3 };
}

beforeEach(() => {
  resetLocalPagesForTests();
  resetDirtyDocsForTests();
  disk.created.length = 0;
  disk.clearedByName.length = 0;
  disk.autoLoad = true;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a local page (created offline)', () => {
  it('waits for the disk without a bound, never opens the socket, and is not recorded as an unsynced server page', async () => {
    vi.useFakeTimers();
    const page = await localDocPage();
    disk.autoLoad = false;
    const { doc, provider, session } = attach(page.id);
    expect(session.startedLocal).toBe(true);

    let ready = false;
    void session.ready.then(() => (ready = true));
    // Far past the server-page bound: a local page's content exists nowhere but the disk.
    await vi.advanceTimersByTimeAsync(PERSISTENCE_WAIT_MS * 10);
    expect(ready).toBe(false);

    disk.created[0].resolveLoaded();
    await session.ready;
    expect(ready).toBe(true);
    expect(provider.connect).not.toHaveBeenCalled();

    doc.getText('content').insert(0, 'typed offline');
    expect(isDocDirty(page.id)).toBe(false);
  });

  it('connects the SAME provider when the server has created the page, and from then on records offline edits like any server page', async () => {
    const page = await localDocPage();
    const { doc, provider, session } = attach(page.id);
    await session.ready;
    expect(provider.connect).not.toHaveBeenCalled();

    // The sync engine removes the registry entry right before it emits.
    await removeLocalPage(page.id);
    emitLocalPageSynced(syncedMeta(page));
    expect(provider.connect).toHaveBeenCalledTimes(1);

    // The socket drops again: now a server page with an unsynced edit.
    provider.wsconnected = false;
    doc.getText('content').insert(0, 'x');
    expect(isDocDirty(page.id)).toBe(true);
  });

  it('a server-created event that lands while the disk is still loading connects once the load is done, not before', async () => {
    const page = await localDocPage();
    disk.autoLoad = false;
    const { provider, session } = attach(page.id);

    await removeLocalPage(page.id);
    emitLocalPageSynced(syncedMeta(page));
    expect(provider.connect).not.toHaveBeenCalled();

    disk.created[0].resolveLoaded();
    await session.ready;
    expect(provider.connect).toHaveBeenCalledTimes(1);
  });

  it('is decided ONCE, at attach: the registry entry disappearing does not turn it into a server page by itself', async () => {
    const page = await localDocPage();
    const { provider, session } = attach(page.id);
    await session.ready;

    await removeLocalPage(page.id);
    expect(session.startedLocal).toBe(true);
    expect(provider.connect).not.toHaveBeenCalled();
  });

  it('keeps its on-disk copy when it ends before the server has the page', async () => {
    const page = await localDocPage();
    const { session } = attach(page.id);
    await session.ready;

    session.dispose();
    expect(disk.created[0].destroy).toHaveBeenCalledTimes(1);
    expect(disk.created[0].clear).not.toHaveBeenCalled();
  });

  it('a doc with no IndexedDB at all gets its starter text from the registry (the one allowed fallback); a browser WITH IndexedDB never does', async () => {
    const page = await localDocPage();
    const { doc, session } = attach(page.id);
    await session.ready;
    expect(doc.getText('content').toString()).toBe('# Offline note\n\n');

    vi.stubGlobal('indexedDB', {});
    const withDb = attach(page.id);
    await withDb.session.ready;
    expect(withDb.doc.getText('content').toString()).toBe('');
  });

  it('a board never gets starter content', async () => {
    const page = await localDocPage('board');
    const { doc, session } = attach(page.id, { kind: 'board' });
    await session.ready;
    expect(doc.getText('content').toString()).toBe('');
    expect(Y.encodeStateAsUpdate(doc).length).toBeLessThanOrEqual(2);
  });
});

describe('a server page', () => {
  it('opens the socket once the on-disk copy is in the doc, and not before', async () => {
    disk.autoLoad = false;
    const { provider, session } = attach('server-page');
    expect(session.startedLocal).toBe(false);
    await Promise.resolve();
    expect(provider.connect).not.toHaveBeenCalled();

    disk.created[0].resolveLoaded();
    await session.ready;
    expect(provider.connect).toHaveBeenCalledTimes(1);
  });

  it(`connects anyway after ${PERSISTENCE_WAIT_MS}ms if the disk never answers`, async () => {
    vi.useFakeTimers();
    disk.autoLoad = false;
    const { provider, session } = attach('server-page');

    await vi.advanceTimersByTimeAsync(PERSISTENCE_WAIT_MS - 1);
    expect(provider.connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    await session.ready;
    expect(provider.connect).toHaveBeenCalledTimes(1);
  });

  it('records a local edit made while disconnected, exactly once, with its space and kind', async () => {
    const { doc, provider, session } = attach('server-page', { kind: 'board', space: 'ops' });
    await session.ready;
    provider.wsconnected = false;

    doc.getText('content').insert(0, 'a');
    doc.getText('content').insert(1, 'b');
    expect(isDocDirty('server-page')).toBe(true);
    const { listDirtyDocs } = await import('./offline/dirtyDocs');
    expect(listDirtyDocs()).toEqual([expect.objectContaining({ pageId: 'server-page', kind: 'board', space: 'ops' })]);
  });

  it('does not record an edit made while connected, one that arrived from the socket, one loaded from disk, or one with no known space', async () => {
    const connected = attach('page-a');
    await connected.session.ready;
    connected.doc.getText('content').insert(0, 'a');
    expect(isDocDirty('page-a')).toBe(false);

    const remote = attach('page-b');
    await remote.session.ready;
    remote.provider.wsconnected = false;
    remote.doc.transact(() => remote.doc.getText('content').insert(0, 'from the server'), remote.provider);
    remote.doc.transact(() => remote.doc.getText('content').insert(0, 'from the disk'), diskOrigin());
    expect(isDocDirty('page-b')).toBe(false);

    const noSpace = attach('page-c', { space: undefined });
    await noSpace.session.ready;
    noSpace.provider.wsconnected = false;
    noSpace.doc.getText('content').insert(0, 'x');
    expect(isDocDirty('page-c')).toBe(false);
  });

  it('marks the page clean once the socket is connected AND synced', async () => {
    const { provider, session } = attach('server-page');
    await session.ready;
    markDocDirty('server-page', 'doc', 'eng');

    provider.wsconnected = true;
    provider.emit('sync', false); // connected but not synced: nothing yet
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(isDocDirty('server-page')).toBe(true);

    provider.becomeSynced();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(isDocDirty('server-page')).toBe(false);
  });

  it('stops recording and reacting after dispose', async () => {
    const { doc, provider, session } = attach('server-page');
    await session.ready;
    session.dispose();

    doc.getText('content').insert(0, 'late');
    expect(isDocDirty('server-page')).toBe(false);
    markDocDirty('server-page', 'doc', 'eng');
    provider.becomeSynced();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(isDocDirty('server-page')).toBe(true);
  });
});

describe('teardown of a server page', () => {
  it('deletes the on-disk copy when the server was connected and synced', async () => {
    const { provider, session } = attach('server-page');
    await session.ready;
    provider.becomeSynced();

    session.dispose();
    expect(disk.created[0].clear).toHaveBeenCalledTimes(1);
    expect(disk.created[0].destroy).not.toHaveBeenCalled();
  });

  it.each([
    ['never connected', (p: FakeProvider) => void p],
    ['connected but still syncing', (p: FakeProvider) => void (p.wsconnected = true)],
    ['synced, then the socket dropped', (p: FakeProvider) => void ((p.synced = true), (p.wsconnected = false))],
  ])('keeps the on-disk copy of an EDITED page when it was %s, and lists it as unsynced', async (_name, arrange) => {
    const { doc, provider, session } = attach('server-page');
    await session.ready;
    arrange(provider);
    // Typed while the socket may well have looked connected: a connection
    // that died silently says so for up to half a minute.
    doc.getText('content').insert(0, 'typed');

    session.dispose();
    expect(disk.created[0].destroy).toHaveBeenCalledTimes(1);
    expect(disk.created[0].clear).not.toHaveBeenCalled();
    // …so the sync engine delivers it even if nobody opens this page again.
    expect(isDocDirty('server-page')).toBe(true);
  });

  it('keeps the copy of an edited page that is connected and synced but whose edit the SERVER never confirmed (06.10.2026)', async () => {
    // `synced` only means the first exchange is done. A read-only connection —
    // the server drops a viewer's updates — or a dead socket stays "synced"
    // while what was typed goes nowhere; deleting the copy then lost it.
    const { doc, provider, session } = attach('server-page');
    await session.ready;
    provider.becomeSynced();
    doc.getText('content').insert(0, 'typed, never acknowledged');

    session.dispose();
    expect(disk.created[0].clear).not.toHaveBeenCalled();
    expect(disk.created[0].destroy).toHaveBeenCalledTimes(1);
    expect(isDocDirty('server-page')).toBe(true);
  });

  it('deletes the copy of an edited page once the server state vector covers it', async () => {
    const confirmed = { value: false };
    const listeners = new Set<() => void>();
    const ack = {
      isConfirmed: () => confirmed.value,
      pendingSince: () => (confirmed.value ? null : 0),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      whenConfirmed: async () => confirmed.value,
      probe: () => undefined,
      dispose: vi.fn(),
    };
    const doc = new Y.Doc();
    const provider = new FakeProvider();
    const session = attachOfflineSession({ pageId: 'server-page', kind: 'doc', doc, provider: provider as unknown as WebsocketProvider, getSpace: () => 'eng', ack });
    await session.ready;
    provider.becomeSynced();
    doc.getText('content').insert(0, 'typed');
    confirmed.value = true;
    for (const listener of listeners) listener();

    session.dispose();
    expect(disk.created[0].clear).toHaveBeenCalledTimes(1);
    // The caller's tracker is the caller's to dispose.
    expect(ack.dispose).not.toHaveBeenCalled();
  });

  it('deletes the copy of a page that was only looked at while offline — nothing in it the server lacks', async () => {
    const { session } = attach('server-page');
    await session.ready;

    session.dispose();
    expect(disk.created[0].clear).toHaveBeenCalledTimes(1);
    expect(isDocDirty('server-page')).toBe(false);
  });

  it('keeps a copy left unsynced by an EARLIER session, even if this one changed nothing', async () => {
    markDocDirty('server-page', 'doc', 'eng');
    const { session } = attach('server-page');
    await session.ready;

    session.dispose();
    expect(disk.created[0].destroy).toHaveBeenCalledTimes(1);
    expect(disk.created[0].clear).not.toHaveBeenCalled();
    expect(isDocDirty('server-page')).toBe(true);
  });

  it('drops the page from the unsynced list when it deletes the copy', async () => {
    const { provider, session } = attach('server-page');
    await session.ready;
    markDocDirty('server-page', 'doc', 'eng');
    provider.becomeSynced();
    session.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(isDocDirty('server-page')).toBe(false);
  });

  it('a session for the same page waits for the previous delete to finish before it opens the database again', async () => {
    let finishClear!: () => void;
    const { provider, session } = attach('server-page');
    await session.ready;
    provider.becomeSynced();
    disk.created[0].clear.mockImplementation(() => new Promise<void>((resolve) => (finishClear = resolve)));
    session.dispose();

    const next = attach('server-page');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disk.created).toHaveLength(1); // nothing opened yet

    finishClear();
    await next.session.ready;
    expect(disk.created).toHaveLength(2);
    expect(disk.clearedByName).toContain('server-page');
  });

  it('an unmounted session never opens the database at all if it ends while waiting for a previous delete', async () => {
    let finishClear!: () => void;
    const first = attach('server-page');
    await first.session.ready;
    first.provider.becomeSynced();
    disk.created[0].clear.mockImplementation(() => new Promise<void>((resolve) => (finishClear = resolve)));
    first.session.dispose();

    const second = attach('server-page');
    second.session.dispose();
    finishClear();
    await second.session.ready;
    expect(disk.created).toHaveLength(1);
    expect(second.provider.connect).not.toHaveBeenCalled();
  });
});
