// @vitest-environment jsdom
/**
 * Callout headings in live mode (round 22).
 *
 * The point of the round was that "NOTE" was the one word on a translated page
 * that stayed English. The point of THIS test is that live mode says it with
 * the same five words reading mode does — the markdown zone's `alerts.*`
 * bundle, not a second copy living here that could drift.
 */
import i18next from 'i18next';
import { afterEach, describe, expect, it } from 'vitest';
import { UI_LANGUAGES } from '../i18n/languages';
import { t as markdownT } from '../markdown/i18n/register';
import { CALLOUT_TYPES } from './live-decorations';
import { CalloutLabelWidget, calloutLabel } from './widgets';

const render = (type: (typeof CALLOUT_TYPES)[number]): string =>
  new CalloutLabelWidget(type, i18next.language).toDOM().textContent ?? '';

afterEach(async () => {
  await i18next.changeLanguage('en');
});

describe('CalloutLabelWidget', () => {
  it('heads a callout in the interface language', async () => {
    expect(render('note')).toBe('Note');
    expect(render('caution')).toBe('Caution');

    const headings = new Set<string>();
    for (const lang of UI_LANGUAGES) {
      await i18next.changeLanguage(lang);
      headings.add(render('note'));
    }
    expect(headings.size).toBe(UI_LANGUAGES.length);
  });

  it('names every alert type in every language', async () => {
    for (const lang of UI_LANGUAGES) {
      await i18next.changeLanguage(lang);
      for (const type of CALLOUT_TYPES) {
        const label = calloutLabel(type);
        // A missing bundle would hand back the key itself.
        expect(label, `${type} in ${lang}`).not.toContain('alerts.');
        expect(label.trim(), `${type} in ${lang}`).not.toBe('');
      }
    }
  });

  it('says exactly what reading mode says', async () => {
    for (const lang of UI_LANGUAGES) {
      await i18next.changeLanguage(lang);
      for (const type of CALLOUT_TYPES) {
        // markdown/alerts.ts writes this very string into `data-alert-label`.
        expect(render(type), `${type} in ${lang}`).toBe(markdownT(`alerts.${type}`));
      }
    }
  });

  it('is rebuilt on a language switch rather than kept from the cache', () => {
    const uk = new CalloutLabelWidget('tip', 'uk');
    expect(uk.eq(new CalloutLabelWidget('tip', 'uk'))).toBe(true);
    expect(uk.eq(new CalloutLabelWidget('tip', 'en'))).toBe(false);
    expect(uk.eq(new CalloutLabelWidget('note', 'uk'))).toBe(false);
  });

  it('keeps the icon beside the name', () => {
    const dom = new CalloutLabelWidget('warning', 'uk').toDOM();
    expect(dom.className).toBe('cm-md-callout__label');
    expect(dom.querySelector('svg')).not.toBeNull();
  });
});
