/**
 * Pasting a markdown-shaped *document* offers a choice instead of silently
 * inserting: drop it into the body, or file it away as a new child page and
 * leave a link to it instead.
 *
 * Registered ahead of `assetUploads()` in the extension list (index.tsx) —
 * `EditorView.domEventHandlers` tries `paste` handlers in extension order and
 * stops at the first one to return `true`, so this has to see the clipboard
 * before assetUploads' own text/html branch (or CodeMirror's plain-text
 * fallback) commits the paste.
 *
 * Deliberately narrower than "looks like markdown": a single bold word or a
 * one-line link pasted mid-sentence looks like markdown too (html-paste.ts's
 * `looksLikeMarkdown`) but is not a document anyone would want spun off into
 * its own page — hence the extra "document-shaped" gate below (a heading, or
 * at least a handful of non-empty lines).
 */
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, showTooltip, type Tooltip, type TooltipView } from '@codemirror/view';
import { editorServicesFacet } from './editor-services';
import { htmlHasRichFormatting, looksLikeMarkdown } from './html-paste';
import { t } from './i18n';
import { pageContextFacet } from './live-preview';
import { formatLinkTarget, relativePath } from './paths';
import { showToast } from './toast';

const MIN_DOCUMENT_LINES = 8;
const HEADING = /^#{1,6}\s/m;

/** Document-shaped: a heading anywhere, or enough non-empty lines to be a document. */
export function looksLikeDocument(text: string): boolean {
  if (HEADING.test(text)) return true;
  const nonEmpty = text.split('\n').filter((line) => line.trim() !== '').length;
  return nonEmpty >= MIN_DOCUMENT_LINES;
}

/** First H1's text, else the first non-empty line (if short enough), else a generic fallback. */
export function deriveTitle(text: string): string {
  const heading = /^#\s+(\S.*)$/m.exec(text);
  if (heading) return heading[1].trim();
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line !== '');
  if (firstLine && firstLine.length <= 80) return firstLine;
  return t('pasteChooser.untitled');
}

interface PendingPaste {
  from: number;
  to: number;
  text: string;
  lines: number;
  /**
   * A document edit landed after the chooser opened (e.g. a collaborator's),
   * so `from`/`to` may no longer mean what they did — the resolve step below
   * then targets the *live* selection instead of these saved positions.
   */
  stale: boolean;
}

const openChooser = StateEffect.define<PendingPaste>();
const closeChooser = StateEffect.define<null>();

const chooserField = StateField.define<PendingPaste | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(openChooser)) return effect.value;
      if (effect.is(closeChooser)) return null;
    }
    if (value && tr.docChanged) return { ...value, stale: true };
    return value;
  },
  // A tooltip card right at the paste position, not a bar at the bottom of the
  // editor — the owner did not even notice that one on a tall page.
  provide: (field) =>
    showTooltip.from(field, (pending): Tooltip | null =>
      pending
        ? {
            pos: pending.from,
            above: false,
            strictSide: false,
            arrow: true,
            create: (view) => chooserPanel(view, pending),
          }
        : null,
    ),
});

/** Where an action should land: the saved paste range, or the live selection once that range has gone stale. */
function targetRange(view: EditorView, pending: PendingPaste): { from: number; to: number } {
  if (!pending.stale) return { from: pending.from, to: pending.to };
  const { from, to } = view.state.selection.main;
  return { from, to };
}

function insertIntoBody(view: EditorView, pending: PendingPaste): void {
  const { from, to } = targetRange(view, pending);
  view.dispatch({
    changes: { from, to, insert: pending.text },
    selection: { anchor: from + pending.text.length },
    userEvent: 'input.paste',
    scrollIntoView: true,
    effects: closeChooser.of(null),
  });
}

