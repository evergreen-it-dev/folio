import { describe, expect, it } from 'vitest';
import i18next from 'i18next';
import './register';
import { bundlesFrom } from '../../i18n/bundles';
import { STANDALONE_LANGUAGE } from '../../i18n/standalone';

/** Every bundle that lies next to this test, keyed by language. */
const BUNDLES = bundlesFrom(import.meta.glob('./*.json', { eager: true, import: 'default' }));
const LANGUAGES = Object.keys(BUNDLES);

/** Recursively collects dotted key paths from a nested translation object. */
function flattenKeys(obj: object, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'object' && value !== null ? flattenKeys(value, path) : [path];
  });
}

describe('diagrams i18n bundles', () => {
  it('every bundle exposes exactly the same set of keys (no translation left behind)', () => {
    const reference = flattenKeys(BUNDLES.en).sort();
    for (const lang of LANGUAGES) expect(flattenKeys(BUNDLES[lang]).sort(), lang).toEqual(reference);
  });

  it('registers the diagrams namespace for every language, idempotently', () => {
    expect(LANGUAGES).toContain('en');
    for (const lang of LANGUAGES) expect(i18next.hasResourceBundle(lang, 'diagrams'), lang).toBe(true);

    // Re-registering (as a second import site would, e.g. BoardCanvas.tsx
    // and MermaidBlock.tsx both importing this module) must not throw or
    // corrupt state — the module guards with hasResourceBundle itself, but
    // addResourceBundle's own default (non-overwriting) behavior means even
    // a bare re-call has to stay safe.
    expect(() => i18next.addResourceBundle('en', 'diagrams', BUNDLES.en)).not.toThrow();
    expect(i18next.getFixedT('en', 'diagrams')('board.save.saving')).toBe('Saving…');
  });

  it('resolves real translations, not just placeholder keys, in every language', () => {
    const en = i18next.getFixedT('en', 'diagrams');
    expect(en('board.save.saving')).toBe('Saving…');
    expect(en('board.loadFailed')).toBe("Couldn't load the board — saving is disabled");
    expect(en('board.sessionExpired')).toBe('Session expired — please log in again');
    expect(en('board.invalidLink')).toBe('This link is no longer valid');

    for (const lang of LANGUAGES.filter((code) => code !== 'en')) {
      const t = i18next.getFixedT(lang, 'diagrams');
      for (const key of ['board.save.saving', 'board.loadFailed', 'board.sessionExpired', 'board.invalidLink']) {
        expect(t(key), `${lang}:${key}`).not.toBe(key);
        expect(t(key), `${lang}:${key}`).not.toBe(en(key));
      }
    }
  });

  it('interpolates {{time}} into the "saved at" variant', () => {
    const t = i18next.getFixedT('en', 'diagrams');
    expect(t('board.save.savedAt', { time: '14:32' })).toBe('Saved 14:32');
  });

  it('falls back to the standalone language when a language has no bundle registered', () => {
    const fallback = i18next.getFixedT(STANDALONE_LANGUAGE, 'diagrams')('board.loading');
    expect(i18next.getFixedT('fr', 'diagrams')('board.loading')).toBe(fallback);
    expect(fallback).toBe('Loading board…');
  });
});
