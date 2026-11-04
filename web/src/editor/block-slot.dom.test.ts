// @vitest-environment jsdom
/**
 * CodeMirror fills its height map from each block widget's `getBoundingClientRect().height`, which leaves out margins, and
 * `.cm-md-block` has a vertical margin: unaccounted, the drawn text sat ~19px lower than the height map said, so a click or `End`
 * under an MDX block (or a table, an HTML block, ...) landed a line too low. Every block widget is therefore placed in a slot
 * that contains its margins (block-slot.ts). jsdom has no layout, so this pins the structure, not the pixels.
 */
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, WidgetType } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { BlockSlotWidget } from './block-slot';
import { livePreview, livePreviewConfig } from './live-preview';
import { markdownEditorExtensions } from './markdown-setup';

class Probe extends WidgetType {
  destroyed = 0;
  constructor(readonly tag: string) {
    super();
  }
  eq(other: Probe): boolean {
    return other.tag === this.tag;
  }
  get estimatedHeight(): number {
    return 40;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cm-md-block';
    el.textContent = this.tag;
    return el;
  }
  updateDOM(dom: HTMLElement, _view: EditorView, from: Probe): boolean {
    if (from.tag === this.tag) return false;
    dom.textContent = this.tag;
    return true;
  }
  destroy(): void {
    this.destroyed++;
  }
}

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

function mount(doc: string, pagePath: string): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [markdownEditorExtensions(), livePreview, livePreviewConfig(true, { space: 'eng', pagePath, pageId: 'P1' })],
      selection: EditorSelection.single(doc.length),
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

describe('BlockSlotWidget', () => {
  it('wraps the widget in a slot that CodeMirror measures, and adds the margins to the height estimate', () => {
    const slot = new BlockSlotWidget(new Probe('a'));
    const dom = slot.toDOM({} as EditorView);
    expect(dom.className).toBe('cm-md-block-slot');
    expect(dom.firstElementChild?.className).toBe('cm-md-block');
    expect(slot.estimatedHeight).toBeGreaterThan(40);
  });

  it('forwards eq, updateDOM and destroy to the widget it wraps', () => {
    const first = new Probe('a');
    const second = new Probe('b');
    const dom = new BlockSlotWidget(first).toDOM({} as EditorView);

    expect(new BlockSlotWidget(new Probe('a')).eq(new BlockSlotWidget(new Probe('a')))).toBe(true);
    expect(new BlockSlotWidget(new Probe('a')).eq(new BlockSlotWidget(new Probe('b')))).toBe(false);
    expect(new BlockSlotWidget(first).eq(first)).toBe(false);

    const next = new BlockSlotWidget(second);
    expect(next.updateDOM(dom, {} as EditorView, new BlockSlotWidget(first))).toBe(true);
    expect(dom.firstElementChild?.textContent).toBe('b');

    next.destroy(dom);
    expect(second.destroyed).toBe(1);
  });
});

describe('live mode places every block widget in a slot', () => {
  it('an .mdx page: the import lines and a component sit in slots, as do a table and an HTML block of a .md page', () => {
    const mdx = mount(['import X from "./x";', '', '<Aside type="tip">', 'Hello', '</Aside>', '', 'Tail paragraph.'].join('\n'), 'a.mdx');
    const slots = [...mdx.contentDOM.querySelectorAll(':scope > .cm-md-block-slot')];
    expect(slots.map((s) => s.firstElementChild?.className)).toEqual([
      expect.stringContaining('cm-md-mdxblock--esm'),
      expect.stringContaining('cm-md-mdxblock--jsx'),
    ]);
    // nothing of the page is a bare block under the content: a margin there is invisible to CodeMirror
    expect(mdx.contentDOM.querySelectorAll(':scope > .cm-md-block')).toHaveLength(0);

    const md = mount(['| a | b |', '| --- | --- |', '| 1 | 2 |', '', '<div>hi</div>', '', 'Tail paragraph.'].join('\n'), 'a.md');
    expect(md.contentDOM.querySelectorAll(':scope > .cm-md-block-slot > .cm-md-block').length).toBeGreaterThanOrEqual(1);
    expect(md.contentDOM.querySelectorAll(':scope > .cm-md-block')).toHaveLength(0);
  });
});
