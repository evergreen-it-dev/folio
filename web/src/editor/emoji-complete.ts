/**
 * Emoji input: `:name` shortcodes, the `((` quick trigger, and `:name:`
 * closing-colon expansion.
 *
 * Everything that decides *what* matches lives here as pure functions so the
 * CodeMirror source and the table-cell dropdown can share one implementation
 * and one set of tests.
 */
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { insertCompletionText, pickedCompletion } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { Facet, type Extension } from '@codemirror/state';
// Relative rather than the `@shared` alias on purpose: this is a *value*
// import, and the test runner has no alias configuration (every other test
// imports from shared types-only, so nothing has needed it before).
import { DEFAULT_EMOJI_FAVORITES } from '../../../shared/contracts';
import { EMOJI, emojiByName, type EmojiEntry } from './emoji-data';
import { fuzzyScore } from './fuzzy';

/** Shortcodes need two letters before they mean anything; `((` opens at once. */
const MIN_COLON_QUERY = 2;
const QUERY_CHARS = /^[\p{L}\p{N}_-]*$/u;
const WORDISH = /[\p{L}\p{N}]/u;

export type EmojiTriggerKind = 'colon' | 'paren';

export interface EmojiTrigger {
  kind: EmojiTriggerKind;
  /** Offset of the first query character (just past the trigger). */
  from: number;
  /** Characters the trigger itself occupies: 1 for `:`, 2 for `((`. */
  triggerLength: number;
  query: string;
}

/** `:name` — only after a boundary, so `http://x` never opens the picker. */
export function findColonQuery(before: string): EmojiTrigger | null {
  const colon = before.lastIndexOf(':');
  if (colon < 0) return null;
  if (colon > 0 && WORDISH.test(before[colon - 1])) return null;
  const query = before.slice(colon + 1);
  if (query.length < MIN_COLON_QUERY) return null;
  if (!QUERY_CHARS.test(query)) return null;
  return { kind: 'colon', from: colon + 1, triggerLength: 1, query };
}

/** `((` — opens immediately, with or without a query. */
export function findParenQuery(before: string): EmojiTrigger | null {
  const open = before.lastIndexOf('((');
  if (open < 0) return null;
  const query = before.slice(open + 2);
  // Anything that is not a plain word character means the author is typing
  // something else — nested parens, a formula — so step aside.
  if (!QUERY_CHARS.test(query)) return null;
  return { kind: 'paren', from: open + 2, triggerLength: 2, query };
}

/** Whichever trigger is closer to the caret. */
export function findEmojiTrigger(before: string): EmojiTrigger | null {
  const paren = findParenQuery(before);
  const colon = findColonQuery(before);
  if (paren && colon) return paren.from >= colon.from ? paren : colon;
  return paren ?? colon;
}

/**
 * `:plus` + the closing `:` the author is about to type. Returns the offset the
 * replacement starts at and the emoji to put there, or null when the name is
 * not one we know (in which case the colon is just a colon).
 */
export function closingColonExpansion(before: string): { from: number; emoji: string } | null {
  const match = findColonQuery(before);
  if (!match) return null;
  const entry = emojiByName(match.query);
  if (!entry) return null;
  return { from: match.from - 1, emoji: entry.emoji };
}

/* ----------------------------------------------------------------- rank -- */

export interface RankedEmoji extends EmojiEntry {
  score: number;
}

/** Favourites, then the owner-required set, then the rest. */
const TIER = 100_000;

/**
 * Ranking is tiered so a tier can never be jumped: favourites stay on top in
 * *their own* order (the shared default list is deliberately ordered), the
 * required set follows, and match quality only ever reorders within a tier.
 */
