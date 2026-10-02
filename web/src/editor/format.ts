/**
 * Inline formatting as pure text edits (round 21).
 *
 * Everything the floating toolbar and its hotkeys do is expressed here as a
 * small list of changes plus the selection they leave behind, so the exact same
 * logic drives the CodeMirror document and a table cell's `<textarea>` — and so
 * the whole toggle matrix can be checked without a browser.
 *
 * Marker choice is deliberate and constrained by two things: what GitHub and
 * GitLab render for a file that leaves this app, and what
 * `markdown/sanitizeSchema.ts` lets through in reading mode.
 *
 * - bold `**`, italic `*`, strike `~~`, code `` ` `` — plain GFM.
 * - underline `<ins>` — markdown has no underline at all. `<u>` is NOT in the
 *   sanitizer's allowed tag list, `<ins>` is (verified against
 *   node_modules/hast-util-sanitize's defaultSchema), and GitHub renders `<ins>`
 *   underlined. So `<ins>` it is.
 * - highlight `==text==`, with an optional colour `==text=={.green}` (the
 *   owner, 24.09.2026: "<mark> is html syntax, redo it as
 *   markdown-friendly" plus a colour choice). `==` is what Obsidian, Typora and
 *   markdown-friendly» plus a colour choice). `==` is what Obsidian, Typora and
 *   markdown-it write; `{.token}` is the markdown-it-attrs convention for a
 *   class. Neither is GFM, so GitHub shows them literally — the owner's call.
 *   Tokens are the table-cell background palette (`BG_TOKENS`). The old
 *   `<mark>` keeps being read and toggled off, never written.
 *
 * Every edit here starts from the RUNS of a format on the line (`runsOf`):
 * where each marker pair opens and closes. That is what lets a partial
 * selection inside bold be un-bolded by splitting the run (`**a** b **c**`,
 * the owner, 24.09.2026: "I selected a piece of bold, cmd+b — it did not take
 * the bold off that part") instead of nesting another pair inside it.
 */
import { BG_TOKENS, type BgToken } from '../markdown/tableSyntax';
import { formatLinkTarget } from './paths';

export type InlineFormat = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'highlight';

export interface InlineMarks {
  open: string;
  close: string;
}

export const INLINE_MARKS: Record<InlineFormat, InlineMarks> = {
  bold: { open: '**', close: '**' },
  italic: { open: '*', close: '*' },
  underline: { open: '<ins>', close: '</ins>' },
  strike: { open: '~~', close: '~~' },
  code: { open: '`', close: '`' },
  highlight: { open: '==', close: '==' },
};

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

export interface FormatEdit {
  /** Ascending, non-overlapping — safe to hand straight to `view.dispatch`. */
  changes: TextChange[];
  /** Where the selection ends up, in coordinates *after* the changes. */
  selection: { from: number; to: number };
}

const NO_EDIT: FormatEdit = { changes: [], selection: { from: 0, to: 0 } };

/** Apply an edit to a plain string — how the cell textarea (and the tests) use it. */
export function applyFormatEdit(text: string, edit: FormatEdit): string {
  let out = text;
  for (let i = edit.changes.length - 1; i >= 0; i--) {
    const change = edit.changes[i];
    out = out.slice(0, change.from) + change.insert + out.slice(change.to);
  }
  return out;
}

/**
 * `*` is italic and `**` is bold, so a `*` seen next to another `*` belongs to
 * the bold marker and must not be peeled off as an italic one — `**word**`
 * asked for italics is `***word***`, not `*word*`.
 */
function doubled(open: string, before: string, after: string): boolean {
  return open.length === 1 && before === open + open && after === open + open;
}

/** Shrink a selection onto the non-blank text inside it. */
function trimRange(text: string, from: number, to: number): { from: number; to: number } {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return start < end ? { from: start, to: end } : { from, to };
}

/* ------------------------------------------------------------------ runs -- */

/** One marker pair of a format and the text between: `**text**`, `==text=={.green}`, `<mark>text</mark>`. */
export interface FormatRun {
  outerFrom: number;
  innerFrom: number;
  innerTo: number;
  outerTo: number;
  /** The exact opening/closing text, so a moved marker is written back verbatim. */
  open: string;
  close: string;
  /** Highlight only: the palette token the run carries, if any. */
  color?: BgToken;
}

