/**
 * Live-mode widget for the `::pagetree{depth=N}` directive: renders the current
 * page's child-page tree in place of the directive source.
 *
 * The tree itself is rendered by the shared component in `../markdown` (SHELL
 * owns it, and reading mode renders the same thing), which fetches
 * `GET /api/pages/:id/subtree?depth=N` on its own. This widget only maps the
 * directive to that component and reveals the source on interaction.
 */
import { MemoryRouter } from 'react-router';
import { EditorView, WidgetType } from '@codemirror/view';
import { revealSource } from './editor-services';
import { t } from './i18n';
import { PageTree } from './pagetree-render';
import { mountReact, unmountReact } from './react-host';

export class PagetreeWidget extends WidgetType {
  constructor(
    readonly pageId: string,
    readonly depth: number,
    readonly lang: string,
  ) {
    super();
  }

  eq(other: PagetreeWidget): boolean {
    return (
      other.pageId === this.pageId && other.depth === this.depth && other.lang === this.lang
    );
  }

  get estimatedHeight(): number {
    return 120;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-block cm-md-pagetree';
    wrap.contentEditable = 'false';
    wrap.title = t('pagetree.editHint');

    const host = document.createElement('div');
    host.className = 'cm-md-pagetree__host';
    wrap.appendChild(host);
    // PageTree may use react-router hooks; this subtree lives outside the app's
    // router, and clicks reveal the source, so the throwaway router is inert.
    mountReact(
      host,
      <MemoryRouter>
        <PageTree pageId={this.pageId} depth={this.depth} />
      </MemoryRouter>,
    );

    const badge = document.createElement('span');
    badge.className = 'cm-md-pagetree__badge';
    badge.textContent = t('pagetree.badge');
    wrap.appendChild(badge);

    wrap.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest('a')) return; // let links work
      event.preventDefault();
      revealSource(view, wrap);
    });

    return wrap;
  }

  destroy(dom: HTMLElement): void {
    const host = dom.querySelector<HTMLElement>('.cm-md-pagetree__host');
    if (host) unmountReact(host);
  }
}
