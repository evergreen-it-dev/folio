// @vitest-environment jsdom
/**
 * The inline table grid, exercised against a real document (round 21).
 *
 * The view is a stub over a real `EditorState` with the markdown language, so
 * `syntaxTree` resolves the table exactly as it does in the editor and every
 * assertion is on the markdown that actually gets written — which is the whole
 * point of these features: multi-line cells, checklists and column drags must
 * all still leave one valid GFM pipe row per row.
 */
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emojiFavouritesFacet } from './emoji-complete';
import { HEADER_ROW, parseGfmTable, serializeGfmTable } from './gfm-table';
import { TableWidget } from './table-widget';

const SIMPLE = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n');

interface Harness {
  view: EditorView;
  dom: HTMLElement;
  /** Stands in for `.cm-scroller`; see `fakeScroller`. */
  scroller: HTMLElement;
  /** The document as it stands now. */
  text(): string;
  cell(row: number, col: number): HTMLTableCellElement;
  field(): HTMLTextAreaElement;
}

/**
 * A scroll container with numbers on it. jsdom has no layout, so `scrollTop`
 * neither moves nor remembers anything by itself, and the widget's viewport
 * guard would have nothing to guard.
 */
function fakeScroller(): HTMLElement {
  const dom = document.createElement('div');
  let top = 0;
  Object.defineProperty(dom, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  for (const [name, value] of [
    ['scrollHeight', 5000],
    ['clientHeight', 500],
    ['scrollWidth', 500],
    ['clientWidth', 500],
  ] as const) {
    Object.defineProperty(dom, name, { configurable: true, get: () => value });
  }
  return dom;
}

function mount(source = SIMPLE): Harness {
  let state = EditorState.create({
    doc: source,
    extensions: [markdown({ base: markdownLanguage }), emojiFavouritesFacet.of([])],
  });
  let dom: HTMLElement | null = null;
  const scroller = fakeScroller();

  const view = {
    get state() {
      return state;
    },
    posAtDOM: () => 0,
    focus: () => {},
    requestMeasure: (request?: { write?: (measure: unknown, view: EditorView) => void }) => {
      request?.write?.(null, view);
    },
    dispatch: (spec: Parameters<EditorView['dispatch']>[0]) => {
      state = state.update(spec as Parameters<EditorState['update']>[0]).state;
      // What CodeMirror does for us in the editor: the block changed, so the
      // widget is re-rendered in place (which is also what carries the pending
      // focus from one cell to the next).
      if (dom) new TableWidget(state.doc.toString(), 'uk').updateDOM(dom, view);
      // And what it does TO us: an update it cannot anchor pins the scroller to
      // the bottom (ViewState.update / EditorView.measure, `scrollAnchorPos < 0`
      // ⇒ `scrollTop = scrollHeight`). That is the jump the widget defends
      // against, so the stub reproduces it on every document change.
      scroller.scrollTop = scroller.scrollHeight;
    },
    scrollDOM: scroller,
    dom: document.body,
  } as unknown as EditorView;

  const widget = new TableWidget(source, 'uk');
  const root = widget.toDOM(view);
  dom = root;
  document.body.append(root);

  return {
    view,
    dom: root,
    scroller,
    text: () => state.doc.toString(),
    cell: (row: number, col: number) =>
      root.querySelector<HTMLTableCellElement>(`[data-row="${row}"][data-col="${col}"]`)!,
    field: () => root.querySelector<HTMLTextAreaElement>('.cm-md-cellinput')!,
  };
}

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

const setRect = (node: Element | null, value: DOMRect): void => {
  if (node) (node as HTMLElement).getBoundingClientRect = () => value;
};

/** Column pitch, row pitch and the grid's origin inside the frame. */
const CELL_W = 100;
const CELL_H = 20;
const ORIGIN = 20;

/**
 * jsdom has no layout, so the widget's geometry pass has to be handed
 * rectangles. Every cell is measured from its own `data-col`/`data-colspan`,
 * which is exactly what the overlay reads back — so a merged header row is laid
 * out here the way a browser would lay it out, and the `+` positions the test
 * asserts on are the ones a person would be aiming at.
 */
function stubLayout(dom: HTMLElement): void {
  const cols = Number(dom.dataset.cols);
  const bodyRows = dom.querySelectorAll('tbody tr').length;
  const width = cols * CELL_W;
  const height = (bodyRows + 1) * CELL_H;

  setRect(dom.querySelector('.cm-md-table-frame'), rect(0, 0, ORIGIN + width + ORIGIN, height + 40));
  setRect(dom.querySelector('.cm-md-grid'), rect(ORIGIN, ORIGIN, width, height));
  setRect(dom.querySelector('thead'), rect(ORIGIN, ORIGIN, width, CELL_H));
  dom.querySelectorAll<HTMLElement>('tbody tr').forEach((tr, index) => {
    setRect(tr, rect(ORIGIN, ORIGIN + (index + 1) * CELL_H, width, CELL_H));
  });
  for (const cell of dom.querySelectorAll<HTMLTableCellElement>('.cm-md-grid th, .cm-md-grid td')) {
    const col = Number(cell.dataset.col);
    const row = Number(cell.dataset.row);
    const span = Number(cell.dataset.colspan ?? 1);
    setRect(
      cell,
      rect(ORIGIN + col * CELL_W, ORIGIN + (row + 1) * CELL_H, span * CELL_W, CELL_H),
    );
  }
}

/** Let the widget's own rAF re-measure with the rectangles above. */
const settle = (): Promise<unknown> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

/** Mount, hand the widget a layout, and wait for it to measure. */
async function mountLaidOut(source = SIMPLE): Promise<Harness> {
  const h = mount(source);
  stubLayout(h.dom);
  await settle();
  return h;
}

const mouse = (node: EventTarget, type: string, init: MouseEventInit = {}): void => {
  node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
};

const press = (node: Element, key: string, init: KeyboardEventInit = {}): void => {
  node.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...init }));
};

/** Type at the caret the way the browser would, event and all. */
function type(field: HTMLTextAreaElement, text: string): void {
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.setRangeText(text, start, end, 'end');
  field.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
}

/** Editing ends the way it does in the browser: focus leaves the field. */
function commit(field: HTMLTextAreaElement): void {
  field.dispatchEvent(new FocusEvent('blur'));
}

/**
 * Insert real characters at the very start of one line's own text node — the
 * way a browser's native contenteditable typing edits an empty line, as
 * opposed to `type()` above, which goes through `setRangeText` (a full-value
 * replace) the way no actual keystroke ever does. A blank line's caret sits
 * *before* its one placeholder space (`domPointAtRaw` resolves an empty line
 * to offset 0), so this is also where the browser's own insertion lands.
 */
function typeAtLineStart(field: HTMLTextAreaElement, text: string, line = 0): void {
  // Consume any `ignoreSyntheticInput` flag a previous `setRangeText` (Enter,
  // say) left armed for one input event: a real *trusted* keystroke bypasses
  // that flag outright, but jsdom can never dispatch a trusted event, so this
  // stand-in has to clear it by hand or the dispatch below would be silently
  // swallowed as if it were the synthetic echo `type()` produces instead.
  field.dispatchEvent(new InputEvent('input', { bubbles: true }));

  const span = field.querySelector<HTMLElement>(`.cm-md-cell-line[data-line="${line}"] .cm-md-cell-text`);
  if (!span) throw new Error(`no cm-md-cell-line at index ${line}`);
  let node: Node | null = span.firstChild;
  while (node && node.nodeType !== Node.TEXT_NODE) node = node.firstChild;
  if (!node) {
    node = document.createTextNode('');
    span.appendChild(node);
  }
  node.textContent = text + (node.textContent ?? '');
  const selection = document.getSelection()!;
  const range = document.createRange();
  range.setStart(node, text.length);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  field.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
}

function openCell(h: Harness, row: number, col: number): HTMLTextAreaElement {
  mouse(h.cell(row, col), 'mousedown');
  return h.field();
}

afterEach(() => {
  document.body.replaceChildren();
});

/**
 * The owner, 24.09.2026: "I typed text, pressed Enter — everything was gone from the cell".
 * Chrome removes the `.cm-md-cell-text` span once its last character is
 * backspaced away; what is typed next lands directly in the line element.
 */
