/**
 * The floating formatting toolbar (round 21) and the hotkeys behind it.
 *
 * One bar, two hosts: over a selection in the CodeMirror document it rides a
 * CodeMirror tooltip (positioned by CodeMirror, rendered into `<body>` like
 * every other popup here so the editor's scroll container cannot clip it), and
 * over a selection inside a table cell's `<textarea>` it is the same DOM,
 * mounted next to the field by hand. The edits themselves are pure — see
 * format.ts, which also explains why underline is `++text++` (it used to be an
 * `<ins>` tag pair that could cross a `**` pair) and highlight is `==text==`.
 */
import { EditorSelection, Prec, StateField, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, showTooltip, type Command, type KeyBinding, type Tooltip } from '@codemirror/view';
import { BG_TOKENS, bgClass, type BgToken } from '../markdown/tableSyntax';
import {
  HIGHLIGHT_COLORS,
  INLINE_MARKS,
  applyFormatEdit,
  formatActiveIn,
  highlightColorAt,
  highlightColorEdit,
  inlineFormatEdit,
  linkEdit,
  quoteEdit,
  type FormatEdit,
  type InlineFormat,
} from './format';
import { createIcon, type IconName } from './icons';
import { t } from './i18n';
import { languageChangedEffect } from './i18n-reload';
import { openMenu, type MenuEntry } from './popup-menu';
import { insertStatus } from './status-widget';

/** Everything the bar can offer: the toggles, plus the two block-ish commands. */
type BarCommand = InlineFormat | 'quote' | 'link' | 'status';

const ICONS: Record<BarCommand, IconName> = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  strike: 'strike',
  code: 'code',
  highlight: 'highlight',
  quote: 'quote',
  link: 'link',
  status: 'tag',
};

const HOTKEYS: Record<BarCommand, string> = {
  bold: 'B',
  italic: 'I',
  underline: 'U',
  strike: '⇧X',
  code: 'E',
  highlight: '',
  quote: '',
  // NOT ⌘K: that one opens the quick switcher app-wide. See LINK_KEY below.
  link: '⇧K',
  status: '',
};

function modLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl+';
  const platform = navigator.platform || navigator.userAgent || '';
  return /Mac|iP(hone|ad|od)/.test(platform) ? '⌘' : 'Ctrl+';
}

function title(kind: BarCommand): string {
  const label = t(`format.${kind}`);
  const key = HOTKEYS[kind];
  return key ? `${label} (${modLabel()}${key})` : label;
}

/* ------------------------------------------------------------- shared bar -- */

/** What the highlight colour menu can pick: a palette token, or `none` to take the highlight off. */
export type HighlightPick = BgToken | 'none';

export interface FormatBarOptions {
  /** Block quote is a block construct — offered outside table cells only. */
  quote: boolean;
  /** Whether a format currently wraps the selection, for the pressed state. */
  isActive(kind: InlineFormat): boolean;
  onFormat(kind: InlineFormat): void;
  onQuote?(): void;
  /** Round 28: wrap the selection in a markdown link. Both hosts get it. */
  onLink?(): void;
  /**
   * Wrap the selection in a status tag (or insert one). Offered by the
   * CodeMirror hosts only: a table cell keeps its own inline grammar and does
   * not render a tag, so its bar leaves this out.
   */
  onStatus?(): void;
  /**
   * The colour chevron beside the highlight button (the owner, 24.09.2026:
   * "give highlight a choice of color"). `highlightColor` answers which swatch
   * is current: a token, `null` for the default yellow, `undefined` when the
   * selection is not highlighted.
   */
  onHighlightColor?(pick: HighlightPick): void;
  highlightColor?(): BgToken | null | undefined;
}

/** The swatch row the chevron opens — one entry per palette token plus «none». */
function highlightSwatches(current: BgToken | null | undefined, pick: (choice: HighlightPick) => void): MenuEntry {
  return {
    kind: 'swatches',
    label: t('format.highlightColor'),
    items: [
      ...HIGHLIGHT_COLORS.map((token) => ({
        label: t(`table.bg.${token}`),
        className: `cm-md-swatch ${bgClass(token)}`,
        selected: current === token || (current === null && token === 'yellow'),
        onSelect: () => pick(token),
      })),
      {
        label: t('format.highlightNone'),
        className: 'cm-md-swatch cm-md-swatch--none',
        selected: current === undefined,
        onSelect: () => pick('none'),
      },
    ],
  };
}

