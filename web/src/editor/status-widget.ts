/**
 * The status tag in the live editor: `:status[Selected]{color=green}` drawn as a
 * badge, a popover to edit it, and the commands that insert one.
 *
 * Same contract as every widget here (widgets.tsx): the widget owns no state.
 * The document text is the only truth, the badge stands in for it, and every
 * edit — a typed letter, a swatch — is a plain `view.dispatch` that the Yjs
 * binding turns into a CRDT update, so the popover, source mode and remote
 * peers can never disagree.
 *
 * The syntax and its escaping rules are shared/status.ts; the parser that
 * finds the tag in the editor is status-syntax.ts; the stylesheet that paints
 * the badge (reading mode uses it too) is markdown/status.css.
 */
import { EditorView, WidgetType } from '@codemirror/view';
import {
  STATUS_COLORS,
  cleanStatusLabel,
  parseStatusAt,
  serializeStatus,
  statusClassNames,
  type StatusColor,
} from '@shared/status';
import { t } from './i18n';

/* ----------------------------------------------------------------- widget -- */

/** True when the user can change the document (not a viewer, not a read-only share). */
function isEditable(view: EditorView): boolean {
  return !view.state.readOnly && view.state.facet(EditorView.editable);
}

/** The tag that starts at `pos`, as `{ from, to, raw }`, or null when none does. */
function tagAt(view: EditorView, pos: number): { from: number; to: number; raw: string } | null {
  const doc = view.state.doc;
  const text = doc.sliceString(pos, Math.min(doc.length, pos + 400));
  const parsed = parseStatusAt(text);
  return parsed ? { from: pos, to: pos + parsed.length, raw: text.slice(0, parsed.length) } : null;
}

/**
 * The badge. `lang` is not used to build the DOM (the label is the author's
 * own text) — it is here so `eq()` sees a language switch and the aria-label
 * is rebuilt in the new language.
 */
export class StatusWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly color: StatusColor,
    readonly lang: string,
  ) {
    super();
  }

  eq(other: StatusWidget): boolean {
    return other.label === this.label && other.color === this.color && other.lang === this.lang;
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement('span');
    dom.className = `cm-md-status ${statusClassNames(this.color).join(' ')}`;
    dom.textContent = this.label;
    dom.setAttribute('role', 'button');
    dom.setAttribute('aria-haspopup', 'dialog');
    dom.setAttribute('aria-label', `${t('statusTag.edit')}: ${this.label}`);
    dom.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      // Whether or not it can be edited, the press is the badge's own: leaving
      // it to the editor would drop the caret beside it and scroll the page.
      event.preventDefault();
      if (!isEditable(view)) return;
      const tag = tagAt(view, view.posAtDOM(dom));
      if (tag) openStatusPopover(view, tag.from);
    });
    return dom;
  }

  /** The badge handles its own press (above); the editor must not also act on it. */
  ignoreEvent(): boolean {
    return true;
  }
}

/* ---------------------------------------------------------------- popover -- */

let openPopover: { dispose(): void } | null = null;

/** Keep a fixed-position panel inside the viewport, below the anchor when it fits. */
function place(dom: HTMLElement, rect: { left: number; top: number; bottom: number }): void {
  dom.style.left = '0px';
  dom.style.top = '0px';
  const size = dom.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - size.width - 8));
  const below = rect.bottom + 6 + size.height + 8 <= window.innerHeight;
  dom.style.left = `${Math.round(left)}px`;
  dom.style.top = `${Math.round(below ? rect.bottom + 6 : Math.max(8, rect.top - size.height - 6))}px`;
}

/**
 * Opens the edit popover for the tag that starts at `from`: a text field and
 * six colour dots. Edits are written to the document as they are made (the
 * badge behind the popover follows), except while an IME composition is in
 * flight — half a syllable is not text yet. Enter / Escape / a click outside
 * close it; emptying the field and closing removes the tag.
 */