export const HIGHLIGHT_COLORS = BG_TOKENS;
const HIGHLIGHT_ATTR = /^\{\.([a-z]+)\}/;

/** `<ins>`/`<u>` for underline, `<mark>` for the legacy highlight. */
const HTML_TAGS: Partial<Record<InlineFormat, string[]>> = {
  underline: ['ins', 'u'],
  highlight: ['mark'],
};

/**
 * Marker runs of `format` in `text`, in document order. Symmetric markers
 * (`**`, `*`, `~~`, `` ` ``, `==`) pair up by turns — first opens, next closes
 * — the way a one-pass renderer reads them; a run of the marker character of
 * a different length (`***`) is not this format's marker and is skipped, and
 * so is an escaped one. A highlight closer may carry `{.token}`. HTML pairs
 * (`<ins>…</ins>`, `<mark>…</mark>`) pair by tag name.
 */
export function runsOf(text: string, format: InlineFormat): FormatRun[] {
  const runs: FormatRun[] = [];
  const { open } = INLINE_MARKS[format];
  const symmetric = format !== 'underline';
  if (symmetric) {
    const ch = open[0];
    const need = open.length;
    let opener: { from: number; to: number } | null = null;
    for (let i = 0; i < text.length; ) {
      if (text[i] === '\\') {
        i += 2;
        continue;
      }
      if (text[i] !== ch) {
        i++;
        continue;
      }
      let j = i;
      while (j < text.length && text[j] === ch) j++;
      if (j - i !== need) {
        i = j;
        continue;
      }
      if (!opener) {
        opener = { from: i, to: j };
        i = j;
        continue;
      }
      let to = j;
      let color: BgToken | undefined;
      if (format === 'highlight') {
        const attr = HIGHLIGHT_ATTR.exec(text.slice(j));
        if (attr) {
          to = j + attr[0].length;
          if ((BG_TOKENS as readonly string[]).includes(attr[1])) color = attr[1] as BgToken;
        }
      }
      if (i > opener.to) {
        runs.push({
          outerFrom: opener.from,
          innerFrom: opener.to,
          innerTo: i,
          outerTo: to,
          open: text.slice(opener.from, opener.to),
          close: text.slice(i, to),
          color,
        });
      }
      opener = null;
      i = to;
    }
  }
  const tags = HTML_TAGS[format];
  if (tags) {
    const re = new RegExp(`<(\\/?)(${tags.join('|')})\\s*>`, 'gi');
    const stack: { from: number; to: number; name: string }[] = [];
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const name = m[2].toLowerCase();
      if (!m[1]) {
        stack.push({ from: m.index, to: m.index + m[0].length, name });
        continue;
      }
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].name !== name) continue;
        const start = stack[k];
        stack.length = k;
        if (m.index > start.to) {
          runs.push({
            outerFrom: start.from,
            innerFrom: start.to,
            innerTo: m.index,
            outerTo: m.index + m[0].length,
            open: text.slice(start.from, start.to),
            close: m[0],
          });
        }
        break;
      }
    }
  }
  return runs.sort((a, b) => a.outerFrom - b.outerFrom);
}

/** The run whose text (markers included) holds `[from, to]`, if any. */
function runAround(runs: readonly FormatRun[], from: number, to: number): FormatRun | null {
  return runs.find((run) => run.outerFrom <= from && to <= run.outerTo) ?? null;
}

/**
 * Whether the selection (or caret) sits in this format — the pressed state
 * of a toolbar button. True inside a run, on its markers, or when the
 * selection is the run itself.
 */
export function formatActiveIn(text: string, from: number, to: number, format: InlineFormat): boolean {
  const start = Math.max(0, Math.min(from, text.length));
  const end = Math.max(start, Math.min(to, text.length));
  const sel = start === end ? { from: start, to: end } : trimRange(text, start, end);
  return runAround(runsOf(text, format), sel.from, sel.to) !== null;
}

