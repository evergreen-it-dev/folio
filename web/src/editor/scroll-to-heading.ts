/**
 * "Jump to this heading" for the CodeMirror surface — what the outline panel
 * needs in source/live mode, where there is no rendered `<h1-6 id="...">` DOM to
 * scrollIntoView (see app/outline/OutlinePanel.tsx).
 *
 * Slugs MUST be the very ones the outline panel and the rendering pipeline use,
 * or a click would silently find nothing. So the pieces come from the shared
 * source rather than being re-invented here: `slugify` + `createSlugDeduper`
 * (markdown/headings.ts) and `stripFrontmatter` (markdown/frontmatter.ts), fed
 * by the same remark parse. `headingPositions` is `extractHeadings` plus the
 * document offset each heading starts at — the one thing that function does not
 * return, and the reason this is not simply a call to it. A test in
 * scroll-to-heading.test.ts asserts the two produce identical slug lists, so the
 * duplication cannot drift unnoticed.
 */
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { remarkUnderline } from '@shared/underline';
import { visit } from 'unist-util-visit';
import type { Root, Heading as MdHeading, Text, InlineCode } from 'mdast';
import { stripFrontmatter } from '../markdown/frontmatter';
import { createSlugDeduper } from '../markdown/headings';

export interface HeadingPosition {
  slug: string;
  /** Offset of the heading's first character in the *original* markdown. */
  pos: number;
}

/** Same text extraction as markdown/headings.ts: prose and inline code, no markup. */
function headingText(node: MdHeading): string {
  let text = '';
  visit(node, (child) => {
    if (child.type === 'text') text += (child as Text).value;
    else if (child.type === 'inlineCode') text += (child as InlineCode).value;
  });
  return text;
}

/** Every heading in document order, with its deduped slug and its offset. */
export function headingPositions(markdown: string): HeadingPosition[] {
  const body = stripFrontmatter(markdown);
  // stripFrontmatter only ever removes a prefix, so the difference in length is
  // exactly how far every offset below has to be shifted back.
  const shift = markdown.length - body.length;
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkUnderline).parse(body) as Root;
  const dedupe = createSlugDeduper();
  const out: HeadingPosition[] = [];

  visit(tree, 'heading', (node: MdHeading) => {
    const slug = dedupe(headingText(node));
    const start = node.position?.start?.offset;
    if (start === undefined) return;
    out.push({ slug, pos: shift + start });
  });

  return out;
}

/**
 * Put the caret on the heading with this slug and scroll it to the top of the
 * editor. Returns false when the document has no such heading, so a caller can
 * fall back to whatever it did before (the reading view's own anchor scroll).
 */
export function scrollToHeading(view: EditorView, slug: string): boolean {
  const found = headingPositions(view.state.doc.toString()).find((heading) => heading.slug === slug);
  if (!found || found.pos > view.state.doc.length) return false;

  const line = view.state.doc.lineAt(found.pos);
  view.dispatch({
    selection: EditorSelection.cursor(line.from),
    effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 24 }),
  });
  view.focus();
  return true;
}

/**
 * Put the caret at this raw-markdown offset and scroll it to the top of the
 * editor — the notes panel's counterpart to scrollToHeading, for a
 * markdown/notes.ts NoteEntry, which has no slug of its own to look a
 * heading up by, only the offset (`pos`) it was found at. `false` when the
 * offset doesn't fit the CURRENT document (it was computed from a possibly
 * stale markdown snapshot — see OutlinePanel.tsx's own doc comment on why
 * that can happen), so a caller can fall back the same way scrollToHeading's
 * callers do.
 */
export function scrollToOffset(view: EditorView, pos: number): boolean {
  if (pos < 0 || pos > view.state.doc.length) return false;

  const line = view.state.doc.lineAt(pos);
  view.dispatch({
    selection: EditorSelection.cursor(line.from),
    effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 24 }),
  });
  view.focus();
  return true;
}

/* ------------------------------------------------- the mounted editor view -- */

let mounted: EditorView | null = null;

/**
 * The editor host registers its view here (editor/index.tsx) so code outside the
 * zone — the outline panel lives in app/ and never sees a CodeMirror instance —
 * can reach it without the view being threaded through React props.
 */
export function setMountedEditorView(view: EditorView): void {
  mounted = view;
}

/**
 * Paired with the setter on unmount. Checks identity first: React tears the old
 * host down *after* a replacement has already registered itself in some orders,
 * and an unconditional clear would leave the live editor unreachable.
 */
export function clearMountedEditorView(view: EditorView): void {
  if (mounted === view) mounted = null;
}

/** Null in reading mode and while the collab session is still connecting. */
export function mountedEditorView(): EditorView | null {
  return mounted;
}

/** `scrollToHeading` against whichever editor is on screen; false when none is. */
export function scrollActiveEditorToHeading(slug: string): boolean {
  return mounted ? scrollToHeading(mounted, slug) : false;
}

/** `scrollToOffset` against whichever editor is on screen; false when none is. */
export function scrollActiveEditorToOffset(pos: number): boolean {
  return mounted ? scrollToOffset(mounted, pos) : false;
}