export function buildFormatBar({
  quote,
  isActive,
  onFormat,
  onQuote,
  onLink,
  onStatus,
  onHighlightColor,
  highlightColor,
}: FormatBarOptions): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'cm-folio-format';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', t('format.aria'));

  const add = (kind: BarCommand, run: () => void, active: boolean) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-folio-format__btn';
    button.title = title(kind);
    button.setAttribute('aria-label', t(`format.${kind}`));
    button.setAttribute('aria-pressed', String(active));
    button.appendChild(createIcon(ICONS[kind]));
    // Keeps the selection (and the editor's focus) exactly where it is: a
    // toolbar that clears what you selected is a toolbar that cannot work.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      run();
    });
    bar.appendChild(button);
  };

  for (const kind of ['bold', 'italic', 'underline', 'strike', 'code', 'highlight'] as const) {
    add(kind, () => onFormat(kind), isActive(kind));
  }
  if (onHighlightColor) {
    const chevron = document.createElement('button');
    chevron.type = 'button';
    chevron.className = 'cm-folio-format__btn cm-folio-format__btn--color';
    chevron.title = t('format.highlightColor');
    chevron.setAttribute('aria-label', t('format.highlightColor'));
    chevron.setAttribute('aria-haspopup', 'menu');
    chevron.appendChild(createIcon('chevronDown'));
    chevron.addEventListener('mousedown', (event) => event.preventDefault());
    chevron.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = chevron.getBoundingClientRect();
      // No focus for the menu: taking it would blur a table cell's field and
      // commit the cell out from under the palette (see popup-menu.ts).
      openMenu({
        x: rect.left,
        y: rect.bottom + 4,
        ariaLabel: t('format.highlightColor'),
        takeFocus: false,
        items: [highlightSwatches(highlightColor?.(), onHighlightColor)],
      });
    });
    bar.appendChild(chevron);
  }
  // Separated from the toggles above: these two write a construct rather than
  // switching one on and off, and the divider is what says so.
  if (onLink || onStatus || (quote && onQuote)) {
    const sep = document.createElement('span');
    sep.className = 'cm-folio-format__sep';
    bar.appendChild(sep);
  }
  if (onLink) add('link', onLink, false);
  if (onStatus) add('status', onStatus, false);
  if (quote && onQuote) add('quote', onQuote, false);
  return bar;
}

/* ------------------------------------------------- CodeMirror integration -- */

/**
 * The lines the selection touches, plus the offset they start at. Whole lines
 * rather than a few characters of padding: format.ts finds the RUN the
 * selection sits in (`runsOf`), and a run's opening marker can be a whole
 * sentence away. Inline runs never cross a line, so this is still O(line).
 */
function sliceAround(state: EditorState, from: number, to: number) {
  const start = state.doc.lineAt(from).from;
  const end = state.doc.lineAt(to).to;
  return { start, text: state.doc.sliceString(start, end) };
}

function dispatchEdit(view: EditorView, offset: number, edit: FormatEdit): boolean {
  if (edit.changes.length === 0) {
    // A caret stepping out of a run is a selection move and nothing else.
    const main = view.state.selection.main;
    if (edit.selection.from + offset === main.from && edit.selection.to + offset === main.to) return false;
    view.dispatch({ selection: EditorSelection.single(edit.selection.from + offset, edit.selection.to + offset) });
    view.focus();
    return true;
  }
  view.dispatch({
    changes: edit.changes.map((change) => ({
      from: change.from + offset,
      to: change.to + offset,
      insert: change.insert,
    })),
    selection: EditorSelection.single(edit.selection.from + offset, edit.selection.to + offset),
    scrollIntoView: true,
    userEvent: 'input.format',
  });
  view.focus();
  return true;
}

export function formatCommand(kind: InlineFormat): Command {
  return (view) => {
    const range = view.state.selection.main;
    const { start, text } = sliceAround(view.state, range.from, range.to);
    return dispatchEdit(view, start, inlineFormatEdit(text, range.from - start, range.to - start, kind));
  };
}

/**
 * Wrap the selection in a link (or drop an empty one at the caret) and put the
 * selection on the part that still has to be typed — `linkEdit` decides which.
 */
export const linkCommand: Command = (view) => {
  const range = view.state.selection.main;
  const { start, text } = sliceAround(view.state, range.from, range.to);
  return dispatchEdit(view, start, linkEdit(text, range.from - start, range.to - start));
};

export const quoteCommand: Command = (view) => {
  const range = view.state.selection.main;
  // Whole lines: `quoteEdit` counts line starts from position 0 of what it gets.
  const first = view.state.doc.lineAt(range.from);
  const last = view.state.doc.lineAt(range.to);
  const text = view.state.doc.sliceString(first.from, last.to);
  return dispatchEdit(view, first.from, quoteEdit(text, range.from - first.from, range.to - first.from));
};

