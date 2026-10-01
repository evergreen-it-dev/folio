// @vitest-environment jsdom
/**
 * The multi-block `<details>` preview: a disclosure the reader can actually
 * open, with everything else still dropping into the markdown source. The open
 * state lives in the DOM rather than on the widget, so it has to survive the
 * in-place update CodeMirror does when only the body changed.
 */
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { act } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DetailsWidget } from './details-widget';

interface StubView {
  view: EditorView;
  /** Selections the widget asked for — `revealSource` is the only one it makes. */
  reveals: number;
  measures: number;
}

function stubView(): StubView {
  const stub: StubView = {
    reveals: 0,
    measures: 0,
    view: {
      state: EditorState.create({ doc: '<details><summary>More</summary>\n\nBody\n\n</details>\n' }),
      posAtDOM: () => 0,
      focus: () => {},
      requestMeasure: () => {
        stub.measures++;
      },
      dispatch: () => {
        stub.reveals++;
      },
    } as unknown as EditorView,
  };
  return stub;
}

async function mount(
  widget = new DetailsWidget('More', 'Body **text**', false, 'eng', 'a.md', 'uk'),
): Promise<{ dom: HTMLElement; stub: StubView; widget: DetailsWidget }> {
  const stub = stubView();
  let dom!: HTMLElement;
  await act(async () => {
    dom = widget.toDOM(stub.view);
    document.body.append(dom);
  });
  return { dom, stub, widget };
}

const click = (node: Element): void => {
  node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};

const isOpen = (dom: HTMLElement): boolean => dom.classList.contains('cm-md-details--open');

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('DetailsWidget', () => {
  it('shows the summary and renders the body as markdown', async () => {
    const { dom } = await mount();
    expect(dom.querySelector('.cm-md-details__label')?.textContent).toBe('More');
    expect(dom.querySelector('.cm-md-details__host strong')?.textContent).toBe('text');
  });

  it('falls back to a generic label when the source has no <summary>', async () => {
    const { dom } = await mount(new DetailsWidget('', 'Body', false, 'eng', 'a.md', 'uk'));
    expect(dom.querySelector('.cm-md-details__label')?.textContent).toBeTruthy();
  });

  it('names an empty body instead of rendering a blank block', async () => {
    const { dom } = await mount(new DetailsWidget('More', '', false, 'eng', 'a.md', 'uk'));
    expect(dom.querySelector('.cm-md-details__empty')?.textContent).toBeTruthy();
  });

  it('opens and closes on the chevron, without revealing the source', async () => {
    const { dom, stub } = await mount();
    const chevron = dom.querySelector<HTMLElement>('.cm-md-details__chevron')!;
    expect(isOpen(dom)).toBe(false);
    expect(chevron.getAttribute('aria-expanded')).toBe('false');

    click(chevron);
    expect(isOpen(dom)).toBe(true);
    expect(chevron.getAttribute('aria-expanded')).toBe('true');
    // The block changed height — CodeMirror has to be told.
    expect(stub.measures).toBe(1);

    click(chevron);
    expect(isOpen(dom)).toBe(false);
    expect(stub.reveals).toBe(0);
  });

  it('reveals the markdown source on a click anywhere else', async () => {
    const { dom, stub } = await mount();
    click(dom.querySelector('.cm-md-details__label')!);
    expect(stub.reveals).toBe(1);
    click(dom.querySelector('.cm-md-details__host') ?? dom);
    expect(stub.reveals).toBe(2);
    expect(isOpen(dom)).toBe(false);
  });

  it('starts expanded for <details open>', async () => {
    const { dom } = await mount(new DetailsWidget('More', 'Body', true, 'eng', 'a.md', 'uk'));
    expect(isOpen(dom)).toBe(true);
    expect(dom.querySelector('.cm-md-details__chevron')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps the block open across an in-place body update', async () => {
    const { dom } = await mount();
    click(dom.querySelector<HTMLElement>('.cm-md-details__chevron')!);
    expect(isOpen(dom)).toBe(true);

    const next = new DetailsWidget('Other', 'Rewritten', false, 'eng', 'a.md', 'uk');
    let updated = false;
    await act(async () => {
      updated = next.updateDOM(dom);
    });
    expect(updated).toBe(true);
    expect(isOpen(dom)).toBe(true);
    expect(dom.querySelector('.cm-md-details__label')?.textContent).toBe('Other');
    expect(dom.querySelector('.cm-md-details__host')?.textContent).toContain('Rewritten');
  });

  it('compares by content, so an unchanged block is never rebuilt', () => {
    const widget = new DetailsWidget('More', 'Body', false, 'eng', 'a.md', 'uk');
    expect(widget.eq(new DetailsWidget('More', 'Body', false, 'eng', 'a.md', 'uk'))).toBe(true);
    expect(widget.eq(new DetailsWidget('More', 'Other', false, 'eng', 'a.md', 'uk'))).toBe(false);
    expect(widget.eq(new DetailsWidget('More', 'Body', true, 'eng', 'a.md', 'uk'))).toBe(false);
  });
});
