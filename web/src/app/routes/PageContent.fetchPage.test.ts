// @vitest-environment jsdom
/**
 * `fetchPage` (PageContent.tsx) for a page created offline: the local
 * registry answers, and the network is never asked — the page has no file on
 * the server yet, so asking would open the page the user just made as an
 * error. Every other id still goes to the server, unchanged.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageDoc } from '@shared/contracts';

// Only fetchPage is under test; the editors are heavy and irrelevant here.
vi.mock('../../editor', () => ({ PageEditor: () => null }));
vi.mock('../../diagrams', () => ({ BoardEditor: () => null }));

const { fetchPage } = await import('./PageContent');
const { api } = await import('../api');
const { createLocalPage, removeLocalPage, resetLocalPagesForTests } = await import('../offline/localPages');

afterEach(() => {
  vi.restoreAllMocks();
  resetLocalPagesForTests();
});

const SERVER_PAGE: PageDoc = {
  id: 'server-1',
  space: 'eng',
  path: 'notes/a.md',
  kind: 'doc',
  title: 'A',
  order: 0,
  status: 'published',
  updatedAt: '2026-09-01T00:00:00Z',
  markdown: '# A\n',
};

describe('fetchPage', () => {
  it('answers a local doc from the registry without touching the network', async () => {
    const getPage = vi.spyOn(api, 'getPage');
    const getTable = vi.spyOn(api, 'getTable');
    const page = await createLocalPage({ space: 'eng', parentPath: 'notes', title: 'Offline note', kind: 'doc' });

    const doc = await fetchPage(page.id);

    expect(doc).toMatchObject({ id: page.id, space: 'eng', kind: 'doc', title: 'Offline note', path: page.path, markdown: '# Offline note\n\n' });
    expect(getPage).not.toHaveBeenCalled();
    expect(getTable).not.toHaveBeenCalled();
  });

  it('answers a local board from the registry too (no body: the scene is in the Y.Doc)', async () => {
    const getPage = vi.spyOn(api, 'getPage');
    const page = await createLocalPage({ space: 'eng', parentPath: '', title: 'Sketch', kind: 'board' });

    const doc = await fetchPage(page.id);

    expect(doc).toMatchObject({ id: page.id, kind: 'board', title: 'Sketch' });
    expect(doc.markdown).toBeUndefined();
    expect(getPage).not.toHaveBeenCalled();
  });

  it('asks the server for every other id — including a page that WAS local and has since been created', async () => {
    const getPage = vi.spyOn(api, 'getPage').mockResolvedValue(SERVER_PAGE);
    const page = await createLocalPage({ space: 'eng', parentPath: '', title: 'Offline note', kind: 'doc' });
    await removeLocalPage(page.id);

    await expect(fetchPage('server-1')).resolves.toBe(SERVER_PAGE);
    await fetchPage(page.id);
    expect(getPage).toHaveBeenCalledTimes(2);
    expect(getPage).toHaveBeenLastCalledWith(page.id);
  });
});
