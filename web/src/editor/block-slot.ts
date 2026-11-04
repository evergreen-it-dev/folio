/**
 * The frame every block widget is placed in.
 *
 * CodeMirror keeps a height map of the document and fills it from each widget's
 * `getBoundingClientRect().height`, which leaves out margins. `.cm-md-block` has a
 * vertical margin of 0.6rem (editor.css) and the editor content is a flex column, so
 * the margins never collapse: every block widget made the drawn text below it sit
 * ~19px lower than where the height map put it. Clicks and `End` / vertical arrows,
 * which look a position up through the height map, then landed a line too low. The
 * fix is to measure a box that contains the margins: the widget's own element keeps
 * its look and margin; this plain `display: flow-root` slot around it holds them, so
 * its height is the real height of the block.
 *
 * The slot forwards everything to the widget it wraps (`eq`, `updateDOM`, `destroy`,
 * events), so a widget does not know it is wrapped.
 */
import { WidgetType, type EditorView } from '@codemirror/view';

/** The vertical margin of `.cm-md-block` (0.6rem top and bottom at the 16px root size): only an estimate until measured. */
const BLOCK_MARGIN_ESTIMATE = 19.2;

export class BlockSlotWidget extends WidgetType {
  constructor(readonly inner: WidgetType) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof BlockSlotWidget && this.inner.eq(other.inner);
  }

  get estimatedHeight(): number {
    const inner = this.inner.estimatedHeight;
    return inner >= 0 ? inner + BLOCK_MARGIN_ESTIMATE : -1;
  }

  get lineBreaks(): number {
    return this.inner.lineBreaks;
  }

  toDOM(view: EditorView): HTMLElement {
    const slot = document.createElement('div');
    slot.className = 'cm-md-block-slot';
    slot.contentEditable = 'false';
    slot.appendChild(this.inner.toDOM(view));
    return slot;
  }

  updateDOM(slot: HTMLElement, view: EditorView, from: this): boolean {
    const dom = slot.firstElementChild as HTMLElement | null;
    return dom !== null && this.inner.updateDOM(dom, view, from.inner);
  }

  destroy(slot: HTMLElement): void {
    const dom = slot.firstElementChild as HTMLElement | null;
    if (dom) this.inner.destroy(dom);
  }

  ignoreEvent(event: Event): boolean {
    return this.inner.ignoreEvent(event);
  }

  coordsAt(slot: HTMLElement, pos: number, side: number): ReturnType<WidgetType['coordsAt']> {
    const dom = slot.firstElementChild as HTMLElement | null;
    return dom ? this.inner.coordsAt(dom, pos, side) : null;
  }
}
