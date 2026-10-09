// @vitest-environment jsdom
/**
 * "Replace with new version…" for file pages: where the entry points are shown (tree row menu, page header),
 * who sees them, the upload flow (request, refreshed queries, the «Undo» toast) and the drop target with its
 * confirmation. The server side (id kept, extension rule, 403, restore) is in server/replaceFilePage.test.ts.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import { ToastProvider } from '../ui/Toast';
import { PageTree } from '../sidebar/PageTree';
import { Header } from '../header/Header';
import { ReplaceFileDropZone } from './ReplaceFileDropZone';
import '../i18n/register';

let spaceRole: 'viewer' | 'editor' = 'editor';
vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'u1', name: 'Test User', email: 't@t.local', isAdmin: false, createdAt: '' },
    memberships: {},
    logout: () => {},
    loggingOut: false,
  }),
  useSpaceRole: () => spaceRole,
}));

beforeAll(async () => {
  await i18next.changeLanguage('en');
});
beforeEach(() => {
  spaceRole = 'editor';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const node = (over: Record<string, unknown>) => ({ space: 'sp', kind: 'doc', order: 0, status: 'published', updatedAt: '', children: [], ...over });
const TREE = {
  tree: [
    node({
      id: 'root',
      path: 'index.md',
      title: 'Root',
      children: [
        node({ id: 'doc1', path: 'notes.md', title: 'Notes', order: 10 }),
        node({ id: 'deck1', path: 'deck.pptx', title: 'deck.pptx', kind: 'office', order: 20 }),
        node({ id: 'pdf1', path: 'report.pdf', title: 'report.pdf', kind: 'pdf', order: 30 }),
      ],
    }),
  ],
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** Records requests; answers the replace POST with `previousSha`, everything else with the tree / an empty object. */
function stubFetch(previousSha: string | null = 'abc1234'): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body });
      const ok = (json: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(json) });
      if (url.endsWith('/templates')) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: 'not found' }) });
      if (method === 'POST' && /\/api\/pages\/[^/]+\/file$/.test(url)) return ok({ id: 'deck1', path: 'deck.pptx', title: 'deck.pptx', kind: 'office', previousSha });
      if (method === 'GET' && url.includes('/tree')) return ok(TREE);
      return ok({});
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

const rowFor = (title: string) => screen.getAllByText(title)[0].closest('[role="button"]') as HTMLElement;

async function renderTree(canEdit = true) {
  render(
    <Wrapper>
      <PageTree space="sp" activeId={undefined} activeFolderPath={undefined} canEdit={canEdit} />
    </Wrapper>,
  );
  await waitFor(() => expect(screen.getByText('Notes')).toBeTruthy());
}

function openMoreMenu(title: string) {
  fireEvent.click(within(rowFor(title)).getByLabelText('More actions'));
}

const REPLACE = 'Replace with new version…';

