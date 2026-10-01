import { beforeAll, describe, expect, it } from 'vitest';
import i18next from 'i18next';
import { formatRelativeDate, shortSha } from './history';
import './i18n/register';
import { UI_LANGUAGES } from '../i18n/languages';

// Pinned rather than left to the standalone fallback's own default, so the
// assertions below check the English plural forms they're written against.
beforeAll(async () => {
  await i18next.changeLanguage('en');
});

describe('shortSha', () => {
  it('truncates to 7 characters', () => {
    expect(shortSha('0123456789abcdef')).toBe('0123456');
  });

  it('leaves an already-short sha alone', () => {
    expect(shortSha('abc')).toBe('abc');
  });
});

describe('formatRelativeDate', () => {
  const now = new Date('2026-08-20T12:00:00.000Z');

  it('reports "just now" for anything under a minute', () => {
    expect(formatRelativeDate(new Date(now.getTime() - 30_000).toISOString(), now)).toBe('just now');
  });

  it('uses correct plural forms for minutes', () => {
    expect(formatRelativeDate(new Date(now.getTime() - 1 * 60_000).toISOString(), now)).toBe('1 minute ago');
    expect(formatRelativeDate(new Date(now.getTime() - 2 * 60_000).toISOString(), now)).toBe('2 minutes ago');
    expect(formatRelativeDate(new Date(now.getTime() - 5 * 60_000).toISOString(), now)).toBe('5 minutes ago');
    expect(formatRelativeDate(new Date(now.getTime() - 11 * 60_000).toISOString(), now)).toBe('11 minutes ago');
    expect(formatRelativeDate(new Date(now.getTime() - 21 * 60_000).toISOString(), now)).toBe('21 minutes ago');
  });

  it('uses correct plural forms for hours', () => {
    expect(formatRelativeDate(new Date(now.getTime() - 1 * 3_600_000).toISOString(), now)).toBe('1 hour ago');
    expect(formatRelativeDate(new Date(now.getTime() - 3 * 3_600_000).toISOString(), now)).toBe('3 hours ago');
    expect(formatRelativeDate(new Date(now.getTime() - 5 * 3_600_000).toISOString(), now)).toBe('5 hours ago');
  });

  it('uses correct plural forms for days, staying under the 30-day cutoff', () => {
    expect(formatRelativeDate(new Date(now.getTime() - 1 * 86_400_000).toISOString(), now)).toBe('1 day ago');
    expect(formatRelativeDate(new Date(now.getTime() - 3 * 86_400_000).toISOString(), now)).toBe('3 days ago');
    expect(formatRelativeDate(new Date(now.getTime() - 5 * 86_400_000).toISOString(), now)).toBe('5 days ago');
  });

  it('falls back to a localized date past ~30 days', () => {
    const result = formatRelativeDate(new Date(now.getTime() - 40 * 86_400_000).toISOString(), now);
    expect(result).not.toMatch(/ago/);
    expect(result).toMatch(/\d{4}/); // contains a year
  });

  it('has a plural form for every count in every language that has a bundle (round 10)', async () => {
    for (const lang of UI_LANGUAGES) {
      await i18next.changeLanguage(lang);
      for (const count of [1, 2, 5, 11, 21]) {
        const text = formatRelativeDate(new Date(now.getTime() - count * 60_000).toISOString(), now);
        expect(text, `${lang}:${count}`).toContain(String(count));
        expect(text, `${lang}:${count}`).not.toContain('minutesAgo');
      }
    }
    await i18next.changeLanguage('en');
  });
});
