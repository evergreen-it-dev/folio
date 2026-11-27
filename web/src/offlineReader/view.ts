import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { stripFrontmatter } from '../markdown/frontmatter';
import type { SavedDocument, SavedDocumentSummary } from '../app/offline/savedDocuments';
import type en from './i18n/en.json';

export type Labels = typeof en;

// A downloaded snapshot is self-contained. Preserve structure and image descriptions without
// loading remote media, running embeds, or interpreting raw HTML from a private document.
const markdown = unified().use(remarkParse).use(remarkGfm).use(remarkRehype, {
  handlers: { image: (_state, node) => ({ type: 'text', value: node.alt ?? '' }) },
}).use(rehypeSanitize, {
  tagNames: ['p', 'br', 'hr', 'em', 'strong', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'sup', 'sub'],
  attributes: { ol: ['start'] },
}).use(rehypeStringify);

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function link(text: string, href: string): HTMLAnchorElement {
  const anchor = element('a', text);
  anchor.href = href;
  return anchor;
}

function documentPath(doc: SavedDocumentSummary): string {
  return '/s/' + encodeURIComponent(doc.space) + '/p/' + encodeURIComponent(doc.id);
}

export function parseDocumentPath(path: string): { space: string; id: string } | undefined {
  const match = /^\/s\/([^/]+)\/p\/([^/]+)$/.exec(path);
  if (!match) return undefined;
  try {
    return { space: decodeURIComponent(match[1]), id: decodeURIComponent(match[2]) };
  } catch {
    return undefined;
  }
}

const SVG = 'http://www.w3.org/2000/svg';

// The Folio mark (public/favicon.svg), drawn inline: the reader can only use what the worker precached.
function mark(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '4 1.5 40 40');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const arms: [string, string][] = [
    ['M18.69 14.7 L20.5 11.56 Q24 5.5 27.5 11.56 L29.31 14.7', '#36C5F0'],
    ['M34.71 24.05 L36.52 27.19 Q40.02 33.25 33.02 33.25 L29.4 33.25', '#E01E5A'],
    ['M18.6 33.25 L14.98 33.25 Q7.98 33.25 11.48 27.19 L13.29 24.05', '#ECB22E'],
    ['M24 17.8 L24 24 L29.37 27.1 M24 24 L18.63 27.1', '#2EB67D'],
  ];
  arms.forEach(([d, color], index) => {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', index === 3 ? '4.9' : '6.4');
    svg.append(path);
  });
  return svg;
}

function topBar(labels: Labels): HTMLElement {
  const header = document.createElement('header');
  header.className = 'bar';
  const brand = document.createElement('a');
  brand.className = 'brand';
  brand.href = '/';
  brand.append(mark(), element('span', 'Folio'));
  const pill = element('span', labels.pill);
  pill.className = 'pill';
  pill.title = labels.offline;
  const retry = element('button', labels.retry);
  retry.type = 'button';
  retry.onclick = () => location.reload();
  header.append(brand, pill, retry);
  return header;
}

export function renderReader(root: HTMLElement, content: SavedDocumentSummary[] | SavedDocument | undefined, labels: Labels, lang: string): void {
  root.replaceChildren(topBar(labels));
  const page = document.createElement('div');
  page.className = 'page';
  root.append(page);
  if (Array.isArray(content)) {
    const title = element('h1', labels.library);
    const hint = element('p', labels.hint);
    hint.className = 'hint';
    page.append(title, hint);
    if (!content.length) {
      const empty = element('p', labels.empty);
      empty.className = 'empty';
      page.append(empty);
    } else {
      const list = document.createElement('ul');
      list.className = 'docs';
      for (const doc of content) {
        const row = document.createElement('li');
        const anchor = link(doc.title, documentPath(doc));
        anchor.append(element('small', doc.space));
        row.append(anchor);
        list.append(row);
      }
      page.append(list);
    }
    return;
  }

  const back = link(labels.library, '/');
  back.className = 'back';
  page.append(back);
  const doc = content;
  if (!doc) {
    const missing = element('p', labels.missing);
    missing.className = 'empty';
    page.append(missing);
    return;
  }
  const savedAt = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(doc.savedAt);
  const note = element('small', labels.saved + ' ' + savedAt);
  note.className = 'meta';
  const article = document.createElement('article');
  article.innerHTML = String(markdown.processSync(stripFrontmatter(doc.markdown)));
  // Most Folio documents open with their own `# Title`, which the app shows as the page title;
  // printing doc.title above it would show the title twice.
  const leading = article.firstElementChild;
  if (leading?.tagName === 'H1') {
    leading.after(note);
    page.append(article);
  } else {
    page.append(element('h1', doc.title), note, article);
  }
}
