/**
 * Hover preview for internal `.md` links, in both live and source mode.
 *
 * Resolution takes two hops (`/api/resolve` then `/api/pages/:id`), so results
 * are cached for the session — a hovered link is very often hovered again.
 * Nothing here may throw into CodeMirror: every failure becomes a "not found"
 * card instead.
 */
import { MemoryRouter } from 'react-router';
import { syntaxTree } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView, hoverTooltip, type Tooltip } from '@codemirror/view';
import type { PageDoc, PageMeta } from '@shared/contracts';
import { Markdown } from '../markdown';
import { t } from './i18n';
import { pageContextFacet } from './live-preview';
import { dirname, normalizeRelative } from './paths';
import { mountReact, unmountReact } from './react-host';

const HOVER_DELAY_MS = 400;
const PREVIEW_LINES = 15;
const CACHE_LIMIT = 50;

export interface LinkPreview {
  title: string;
  markdown: string;
  path: string;
}

/* ------------------------------------------------------------------ pure -- */

const EXTERNAL = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/|\/)/;

/**
 * Space-relative path of an internal markdown link, or null when the link is
 * external, absolute, a bare anchor, or simply not a page.
 */
export function linkTargetPath(url: string, pagePath: string): string | null {
  const raw = url.trim().replace(/^<(.*)>$/, '$1');
  if (!raw || raw.startsWith('#')) return null;
  if (EXTERNAL.test(raw)) return null;

  const withoutHash = raw.split('#')[0].split('?')[0];
  if (!withoutHash.toLowerCase().endsWith('.md')) return null;

  const dir = dirname(pagePath);
  const joined = normalizeRelative(dir ? `${dir}/${withoutHash}` : withoutHash);
  return joined || null;
}

/** Drop the leading H1: the card shows the title itself, right above the body. */
export function stripLeadingHeading(markdown: string): string {
  return markdown.replace(/^\s*#[ \t]+[^\n]*\n?/, '');
}

export function firstLines(markdown: string, count = PREVIEW_LINES): string {
  const lines = markdown.split('\n');
  if (lines.length <= count) return markdown;
  return `${lines.slice(0, count).join('\n')}\n`;
}

/**
 * Whether this device can hover at all. A touch screen synthesises a hover on
 * tap, so the card would open over the very link the reader just tapped and sit
 * there until the next tap elsewhere — `(hover: none)` is the standard signal
 * for that pointer. Checked per hover rather than once at setup, so plugging a
 * mouse into a tablet brings previews back without reloading the editor.
 */
export function hoverPreviewsSupported(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return !window.matchMedia('(hover: none)').matches;
}

/** Insertion-ordered cache that drops its oldest entry past `limit`. */
export class LruCache<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly limit: number) {}

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    // Re-insert so recently used keys move to the young end.
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  clear(): void {
    this.entries.clear();
  }
}

/* --------------------------------------------------------------- loading -- */

const previews = new LruCache<Promise<LinkPreview | null>>(CACHE_LIMIT);

export function clearPreviewCache(): void {
  previews.clear();
}

async function load(space: string, path: string): Promise<LinkPreview | null> {
  const query = `space=${encodeURIComponent(space)}&path=${encodeURIComponent(path)}`;
  const resolved = await fetch(`/api/resolve?${query}`, { credentials: 'same-origin' });
  if (!resolved.ok) return null;
  const meta = (await resolved.json()) as PageMeta;
  if (!meta?.id) return null;

  const page = await fetch(`/api/pages/${encodeURIComponent(meta.id)}`, {
    credentials: 'same-origin',
  });
  if (!page.ok) return null;
  const doc = (await page.json()) as PageDoc;

  return {
    title: meta.title || path,
    path: meta.path ?? path,
    markdown: firstLines(stripLeadingHeading(doc.markdown ?? '')),
  };
}

function preview(space: string, path: string): Promise<LinkPreview | null> {
  const key = `${space}\u0000${path}`;
  const cached = previews.get(key);
  if (cached) return cached;
  // A rejected request must not poison the entry forever, so failures memoise
  // as null and are retried after eviction.
  const pending = load(space, path).catch(() => null);
  previews.set(key, pending);
  return pending;
}

/* --------------------------------------------------------------- tooltip -- */

interface LinkAtPos {
  url: string;
  from: number;
  to: number;
}

/**
 * The markdown Link node covering `pos`, with its URL. Both sides are tried
 * because a caret sitting exactly on a link boundary resolves outwards.
 */
function linkAt(view: EditorView, pos: number): LinkAtPos | null {
  const tree = syntaxTree(view.state);
  for (const side of [1, -1] as const) {
    for (let node = tree.resolveInner(pos, side); node; node = node.parent!) {
      if (node.name === 'Link') {
        const url = node.getChild('URL');
        if (!url) return null;
        return { url: view.state.sliceDoc(url.from, url.to), from: node.from, to: node.to };
      }
      if (!node.parent) break;
    }
  }
  return null;
}

function card(modifier: string): HTMLElement {
  const dom = document.createElement('div');
  dom.className = `cm-folio-preview ${modifier}`;
  return dom;
}

function fill(dom: HTMLElement, data: LinkPreview, space: string): void {
  dom.classList.remove('cm-folio-preview--loading');
  dom.replaceChildren();

  const title = document.createElement('div');
  title.className = 'cm-folio-preview__title';
  title.textContent = data.title;
  dom.appendChild(title);

  const body = document.createElement('div');
  body.className = 'cm-folio-preview__body';
  dom.appendChild(body);

  // Markdown uses react-router hooks and the tooltip lives outside the app's
  // router, so give it a throwaway one.
  mountReact(
    body,
    <MemoryRouter>
      <Markdown markdown={data.markdown} space={space} pagePath={data.path} />
    </MemoryRouter>,
  );
}

function previewTooltip(space: string, target: string, from: number, to: number): Tooltip {
  return {
    pos: from,
    end: to,
    above: true,
    create() {
      const dom = card('cm-folio-preview--loading');
      dom.textContent = t('preview.loading');

      void preview(space, target).then((data) => {
        if (!dom.isConnected) return;
        if (data) fill(dom, data, space);
        else {
          dom.className = 'cm-folio-preview cm-folio-preview--missing';
          dom.textContent = t('preview.missing');
        }
      });

      return {
        dom,
        destroy() {
          const body = dom.querySelector<HTMLElement>('.cm-folio-preview__body');
          if (body) unmountReact(body);
        },
      };
    },
  };
}

/** Hover preview over internal relative `.md` links. */
export function linkPreview(): Extension {
  return hoverTooltip(
    (view, pos) => {
      try {
        if (!hoverPreviewsSupported()) return null;
        const link = linkAt(view, pos);
        if (!link) return null;
        const { space, pagePath } = view.state.facet(pageContextFacet);
        if (!space) return null;
        const target = linkTargetPath(link.url, pagePath);
        if (!target) return null;
        // Anchored to the link itself, so the card follows the link and not the
        // whole line when the pointer moves on.
        return previewTooltip(space, target, link.from, link.to);
      } catch {
        return null; // a preview is never worth breaking the editor over
      }
    },
    { hoverTime: HOVER_DELAY_MS, hideOnChange: true },
  );
}
