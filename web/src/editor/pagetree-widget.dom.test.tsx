// @vitest-environment jsdom
/**
 * The `::pagetree` block widget must render the REAL tree, not a plaque.
 *
 * Round 27 regression guard: `pagetree-render.tsx` used to be a placeholder
 * adapter, so live mode showed "⌸ Page tree (depth N)" with zero links
 * while reading mode — rendering the same directive through the same shared
 * component — showed the children. These tests pin the swap: the widget fetches
 * the subtree, draws a link per child, honours `depth`, and says something
 * sensible when there are no children.
 */
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { act } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PagetreeWidget } from './pagetree-widget';

const DOC = '::pagetree{depth=2}';

interface Child {
  id: string;
  space: string;
  path: string;
  title: string;
  icon?: string;
  children: Child[];
}

const child = (id: string, title: string, children: Child[] = [], icon?: string): Child => ({
  id,
  space: 'eng',
  path: `${id}.md`,
  title,
  icon,
  children,
});

/** Every subtree URL the component asked for, in order. */
let requested: string[] = [];

function stubFetch(children: Child[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      requested.push(String(url));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ children }) } as Response);
    }),
  );
}

function stubView(): EditorView {
  return {
    state: EditorState.create({ doc: DOC }),
    posAtDOM: () => 0,
    focus: () => {},
    dispatch: () => {},
  } as unknown as EditorView;
}

async function mount(depth = 2): Promise<HTMLElement> {
  const widget = new PagetreeWidget('page-1', depth, 'uk');
  let dom!: HTMLElement;
  await act(async () => {
    dom = widget.toDOM(stubView());
    document.body.append(dom);
  });
  // One more flushed tick for the fetch promise chain.
  await act(async () => {});
  return dom;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  requested = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('PagetreeWidget', () => {
  it('renders the children as links, not a placeholder', async () => {
    stubFetch([child('c1', 'Child 1', [child('g1', 'Grandchild')]), child('c2', 'Child 2')]);
    const dom = await mount();

    expect(dom.querySelector('.folio-pagetree-placeholder')).toBeNull();
    const links = [...dom.querySelectorAll('a')];
    expect(links.map((a) => a.textContent?.trim())).toEqual(['Child 1', 'Grandchild', 'Child 2']);
    // Real page hrefs, so the tree is navigable rather than decorative.
    expect(links[0]?.getAttribute('href')).toBe('/s/eng/p/c1');
    expect(links[1]?.getAttribute('href')).toBe('/s/eng/p/g1');
  });

  it('asks the server for the depth the directive carries', async () => {
    stubFetch([child('c1', 'Child 1')]);
    await mount(4);
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain('/api/pages/page-1/subtree');
    expect(requested[0]).toContain('depth=4');
  });

  it('shows an empty state — not an empty box — for a page with no children', async () => {
    stubFetch([]);
    const dom = await mount();
    expect(dom.querySelector('a')).toBeNull();
    expect(dom.textContent?.replace(/\s+/g, ' ').trim().length).toBeGreaterThan(0);
    expect(dom.querySelector('.cm-md-pagetree__host')?.textContent?.trim()).not.toBe('');
  });

  it('keeps the source-reveal affordance off the links themselves', async () => {
    stubFetch([child('c1', 'Child 1')]);
    const dom = await mount();
    const link = dom.querySelector('a');
    const onLink = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    link!.dispatchEvent(onLink);
    expect(onLink.defaultPrevented).toBe(false);

    const onBox = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    dom.dispatchEvent(onBox);
    expect(onBox.defaultPrevented).toBe(true);
  });
});
