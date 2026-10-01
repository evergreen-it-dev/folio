/**
 * Rich clipboard HTML -> editable Folio markdown.
 *
 * Google Docs copies a complete document as `text/html`, with its formatting
 * expressed mostly as inline CSS and every embedded image as a base64 data
 * URL. CodeMirror intentionally falls back to `text/plain`, so without this
 * bridge the paste looks successful while silently losing both structure and
 * images.
 *
 * The converter is deliberately client-side: the clipboard never needs to be
 * sent to a conversion endpoint. Data images are removed before Turndown sees
 * the HTML, returned as Files, and then travel through the editor's existing
 * authenticated asset upload pipeline.
 */
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import {
  cellKey,
  formatTableAttrLine,
  type BgToken,
  type TableAttrs,
} from '../markdown/tableSyntax';

export interface ClipboardHtmlImage {
  file: File;
  /** Unique URL-shaped marker embedded in the converted markdown. */
  marker: string;
}

export interface ConvertedClipboardHtml {
  markdown: string;
  images: ClipboardHtmlImage[];
  /** Block-shaped pastes must be separated from text already on the line. */
  block: boolean;
}

const BLOCK_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,blockquote,pre,ul,ol,table,hr,div';
const SAFE_LINK = /^(?:https?:|mailto:|tel:|\/|#)/i;
const TRANSPARENT = new Set(['', 'transparent', 'inherit', 'initial', 'unset', 'none']);
const MONOSPACE = /(?:^|,|\s)(?:monospace|consolas|courier(?:\s+new)?|menlo|monaco)(?:,|\s|$)/i;
const MAX_DATA_IMAGE_CHARS = 70 * 1024 * 1024; // comfortably below the server's 50 MiB decoded limit

function turndownService(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  td.use(gfm);
  td.remove(['style', 'script', 'noscript', 'template']);

  // Folio's formatting toolbar writes these exact HTML fragments because GFM
  // has no underline/highlight syntax with a dependable fallback.
  td.addRule('folio-underline', {
    filter: 'ins',
    replacement: (content) => (content ? `<ins>${content}</ins>` : ''),
  });
  td.addRule('folio-highlight', {
    filter: 'mark',
    replacement: (content) => (content ? `<mark>${content}</mark>` : ''),
  });
  return td;
}

function styleValue(element: Element, property: string): string {
  return (element as HTMLElement).style.getPropertyValue(property).trim();
}

function visibleBackground(element: Element): string | null {
  const raw = styleValue(element, 'background-color');
  return TRANSPARENT.has(raw.toLowerCase()) ? null : raw || null;
}

function boldStyle(element: Element): boolean {
  const raw = styleValue(element, 'font-weight').toLowerCase();
  if (raw === 'bold' || raw === 'bolder') return true;
  const numeric = Number.parseInt(raw, 10);
  return Number.isFinite(numeric) && numeric >= 600;
}

function normalWeight(element: Element): boolean {
  const raw = styleValue(element, 'font-weight').toLowerCase();
  if (!raw) return false;
  if (raw === 'normal' || raw === 'lighter') return true;
  const numeric = Number.parseInt(raw, 10);
  return Number.isFinite(numeric) && numeric < 600;
}

function italicStyle(element: Element): boolean {
  return /^(?:italic|oblique)/i.test(styleValue(element, 'font-style'));
}

function decorationStyle(element: Element, kind: 'underline' | 'line-through'): boolean {
  const raw = `${styleValue(element, 'text-decoration')} ${styleValue(element, 'text-decoration-line')}`;
  return new RegExp(`(?:^|\\s)${kind}(?:\\s|$)`, 'i').test(raw);
}

function monospaceStyle(element: Element): boolean {
  return MONOSPACE.test(styleValue(element, 'font-family'));
}

function unwrap(element: Element): void {
  element.replaceWith(...Array.from(element.childNodes));
}

/** Replace one styled span with semantic elements Turndown understands. */
function promoteSpan(span: HTMLElement): void {
  const tags: string[] = [];
  if (boldStyle(span)) tags.push('strong');
  if (italicStyle(span)) tags.push('em');
  // A hyperlink is normally underlined by Google Docs; the link itself
  // already carries that meaning, so don't wrap it in a redundant <ins>.
  if (decorationStyle(span, 'underline') && span.parentElement?.tagName !== 'A') tags.push('ins');
  if (decorationStyle(span, 'line-through')) tags.push('del');
  if (visibleBackground(span)) tags.push('mark');
  if (monospaceStyle(span)) tags.push('code');

  if (tags.length === 0) {
    unwrap(span);
    return;
  }

  const document = span.ownerDocument;
  let replacement: Node = document.createDocumentFragment();
  while (span.firstChild) replacement.appendChild(span.firstChild);
  // First signal in the list becomes the outermost wrapper. That keeps the
  // resulting markdown stable for combinations such as bold+italic.
  for (const tag of [...tags].reverse()) {
    const wrapper = document.createElement(tag);
    wrapper.appendChild(replacement);
    replacement = wrapper;
  }
  span.replaceWith(replacement);
}

function isCodeParagraph(element: Element): boolean {
  if (element.tagName !== 'P' || !visibleBackground(element)) return false;
  const styled = [element, ...Array.from(element.querySelectorAll<HTMLElement>('[style]'))];
  return styled.some(monospaceStyle);
}

/** Google Docs represents a code block as consecutive grey monospace <p>s. */
function groupCodeParagraphs(root: HTMLElement): void {
  for (let current = root.firstElementChild; current; ) {
    if (!isCodeParagraph(current)) {
      current = current.nextElementSibling;
      continue;
    }

    const document = current.ownerDocument;
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    pre.appendChild(code);

    const lines: string[] = [];
    let cursor: Element | null = current;
    let after: Element | null = null;
    while (cursor && isCodeParagraph(cursor)) {
      lines.push((cursor.textContent ?? '').replace(/\u00a0/g, ' ').replace(/[ \t]+$/g, ''));
      const next: Element | null = cursor.nextElementSibling;
      if (cursor === current) cursor.replaceWith(pre);
      else cursor.remove();
      cursor = next;
      after = next;
    }
    code.textContent = lines.join('\n');
    current = after;
  }
}

function promoteStyles(root: HTMLElement): void {
  // Google wraps the whole clipboard in <b style="font-weight:normal">.
  // Leaving that wrapper intact produces a stray pair of ** around the entire
  // document even though the visual style explicitly says it is not bold.
  for (const element of Array.from(root.querySelectorAll('b,strong'))) {
    if (normalWeight(element)) unwrap(element);
  }

  // Run after removing the Google wrapper: its document paragraphs become
  // direct body children only at that point, which is what separates adjacent
  // code-block lines from ordinary nested/table paragraphs.
  groupCodeParagraphs(root);

  for (const span of Array.from(root.querySelectorAll<HTMLElement>('span'))) promoteSpan(span);

  // Non-code highlighted paragraphs carry the background on <p>, not <span>.
  for (const paragraph of Array.from(root.querySelectorAll<HTMLElement>('p[style]'))) {
    if (!visibleBackground(paragraph) || paragraph.closest('pre')) continue;
    const mark = paragraph.ownerDocument.createElement('mark');
    while (paragraph.firstChild) mark.appendChild(paragraph.firstChild);
    paragraph.appendChild(mark);
  }
}

const RICH_FORMATTING_SELECTOR =
  'a[href],strong,b,em,i,u,s,del,code,pre,ul,ol,li,table,h1,h2,h3,h4,h5,h6,blockquote,img';

/**
 * Does this clipboard HTML carry real formatting rather than being a plain
 * markdown-shaped document's inert HTML twin? Checks both semantic tags and
 * the inline styles Google Docs (and similar editors) use instead of tags —
 * reusing the same style predicates `promoteStyles` relies on below, so the
 * two stay in agreement about what counts as bold/italic/underline/strike.
 */
export function htmlHasRichFormatting(html: string): boolean {
  if (!html.trim() || typeof DOMParser === 'undefined') return false;
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  if (!body) return false;
  if (body.querySelector(RICH_FORMATTING_SELECTOR)) return true;
  for (const element of Array.from(body.querySelectorAll<HTMLElement>('[style]'))) {
    if (boldStyle(element)) return true;
    if (italicStyle(element)) return true;
    if (decorationStyle(element, 'underline') || decorationStyle(element, 'line-through')) return true;
  }
  return false;
}

const GOOGLE_REDIRECT = /^https?:\/\/(?:www\.)?google\.[a-z.]+\/url\?/i;

/**
 * Google Docs wraps every copied hyperlink in a tracking redirect
 * (`https://www.google.com/url?q=<encoded target>&sa=D&source=docs&ust=…`).
 * Recover the real target so the pasted markdown links somewhere useful
 * instead of through Google's redirector.
 */
export function unwrapRedirectHref(href: string): string {
  if (!GOOGLE_REDIRECT.test(href)) return href;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  const target = url.searchParams.get('q') ?? url.searchParams.get('url');
  if (!target) return href;
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    decoded = target;
  }
  return SAFE_LINK.test(decoded) ? decoded : href;
}

