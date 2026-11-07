// @vitest-environment jsdom
/**
 * Graph view (16.10.2026): the outline panel of a page in a space carries a
 * "Local graph" section — even on a page with no headings and no notes — which
 * asks for the page's neighbourhood and can be put away like Outline/Notes. On
 * a surface without a space (a share link) there is no graph.
 *
 * 16.10.2026 (owner): a visible "Depth" label and a tooltip per depth button;
 * the section collapses from its header and stays collapsed everywhere (one
 * global flag); the tree-structure setting (on by default) is sent with the
 * request so the page's parent and children are neighbours; the empty state
 * says how to get links and shows only with no neighbour at all; a page of
 * another space opens in its own space.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import i18next from 'i18next';
import { OutlinePanel } from './OutlinePanel';

vi.mock('../../editor', () => ({ scrollActiveEditorToHeading: () => false, scrollActiveEditorToOffset: () => false }));
// The canvas itself needs a real 2D context; the panel's wiring is what is under test.
const canvasSpy = vi.fn();
vi.mock('../graph/GraphCanvas', () => ({
  GraphCanvas: (props: { nodes: unknown[] }) => {
    canvasSpy(props);
    return <div data-testid="graph-canvas">{props.nodes.length}</div>;
  },
}));
const getPageGraph = vi.fn();
vi.mock('../api', () => ({ api: { getPageGraph: (...args: unknown[]) => getPageGraph(...args) } }));

beforeAll(async () => {
  await i18next.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

function renderAt(url: string, markdown: string, probe = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/s/:space/p/:id" element={<OutlinePanel markdown={markdown} pageId="P1" />} />
          <Route path="/share/:token" element={<OutlinePanel markdown={markdown} pageId="P1" />} />
        </Routes>
        {probe && <LocationProbe />}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

const GRAPH = {
  nodes: [
    { id: 'P1', title: 'Here', kind: 'doc', path: 'here.md', tags: [], degree: 1 },
    { id: 'P2', title: 'There', kind: 'doc', path: 'there.md', tags: [], degree: 1 },
  ],
  edges: [{ source: 'P1', target: 'P2', count: 1 }],
  totalPages: 2,
  truncated: false,
  limit: 10000,
  center: 'P1',
};

describe('OutlinePanel — local graph section', () => {
  it('shows the local graph of the page at depth 1, even with no headings; depth buttons refetch; it can be hidden', async () => {
    getPageGraph.mockResolvedValue(GRAPH);
    renderAt('/s/acme/p/P1', 'just text, no headings\n');
    const section = await screen.findAllByRole('region', { name: 'Local graph' });
    expect(section.length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getAllByTestId('graph-canvas')[0].textContent).toBe('2'));
    expect(getPageGraph).toHaveBeenCalledWith('P1', 1, 'both', true);

    fireEvent.click(screen.getAllByRole('button', { name: 'Depth' })[0]);
    fireEvent.click(screen.getByRole('menuitemradio', { name: "+ neighbours' links" }));
    await waitFor(() => expect(getPageGraph).toHaveBeenCalledWith('P1', 2, 'both', true));
    expect(JSON.parse(localStorage.getItem('folio:graph:acme')!).depth).toBe(2);

    fireEvent.click(screen.getByRole('button', { name: 'Local graph' }));
    expect(screen.queryAllByTestId('graph-canvas')).toHaveLength(0);
  });

  it('depth lives in a menu inside the canvas: caption, a check on the current row, label per depth', async () => {
    getPageGraph.mockResolvedValue(GRAPH);
    renderAt('/s/acme/p/P1', 'text\n');
    await screen.findAllByTestId('graph-canvas');
    const trigger = screen.getAllByRole('button', { name: 'Depth' })[0];
    expect(trigger.textContent).toBe('direct links');
    fireEvent.click(trigger);
    expect(screen.getByText('Which pages the graph shows')).toBeTruthy();
    expect(screen.getByRole('menuitemradio', { name: 'Direct links only' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitemradio', { name: '+ one more step' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('menuitemradio', { name: '+ one more step' }));
    await waitFor(() => expect(getPageGraph).toHaveBeenCalledWith('P1', 3, 'both', true));
    expect(screen.getAllByRole('button', { name: 'Depth' })[0].textContent).toBe('+ one more step');
  });

  it('collapses from its header, remembered globally (another page, another space): no canvas and no request while collapsed', async () => {
    getPageGraph.mockResolvedValue(GRAPH);
    const first = renderAt('/s/acme/p/P1', 'text\n');
    await screen.findAllByTestId('graph-canvas');
    const header = screen.getAllByRole('button', { name: 'Local graph' })[0];
    expect(header.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(header);
    expect(localStorage.getItem('folio:local-graph-collapsed')).toBe('true');
    expect(screen.queryAllByTestId('graph-canvas')).toHaveLength(0);
    first.unmount();

    getPageGraph.mockClear();
    renderAt('/s/other/p/P1', 'text\n');
    const again = screen.getAllByRole('button', { name: 'Local graph' })[0];
    expect(again.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryAllByTestId('graph-canvas')).toHaveLength(0);
    expect(getPageGraph).not.toHaveBeenCalled();
    fireEvent.click(again);
    await screen.findAllByTestId('graph-canvas');
    expect(localStorage.getItem('folio:local-graph-collapsed')).toBe('false');
  });

  it('sends the tree-structure setting (on by default, off when the space turned it off)', async () => {
    getPageGraph.mockResolvedValue(GRAPH);
    localStorage.setItem('folio:graph:acme', JSON.stringify({ showTree: false }));
    renderAt('/s/acme/p/P1', 'text\n');
    await screen.findAllByTestId('graph-canvas');
    expect(getPageGraph).toHaveBeenCalledWith('P1', 1, 'both', false);
  });

  it('a page whose only neighbour is its parent (a tree edge) is not "empty"; with no neighbour at all the hint says how to get links', async () => {
    getPageGraph.mockResolvedValue({
      ...GRAPH,
      nodes: [GRAPH.nodes[0], { id: 'PARENT', title: 'Parent', kind: 'doc', path: 'parent.md', tags: [], degree: 1 }],
      edges: [{ source: 'PARENT', target: 'P1', count: 1, kind: 'tree' }],
    });
    const first = renderAt('/s/acme/p/P1', 'text\n');
    await waitFor(() => expect(screen.getAllByTestId('graph-canvas')[0].textContent).toBe('2'));
    expect(screen.queryByText('Link pages to each other — they will appear here.')).toBeNull();
    first.unmount();

    getPageGraph.mockResolvedValue({ ...GRAPH, nodes: [GRAPH.nodes[0]], edges: [] });
    renderAt('/s/acme/p/P9', 'text\n');
    expect((await screen.findAllByText('Link pages to each other — they will appear here.')).length).toBeGreaterThan(0);
  });

  it('a page of another space is labelled with its space and opens there', async () => {
    let clicked: ((n: unknown) => void) | undefined;
    getPageGraph.mockResolvedValue({
      ...GRAPH,
      nodes: [GRAPH.nodes[0], { id: 'X1', title: 'Runbook', kind: 'doc', path: 'runbook.md', tags: [], degree: 1, space: 'ops', spaceName: 'Operations' }],
      edges: [{ source: 'P1', target: 'X1', count: 1 }],
    });
    canvasSpy.mockImplementation((props: { nodes: Array<{ id: string; title: string }>; onOpen: (n: unknown) => void }) => {
      clicked = props.onOpen;
    });
    renderAt('/s/acme/p/P1', 'text\n', true);
    await waitFor(() => expect(clicked).toBeTruthy());
    const nodes = canvasSpy.mock.calls.at(-1)![0].nodes as Array<{ id: string; title: string; space?: string }>;
    const other = nodes.find((n) => n.id === 'X1')!;
    expect(other.title).toBe('Operations / Runbook');
    act(() => clicked!(other));
    expect(screen.getByTestId('location').textContent).toBe('/s/ops/p/X1');
  });

  it('renders nothing on a surface without a space when there is nothing to outline', () => {
    const { container } = renderAt('/share/tok', 'no headings\n');
    expect(container.innerHTML).toBe('');
    expect(getPageGraph).not.toHaveBeenCalled();
  });
});