/**
 * Whether the caret (or selection) already sits inside this format — the
 * pressed state of a button. Exported because the pinned toolbar (round 25)
 * shows the same buttons permanently and has to answer the same question.
 */
export function isFormatActive(state: EditorState, kind: InlineFormat): boolean {
  const range = state.selection.main;
  const { start, text } = sliceAround(state, range.from, range.to);
  return formatActiveIn(text, range.from - start, range.to - start, kind);
}

/** The highlight colour under the selection — see `FormatBarOptions.highlightColor`. */
export function highlightColorOf(state: EditorState): BgToken | null | undefined {
  const range = state.selection.main;
  const { start, text } = sliceAround(state, range.from, range.to);
  return highlightColorAt(text, range.from - start, range.to - start);
}

/** Paint the selection with a palette colour, or take the highlight off (`none`). */
export function highlightColorCommand(pick: HighlightPick): Command {
  return (view) => {
    const range = view.state.selection.main;
    const { start, text } = sliceAround(view.state, range.from, range.to);
    const from = range.from - start;
    const to = range.to - start;
    if (pick === 'none') {
      if (!formatActiveIn(text, from, to, 'highlight')) return false;
      return dispatchEdit(view, start, inlineFormatEdit(text, from, to, 'highlight'));
    }
    return dispatchEdit(view, start, highlightColorEdit(text, from, to, pick === 'yellow' ? null : pick));
  };
}

/**
 * The link hotkey, and why it is not ⌘K.
 *
 * ⌘K belongs to the app's quick switcher and taking it here would break the
 * one shortcut every reader already knows. ⌘⌥K was the other candidate and is
 * unbound everywhere, but CodeMirror can only resolve an Alt combination
 * through the *physical* key, and on Windows it refuses to do that for
 * Ctrl+Alt at all (AltGr) — which would leave the binding dead for anyone
 * typing on a Cyrillic layout there, i.e. most of this app's authors.
 * `Mod-Shift-k` resolves everywhere. It costs `deleteLine`, which
 * `defaultKeymap` binds to Shift-Mod-k and which this (Prec.high) keymap now
 * shadows — a deliberate trade: a prose editor needs "make this a link" more
 * than it needs a second way to delete a line.
 */
export const LINK_KEY = 'Mod-Shift-k';

export const FORMAT_KEYMAP: readonly KeyBinding[] = [
  { key: 'Mod-b', run: formatCommand('bold'), preventDefault: true },
  { key: 'Mod-i', run: formatCommand('italic'), preventDefault: true },
  { key: 'Mod-u', run: formatCommand('underline'), preventDefault: true },
  { key: 'Mod-Shift-x', run: formatCommand('strike'), preventDefault: true },
  { key: 'Mod-e', run: formatCommand('code'), preventDefault: true },
  { key: LINK_KEY, run: linkCommand, preventDefault: true },
];

/**
 * The bar over a selection in the document. It was taken out once in favour
 * of the pinned top toolbar alone («covering the document»); the owner asked
 * for it back on 24.09.2026 ("I selected — and the mini editor did not appear"): a
 * selection is where the formatting decision is being made, and the strip at
 * the top is a long way from it on a tall page. It rides a CodeMirror tooltip
 * above the selection (rendered into <body> like every other popup here, so
 * the scroller cannot clip it) and disappears the moment the selection
 * collapses. Table cells keep their own copy (`attachFieldFormatting`): they
 * are outside CodeMirror's selection model.
 */
function tooltipsFor(state: EditorState): readonly Tooltip[] {
  const range = state.selection.main;
  if (range.empty || state.selection.ranges.length > 1) return [];
  if (state.readOnly) return [];
  return [
    {
      pos: range.from,
      end: range.to,
      above: true,
      arrow: false,
      create: (view) => ({
        dom: buildFormatBar({
          quote: true,
          isActive: (kind) => isFormatActive(view.state, kind),
          onFormat: (kind) => formatCommand(kind)(view),
          onQuote: () => quoteCommand(view),
          onLink: () => linkCommand(view),
          onStatus: () => void insertStatus(view),
          onHighlightColor: (pick) => highlightColorCommand(pick)(view),
          highlightColor: () => highlightColorOf(view.state),
        }),
      }),
    },
  ];
}

