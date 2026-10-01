/**
 * `[[` page picker.
 *
 * `[[` is *input*, never storage (spec §3.4): picking an entry writes an
 * ordinary relative markdown link, so the file on disk stays plain GitHub
 * markdown and nothing has to understand a wiki dialect to read it.
 */
import {
  insertCompletionText,
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import type { IconName } from './icons';
import { fuzzyScore } from './fuzzy';
import { pageContextFacet } from './live-preview';
import { ensurePageIndex, pageIndex, type PageEntry } from './page-index';
import { formatLinkTarget, relativePath } from './paths';

/** Longest `[[query` we will look back over, so a stray `[[` cannot capture a line. */
const MAX_QUERY = 80;

export interface WikilinkQuery {
  /** Offset of the first character after `[[`. */
  from: number;
  query: string;
}

/**
 * Locate an open `[[` before `offset` on this line. Returns null once the pair
 * has been closed, so `[[a]] more text` stops offering completions.
 */
export function findWikilinkQuery(lineText: string, offset: number): WikilinkQuery | null {
  const before = lineText.slice(0, offset);
  const open = before.lastIndexOf('[[');
  if (open < 0) return null;
  const query = before.slice(open + 2);
  if (query.length > MAX_QUERY) return null;
  if (query.includes(']')) return null;
  return { from: open + 2, query };
}

/**
 * The range a pick replaces: the `[[`, the typed query, and the closing
 * brackets — which `closeBrackets` has usually already inserted for us.
 * `after` is the document text immediately following the cursor.
 */
export function wikilinkRange(after: string, queryFrom: number, cursor: number): { from: number; to: number } {
  const trailing = after.startsWith(']]') ? 2 : after.startsWith(']') ? 1 : 0;
  return { from: queryFrom - 2, to: cursor + trailing };
}

/* ----------------------------------------------------------------- match -- */

/** Matching the path too makes "arch/data" work, but never outranks a title hit. */
const PATH_PENALTY = 25;

export interface RankedPage extends PageEntry {
  score: number;
}

export function rankPages(query: string, entries: readonly PageEntry[], limit = 30): RankedPage[] {
  const ranked: RankedPage[] = [];
  for (const entry of entries) {
    const byTitle = fuzzyScore(query, entry.title);
    const byPath = byTitle === null ? fuzzyScore(query, entry.path) : null;
    const score = byTitle ?? (byPath === null ? null : byPath - PATH_PENALTY);
    if (score !== null) ranked.push({ ...entry, score });
  }
  ranked.sort(
    (a, b) => b.score - a.score || a.title.length - b.title.length || a.title.localeCompare(b.title),
  );
  return ranked.slice(0, limit);
}

/* ---------------------------------------------------------------- insert -- */

/** What a pick writes: always a plain relative markdown link. */
export function wikilinkMarkdown(fromPagePath: string, entry: PageEntry): string {
  const target = relativePath(fromPagePath, entry.path);
  return `[${entry.title.replace(/[[\]]/g, '')}](${formatLinkTarget(target)})`;
}

/**
 * Round 26 (DATA TABLES): `table` is a third page kind in the `[[` list.
 * icons.ts already carries a `table` glyph (drawn for the R17 in-text table
 * block) — a different feature with the same shape, and the right visual
 * answer here regardless.
 */
function iconFor(kind: string): IconName {
  if (kind === 'board') return 'board';
  if (kind === 'table') return 'table';
  return 'page';
}

/* ------------------------------------------------------------ completion -- */

interface WikiCompletion extends Completion {
  folio?: { icon: IconName; description?: string };
}

/** Typing `[[` anywhere offers the pages of the current space. */
export async function wikilinkCompletions(context: CompletionContext): Promise<CompletionResult | null> {
  const line = context.state.doc.lineAt(context.pos);
  const found = findWikilinkQuery(line.text, context.pos - line.from);
  if (!found) return null;

  const { space, pagePath } = context.state.facet(pageContextFacet);
  if (!space) return null;

  // Usually a cache hit; only the first `[[` in a space waits for the request.
  let entries = pageIndex(space);
  if (entries.length === 0) entries = await ensurePageIndex(space);
  if (context.aborted || entries.length === 0) return null;

  const options: WikiCompletion[] = rankPages(found.query, entries).map((entry) => ({
    label: entry.title || entry.path,
    apply: applyWikilink(pagePath, entry),
    folio: { icon: iconFor(entry.kind), description: entry.path },
  }));
  if (options.length === 0) return null;

  return {
    // Matching is ours (`filter: false`), so this range holds only the query.
    from: line.from + found.from,
    to: context.pos,
    options,
    filter: false,
  };
}

function applyWikilink(pagePath: string, entry: PageEntry): Completion['apply'] {
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    const after = view.state.sliceDoc(to, Math.min(to + 2, view.state.doc.length));
    const range = wikilinkRange(after, from, to);
    view.dispatch({
      ...insertCompletionText(view.state, wikilinkMarkdown(pagePath, entry), range.from, range.to),
      annotations: pickedCompletion.of(completion),
    });
  };
}
