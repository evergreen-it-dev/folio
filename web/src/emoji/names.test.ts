import { describe, expect, it } from 'vitest';
import { DEFAULT_EMOJI_FAVORITES } from '@shared/contracts';
import { EMOJI_CATEGORIES, EMOJI_GRID, EMOJI_NAMES, filterEmoji } from './names';

describe('EMOJI_NAMES coverage', () => {
  it('has a name entry for every emoji in the grid', () => {
    const missing = EMOJI_GRID.filter((e) => !EMOJI_NAMES[e]);
    expect(missing).toEqual([]);
  });

  it('has every DEFAULT_EMOJI_FAVORITES entry present in the grid, with a name', () => {
    for (const emoji of DEFAULT_EMOJI_FAVORITES) {
      expect(EMOJI_GRID).toContain(emoji);
      expect(EMOJI_NAMES[emoji]).toBeTruthy();
    }
  });

  it('keeps each emoji in exactly one category', () => {
    const categorized = EMOJI_CATEGORIES.flatMap((category) => category.emojis);
    expect(new Set(categorized).size).toBe(categorized.length);
    expect(categorized).toEqual(EMOJI_GRID);
  });

  it('keeps the original grid as the Business category and adds smileys', () => {
    expect(EMOJI_CATEGORIES[0].key).toBe('business');
    expect(EMOJI_CATEGORIES.find((category) => category.key === 'smileys')?.emojis).toContain('😀');
  });
});

describe('filterEmoji', () => {
  it('returns the full list unchanged for an empty query', () => {
    expect(filterEmoji('', EMOJI_GRID)).toEqual(EMOJI_GRID);
    expect(filterEmoji('   ', EMOJI_GRID)).toEqual(EMOJI_GRID);
  });

  it('finds an emoji by its own character', () => {
    expect(filterEmoji('🚀', EMOJI_GRID)).toContain('🚀');
  });

  it('is case-insensitive', () => {
    expect(filterEmoji('ROCKET', EMOJI_GRID)).toContain('🚀');
  });

  it.each([
    ['smileys', '😀'],
    ['business', '📄'],
    ['food', '🍕'],
  ])('searches categories: %s -> %s', (query, emoji) => {
    expect(filterEmoji(query, EMOJI_GRID)).toContain(emoji);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterEmoji('zzzqqq', EMOJI_GRID)).toEqual([]);
  });

  // The coordinator's exact seven original aliases, then the five newly
  // added defaults — each must resolve to its emoji. The keywords of other
  // languages are checked next to their data, in ./keywords/.
  const requiredAliases: Array<[query: string, emoji: string]> = [
    ['plus', '➕'],
    ['minus', '➖'],
    ['soon', '🔜'],
    ['tools', '🛠️'],
    ['hammer', '🛠️'],
    ['warning', '⚠️'],
    ['new', '🆕'],
    ['star', '⭐'],
    ['check', '✅'],
    ['done', '✅'],
    ['no entry', '⛔'],
    ['exclamation', '❗'],
    ['prohibited', '🚫'],
    ['heart', '❤️'],
  ];

  it.each(requiredAliases)('finds %s -> %s', (query, emoji) => {
    expect(filterEmoji(query, EMOJI_GRID)).toContain(emoji);
  });
});
