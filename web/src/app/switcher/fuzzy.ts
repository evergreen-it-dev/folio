export interface FuzzyMatch {
  matched: boolean;
  score: number;
}

/**
 * Case-insensitive subsequence fuzzy match (fzf/VS Code "quick open" style):
 * every character of `query`, in order but not necessarily contiguous, must
 * appear in `target`. Un-matched leftover query characters -> no match.
 *
 * Scoring (higher = better) rewards, on top of one point per matched
 * character:
 * - consecutive runs of matched characters (typing "qui" should rank
 *   "Quick Switcher" above a hit scattered across unrelated words),
 * - a match starting right at the beginning of the string or right after a
 *   word-separator (so "qk" ranks "Quick K..." above a mid-word hit).
 *
 * An empty query matches everything with score 0 — callers that want
 * "no query -> show an unranked default list" (e.g. the switcher's recents)
 * should special-case that upstream rather than relying on this to rank.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch {
  const q = query.trim().toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0) return { matched: true, score: 0 };

  let score = 0;
  let qi = 0;
  let consecutiveRun = 0;
  let prevMatchedTi = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (q[qi] !== t[ti]) continue;

    score += 1;
    if (prevMatchedTi === ti - 1) {
      consecutiveRun += 1;
      score += consecutiveRun * 3;
    } else {
      consecutiveRun = 0;
    }
    if (ti === 0 || /[\s\-_/]/.test(t[ti - 1]!)) {
      score += 5;
    }
    prevMatchedTi = ti;
    qi += 1;
  }

  if (qi < q.length) return { matched: false, score: 0 };

  // Slight preference for shorter targets, all else equal — a tighter match.
  score += Math.max(0, 20 - t.length) * 0.1;
  return { matched: true, score };
}

/**
 * Filters `items` to those whose `getText(item)` fuzzy-matches `query`, best
 * match first (ties keep the original relative order — e.g. recents' own
 * most-recent-first ordering survives a tie). An empty/whitespace-only query
 * returns `items` unchanged, in their given order.
 */
export function fuzzyFilter<T>(query: string, items: readonly T[], getText: (item: T) => string): T[] {
  if (query.trim().length === 0) return [...items];
  return items
    .map((item, index) => ({ item, index, match: fuzzyMatch(query, getText(item)) }))
    .filter((entry) => entry.match.matched)
    .sort((a, b) => b.match.score - a.match.score || a.index - b.index)
    .map((entry) => entry.item);
}
