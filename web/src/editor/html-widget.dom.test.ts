// @vitest-environment jsdom
/**
 * The HTML block preview is read-only — a click reveals the markdown source —
 * with one exception: `<details>` has to open and close in place, or the
 * `/expand` block (and every collapsed section imported from Confluence) can
 * never be read without dropping into the source.
 */
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { act } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HtmlBlockWidget } from './html-widget';

const EXPAND = '<details><summary>More</summary>\n\n<p>Body</p>\n\n</details>';

interface StubView {
  view: EditorView;
  /** Selections the widget asked for — `revealSource` is the only one it makes. */
  reveals: number;
}

function stubView(doc = EXPAND): StubView {
  const stub: StubView = {
    reveals: 0,
    view: {
      state: EditorState.create({ doc }),
      posAtDOM: () => 0,
      focus: () => {},
      dispatch: () => {
        stub.reveals++;
      },
    } as unknown as EditorView,
  };
  return stub;
}

async function mount(html = EXPAND): Promise<{ dom: HTMLElement; stub: StubView }> {
  const stub = stubView(html);
  const widget = new HtmlBlockWidget(html, 'eng', 'a.md', 'uk');
  let dom!: HTMLElement;
  await act(async () => {
    dom = widget.toDOM(stub.view);
    document.body.append(dom);
  });
  return { dom, stub };
}

const click = (node: Element): void => {
  node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('HtmlBlockWidget', () => {
  it('renders the block, details and all', async () => {
    const { dom } = await mount();
    expect(dom.querySelector('details')).not.toBeNull();
    expect(dom.querySelector('summary')?.textContent).toBe('More');
  });

  it('opens and closes on a click on the summary, without revealing the source', async () => {
    const { dom, stub } = await mount();
    const summary = dom.querySelector('summary');
    const details = dom.querySelector('details');
    expect(details?.open).toBe(false);

    click(summary!);
    expect(details?.open).toBe(true);
    click(summary!);
    expect(details?.open).toBe(false);
    expect(stub.reveals).toBe(0);
  });

  it('still reveals the markdown source when the rest of the block is clicked', async () => {
    const { dom, stub } = await mount();
    click(dom.querySelector('p') ?? dom);
    expect(stub.reveals).toBe(1);
    expect(dom.querySelector('details')?.open).toBe(false);
  });
});
