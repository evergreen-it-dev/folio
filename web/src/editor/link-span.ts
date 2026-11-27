/**
 * Where an existing markdown link sits around a selection, so that "make this
 * a link" over the words of a link retargets it instead of nesting a second
 * link inside its label (`[[a](b)](c)`).
 *
 * Pure and line-based, like the other edits in format.ts: the document and a
 * table cell's `<textarea>` both ask it. Reference-style links and a `)` inside
 * an unwrapped address are not recognised; they stay plain text here.
 */

export interface LinkSpan {
  /** Absolute offsets of the whole `[label](target)` in the text given. */
  from: number;
  to: number;
  /** The label as written (markup inside it kept). */
  label: string;
  /** The address without its `<…>` wrapper. */
  target: string;
}

const LINK = /\[((?:\\.|[^\]\\])*)\]\((<[^>\n]*>|[^)\s]*)(?:\s+(?:"[^"]*"|'[^']*'))?\)/g;

/** Every inline link on `line`, images excluded, offsets relative to the line. */
export function linksOnLine(line: string): LinkSpan[] {
  const out: LinkSpan[] = [];
  for (const match of line.matchAll(LINK)) {
    const from = match.index ?? 0;
    if (line[from - 1] === '!') continue;
    const raw = match[2];
    out.push({
      from,
      to: from + match[0].length,
      label: match[1],
      target: raw.startsWith('<') ? raw.slice(1, -1) : raw,
    });
  }
  return out;
}

export type LinkAround =
  /** Selection or caret lies within one link: retarget it. */
  | { kind: 'inside'; span: LinkSpan }
  /** Selection cuts across a link's edge or swallows one: any link here would nest or break. */
  | { kind: 'partial' }
  | null;

/**
 * `text` may hold several lines; `[from, to]` must lie on one of them. Offsets
 * in the answer are into `text`.
 */
export function linkAround(text: string, from: number, to: number): LinkAround {
  const start = text.lastIndexOf('\n', Math.max(0, from) - 1) + 1;
  const newline = text.indexOf('\n', from);
  const line = text.slice(start, newline === -1 ? text.length : newline);
  const a = from - start;
  const b = to - start;
  for (const span of linksOnLine(line)) {
    const inside = a >= span.from && b <= span.to;
    if (a === b) {
      // A caret on the very edge is outside the link.
      if (a > span.from && a < span.to) return { kind: 'inside', span: { ...span, from: span.from + start, to: span.to + start } };
      continue;
    }
    if (inside) return { kind: 'inside', span: { ...span, from: span.from + start, to: span.to + start } };
    if (a < span.to && b > span.from) return { kind: 'partial' };
  }
  return null;
}