export function rankEmoji(
  query: string,
  favourites: readonly string[] = [],
  limit = 40,
  entries: readonly EmojiEntry[] = EMOJI,
): RankedEmoji[] {
  const ranked: RankedEmoji[] = [];

  // A favourite the name map does not know (the shared picker's grid is larger
  // than ours) still deserves a row — it just has no searchable name.
  const known = new Set(entries.map((entry) => entry.emoji));
  const extras: EmojiEntry[] = query
    ? []
    : favourites
        .filter((emoji) => !known.has(emoji))
        .map((emoji) => ({ emoji, name: emoji, aliases: [], priority: 0 }));

  for (const entry of [...entries, ...extras]) {
    let match: number | null = null;
    if (!query) {
      match = 0;
    } else {
      for (const candidate of [entry.name, ...entry.aliases]) {
        const value = fuzzyScore(query, candidate);
        if (value !== null && (match === null || value > match)) match = value;
      }
    }
    if (match === null) continue;

    const favourite = favourites.indexOf(entry.emoji);
    const tier = favourite >= 0 ? 2 : entry.priority > 0 ? 1 : 0;
    const order = favourite >= 0 ? favourites.length - favourite : 0;
    ranked.push({ ...entry, score: tier * TIER + match * 100 + order });
  }

  ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return ranked.slice(0, limit);
}

/* ------------------------------------------------------------ favourites -- */

/**
 * Favourites come from the shared `useEmojiFavorites()` hook, which is bound to
 * React and react-query. The completion source and the table-cell dropdown are
 * plain DOM, so `PageEditor` reads the hook once and pushes the list in here.
 */
export const emojiFavouritesFacet = Facet.define<readonly string[], readonly string[]>({
  combine: (values) => values[values.length - 1] ?? DEFAULT_EMOJI_FAVORITES,
});

const FAVOURITES_KEY = 'folio.emoji.favorites';
const FAVOURITES_MAX = 16;

/**
 * Local stand-in for `useEmojiFavorites()` from the shared emoji module, which
 * does not exist yet. Same storage key, same shape (a most-recent-first list of
 * plain emoji), so the shared hook can take over without a migration.
 */
export function emojiFavourites(): string[] {
  try {
    const raw = localStorage.getItem(FAVOURITES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    const stored = Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
    // Until the author picks anything, the shared defaults are the favourites.
    return stored.length > 0 ? stored : [...DEFAULT_EMOJI_FAVORITES];
  } catch {
    return [...DEFAULT_EMOJI_FAVORITES];
  }
}

export function rememberEmoji(emoji: string): void {
  try {
    const next = [emoji, ...emojiFavourites().filter((item) => item !== emoji)].slice(0, FAVOURITES_MAX);
    localStorage.setItem(FAVOURITES_KEY, JSON.stringify(next));
  } catch {
    /* private mode — favourites just do not persist */
  }
}

/* ------------------------------------------------------------ codemirror -- */

interface EmojiCompletion extends Completion {
  folioEmoji?: string;
}

/** `:name` and `((` completions inside the document. */
export function emojiCompletions(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const trigger = findEmojiTrigger(line.text.slice(0, context.pos - line.from));
  if (!trigger) return null;

  const favourites = context.state.facet(emojiFavouritesFacet);
  const options: EmojiCompletion[] = rankEmoji(trigger.query, favourites).map((entry) => ({
    label: entry.name,
    // No `detail`: the glyph is already the row icon, and CodeMirror would
    // render it a second time on the right.
    apply: applyEmoji(entry.emoji, trigger.triggerLength),
    folioEmoji: entry.emoji,
  }));
  if (options.length === 0) return null;

  return {
    from: line.from + trigger.from,
    to: context.pos,
    options,
    filter: false,
  };
}

function applyEmoji(emoji: string, triggerLength: number): Completion['apply'] {
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    rememberEmoji(emoji);
    view.dispatch({
      ...insertCompletionText(view.state, emoji, from - triggerLength, to),
      annotations: pickedCompletion.of(completion),
    });
  };
}

/**
 * Typing the closing `:` of a full `:name:` replaces it immediately, without
 * going through the completion list.
 */
export function emojiClosingColon(): Extension {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== ':') return false;
    const line = view.state.doc.lineAt(from);
    const expansion = closingColonExpansion(line.text.slice(0, from - line.from));
    if (!expansion) return false;
    rememberEmoji(expansion.emoji);
    view.dispatch({
      changes: { from: line.from + expansion.from, to, insert: expansion.emoji },
      userEvent: 'input.type',
    });
    return true;
  });
}

/** The emoji for a completion row, used by the shared option renderer. */
export function emojiOf(completion: Completion): string | undefined {
  return (completion as EmojiCompletion).folioEmoji;
}
