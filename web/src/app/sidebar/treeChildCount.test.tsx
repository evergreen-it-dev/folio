// @vitest-environment jsdom
/** A tree row with subpages shows how many direct children it has, before the chevron. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import { ToastProvider } from '../ui/Toast';
import { PageTree } from './PageTree';
import '../i18n/register';

vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'T', email: 't@t.local', isAdmin: false, createdAt: '' }, memberships: {}, logout: () => {}, loggingOut: false }),
  useSpaceRole: () => 'editor' as const,
}));

const node = (over: Record<string, unknown>) => ({ space: 'sp', kind: 'doc', order: 0, status: 'published', updatedAt: '', children: [], ...over });
const TREE = {
  tree: [
    node({
      id: 'root',
      path: 'index.md',
      title: 'Root',
      children: [
        node({ id: 'parent', path: 'Parent.md', title: 'Parent', children: [1, 2, 3].map((n) => node({ id: `c${n}`, path: `Parent/c${n}.md`, title: `Child ${n}` })) }),
        node({ id: 'one', path: 'One.md', title: 'One', children: [node({ id: 'o1', path: 'One/o1.md', title: 'Only' })] }),
        node({ id: 'leaf', path: 'Leaf.md', title: 'Leaf' }),
      ],
    }),
  ],
};

beforeEach(async () => {
  await i18next.changeLanguage('en');
  window.localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/templates') ? { ok: false, status: 404, json: async () => ({ error: 'not found' }) } : { ok: true, status: 200, json: async () => TREE },
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderTree() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastProvider>
          <PageTree space="sp" activeId="leaf" activeFolderPath={undefined} canEdit />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const rowOf = (title: string) => screen.getByText(title).closest('[role="button"]')!;

describe('tree child counter', () => {
  it('shows the direct-child count with an accessible label, collapsed', async () => {
    renderTree();
    await screen.findByText('Parent');
    const badge = rowOf('Parent').querySelector('[data-testid="tree-child-count"]')!;
    expect(badge.textContent).toBe('3');
    expect(badge.getAttribute('aria-label')).toBe('3 subpages');
    expect(rowOf('One').querySelector('[data-testid="tree-child-count"]')!.getAttribute('aria-label')).toBe('1 subpage');
  });

  it('shows nothing on a leaf', async () => {
    renderTree();
    await screen.findByText('Leaf');
    expect(rowOf('Leaf').querySelector('[data-testid="tree-child-count"]')).toBeNull();
  });
});
