/**
 * Rendered view of a raw HTML block (imported Confluence tables, `<details>`,
 * …). The markup goes through the same `Markdown` component the reading view
 * uses, so rehype-raw + sanitize decide what survives — the editor never
 * renders untrusted HTML on its own terms.
 *
 * Read-only by design: the widget shows the result, editing happens in the
 * markdown source, which a click or a caret entering the range reveals.
 */
import { MemoryRouter } from 'react-router';
import { EditorView, WidgetType } from '@codemirror/view';
import { Markdown } from '../markdown';
import { revealSource } from './editor-services';
import { t } from './i18n';
import { mountReact, unmountReact } from './react-host';

/** The `<summary>` an event landed in, if any. */
function summaryAt(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest('summary') : null;
}

export class HtmlBlockWidget extends WidgetType {
  constructor(
    readonly html: string,
    readonly space: string,
    readonly pagePath: string,
    readonly lang: string,
  ) {
    super();
  }

  eq(other: HtmlBlockWidget): boolean {
    return (
      other.html === this.html &&
      other.space === this.space &&
      other.pagePath === this.pagePath &&
      other.lang === this.lang
    );
  }

  get estimatedHeight(): number {
    return 140;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-block cm-md-htmlblock';
    wrap.contentEditable = 'false';
    wrap.title = t('html.title');

    const host = document.createElement('div');
    host.className = 'cm-md-htmlblock__host';
    wrap.appendChild(host);
    // Markdown uses react-router hooks and this subtree lives outside the app's
    // router; clicks reveal the source anyway, so the throwaway router is never
    // actually navigated.
    mountReact(
      host,
      <MemoryRouter>
        <Markdown markdown={this.html} space={this.space} pagePath={this.pagePath} />
      </MemoryRouter>,
    );

    const badge = document.createElement('span');
    badge.className = 'cm-md-htmlblock__badge';
    badge.textContent = 'HTML';
    wrap.appendChild(badge);

    // A `<details>` summary is the one interactive part of an otherwise
    // read-only preview: clicking it must open the block, not jump into the
    // markdown source. Everything else in the widget still reveals the source.
    wrap.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      // `preventDefault` either way: a caret landing inside the widget would
      // make the decoration give way to the markdown source, which is exactly
      // what a click on the summary must not do.
      event.preventDefault();
      if (summaryAt(event.target)) return;
      revealSource(view, wrap);
    });

    wrap.addEventListener('click', (event) => {
      const summary = summaryAt(event.target);
      if (!summary) return;
      const details = summary.closest('details');
      if (!details) return;
      // Toggling by hand rather than letting the disclosure do it: the widget
      // sits inside a `contenteditable` surface, where the browser's own
      // activation behaviour is not something to rely on. `preventDefault`
      // keeps a native toggle from undoing this one.
      event.preventDefault();
      details.open = !details.open;
    });

    return wrap;
  }

  destroy(dom: HTMLElement): void {
    const host = dom.querySelector<HTMLElement>('.cm-md-htmlblock__host');
    if (host) unmountReact(host);
  }
}
