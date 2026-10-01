import { describe, expect, it } from 'vitest';
import { EMOJI_GRID, filterEmoji } from '../names';

describe('Ukrainian emoji keywords', () => {
  it.each([
    ['смайли', '😀'],
    ['посмішка', '😀'],
    ['їжа', '🍕'],
    ['ракета', '🚀'],
  ])('searches categories and keywords: %s -> %s', (query, emoji) => {
    expect(filterEmoji(query, EMOJI_GRID)).toContain(emoji);
  });

  // The same set the English names are required to cover.
  it.each([
    ['плюс', '➕'],
    ['мінус', '➖'],
    ['скоро', '🔜'],
    ['молотки', '🛠️'],
    ['увага', '⚠️'],
    ['нове', '🆕'],
    ['зірка', '⭐'],
    ['галочка', '✅'],
    ['стоп', '⛔'],
    ['важливо', '❗'],
    ['заборона', '🚫'],
    ['серце', '❤️'],
  ])('finds %s -> %s', (query, emoji) => {
    expect(filterEmoji(query, EMOJI_GRID)).toContain(emoji);
  });
});
