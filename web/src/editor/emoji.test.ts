import { describe, expect, it } from 'vitest';
import { DEFAULT_EMOJI_FAVORITES } from '../../../shared/contracts';
import {
  closingColonExpansion,
  findColonQuery,
  findEmojiTrigger,
  findParenQuery,
  rankEmoji,
} from './emoji-complete';
import { EMOJI, emojiByName } from './emoji-data';
import { isEffectivelyEmpty } from './live-decorations';
import {
  HEADER_ROW,
  parseGfmTable,
  serializeGfmTable,
  setCell,
} from './gfm-table';

describe('findColonQuery', () => {
  it('needs two characters before it means anything', () => {
    expect(findColonQuery(':p')).toBeNull();
    expect(findColonQuery(':pl')).toEqual({ kind: 'colon', from: 1, triggerLength: 1, query: 'pl' });
  });

  it('reports where the query starts', () => {
    expect(findColonQuery('text :pl')).toMatchObject({ query: 'pl', from: 6 });
  });

  it('stays out of URLs and clock times', () => {
    expect(findColonQuery('see http://example.com')).toBeNull();
    expect(findColonQuery('at 12:30')).toBeNull();
    expect(findColonQuery('word:ab')).toBeNull();
  });

  it('ignores queries with spaces or punctuation', () => {
    expect(findColonQuery(': plus')).toBeNull();
    expect(findColonQuery(':pl.us')).toBeNull();
  });

  it('opens after a boundary mid-line', () => {
    expect(findColonQuery('done :ch')).toMatchObject({ query: 'ch' });
  });
});

describe('findParenQuery', () => {
  it('opens immediately on a bare `((`', () => {
    expect(findParenQuery('((')).toEqual({ kind: 'paren', from: 2, triggerLength: 2, query: '' });
  });

  it('filters as letters arrive', () => {
    expect(findParenQuery('((pl')).toMatchObject({ query: 'pl' });
    expect(findParenQuery('text ((st')).toMatchObject({ query: 'st', from: 7 });
  });

  it('bails when the next character is not word-ish', () => {
    expect(findParenQuery('(()')).toBeNull();
    expect(findParenQuery('((a)')).toBeNull();
    expect(findParenQuery('(( note')).toBeNull();
  });

  it('returns null without the pair', () => {
    expect(findParenQuery('(one')).toBeNull();
  });
});

describe('findEmojiTrigger', () => {
  it('prefers whichever trigger is closer to the caret', () => {
    expect(findEmojiTrigger('((ab :cd')).toMatchObject({ kind: 'colon', query: 'cd' });
    expect(findEmojiTrigger(':cd ((ab')).toMatchObject({ kind: 'paren', query: 'ab' });
  });

  it('returns null for ordinary prose', () => {
    expect(findEmojiTrigger('ordinary text')).toBeNull();
  });
});

describe('closingColonExpansion', () => {
  it('expands a full shortcode on the closing colon', () => {
    expect(closingColonExpansion(':plus')).toEqual({ from: 0, emoji: '➕' });
    expect(closingColonExpansion('done :check')).toEqual({ from: 5, emoji: '✅' });
  });

  it('expands aliases too', () => {
    expect(closingColonExpansion(':favourite')).toEqual({ from: 0, emoji: '⭐' });
    expect(closingColonExpansion(':attention')).toEqual({ from: 0, emoji: '⚠️' });
  });

  it('leaves unknown names alone', () => {
    expect(closingColonExpansion(':notanemoji')).toBeNull();
    expect(closingColonExpansion('at 12:30')).toBeNull();
  });
});

describe('emoji name map', () => {
  it('resolves every emoji the owner named', () => {
    const required: [string, string][] = [
      ['plus', '➕'],
      ['minus', '➖'],
      ['soon', '🔜'],
      ['tools', '🛠️'],
      ['warning', '⚠️'],
      ['new', '🆕'],
      ['star', '⭐'],
    ];
    for (const [name, emoji] of required) expect(emojiByName(name)?.emoji).toBe(emoji);
  });

  it('resolves the aliases for them', () => {
    const aliases: [string, string][] = [
      ['add', '➕'],
      ['remove', '➖'],
      ['later', '🔜'],
      ['hammer', '🛠️'],
      ['attention', '⚠️'],
      ['fresh', '🆕'],
      ['favourite', '⭐'],
    ];
    for (const [alias, emoji] of aliases) expect(emojiByName(alias)?.emoji).toBe(emoji);
  });

  it('covers every shared default favourite by name and by alias', () => {
    for (const emoji of DEFAULT_EMOJI_FAVORITES) {
      expect(EMOJI.some((entry) => entry.emoji === emoji)).toBe(true);
    }
    expect(emojiByName('done')?.emoji).toBe('✅');
    expect(emojiByName('noentry')?.emoji).toBe('⛔');
    expect(emojiByName('important')?.emoji).toBe('❗');
    expect(emojiByName('forbidden')?.emoji).toBe('🚫');
    expect(emojiByName('love')?.emoji).toBe('❤️');
  });

  it('carries a usable common set', () => {
    expect(EMOJI.length).toBeGreaterThanOrEqual(60);
  });
});