/** Back over whitespace from `pos`, no further than `floor`. */
function backOverSpace(text: string, pos: number, floor: number): number {
  while (pos > floor && /\s/.test(text[pos - 1])) pos--;
  return pos;
}

/** Forward over whitespace from `pos`, no further than `ceil`. */
function overSpace(text: string, pos: number, ceil: number): number {
  while (pos < ceil && /\s/.test(text[pos])) pos++;
  return pos;
}

/**
 * Take `[from, to]` out of `run` — the part becomes plain, what is left of the
 * run on either side keeps its markers, and whitespace at the cut moves
 * outside them (GFM does not read `**a **` as bold). A caret gets the pair
 * closed and reopened around it, so typing there is plain text.
 */
function splitRunEdit(text: string, run: FormatRun, from: number, to: number): FormatEdit {
  const { innerFrom, innerTo, open, close } = run;
  if (from === to) {
    if (from <= innerFrom) return { changes: [], selection: { from: run.outerFrom, to: run.outerFrom } };
    if (from >= innerTo) return { changes: [], selection: { from: run.outerTo, to: run.outerTo } };
    return {
      changes: [{ from, to: from, insert: close + open }],
      selection: { from: from + close.length, to: from + close.length },
    };
  }
  const closeAt = backOverSpace(text, from, innerFrom);
  const openAt = overSpace(text, to, innerTo);
  const keepHead = closeAt > innerFrom;
  const keepTail = openAt < innerTo;
  const changes: TextChange[] = [];
  let shift = 0;
  if (keepHead) {
    changes.push({ from: closeAt, to: closeAt, insert: close });
    shift += close.length;
  } else {
    changes.push({ from: run.outerFrom, to: innerFrom, insert: '' });
    shift -= open.length;
  }
  if (keepTail) changes.push({ from: openAt, to: openAt, insert: open });
  else changes.push({ from: innerTo, to: run.outerTo, insert: '' });
  return { changes, selection: { from: from + shift, to: to + shift } };
}

/**
 * Toggle one inline format over `[from, to)` of `text`.
 *
 * Off when the selection is a run (markers inside it) or a run's text
 * (markers just outside it) — both mean "turn this off"; off for the
 * selected PART of a run by splitting it (`splitRunEdit`); on otherwise.
 */
export function inlineFormatEdit(
  text: string,
  from: number,
  to: number,
  format: InlineFormat,
): FormatEdit {
  const { open, close } = INLINE_MARKS[format];
  const start = Math.max(0, Math.min(from, text.length));
  const end = Math.max(start, Math.min(to, text.length));

  const inner = start === end ? { from: start, to: end } : trimRange(text, start, end);
  const run = runAround(runsOf(text, format), inner.from, inner.to);
  if (run) {
    // The whole run, markers or not: off. Checked on the run rather than on
    // the plain marker strings so a `<mark>` run or a coloured `==…=={.x}` run
    // loses its whole closer, attribute included.
    const whole =
      (inner.from <= run.innerFrom && inner.to >= run.innerTo) ||
      (inner.from === run.outerFrom && inner.to === run.outerTo);
    if (whole && inner.from < inner.to) {
      return {
        changes: [
          { from: run.outerFrom, to: run.innerFrom, insert: '' },
          { from: run.innerTo, to: run.outerTo, insert: '' },
        ],
        selection: { from: run.outerFrom, to: run.innerTo - run.open.length },
      };
    }
    // On a marker (caret or selection touching it): treat as the visible edge.
    const s = Math.max(run.innerFrom, Math.min(inner.from, run.innerTo));
    const e = Math.max(run.innerFrom, Math.min(inner.to, run.innerTo));
    return splitRunEdit(text, run, s, e);
  }

  // No run of this format here (`***x***` is bold+italic, not a bold run):
  // the plain marker strings still decide the two exact-match cases.
  const selected = text.slice(start, end);
  if (
    selected.length >= open.length + close.length &&
    selected.startsWith(open) &&
    selected.endsWith(close) &&
    !doubled(open, selected.slice(0, 2), selected.slice(-2))
  ) {
    return {
      changes: [
        { from: start, to: start + open.length, insert: '' },
        { from: end - close.length, to: end, insert: '' },
      ],
      selection: { from: start, to: end - open.length - close.length },
    };
  }

  if (
    start >= open.length &&
    text.slice(start - open.length, start) === open &&
    text.slice(end, end + close.length) === close &&
    !doubled(open, text.slice(Math.max(0, start - 2), start), text.slice(end, end + 2))
  ) {
    return {
      changes: [
        { from: start - open.length, to: start, insert: '' },
        { from: end, to: end + close.length, insert: '' },
      ],
      selection: { from: start - open.length, to: end - open.length },
    };
  }

  // Wrapping a selection that carries its own padding would put the markers
  // around the spaces, which GFM then refuses to read as emphasis at all.
  return {
    changes: [
      { from: inner.from, to: inner.from, insert: open },
      { from: inner.to, to: inner.to, insert: close },
    ],
    selection: { from: inner.from + open.length, to: inner.to + open.length },
  };
}

