/**
 * `:status[Selected]{color=green}` — the inline status tag (a Confluence-style
 * lozenge). Plain TS with no DOM, importable from `web` (reading pipeline, live
 * editor), `server` (search index, PDF/DOCX export, Confluence import) alike.
 *
 * SYNTAX CHOICE: a generic text directive, because `remark-directive` is
 * already the reading pipeline's parser for `::pagetree` / `::form`
 * (web/src/markdown/pipeline.ts), so no new parser is needed there, and
 * `docs/spec.md` §3.2 reserved a `status` directive from the start. The text
 * form `:name[label]{attrs}` is the one remark-directive accepts for inline
 * content (the spec's old `::status{…}Text::` sketch is not parseable).
 * Outside Folio the source degrades to readable text — `:status[Selected]` —
 * and the label is always the first thing in it.
 *
 * The text is stored exactly as typed; upper case is a presentation detail
 * (`text-transform: uppercase` in the stylesheets), so search, export and
 * copy/paste keep the original characters.
 */

/** Confluence's six lozenge colours, in palette order. `grey` is the default. */
export const STATUS_COLORS = ['grey', 'blue', 'green', 'yellow', 'red', 'purple'] as const;
export type StatusColor = (typeof STATUS_COLORS)[number];
export const DEFAULT_STATUS_COLOR: StatusColor = 'grey';

/**
 * Anything that is not a palette colour — a typo, a colour removed later, no
 * attribute at all — renders grey rather than failing the render. `gray` (the
 * American spelling, which the highlight palette uses) is accepted as grey.
 */
export function resolveStatusColor(raw: string | null | undefined): StatusColor {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'gray') return 'grey';
  return (STATUS_COLORS as readonly string[]).includes(value) ? (value as StatusColor) : DEFAULT_STATUS_COLOR;
}

/**
 * Light-theme lozenge colours (background / text), for the surfaces that cannot
 * read the app's stylesheet: the PDF print document and DOCX runs. Kept equal to
 * the values in web/src/markdown/status.css by hand.
 */
export const STATUS_PALETTE: Record<StatusColor, { bg: string; fg: string }> = {
  grey: { bg: '#dfe1e6', fg: '#42526e' },
  blue: { bg: '#deebff', fg: '#0747a6' },
  green: { bg: '#e3fcef', fg: '#006644' },
  yellow: { bg: '#fff0b3', fg: '#5e4500' },
  red: { bg: '#ffebe6', fg: '#bf2600' },
  purple: { bg: '#eae6ff', fg: '#403294' },
};

/** Class list of the rendered badge, everywhere: `folio-status folio-status--green`. */
export function statusClassNames(color: string | null | undefined): string[] {
  return ['folio-status', `folio-status--${resolveStatusColor(color)}`];
}

