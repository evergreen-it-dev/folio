/**
 * Live-mode widget for a `<details>` disclosure whose body is real markdown and
 * therefore reaches the parser as three separate blocks (opening HTML fragment,
 * body, closing fragment — see `collectDetailsBlocks`). One replacement covers
 * all three, so the `/expand` template looks like a collapsible block the moment
 * it is inserted instead of showing its own tags.
 *
 * The body goes through the same `Markdown` component the reading view uses, so
 * lists, tables and `::pagetree` inside a disclosure render exactly as they will
 * once the page is read.
 *
 * Read-only, like every other block preview: the chevron opens and closes the
 * block, everything else puts the caret into the markdown source.
 */
import { MemoryRouter } from 'react-router';
import { EditorView, WidgetType } from '@codemirror/view';
import { Markdown } from '../markdown';
import { revealSource } from './editor-services';
import { t } from './i18n';
import { mountReact, unmountReact } from './react-host';

const OPEN_CLASS = 'cm-md-details--open';

export class DetailsWidget extends WidgetType {
  constructor(
    readonly summary: string,
    readonly body: string,
    /** From `<details open>`; afterwards the open state lives in the DOM. */
    readonly startOpen: boolean,
    readonly space: string,
    readonly pagePath: string,
    readonly lang: string,
  ) {
    super();
  }

  eq(other: DetailsWidget): boolean {
    return (
      other.summary === this.summary &&
      other.body === this.body &&
      other.startOpen === this.startOpen &&
      other.space === this.space &&
      other.pagePath === this.pagePath &&
      other.lang === this.lang
    );
  }

  get estimatedHeight(): number {
    return this.startOpen ? 140 : 44;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-block cm-md-details';
    wrap.contentEditable = 'false';
    wrap.title = t('details.editHint');
    if (this.startOpen) wrap.classList.add(OPEN_CLASS);

    const head = document.createElement('div');
    head.className = 'cm-md-details__summary';

    const chevron = document.createElement('button');
    chevron.type = 'button';
    chevron.className = 'cm-md-details__chevron';
    chevron.title = t('details.toggle');
    chevron.setAttribute('aria-label', t('details.toggle'));
    chevron.setAttribute('aria-expanded', String(this.startOpen));

    const label = document.createElement('span');
    label.className = 'cm-md-details__label';
    label.textContent = this.summary || t('details.untitled');

    head.append(chevron, label);
    wrap.appendChild(head);

    const host = document.createElement('div');
    host.className = 'cm-md-details__host';
    wrap.appendChild(host);
    this.renderBody(host);

    // Open/close is the one interaction that must NOT drop into the source, so
    // it lives on a button of its own and stops the reveal handler below.
    chevron.addEventListener('mousedown', (event) => event.preventDefault());
    chevron.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const open = wrap.classList.toggle(OPEN_CLASS);
      chevron.setAttribute('aria-expanded', String(open));
      // The block just changed height; CodeMirror has to re-measure or the
      // lines below it keep the old offsets.
      view.requestMeasure();
    });

    wrap.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      // `preventDefault` either way: a caret landing inside the widget would
      // make the decoration give way to the source, which a chevron click
      // must not do.
      event.preventDefault();
      if (event.target instanceof Element && event.target.closest('.cm-md-details__chevron')) return;
      revealSource(view, wrap);
    });

    return wrap;
  }

  /**
   * Called instead of a rebuild when only the summary or the body changed: the
   * DOM node survives, and with it whether the reader had this block open.
   */
  updateDOM(dom: HTMLElement): boolean {
    const label = dom.querySelector<HTMLElement>('.cm-md-details__label');
    const host = dom.querySelector<HTMLElement>('.cm-md-details__host');
    if (!label || !host) return false;
    label.textContent = this.summary || t('details.untitled');
    this.renderBody(host);
    return true;
  }

  destroy(dom: HTMLElement): void {
    const host = dom.querySelector<HTMLElement>('.cm-md-details__host');
    if (host) unmountReact(host);
  }

  /**
   * One React root either way — an empty body renders a placeholder *through*
   * it rather than unmounting, because `unmountReact` is deferred and would
   * come back later to tear down nodes it no longer owns.
   *
   * `Markdown` uses react-router hooks and this subtree lives outside the app's
   * router; clicks reveal the source anyway, so the throwaway router is never
   * actually navigated. No `pageId`: like the HTML-block preview, it would drag
   * the backlinks section into a disclosure body.
   */
  private renderBody(host: HTMLElement): void {
    mountReact(
      host,
      this.body.trim() === '' ? (
        <p className="cm-md-details__empty">{t('details.empty')}</p>
      ) : (
        <MemoryRouter>
          <Markdown markdown={this.body} space={this.space} pagePath={this.pagePath} />
        </MemoryRouter>
      ),
    );
  }
}