function sanitizeLinks(root: HTMLElement): void {
  for (const link of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    const href = unwrapRedirectHref(link.getAttribute('href')?.trim() ?? '');
    if (SAFE_LINK.test(href)) link.setAttribute('href', href);
    else link.removeAttribute('href');
  }
}

function imageExtension(mime: string): string {
  switch (mime.toLowerCase()) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/svg+xml':
      return 'svg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/avif':
      return 'avif';
    default:
      return 'png';
  }
}

function dataImageFile(src: string, index: number): File | null {
  if (src.length > MAX_DATA_IMAGE_CHARS) return null;
  const match = /^data:(image\/[a-z0-9.+-]+)(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i.exec(src);
  if (!match) return null;

  try {
    const mime = match[1].toLowerCase();
    const decoded = match[2] ? atob(match[3].replace(/\s/g, '')) : decodeURIComponent(match[3]);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i) & 0xff;
    const name = `pasted-image-${String(index + 1).padStart(2, '0')}.${imageExtension(mime)}`;
    return new File([bytes], name, { type: mime });
  } catch {
    return null;
  }
}

function extractImages(root: HTMLElement): ClipboardHtmlImage[] {
  const out: ClipboardHtmlImage[] = [];
  for (const image of Array.from(root.querySelectorAll<HTMLImageElement>('img'))) {
    const src = image.getAttribute('src')?.trim() ?? '';
    if (!src.toLowerCase().startsWith('data:')) continue;
    const file = dataImageFile(src, out.length);
    if (!file) {
      image.remove();
      continue;
    }
    const marker = `folio-clipboard-image://${crypto.randomUUID()}/${out.length}`;
    image.setAttribute('src', marker);
    if (!image.getAttribute('alt')?.trim()) image.setAttribute('alt', file.name.replace(/\.[^.]+$/, ''));
    out.push({ file, marker });
  }
  return out;
}

