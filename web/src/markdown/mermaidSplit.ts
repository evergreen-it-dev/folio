import { stripFrontmatter } from './frontmatter';

/**
 * Splits a markdown document into alternating text/mermaid segments on
 * top-level ```mermaid fences, so the caller can run the unified pipeline
 * over the text segments and hand the mermaid segments to <MermaidBlock>
 * (a real React island, not something the string-based pipeline can produce).
 *
 * "Top-level" means: not nested inside another fenced code block. A fence
 * marker is a line (indented up to 3 spaces, per CommonMark) of 3+ backticks
 * or tildes; the matching close is the next line with a run of the same
 * character at least as long, alone on its line. An unterminated fence runs
 * to the end of the document (matches CommonMark's own fallback).
 */

export interface TextSegment {
  type: 'text';
  value: string;
}

export interface MermaidSegment {
  type: 'mermaid';
  code: string;
}

export type MarkdownSegment = TextSegment | MermaidSegment;

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)/;

export function splitMermaidFences(rawMarkdown: string): MarkdownSegment[] {
  // Round 5: a page's frontmatter block (icon/cover) round-trips through
  // this same `markdown` string — strip it before splitting so it never
  // ends up rendered as garbage in segment 0. See frontmatter.ts.
  const markdown = stripFrontmatter(rawMarkdown);
  const lines = markdown.split(/\r\n|\r|\n/);
  const segments: MarkdownSegment[] = [];
  let textLines: string[] = [];
  let i = 0;

  const flushText = () => {
    segments.push({ type: 'text', value: textLines.join('\n') });
    textLines = [];
  };

  while (i < lines.length) {
    const match = lines[i].match(FENCE_OPEN_RE);
    if (!match) {
      textLines.push(lines[i]);
      i++;
      continue;
    }

    const [, marker, info] = match;
    const fenceChar = marker[0];
    const closeRe = new RegExp(`^ {0,3}${fenceChar}{${marker.length},}[ \\t]*$`);
    // Only the first whitespace-delimited token of the info string is the
    // language, same convention as CommonMark code-fence highlighting.
    const isMermaid = info.trim().split(/\s+/)[0]?.toLowerCase() === 'mermaid';

    let j = i + 1;
    const body: string[] = [];
    while (j < lines.length && !closeRe.test(lines[j])) {
      body.push(lines[j]);
      j++;
    }
    const closed = j < lines.length; // false = unterminated fence, ran to EOF

    if (isMermaid) {
      flushText();
      segments.push({ type: 'mermaid', code: body.join('\n') });
    } else {
      // Not mermaid: keep the fence verbatim as text so any ```mermaid
      // written *inside* it (e.g. a doc explaining the syntax) is not split.
      textLines.push(lines[i], ...body);
      if (closed) textLines.push(lines[j]);
    }

    i = closed ? j + 1 : lines.length;
  }
  flushText();

  // Drop blank text segments introduced by splitting, but never collapse a
  // plain (no mermaid) document down to nothing.
  if (segments.length === 1) return segments;
  return segments.filter((s) => s.type !== 'text' || s.value.trim() !== '');
}
