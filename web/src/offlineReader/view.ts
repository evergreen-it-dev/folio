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

export function renderReader(root: HTMLElement, content: SavedDocumentSummary[] | SavedDocument | undefined, labels: Labels, lang: string): void {
  const header = element('header', labels.offline);
  const retry = element('button', labels.retry);
  retry.onclick = () => location.reload();
  header.append(retry);
  root.replaceChildren(header);
  if (Array.isArray(content)) {
    root.append(element('h1', labels.library));
    if (!content.length) root.append(element('p', labels.empty));
    else {
      const list = document.createElement('ul');
      for (const doc of content) {
        const row = document.createElement('li');
        row.append(link(doc.title, documentPath(doc)), element('small', doc.space));
        list.append(row);
      }
      root.append(list);
    }
    return;
  }

  root.append(link(labels.library, '/'));
  const doc = content;
  if (!doc) {
    root.append(element('p', labels.missing));
    return;
  }
  const savedAt = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(doc.savedAt);
  root.append(element('h1', doc.title), element('small', labels.saved + ' ' + savedAt));
  const article = document.createElement('article');
  article.innerHTML = String(markdown.processSync(stripFrontmatter(doc.markdown)));
  root.append(article);
}