const HEX_COLOR_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_COLOR_RE = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/i;

function parseColor(raw: string | null): [number, number, number] | null {
  if (!raw || TRANSPARENT.has(raw.trim().toLowerCase())) return null;
  const hex = HEX_COLOR_RE.exec(raw.trim());
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3) digits = digits.split('').map((digit) => digit + digit).join('');
    return [0, 2, 4].map((at) => Number.parseInt(digits.slice(at, at + 2), 16)) as [number, number, number];
  }
  const rgb = RGB_COLOR_RE.exec(raw.trim());
  if (!rgb || (rgb[4] !== undefined && Number.parseFloat(rgb[4]) <= 0)) return null;
  return [rgb[1], rgb[2], rgb[3]].map((value) => Math.min(255, Number.parseInt(value, 10))) as [number, number, number];
}

function colorToken(raw: string | null): BgToken | null {
  const rgb = parseColor(raw);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((value) => value / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2;
  if (max === min) return 'gray';
  const delta = max - min;
  const saturation = light > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  if (saturation < 0.25) return 'gray';
  let hue: number;
  if (max === r) hue = (g - b) / delta + (g < b ? 6 : 0);
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue *= 60;
  if (hue < 25 || hue >= 300) return 'red';
  if (hue < 40) return 'orange';
  if (hue < 70) return 'yellow';
  if (hue < 172) return 'green';
  if (hue < 202) return 'teal';
  if (hue < 236) return 'blue';
  return 'purple';
}

function normalizeCellMarkdown(markdown: string): string {
  const lines = markdown.replace(/\u00a0/g, ' ').split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    let content = line.trim();
    const bullet = /^[-+*]\s+(.*)$/.exec(content);
    if (bullet) content = `• ${bullet[1]}`;
    else content = content.replace(/^(\d+)\.\s+/, '$1. ');
    const googleLevel = /FOLIOCELLLEVEL(\d+)END\s*/.exec(content);
    if (googleLevel) content = content.replace(googleLevel[0], '');
    const depth = Math.min(
      2,
      Math.max(Math.floor(indent / 4), googleLevel ? Number.parseInt(googleLevel[1], 10) - 1 : 0),
    );
    out.push(`${'  '.repeat(depth)}${content}`);
  }
  return out.join('<br>');
}

