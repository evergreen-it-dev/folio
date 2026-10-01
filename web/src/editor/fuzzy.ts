/**
 * Shared typeahead scoring. Lives on its own so both the `[[` picker and the
 * emoji shortcodes can use it without dragging the CodeMirror view layer along
 * (wikilink.ts imports live-preview, which would cycle back through the table
 * widget).
 */
const WORDISH = /[\p{L}\p{N}]/u;

function isWordStart(text: string, index: number): boolean {
  return index === 0 || !WORDISH.test(text[index - 1]);
}

/**
 * Subsequence match with the usual typeahead bonuses (prefix, word starts,
 * contiguous runs). Case folding is `toLowerCase`, which handles Cyrillic just
 * as well as Latin. Returns null when `query` is not a subsequence of `text`.
 */
export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const needle = query.toLowerCase();
  const hay = text.toLowerCase();

  let score = 0;
  let cursor = 0;
  let previous = -2;
  let run = 0;

  for (const char of needle) {
    if (char === ' ') continue;
    const at = hay.indexOf(char, cursor);
    if (at < 0) return null;

    if (at === previous + 1) {
      run += 1;
      score += 8 + run * 2;
    } else {
      run = 0;
      score += 1;
    }
    if (at === 0) score += 12;
    else if (isWordStart(hay, at)) score += 6;
    score -= Math.min(at - cursor, 8);

    previous = at;
    cursor = at + char.length;
  }
  return score;
}
