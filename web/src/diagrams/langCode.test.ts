import { describe, expect, it } from 'vitest';
import { mapToExcalidrawLangCode } from './langCode';

describe('mapToExcalidrawLangCode', () => {
  it('maps uk to Excalidraw\'s uk-UA locale', () => {
    expect(mapToExcalidrawLangCode('uk')).toBe('uk-UA');
  });

  it('maps ru to Excalidraw\'s ru-RU locale', () => {
    expect(mapToExcalidrawLangCode('ru')).toBe('ru-RU');
  });

  it('maps en to Excalidraw\'s own default "en"', () => {
    expect(mapToExcalidrawLangCode('en')).toBe('en');
  });

  it('is case-insensitive and tolerates a region suffix i18next might already carry (e.g. "en-US")', () => {
    expect(mapToExcalidrawLangCode('UK')).toBe('uk-UA');
    expect(mapToExcalidrawLangCode('en-US')).toBe('en');
  });

  it('falls back to "en" for an unrecognized or missing language', () => {
    expect(mapToExcalidrawLangCode('fr')).toBe('en');
    expect(mapToExcalidrawLangCode(undefined)).toBe('en');
    expect(mapToExcalidrawLangCode(null)).toBe('en');
    expect(mapToExcalidrawLangCode('')).toBe('en');
  });
});
