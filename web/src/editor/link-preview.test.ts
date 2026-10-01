import { afterEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { UI_LANGUAGES } from '../i18n/languages';
import { t } from './i18n';
import {
  LruCache,
  firstLines,
  hoverPreviewsSupported,
  linkTargetPath,
  stripLeadingHeading,
} from './link-preview';

describe('linkTargetPath', () => {
  it('resolves a sibling link', () => {
    expect(linkTargetPath('data-flow.md', 'architecture/index.md')).toBe(
      'architecture/data-flow.md',
    );
  });

  it('resolves a parent traversal', () => {
    expect(linkTargetPath('../onboarding.md', 'architecture/data-flow.md')).toBe('onboarding.md');
  });

  it('resolves from a page at the space root', () => {
    expect(linkTargetPath('architecture/index.md', 'index.md')).toBe('architecture/index.md');
  });

  it('unwraps angle-bracketed destinations', () => {
    expect(linkTargetPath('<New page.md>', 'index.md')).toBe('New page.md');
  });

  it('drops anchors and query strings', () => {
    expect(linkTargetPath('spec.md#section', 'index.md')).toBe('spec.md');
    expect(linkTargetPath('spec.md?v=2', 'index.md')).toBe('spec.md');
  });

  it('skips external and absolute links', () => {
    expect(linkTargetPath('https://example.com/a.md', 'index.md')).toBeNull();
    expect(linkTargetPath('//cdn.example.com/a.md', 'index.md')).toBeNull();
    expect(linkTargetPath('/files/eng/a.md', 'index.md')).toBeNull();
    expect(linkTargetPath('mailto:a@b.c', 'index.md')).toBeNull();
  });

  it('skips bare anchors and non-page targets', () => {
    expect(linkTargetPath('#section', 'index.md')).toBeNull();
    expect(linkTargetPath('diagram.png', 'index.md')).toBeNull();
    expect(linkTargetPath('', 'index.md')).toBeNull();
  });

  it('accepts an uppercase extension', () => {
    expect(linkTargetPath('README.MD', 'index.md')).toBe('README.MD');
  });
});

describe('hoverPreviewsSupported', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Records the query so a typo in the media feature can't pass silently. */
  function stubHover(matches: boolean): string[] {
    const asked: string[] = [];
    vi.stubGlobal('window', {
      matchMedia: (query: string) => (asked.push(query), { media: query, matches }),
    });
    return asked;
  }

  it('keeps previews on a pointer that can hover', () => {
    const asked = stubHover(false);
    expect(hoverPreviewsSupported()).toBe(true);
    expect(asked).toEqual(['(hover: none)']);
  });

  it('drops them on a touch screen, where a tap fakes a hover', () => {
    stubHover(true);
    expect(hoverPreviewsSupported()).toBe(false);
  });

  it('assumes hover when the environment cannot answer', () => {
    expect(hoverPreviewsSupported()).toBe(true); // no window at all (SSR/tests)
    vi.stubGlobal('window', {});
    expect(hoverPreviewsSupported()).toBe(true);
  });
});

describe('card copy', () => {
  afterEach(async () => {
    await i18next.changeLanguage('en');
  });

  /**
   * The loading and "not found" states used to be hardcoded in one language. They are
   * the only text the card writes itself (everything else is the page's own
   * markdown), so they have to follow the interface language.
   */
  it('follows the interface language', async () => {
    expect(t('preview.loading')).toBe('Loading…');
    expect(t('preview.missing')).toBe('Page not found');

    for (const lang of UI_LANGUAGES.filter((code) => code !== 'en')) {
      await i18next.changeLanguage(lang);
      expect(t('preview.loading'), lang).not.toBe('Loading…');
      expect(t('preview.missing'), lang).not.toBe('Page not found');
    }
  });
});

describe('stripLeadingHeading', () => {
  it('removes the H1 the card already shows as a title', () => {
    expect(stripLeadingHeading('# Title\n\nBody')).toBe('\nBody');
  });

  it('tolerates leading blank lines', () => {
    expect(stripLeadingHeading('\n\n# Title\nBody')).toBe('Body');
  });

  it('leaves deeper headings and plain text alone', () => {
    expect(stripLeadingHeading('## Sub\nBody')).toBe('## Sub\nBody');
    expect(stripLeadingHeading('Body only')).toBe('Body only');
  });

  it('does not touch a hash that is not a heading', () => {
    expect(stripLeadingHeading('#tag line')).toBe('#tag line');
  });
});

describe('firstLines', () => {
  const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');

  it('truncates to the requested number of lines', () => {
    expect(firstLines(long, 15).trimEnd().split('\n')).toHaveLength(15);
  });

  it('returns short documents untouched', () => {
    expect(firstLines('a\nb', 15)).toBe('a\nb');
  });
});

describe('LruCache', () => {
  it('evicts the oldest entry past the limit', () => {
    const cache = new LruCache<number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('d', 4);
    expect(cache.size).toBe(3);
    expect(cache.has('a')).toBe(false);
    expect(cache.keys()).toEqual(['b', 'c', 'd']);
  });

  it('keeps recently read entries alive', () => {
    const cache = new LruCache<number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.get('a'); // refresh
    cache.set('d', 4);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
  });

  it('overwrites without growing', () => {
    const cache = new LruCache<number>(2);
    cache.set('a', 1);
    cache.set('a', 2);
    expect(cache.size).toBe(1);
    expect(cache.get('a')).toBe(2);
  });

  it('reports a miss as undefined and clears fully', () => {
    const cache = new LruCache<number>(2);
    cache.set('a', 1);
    expect(cache.get('nope')).toBeUndefined();
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('holds the documented 50 previews before evicting', () => {
    const cache = new LruCache<number>(50);
    for (let i = 0; i < 60; i++) cache.set(`k${i}`, i);
    expect(cache.size).toBe(50);
    expect(cache.has('k9')).toBe(false);
    expect(cache.has('k10')).toBe(true);
  });
});
