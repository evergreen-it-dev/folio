import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreatePageBody, PageMeta } from '@shared/contracts';

const createPage = vi.fn<(body: CreatePageBody) => Promise<PageMeta>>();

vi.mock('../api', () => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
      readonly body?: unknown,
    ) {
      super(message);
    }
  }
  return { ApiError, api: { createPage: (body: CreatePageBody) => createPage(body) } };
});

const clearPersistedState = vi.fn<(pageId: string) => Promise<void>>(async () => undefined);

vi.mock('./ydocPersistence', async (original) => ({
  ...(await original<typeof import('./ydocPersistence')>()),
  clearPersistedState: (pageId: string) => clearPersistedState(pageId),
}));

import { ApiError } from '../api';
import { resetConnectivityForTests } from './connectivity';
import { memoryStore } from './db';
import { resetDirtyDocsForTests } from './dirtyDocs';
import { onLocalPageSynced } from './events';
import { createLocalPage, getLocalPage, listLocalPages, resetLocalPagesForTests, type LocalPage } from './localPages';
import { registerOpenSession, resetOpenSessionsForTests } from './openSessions';
import { requestSync, resetSyncEngineForTests, retryLocalPage } from './syncEngine';

const meta = (body: CreatePageBody, path: string): PageMeta => ({
  id: body.id!,
  space: body.space,
  path,
  kind: body.kind ?? 'doc',
  title: body.title,
  order: 0,
  status: 'draft',
  updatedAt: '2026-09-29T00:00:00.000Z',
});

beforeEach(() => {
  createPage.mockReset();
  clearPersistedState.mockClear();
  resetOpenSessionsForTests();
  resetLocalPagesForTests(memoryStore<LocalPage>((page) => page.id));
  resetDirtyDocsForTests(memoryStore((doc) => doc.pageId));
  resetSyncEngineForTests();
  resetConnectivityForTests();
});

afterEach(() => vi.restoreAllMocks());

describe('the sync engine', () => {
  it('creates the page on the server under the id it already has, with its Yjs state', async () => {
    const page = await createLocalPage({ space: 's', parentPath: 'notes', title: 'Plan', kind: 'doc' });
    createPage.mockImplementation(async (body) => meta(body, 'notes/plan.md'));
    const synced: string[] = [];
    onLocalPageSynced('*', (m) => synced.push(m.id));

    await requestSync();

    expect(createPage).toHaveBeenCalledTimes(1);
    const body = createPage.mock.calls[0][0];
    expect(body).toMatchObject({ id: page.id, space: 's', parentPath: 'notes', title: 'Plan', kind: 'doc' });
    expect(typeof body.ydocState).toBe('string');
    expect(body.ydocState!.length).toBeGreaterThan(0);
    expect(listLocalPages()).toEqual([]);
    expect(synced).toEqual([page.id]);
  });

  it('syncs a parent before its child, and creates the child in the parent\'s REAL directory', async () => {
    const parent = await createLocalPage({ space: 's', parentPath: '', title: 'Parent', kind: 'doc' });
    const child = await createLocalPage({ space: 's', parentPath: parent.path.replace(/\.md$/, ''), title: 'Child', kind: 'board' });
    expect(child.parentId).toBe(parent.id);
    // The server picks its own (transliterated) file name for the parent.
    createPage.mockImplementation(async (body) => meta(body, body.id === parent.id ? 'batko.md' : 'batko/dytyna.excalidraw.svg'));

    await requestSync();

    expect(createPage.mock.calls.map(([body]) => body.id)).toEqual([parent.id, child.id]);
    expect(createPage.mock.calls[1][0].parentPath).toBe('batko');
    expect(listLocalPages()).toEqual([]);
  });

  it('deletes the on-disk copy of a synced page nobody has open, and leaves an open one to its session', async () => {
    const closed = await createLocalPage({ space: 's', parentPath: '', title: 'Closed', kind: 'doc' });
    const open = await createLocalPage({ space: 's', parentPath: '', title: 'Open', kind: 'doc' });
    registerOpenSession(open.id);
    createPage.mockImplementation(async (body) => meta(body, `${body.title}.md`));

    await requestSync();

    expect(clearPersistedState.mock.calls.map(([id]) => id)).toEqual([closed.id]);
  });

  it('keeps everything and stops when the network is still down', async () => {
    const first = await createLocalPage({ space: 's', parentPath: '', title: 'One', kind: 'doc' });
    await createLocalPage({ space: 's', parentPath: '', title: 'Two', kind: 'doc' });
    createPage.mockRejectedValue(new TypeError('Failed to fetch'));

    await requestSync();

    expect(createPage).toHaveBeenCalledTimes(1);
    expect(listLocalPages().map((p) => p.state)).toEqual(['pending', 'pending']);
    expect(getLocalPage(first.id)?.attempts).toBe(1);
  });

  it('marks a page the server refused as failed, moves on, and retries it on request', async () => {
    const refused = await createLocalPage({ space: 's', parentPath: '', title: 'No', kind: 'doc' });
    const fine = await createLocalPage({ space: 's', parentPath: '', title: 'Yes', kind: 'doc' });
    createPage.mockImplementation(async (body) => {
      if (body.id === refused.id) throw new ApiError(403, 'forbidden');
      return meta(body, 'yes.md');
    });

    await requestSync();

    expect(getLocalPage(refused.id)).toMatchObject({ state: 'failed', error: 'forbidden' });
    expect(getLocalPage(fine.id)).toBeUndefined();

    // A failed page is not retried by itself…
    createPage.mockClear();
    await requestSync();
    expect(createPage).not.toHaveBeenCalled();

    // …only when the author asks.
    createPage.mockImplementation(async (body) => meta(body, 'no.md'));
    await retryLocalPage(refused.id);
    expect(listLocalPages()).toEqual([]);
  });

  it('does nothing while the connection is known to be offline', async () => {
    await createLocalPage({ space: 's', parentPath: '', title: 'One', kind: 'doc' });
    resetConnectivityForTests({ state: 'offline' });

    await requestSync();

    expect(createPage).not.toHaveBeenCalled();
    expect(listLocalPages()).toHaveLength(1);
  });
});