describe('tree row menu', () => {
  it('offers the item on a pptx and a pdf row, not on a document row', async () => {
    stubFetch();
    await renderTree();

    openMoreMenu('deck.pptx');
    expect(screen.getByText(REPLACE)).toBeTruthy();
    cleanup();

    await renderTree();
    openMoreMenu('report.pdf');
    expect(screen.getByText(REPLACE)).toBeTruthy();
    cleanup();

    await renderTree();
    openMoreMenu('Notes');
    expect(screen.getByText('Change slug')).toBeTruthy(); // the menu is open
    expect(screen.queryByText(REPLACE)).toBeNull();
  });

  it('shows no row menu at all to a viewer', async () => {
    stubFetch();
    await renderTree(false);
    expect(within(rowFor('deck.pptx')).queryByLabelText('More actions')).toBeNull();
    expect(screen.queryByTestId('replace-file-input')).toBeNull();
  });

  it('uploads the chosen file to the page, refreshes the tree, and offers an Undo that restores the replaced version', async () => {
    const calls = stubFetch('abc1234');
    await renderTree();
    const treeRequests = () => calls.filter((c) => c.url.includes('/tree')).length;
    const treeBefore = treeRequests();

    const input = within(rowFor('deck.pptx').parentElement as HTMLElement).getByTestId('replace-file-input') as HTMLInputElement;
    expect(input.accept).toBe('.pdf,.docx,.xlsx,.pptx');
    const file = new File(['PK\u0003\u0004new'], 'deck v2.pptx');
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/pages/deck1/file')).toBe(true));
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/pages/deck1/file')!;
    expect(post.body).toBeInstanceOf(FormData);
    expect(((post.body as FormData).get('file') as File).name).toBe('deck v2.pptx');

    await waitFor(() => expect(screen.getByText('File replaced.')).toBeTruthy());
    expect(treeRequests()).toBeGreaterThan(treeBefore); // the tree was asked again: the name can change with the extension

    fireEvent.click(screen.getByText('Undo'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/pages/deck1/restore/abc1234')).toBe(true));
    await waitFor(() => expect(screen.getByText('Previous version restored')).toBeTruthy());
  });

  it('says so when the new file is identical to the current one, and offers no Undo', async () => {
    stubFetch(null);
    await renderTree();
    const input = within(rowFor('report.pdf').parentElement as HTMLElement).getByTestId('replace-file-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['%PDF-'], 'report.pdf')] } });
    await waitFor(() => expect(screen.getByText(/identical to the current one/)).toBeTruthy());
    expect(screen.queryByText('Undo')).toBeNull();
  });
});

describe('page header', () => {
  function renderHeader(props: { fileActions?: boolean }) {
    return render(
      <Wrapper>
        <Header
          space="sp"
          pageId="deck1"
          pagePath="deck.pptx"
          title="deck.pptx"
          fileActions={props.fileActions}
          presence={[]}
          collapsed={false}
          onToggleCollapse={() => {}}
          onOpenSwitcher={() => {}}
        />
      </Wrapper>,
    );
  }

  it('has the button on a file page for an editor, and the file picker takes all four types', () => {
    stubFetch();
    renderHeader({ fileActions: true });
    expect(screen.getAllByLabelText(REPLACE).length).toBeGreaterThan(0);
    const inputs = screen.getAllByTestId('replace-file-input') as HTMLInputElement[];
    expect(inputs.every((i) => i.accept === '.pdf,.docx,.xlsx,.pptx')).toBe(true);
  });

  it('has no button for a viewer, nor on a page that is not a file', () => {
    stubFetch();
    spaceRole = 'viewer';
    renderHeader({ fileActions: true });
    expect(screen.queryAllByLabelText(REPLACE)).toHaveLength(0);
    cleanup();

    spaceRole = 'editor';
    renderHeader({ fileActions: false });
    expect(screen.queryAllByLabelText(REPLACE)).toHaveLength(0);
  });
});

describe('drop target on the open file page', () => {
  function fileDrag(type: string, target: Element | Window, files: File[] = []) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files, dropEffect: '' } });
    fireEvent(target, event);
  }

  function renderZone(canEdit: boolean) {
    return render(
      <Wrapper>
        <ReplaceFileDropZone space="sp" pageId="deck1" pagePath="deck.pptx" canEdit={canEdit}>
          <div>viewer</div>
        </ReplaceFileDropZone>
      </Wrapper>,
    );
  }

  it('asks «Replace with …?» after a drop, uploads only on confirm, and mentions the extension change', async () => {
    const calls = stubFetch();
    renderZone(true);
    expect(screen.queryByTestId('replace-file-drop')).toBeNull();

    fileDrag('dragenter', window);
    const overlay = await screen.findByTestId('replace-file-drop');
    const dropped = new File(['%PDF-1.4'], 'deck export.pdf');
    fileDrag('drop', overlay, [dropped]);

    expect(await screen.findByText('Replace with “deck export.pdf”?')).toBeTruthy();
    expect(screen.getByText(/file type changes from \.pptx to \.pdf/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false); // nothing uploaded yet

    fireEvent.click(screen.getByText('Replace'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/pages/deck1/file')).toBe(true));
  });

  it('does not upload when the confirmation is cancelled', async () => {
    const calls = stubFetch();
    renderZone(true);
    fileDrag('dragenter', window);
    fileDrag('drop', await screen.findByTestId('replace-file-drop'), [new File(['PK'], 'other.pptx')]);
    await screen.findByText('Replace with “other.pptx”?');
    expect(screen.queryByText(/file type changes/)).toBeNull(); // same extension
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByText('Replace with “other.pptx”?')).toBeNull());
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('refuses a file of an unsupported type with a message and no dialog', async () => {
    const calls = stubFetch();
    renderZone(true);
    fileDrag('dragenter', window);
    fileDrag('drop', await screen.findByTestId('replace-file-drop'), [new File(['x'], 'notes.txt')]);
    await screen.findByText(/Only \.pdf, \.docx, \.xlsx and \.pptx files/);
    expect(screen.queryByText(/Replace with/)).toBeNull();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('does nothing for a viewer', async () => {
    stubFetch();
    renderZone(false);
    fileDrag('dragenter', window);
    expect(screen.queryByTestId('replace-file-drop')).toBeNull();
  });
});
