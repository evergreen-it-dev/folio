import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyMatch } from './fuzzy';

describe('fuzzyMatch', () => {
  it('matches an exact substring', () => {
    expect(fuzzyMatch('quick', 'Quick Switcher').matched).toBe(true);
  });

  it('matches a scattered subsequence', () => {
    expect(fuzzyMatch('qsw', 'Quick Switcher').matched).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(fuzzyMatch('QUICK', 'quick switcher').matched).toBe(true);
  });

  it('does not match when a query character is missing entirely', () => {
    expect(fuzzyMatch('qz', 'Quick Switcher').matched).toBe(false);
  });

  it('does not match when query characters are out of order', () => {
    expect(fuzzyMatch('ki', 'ik').matched).toBe(false);
  });

  it('does not match when the query is longer than what target can supply', () => {
    expect(fuzzyMatch('quickswitcherxyz', 'Quick Switcher').matched).toBe(false);
  });

  it('treats an empty (or whitespace-only) query as matching with score 0', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ matched: true, score: 0 });
    expect(fuzzyMatch('   ', 'anything')).toEqual({ matched: true, score: 0 });
  });

  it('scores a fully-contiguous match higher than the same letters scattered', () => {
    const contiguous = fuzzyMatch('arch', 'Architecture Overview');
    const scattered = fuzzyMatch('arch', 'A Reference Correction History');
    expect(contiguous.matched).toBe(true);
    expect(scattered.matched).toBe(true);
    expect(contiguous.score).toBeGreaterThan(scattered.score);
  });

  it('scores a match at a word boundary higher than a mid-word match', () => {
    // "sw" starts the second word in "Quick Switcher" (boundary), but is
    // buried mid-word in "Answer Wise" (still a valid subsequence: ...n-SW...).
    const boundary = fuzzyMatch('sw', 'Quick Switcher');
    const midWord = fuzzyMatch('sw', 'Answer Wise');
    expect(boundary.matched).toBe(true);
    expect(midWord.matched).toBe(true);
    expect(boundary.score).toBeGreaterThan(midWord.score);
  });

  it('scores a match at the very start of the string highly', () => {
    const atStart = fuzzyMatch('qu', 'Quick Switcher');
    const notAtStart = fuzzyMatch('qu', 'A Quick Switcher');
    expect(atStart.score).toBeGreaterThan(notAtStart.score);
  });
});

describe('fuzzyFilter', () => {
  const pages = ['Onboarding', 'Architecture Overview', 'Deploy Runbook', 'Quick Switcher Notes'];

  it('returns items unchanged, in order, for an empty query', () => {
    expect(fuzzyFilter('', pages, (p) => p)).toEqual(pages);
  });

  it('drops non-matching items', () => {
    expect(fuzzyFilter('deploy', pages, (p) => p)).toEqual(['Deploy Runbook']);
  });

  it('ranks a tighter/earlier match first', () => {
    const result = fuzzyFilter('qui', pages, (p) => p);
    expect(result[0]).toBe('Quick Switcher Notes');
  });

  it('returns an empty array when nothing matches', () => {
    expect(fuzzyFilter('zzzzz', pages, (p) => p)).toEqual([]);
  });

  it('keeps input order as a tiebreaker for equal scores', () => {
    const items = ['ab', 'ab'];
    expect(fuzzyFilter('ab', items, (s) => s)).toEqual(['ab', 'ab']);
  });
});
