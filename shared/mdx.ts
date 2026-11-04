/**
 * MDX pages (Nimbus, Starlight, Docusaurus, Astro docs): a `.mdx` file is a page
 * like a `.md` one — front matter, Markdown, and on top of that three things
 * Markdown has no word for:
 *
 *   - ESM `import` / `export` statements, one per paragraph at the top level;
 *   - JSX block components (`<Aside type="note">…</Aside>`, `<Tabs>`, `<Card />`);
 *   - `{expressions}` (and brace comments, `{` slash-star ... star-slash `}`) in the text.
 *
 * Folio never interprets any of it. The editor works on the text of the file, so
 * every byte round-trips by construction; what this module adds is the *map* of
 * the document: which line ranges are ESM and which are one JSX component, so the
 * editor can fold each into one compact block (web/src/editor/mdx-widget.tsx) and
 * the Reading view can render the component's Markdown body in a labelled box
 * (web/src/markdown/mdx.ts) instead of dropping the tag or showing it as text.
 *
 * Pure and dependency-free, shared by the server and the web app. Positions are
 * character offsets into the text it was given (front matter already stripped).
 */

/** The `.mdx` suffix, case-insensitive — the one extension besides `.md` that opens as a page. */
export function isMdxPath(pathOrName: string): boolean {
  return /\.mdx$/i.test(pathOrName);
}

/** `.md` or `.mdx` — the suffix a plain document file carries, as written in the path ('' for anything else). */
export function docExtOf(pathOrName: string): string {
  const m = /\.mdx?$/i.exec(pathOrName);
  return m ? m[0] : '';
}

/** `guide/intro.mdx` -> `guide/intro`, `intro.md` -> `intro`; anything else unchanged. */
export function stripDocExt(pathOrName: string): string {
  return pathOrName.replace(/\.mdx?$/i, '');
}

/** A directory's own page: `index.md`, `index.mdx`, `README.md`, `README.mdx` (case as written). */
export function isDirIndexName(name: string): boolean {
  return /^(index|README)\.mdx?$/.test(name);
}

/** `index.md` / `index.mdx` only (README is the weaker fallback). */
export function isStrongIndexName(name: string): boolean {
  return /^index\.mdx?$/.test(name);
}

export type MdxBlockKind = 'esm' | 'jsx';

export interface MdxBlock {
  kind: MdxBlockKind;
  /** Offset of the first character of the block's first line. */
  from: number;
  /** Offset just after the block's last character (the end of its last line, line break excluded). */
  to: number;
  /** `text.slice(from, to)`. */
  source: string;
  /** jsx: the outermost component's name (`Aside`, `Tabs`, `ui.Card`), `''` for a fragment `<>`. */
  name?: string;
  /** jsx: the opening tag exactly as written, up to and including its `>` (may span lines). */
  openTag?: string;
  /** jsx: true for `<Card ... />`. */
  selfClosing?: boolean;
  /** jsx: what sits between the opening tag and the closing tag (empty for a self-closing one). */
  body?: string;
}

