import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkDirective from 'remark-directive';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { remarkAlerts } from './alerts';
import { remarkGlossaryTerms } from './glossaryTerms';
import { remarkDirectiveFallback } from './directiveFallback';
import { rehypeRelativeLinks } from './relativeLinks';
import { rehypeFolioPageLinks } from './rehypeFolioLinks';
import type { FolioPageLinksOptions } from './rehypeFolioLinks';
import { createTableIndexCursor, rehypeWrapTables } from './tables';
import type { TableIndexCursor } from './tables';
import { rehypeCellLists, rehypeTableExtensions } from './tableExtensions';
import { rehypeFlagStrayTables } from './strayTable';
import { rehypeAssignHeadingIds } from './headingIds';
import type { HeadingIdCursor } from './headingIds';
import { rehypeAssignNoteIds, createNoteIdCursor } from './noteIds';
import type { NoteIdCursor } from './noteIds';
import { rehypeCollapsibleSections } from './collapsibleSections';
import { rehypeMentions } from './mentions';
import type { MentionLookup } from './mentions';
import { rehypeHighlight } from '@shared/highlight';
import { folioSanitizeSchema } from './sanitizeSchema';

export interface RenderOptions {
  space: string;
  /** Path of the page being rendered, relative to the space root. */
  pagePath: string;
  /** Round 8: forwarded to rehypeRelativeLinks — see its own doc comment. */
  shareToken?: string;
  /**
   * Round 15: display name for a known `@handle`, undefined for anything
   * else — undefined lookup (list not loaded yet, or the caller has no way
   * to ask, e.g. no space) leaves every `@mention` as plain text. See
   * mentions.ts/mentionIndex.ts for where this comes from in `<Markdown>`.
   */
  mentionLookup?: MentionLookup;
  /**
   * Round 22.09.2026: `window.location.origin`, threaded through so
   * rehypeFolioPageLinks can tell an absolute Folio page URL apart from a
   * foreign one — see its own doc comment and folioLinks.ts's
   * `parseFolioLink`. Undefined (SSR/most tests) means only root-relative
   * `/s/...` links can ever match, never an absolute one.
   */
  origin?: string;
  /** Test-only override for rehypeFolioPageLinks' resolve/hasFailed/ensureResolve — see its own doc comment. Production callers never pass this, defaulting to the real folioLinkIndex.ts cache. */
  folioLinks?: Pick<FolioPageLinksOptions, 'resolve' | 'hasFailed' | 'ensureResolve'>;
}