describe('text the browser put outside the cell-text span', () => {
  /** What Chrome leaves behind: the span gone, a bare text node in the line, caret at its end. */
  function typeBare(field: HTMLTextAreaElement, text: string, line = 0): Text {
    field.dispatchEvent(new InputEvent('input', { bubbles: true })); // clear any armed synthetic flag
    const row = field.querySelector<HTMLElement>(`.cm-md-cell-line[data-line="${line}"]`)!;
    row.querySelector('.cm-md-cell-text')?.remove();
    const node = document.createTextNode(text);
    row.appendChild(node);
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(node, text.length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    field.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
    return node;
  }

  it('is read back into the value, with the caret where it was', () => {
    const h = mount(['| a | b |', '| --- | --- |', '|  | 2 |'].join('\n'));
    const field = openCell(h, 0, 0);
    const node = typeBare(field, 'xyz');
    expect(field.value).toBe('xyz');
    expect(field.selectionStart).toBe(3);
    // The span is back and owns the text node — the next keystroke lands inside it.
    expect(node.parentElement?.classList.contains('cm-md-cell-text')).toBe(true);
    expect(document.getSelection()?.anchorNode).toBe(node);
  });

  it('survives the commit instead of vanishing', () => {
    const h = mount(['| a | b |', '| --- | --- |', '|  | 2 |'].join('\n'));
    const field = openCell(h, 0, 0);
    typeBare(field, 'xyz');
    commit(field);
    expect(parseGfmTable(h.text())?.rows).toEqual([['xyz', '2']]);
  });

  it('lets the (( emoji trigger see it', () => {
    const h = mount(['| a | b |', '| --- | --- |', '|  | 2 |'].join('\n'));
    const field = openCell(h, 0, 0);
    typeBare(field, 'xyz ((');
    expect(document.querySelector('.folio-emoji-pop')).toBeTruthy();
  });
});

describe('clicking another cell while one is open', () => {
  // The owner, 24.09.2026: after typing, a click on the neighbour cell used
  // to commit the text but leave the neighbour closed (its editor died in
  // the commit's re-render) — or, before that, lose the text outright.
  it('commits the edit and opens the clicked cell', () => {
    const h = mount(['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n'));
    const first = openCell(h, 0, 0);
    type(first, 'xyz');
    mouse(h.cell(0, 1), 'mousedown');
    // What the browser does when the new field takes focus.
    first.dispatchEvent(new FocusEvent('blur'));
    expect(parseGfmTable(h.text())?.rows).toEqual([['1xyz', '2']]);
    const open = h.dom.querySelector('.cm-md-cellinput')?.closest('td');
    expect(open).toBe(h.cell(0, 1));
  });

  it('with nothing typed, simply moves on to the clicked cell', () => {
    const h = mount(['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n'));
    const first = openCell(h, 0, 0);
    mouse(h.cell(0, 1), 'mousedown');
    first.dispatchEvent(new FocusEvent('blur'));
    expect(h.dom.querySelector('.cm-md-cellinput')?.closest('td')).toBe(h.cell(0, 1));
  });
});

describe('opening a cell', () => {
  // The owner, 29.09.2026: the open cell grew (its padding was counted twice
  // by a height pinned from `scrollHeight`), and the row-insert line stayed
  // where the row used to end.
  it('never pins a height on the field — it is as tall as its content', () => {
    const h = mount();
    const field = openCell(h, 0, 0);
    expect(field.style.height).toBe('');
    type(field, 'more text');
    expect(field.style.height).toBe('');
  });
});

/**
 * The owner, 29.09.2026 (screenshot): a cell in the last row was open, the
 * next click opened one in the second row — one row got shorter, the other
 * taller by as much, and the frame around them kept its size. The overlay only
 * watched the frame, so the row handles and the insert line stayed on borders
 * that were no longer there.
 */
describe('the overlay follows the grid', () => {
  const TWO_ROWS = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'].join('\n');
  let observed: Element[] = [];
  let resized: () => void = () => {};

  beforeEach(() => {
    observed = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe(node: Element): void {
          observed.push(node);
        }
        unobserve(): void {}
        disconnect(): void {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const centre = (zone: HTMLElement | null | undefined): number | null =>
    zone ? parseFloat(zone.style.top) + parseFloat(zone.style.height) / 2 : null;

  it('watches every row and every cell, not only the frame', async () => {
    const h = await mountLaidOut(TWO_ROWS);
    expect(observed).toContain(h.dom.querySelector('.cm-md-table-frame'));
    const parts = [...h.dom.querySelectorAll('.cm-md-grid tr, .cm-md-grid th, .cm-md-grid td')];
    expect(parts).toHaveLength(3 + 6);
    for (const part of parts) expect(observed).toContain(part);
  });

  it('moves the handles and the insert line when two rows trade height', async () => {
    const h = await mountLaidOut(TWO_ROWS);
    const frame = h.dom.querySelector<HTMLElement>('.cm-md-table-frame')!;
    const border = ORIGIN + 2 * CELL_H;
    const handleTops = () =>
      [...h.dom.querySelectorAll<HTMLElement>('.cm-md-handle--row')].map((node) => parseFloat(node.style.top));
    const active = () => h.dom.querySelector<HTMLElement>('.cm-md-edge--row[data-active]');

    // The pointer rests on the border between the two rows, clear of any column border.
    mouse(frame, 'mousemove', { clientX: ORIGIN + CELL_W / 2, clientY: border });
    expect(centre(active())).toBe(border);
    expect(handleTops()).toEqual([ORIGIN + CELL_H, border]);

    // Row one grows by 10, row two shrinks by 10: the frame is exactly as tall as before.
    const rows = h.dom.querySelectorAll('tbody tr');
    const width = 2 * CELL_W;
    setRect(rows[0], rect(ORIGIN, ORIGIN + CELL_H, width, CELL_H + 10));
    setRect(rows[1], rect(ORIGIN, border + 10, width, CELL_H - 10));
    resized();

    expect(handleTops()).toEqual([ORIGIN + CELL_H, border + 10]);
    // …and the line under the pointer that never moved is drawn on the border's new place.
    expect(centre(active())).toBe(border + 10);
  });

  it('lights nothing up again once the pointer has left the table', async () => {
    const h = await mountLaidOut(TWO_ROWS);
    const frame = h.dom.querySelector<HTMLElement>('.cm-md-table-frame')!;
    mouse(frame, 'mousemove', { clientX: ORIGIN + CELL_W / 2, clientY: ORIGIN + 2 * CELL_H });
    // `mouseleave` does not bubble; the widget listens on the frame itself.
    frame.dispatchEvent(new MouseEvent('mouseleave'));
    resized();
    expect(h.dom.querySelector('.cm-md-edge[data-active]')).toBeNull();
  });
});

describe('cell editing', () => {
  it('opens a cell into a text field carrying its markdown', () => {
    const h = mount();
    expect(openCell(h, 0, 0).value).toBe('1');
  });

  it('Enter breaks the line inside the cell and writes <br>, not a new row', () => {
    const h = mount();
    const field = openCell(h, 0, 0);
    field.value = 'one';
    field.setSelectionRange(3, 3);
    press(field, 'Enter');
    type(field, 'two');
    commit(field);

    expect(h.text()).toContain('one<br>two');
    // Still exactly three lines: header, delimiter, one body row.
    expect(h.text().split('\n')).toHaveLength(3);
    expect(parseGfmTable(h.text())?.rows).toHaveLength(1);
  });

  it('keeps a heading marker once a real keystroke rereads the cell from its own DOM', () => {
    // `renderCell` draws a heading line as a real `<h1>`-`<h3>` with no visible
    // `#`, storing the marker only in `data-marker`. Every OTHER keystroke in
    // the cell (not just the one that made the heading) fires a native `input`
    // that re-derives the whole cell's text by walking that DOM back into
    // markdown — so the marker has to survive that walk indefinitely, not just
    // once.
    const h = mount();
    const field = openCell(h, 0, 0);
    field.value = '# Heading\nmore';
    // A direct `.value =` assignment renders the two lines but does not, by
    // itself, exercise the read-back — only a genuine (not `setRangeText`)
    // `input` event does, the way the browser's own typing fires one on
    // every keystroke.
    field.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'e' }));
    commit(field);
    expect(parseGfmTable(h.text())?.rows[0][0]).toBe('# Heading<br>more');
  });

  it('a real keystroke into an empty cell does not strand the caret-anchor space', () => {
    // An empty cell's one line renders a single placeholder space so
    // contenteditable has somewhere to put the caret — which lands *before*
    // it, so the browser's own typing (unlike `type()`'s `setRangeText`,
    // which replaces the whole value) inserts new characters ahead of the
    // placeholder inside the very same text node. Nothing then trims that
    // leftover space back out of the live `value` unless the fix does — it
    // is invisible at commit (`cellTextToRaw` trims every line) but wrong for
    // every read of the field in between, including the very next Enter's.
    const h = mount();
    const field = openCell(h, 0, 0);
    field.value = ''; // a genuinely empty cell, not the fixture's '1'
    typeAtLineStart(field, 'sdfsdfdsdfs');

    expect(field.value).toBe('sdfsdfdsdfs');
    expect(field.querySelector('.cm-md-cell-text')?.textContent).toBe('sdfsdfdsdfs');
  });

  it('Enter after a real keystroke still breaks the line, clean of the stray space', () => {
    const h = mount();
    const field = openCell(h, 0, 0);
    field.value = '';
    typeAtLineStart(field, 'sdfsdfdsdfs');
    press(field, 'Enter');

    expect(field.value).toBe('sdfsdfdsdfs\n');
    expect(field.querySelectorAll('.cm-md-cell-line')).toHaveLength(2);

    typeAtLineStart(field, 'druga stroka', 1);
    commit(field);
    expect(parseGfmTable(h.text())?.rows[0][0]).toBe('sdfsdfdsdfs<br>druga stroka');
  });

  it('Mod+Enter is what moves down — and grows the table from the last row', () => {
    const h = mount();
    const field = openCell(h, 0, 0);
    field.value = 'x';
    press(field, 'Enter', { ctrlKey: true });
    expect(parseGfmTable(h.text())?.rows).toHaveLength(2);
  });

  it('Tab still walks to the next cell and appends a row off the end', () => {
    const h = mount();
    const field = openCell(h, 0, 1);
    field.value = 'z';
    press(field, 'Tab');
    expect(parseGfmTable(h.text())?.rows).toEqual([['1', 'z'], ['', '']]);
  });

  it('Escape throws the draft away', () => {
    const h = mount();
    const field = openCell(h, 0, 0);
    field.value = 'nope';
    press(field, 'Escape');
    expect(h.text()).toBe(SIMPLE);
  });

  it('pasting several lines keeps them as lines, and they land as <br>s', () => {
    const h = mount();
    const field = openCell(h, 0, 0);
    field.value = '';
    field.setSelectionRange(0, 0);

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: () => '  first \r\n\tsecond\n\nthird  ' },
    });
    field.dispatchEvent(event);

    expect(field.value).toBe('first\nsecond\n\nthird');
    commit(field);
    expect(h.text()).toContain('first<br>second<br><br>third');
    expect(h.text().split('\n')).toHaveLength(3);
  });

  it('escapes a pasted pipe exactly once, so the cell does not split', () => {
    const h = mount();
    const field = openCell(h, 0, 0);
    field.value = 'a | b';
    commit(field);
    expect(h.text()).toContain('a \\| b');
    expect(parseGfmTable(h.text())?.rows[0][0]).toBe('a | b');
  });
});

