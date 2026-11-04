/**
 * The one-line description of a page in llms.txt (publicLlms.ts): plain text, never Markdown, never the whole page.
 * Order of preference: the page's front matter `description`, else its first prose paragraph (headings, lists, tables,
 * quotes, code, HTML/MDX blocks and directives are skipped), with Markdown and wikilink syntax reduced to the words a
 * reader would see, cut at a sentence boundary within LLMS_DESCRIPTION_MAX characters.
 */

export const LLMS_DESCRIPTION_MAX = 160;

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Inline Markdown / Obsidian syntax -> the text it shows. */
export function plainInline(text: string): string {
  return oneLine(
    text
      .replace(/%%[\s\S]*?%%/g, '') // Obsidian comments
      .replace(/!\[\[[^[\]]*\]\]/g, '') // embeds
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images -> alt
      .replace(/\[\[([^[\]]+)\]\]/g, (_m, inner: string) => {
        const bar = inner.indexOf('|');
        if (bar !== -1) return inner.slice(bar + 1).trim();
        const target = inner.split('#')[0].trim() || inner.replace(/^#\^?/, '');
        return target.slice(target.lastIndexOf('/') + 1);
      })
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> label
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1') // reference links -> label
      .replace(/\[\^[^\]]+\]/g, '') // footnote references
      .replace(/<(https?:\/\/[^>\s]+)>/g, '$1') // autolinks
      .replace(/<\/?[A-Za-z][^>]*>/g, '') // inline HTML / JSX tags
      .replace(/`([^`]*)`/g, '$1')
      .replace(/(?<=\S)\*{1,3}|\*{1,3}(?=\S)|~~|==/g, '')
      .replace(/(^|[^\w])_{1,3}(?=\S)([^_]+?)_{1,3}(?=[^\w]|$)/g, '$1$2')
      .replace(/\s\^[\w-]+$/, '') // trailing block id
      .replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, '$1'),
  );
}

/** Cuts `text` after the last sentence that fits `max`; with no sentence end that early, at a word, with an ellipsis. */
export function cutAtSentence(text: string, max = LLMS_DESCRIPTION_MAX): string {
  if (text.length <= max) return text;
  let end = 0;
  const re = /[.!?…]+["')\]]*(?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index + m[0].length > max) break;
    end = m.index + m[0].length;
  }
  if (end > 0) return text.slice(0, end).trim();
  const room = text.slice(0, max - 1);
  const space = room.lastIndexOf(' ');
  return `${(space > max * 0.5 ? room.slice(0, space) : room).replace(/[\s,;:.-]+$/, '')}…`;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}#{1,6}(\s|$)/;
const LIST_ITEM = /^\s*([-*+]|\d+[.)])(\s|$)/;
const QUOTE = /^\s{0,3}>/;
const TAG_OPEN = /^\s*<([A-Za-z][\w.:-]*)\b/;
/** Lines that open something that is not prose: table, JSX expression, directive, math, comment, MDX import/export, definitions, rules. */
const NON_PROSE = /^\s{0,3}(\||\{|:{2,}|\$\$|%%|import\s|export\s|\[[^\]]+\]:\s|\[\^[^\]]+\]:)|^\s{0,3}([-*_])(\s*\2){2,}\s*$/;

function fenceCloses(open: RegExpExecArray, line: string): boolean {
  const close = FENCE.exec(line);
  return !!close && close[1][0] === open[1][0] && close[1].length >= open[1].length;
}

/** The first prose paragraph of a Markdown body as plain text, or ''. */
export function firstParagraph(markdown: string): string {
  const lines = markdown.replace(/^﻿/, '').replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '').split(/\r?\n/);
  let i = 0;
  let afterList = false;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      i++;
      while (i < lines.length && !fenceCloses(fence, lines[i])) i++;
      i++;
      afterList = false;
      continue;
    }
    if (HEADING.test(line)) {
      i++;
      afterList = false;
      continue;
    }
    const tag = TAG_OPEN.exec(line);
    if (tag) {
      // An HTML / JSX block: through its closing tag when it spans lines, else to the blank line.
      const name = tag[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const open = new RegExp(`<${name}(?![\\w.:-])`, 'g');
      const close = new RegExp(`</${name}\\s*>|/>`, 'g');
      let depth = 0;
      do {
        depth += (lines[i].match(open) ?? []).length - (lines[i].match(close) ?? []).length;
        i++;
      } while (depth > 0 && i < lines.length);
      afterList = false;
      continue;
    }
    const indentedCode = /^( {4}|\t)/.test(line) && !afterList;
    const listContinuation: boolean = afterList && /^\s{2,}/.test(line);
    if (LIST_ITEM.test(line) || listContinuation || indentedCode || QUOTE.test(line) || NON_PROSE.test(line)) {
      afterList = LIST_ITEM.test(line) || listContinuation;
      i++;
      // The rest of this block, up to the blank line.
      while (i < lines.length && lines[i].trim() && !HEADING.test(lines[i]) && !FENCE.test(lines[i]) && !LIST_ITEM.test(lines[i])) i++;
      continue;
    }
    afterList = false;
    // A paragraph: until a blank line or a line that starts another construct.
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !HEADING.test(lines[i]) && !FENCE.test(lines[i]) && !LIST_ITEM.test(lines[i]) && !QUOTE.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    if (para.length === 2 && /^\s*(=+|-+)\s*$/.test(para[1])) continue; // a setext heading
    const text = plainInline(para.join(' '));
    if (text) return text;
  }
  return '';
}

/** The llms.txt description of a page: its front matter `description`, else the first prose paragraph of `body`; one line, plain text, <= LLMS_DESCRIPTION_MAX. */
export function llmsDescription(frontMatterDescription: string | undefined, body: string | undefined): string {
  const own = frontMatterDescription ? plainInline(frontMatterDescription) : '';
  return cutAtSentence(own || firstParagraph(body ?? ''));
}