describe('rankEmoji', () => {
  it('lists favourites first when there is no query', () => {
    const ranked = rankEmoji('', DEFAULT_EMOJI_FAVORITES, 12);
    expect(ranked.map((entry) => entry.emoji)).toEqual([...DEFAULT_EMOJI_FAVORITES]);
  });

  it('shows all twelve defaults in the bare `((` panel', () => {
    const ranked = rankEmoji('', DEFAULT_EMOJI_FAVORITES, 40).map((entry) => entry.emoji);
    for (const emoji of DEFAULT_EMOJI_FAVORITES) expect(ranked).toContain(emoji);
  });

  it('puts the owner-required set above the rest without favourites', () => {
    const top = rankEmoji('', [], 7).map((entry) => entry.name);
    expect(top.sort()).toEqual(['minus', 'new', 'plus', 'soon', 'star', 'tools', 'warning']);
  });

  it('matches by name and by alias', () => {
    expect(rankEmoji('plus', [], 1)[0].emoji).toBe('➕');
    expect(rankEmoji('pl', [], 1)[0].emoji).toBe('➕');
    expect(rankEmoji('favo', [], 1)[0].emoji).toBe('⭐');
  });

  it('returns nothing for a query that matches no name', () => {
    expect(rankEmoji('zzzzqq', [])).toEqual([]);
  });

  it('still lists a favourite our name map does not know', () => {
    const ranked = rankEmoji('', ['🦄🦄'], 5).map((entry) => entry.emoji);
    expect(ranked[0]).toBe('🦄🦄');
  });

  it('honours the limit', () => {
    expect(rankEmoji('', [], 5)).toHaveLength(5);
  });
});

describe('emoji in markdown', () => {
  it('is plain text through a table round trip, alongside escaped pipes', () => {
    const table = parseGfmTable('| a | b |\n| --- | --- |\n| 1 | 2 |')!;
    const edited = setCell(setCell(table, HEADER_ROW, 0, '⭐ Status'), 0, 1, 'yes | no ✅');
    const markdown = serializeGfmTable(edited);
    expect(markdown).toContain('⭐ Status');
    expect(markdown).toContain('yes \\| no ✅');

    const reparsed = parseGfmTable(markdown)!;
    expect(reparsed.header[0]).toBe('⭐ Status');
    expect(reparsed.rows[0][1]).toBe('yes | no ✅');
  });

  it('needs no escaping inside bold or a heading', () => {
    const table = parseGfmTable('| a |\n| --- |')!;
    const markdown = serializeGfmTable(setCell(table, HEADER_ROW, 0, '**🔥 on fire**'));
    expect(parseGfmTable(markdown)?.header[0]).toBe('**🔥 on fire**');
  });
});

describe('isEffectivelyEmpty', () => {
  it('is true for a blank document', () => {
    expect(isEffectivelyEmpty('')).toBe(true);
    expect(isEffectivelyEmpty('   \n\n  ')).toBe(true);
  });

  it('is true for an H1 alone, with or without trailing blanks', () => {
    expect(isEffectivelyEmpty('# Heading')).toBe(true);
    expect(isEffectivelyEmpty('# Heading\n')).toBe(true);
    expect(isEffectivelyEmpty('# Heading\n\n\n')).toBe(true);
    expect(isEffectivelyEmpty('\n# Heading\n\n')).toBe(true);
  });

  it('is false as soon as there is real content', () => {
    expect(isEffectivelyEmpty('# Heading\n\nText')).toBe(false);
    expect(isEffectivelyEmpty('Text')).toBe(false);
    expect(isEffectivelyEmpty('# A\n# B')).toBe(false);
    expect(isEffectivelyEmpty('## Subheading')).toBe(false);
    expect(isEffectivelyEmpty('- item')).toBe(false);
  });
});