export function openStatusPopover(view: EditorView, from: number): void {
  openPopover?.dispose();
  const initial = tagAt(view, from);
  if (!initial) return;
  const parsed = parseStatusAt(initial.raw)!;

  /** Where the tag is NOW: remote edits may have shifted it since the last write. */
  let raw = initial.raw;
  let at = initial.from;
  let label = parsed.label;
  let color: StatusColor = parsed.color;
  let composing = false;

  const locate = (): { from: number; to: number } | null => {
    const doc = view.state.doc;
    if (doc.sliceString(at, at + raw.length) === raw) return { from: at, to: at + raw.length };
    // Shifted by someone else's edit: look for the same text on its line, then anywhere.
    const line = doc.lineAt(Math.min(at, doc.length));
    const inLine = line.text.indexOf(raw);
    if (inLine >= 0) return { from: line.from + inLine, to: line.from + inLine + raw.length };
    const anywhere = doc.toString().indexOf(raw);
    return anywhere >= 0 ? { from: anywhere, to: anywhere + raw.length } : null;
  };

  const dom = document.createElement('div');
  dom.className = 'folio-status-pop';
  dom.setAttribute('role', 'dialog');
  dom.setAttribute('aria-label', t('statusTag.edit'));
  dom.style.position = 'fixed';
  dom.style.zIndex = '1200';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'folio-status-pop__input';
  input.value = label;
  input.maxLength = 60;
  input.spellcheck = false;
  input.setAttribute('aria-label', t('statusTag.text'));
  input.autocomplete = 'off';

  const swatches = document.createElement('div');
  swatches.className = 'folio-status-pop__swatches';
  swatches.setAttribute('role', 'radiogroup');
  swatches.setAttribute('aria-label', t('statusTag.color'));
  const buttons = new Map<StatusColor, HTMLButtonElement>();
  for (const name of STATUS_COLORS) {
    const button = document.createElement('button');
    button.type = 'button';
    // Only the colour class: the base `.folio-status` would turn the dot into a lozenge.
    button.className = `folio-status-pop__swatch folio-status--${name}`;
    button.title = t(`statusTag.colors.${name}`);
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-label', t(`statusTag.colors.${name}`));
    // Keeps the text field focused (and its IME state intact) through a click.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      color = name;
      markSelected();
      write();
    });
    buttons.set(name, button);
    swatches.appendChild(button);
  }
  const markSelected = () => {
    for (const [name, button] of buttons) {
      button.setAttribute('aria-checked', String(name === color));
      button.dataset.selected = name === color ? 'true' : 'false';
    }
  };
  markSelected();

  dom.append(input, swatches);

  /** Writes label + colour to the document; a transiently empty label waits. */
  const write = () => {
    const clean = cleanStatusLabel(label);
    if (clean === '') return;
    const range = locate();
    if (!range) return dispose();
    const next = serializeStatus(clean, color);
    if (next !== raw) {
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: next },
        userEvent: 'input.status',
      });
    }
    at = range.from;
    raw = next;
  };

  /** Closing with nothing typed takes the tag out — an empty badge is nothing to look at. */
  const removeIfEmpty = () => {
    if (cleanStatusLabel(label) !== '') return;
    const range = locate();
    if (range) view.dispatch({ changes: { from: range.from, to: range.to }, userEvent: 'delete.status' });
  };

  const reposition = () => {
    const rect = anchorRect();
    if (rect) place(dom, rect);
  };

  /** The badge on screen, else the text position — whichever the editor can tell us. */
  const anchorRect = (): { left: number; top: number; bottom: number } | null => {
    for (const badge of view.contentDOM.querySelectorAll<HTMLElement>('.cm-md-status')) {
      try {
        if (view.posAtDOM(badge) === at) return badge.getBoundingClientRect();
      } catch {
        /* a badge being torn down */
      }
    }
    const coords = view.coordsAtPos(at);
    return coords ? { left: coords.left, top: coords.top, bottom: coords.bottom } : null;
  };

  let disposed = false;
  function dispose(refocus = false): void {
    if (disposed) return;
    disposed = true;
    if (openPopover === handle) openPopover = null;
    document.removeEventListener('mousedown', onOutside, true);
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
    removeIfEmpty();
    dom.remove();
    if (refocus) {
      const range = locate();
      view.focus();
      if (range) view.dispatch({ selection: { anchor: range.to } });
    }
  }
  const handle = { dispose: () => dispose() };

  function onOutside(event: MouseEvent): void {
    if (!dom.contains(event.target as Node)) dispose();
  }

  input.addEventListener('compositionstart', () => {
    composing = true;
  });
  input.addEventListener('compositionend', () => {
    composing = false;
    label = input.value;
    write();
  });
  input.addEventListener('input', () => {
    label = input.value;
    if (!composing) write();
  });
  dom.addEventListener('keydown', (event) => {
    // 229 / isComposing: the Enter that confirms an IME candidate is not ours.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dispose(true);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      label = input.value;
      write();
      dispose(true);
    } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && event.target !== input) {
      event.preventDefault();
      const order = [...buttons.values()];
      const index = order.indexOf(event.target as HTMLButtonElement);
      const step = event.key === 'ArrowRight' ? 1 : -1;
      order[(index + step + order.length) % order.length]?.focus();
    }
  });

  document.addEventListener('mousedown', onOutside, true);
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);

  document.body.appendChild(dom);
  openPopover = handle;
  reposition();
  input.focus();
  input.select();
}

/* ------------------------------------------------------------ insertion -- */

/**
 * Wraps the selection in a status tag, or drops a `STATUS` tag at the caret,
 * and opens the popover on it. `from`/`to` default to the main selection; the
 * slash menu passes the range of its trigger text instead.
 *
 * Selected text becomes the label (line breaks collapsed — a badge is one
 * line). The caret ends up just after the tag, so closing the popover leaves
 * the author typing where they were.
 */
export function insertStatus(view: EditorView, from?: number, to?: number): boolean {
  if (!isEditable(view)) return false;
  const range = view.state.selection.main;
  const start = from ?? range.from;
  const end = to ?? range.to;
  const selected = cleanStatusLabel(view.state.doc.sliceString(start, end));
  const label = selected || t('statusTag.defaultText');
  const insert = serializeStatus(label, 'grey');
  view.dispatch({
    changes: { from: start, to: end, insert },
    selection: { anchor: start + insert.length },
    scrollIntoView: true,
    userEvent: 'input.status',
  });
  view.focus();
  openStatusPopover(view, start);
  return true;
}