describe('cell mini-slash', () => {
  const openSlash = (h: Harness): HTMLElement => {
    const field = openCell(h, 0, 0);
    field.value = '';
    field.setSelectionRange(0, 0);
    type(field, '/');
    return document.querySelector<HTMLElement>('.folio-tablemenu')!;
  };

  it('opens on a slash at the start of a line', () => {
    const h = mount();
    expect(openSlash(h)).toBeTruthy();
  });

  it('does not open on a slash inside a word', () => {
    const h = mount();
    const field = openCell(h, 0, 0);
    field.value = 'and';
    field.setSelectionRange(3, 3);
    type(field, '/');
    expect(document.querySelector('.folio-tablemenu')).toBeNull();
  });

  it('writes a bullet line that renders as a list', () => {
    const h = mount();
    const menu = openSlash(h);
    mouse(menu.querySelectorAll('.folio-tablemenu__item')[0], 'click');

    const field = h.field();
    expect(field.value).toBe('• ');
    type(field, 'first');
    press(field, 'Enter');
    type(field, 'second');
    commit(field);

    expect(h.text()).toContain('• first<br>• second');
    expect(h.text().split('\n')).toHaveLength(3);
    expect(h.cell(0, 0).querySelectorAll('.cm-md-cell-line[data-kind="bullet"]')).toHaveLength(2);
  });

  it('writes checklist lines with real checkboxes that write back', () => {
    const h = mount();
    const menu = openSlash(h);
    mouse(menu.querySelectorAll('.folio-tablemenu__item')[1], 'click');

    const field = h.field();
    expect(field.value).toBe('[ ] ');
    type(field, 'todo');
    commit(field);
    expect(h.text()).toContain('[ ] todo');

    const box = h.cell(0, 0).querySelector<HTMLInputElement>('.cm-md-cell-check')!;
    expect(box.checked).toBe(false);
    mouse(box, 'click');
    expect(h.text()).toContain('[x] todo');
  });

  it('numbers a numbered list and counts on from the line before', () => {
    const h = mount();
    const menu = openSlash(h);
    mouse(menu.querySelectorAll('.folio-tablemenu__item')[2], 'click');

    const field = h.field();
    expect(field.value).toBe('1. ');
    type(field, 'one');
    press(field, 'Enter');
    expect(field.value).toBe('1. one\n2. ');
    type(field, 'two');
    commit(field);
    // The file holds the round-28 shape, which renumbers each run from 1 —
    // here that is exactly what was typed.
    expect(h.text()).toContain('1. one<br>2. two');
    const items = h.cell(0, 0).querySelectorAll('ol.cm-md-cell-list > .cm-md-cell-line');
    expect(items).toHaveLength(2);
  });

  it('inserts Heading 1–3 and renders them as headings without HTML table fallback', () => {
    for (const [menuIndex, marker, tag] of [[3, '# ', 'h1'], [4, '## ', 'h2'], [5, '### ', 'h3']] as const) {
      const h = mount();
      const menu = openSlash(h);
      mouse(menu.querySelectorAll('.folio-tablemenu__item')[menuIndex], 'click');
      const field = h.field();
      expect(field.value).toBe(marker);
      type(field, 'Title');
      commit(field);
      expect(h.text()).toContain(`${marker}Title`);
      expect(h.cell(0, 0).querySelector(tag)?.textContent).toBe('Title');
    }
  });

  it('inserts an inline link placeholder with the label selected, not a block item', () => {
    const h = mount();
    const menu = openSlash(h);
    const items = menu.querySelectorAll('.folio-tablemenu__item');
    // The one INLINE entry, after the block/line items — see table-widget.ts's
    // `openSlash`: everything else in the main slash menu (table, image,
    // callout, mermaid…) has no shape inside a single cell, so it is left out
    // rather than writing markdown the grid can't hold.
    mouse(items[items.length - 1], 'click');

    const field = h.field();
    expect(field.value).toMatch(/^\[.+\]\(url\)$/);
    expect(field.selectionStart).toBe(1);
    expect(field.selectionEnd).toBe(field.value.indexOf(']'));
    type(field, 'docs');
    commit(field);
    expect(h.text()).toContain('[docs](url)');
  });

  it('Enter on an empty item ends the list instead of growing it', () => {
    const h = mount();
    const menu = openSlash(h);
    mouse(menu.querySelectorAll('.folio-tablemenu__item')[0], 'click');
    const field = h.field();
    type(field, 'only');
    press(field, 'Enter');
    expect(field.value).toBe('• only\n• ');
    press(field, 'Enter');
    expect(field.value).toBe('• only\n');
  });
});