async function insertAsChildLink(view: EditorView, pending: PendingPaste): Promise<void> {
  const services = view.state.facet(editorServicesFacet);
  const ctx = view.state.facet(pageContextFacet);
  const title = deriveTitle(pending.text);

  let created: Awaited<ReturnType<typeof services.createChildPage>> = null;
  try {
    created = await services.createChildPage({ markdown: pending.text, title });
  } catch {
    created = null;
  }

  if (!view.dom.isConnected) return; // page switched away while the request was in flight
  if (!created) {
    showToast(view, t('pasteChooser.failed'));
    view.dispatch({ effects: closeChooser.of(null) });
    return;
  }

  const rel = relativePath(ctx.pagePath, created.path);
  const link = `[${created.title}](${formatLinkTarget(rel)})`;
  const { from, to } = targetRange(view, pending);
  view.dispatch({
    changes: { from, to, insert: link },
    selection: { anchor: from + link.length },
    userEvent: 'input.paste',
    scrollIntoView: true,
    effects: closeChooser.of(null),
  });
}

function button(label: string, extraClass: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `cm-folio-paste-chooser__btn${extraClass}`;
  el.textContent = label;
  el.addEventListener('click', (event) => {
    event.preventDefault();
    onClick();
  });
  return el;
}

function chooserPanel(view: EditorView, initial: PendingPaste): TooltipView {
  const dom = document.createElement('div');
  dom.className = 'cm-folio-paste-chooser';
  dom.setAttribute('role', 'dialog');
  dom.setAttribute('aria-label', t('pasteChooser.title'));
  // Keep the editor's selection (and focus) exactly where the paste left it.
  dom.addEventListener('mousedown', (event) => event.preventDefault());

  const text = document.createElement('span');
  text.className = 'cm-folio-paste-chooser__text';

  const actions = document.createElement('div');
  actions.className = 'cm-folio-paste-chooser__actions';

  const currentPending = (): PendingPaste | null => view.state.field(chooserField, false) ?? null;

  const bodyBtn = button(t('pasteChooser.body'), ' cm-folio-paste-chooser__btn--primary', () => {
    const pending = currentPending();
    if (pending) insertIntoBody(view, pending);
  });
  const linkBtn = button(t('pasteChooser.link'), '', () => {
    const pending = currentPending();
    if (pending) void insertAsChildLink(view, pending);
  });
  const cancelBtn = button(t('pasteChooser.cancel'), ' cm-folio-paste-chooser__btn--ghost', () => {
    view.dispatch({ effects: closeChooser.of(null) });
  });

  actions.append(bodyBtn, linkBtn, cancelBtn);
  dom.append(text, actions);

  const render = (pending: PendingPaste): void => {
    text.textContent = t('pasteChooser.lines', { count: pending.lines });
  };
  render(initial);

  return {
    dom,
    update(update) {
      const pending = update.state.field(chooserField, false);
      if (pending) render(pending);
    },
  };
}

function hasFiles(transfer: DataTransfer | null | undefined): boolean {
  return !!transfer && transfer.files.length > 0;
}

/** Paste + Esc handling for the chooser; must sit before `assetUploads()` in the extension list. */
export function markdownPasteChooser(): Extension {
  return [
    chooserField,
    EditorView.domEventHandlers({
      paste(event, view) {
        if (hasFiles(event.clipboardData)) return false;
        const plain = event.clipboardData?.getData('text/plain') ?? '';
        if (!plain.trim()) return false;
        if (!looksLikeMarkdown(plain)) return false;
        if (!looksLikeDocument(plain)) return false;
        // A rich HTML twin (Google Docs, Confluence, a web page) means this
        // paste should go through the normal html-paste conversion instead of
        // being offered as a plain-text document — the chooser is for
        // markdown-shaped text with no better source to convert from.
        const html = event.clipboardData?.getData('text/html') ?? '';
        if (html && htmlHasRichFormatting(html)) return false;

        event.preventDefault();
        const { from, to } = view.state.selection.main;
        view.dispatch({
          effects: openChooser.of({ from, to, text: plain, lines: plain.split('\n').length, stale: false }),
        });
        return true;
      },
      keydown(event, view) {
        if (event.key !== 'Escape') return false;
        if (!view.state.field(chooserField, false)) return false;
        event.preventDefault();
        view.dispatch({ effects: closeChooser.of(null) });
        return true;
      },
    }),
  ];
}
