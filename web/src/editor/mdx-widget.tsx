/**
 * An MDX construct of an `.mdx` page folded into one compact block: the `import` /
 * `export` lines at the top of the page, or one JSX component (`<Aside>`, `<Tabs>`,
 * `<Card />`). Folio never runs MDX — the site generator does — so the block shows
 * what the page will hold (a component's Markdown body in a labelled box, the
 * import lines as code) and leaves the characters of the file alone: a click, or a
 * caret arriving by arrow key, drops the block back into its source, which is then
 * edited as ordinary text. Source mode never folds anything.
 *
 * The JSX preview goes through the same `Markdown` component the Reading view
 * uses (markdown/mdx.ts turns the component into a box), so what the editor shows
 * and what Reading shows cannot drift apart.
 */
import { MemoryRouter } from 'react-router';
import { EditorView, WidgetType } from '@codemirror/view';
import { Markdown } from '../markdown';
import { revealSource } from './editor-services';
import { t } from './i18n';
import { mountReact, unmountReact } from './react-host';

export class MdxBlockWidget extends WidgetType {
  constructor(
    readonly kind: 'esm' | 'jsx',
    readonly source: string,
    readonly space: string,
    readonly pagePath: string,
    readonly lang: string,
  ) {
    super();
  }

  eq(other: MdxBlockWidget): boolean {
    return (
      other.kind === this.kind &&
      other.source === this.source &&
      other.space === this.space &&
      other.pagePath === this.pagePath &&
      other.lang === this.lang
    );
  }

  get estimatedHeight(): number {
    return this.kind === 'esm' ? 40 : 100;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = `cm-md-block cm-md-mdxblock cm-md-mdxblock--${this.kind}`;
    wrap.contentEditable = 'false';
    wrap.title = t(this.kind === 'esm' ? 'mdx.titleEsm' : 'mdx.titleJsx');

    const host = document.createElement('div');
    host.className = 'cm-md-mdxblock__host';
    wrap.appendChild(host);
    if (this.kind === 'esm') {
      const code = document.createElement('pre');
      const inner = document.createElement('code');
      inner.textContent = this.source;
      code.appendChild(inner);
      host.appendChild(code);
    } else {
      // The same throwaway router as the HTML block's: links inside only ever reveal the source.
      mountReact(
        host,
        <MemoryRouter>
          <Markdown markdown={this.source} space={this.space} pagePath={this.pagePath} />
        </MemoryRouter>,
      );
    }

    // A long component (Tabs with a table in every tab) stays one compact block: the preview is capped in height
    // (editor.css) and fades out where it is cut. The full text is a click away.
    if (this.kind === 'jsx' && typeof ResizeObserver !== 'undefined') {
      const clip = () => wrap.classList.toggle('cm-md-mdxblock--clipped', host.scrollHeight > host.clientHeight + 1);
      const observer = new ResizeObserver(clip);
      observer.observe(host);
      for (const child of Array.from(host.children)) observer.observe(child);
      this.observers.set(wrap, observer);
    }

    const badge = document.createElement('span');
    badge.className = 'cm-md-mdxblock__badge';
    badge.textContent = t(this.kind === 'esm' ? 'mdx.badgeEsm' : 'mdx.badgeJsx');
    wrap.appendChild(badge);

    wrap.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      // A caret landing inside the widget would make the decoration give way by itself; do it on purpose, once.
      event.preventDefault();
      revealSource(view, wrap);
    });
    return wrap;
  }

  private readonly observers = new WeakMap<HTMLElement, ResizeObserver>();

  destroy(dom: HTMLElement): void {
    this.observers.get(dom)?.disconnect();
    const host = dom.querySelector<HTMLElement>('.cm-md-mdxblock__host');
    if (host) unmountReact(host);
  }

  ignoreEvent(): boolean {
    return false;
  }
}