/* ------------------------------------------------------------- highlight -- */

/** `==` plus the colour attribute a token needs; yellow is the default and is written plain. */
export function highlightMarks(color: BgToken | null): InlineMarks {
  return { open: '==', close: color && color !== 'yellow' ? `=={.${color}}` : '==' };
}

/** The colour of the highlight run the selection sits in: a token, `null` for the default, `undefined` when not highlighted. */
export function highlightColorAt(text: string, from: number, to: number): BgToken | null | undefined {
  const start = Math.max(0, Math.min(from, text.length));
  const end = Math.max(start, Math.min(to, text.length));
  const sel = start === end ? { from: start, to: end } : trimRange(text, start, end);
  const run = runAround(runsOf(text, 'highlight'), sel.from, sel.to);
  if (!run) return undefined;
  return run.color ?? null;
}

/**
 * Paint `[from, to)` with a highlight colour (`null` = the default yellow).
 * Inside an existing run the run is rewritten: the selected part gets the
 * colour, what is left on either side keeps the run's own — so a word in the
 * middle of a green sentence can go red. Legacy `<mark>` runs come out as
 * `==…==` too. Outside any run it wraps like `inlineFormatEdit` would.
 */
export function highlightColorEdit(text: string, from: number, to: number, color: BgToken | null): FormatEdit {
  const marks = highlightMarks(color);
  const start = Math.max(0, Math.min(from, text.length));
  const end = Math.max(start, Math.min(to, text.length));
  const sel = start === end ? { from: start, to: end } : trimRange(text, start, end);
  const run = runAround(runsOf(text, 'highlight'), sel.from, sel.to);
  if (!run) {
    return {
      changes: [
        { from: sel.from, to: sel.from, insert: marks.open },
        { from: sel.to, to: sel.to, insert: marks.close },
      ],
      selection: { from: sel.from + marks.open.length, to: sel.to + marks.open.length },
    };
  }
  const own = highlightMarks(run.color ?? null);
  const s = Math.max(run.innerFrom, Math.min(sel.from, run.innerTo));
  const e = Math.max(run.innerFrom, Math.min(sel.to, run.innerTo));
  // A caret or a selection covering the run: recolour the whole run.
  const whole = s === e || (s <= run.innerFrom && e >= run.innerTo);
  const midFrom = whole ? run.innerFrom : s;
  const midTo = whole ? run.innerTo : e;
  const head = text.slice(run.innerFrom, midFrom).trimEnd();
  const gapBefore = text.slice(run.innerFrom + head.length, midFrom);
  const mid = text.slice(midFrom, midTo);
  const tail = text.slice(midTo, run.innerTo).trimStart();
  const gapAfter = text.slice(midTo, run.innerTo - tail.length);
  const before = head ? `${own.open}${head}${own.close}${gapBefore}` : gapBefore;
  const after = tail ? `${gapAfter}${own.open}${tail}${own.close}` : gapAfter;
  const insert = `${before}${marks.open}${mid}${marks.close}${after}`;
  const midAt = run.outerFrom + before.length + marks.open.length;
  return {
    changes: [{ from: run.outerFrom, to: run.outerTo, insert }],
    selection: whole && s === e
      ? { from: midAt + (s - run.innerFrom), to: midAt + (s - run.innerFrom) }
      : { from: midAt, to: midAt + mid.length },
  };
}