const FENCE_RE = /^(\s*)(`{3,}|~{3,})/;
const ESM_RE = /^(import|export)\s/;
const TAG_NAME_RE = /^<([A-Z][\w.:-]*)(?=[\s/>]|$)|^<(>)/;

interface Line {
  start: number;
  end: number;
  text: string;
}

function splitLines(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    let textEnd = end;
    if (textEnd > start && text[textEnd - 1] === '\r') textEnd--;
    out.push({ start, end: textEnd, text: text.slice(start, textEnd) });
    if (end >= text.length) break;
    start = end + 1;
  }
  return out;
}

/**
 * Reads one JSX tag starting at `at` (`text[at] === '<'`): skips quoted attribute values and `{…}` expressions
 * (which may hold a `>`), returns where the tag ends and what kind it is. `null` when it never closes.
 */
function readTag(text: string, at: number): { end: number; name: string; closing: boolean; selfClosing: boolean } | null {
  let i = at + 1;
  let closing = false;
  if (text[i] === '/') {
    closing = true;
    i++;
  }
  const nameStart = i;
  while (i < text.length && /[\w.:-]/.test(text[i])) i++;
  const name = text.slice(nameStart, i);
  let depth = 0;
  let quote = '';
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (depth > 0) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return { end: i + 1, name, closing, selfClosing: text[i - 1] === '/' && !closing };
    else if (ch === '<') return null; // a stray `<` before the tag closed: not JSX
  }
  return null;
}

/** Offsets of the lines that are inside a fenced code block (the fence lines included). */
function fencedLines(lines: Line[]): boolean[] {
  const fenced = new Array<boolean>(lines.length).fill(false);
  let open: { char: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_RE.exec(lines[i].text);
    if (open) {
      fenced[i] = true;
      if (m && m[2][0] === open.char && m[2].length >= open.len && lines[i].text.slice(m[0].length).trim() === '') open = null;
    } else if (m) {
      fenced[i] = true;
      open = { char: m[2][0], len: m[2].length };
    }
  }
  return fenced;
}

/** Where a run of ESM lines stands: brackets opened and not yet closed, and whether a template literal is still open. */
interface EsmState {
  balance: number;
  template: boolean;
}

/** Feeds one more line of ESM to `state` — a blank line only ends the statement when nothing is open. */
function advanceEsm(state: EsmState, line: string): void {
  let quote = state.template ? '`' : '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{' || ch === '(' || ch === '[') state.balance++;
    else if (ch === '}' || ch === ')' || ch === ']') state.balance--;
  }
  state.template = quote === '`';
}

/**
 * Finds the end of the JSX element whose opening tag starts at `at`: the matching `</Name>` (counting nested
 * elements of the same name), skipping fenced code and inline code in the body. Returns the offset after the
 * closing tag, or `null` when it never closes.
 */
function elementEnd(text: string, at: number, open: { end: number; name: string }): { end: number; bodyEnd: number } | null {
  const lines = splitLines(text);
  const fenced = fencedLines(lines);
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lines[mid].start <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  let depth = 1;
  let i = open.end;
  while (i < text.length) {
    const lineIdx = lineAt(i);
    if (fenced[lineIdx]) {
      i = lines[lineIdx].end + 1;
      continue;
    }
    const ch = text[i];
    if (ch === '`') {
      // inline code: skip to the closing run of the same length, on the same line
      let run = 0;
      while (text[i + run] === '`') run++;
      const lineEnd = lines[lineIdx].end;
      const close = text.indexOf('`'.repeat(run), i + run);
      i = close !== -1 && close < lineEnd ? close + run : i + run;
      continue;
    }
    if (ch === '<' && (text[i + 1] === '/' || /[A-Za-z>]/.test(text[i + 1] ?? ''))) {
      const tag = readTag(text, i);
      if (tag && tag.name === open.name) {
        if (tag.closing) {
          depth--;
          if (depth === 0) return { end: tag.end, bodyEnd: i };
        } else if (!tag.selfClosing) depth++;
        i = tag.end;
        continue;
      }
      if (tag) {
        i = tag.end;
        continue;
      }
    }
    i++;
  }
  return null;
}

/**
 * The ESM statements and JSX components at the top level of an MDX document, in order, never overlapping.
 *
 * - ESM: a paragraph (lines up to a blank line, or past it while brackets stay open) whose first line starts with
 *   `import ` / `export ` — MDX's own rule.
 * - JSX: a line that starts with `<Capitalised…` (or `<>`) at the left margin, up to the line that holds the
 *   matching close tag; nothing but whitespace may follow it on that line (otherwise it is inline JSX in a
 *   paragraph, left to the paragraph). A self-closing `<Card />` is one block too. Lowercase HTML (`<details>`,
 *   `<dl>`) is Markdown's own raw HTML and is not touched here.
 *
 * Fenced code is skipped. An element that never closes yields no block — the author is still typing it.
 */
export function scanMdxBlocks(text: string): MdxBlock[] {
  const lines = splitLines(text);
  const fenced = fencedLines(lines);
  const blocks: MdxBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (fenced[i]) {
      i++;
      continue;
    }
    // ESM
    if (ESM_RE.test(line.text)) {
      let j = i;
      const state: EsmState = { balance: 0, template: false };
      for (; j < lines.length; j++) {
        if (fenced[j]) break;
        const t = lines[j].text;
        if (t.trim() === '' && state.balance <= 0 && !state.template) break;
        advanceEsm(state, t);
      }
      const last = lines[j - 1];
      blocks.push({ kind: 'esm', from: line.start, to: last.end, source: text.slice(line.start, last.end) });
      i = j;
      continue;
    }
    // JSX
    const lead = /^ {0,3}/.exec(line.text)![0].length;
    const m = TAG_NAME_RE.exec(line.text.slice(lead));
    if (m) {
      const at = line.start + lead;
      const open = readTag(text, at);
      if (open && !open.closing) {
        let end: number;
        let bodyStart = open.end;
        let bodyEnd = open.end;
        if (open.selfClosing) end = open.end;
        else {
          const close = elementEnd(text, at, open);
          if (!close) {
            i++;
            continue;
          }
          end = close.end;
          bodyEnd = close.bodyEnd;
        }
        // Only whitespace may follow the element on its last line.
        let lineEnd = text.indexOf('\n', end);
        if (lineEnd === -1) lineEnd = text.length;
        const rest = text.slice(end, lineEnd).replace(/\r$/, '');
        if (rest.trim() === '') {
          const to = end + rest.length;
          const body = open.selfClosing ? '' : text.slice(bodyStart, bodyEnd);
          blocks.push({
            kind: 'jsx',
            from: at,
            to,
            source: text.slice(at, to),
            name: m[1] ?? '',
            openTag: text.slice(at, open.end),
            selfClosing: open.selfClosing,
            body,
          });
          // continue after the last line of the block
          let k = i;
          while (k < lines.length && lines[k].end < to) k++;
          i = k + 1;
          continue;
        }
      }
    }
    i++;
  }
  return blocks;
}

/** A brace comment alone on a line — MDX's way of writing a comment; invisible when the page is rendered. */
export const MDX_COMMENT_LINE_RE = /^\s*\{\/\*[\s\S]*?\*\/\}\s*$/;

/** The attributes of an opening tag as short display text: `<Aside type="note" title="x">` -> `type="note" title="x"`. */
export function mdxTagAttributes(openTag: string): string {
  const m = /^<[\w.:-]*\s*([\s\S]*?)\/?>$/.exec(openTag);
  return (m?.[1] ?? '').replace(/\s+/g, ' ').trim();
}