describe('formatting inside a cell', () => {
  it('shows the bar for a selection and writes valid markdown', () => {
    const h = mount();
    const field = openCell(h, 0, 0);
    field.value = 'word';
    field.setSelectionRange(0, 4);
    document.dispatchEvent(new Event('selectionchange'));

    const bar = document.querySelector<HTMLElement>('.cm-folio-format')!;
    expect(bar).toBeTruthy();
    // Six formats plus the link. No block quote inside a cell — a pipe row
    // cannot hold one.
    // …plus the highlight colour chevron (24.09.2026).
    expect(bar.querySelectorAll('.cm-folio-format__btn')).toHaveLength(8);

    mouse(bar.querySelectorAll('.cm-folio-format__btn')[0], 'click');
    expect(field.value).toBe('**word**');
    commit(field);
    expect(h.text()).toContain('**word**');
  });

  it('makes a link out of the selected text, and the cell renders it', () => {
    const h = mount();
    const field = openCell(h, 0, 0);
    field.value = 'word';
    field.setSelectionRange(0, 4);
    document.dispatchEvent(new Event('selectionchange'));

    const bar = document.querySelector<HTMLElement>('.cm-folio-format')!;
    const link = [...bar.querySelectorAll('.cm-folio-format__btn')].find(
      (button) => button.getAttribute('aria-label') === 'Link',
    )!;
    mouse(link, 'click');
    expect(field.value).toBe('[word](url)');
    commit(field);
    expect(h.text()).toContain('[word](url)');
    // The grid shows the label, styled as a link (it does not navigate — see
    // INLINE_TAGS/INLINE_CLASSES), so the pipes never leak into the cell.
    expect(h.cell(0, 0).querySelector('.cm-md-link')?.textContent).toBe('word');
  });

  it('renders the HTML formats as formats once the cell is committed', () => {
    const h = mount();
    const field = openCell(h, 0, 0);
    field.value = 'word';
    field.setSelectionRange(0, 4);
    press(field, 'u', { metaKey: true });
    commit(field);

    expect(h.text()).toContain('<ins>word</ins>');
    const cell = h.cell(0, 0);
    expect(cell.querySelector('.cm-md-ins')?.textContent).toBe('word');
    expect(cell.textContent).not.toContain('<ins>');
  });

  it('takes the hotkeys too, and toggles back off', () => {
    const h = mount();
    const field = openCell(h, 0, 0);
    field.value = 'word';
    field.setSelectionRange(0, 4);

    press(field, 'u', { metaKey: true });
    expect(field.value).toBe('<ins>word</ins>');
    press(field, 'u', { metaKey: true });
    expect(field.value).toBe('word');

    press(field, 'x', { metaKey: true, shiftKey: true });
    expect(field.value).toBe('~~word~~');
  });
});

describe('rendering', () => {
  it('renders inline markdown, breaks and list structures', () => {
    const h = mount(['| a |', '| --- |', '| **b**<br>[x] done |'].join('\n'));
    const cell = h.cell(0, 0);
    expect(cell.querySelectorAll('.cm-md-cell-line')).toHaveLength(2);
    expect(cell.querySelector('strong')?.textContent).toBe('b');
    expect(cell.querySelector<HTMLInputElement>('.cm-md-cell-check')?.checked).toBe(true);
  });

  it('keeps the compact toolbar and drops the visual-editor button', () => {
    const h = mount();
    const labels = [...h.dom.querySelectorAll('.cm-md-table-barbtn')].map(
      (button) => button.getAttribute('aria-label') ?? button.textContent,
    );
    expect(labels).toEqual([
      'Row',
      'Column',
      'Narrow table',
      'Medium table',
      'Full-width table',
      'Source',
    ]);
  });

  it('falls back to the source when the block does not parse as a table', () => {
    const h = mount('| a |\n| b |');
    expect(h.dom.querySelector('.cm-md-table-fallback')?.textContent).toBe('| a |\n| b |');
  });
});

describe('handles', () => {
  it('gives every column and every row a handle', () => {
    const h = mount();
    expect(h.dom.querySelectorAll('.cm-md-handle--col')).toHaveLength(2);
    expect(h.dom.querySelectorAll('.cm-md-handle--row')).toHaveLength(1);
  });

  it('puts a + on every border, including the outer ones', () => {
    const h = mount();
    // three column borders for two columns, two row borders for one row
    expect(h.dom.querySelectorAll('.cm-md-edge--col')).toHaveLength(3);
    expect(h.dom.querySelectorAll('.cm-md-edge--row')).toHaveLength(2);
  });

  it('inserts a column exactly where the + sits', () => {
    const h = mount();
    const first = h.dom.querySelectorAll<HTMLElement>('.cm-md-edge--col .cm-md-edge__btn')[0];
    mouse(first, 'click');
    expect(parseGfmTable(h.text())?.header).toEqual(['', 'a', 'b']);
  });

  it('inserts a row exactly where the + sits', () => {
    const h = mount();
    const top = h.dom.querySelectorAll<HTMLElement>('.cm-md-edge--row .cm-md-edge__btn')[0];
    mouse(top, 'click');
    expect(parseGfmTable(h.text())?.rows).toEqual([
      ['', ''],
      ['1', '2'],
    ]);
  });

  it('opens the column menu on a press that does not travel', () => {
    const h = mount();
    mouse(h.dom.querySelector('.cm-md-handle--col .cm-md-handle__btn')!, 'mousedown', { clientX: 10 });
    mouse(document, 'mouseup', { clientX: 10 });

    const menu = document.querySelector<HTMLElement>('.folio-tablemenu')!;
    const labels = [...menu.querySelectorAll('.folio-tablemenu__label')].map((n) => n.textContent);
    expect(labels).toEqual([
      'Align left',
      'Align centre',
      'Align right',
      'No alignment',
      'Insert column to the left',
      'Insert column to the right',
      'Delete column',
    ]);
  });

  it('sets a column alignment from that menu', () => {
    const h = mount();
    mouse(h.dom.querySelector('.cm-md-handle--col .cm-md-handle__btn')!, 'mousedown', { clientX: 10 });
    mouse(document, 'mouseup', { clientX: 10 });
    mouse(document.querySelectorAll('.folio-tablemenu__item')[1], 'click');
    expect(parseGfmTable(h.text())?.align).toEqual(['center', null]);
  });

  it('deletes a row from the row menu', () => {
    const h = mount();
    mouse(h.dom.querySelector('.cm-md-handle--row .cm-md-handle__btn')!, 'mousedown', { clientX: 10 });
    const items = document.querySelectorAll('.folio-tablemenu__item');
    mouse(items[items.length - 1], 'click');
    expect(parseGfmTable(h.text())?.rows).toEqual([]);
  });
});