/* ------------------------------------------------------------------ link -- */

/**
 * The words a link is written with when the author has not supplied them yet.
 * Plain latin markup placeholders, like the `![${alt}](${path.png})` entry in
 * block-commands.ts — they are never read as prose, only ever typed over.
 */
export const LINK_PLACEHOLDER = { text: 'text', url: 'url' } as const;

/** A selection that could only have been meant as a target, not as a label. */
const URL_LIKE = /^(?:[a-z][a-z\d+.-]*:|\/\/|\/|#|www\.)\S*$/i;

/**
 * Turn `[from, to)` into a markdown link, and leave the selection on whichever
 * half the author still has to type.
 *
 * Three cases, one rule ("select what is still a placeholder"):
 *  - a word selected  -> `[word](url)`, `url` selected;
 *  - a URL selected   -> `[text](that-url)`, `text` selected — pasting a link
 *    and wrapping it is the other half of this gesture, and the label is then
 *    the missing part;
 *  - nothing selected -> `[text](url)`, `text` selected.
 *
 * Pure, like every other edit here, so the CodeMirror document and a table
 * cell's `<textarea>` get exactly the same behaviour out of it.
 */
export function linkEdit(text: string, from: number, to: number): FormatEdit {
  const start = Math.max(0, Math.min(from, text.length));
  const end = Math.max(start, Math.min(to, text.length));
  const inner = start === end ? { from: start, to: end } : trimRange(text, start, end);
  const selected = text.slice(inner.from, inner.to);

  const isUrl = selected !== '' && URL_LIKE.test(selected);
  const labelIsPlaceholder = selected === '' || isUrl;
  const label = labelIsPlaceholder ? LINK_PLACEHOLDER.text : selected;
  const target = isUrl ? selected : LINK_PLACEHOLDER.url;

  // `[label](target)` — the label starts one character in, the target three
  // characters past the end of the label.
  const labelAt = inner.from + 1;
  const targetAt = labelAt + label.length + 2;
  return {
    changes: [{ from: inner.from, to: inner.to, insert: `[${label}](${target})` }],
    selection: labelIsPlaceholder
      ? { from: labelAt, to: labelAt + label.length }
      : { from: targetAt, to: targetAt + target.length },
  };
}

/* ------------------------------------------------------ paste a link over -- */

/** Exactly one address, no whitespace and no angle brackets inside. */
const SINGLE_URL = /^https?:\/\/[^\s<>]+$/i;
/** `www.example.com` — what @codemirror/lang-markdown's own paste-as-link took, and wrote with `https://` in front. */
const WWW_URL = /^www\.[^\s<>]+$/i;
const MAILTO_URL = /^mailto:[^\s<>@]+@[^\s<>]+$/i;

/** A selection that already is an address: wrapping it would nest one address in another. */
const ADDRESS_SELECTION = /^(?:https?:\/\/|www\.|mailto:)\S+$/i;

/**
 * What a list item, quote or heading writes before its text. A selection that
 * starts on that marker (`field.select()` in a table cell does) is only ever
 * meant to cover the words after it.
 */
const LINE_PREFIX =
  /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+•·◦]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|\[[ xX]\][ \t]+|#{1,6}[ \t]+)?/;

/**
 * The link target for a clipboard whose plain text is exactly ONE address
 * (surrounding whitespace and the trailing newline a terminal adds are
 * ignored); null for anything else, which is then pasted as ordinary text.
 *
 * `http(s)://…` is taken as it is. `www.…` gets `https://` in front and
 * `mailto:` stays — both are what the markdown language package's own
 * paste-as-link accepted before this took its place (see markdown-setup.ts).
 */
export function pastedUrl(clipboard: string): string | null {
  const value = clipboard.trim();
  if (MAILTO_URL.test(value)) return value;
  const target = WWW_URL.test(value) ? `https://${value}` : value;
  if (!SINGLE_URL.test(target)) return null;
  try {
    return new URL(target).hostname ? target : null;
  } catch {
    return null;
  }
}

interface InlineSpan {
  from: number;
  to: number;
  kind: 'link' | 'code';
}

