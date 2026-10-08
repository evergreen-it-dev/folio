// @vitest-environment jsdom
/**
 * The status tag in a real EditorView: parsed from `:status[…]{color=…}`,
 * drawn as a badge in live mode, raw in source mode, edited through the
 * popover (text + colour dots), inserted by the toolbar/slash commands.
 * The document text is the only state — every assertion reads it back.
 */
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { BLOCK_ITEMS, toolbarOverflowItems } from './block-commands';
import { buildFormatBar } from './format-toolbar';
import { livePreview, livePreviewConfig } from './live-preview';
import { markdownEditorExtensions } from './markdown-setup';
import { insertStatus, openStatusPopover } from './status-widget';

const views: EditorView[] = [];

function mount(doc: string, selection: EditorSelection | number = 0, live = true, readOnly = false): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdownEditorExtensions(),
        livePreview,
        livePreviewConfig(live, { space: 'eng', pagePath: 'a.md', pageId: 'P1' }),
        EditorState.readOnly.of(readOnly),
      ],
      selection: typeof selection === 'number' ? EditorSelection.single(selection) : selection,
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

const badges = (view: EditorView) => [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-md-status')];
const popover = () => document.querySelector<HTMLElement>('.folio-status-pop');
const input = () => document.querySelector<HTMLInputElement>('.folio-status-pop__input')!;
const swatch = (color: string) => document.querySelector<HTMLButtonElement>(`.folio-status-pop__swatch.folio-status--${color}`)!;

function type(text: string): void {
  const field = input();
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe('badge', () => {
  it('draws the tag as a coloured badge and leaves the markdown alone', () => {
    const doc = 'Level: :status[Must have]{color=red} now';
    const view = mount(doc);
    const [badge] = badges(view);
    expect(badge.textContent).toBe('Must have');
    expect(badge.classList.contains('folio-status--red')).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.contentDOM.textContent).not.toContain(':status');
  });

  it('defaults to grey and takes an unknown colour as grey', () => {
    const view = mount(':status[A] :status[B]{color=mauve}');
    expect(badges(view).map((b) => [...b.classList].find((c) => c.startsWith('folio-status--')))).toEqual([
      'folio-status--grey',
      'folio-status--grey',
    ]);
  });

  it('shows the raw syntax in source mode', () => {
    const view = mount(':status[Done]{color=green}', 0, false);
    expect(badges(view)).toEqual([]);
    expect(view.contentDOM.textContent).toContain(':status[Done]{color=green}');
  });

  it('ignores a tag inside inline code and a fenced block', () => {
    const view = mount('`:status[x]` and\n\n```\n:status[y]\n```\n');
    expect(badges(view)).toEqual([]);
  });

  it('is one atom: the caret steps over it and Backspace removes the whole tag', () => {
    const doc = 'a :status[Done]{color=green} b';
    const view = mount(doc, doc.indexOf(' b'));
    const atoms = view.state.facet(EditorView.atomicRanges).map((f) => f(view));
    const from = doc.indexOf(':status');
    const to = doc.indexOf(' b');
    const inside = atoms.some((set) => {
      let hit = false;
      set.between(from + 1, to - 1, () => {
        hit = true;
      });
      return hit;
    });
    expect(inside).toBe(true);
  });
});

describe('in a table cell', () => {
  it('shows the badge in the grid instead of the raw syntax, and leaves the table text alone', () => {
    const doc = 'Intro\n\n| Item | State |\n| --- | --- |\n| One | :status[Done]{color=green} |\n\nAfter\n';
    const view = mount(doc);
    const badge = view.contentDOM.querySelector<HTMLElement>('.cm-md-table-widget .folio-status--green');
    expect(badge?.textContent).toBe('Done');
    expect(view.state.doc.toString()).toBe(doc);
  });
});

describe('popover', () => {
  it('opens on a click, with the current text and colour', () => {
    const view = mount('x :status[Done]{color=green}');
    badges(view)[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(popover()).not.toBeNull();
    expect(input().value).toBe('Done');
    expect(swatch('green').dataset.selected).toBe('true');
    expect(swatch('grey').dataset.selected).toBe('false');
  });

  it('offers the six colours', () => {
    const view = mount(':status[Done]');
    openStatusPopover(view, 0);
    expect(document.querySelectorAll('.folio-status-pop__swatch').length).toBe(6);
  });

  it('writes a colour change into the source', () => {
    const view = mount('x :status[Done]{color=green} y');
    openStatusPopover(view, 2);
    swatch('red').click();
    expect(view.state.doc.toString()).toBe('x :status[Done]{color=red} y');
    swatch('grey').click();
    expect(view.state.doc.toString()).toBe('x :status[Done] y');
  });

  it('writes the text as typed and escapes what would break the tag', () => {
    const view = mount(':status[Done]{color=blue}');
    openStatusPopover(view, 0);
    type('In [review]');
    expect(view.state.doc.toString()).toBe(':status[In \\[review\\]]{color=blue}');
    expect(badges(view)[0].textContent).toBe('In [review]');
  });

  it('keeps the colour while the text changes and vice versa', () => {
    const view = mount(':status[A]');
    openStatusPopover(view, 0);
    swatch('purple').click();
    type('Bee');
    expect(view.state.doc.toString()).toBe(':status[Bee]{color=purple}');
  });

  it('waits out an IME composition and writes the finished text', () => {
    const view = mount(':status[A]{color=green}');
    openStatusPopover(view, 0);
    const field = input();
    field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    field.value = 'Pr';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    expect(view.state.doc.toString()).toBe(':status[A]{color=green}');
    field.value = 'Prêt';
    field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    expect(view.state.doc.toString()).toBe(':status[Prêt]{color=green}');
  });

  it('finds the tag again after someone else edited above it', () => {
    const view = mount('x :status[Done]');
    openStatusPopover(view, 2);
    view.dispatch({ changes: { from: 0, insert: 'NEW LINE\n' } });
    swatch('yellow').click();
    expect(view.state.doc.toString()).toBe('NEW LINE\nx :status[Done]{color=yellow}');
  });

  it('closes on Enter and Escape, leaving the caret after the tag', () => {
    const view = mount('a :status[Done] b');
    openStatusPopover(view, 2);
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(popover()).toBeNull();
    expect(view.state.selection.main.head).toBe('a :status[Done]'.length);
    openStatusPopover(view, 2);
    popover()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(popover()).toBeNull();
  });

  it('closes on a click outside', () => {
    const view = mount(':status[Done]');
    openStatusPopover(view, 0);
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(popover()).toBeNull();
  });

  it('removes the tag when it is closed with an empty text', () => {
    const view = mount('a :status[Done] b');
    openStatusPopover(view, 2);
    type('   ');
    expect(view.state.doc.toString()).toBe('a :status[Done] b');
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(view.state.doc.toString()).toBe('a  b');
  });

  it('does not open in a read-only editor', () => {
    const view = mount(':status[Done]', 0, true, true);
    badges(view)[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(popover()).toBeNull();
  });
});

describe('insertStatus', () => {
  it('wraps the selected text in a tag and opens the popover', () => {
    const view = mount('pick Selected here', EditorSelection.single(5, 13));
    expect(insertStatus(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('pick :status[Selected] here');
    expect(popover()).not.toBeNull();
    expect(input().value).toBe('Selected');
    swatch('green').click();
    expect(view.state.doc.toString()).toBe('pick :status[Selected]{color=green} here');
  });

  it('inserts a default tag at the caret and opens the popover on it', () => {
    const view = mount('ab', 1);
    insertStatus(view);
    expect(view.state.doc.toString()).toBe('a:status[Status]b');
    expect(popover()).not.toBeNull();
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe('Status'.length);
  });

  it('collapses a multi-line selection into one label', () => {
    const view = mount('one\ntwo', EditorSelection.single(0, 7));
    insertStatus(view);
    expect(view.state.doc.toString()).toBe(':status[one two]');
  });

  it('does nothing in a read-only editor', () => {
    const view = mount('ab', 1, true, true);
    expect(insertStatus(view)).toBe(false);
    expect(view.state.doc.toString()).toBe('ab');
  });
});

describe('where the command is offered', () => {
  it('is a button on the formatting bar when a host wires it, and absent otherwise', () => {
    const base = { quote: true, isActive: () => false, onFormat: () => {} };
    const without = buildFormatBar(base);
    expect(without.querySelector('[aria-label="Status"]')).toBeNull();
    let called = 0;
    const withStatus = buildFormatBar({ ...base, onStatus: () => called++ });
    const button = withStatus.querySelector<HTMLButtonElement>('[aria-label="Status"]')!;
    expect(button.title).toBe('Status');
    button.click();
    expect(called).toBe(1);
  });

  it('is a slash-menu entry, replacing the typed «/status» with a tag', () => {
    const item = BLOCK_ITEMS.find((candidate) => candidate.id === 'status')!;
    expect(item).toBeDefined();
    const view = mount('x /stat', 7);
    item.insert(view, 2, 7, null);
    expect(view.state.doc.toString()).toBe('x :status[Status]');
    expect(popover()).not.toBeNull();
  });

  it('is not duplicated in the toolbar overflow menu', () => {
    expect(toolbarOverflowItems().some((item) => item.id === 'status')).toBe(false);
  });
});
