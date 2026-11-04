import { MDX_COMMENT_LINE_RE, mdxTagAttributes, scanMdxBlocks, type MdxBlock } from '@shared/mdx';

/**
 * MDX for the Reading view and for the editor's component blocks.
 *
 * An `.mdx` page is Markdown plus things this renderer cannot execute: `import` /
 * `export` lines, JSX components (`<Aside>`, `<Tabs>`, `<Card />`) and
 * `{expression}` comments. Folio does not run them (the site generator does);
 * what it owes the reader is not to drop them silently (a sanitised unknown tag
 * vanishes with its content in some cases, and a component that wraps a table
 * would take the table with it) and not to print them as raw text.
 *
 * `mdxToMarkdown` rewrites the page's text into plain Markdown the usual pipeline
 * renders, never touching the file:
 *   - ESM lines are left out (they are code for the build, not content);
 *   - brace comments alone on a line are left out;
 *   - a JSX component becomes a labelled box: a head with the component's name
 *     and its attributes, then its body as Markdown (components nested in the
 *     body become nested boxes). A component without a body is just the head.
 * Fenced code is left exactly as it is, including a fence that shows MDX.
 */

const MAX_DEPTH = 6;
const FENCE_RE = /^(\s*)(`{3,}|~{3,})/;

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** `title="x"` / `label='x'` out of an attribute string: what a reader would call the component's heading. */
function headingAttr(attrs: string): { heading: string | null; rest: string } {
  const m = /(?:^|\s)(title|label)=(?:"([^"]*)"|'([^']*)')/.exec(attrs);
  if (!m) return { heading: null, rest: attrs };
  const rest = (attrs.slice(0, m.index) + attrs.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
  return { heading: m[2] ?? m[3] ?? null, rest };
}

/** Removes the indentation every line of `text` shares, so an indented JSX body does not turn into an indented code block. */
function dedent(text: string): string {
  const lines = text.split('\n');
  let min = Infinity;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const indent = /^[ \t]*/.exec(line)![0].length;
    if (indent < min) min = indent;
  }
  if (!Number.isFinite(min) || min === 0) return text;
  return lines.map((line) => (line.trim() === '' ? '' : line.slice(min))).join('\n');
}

/**
 * An attribute string short enough for the head of a box: a `{…}` expression longer than a few characters (a whole
 * code sample passed as `code={'…'}`, an object) is shown as `{…}`, and the rest is cut at 120 characters.
 */
export function shortenAttrs(attrs: string): string {
  let out = '';
  for (let i = 0; i < attrs.length; i++) {
    if (attrs[i] !== '{') {
      out += attrs[i];
      continue;
    }
    let depth = 0;
    let quote = '';
    let j = i;
    for (; j < attrs.length; j++) {
      const ch = attrs[j];
      if (quote) {
        if (ch === '\\') j++;
        else if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) break;
    }
    const expr = attrs.slice(i, Math.min(j + 1, attrs.length));
    out += expr.length > 28 ? '{…}' : expr;
    i = j;
  }
  return out.length > 120 ? `${out.slice(0, 119)}…` : out;
}

function headHtml(block: MdxBlock): string {
  const name = block.name || 'Fragment';
  const { heading, rest: restRaw } = headingAttr(mdxTagAttributes(block.openTag ?? ''));
  const rest = shortenAttrs(restRaw);
  const parts = [`<span class="folio-mdx__tag">${escapeHtml(name)}</span>`];
  if (heading) parts.push(`<span class="folio-mdx__title">${escapeHtml(heading)}</span>`);
  if (rest) parts.push(`<code class="folio-mdx__attrs">${escapeHtml(rest)}</code>`);
  return `<div class="folio-mdx__head">${parts.join(' ')}</div>`;
}

/** The brace comments (`{` + slash-star ... star-slash + `}`) that stand alone on a line, dropped outside fenced code. */
function dropCommentLines(text: string): string {
  if (!text.includes('{/*')) return text;
  const out: string[] = [];
  let fence: { char: string; len: number } | null = null;
  for (const line of text.split('\n')) {
    const m = FENCE_RE.exec(line);
    if (fence) {
      if (m && m[2][0] === fence.char && m[2].length >= fence.len && line.slice(m[0].length).trim() === '') fence = null;
    } else if (m) {
      fence = { char: m[2][0], len: m[2].length };
    } else if (MDX_COMMENT_LINE_RE.test(line)) {
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

export function mdxToMarkdown(text: string, depth = 0): string {
  const blocks = depth >= MAX_DEPTH ? [] : scanMdxBlocks(text);
  if (blocks.length === 0) return dropCommentLines(text);
  let out = '';
  let cursor = 0;
  for (const block of blocks) {
    out += dropCommentLines(text.slice(cursor, block.from));
    cursor = block.to;
    if (block.kind === 'esm') continue;
    const body = (block.body ?? '').replace(/^[ \t]*\r?\n/, '').replace(/\s+$/, '');
    const open = `<div class="folio-mdx"><div class="folio-mdx__box">${headHtml(block)}`;
    // The body is Markdown, so the box's own tags sit in separate HTML blocks around it (a blank line ends a raw HTML block).
    out += body.trim() === '' ? `\n\n${open}</div></div>\n\n` : `\n\n${open}\n\n${mdxToMarkdown(dedent(body), depth + 1)}\n\n</div></div>\n\n`;
  }
  out += dropCommentLines(text.slice(cursor));
  return out;
}

/** True for a page whose file is `.mdx`: the Reading view and the editor switch the MDX handling on by the path alone. */
export function isMdxPagePath(pagePath: string | undefined): boolean {
  return !!pagePath && /\.mdx$/i.test(pagePath);
}
