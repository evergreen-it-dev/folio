import { describe, expect, it } from 'vitest';
import { closingColonExpansion, findColonQuery, findParenQuery, rankEmoji } from '../emoji-complete';
import { emojiByName } from '../emoji-data';

describe('Ukrainian emoji aliases', () => {
  it('a Cyrillic query opens both pickers', () => {
    expect(findColonQuery('текст :пл')).toMatchObject({ query: 'пл', from: 7 });
    expect(findParenQuery('текст ((зі')).toMatchObject({ query: 'зі', from: 8 });
  });

  it('a clock time after a Cyrillic word is not a query', () => {
    expect(findColonQuery('о 12:30')).toBeNull();
    expect(closingColonExpansion('о 12:30')).toBeNull();
  });

  it('expands an alias on the closing colon', () => {
    expect(closingColonExpansion(':зірка')).toEqual({ from: 0, emoji: '⭐' });
    expect(closingColonExpansion(':увага')).toEqual({ from: 0, emoji: '⚠️' });
    expect(closingColonExpansion('готово :check')).toEqual({ from: 7, emoji: '✅' });
  });

  it('resolves the aliases of the set the owner named', () => {
    const aliases: [string, string][] = [
      ['плюс', '➕'],
      ['мінус', '➖'],
      ['скоро', '🔜'],
      ['молотки', '🛠️'],
      ['увага', '⚠️'],
      ['нове', '🆕'],
      ['зірка', '⭐'],
    ];
    for (const [alias, emoji] of aliases) expect(emojiByName(alias)?.emoji).toBe(emoji);
  });

  it('resolves the aliases of the default favourites', () => {
    expect(emojiByName('готово')?.emoji).toBe('✅');
    expect(emojiByName('стоп')?.emoji).toBe('⛔');
    expect(emojiByName('важливо')?.emoji).toBe('❗');
    expect(emojiByName('заборона')?.emoji).toBe('🚫');
    expect(emojiByName('серце')?.emoji).toBe('❤️');
  });

  it('ranks by the beginning of an alias', () => {
    expect(rankEmoji('пл', [], 1)[0].emoji).toBe('➕');
    expect(rankEmoji('зір', [], 1)[0].emoji).toBe('⭐');
  });
});
