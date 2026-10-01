/**
 * Small inline/block widgets used by live mode.
 *
 * Invariant: no widget owns state. Every interaction that changes content goes
 * through `view.dispatch` as a plain text edit, which the Yjs binding turns into
 * a CRDT update — so widgets, source mode and remote peers can never disagree.
 */
import { EditorView, WidgetType } from '@codemirror/view';
import { revealSource } from './editor-services';
import { t } from './i18n';
import { createIcon, type IconName } from './icons';
import { taskToggleEdit, type CalloutType } from './live-decorations';
// Round 22: the callout heading is the SAME string reading mode prints, so it
// comes from the same dictionary — markdown/i18n's `alerts.*`, reached through
// that zone's own non-React `t()`. Importing it also registers the bundle, so
// this works even when a document is opened before anything in the reading
// pipeline has been imported. Read-only use of another zone's namespace: no
// second copy of the five words to drift out of sync.
import { t as markdownT } from '../markdown/i18n/register';

function onReveal(dom: HTMLElement, view: EditorView): void {
  dom.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    revealSource(view, dom);
  });
}

export class TaskCheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  eq(other: TaskCheckboxWidget): boolean {
    return other.checked === this.checked;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.className = 'cm-md-task';
    box.setAttribute('aria-label', t(this.checked ? 'task.done' : 'task.notDone'));
    box.addEventListener('mousedown', (event) => event.preventDefault());
    box.addEventListener('click', (event) => {
      event.preventDefault();
      const line = view.state.doc.lineAt(view.posAtDOM(box));
      const edit = taskToggleEdit(line.text, line.from);
      if (edit) view.dispatch({ changes: edit });
    });
    return box;
  }
}

const CALLOUT_ICONS: Record<CalloutType, IconName> = {
  note: 'info',
  tip: 'bulb',
  important: 'alert',
  warning: 'alert',
  caution: 'alert',
};

/** The visible name of a callout, in the interface language. */
export function calloutLabel(type: CalloutType): string {
  return markdownT(`alerts.${type}`);
}

/**
 * The heading row of a GFM callout, shown in place of the literal `[!NOTE]`.
 *
 * Round 22 translated it. Until then the name was the marker keyword verbatim
 * ("note", capitalised by CSS), which is the one thing a Ukrainian or Russian
 * reader never sees anywhere else in the page; reading mode learned the same
 * five words in the same round (markdown/alerts.ts writes them into
 * `data-alert-label`), and both views read them from the same bundle so a
 * callout is named identically on either side of the mode switch.
 *
 * `lang` is not used to look the string up — i18next already knows the current
 * language — it is here so `eq()` sees a language switch and CodeMirror throws
 * the rendered label away instead of keeping the old words on screen.
 */
export class CalloutLabelWidget extends WidgetType {
  constructor(
    readonly type: CalloutType,
    readonly lang: string,
  ) {
    super();
  }

  eq(other: CalloutLabelWidget): boolean {
    return other.type === this.type && other.lang === this.lang;
  }

  toDOM(): HTMLElement {
    const label = document.createElement('span');
    label.className = 'cm-md-callout__label';
    label.appendChild(createIcon(CALLOUT_ICONS[this.type]));
    const name = document.createElement('span');
    name.textContent = calloutLabel(this.type);
    label.appendChild(name);
    return label;
  }

  /** Passive label: let CodeMirror place the caret, which reveals the source. */
  ignoreEvent(): boolean {
    return false;
  }
}

export class ImageWidget extends WidgetType {
  constructor(
    readonly alt: string,
    readonly src: string,
    readonly resolved: string,
    readonly width?: string,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.resolved === this.resolved && other.alt === this.alt && other.width === this.width;
  }

  get estimatedHeight(): number {
    return 160;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-block cm-md-image';
    wrap.contentEditable = 'false';
    wrap.title = t('image.edit');

    const img = document.createElement('img');
    img.src = this.resolved;
    img.alt = this.alt;
    img.loading = 'lazy';
    if (this.width) img.style.width = this.width;
    img.addEventListener('error', () => {
      wrap.classList.add('cm-md-image--broken');
      img.replaceWith(brokenImage(this.src));
    });
    wrap.appendChild(img);

    if (this.alt.trim()) {
      const caption = document.createElement('figcaption');
      caption.className = 'cm-md-image__caption';
      caption.textContent = this.alt;
      wrap.appendChild(caption);
    }

    wrap.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
    });
    wrap.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openImageEditor(wrap, view, this.alt, this.src, this.width);
    });
    return wrap;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function escapeMarkdownAlt(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/]/g, '\\]');
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function imageSource(alt: string, src: string, width?: string): string {
  if (!width) return `![${escapeMarkdownAlt(alt)}](${src})`;
  return `<img src="${escapeHtmlAttribute(src)}" alt="${escapeHtmlAttribute(alt)}" width="${width}">`;
}

function openImageEditor(
  anchor: HTMLElement,
  view: EditorView,
  alt: string,
  src: string,
  width?: string,
): void {
  document.querySelector('.folio-image-editor')?.remove();
  const panel = document.createElement('div');
  panel.className = 'folio-image-editor';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('image.edit'));

  const descriptionLabel = document.createElement('label');
  descriptionLabel.textContent = t('image.description');
  const description = document.createElement('input');
  description.type = 'text';
  description.value = alt;
  description.placeholder = t('image.descriptionPlaceholder');
  descriptionLabel.appendChild(description);

  const sizeLabel = document.createElement('label');
  sizeLabel.textContent = t('image.size');
  const size = document.createElement('select');
  for (const [value, label] of [
    ['', t('image.sizeAuto')],
    ['25%', '25%'],
    ['50%', '50%'],
    ['75%', '75%'],
    ['100%', '100%'],
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.selected = value === (width ?? '');
    size.appendChild(option);
  }
  sizeLabel.appendChild(size);

  const actions = document.createElement('div');
  actions.className = 'folio-image-editor__actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = t('image.cancel');
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'folio-image-editor__save';
  save.textContent = t('image.save');
  actions.append(cancel, save);
  panel.append(descriptionLabel, sizeLabel, actions);

  const close = () => panel.remove();
  cancel.addEventListener('click', close);
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  save.addEventListener('click', () => {
    try {
      const line = view.state.doc.lineAt(view.posAtDOM(anchor));
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: imageSource(description.value, src, size.value || undefined) },
      });
    } finally {
      close();
    }
  });

  document.body.appendChild(panel);
  const rect = anchor.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  panel.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - panelRect.width - 12))}px`;
  panel.style.top = `${Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - panelRect.height - 12))}px`;
  description.focus({ preventScroll: true });
  description.select();
}

function brokenImage(src: string): HTMLElement {
  const note = document.createElement('span');
  note.className = 'cm-md-image__missing';
  note.textContent = t('image.notFound', { src });
  return note;
}
