/**
 * `@mentions` — the `@` picker and the pill decoration.
 *
 * Storage is plain text (spec round 15): a mention in a markdown file is the
 * literal string `@username`, so the file stays readable git-native truth and
 * nothing has to understand a macro dialect to read it. The pill is purely a
 * view detail and appears only for handles this space actually knows — an
 * unknown `@foo` is left as the ordinary text it is.
 *
 * The pure half (token boundaries, code-context filtering, ranking) is kept
 * free of CodeMirror's view layer so it can be unit-tested in plain node.
 */
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { StateEffect, type Extension } from '@codemirror/state';
import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view';
import type { Tree } from '@lezer/common';
import type { MentionableUser } from '@shared/contracts';
import { fuzzyScore } from './fuzzy';
import type { IconName } from './icons';
import type { DocText, Span } from './live-decorations';
import { pageContextFacet } from './live-preview';
import { ensureMentionIndex, mentionIndex, mentionName, onMentionsLoaded } from './mention-index';

/** Handle length bounds, mirroring `usernameSchema` in shared/contracts.ts. */
export const MIN_HANDLE = 2;
export const MAX_HANDLE = 32;

/**
 * What may *not* sit in front of an `@` for it to open a mention: letters and
 * digits (mid-word), and the characters an e-mail address is made of — with
 * `a@b`, `team.lead@folio.dev` and `x-1@y` all landing on the same rule. Line
 * start, a space or ordinary punctuation (`(@ann)`, `«@ann»`) all pass.
 */
const BLOCKED_BEFORE = /[\p{L}\p{N}_@.+-]/u;

/** Handles as written in text: matched case-insensitively, looked up in lower case. */
const HANDLE_IN_TEXT = /@([A-Za-z0-9][A-Za-z0-9._-]*)/g;

/** What the author may have typed after `@` while the palette is open. */
const QUERY_CHARS = /^[A-Za-z0-9._-]*$/;

/** `.`/`-`/`_` at the end of a token is sentence punctuation, not the handle. */
const TRAILING_PUNCTUATION = /[._-]+$/;

export interface MentionToken {
  /** Offset of the `@` itself. */
  from: number;
  /** End of the handle, exclusive. */
  to: number;
  /** The handle without `@`, lower-cased for lookup. */
  handle: string;
}

/**
 * Every `@handle` in one piece of text (a single line, in practice).
 *
 * Nothing here decides whether a handle is real — that is the caller's lookup.
 * This is only about where a token starts and ends.
 */
export function findMentionTokens(text: string): MentionToken[] {
  const tokens: MentionToken[] = [];
  HANDLE_IN_TEXT.lastIndex = 0;
  for (let match = HANDLE_IN_TEXT.exec(text); match; match = HANDLE_IN_TEXT.exec(text)) {
    const at = match.index;
    if (at > 0 && BLOCKED_BEFORE.test(text[at - 1])) continue;
    const handle = match[1].replace(TRAILING_PUNCTUATION, '');
    if (handle.length < MIN_HANDLE || handle.length > MAX_HANDLE) continue;
    tokens.push({ from: at, to: at + 1 + handle.length, handle: handle.toLowerCase() });
  }
  return tokens;
}

/* ------------------------------------------------------------ decorating -- */

/**
 * Node names a mention may not be highlighted inside. Code is the important
 * one (`` `@types/node` `` is not a person), link destinations and raw HTML
 * come along because a pill over a URL or an attribute would be nonsense.
 */
const CODE_NODES = new Set([
  'InlineCode',
  'FencedCode',
  'CodeBlock',
  'CodeText',
  'Comment',
  'CommentBlock',
  'HTMLBlock',
  'HTMLTag',
  'URL',
]);

export interface MentionSpec extends Span {
  handle: string;
  /** Full name, shown as the pill's title. */
  name: string;
}

export interface MentionScan {
  doc: DocText;
  tree: Tree;
  /** Ranges to scan — the viewport, in the running editor. */
  ranges: readonly Span[];
  /** Display name for a known handle; undefined leaves the text plain. */
  lookup: (handle: string) => string | undefined;
}

/** Ranges of `tree` within [from, to] that a mention must not be drawn inside. */
function codeRanges(tree: Tree, from: number, to: number): Span[] {
  const spans: Span[] = [];
  tree.iterate({
    from,
    to,
    enter: (node) => {
      if (!CODE_NODES.has(node.name)) return true;
      spans.push({ from: node.from, to: node.to });
      return false;
    },
  });
  return spans;
}

const overlaps = (spans: readonly Span[], from: number, to: number): boolean =>
  spans.some((span) => span.from < to && span.to > from);

/**
 * Mentions to draw: every known handle in the scanned ranges, minus the ones
 * sitting in code, links or raw HTML. Line by line, so a token can never be
 * split by a range boundary.
 */
export function computeMentionSpecs({ doc, tree, ranges, lookup }: MentionScan): MentionSpec[] {
  const specs: MentionSpec[] = [];
  const seen = new Set<number>();

  for (const range of ranges) {
    const skip = codeRanges(tree, range.from, range.to);
    const first = doc.lineAt(range.from).number;
    const last = doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) {
      const line = doc.line(n);
      for (const token of findMentionTokens(line.text)) {
        const from = line.from + token.from;
        const to = line.from + token.to;
        if (seen.has(from)) continue;
        if (overlaps(skip, from, to)) continue;
        const name = lookup(token.handle);
        if (name === undefined) continue; // unknown handle: plain text, as stored
        seen.add(from);
        specs.push({ from, to, handle: token.handle, name });
      }
    }
  }

  return specs;
}

