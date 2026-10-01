import { describe, expect, it } from 'vitest';
import { translitSlug } from './translit';

// Mirrors server/translit.test.ts's cases exactly — this is a client-side
// port that must stay behaviorally identical, since CreateSpaceDialog.tsx
// uses it to preview the same slug SERVER will actually generate.
describe('translitSlug', () => {
  it('turns a title into a Latin slug', () => {
    expect(translitSlug('Нова дошка')).toBe('nova-doshka');
  });

  it('handles the special digraphs/trigraphs', () => {
    expect(translitSlug('жук і чаша')).toBe('zhuk-i-chasha');
    expect(translitSlug('щука')).toBe('shchuka');
    expect(translitSlug('характеристика')).toBe('kharakteristika');
    expect(translitSlug('цукор')).toBe('tsukor');
  });

  it('drops soft/hard signs entirely rather than mapping them to a character', () => {
    expect(translitSlug('автомобіль')).toBe('avtomobil');
    expect(translitSlug('аъб')).toBe('ab');
  });

  it('maps the letters that other Cyrillic alphabets add', () => {
    expect(translitSlug('ё')).toBe('yo');
    expect(translitSlug('ы')).toBe('y');
    expect(translitSlug('э')).toBe('e');
  });

  it('handles Ukrainian-specific letters', () => {
    expect(translitSlug('і')).toBe('i');
    expect(translitSlug('їжак')).toBe('yizhak');
    expect(translitSlug('єдність')).toBe('yednist');
    expect(translitSlug('ґанок')).toBe('ganok');
  });

  it('lowercases and dash-joins plain ASCII input the same as a Cyrillic one', () => {
    expect(translitSlug('My Board')).toBe('my-board');
    expect(translitSlug('Data Flow!!')).toBe('data-flow');
  });

  it('collapses runs of separators and trims leading/trailing dashes', () => {
    expect(translitSlug('  --Привіт,   Світе!--  ')).toBe('privit-svite');
  });

  it('falls back to a generated slug when nothing alphanumeric survives', () => {
    expect(translitSlug('!!!')).toMatch(/^item-[0-9a-z]+$/);
  });
});