/**
 * Renders one markdown *segment* (never raw ```mermaid fences — those are
 * split out by `splitMermaidFences` before this runs) to sanitized HTML.
 *
 * Pipeline: remark-parse -> remark-gfm -> remarkAlerts -> remarkGlossaryTerms
 * (glossary terms, round 31: strips `*[Term]: description` declarations and
 * wraps later occurrences of the term in `<abbr title="description">` — see
 * glossaryTerms.ts; runs on mdast, like remarkAlerts, before anything turns
 * this into hast) -> remarkDirective
 * (round 13: parses `::name{attrs}` syntax into leafDirective/
 * containerDirective mdast nodes — doesn't render anything itself, see its
 * own docs) -> remarkDirectiveFallback (sets sanitized fallback text for any
 * directive still in the tree at this point; ::pagetree is normally already
 * gone by here, see that plugin's own comment) -> remark-rehype
 * (allowDangerousHtml, so inline HTML survives as raw nodes) -> rehype-raw
 * (parses those raw nodes into real elements) -> rehypeFolioPageLinks
 * (round 22.09.2026: an absolute/root-relative URL to another Folio page —
 * e.g. a pasted "Copy link" link — becomes an in-app page link
 * showing its title, see rehypeFolioLinks.ts; must run BEFORE
 * rehypeRelativeLinks below, which would otherwise treat it as a plain
 * external link) -> rehypeRelativeLinks (rewrites RELATIVE hrefs/srcs, must
 * see real <a>/<img> elements, so after rehype-raw) -> rehypeTableExtensions (round 17: rebuilds a pipe table's rows
 * from the merge layer the source carries and the `[//]: # (folio-table: …)`
 * metadata line — it re-reads the markdown through the node positions, so it
 * must run while those positions are still the ones remark assigned) ->
 * rehypeCellLists (round 28: the `<br>`-joined marker lines inside a cell —
 * `• …`, `- …`, `1. …` — become a real nested list; which lines count is
 * tableSyntax.ts's parseCellLines, shared verbatim with the editor's grid)
 * -> rehypeWrapTables -> rehypeFlagStrayTables (a pipe table that GFM
 * correctly refused to parse — no blank line before it, so it's lazy
 * continuation text of the preceding paragraph, see strayTable.ts — gets
 * wrapped in a `.folio-stray-table` span so markdown.css can show it as
 * raw/preformatted instead of letting the pipes collapse into unreadable
 * prose) -> rehypeAssignHeadingIds (round 5: see
 * headingIds.ts) -> rehypeAssignNoteIds (notes panel: see noteIds.ts — after
 * rehypeCellLists so it can skip a table's contents wholesale, not merely the
 * plain `<table>` GFM itself produces) -> rehypeCollapsibleSections -> rehypeMentions (round 15:
 * wraps known `@handle` text in `.folio-mention` spans — after every
 * text-shaping pass, so it sees final prose, and before sanitize, so the
 * spans it adds get vetted like everything else) -> rehypeHighlight
 * (shared/highlight.ts: `==text==`/`==text=={.token}` -> `<mark
 * class="folio-hl folio-hl-<token>">`; legacy `<mark>` — already a real
 * element by now, from rehype-raw above — is left untouched. Last of the
 * text-shaping passes for the same reason rehypeMentions is: it must see
 * final prose, not table/cell-list scaffolding that hasn't settled yet) ->
 * rehype-sanitize (must run last of the transforms, so it can vet
 * everything raw HTML and our own plugins produced) -> stringify.
 *
 * `headingCursor` is optional and, when given, shared by the caller across
 * every segment of the SAME page (index.tsx creates one per render) — a
 * page's headings can be split across several independent calls to this
 * function by a mermaid fence sitting between them, and without a shared
 * cursor each call would restart heading numbering from zero, producing
 * duplicate ids the outline panel and collapsible sections both depend on
 * being unique.
 *
 * `tableIndexCursor` is the same idea for the fit/scroll toggle's per-table
 * index (tables.ts) — index.tsx threads one shared cursor across a page's
 * segments the same way it does headingCursor. A caller that doesn't care
 * (every test in this file included) gets a fresh one per call, which is
 * exactly as good for a single-call render — the indices just don't need to
 * agree with any OTHER call.
 *
 * `noteCursor` is the same idea again, for the notes panel's `data-note-index`
 * (noteIds.ts) — a bare counter rather than a pre-computed list, since a
 * note's id is just its position, not content-derived like a heading's slug.
 */
export function renderMarkdownToHtml(
  markdown: string,
  options: RenderOptions,
  headingCursor?: HeadingIdCursor,
  tableIndexCursor: TableIndexCursor = createTableIndexCursor(),
  noteCursor: NoteIdCursor = createNoteIdCursor(),
): string {
  const file = unified()
    .use(remarkParse)
    .use(remarkGfm)
    // The owner (17.09): "why is it in one line in reading?" — in markdown a
    // single line break is by the standard NOT a break: the paragraph is glued
    // into one line, and a page typed line by line in Live edit became one
    // solid paragraph in reading. remarkBreaks makes a soft break a real <br>,
    // so reading shows the same thing the person saw while writing.
    .use(remarkBreaks)
    .use(remarkAlerts)
    .use(remarkGlossaryTerms)
    .use(remarkDirective)
    .use(remarkDirectiveFallback)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeFolioPageLinks, { origin: options.origin, shareToken: options.shareToken, ...options.folioLinks })
    .use(rehypeRelativeLinks, options)
    .use(rehypeTableExtensions)
    .use(rehypeCellLists)
    .use(rehypeWrapTables, tableIndexCursor)
    .use(rehypeFlagStrayTables)
    .use(rehypeAssignHeadingIds, headingCursor)
    .use(rehypeAssignNoteIds, noteCursor)
    .use(rehypeCollapsibleSections)
    .use(rehypeMentions, options.mentionLookup)
    .use(rehypeHighlight)
    .use(rehypeSanitize, folioSanitizeSchema)
    .use(rehypeStringify)
    .processSync(markdown);
  return String(file);
}
