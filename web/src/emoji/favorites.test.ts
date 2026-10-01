import { describe, expect, it } from 'vitest';
import { DEFAULT_EMOJI_FAVORITES } from '@shared/contracts';
import { decideFavoriteWrites, seedFavorites, toggleFavorite } from './favorites';

describe('seedFavorites', () => {
  it('falls back to the twelve defaults when emojis is absent', () => {
    expect(seedFavorites(undefined)).toEqual(DEFAULT_EMOJI_FAVORITES);
  });

  it('falls back to the defaults when emojis is an empty array (customized down to nothing)', () => {
    expect(seedFavorites([])).toEqual(DEFAULT_EMOJI_FAVORITES);
  });

  it('uses the server list as-is once the user has any favorites at all', () => {
    expect(seedFavorites(['🚀', '🎯'])).toEqual(['🚀', '🎯']);
  });

  it('does not mutate DEFAULT_EMOJI_FAVORITES itself', () => {
    const result = seedFavorites(undefined);
    result.push('🙃');
    expect(DEFAULT_EMOJI_FAVORITES).not.toContain('🙃');
  });

  it('covers all twelve current defaults (order preserved)', () => {
    expect(seedFavorites(undefined)).toHaveLength(12);
    expect(seedFavorites(undefined)).toEqual([
      '➕', '➖', '✅', '⛔', '❗', '🚫', '❤️', '🔜', '🛠️', '⚠️', '🆕', '⭐',
    ]);
  });
});

describe('toggleFavorite', () => {
  it('appends to the end when turning a favorite on', () => {
    expect(toggleFavorite(['🚀'], '🎯', true)).toEqual(['🚀', '🎯']);
  });

  it('removes it (wherever it sits) when turning a favorite off', () => {
    expect(toggleFavorite(['🚀', '🎯', '🔥'], '🎯', false)).toEqual(['🚀', '🔥']);
  });

  it('is a no-op (same reference) when already in the requested state — turning on something already favorited', () => {
    const favorites = ['🚀', '🎯'];
    expect(toggleFavorite(favorites, '🚀', true)).toBe(favorites);
  });

  it('is a no-op (same reference) when already in the requested state — turning off something not favorited', () => {
    const favorites = ['🚀', '🎯'];
    expect(toggleFavorite(favorites, '🔥', false)).toBe(favorites);
  });

  it('turning on twice does not duplicate the entry', () => {
    const once = toggleFavorite(['🚀'], '🎯', true);
    const twice = toggleFavorite(once, '🎯', true);
    expect(twice).toEqual(['🚀', '🎯']);
    expect(twice).toBe(once); // second call is the idempotent no-op path
  });

  it('re-adding after removal goes back to the end, not its original position', () => {
    const removed = toggleFavorite(['🚀', '🎯', '🔥'], '🚀', false);
    expect(removed).toEqual(['🎯', '🔥']);
    const readded = toggleFavorite(removed, '🚀', true);
    expect(readded).toEqual(['🎯', '🔥', '🚀']);
  });
});

describe('decideFavoriteWrites', () => {
  it('materializes the whole defaults+1 set (all starred:true) when the server list is absent and a new emoji is added', () => {
    const writes = decideFavoriteWrites(undefined, '🚀', true);
    expect(writes).toHaveLength(13);
    expect(writes.every((w) => w.starred === true)).toBe(true);
    expect(writes.map((w) => w.emoji)).toEqual([...DEFAULT_EMOJI_FAVORITES, '🚀']);
  });

  it('materializes the whole defaults+1 set when the server list is an empty array', () => {
    const writes = decideFavoriteWrites([], '🎯', true);
    expect(writes.map((w) => w.emoji)).toEqual([...DEFAULT_EMOJI_FAVORITES, '🎯']);
    expect(writes.every((w) => w.starred === true)).toBe(true);
  });

  it('materializes the eleven remaining defaults (no write for the removed one) when removing a default on first customization', () => {
    const writes = decideFavoriteWrites(undefined, '⭐', false);
    expect(writes).toHaveLength(11);
    expect(writes.map((w) => w.emoji)).not.toContain('⭐');
    expect(writes.every((w) => w.starred === true)).toBe(true);
    expect(writes.map((w) => w.emoji)).toEqual(DEFAULT_EMOJI_FAVORITES.filter((e) => e !== '⭐'));
  });

  it('is a single normal write once the server list is non-empty (already materialized/customized)', () => {
    expect(decideFavoriteWrites(['🚀'], '🎯', true)).toEqual([{ emoji: '🎯', starred: true }]);
    expect(decideFavoriteWrites(['🚀', '🎯'], '🚀', false)).toEqual([{ emoji: '🚀', starred: false }]);
  });

  it('re-materializes defaults+1 if the server list becomes empty again (documented, accepted behavior)', () => {
    // Simulates: user removed their one remaining custom favorite (server
    // list is now []), then adds a different one — re-triggers the same
    // materialization path as a brand-new account, not a single write.
    const writes = decideFavoriteWrites([], '🐳', true);
    expect(writes.map((w) => w.emoji)).toEqual([...DEFAULT_EMOJI_FAVORITES, '🐳']);
  });
});
