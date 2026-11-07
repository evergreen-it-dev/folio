/**
 * The slot under the page title (the page's properties, Notion-like — owner, 07.11.2026).
 *
 * The title is the document's own first line (`# Title`), so "under the title" is inside the text in every mode:
 *
 * - Live / Source: a block widget right after line 1 when that line is an H1, else at the very top. Its DOM is ONE
 *   host element owned by PageEditor (React portals the properties into it), so CodeMirror dropping and re-creating
 *   the widget — scrolled out of the viewport, the decoration rebuilt — moves the same node and never remounts what
 *   is inside it. The widget ignores its events (the fields inside are not the editor's) and asks for a re-measure
 *   whenever the host changes height (the panel opening), or the lines below would keep stale offsets.
 * - Reading: the rendered markdown is not React's to share, so the host is placed by hand after the first H1 — when
 *   the page opens with one — and put back whenever the renderer replaces that part of the page.
 */
import { StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

const H1 = /^#[ \t]/;

class TitleSlotWidget extends WidgetType {
  constructor(readonly host: HTMLElement) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof TitleSlotWidget && other.host === this.host;
  }

  toDOM(view: EditorView): HTMLElement {
    const host = this.host;
    host.contentEditable = 'false';
    watchHeight(host, view);
    return host;
  }

  ignoreEvent(): boolean {
    return true;
  }

  destroy(): void {
    // The host outlives the widget (PageEditor owns it); nothing to tear down here.
  }
}

/** One observer per host: the view it measures is the latest one that drew it. */
const observed = new WeakMap<HTMLElement, { observer: ResizeObserver; view: EditorView }>();

function watchHeight(host: HTMLElement, view: EditorView) {
  const known = observed.get(host);
  if (known) {
    known.view = view;
    return;
  }
  if (typeof ResizeObserver === 'undefined') return;
  const entry = {
    view,
    observer: new ResizeObserver(() => {
      if (entry.view.dom.isConnected) entry.view.requestMeasure();
    }),
  };
  entry.observer.observe(host);
  observed.set(host, entry);
}

function build(state: EditorState, widget: TitleSlotWidget): DecorationSet {
  const first = state.doc.line(1);
  const deco = H1.test(first.text)
    ? Decoration.widget({ widget, block: true, side: 1 }).range(first.to)
    : Decoration.widget({ widget, block: true, side: -1 }).range(0);
  return Decoration.set([deco]);
}

/** The block under the H1 (or at the top), drawing `host`. */
export function titleSlot(host: HTMLElement): Extension {
  const widget = new TitleSlotWidget(host);
  return StateField.define<DecorationSet>({
    create: (state) => build(state, widget),
    // Rebuilt rather than mapped: a mapped block at the end of line 1 would follow text typed at that point (Enter
    // at the end of the title) onto line 2. The widget is the same, so CodeMirror keeps the DOM.
    update: (deco, tr) => (tr.docChanged ? build(tr.state, widget) : deco),
    provide: (field) => EditorView.decorations.from(field),
  });
}

/**
 * Reading mode: put `host` right after the H1 that opens the rendered page, or at the top of the page when it does
 * not open with one (or has not rendered yet). Idempotent; returns whether it moved anything.
 */
export function placeTitleSlot(prose: HTMLElement, host: HTMLElement): boolean {
  const root = prose.querySelector<HTMLElement>('.folio-markdown');
  if (!root) {
    if (prose.firstChild === host) return false;
    prose.prepend(host);
    return true;
  }
  let lead = root.firstElementChild;
  if (lead === host) lead = host.nextElementSibling;
  // A text segment (`.folio-md-segment`) opening with the H1: the slot goes right after it, inside the segment.
  const heading = lead?.firstElementChild?.tagName === 'H1' ? lead.firstElementChild : lead?.tagName === 'H1' ? lead : null;
  if (heading) {
    if (heading.nextSibling === host) return false;
    heading.after(host);
    return true;
  }
  if (root.firstChild === host) return false;
  root.prepend(host);
  return true;
}

/** Keeps `host` in place under the title while the reading page renders and re-renders. */
export function keepTitleSlot(prose: HTMLElement, host: HTMLElement): () => void {
  placeTitleSlot(prose, host);
  if (typeof MutationObserver === 'undefined') return () => undefined;
  const observer = new MutationObserver((records) => {
    // What changes inside the slot (the properties themselves) is not the page moving under it.
    if (records.every((record) => host.contains(record.target))) return;
    placeTitleSlot(prose, host);
  });
  observer.observe(prose, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    host.remove();
  };
}