function cellInnerMarkdown(cell: HTMLTableCellElement, inline: TurndownService): string {
  const clone = cell.cloneNode(true) as HTMLTableCellElement;
  // Google Docs writes nested lists as sibling <ul>s and records the real
  // depth on each <li aria-level="…">. HTML nesting alone therefore looks
  // flat to Turndown; carry that explicit level through a temporary text
  // marker and turn it into Folio's two-space cell-list indent afterwards.
  for (const item of Array.from(clone.querySelectorAll<HTMLLIElement>('li[aria-level]'))) {
    const level = Number.parseInt(item.getAttribute('aria-level') ?? '', 10);
    if (Number.isFinite(level) && level > 1) {
      const content = item.querySelector('p') ?? item;
      content.insertBefore(
        clone.ownerDocument.createTextNode(`FOLIOCELLLEVEL${level}END `),
        content.firstChild,
      );
    }
  }
  return normalizeCellMarkdown(inline.turndown(clone.innerHTML));
}

function escapeTableCell(value: string): string {
  return value.replace(/(^|[^\\])\|/g, '$1\\|').replace(/\r?\n/g, '<br>');
}

function tableWidths(table: HTMLTableElement, attrs: TableAttrs): void {
  const columns = Array.from(table.querySelectorAll<HTMLTableColElement>('colgroup > col'));
  if (columns.length === 0) return;
  const values = columns.map((column) => {
    const raw = column.getAttribute('width') || styleValue(column, 'width');
    const value = raw ? Number.parseFloat(raw) : Number.NaN;
    return Number.isFinite(value) && value > 0 ? value : 0;
  });
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!total || values.some((value) => value <= 0)) return;

  let used = 0;
  values.forEach((value, index) => {
    const percent = index === values.length - 1 ? 100 - used : Math.max(1, Math.round((value / total) * 100));
    used += percent;
    attrs.width[index + 1] = `${percent}%`;
  });
}