/** `{color=green}` / `{color="green"}` / `{color='green'}` -> `green`; null when no colour is given. */
export function parseStatusAttrs(attrs: string | null | undefined): string | null {
  if (!attrs) return null;
  const match = /(?:^|[\s,])colou?r\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`}]+))/i.exec(attrs);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null;
}

/* ------------------------------------------------------------------ escaping */

/**
 * Characters the label must escape so the directive stays one inline unit and
 * its text renders verbatim in remark (the label of a text directive is parsed
 * as markdown): the backslash, brackets, emphasis/code/strike markers, `<`
 * (raw HTML) and `&` (character references). Everything else is stored as is.
 */
const LABEL_ESCAPE_RE = /[\\[\]*_`~<&]/g;
const LABEL_UNESCAPE_RE = /\\([\\[\]*_`~<&])/g;

/** Collapses line breaks and runs of whitespace: a status is a single inline word group. */
export function cleanStatusLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim();
}

export function escapeStatusLabel(label: string): string {
  return cleanStatusLabel(label).replace(LABEL_ESCAPE_RE, '\\$&');
}

export function unescapeStatusLabel(raw: string): string {
  return raw.replace(LABEL_UNESCAPE_RE, '$1');
}

/** The markdown for one tag. Grey is the default, so it is written without attributes. */
export function serializeStatus(label: string, color: string | null | undefined = DEFAULT_STATUS_COLOR): string {
  const resolved = resolveStatusColor(color);
  const attrs = resolved === DEFAULT_STATUS_COLOR ? '' : `{color=${resolved}}`;
  return `:status[${escapeStatusLabel(label)}]${attrs}`;
}

/* ------------------------------------------------------------------- parsing */

/** Source form: label = escaped characters or anything but `]`/newline. Sticky/anchored use only. */
const STATUS_SOURCE = String.raw`:status\[((?:\\.|[^\]\\\n])*)\](?:\{([^}\n]*)\})?`;

export interface ParsedStatus {
  /** Label with escapes resolved — what the badge shows (before the CSS upper-casing). */
  label: string;
  color: StatusColor;
  /** Source length, `:status[` through the closing `}` or `]`. */
  length: number;
}

/** Parses a tag that STARTS at the beginning of `text`, or returns null. */
export function parseStatusAt(text: string): ParsedStatus | null {
  const match = new RegExp(`^${STATUS_SOURCE}`).exec(text);
  if (!match) return null;
  return {
    label: unescapeStatusLabel(match[1]),
    color: resolveStatusColor(parseStatusAttrs(match[2])),
    length: match[0].length,
  };
}

/**
 * Plain text for search and snippets: every tag becomes its label. This is a
 * flat regex pass over raw markdown (it does not know about code fences), which
 * is the right trade for an index — a `:status[x]` shown inside a code sample
 * is indexed as `x`, and nothing is ever lost from the document itself.
 */
export function stripStatusDirectives(markdown: string): string {
  if (!markdown.includes(':status[')) return markdown;
  return markdown.replace(new RegExp(STATUS_SOURCE, 'g'), (_whole, label: string) => unescapeStatusLabel(label));
}

/**
 * Same match on text that remark-parse has ALREADY decoded (escapes resolved,
 * so the label is bare text with at most one level of balanced brackets).
 * Used by the export pipelines, which do not run remark-directive: there a tag
 * is still sitting inside a text node. Global; capture 1 = label, 2 = attrs.
 */
export const DECODED_STATUS_RE = /:status\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\](?:\{([^}\n]*)\})?/g;

/* --------------------------------------------------------------- mdast pass */

interface MdastLike {
  type: string;
  value?: string;
  children?: MdastLike[];
  data?: Record<string, unknown>;
}

/**
 * A remark plugin for the export pipelines (PDF print), which — unlike the
 * reading view — do not run remark-directive: `:status[Text]{color=…}` is
 * still sitting inside a `text` node there. It splits such nodes and puts a
 * `folioStatus` node in the gap, hinted (`data.hName`) to render as
 * `<span class="folio-status folio-status--…">`. Code and raw HTML are
 * different node types and never reach it.
 */
export function remarkStatusInText() {
  const walk = (parent: MdastLike): void => {
    if (!parent.children) return;
    const next: MdastLike[] = [];
    for (const child of parent.children) {
      if (child.type !== 'text' || !child.value?.includes(':status[')) {
        walk(child);
        next.push(child);
        continue;
      }
      let last = 0;
      for (const match of child.value.matchAll(DECODED_STATUS_RE)) {
        const label = cleanStatusLabel(match[1]);
        if (!label) continue;
        if (match.index > last) next.push({ type: 'text', value: child.value.slice(last, match.index) });
        next.push({
          type: 'folioStatus',
          children: [{ type: 'text', value: label }],
          data: { hName: 'span', hProperties: { className: statusClassNames(parseStatusAttrs(match[2])) } },
        });
        last = match.index + match[0].length;
      }
      if (last < child.value.length) next.push({ type: 'text', value: child.value.slice(last) });
    }
    parent.children = next;
  };
  return (tree: MdastLike): void => walk(tree);
}
