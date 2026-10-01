import { describe, expect, it } from 'vitest';
import { resolveTextLanguage, serverText, serverTextLanguages } from './serverText.js';

describe('serverText', () => {
  it('ships English and Ukrainian', () => {
    expect(serverTextLanguages()).toEqual(expect.arrayContaining(['en', 'uk']));
  });

  it('prefers the saved language when there is a bundle for it', () => {
    expect(resolveTextLanguage('uk', 'en-US,en;q=0.9')).toBe('uk');
  });

  it('falls back to the browser languages, in order', () => {
    expect(resolveTextLanguage(undefined, 'de-DE,uk;q=0.8,en;q=0.5')).toBe('uk');
    expect(resolveTextLanguage('xx', 'en-GB')).toBe('en');
  });

  it('falls back to English when nothing matches', () => {
    expect(resolveTextLanguage(undefined, 'de-DE,fr;q=0.8')).toBe('en');
    expect(resolveTextLanguage(null, null)).toBe('en');
  });

  it('writes the text in the requested language, English otherwise', () => {
    expect(serverText('table.defaultView', 'en')).toBe('All records');
    expect(serverText('table.defaultView', 'uk')).not.toBe('All records');
    expect(serverText('table.defaultView', 'xx')).toBe('All records');
    expect(serverText('table.defaultView')).toBe('All records');
  });
});
