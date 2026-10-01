import { describe, expect, it } from 'vitest';
import type { Stars } from '@shared/contracts';
import { applyStarToggle, EMPTY_STARS, isStarred } from './stars';

describe('applyStarToggle', () => {
  it('adds a space to an empty list when starring', () => {
    const result = applyStarToggle(EMPTY_STARS, 'space', 'engineering', true);
    expect(result).toEqual({ spaces: ['engineering'], pages: [] });
  });

  it('adds a page without touching the spaces list', () => {
    const start: Stars = { spaces: ['engineering'], pages: [] };
    const result = applyStarToggle(start, 'page', 'p1', true);
    expect(result).toEqual({ spaces: ['engineering'], pages: ['p1'] });
  });

  it('removes an id when unstarring', () => {
    const start: Stars = { spaces: ['engineering', 'design'], pages: [] };
    const result = applyStarToggle(start, 'space', 'engineering', false);
    expect(result).toEqual({ spaces: ['design'], pages: [] });
  });

  it('is a no-op (same reference) when already in the requested state', () => {
    const start: Stars = { spaces: ['engineering'], pages: [] };
    expect(applyStarToggle(start, 'space', 'engineering', true)).toBe(start);

    const empty: Stars = { spaces: [], pages: [] };
    expect(applyStarToggle(empty, 'page', 'missing', false)).toBe(empty);
  });

  it('does not mutate the input object', () => {
    const start: Stars = { spaces: ['engineering'], pages: ['p1'] };
    const snapshot = JSON.parse(JSON.stringify(start));
    applyStarToggle(start, 'page', 'p2', true);
    expect(start).toEqual(snapshot);
  });

  it('round-trips star then unstar back to the original list contents', () => {
    const start: Stars = { spaces: [], pages: ['p1'] };
    const starred = applyStarToggle(start, 'page', 'p2', true);
    const unstarred = applyStarToggle(starred, 'page', 'p2', false);
    expect(unstarred).toEqual(start);
  });
});

describe('isStarred', () => {
  it('is false for undefined stars', () => {
    expect(isStarred(undefined, 'space', 'engineering')).toBe(false);
  });

  it('checks the right list for the given kind', () => {
    const stars: Stars = { spaces: ['engineering'], pages: ['p1'] };
    expect(isStarred(stars, 'space', 'engineering')).toBe(true);
    expect(isStarred(stars, 'space', 'p1')).toBe(false);
    expect(isStarred(stars, 'page', 'p1')).toBe(true);
    expect(isStarred(stars, 'page', 'engineering')).toBe(false);
  });
});
