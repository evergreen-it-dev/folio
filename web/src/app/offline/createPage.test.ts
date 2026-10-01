import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { CreatePageBody, PageMeta } from '@shared/contracts';

const createPage = vi.fn<(body: CreatePageBody) => Promise<PageMeta>>();
const getTree = vi.fn();

vi.mock('../api', () => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { ApiError, api: { createPage: (body: CreatePageBody) => createPage(body), getTree: (space: string) => getTree(space) } };
});

import { ApiError } from '../api';
import { resetConnectivityForTests } from './connectivity';
import { OfflineUnsupportedError, createPageOfflineAware, treeOfflineAware } from './createPage';
import { memoryStore } from './db';
import { resetDirtyDocsForTests } from './dirtyDocs';
import { discardLocalPage, isLocalPageId, listLocalPages, resetLocalPagesForTests, type LocalPage } from './localPages';
import { resetSyncEngineForTests } from './syncEngine';

const body: CreatePageBody = { space: 's', parentPath: '', title: 'New page', kind: 'doc' };

beforeEach(() => {
  createPage.mockReset();
  getTree.mockReset();
  resetLocalPagesForTests(memoryStore<LocalPage>((page) => page.id));
  resetDirtyDocsForTests(memoryStore((doc) => doc.pageId));
  resetSyncEngineForTests();
  resetConnectivityForTests();
});

describe('createPageOfflineAware', () => {
  it('is the plain server call while the server answers', async () => {
    createPage.mockResolvedValue({ id: 'X', space: 's', path: 'x.md', kind: 'doc', title: 'x', order: 0, status: 'draft', updatedAt: '' });
    const created = await createPageOfflineAware(new QueryClient(), body);
    expect(created.local).toBe(false);
    expect(listLocalPages()).toEqual([]);
  });

  it('creates the page on this device when the request cannot reach the server', async () => {
    createPage.mockRejectedValue(new TypeError('Failed to fetch'));
    const client = new QueryClient();
    const created = await createPageOfflineAware(client, body);
    expect(created.local).toBe(true);
    expect(isLocalPageId(created.page.id)).toBe(true);
    expect(created.page.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    // The page route reads this instead of asking a server that is not there.
    expect(client.getQueryData(['page', created.page.id])).toMatchObject({ id: created.page.id, markdown: '# New page\n\n' });
  });

  it('treats the proxy answering for a missing app (502/503) as unreachable, but not a gateway timeout', async () => {
    createPage.mockRejectedValue(new ApiError(503, 'Service Unavailable'));
    expect((await createPageOfflineAware(new QueryClient(), body)).local).toBe(true);
    // 504: the app may have created the page already — a local twin would be a duplicate.
    createPage.mockRejectedValue(new ApiError(504, 'Gateway Timeout'));
    await expect(createPageOfflineAware(new QueryClient(), body)).rejects.toMatchObject({ status: 504 });
  });

  it('does not even try the server when the connection is known to be down', async () => {
    resetConnectivityForTests({ state: 'offline' });
    const created = await createPageOfflineAware(new QueryClient(), { ...body, kind: 'board' });
    expect(createPage).not.toHaveBeenCalled();
    expect(created).toMatchObject({ local: true, page: { kind: 'board' } });
  });

  it('lets a refusal from the server through — a local copy would only postpone it', async () => {
    createPage.mockRejectedValue(new ApiError(403, 'forbidden'));
    await expect(createPageOfflineAware(new QueryClient(), body)).rejects.toMatchObject({ status: 403 });
    expect(listLocalPages()).toEqual([]);
  });

  it('says so when the kind needs the server', async () => {
    resetConnectivityForTests({ state: 'offline' });
    await expect(createPageOfflineAware(new QueryClient(), { ...body, kind: 'table' })).rejects.toBeInstanceOf(OfflineUnsupportedError);
  });

  it('keeps provisional paths unique, against the cached tree and against each other', async () => {
    resetConnectivityForTests({ state: 'offline' });
    const client = new QueryClient();
    client.setQueryData(['tree', 's'], {
      tree: [{ id: 'A', space: 's', path: 'new-page.md', kind: 'doc', title: 'a', order: 0, status: 'draft', updatedAt: '', children: [] }],
    });
    const one = await createPageOfflineAware(client, body);
    const two = await createPageOfflineAware(client, body);
    expect(new Set(['new-page.md', one.page.path, two.page.path]).size).toBe(3);
  });
});

describe('discardLocalPage', () => {
  it('takes the local children with it', async () => {
    resetConnectivityForTests({ state: 'offline' });
    const client = new QueryClient();
    const parent = await createPageOfflineAware(client, body);
    const child = await createPageOfflineAware(client, { ...body, parentPath: parent.page.path.replace(/\.md$/, ''), title: 'Child' });
    const removed = await discardLocalPage(parent.page.id);
    expect(removed.sort()).toEqual([parent.page.id, child.page.id].sort());
    expect(listLocalPages()).toEqual([]);
  });
});

describe('treeOfflineAware', () => {
  it('answers from the cache when the server cannot be reached', async () => {
    const client = new QueryClient();
    const cached = { tree: [] };
    client.setQueryData(['tree', 's'], cached);
    getTree.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await treeOfflineAware(client, 's')).toBe(cached);
    resetConnectivityForTests({ state: 'offline' });
    getTree.mockClear();
    expect(await treeOfflineAware(client, 's')).toBe(cached);
    expect(getTree).not.toHaveBeenCalled();
  });
});