/* ------------------------------------------------------------- ranking -- */

/** Matching the handle too makes "@ann" work, but never outranks a name hit. */
const HANDLE_PENALTY = 25;

export interface RankedMention extends MentionableUser {
  score: number;
}

export function rankMentions(
  query: string,
  users: readonly MentionableUser[],
  limit = 20,
): RankedMention[] {
  const ranked: RankedMention[] = [];
  for (const user of users) {
    const byName = fuzzyScore(query, user.name);
    const byHandle = byName === null ? fuzzyScore(query, user.username) : null;
    const score = byName ?? (byHandle === null ? null : byHandle - HANDLE_PENALTY);
    if (score !== null) ranked.push({ ...user, score });
  }
  ranked.sort(
    (a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name),
  );
  return ranked.slice(0, limit);
}

/* ---------------------------------------------------------- completion -- */

export interface MentionQuery {
  /** Offset of the `@`. */
  at: number;
  query: string;
}

/**
 * An open `@query` before the caret, or null when this `@` is part of a word
 * or an address. Same boundary rule as the decoration, so what lights up is
 * exactly what the palette would have written.
 */
export function findMentionQuery(before: string): MentionQuery | null {
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && BLOCKED_BEFORE.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > MAX_HANDLE) return null;
  if (!QUERY_CHARS.test(query)) return null;
  return { at, query };
}

/** What a pick writes: plain text, never a hidden syntax. */
export function mentionText(user: Pick<MentionableUser, 'username'>): string {
  return `@${user.username}`;
}

interface MentionCompletion extends Completion {
  folio?: { icon: IconName; description?: string };
}

/** Typing `@` offers the people this space can mention. */
export async function mentionCompletions(
  context: CompletionContext,
): Promise<CompletionResult | null> {
  const line = context.state.doc.lineAt(context.pos);
  const found = findMentionQuery(line.text.slice(0, context.pos - line.from));
  if (!found) return null;

  const { space, shareToken } = context.state.facet(pageContextFacet);
  if (!space) return null;
  // A share-link guest has no session, and GET /api/spaces/:space/mentionable
  // needs viewer+ — offering the palette would just 401. Same reasoning (and
  // same signal: shareToken's presence IS "no session here") as the skip in
  // markdown/index.tsx.
  if (shareToken) return null;

  // Usually a cache hit; only the first `@` in a session waits for the request.
  let users = mentionIndex(space);
  if (users.length === 0) users = await ensureMentionIndex(space);
  if (context.aborted || users.length === 0) return null;

  const options: MentionCompletion[] = rankMentions(found.query, users).map((user) => ({
    label: user.username,
    displayLabel: user.name || mentionText(user),
    apply: mentionText(user),
    folio: { icon: 'user', description: mentionText(user) },
  }));
  if (options.length === 0) return null;

  return {
    // Matching is ours (`filter: false`), so the range covers the `@` as well:
    // picking rewrites the whole token.
    from: line.from + found.at,
    to: context.pos,
    options,
    filter: false,
  };
}

/* ------------------------------------------------------------ extension -- */

/** Dispatched when a space's list arrives, so cached decorations rebuild once. */
export const mentionsLoadedEffect = StateEffect.define<string>();

function buildMentionDecorations(view: EditorView): DecorationSet {
  const { space } = view.state.facet(pageContextFacet);
  if (!space) return Decoration.none;

  const specs = computeMentionSpecs({
    doc: view.state.doc,
    tree: syntaxTree(view.state),
    ranges: view.visibleRanges,
    lookup: (handle) => mentionName(space, handle),
  });
  return Decoration.set(
    specs.map((spec) =>
      Decoration.mark({ class: 'folio-mention', attributes: { title: spec.name } }).range(
        spec.from,
        spec.to,
      ),
    ),
    true,
  );
}

/** Loads the list for whatever space the editor is showing now. */
function ensureLoaded(view: EditorView): void {
  const { space, shareToken } = view.state.facet(pageContextFacet);
  if (space && !shareToken) void ensureMentionIndex(space);
}

/**
 * Pills for known handles, in both live and source mode: the text is never
 * folded or replaced, only marked, so the markdown reads the same either way.
 */
export function mentions(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private readonly off: () => void;

      constructor(view: EditorView) {
        ensureLoaded(view);
        this.decorations = buildMentionDecorations(view);
        this.off = onMentionsLoaded((space) => {
          if (space !== view.state.facet(pageContextFacet).space) return;
          // Outside the update cycle (a settled request), so dispatching is safe.
          view.dispatch({ effects: mentionsLoadedEffect.of(space) });
        });
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.transactions.some(
            (tr) => tr.reconfigured || tr.effects.some((effect) => effect.is(mentionsLoadedEffect)),
          ) ||
          syntaxTree(update.state) !== syntaxTree(update.startState)
        ) {
          // The page context arrives through a reconfiguration, so the space
          // this editor shows may only become known here.
          ensureLoaded(update.view);
          this.decorations = buildMentionDecorations(update.view);
        }
      }

      destroy() {
        this.off();
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
