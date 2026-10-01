import type { Parent, Paragraph, Root, RootContent, Text } from 'mdast';

/**
 * Inline glossary terms — Markdown Extra's abbreviation syntax:
 *
 *   *[Octopus]: An eight-armed sea animal
 *
 * A declaration line disappears from the rendered output; every later
 * occurrence of the term ("Octopus", any casing, whole words only) anywhere
 * on the page is wrapped in `<abbr title="An eight-armed sea animal">Octopus</abbr>`
 * so hovering shows the description — no JS, no custom tooltip, works in a
 * plain `<abbr>` the way it works on any web page (see markdown.css for the
 * "not shown loudly" styling and pipeline.ts for where this sits in the
 * chain). This is a remark (mdast) plugin, not a rehype one, so it can use
 * `data.hName`/`data.hProperties` the same way alerts.ts does — mdast-util-
 * to-hast swaps the tag/attributes in when it builds the hast tree, so no
 * raw HTML is ever inserted (see that file's doc comment for the mechanism).
 *
 * Scope is one page (renderMarkdownToHtml never sees more than one page's
 * markdown at a time — see pipeline.ts), matching the owner's ask: a term
 * declared on page A means nothing on page B.
 */

export interface GlossaryTerm {
  term: string;
  description: string;
}

/**
 * One declaration, alone on its line: `*[Term]: description`. The `*[` /
 * `]:` pair is not otherwise meaningful CommonMark (unlike a bare
 * `[label]:`, the leading `*` stops it from ever being parsed as a real
 * link-reference definition), so remark hands it to us as plain paragraph
 * text — this is the line-level pattern we look for inside that text.
 */
const DECLARATION_LINE = /^\*\[([^\]]+)\]:[ \t]*(.+)$/;

/** Escapes a term for use inside the alternation built by `buildTermRegex`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strips every declaration line out of one paragraph's text children,
 * collecting `{term, description}` pairs as it goes. Line-level, not
 * paragraph-level: several declarations in a row (the common "put them all
 * at the bottom" layout) parse as soft-wrapped lines of ONE paragraph text
 * node, and a declaration can just as easily share a paragraph with ordinary
 * prose — so this only ever removes the matching *lines*, never a whole
 * text node unless every one of its lines was a declaration.
 */
function stripParagraphDeclarations(paragraph: Paragraph, terms: GlossaryTerm[]): void {
  for (let i = paragraph.children.length - 1; i >= 0; i--) {
    const child = paragraph.children[i];
    if (child.type !== 'text') continue; // a declaration is bare text, never e.g. **bold**

    const lines = child.value.split('\n');
    let sawDeclaration = false;
    const kept: string[] = [];
    for (const line of lines) {
      const match = DECLARATION_LINE.exec(line);
      if (!match) {
        kept.push(line);
        continue;
      }
      sawDeclaration = true;
      const term = match[1].trim();
      const description = match[2].trim();
      if (term && description) terms.push({ term, description });
    }
    if (!sawDeclaration) continue;

    const value = kept.join('\n');
    if (value.length === 0) {
      paragraph.children.splice(i, 1);
    } else {
      (child as Text).value = value;
    }
  }
}

/**
 * Depth-first removal pass: finds every paragraph in the tree (declarations
 * can sit anywhere — inside a blockquote or list item too, not just at the
 * top level) and strips its declaration lines; a paragraph left with no
 * children (it WAS a declaration, alone) is removed from its parent so
 * nothing renders in its place — matching how alerts.ts's remarkAlerts
 * removes a fully-consumed marker paragraph from its blockquote.
 */
function stripDeclarations(children: RootContent[], terms: GlossaryTerm[]): void {
  for (let i = children.length - 1; i >= 0; i--) {
    const node = children[i];
    if (node.type === 'paragraph') {
      stripParagraphDeclarations(node, terms);
      if (node.children.length === 0) children.splice(i, 1);
      continue; // a paragraph's children are inline content, never nested paragraphs
    }
    if ('children' in node && Array.isArray((node as unknown as Parent).children)) {
      stripDeclarations((node as unknown as Parent).children as RootContent[], terms);
    }
  }
}

/** Tags whose text is never glossary-lit — see rehypeGlossary-equivalent skip list in mentions.ts for the code/pre precedent; link + heading are this plugin's own additions per the spec. */
const SKIP_TYPES = new Set([
  'code', // fenced/indented block — literal content, not prose
  'inlineCode', // `` `code` `` — same reason, just inline
  'link', // a link's visible text stays exactly what the author wrote
  'linkReference', // ditto, for `[text][ref]` links
  'heading', // headings are structural, not runs of hover-able prose
  'definition', // `[ref]: url` — not visible text at all
  'footnoteDefinition',
]);

