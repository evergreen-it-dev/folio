import { afterEach, describe, expect, it } from 'vitest';
import i18next from 'i18next';
import { bundlesFrom } from '../i18n/bundles';
import { UI_LANGUAGES } from '../i18n/languages';
import { STANDALONE_LANGUAGE } from '../i18n/standalone';
import { NS, t } from './i18n';

/** Every bundle the editor ships, keyed by language. */
const BUNDLES: Record<string, unknown> = bundlesFrom(import.meta.glob('./i18n/*.json', { eager: true, import: 'default' }));
const LANGUAGES = Object.keys(BUNDLES);

function flatten(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flatten(child, prefix ? `${prefix}.${key}` : key),
  );
}

afterEach(async () => {
  await i18next.changeLanguage(STANDALONE_LANGUAGE);
});

describe('editor bundles', () => {
  it('ships one bundle per interface language', () => {
    expect([...LANGUAGES].sort()).toEqual([...UI_LANGUAGES].sort());
  });

  it('defines exactly the same keys in every language', () => {
    const reference = flatten(BUNDLES.en).sort();
    for (const lang of LANGUAGES) expect(flatten(BUNDLES[lang]).sort(), lang).toEqual(reference);
  });

  it('leaves no value empty', () => {
    for (const [lang, bundle] of Object.entries(BUNDLES)) {
      const empty = flatten(bundle).filter((key) => !i18next.t(`${NS}:${key}`, { lng: lang }));
      expect(empty, `empty values in ${lang}`).toEqual([]);
    }
  });

  it('translates rather than transliterates — the languages differ', () => {
    for (const key of [
      'mode.reading',
      'table.addRow',
      'mermaid.save',
      'upload.onlyImages',
      'preview.missing',
      'slash.expand.name',
    ]) {
      const values = LANGUAGES.map((lng) => i18next.t(`${NS}:${key}`, { lng }));
      expect(new Set(values).size, `${key} should differ across languages`).toBe(LANGUAGES.length);
    }
  });
});

describe('runtime lookup', () => {
  it('defaults to the standalone language', () => {
    expect(i18next.language).toBe(STANDALONE_LANGUAGE);
    expect(t('mode.reading')).toBe('Reading');
  });

  it('follows a language switch without re-registering anything', async () => {
    const seen = new Set<string>();
    for (const lang of LANGUAGES) {
      await i18next.changeLanguage(lang);
      seen.add(t('mode.reading'));
    }
    expect(seen.size).toBe(LANGUAGES.length);
  });

  it('interpolates values', () => {
    expect(t('table.headerPlaceholder', { n: 3 })).toBe('Column 3');
    expect(t('upload.failed', { name: 'a.png' })).toBe('Could not upload a.png');
  });

  it('keeps diagram templates translated as whole bodies', () => {
    expect(t('templateCode.flowchart')).toContain('Start');
    for (const lng of LANGUAGES.filter((code) => code !== 'en')) {
      expect(i18next.t(`${NS}:templateCode.flowchart`, { lng }), lng).not.toContain('Start');
    }
  });
});