const BARE_ADDRESS = /(?:https?:\/\/|www\.)[^\s<>]+/gi;
const AUTOLINK = /<(?:https?|mailto|ftp):[^\s<>]*>/gi;
const HTML_ANCHOR = /<a\s[^>]*>[\s\S]*?<\/a>/gi;
const HTML_IMAGE = /<img\b[^>]*>/gi;

/** Index just past the `)` that closes the inline link whose `[` is at `open`, or -1 when it is not one. */
function inlineLinkEnd(text: string, open: number): number {
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '[') depth++;
    else if (text[i] === ']' && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0 || text[close + 1] !== '(') return -1;
  let at = close + 2;
  // `<…>` destinations may hold parentheses; the closer comes after them.
  if (text[at] === '<') {
    const angle = text.indexOf('>', at + 1);
    if (angle < 0) return -1;
    at = angle + 1;
  }
  let parens = 1;
  for (; at < text.length; at++) {
    if (text[at] === '\\') {
      at++;
      continue;
    }
    if (text[at] === '(') parens++;
    else if (text[at] === ')' && --parens === 0) return at + 1;
  }
  return -1;
}

/** Inline code spans, links, images and bare addresses of one line, with their source ranges. */
function inlineSpans(line: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  for (let i = 0; i < line.length; ) {
    const ch = line[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') {
      let run = i;
      while (line[run] === '`') run++;
      const size = run - i;
      let close = -1;
      for (let k = run; k < line.length && close < 0; ) {
        if (line[k] !== '`') {
          k++;
          continue;
        }
        let end = k;
        while (line[end] === '`') end++;
        if (end - k === size) close = end;
        k = end;
      }
      if (close < 0) {
        i = run;
        continue;
      }
      spans.push({ from: i, to: close, kind: 'code' });
      i = close;
      continue;
    }
    if (ch === '[') {
      const end = inlineLinkEnd(line, i);
      if (end > 0) {
        spans.push({ from: i > 0 && line[i - 1] === '!' ? i - 1 : i, to: end, kind: 'link' });
        i = end;
        continue;
      }
    }
    i++;
  }
  for (const pattern of [BARE_ADDRESS, AUTOLINK, HTML_ANCHOR, HTML_IMAGE]) {
    for (const match of line.matchAll(pattern)) {
      spans.push({ from: match.index, to: match.index + match[0].length, kind: 'link' });
    }
  }
  return spans;
}