describe('column drag', () => {
  /**
   * jsdom has no layout, so the widget's geometry pass needs rectangles handed
   * to it: two 100px columns starting at x=20, one 20px body row.
   */
  function fakeLayout(dom: HTMLElement): void {
    const rect = (left: number, top: number, width: number, height: number) =>
      ({
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        x: left,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;

    const set = (node: Element | null, value: DOMRect) => {
      if (node) (node as HTMLElement).getBoundingClientRect = () => value;
    };

    set(dom.querySelector('.cm-md-table-frame'), rect(0, 0, 240, 80));
    set(dom.querySelector('.cm-md-grid'), rect(20, 20, 200, 40));
    set(dom.querySelector('thead'), rect(20, 20, 200, 20));
    const heads = dom.querySelectorAll('thead th');
    set(heads[0], rect(20, 20, 100, 20));
    set(heads[1], rect(120, 20, 100, 20));
    set(dom.querySelector('tbody tr'), rect(20, 40, 200, 20));
  }

  /** Let the widget's own rAF re-measure with the rectangles above. */
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

  it('moves a column when its handle is dragged across another', async () => {
    const h = mount();
    fakeLayout(h.dom);
    await settle();

    const handle = h.dom.querySelectorAll<HTMLElement>('.cm-md-handle--col .cm-md-handle__btn')[0];
    mouse(handle, 'mousedown', { clientX: 70 });
    mouse(document, 'mousemove', { clientX: 170 });
    mouse(document, 'mouseup', { clientX: 170 });

    const table = parseGfmTable(h.text())!;
    expect(table.header).toEqual(['b', 'a']);
    expect(table.rows).toEqual([['2', '1']]);
  });

  it('a press that never travels far enough opens the menu instead', async () => {
    const h = mount();
    fakeLayout(h.dom);
    await settle();

    const handle = h.dom.querySelectorAll<HTMLElement>('.cm-md-handle--col .cm-md-handle__btn')[0];
    mouse(handle, 'mousedown', { clientX: 70 });
    mouse(document, 'mousemove', { clientX: 72 });
    mouse(document, 'mouseup', { clientX: 72 });

    expect(h.text()).toBe(SIMPLE);
    expect(document.querySelector('.folio-tablemenu')).toBeTruthy();
  });
});

/* ------------------------------------------------- round 17: extensions -- */

describe('merged cells', () => {
  const GRID = ['| a | b | c |', '| --- | --- | --- |', '| 1 | 2 | 3 |', '| 4 | 5 | 6 |'].join('\n');

  /** A menu entry by its visible label. */
  const item = (label: string): HTMLElement =>
    [...document.querySelectorAll<HTMLElement>('.folio-tablemenu__item')].find(
      (button) => button.querySelector('.folio-tablemenu__label')?.textContent === label,
    )!;

  const openRowMenu = (h: Harness, index: number) => {
    const handles = h.dom.querySelectorAll<HTMLElement>('.cm-md-handle--row .cm-md-handle__btn');
    mouse(handles[index], 'mousedown', { clientX: 10 });
  };

  it('draws a colspan as one cell and leaves the covered ones out of the DOM', () => {
    const h = mount(['| a | b | c |', '| - | - | - |', '| wide |||'].join('\n'));
    const cell = h.cell(0, 0);
    expect(cell.colSpan).toBe(3);
    expect(h.dom.querySelectorAll('tbody td')).toHaveLength(1);
  });

  it('draws a rowspan as one tall cell, leaving the covered row a cell short', () => {
    const h = mount(['| a | b |', '| - | - |', '| tall | 2 |', '| ^^ | 5 |'].join('\n'));
    expect(h.cell(0, 0).rowSpan).toBe(2);
    expect(h.dom.querySelectorAll('tbody tr')[1].children).toHaveLength(1);
  });

  it('sends navigation that lands on a covered cell to the cell that is drawn', () => {
    const h = mount(['| a | b |', '| - | - |', '| tall | 2 |', '| ^^ | 5 |'].join('\n'));
    mouse(h.cell(0, 1), 'mousedown'); // the "2" cell; Tab from here wraps to (1,0)
    press(h.field(), 'Tab');
    const open = h.dom.querySelector('.cm-md-cellinput')?.closest('td');
    expect(open).toBe(h.cell(0, 0));
    expect(open?.rowSpan).toBe(2);
  });

  it('merges the selected row from the row handle menu, writing tight pipes', () => {
    const h = mount(GRID);
    openRowMenu(h, 0);
    mouse(item('Merge cells'), 'click');
    expect(h.text().split('\n')[2]).toBe('| 1<br>2<br>3 |||');
  });

  it('offers unmerge for a merged cell, and putting it back restores the row', () => {
    const h = mount(['| a | b | c |', '| - | - | - |', '| wide |||'].join('\n'));
    openRowMenu(h, 0);
    mouse(item('Unmerge cells'), 'click');
    expect(parseGfmTable(h.text())?.spanLeft).toBeUndefined();
    expect(h.dom.querySelectorAll('tbody td')).toHaveLength(3);
  });

  it('extends a selection with shift-click and merges exactly that rectangle', () => {
    const h = mount(GRID);
    mouse(h.cell(0, 0), 'mousedown');
    mouse(h.cell(1, 1), 'mousedown', { shiftKey: true });

    expect(h.dom.querySelectorAll('[data-selected="true"]')).toHaveLength(4);
    openRowMenu(h, 0);
    mouse(item('Merge cells'), 'click');
    expect(h.text().split('\n').slice(2)).toEqual([
      '| 1<br>2<br>4<br>5 || 3   |',
      '| ^^  || 6   |',
    ]);
  });

  it('a plain click clears the selection again', () => {
    const h = mount(GRID);
    mouse(h.cell(0, 0), 'mousedown');
    mouse(h.cell(1, 1), 'mousedown', { shiftKey: true });
    mouse(h.cell(0, 2), 'mousedown');
    expect(h.dom.querySelectorAll('[data-selected="true"]')).toHaveLength(0);
  });
});

describe('cell backgrounds and column widths', () => {
  const GRID = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n');

  const swatch = (label: string): HTMLElement =>
    document.querySelector<HTMLElement>(`.folio-tablemenu__swatch[aria-label="${label}"]`)!;

  it('paints the selected column and writes the metadata line above the table', () => {
    const h = mount(GRID);
    mouse(h.dom.querySelector('.cm-md-handle--col .cm-md-handle__btn')!, 'mousedown', { clientX: 10 });
    mouse(document, 'mouseup', { clientX: 10 });
    mouse(swatch('Yellow'), 'click');

    const lines = h.text().split('\n');
    expect(lines[0]).toBe('[//]: # (folio-table: bg=HA:yellow,A1:yellow)');
    expect(lines[1]).toBe('');
    expect(h.cell(HEADER_ROW, 0).className).toContain('folio-bg-yellow');
  });

  it('clears a background through the palette’s empty swatch', () => {
    const h = mount(['[//]: # (folio-table: bg=A1:green)', '', GRID].join('\n'));
    expect(h.cell(0, 0).className).toContain('folio-bg-green');

    mouse(h.dom.querySelectorAll('.cm-md-handle--row .cm-md-handle__btn')[0], 'mousedown', { clientX: 10 });
    mouse(swatch('No background'), 'click');
    expect(h.text()).toBe(['| a   | b   |', '| --- | --- |', '| 1   | 2   |'].join('\n'));
  });

  it('keeps the metadata line through an unrelated structural edit', () => {
    const h = mount(['[//]: # (folio-table: bg=A1:green)', '', GRID].join('\n'));
    mouse(h.dom.querySelectorAll<HTMLElement>('.cm-md-table-barbtn')[0], 'click'); // add row
    const lines = h.text().split('\n');
    expect(lines[0]).toBe('[//]: # (folio-table: bg=A1:green)');
    expect(lines).toHaveLength(6);
  });

  it('renders declared widths onto the colgroup', () => {
    const h = mount(['[//]: # (folio-table: w=1:30%,2:70%)', '', GRID].join('\n'));
    const cols = h.dom.querySelectorAll<HTMLElement>('colgroup col');
    expect([...cols].map((col) => col.style.width)).toEqual(['30%', '70%']);
    expect(h.dom.querySelector<HTMLElement>('.cm-md-grid')?.dataset.sized).toBe('true');
  });

  it('writes w= when a column border is dragged', async () => {
    const h = mount(GRID);
    const rect = (left: number, top: number, width: number, height: number) =>
      ({
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        x: left,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    const set = (node: Element | null, value: DOMRect) => {
      if (node) (node as HTMLElement).getBoundingClientRect = () => value;
    };
    set(h.dom.querySelector('.cm-md-table-frame'), rect(0, 0, 240, 80));
    set(h.dom.querySelector('.cm-md-grid'), rect(20, 20, 200, 40));
    set(h.dom.querySelector('thead'), rect(20, 20, 200, 20));
    const heads = h.dom.querySelectorAll('thead th');
    set(heads[0], rect(20, 20, 100, 20));
    set(heads[1], rect(120, 20, 100, 20));
    set(h.dom.querySelector('tbody tr'), rect(20, 40, 200, 20));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    // The middle border, dragged 50px to the right: 100/100 becomes 150/50.
    const line = h.dom.querySelectorAll<HTMLElement>('.cm-md-edge--col .cm-md-edge__line')[1];
    expect(line.dataset.resize).toBe('true');
    mouse(line, 'mousedown', { clientX: 120 });
    mouse(document, 'mousemove', { clientX: 170 });
    mouse(document, 'mouseup', { clientX: 170 });

    expect(h.text().split('\n')[0]).toBe('[//]: # (folio-table: w=1:75%,2:25%)');
  });
});

describe('table display width', () => {
  it('offers narrow, medium and full-width buttons and persists the choice', () => {
    const h = mount();
    const buttons = () => [...h.dom.querySelectorAll<HTMLButtonElement>('.cm-md-table-widthbtn')];

    expect(buttons()).toHaveLength(3);
    expect(buttons().map((button) => button.textContent)).toEqual([
      'Narrow table',
      'Medium table',
      'Full-width table',
    ]);
    expect(buttons().map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    expect(h.dom.dataset.display).toBe('narrow');

    mouse(buttons()[1], 'click');
    expect(h.text().split('\n')[0]).toBe('[//]: # (folio-table: display=medium)');
    expect(h.dom.dataset.display).toBe('medium');
    expect(buttons().map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);

    mouse(buttons()[2], 'click');
    expect(h.text().split('\n')[0]).toBe('[//]: # (folio-table: display=full)');
    expect(h.dom.dataset.display).toBe('full');

    mouse(buttons()[0], 'click');
    expect(parseGfmTable(h.text())?.attrs).toBeUndefined();
    expect(h.text()).not.toContain('folio-table:');
    expect(h.dom.dataset.display).toBe('narrow');
  });

  it('shrinks a narrow table from its highlighted right edge', async () => {
    const h = await mountLaidOut();
    const lines = h.dom.querySelectorAll<HTMLElement>('.cm-md-edge--col .cm-md-edge__line');
    expect(lines[0].dataset.resize).toBeUndefined();
    expect(lines[2].dataset.resize).toBe('true');

    mouse(lines[2], 'mousedown', { clientX: 220 });
    mouse(document, 'mousemove', { clientX: 120 });
    mouse(document, 'mouseup', { clientX: 120 });

    expect(h.text().split('\n')[0]).toBe('[//]: # (folio-table: w=1:50px,2:50px)');
    expect(h.dom.querySelector<HTMLElement>('.cm-md-grid')?.dataset.pixelSized).toBe('true');
  });

  it('grows a full-width table past its viewport from the right edge', async () => {
    const h = await mountLaidOut(['[//]: # (folio-table: display=full)', '', SIMPLE].join('\n'));
    const lines = h.dom.querySelectorAll<HTMLElement>('.cm-md-edge--col .cm-md-edge__line');
    expect(lines[2].dataset.resize).toBe('true');

    mouse(lines[2], 'mousedown', { clientX: 220 });
    mouse(document, 'mousemove', { clientX: 320 });
    mouse(document, 'mouseup', { clientX: 320 });

    expect(h.text().split('\n')[0]).toBe(
      '[//]: # (folio-table: display=full; w=1:150px,2:150px)',
    );
  });

  it('leaves the outer edge fixed in medium mode', async () => {
    const h = await mountLaidOut(['[//]: # (folio-table: display=medium)', '', SIMPLE].join('\n'));
    const lines = h.dom.querySelectorAll<HTMLElement>('.cm-md-edge--col .cm-md-edge__line');
    expect(lines[1].dataset.resize).toBe('true');
    expect(lines[2].dataset.resize).toBeUndefined();
  });
});

describe('nested lists in a cell', () => {
  it('Tab nests a list line instead of leaving the cell', () => {
    const h = mount();
    mouse(h.cell(0, 0), 'mousedown');
    const field = h.field();
    field.value = '• one\n• two';
    field.setSelectionRange(field.value.length, field.value.length);
    press(field, 'Tab');
    expect(field.value).toBe('• one\n  • two');

    press(field, 'Tab', { shiftKey: true });
    expect(field.value).toBe('• one\n• two');
  });

  it('Tab still moves to the next cell from a plain line', () => {
    const h = mount();
    mouse(h.cell(0, 0), 'mousedown');
    press(h.field(), 'Tab');
    expect(h.dom.dataset.focusCol).toBeUndefined();
    expect(h.cell(0, 1).querySelector('.cm-md-cellinput')).toBeTruthy();
  });

  it('draws the nesting it reads back from the file', () => {
    const h = mount(['| a |', '| - |', '| • one<br>  • two |'].join('\n'));
    const lines = h.cell(0, 0).querySelectorAll<HTMLElement>('.cm-md-cell-line');
    expect(lines[0].dataset.indent).toBeUndefined();
    expect(lines[1].dataset.indent).toBe('1');
  });
});

/* ------------------------------------- round 28: lists inside a cell -- */

/**
 * The editing half of round 28. The written shape is `markdown/tableSyntax.ts`'s
 * (`formatCellLines`), so every assertion below is on the markdown the cell
 * commits — that is the half the reading renderer and the importer have to
 * agree with.
 */
describe('round 28: editing a list inside a cell', () => {
  const cellText = (h: Harness, row = 0, col = 0): string | undefined =>
    parseGfmTable(h.text())?.rows[row][col];

  it('continues a list typed with an ASCII dash, and files it in the round-28 shape', () => {
    const h = mount();
    const field = openCell(h, 0, 0);
    field.value = '- one';
    field.setSelectionRange(field.value.length, field.value.length);

    press(field, 'Enter');
    // The continuation is the marker the file will hold, not the one typed.
    expect(field.value).toBe('- one\n• ');
    type(field, 'two');
    commit(field);

    expect(cellText(h)).toBe('• one<br>• two');
    expect(h.text().split('\n')).toHaveLength(3);
  });

  it('writes Tab nesting as two spaces per level, and Shift+Tab takes it back', () => {
    const h = mount();
    const field = openCell(h, 0, 0);
    field.value = '• one\n- two';
    field.setSelectionRange(field.value.length, field.value.length);

    press(field, 'Tab');
    commit(field);
    expect(cellText(h)).toBe('• one<br>  • two');

    const again = openCell(h, 0, 0);
    again.setSelectionRange(again.value.length, again.value.length);
    press(again, 'Tab', { shiftKey: true });
    commit(again);
    expect(cellText(h)).toBe('• one<br>• two');
  });

  it('lets Tab reach three levels and no further, without ever leaving the cell', () => {
    const h = mount();
    const field = openCell(h, 0, 0);
    field.value = '• one\n• two';
    field.setSelectionRange(field.value.length, field.value.length);

    for (let i = 0; i < 5; i++) press(field, 'Tab');
    expect(field.value).toBe('• one\n    • two');
    // Still the same cell: no commit, no walk to the next one.
    expect(h.cell(0, 0).querySelector('.cm-md-cellinput')).toBe(field);
    expect(h.text()).toBe(SIMPLE);
  });

  it('Enter on an empty item leaves the list and writes a plain line', () => {
    const h = mount();
    const field = openCell(h, 0, 0);
    field.value = '• one\n• ';
    field.setSelectionRange(field.value.length, field.value.length);

    press(field, 'Enter');
    expect(field.value).toBe('• one\n');
    type(field, 'after');
    commit(field);
    expect(cellText(h)).toBe('• one<br>after');
  });

  it('Tab off the last cell still appends a row when the line is not an item', () => {
    const h = mount();
    const field = openCell(h, 0, 1);
    field.value = '- item';
    field.setSelectionRange(field.value.length, field.value.length);
    press(field, 'Tab'); // on an item: nests, does not leave
    expect(parseGfmTable(h.text())?.rows).toHaveLength(1);

    field.value = 'plain';
    field.setSelectionRange(field.value.length, field.value.length);
    press(field, 'Tab'); // plain line: the old behaviour, a new row
    expect(parseGfmTable(h.text())?.rows).toEqual([
      ['1', 'plain'],
      ['', ''],
    ]);
  });

  it('leaves a cell with no list alone, byte for byte', () => {
    // Every near-miss the format has to tolerate: an em-dash, a bare hyphen
    // with no space, a number that is not an item, a `<br>` between prose lines.
    // Serialised first so the padding is already the widget's own — otherwise
    // the assertion would be about column widths rather than about the cell.
    const source = serializeGfmTable(
      parseGfmTable(
        [
          '| a | b |',
          '| --- | --- |',
          '| term — two weeks<br>-5 degrees<br>2024 was the year | 2 |',
        ].join('\n'),
      )!,
    );
    const h = mount(source);
    const field = openCell(h, 0, 0);
    commit(field);
    expect(h.text()).toBe(source);
  });

  it('draws a real list, nested, with the deeper items inside the item above', () => {
    const h = mount(
      ['| a |', '| - |', '| • one<br>  • two<br>    • three<br>plain |'].join('\n'),
    );
    const cell = h.cell(0, 0);

    const outer = cell.querySelector<HTMLElement>('.cm-md-cell > ul.cm-md-cell-list')!;
    expect(outer).toBeTruthy();
    const first = outer.querySelector<HTMLElement>(':scope > li')!;
    expect(first.querySelector('.cm-md-cell-text')?.textContent).toBe('one');
    // Second level lives inside the first item, third inside the second.
    const second = first.querySelector<HTMLElement>(':scope > ul.cm-md-cell-list > li')!;
    expect(second.dataset.line).toBe('1');
    expect(second.querySelector<HTMLElement>(':scope > ul.cm-md-cell-list > li')?.dataset.line).toBe(
      '2',
    );
    // The paragraph line ends the list rather than joining it.
    expect(cell.querySelector('.cm-md-cell > div.cm-md-cell-line')?.textContent).toBe('plain');
  });

  it('reads an imported list deeper than Tab can build without flattening it', () => {
    const deep = '• a<br>  • b<br>    • c<br>      • d';
    const h = mount(['| a |', '| - |', `| ${deep} |`].join('\n'));
    const field = openCell(h, 0, 0);
    // Opening and committing an untouched cell may not rewrite the file.
    commit(field);
    expect(parseGfmTable(h.text())?.rows[0][0]).toBe(deep);
  });

  it('treats a checklist item as a list item for Enter and for Tab', () => {
    const h = mount();
    const field = openCell(h, 0, 0);
    field.value = '[ ] one';
    field.setSelectionRange(field.value.length, field.value.length);

    press(field, 'Enter');
    expect(field.value).toBe('[ ] one\n[ ] ');
    type(field, 'two');
    press(field, 'Tab');
    expect(field.value).toBe('[ ] one\n  [ ] two');
    commit(field);

    expect(cellText(h)).toBe('[ ] one<br>  [ ] two');
    expect(h.cell(0, 0).querySelectorAll('input.cm-md-cell-check')).toHaveLength(2);
  });

  it('starts a new list when the marker kind changes at the same level', () => {
    const h = mount(['| a |', '| - |', '| • one<br>1. two |'].join('\n'));
    const cell = h.cell(0, 0);
    expect(cell.querySelectorAll('ul.cm-md-cell-list')).toHaveLength(1);
    expect(cell.querySelectorAll('ol.cm-md-cell-list')).toHaveLength(1);
  });
});

/* ------------------------------------------- round 27: the two + buttons -- */

/**
 * Inserting a row used to throw the viewport to the bottom of the page. Two
 * things caused it, and both are checked here: the edit named no cell to focus
 * afterwards, and it let CodeMirror re-anchor an update it had no anchor for
 * (the harness's `dispatch` reproduces that pin-to-the-bottom exactly).
 */
describe('inserting a row', () => {
  /** The `+` on the border above body row `index`. */
  const rowPlus = (h: Harness, index: number): HTMLElement =>
    h.dom.querySelectorAll<HTMLElement>('.cm-md-edge--row .cm-md-edge__btn')[index];

  it('opens the first cell of the new row, the way Tab already does', () => {
    const h = mount();
    mouse(rowPlus(h, 0), 'click');

    expect(parseGfmTable(h.text())?.rows).toEqual([
      ['', ''],
      ['1', '2'],
    ]);
    expect(h.dom.querySelector('.cm-md-cellinput')?.closest('td')).toBe(h.cell(0, 0));
  });

  it('leaves the viewport exactly where it was', () => {
    const h = mount();
    h.scroller.scrollTop = 240;
    mouse(rowPlus(h, 0), 'click');
    expect(h.scroller.scrollTop).toBe(240);
  });

  it('holds it through the deferred measure and the next frame too', async () => {
    const h = mount();
    h.scroller.scrollTop = 240;
    mouse(rowPlus(h, 1), 'click');
    // CodeMirror compensates asynchronously; so does the widget.
    h.scroller.scrollTop = h.scroller.scrollHeight;
    await settle();
    expect(h.scroller.scrollTop).toBe(240);
  });

  it('holds it for the bar button and for the row menu as well', () => {
    const h = mount();
    h.scroller.scrollTop = 90;
    mouse(h.dom.querySelectorAll<HTMLElement>('.cm-md-table-barbtn')[0], 'click');
    expect(h.scroller.scrollTop).toBe(90);
    expect(parseGfmTable(h.text())?.rows).toHaveLength(2);
    expect(h.dom.querySelector('.cm-md-cellinput')?.closest('td')).toBe(h.cell(1, 0));
  });

  it('still lets a Tab commit follow the caret out of the table', () => {
    const h = mount();
    const field = openCell(h, 0, 1);
    field.value = 'z';
    h.scroller.scrollTop = 10;
    press(field, 'Tab');
    // Deliberately NOT held: this edit hands focus to the appended row, and the
    // view is supposed to come along.
    expect(h.scroller.scrollTop).toBe(h.scroller.scrollHeight);
    expect(parseGfmTable(h.text())?.rows).toHaveLength(2);
  });
});

/**
 * The column `+` "did nothing": round 17 moved the overlay's column geometry
 * onto the `<colgroup>`, whose `<col>` elements generate no box, and the `<th>`
 * fallback beside it gave up whenever the header carried a merge. Every border
 * collapsed onto x=0 — the buttons piled up outside the table and the hover
 * test could never light one up.
 */
describe('inserting a column', () => {
  const MERGED_HEAD = ['| head |||', '| --- | --- | --- |', '| 1 | 2 | 3 |'].join('\n');

  const edgeLefts = (h: Harness): string[] =>
    [...h.dom.querySelectorAll<HTMLElement>('.cm-md-edge--col')].map((zone) => zone.style.left);

  const colPlus = (h: Harness, index: number): HTMLElement =>
    h.dom.querySelectorAll<HTMLElement>('.cm-md-edge--col .cm-md-edge__btn')[index];

  it('puts a + on every real column border', async () => {
    const h = await mountLaidOut();
    // Borders at x = 20 / 120 / 220, each button band reaching 14px either side.
    expect(edgeLefts(h)).toEqual(['6px', '106px', '206px']);
  });

  it('finds those borders under a merged header row', async () => {
    const h = await mountLaidOut(MERGED_HEAD);
    expect(h.dom.querySelectorAll('thead th')).toHaveLength(1);
    expect(edgeLefts(h)).toEqual(['6px', '106px', '206px', '306px']);
  });

  it('lights up the border the pointer is nearest, merged header or not', async () => {
    const h = await mountLaidOut(MERGED_HEAD);
    mouse(h.dom.querySelector('.cm-md-table-frame')!, 'mousemove', { clientX: 220, clientY: 25 });
    const active = [...h.dom.querySelectorAll<HTMLElement>('.cm-md-edge--col')].findIndex(
      (zone) => zone.dataset.active === 'true',
    );
    expect(active).toBe(2);
  });

  it('inserts at the border that was pressed', async () => {
    for (const [index, header] of [
      [0, ['', 'a', 'b']],
      [1, ['a', '', 'b']],
      [2, ['a', 'b', '']],
    ] as const) {
      const h = await mountLaidOut();
      mouse(colPlus(h, index), 'click');
      expect(parseGfmTable(h.text())?.header).toEqual(header);
      document.body.replaceChildren();
    }
  });

  it('inserts into the middle of a merged header without losing the merge', async () => {
    const h = await mountLaidOut(MERGED_HEAD);
    mouse(colPlus(h, 2), 'click');
    const table = parseGfmTable(h.text())!;
    expect(table.header).toHaveLength(4);
    expect(table.rows).toEqual([['1', '2', '', '3']]);
    // Inserting inside a span widens it rather than splitting it.
    expect(table.spanLeft?.[0]).toEqual([false, true, true, true]);
  });

  it('opens the new column header for editing', () => {
    const h = mount();
    mouse(h.dom.querySelectorAll<HTMLElement>('.cm-md-table-barbtn')[1], 'click');
    expect(h.dom.querySelector('.cm-md-cellinput')?.closest('th')).toBe(h.cell(HEADER_ROW, 2));
  });

  it('leaves the viewport where it was', () => {
    const h = mount();
    h.scroller.scrollTop = 175;
    mouse(h.dom.querySelectorAll<HTMLElement>('.cm-md-edge--col .cm-md-edge__btn')[1], 'click');
    expect(parseGfmTable(h.text())?.header).toEqual(['a', '', 'b']);
    expect(h.scroller.scrollTop).toBe(175);
  });

  it('re-addresses w= and leaves no column without a width', () => {
    const h = mount(['[//]: # (folio-table: w=1:30%,2:70%)', '', SIMPLE].join('\n'));
    mouse(h.dom.querySelectorAll<HTMLElement>('.cm-md-edge--col .cm-md-edge__btn')[1], 'click');

    // A map that named every column but the new one would hand the newcomer
    // whatever is left of 100% — nothing — and the column would arrive invisible.
    expect(h.text().split('\n')[0]).toBe('[//]: # (folio-table: w=1:20%,2:33%,3:47%)');
    const widths = [...h.dom.querySelectorAll<HTMLElement>('colgroup col')].map((c) => c.style.width);
    expect(widths).toEqual(['20%', '33%', '47%']);
  });

  it('carries cell backgrounds across, metadata line and all', () => {
    const h = mount(['[//]: # (folio-table: bg=B1:green)', '', SIMPLE].join('\n'));
    expect(h.cell(0, 1).className).toContain('folio-bg-green');
    mouse(h.dom.querySelectorAll<HTMLElement>('.cm-md-edge--col .cm-md-edge__btn')[1], 'click');

    expect(h.text().split('\n')[0]).toBe('[//]: # (folio-table: bg=C1:green)');
    expect(parseGfmTable(h.text())?.header).toEqual(['a', '', 'b']);
    expect(h.cell(0, 2).className).toContain('folio-bg-green');
  });

  it('works just the same on a table with no metadata line', () => {
    const h = mount();
    mouse(h.dom.querySelectorAll<HTMLElement>('.cm-md-edge--col .cm-md-edge__btn')[2], 'click');
    expect(h.text().split('\n')).toHaveLength(3);
    expect(parseGfmTable(h.text())?.rows).toEqual([['1', '2', '']]);
  });
});

/**
 * Round 27: the right-click menu. Everything the `…` handles carry, at the
 * pointer — the handles are 11px and the owner could not hit them.
 */
describe('the cell context menu', () => {
  const GRID = ['| a | b | c |', '| --- | --- | --- |', '| 1 | 2 | 3 |', '| 4 | 5 | 6 |'].join('\n');

  const rightClick = (node: EventTarget): MouseEvent => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    node.dispatchEvent(event);
    return event;
  };

  const menu = (): HTMLElement | null => document.querySelector<HTMLElement>('.folio-tablemenu');

  const labels = (): string[] =>
    [...document.querySelectorAll('.folio-tablemenu__label')].map((n) => n.textContent ?? '');

  const item = (label: string): HTMLElement =>
    [...document.querySelectorAll<HTMLElement>('.folio-tablemenu__item')].find(
      (button) => button.querySelector('.folio-tablemenu__label')?.textContent === label,
    )!;

  const selected = (h: Harness): number => h.dom.querySelectorAll('[data-selected="true"]').length;

  it('opens on a right click and swallows the browser menu', () => {
    const h = mount(GRID);
    const event = rightClick(h.cell(0, 1));
    expect(event.defaultPrevented).toBe(true);
    expect(menu()).toBeTruthy();
  });

  it('carries the row, column, background and alignment actions', () => {
    const h = mount(GRID);
    rightClick(h.cell(0, 1));
    expect(labels()).toEqual([
      'Insert row above',
      'Insert row below',
      'Insert column to the left',
      'Insert column to the right',
      'Align left',
      'Align centre',
      'Align right',
      'No alignment',
      'Emoji…',
      'Delete row',
      'Delete column',
    ]);
    expect(document.querySelectorAll('.folio-tablemenu__swatch').length).toBeGreaterThan(0);
  });

  it('a right click does not open the cell for editing', () => {
    const h = mount(GRID);
    mouse(h.cell(0, 1), 'mousedown', { button: 2 });
    rightClick(h.cell(0, 1));
    expect(h.dom.querySelector('.cm-md-cellinput')).toBeNull();
  });

  // The owner, 24.09.2026: "a right click on a table — an analog of the column menu". A cell
  // opens on its first click, so the right-click usually lands in the editor.
  it('opens from inside the open cell editor too, committing the draft first', () => {
    const h = mount(GRID);
    mouse(h.cell(0, 1), 'mousedown');
    const field = h.dom.querySelector<HTMLElement>('.cm-md-cellinput')!;
    expect(field).toBeTruthy();
    const event = rightClick(field);
    expect(event.defaultPrevented).toBe(true);
    expect(menu()).toBeTruthy();
    expect(h.dom.querySelector('.cm-md-cellinput')).toBeNull();
  });

  // The owner, 24.09.2026: "I clicked somewhere on the table — it went into
  // source». A press on the widget's own chrome must not move the browser
  // selection, or CodeMirror puts the caret at the widget and unfolds it.
  it('a press on the widget outside any cell is swallowed, so the grid stays folded', () => {
    const h = mount(GRID);
    const bar = h.dom.querySelector<HTMLElement>('.cm-md-table-bar__spacer')!;
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    bar.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const frame = h.dom.querySelector<HTMLElement>('.cm-md-table-frame')!;
    const onFrame = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    frame.dispatchEvent(onFrame);
    expect(onFrame.defaultPrevented).toBe(true);
  });

  it('acts on the cell that was clicked', () => {
    const h = mount(GRID);
    rightClick(h.cell(1, 1));
    mouse(item('Insert row below'), 'click');
    expect(parseGfmTable(h.text())?.rows).toEqual([
      ['1', '2', '3'],
      ['4', '5', '6'],
      ['', '', ''],
    ]);
  });

  it('inserts a column on the side that was asked for', () => {
    const h = mount(GRID);
    rightClick(h.cell(0, 2));
    mouse(item('Insert column to the left'), 'click');
    expect(parseGfmTable(h.text())?.header).toEqual(['a', 'b', '', 'c']);
  });

  it('selects the cell it was opened on', () => {
    const h = mount(GRID);
    rightClick(h.cell(1, 2));
    expect(selected(h)).toBe(1);
    expect(h.cell(1, 2).dataset.selected).toBe('true');
  });

  it('keeps a shift-selection when the click lands inside it, and acts on it', () => {
    const h = mount(GRID);
    mouse(h.cell(0, 0), 'mousedown');
    mouse(h.cell(1, 1), 'mousedown', { shiftKey: true });
    expect(selected(h)).toBe(4);

    rightClick(h.cell(1, 1));
    expect(selected(h)).toBe(4);

    mouse(item('Merge cells'), 'click');
    expect(h.text().split('\n').slice(2)).toEqual(['| 1<br>2<br>4<br>5 || 3   |', '| ^^  || 6   |']);
  });

  it('moves the selection when the click lands outside it', () => {
    const h = mount(GRID);
    mouse(h.cell(0, 0), 'mousedown');
    mouse(h.cell(1, 1), 'mousedown', { shiftKey: true });

    rightClick(h.cell(0, 2));
    expect(selected(h)).toBe(1);
    expect(h.cell(0, 2).dataset.selected).toBe('true');
  });

  it('spans the whole selection when inserting around it', () => {
    const h = mount(GRID);
    mouse(h.cell(0, 0), 'mousedown');
    mouse(h.cell(1, 1), 'mousedown', { shiftKey: true });
    rightClick(h.cell(0, 0));
    mouse(item('Insert row below'), 'click');
    // Below the LAST selected row, not below the cell under the pointer.
    expect(parseGfmTable(h.text())?.rows).toEqual([
      ['1', '2', '3'],
      ['4', '5', '6'],
      ['', '', ''],
    ]);
  });

  it('offers no row deletion on the header, which is not a row you can drop', () => {
    const h = mount(GRID);
    rightClick(h.cell(HEADER_ROW, 0));
    expect(labels()).not.toContain('Delete row');
    expect(labels()).not.toContain('Insert row above');
    expect(labels()).toContain('Insert row below');
  });

});