const formatTooltip = StateField.define<readonly Tooltip[]>({
  create: tooltipsFor,
  update(value, tr) {
    if (
      !tr.docChanged &&
      !tr.selection &&
      !tr.reconfigured &&
      !tr.effects.some((effect) => effect.is(languageChangedEffect))
    ) {
      return value;
    }
    return tooltipsFor(tr.state);
  },
  provide: (field) => showTooltip.computeN([field], (state) => state.field(field)),
});

/** The selection bar plus the hotkeys behind it; the pinned toolbar shows the same buttons permanently. */
export const formatting: Extension = [formatTooltip, Prec.high(keymap.of([...FORMAT_KEYMAP]))];

/* ------------------------------------------------- plain text-field host -- */

/** Which format a keyboard event asks for, or null. */
export function formatForEvent(event: KeyboardEvent): InlineFormat | null {
  if (!(event.metaKey || event.ctrlKey)) return null;
  const key = event.key.toLowerCase();
  if (event.shiftKey) return key === 'x' ? 'strike' : null;
  if (key === 'b') return 'bold';
  if (key === 'i') return 'italic';
  if (key === 'u') return 'underline';
  if (key === 'e') return 'code';
  return null;
}

export interface FieldFormatHandle {
  /** Re-check the selection and show or hide the bar. */
  refresh(): void;
  destroy(): void;
}

/**
 * The same bar over a `<textarea>` — the table cell editor. Quote is left out:
 * a cell is one pipe-table row and cannot hold a block construct.
 */
export function attachFieldFormatting(
  field: HTMLTextAreaElement,
  onChange?: () => void,
): FieldFormatHandle {
  let bar: HTMLElement | null = null;

  const selection = () => ({
    from: field.selectionStart ?? 0,
    to: field.selectionEnd ?? 0,
  });

  /** Every command here is the same three lines: a pure edit, applied. */
  const run = (edit: FormatEdit) => {
    field.value = applyFormatEdit(field.value, edit);
    field.setSelectionRange(edit.selection.from, edit.selection.to);
    field.focus();
    onChange?.();
    show();
  };

  const apply = (kind: InlineFormat) => {
    const { from, to } = selection();
    run(inlineFormatEdit(field.value, from, to, kind));
  };

  // A cell renders links like any other inline markup (gfm-table's parseInline
  // has a `link` token), so the button belongs here too. No hotkey: the cell's
  // own keydown handler routes only what `formatForEvent` knows.
  const applyLink = () => {
    const { from, to } = selection();
    run(linkEdit(field.value, from, to));
  };

  const hide = () => {
    bar?.remove();
    bar = null;
  };

  const show = () => {
    const { from, to } = selection();
    if (from === to || !field.isConnected) return hide();

    hide();
    bar = buildFormatBar({
      quote: false,
      isActive: (kind) => formatActiveIn(field.value, from, to, kind),
      onFormat: apply,
      onLink: applyLink,
      onHighlightColor: (pick) => {
        const at = selection();
        if (pick === 'none') {
          if (formatActiveIn(field.value, at.from, at.to, 'highlight')) apply('highlight');
          return;
        }
        run(highlightColorEdit(field.value, at.from, at.to, pick === 'yellow' ? null : pick));
      },
      highlightColor: () => {
        const at = selection();
        return highlightColorAt(field.value, at.from, at.to);
      },
    });
    bar.classList.add('cm-folio-format--field');
    bar.style.position = 'fixed';
    bar.style.zIndex = '1200';
    document.body.appendChild(bar);

    const anchor = field.getBoundingClientRect();
    const size = bar.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - size.width - 8));
    const above = anchor.top - size.height - 6;
    bar.style.left = `${Math.round(left)}px`;
    bar.style.top = `${Math.round(above >= 8 ? above : anchor.bottom + 6)}px`;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const kind = formatForEvent(event);
    if (!kind) return;
    event.preventDefault();
    event.stopPropagation();
    apply(kind);
  };

  // `selectionchange` on the document is the only event that fires for every
  // way a text field's selection can move; the rest are best-effort nudges.
  const onSelectionChange = () => {
    if (document.activeElement === field) show();
  };

  field.addEventListener('keydown', onKeyDown);
  field.addEventListener('mouseup', show);
  field.addEventListener('input', show);
  document.addEventListener('selectionchange', onSelectionChange);

  return {
    refresh: show,
    destroy() {
      field.removeEventListener('keydown', onKeyDown);
      field.removeEventListener('mouseup', show);
      field.removeEventListener('input', show);
      document.removeEventListener('selectionchange', onSelectionChange);
      hide();
    },
  };
}

export { INLINE_MARKS, BG_TOKENS };