/** One term compiled into the alternation, plus its description for lookup by matched text. */
interface TermMatcher {
  regex: RegExp;
  byLowerCase: Map<string, string>;
}

/**
 * Compiles every declared term into one alternation, longest term first —
 * JS regex alternation tries branches left-to-right and stops at the first
 * one that matches at a given position, so ordering by descending length is
 * what makes "Octopus Prime" win over "Octopus" when both are declared and
 * the text says "Octopus Prime". Word boundaries are unicode-aware
 * lookaround (terms may be non-Latin), matching the style of mentions.ts's
 * `BLOCKED_BEFORE` but on both sides, since a term isn't anchored to `@`.
 * Case-insensitive ('i'); the matched text itself (original casing) is what
 * ends up on the page, only the lookup key is lower-cased.
 */
function buildTermMatcher(terms: GlossaryTerm[]): TermMatcher | null {
  if (terms.length === 0) return null;
  const sorted = [...terms].sort((a, b) => b.term.length - a.term.length);
  const byLowerCase = new Map<string, string>();
  for (const { term, description } of sorted) {
    byLowerCase.set(term.toLowerCase(), description); // last declaration of a repeated term wins
  }
  const alternation = sorted.map((t) => escapeRegExp(t.term)).join('|');
  // The declared word is a STEM, not an exact form: many languages inflect
  // (Ukrainian declines nouns by case), so a declared "Octopus" must also
  // highlight "Octopuses" and the case forms of the word (the owner's
  // decision, 11.09). The tail is limited to three letters — exactly as much
  // as case endings need, and too little to catch another word with the same
  // root: "Octopuslike" has four and is not caught. The price is known and
  // deliberate: a short stem can pick up a neighbor ("cat" + "tle"), and
  // then the term is worth declaring longer.
  const regex = new RegExp(`(?<![\\p{L}\\p{N}_])(${alternation})(\\p{L}{0,3})(?![\\p{L}\\p{N}_])`, 'giu');
  return { regex, byLowerCase };
}

/**
 * Splits one text node's value around every glossary term match, or returns
 * null when nothing in it matches (the caller then leaves the original node
 * untouched — same "don't replace with an identical copy" convention as
 * mentions.ts's splitMentionText).
 */
function splitTextForTerms(value: string, matcher: TermMatcher): RootContent[] | null {
  matcher.regex.lastIndex = 0;
  let match = matcher.regex.exec(value);
  if (!match) return null;

  const parts: RootContent[] = [];
  let cursor = 0;
  while (match) {
    const from = match.index;
    const to = from + match[0].length;
    // The description is looked up by the STEM (the first group), because the match also contains the tail.
    const description = matcher.byLowerCase.get(match[1].toLowerCase());
    if (description !== undefined) {
      if (from > cursor) parts.push({ type: 'text', value: value.slice(cursor, from) });
      parts.push({
        type: 'text',
        // Original casing is the matched substring itself — we only ever
        // attach a render hint, never rewrite the text.
        value: value.slice(from, to),
        data: {
          hName: 'abbr',
          hProperties: { className: ['folio-glossary-term'], title: description },
        },
      } as Text);
      cursor = to;
    }
    match = matcher.regex.exec(value);
  }
  if (cursor === 0) return null;
  if (cursor < value.length) parts.push({ type: 'text', value: value.slice(cursor) });
  return parts;
}

/** Depth-first, in place — same shape as mentions.ts's walk, for the same reason: splicing a text node into several requires precise control the visitor pattern doesn't give for free. */
function walkForTerms(children: RootContent[], matcher: TermMatcher): void {
  for (let i = children.length - 1; i >= 0; i--) {
    const node = children[i];
    if (node.type === 'text') {
      const parts = splitTextForTerms(node.value, matcher);
      if (parts) children.splice(i, 1, ...parts);
      continue;
    }
    if (SKIP_TYPES.has(node.type)) continue;
    if ('children' in node && Array.isArray((node as unknown as Parent).children)) {
      walkForTerms((node as unknown as Parent).children as RootContent[], matcher);
    }
  }
}

/**
 * Remark plugin: removes every `*[Term]: description` declaration from the
 * tree, then wraps each later occurrence of a declared term in
 * `<abbr title="description">Term</abbr>` (via hName/hProperties — see this
 * file's own doc comment). No declarations on the page: a plain no-op, the
 * tree isn't walked a second time for nothing.
 */
export function remarkGlossaryTerms() {
  return (tree: Root) => {
    const terms: GlossaryTerm[] = [];
    stripDeclarations(tree.children as RootContent[], terms);

    const matcher = buildTermMatcher(terms);
    if (!matcher) return;
    walkForTerms(tree.children as RootContent[], matcher);
  };
}