/** `[` and `]` in `label` pair up (escaped ones aside) and it does not end on a lone backslash. */
function labelIsSafe(label: string): boolean {
  let depth = 0;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      if (i === label.length - 1) return false;
      i++;
      continue;
    }
    if (label[i] === '[') depth++;
    else if (label[i] === ']' && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * Paste a URL over a selection: `[selected text](url)`, the way Confluence and
 * Google Docs do it, instead of replacing the text with the address.
 *
 * Returns null whenever the plain replacement is the right behaviour — the
 * caller then lets the paste through untouched:
 *  - nothing is selected, or only blanks;
 *  - the selection spans lines (a table cell value is lines too);
 *  - the selection is itself an address, or touches an existing link, image,
 *    bare address or raw HTML anchor — links never nest;
 *  - the selection is inside inline code, or cuts a code span or an emphasis
 *    pair in two (the link would straddle the markers);
 *  - the text has stray brackets that would end the label early.
 * Formatting the selection fully contains (`**bold**`) is kept as the label;
 * a selection that stops at the visible edge of a run (a table cell hides its
 * markers) is widened over the marker first. The destination is written like
 * every other link target here, through `formatLinkTarget`, so a `)` in the
 * address gets the `<…>` form.
 *
 * Pure, like every edit in this file: one rule for the CodeMirror document in
 * both modes and for a table cell's text field.
 */
export function linkOverSelectionEdit(text: string, from: number, to: number, url: string): FormatEdit | null {
  const start = Math.max(0, Math.min(from, text.length));
  const end = Math.max(0, Math.min(to, text.length));
  if (start >= end) return null;

  const lineFrom = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
  const newline = text.indexOf('\n', lineFrom);
  const lineTo = newline < 0 ? text.length : newline;
  if (end > lineTo) return null;

  const line = text.slice(lineFrom, lineTo);
  const prefix = LINE_PREFIX.exec(line)?.[0].length ?? 0;
  const trimmed = trimRange(text, Math.max(start, lineFrom + prefix), end);
  if (!text.slice(trimmed.from, trimmed.to).trim()) return null;

  // The marker is blanked out, not cut: offsets stay aligned and a bullet `*`
  // can no longer pair up with an emphasis `*` further along.
  const scan = ' '.repeat(prefix) + line.slice(prefix);
  let selFrom = trimmed.from - lineFrom;
  let selTo = trimmed.to - lineFrom;

  // A table cell hides its markers, so a selection that covers the VISIBLE
  // text of a run ends at the inner edge, not past the marker. Widen it over
  // the marker: a selection reading `a **bold` was meant as `a **bold**`.
  const runs = (['bold', 'italic', 'underline', 'strike', 'highlight', 'code'] as const).flatMap((format) =>
    runsOf(scan, format),
  );
  for (const run of runs) {
    if (selTo === run.innerTo && selFrom <= run.outerFrom) selTo = run.outerTo;
    else if (selFrom === run.innerFrom && selTo >= run.outerTo) selFrom = run.outerFrom;
  }

  const label = line.slice(selFrom, selTo);
  if (ADDRESS_SELECTION.test(label) || !labelIsSafe(label)) return null;

  for (const span of inlineSpans(scan)) {
    if (span.from >= selTo || selFrom >= span.to) continue;
    if (span.kind === 'link') return null;
    if (selFrom > span.from || selTo < span.to) return null;
  }
  for (const run of runs) {
    if (run.outerFrom >= selTo || selFrom >= run.outerTo) continue;
    const inside = run.innerFrom <= selFrom && selTo <= run.innerTo;
    const whole = selFrom <= run.outerFrom && run.outerTo <= selTo;
    if (!inside && !whole) return null;
  }

  const insert = `[${label}](${formatLinkTarget(url)})`;
  const caret = lineFrom + selFrom + insert.length;
  return {
    changes: [{ from: lineFrom + selFrom, to: lineFrom + selTo, insert }],
    selection: { from: caret, to: caret },
  };
}

/* ------------------------------------------------------------ block quote -- */

const QUOTE_PREFIX = /^[ \t]*>[ \t]?/;

/** Line starts covered by `[from, to)`, the way a block command sees them. */
function lineStarts(text: string, from: number, to: number): number[] {
  const out: number[] = [];
  let at = text.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
  for (;;) {
    out.push(at);
    const next = text.indexOf('\n', at);
    // The next line starts at `next + 1`; a selection that ends exactly there
    // has not reached into it, so it is not part of the block.
    if (next === -1 || next + 1 >= to) break;
    at = next + 1;
  }
  return out;
}

/**
 * Toggle `> ` over every line the selection touches. Off only when *all* of
 * them are already quoted — a partially quoted selection means the author wants
 * the rest quoted too.
 *
 * Cells never get this one: a block construct cannot live inside a pipe row.
 */
export function quoteEdit(text: string, from: number, to: number): FormatEdit {
  const starts = lineStarts(text, from, to);
  if (starts.length === 0) return NO_EDIT;

  const lines = starts.map((start) => {
    const end = text.indexOf('\n', start);
    return text.slice(start, end === -1 ? text.length : end);
  });
  const quoted = lines.every((line) => QUOTE_PREFIX.test(line));

  const changes: TextChange[] = [];
  let shiftFrom = 0;
  let shiftTo = 0;

  starts.forEach((start, index) => {
    const marker = quoted ? (QUOTE_PREFIX.exec(lines[index]) as RegExpExecArray)[0] : '> ';
    const delta = quoted ? -marker.length : marker.length;
    if (quoted) changes.push({ from: start, to: start + marker.length, insert: '' });
    else changes.push({ from: start, to: start, insert: marker });
    if (start <= from) shiftFrom += delta;
    shiftTo += delta;
  });

  const end = Math.max(0, to + shiftTo);
  return {
    changes,
    selection: { from: Math.max(0, Math.min(from + shiftFrom, end)), to: end },
  };
}