function tableMarkdown(table: HTMLTableElement, inline: TurndownService): string | null {
  const rows = Array.from(table.rows);
  if (rows.length === 0) return null;

  const attrs: TableAttrs = { bg: {}, width: {} };
  tableWidths(table, attrs);

  // Merged cells are EXPANDED into a rectangular grid — content stays in the
  // first covered cell, the rest come out empty. Folio has its own colspan/
  // rowspan syntax, but inferring it from an arbitrary browser table is
  // unsafe, and the previous code bailed out here instead: Turndown's GFM
  // handling then dumped the table's raw HTML into the document (owner,
  // 17.09: a paste from Google Sheets landed as a wall of `<table style=…>`).
  // A flattened table loses the merge, never the text.
  const grid: string[][] = [];
  const rowOf = (index: number): string[] => (grid[index] ??= []);
  rows.forEach((row, rowIndex) => {
    const cells = Array.from(row.cells);
    let column = 0;
    for (const cell of cells) {
      while (rowOf(rowIndex)[column] !== undefined) column++;
      const own = visibleBackground(cell);
      const inherited = visibleBackground(row);
      const token = colorToken(own ?? inherited);
      if (token) attrs.bg[cellKey(rowIndex === 0 ? -1 : rowIndex - 1, column)] = token;
      const text = cellInnerMarkdown(cell, inline);
      // colSpan/rowSpan are 1 for a plain cell, so this covers both shapes.
      for (let dr = 0; dr < Math.max(1, cell.rowSpan); dr++) {
        for (let dc = 0; dc < Math.max(1, cell.colSpan); dc++) {
          rowOf(rowIndex + dr)[column + dc] = dr === 0 && dc === 0 ? text : '';
        }
      }
      column += Math.max(1, cell.colSpan);
    }
  });

  const width = Math.max(0, ...grid.map((row) => row.length));
  if (width === 0) return null;
  const matrix = grid.map((row) => {
    const filled = Array.from({ length: width }, (_, index) => row[index] ?? '');
    return filled;
  });

  const lines = [
    `| ${matrix[0].map(escapeTableCell).join(' | ')} |`,
    `| ${new Array(width).fill('---').join(' | ')} |`,
    ...matrix.slice(1).map((row) => `| ${row.map(escapeTableCell).join(' | ')} |`),
  ];
  const attrLine = formatTableAttrLine(attrs);
  return attrLine ? `${attrLine}\n\n${lines.join('\n')}` : lines.join('\n');
}

function extractTables(root: HTMLElement, inline: TurndownService): Map<string, string> {
  const replacements = new Map<string, string>();
  Array.from(root.querySelectorAll<HTMLTableElement>('table')).forEach((table, index) => {
    const markdown = tableMarkdown(table, inline);
    if (!markdown) return;
    const marker = `FOLIOTABLEPLACEHOLDER${index}END`;
    replacements.set(marker, markdown);
    table.replaceWith(table.ownerDocument.createTextNode(marker));
  });
  return replacements;
}

/** Convert clipboard HTML synchronously; upload itself stays in uploads.ts. */

/**
 * Does the clipboard's text/plain already read as markdown? Browsers, editors
 * and chat apps put a text/html twin next to copied markdown; converting THAT
 * twin through turndown escapes every `#`, `*`, `_`, `[` — the owner saw a
 * pasted document turn into `\#` / `\*` soup. When the plain text carries
 * markdown structure, it is the better source and must be pasted verbatim.
 */
export function looksLikeMarkdown(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  const lines = value.split('\n');
  let hits = 0;
  for (const line of lines) {
    if (/^#{1,6}\s+\S/.test(line)) return true;
    if (/^```/.test(line)) return true;
    if (/^\s*([-*+]|\d+\.)\s+\S/.test(line)) hits += 1;
    else if (/^\s*\|.*\|\s*$/.test(line)) hits += 1;
    else if (/^>\s?\S/.test(line)) hits += 1;
    else if (/\[[^\]]+\]\([^)]+\)/.test(line)) hits += 1;
    else if (/(\*\*|__)[^*_]+(\*\*|__)/.test(line)) hits += 1;
    else if (/`[^`]+`/.test(line)) hits += 1;
  }
  return hits >= 2;
}

export function convertClipboardHtml(html: string): ConvertedClipboardHtml | null {
  if (!html.trim() || typeof DOMParser === 'undefined') return null;
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const body = parsed.body;
  if (!body || (!body.textContent?.trim() && !body.querySelector('img'))) return null;
  const block = body.querySelector(BLOCK_SELECTOR) !== null;

  for (const unsafe of Array.from(body.querySelectorAll('style,script,noscript,template'))) unsafe.remove();
  sanitizeLinks(body);
  const images = extractImages(body);
  promoteStyles(body);

  const td = turndownService();
  const tables = extractTables(body, td);
  let markdown = td.turndown(body.innerHTML);
  for (const [marker, table] of tables) markdown = markdown.replace(marker, table);
  markdown = markdown
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!markdown && images.length === 0) return null;
  return { markdown, images, block };
}
