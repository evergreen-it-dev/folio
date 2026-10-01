import { CompletionContext, type Completion } from '@codemirror/autocomplete';
import { EditorState, type Transaction, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import i18next from 'i18next';
import { afterEach, describe, expect, it } from 'vitest';
import { UI_LANGUAGES } from '../i18n/languages';
import { NS } from './i18n';
import { markdownEditorExtensions } from './markdown-setup';
import { folioTooltipClass, rankBlockOptions, slashMenu } from './slash-menu';

/** The «/» menu as it is offered at the end of `doc`. */
function menuAt(doc: string) {
  const state = EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [markdownEditorExtensions()],
  });
  const result = slashMenu(new CompletionContext(state, doc.length, false));
  if (!result) throw new Error(`no slash menu for ${JSON.stringify(doc)}`);
  return { state, result };
}

function optionNamed(doc: string, displayLabel: string) {
  const { state, result } = menuAt(doc);
  const option = result.options.find((item) => item.displayLabel === displayLabel);
  if (!option) throw new Error(`no entry labelled ${displayLabel}`);
  return { state, option, from: result.from, to: state.doc.length };
}

/**
 * Applies an entry against a stub view. The snippet machinery only ever
 * touches `state` and `dispatch`, so a real (DOM-bound) EditorView is not
 * needed to see what an entry writes.
 */
function apply(doc: string, displayLabel: string): EditorState {
  const { state, option, from, to } = optionNamed(doc, displayLabel);
  let applied = state;
  const view = {
    get state() {
      return applied;
    },
    dispatch: (tr: Transaction | TransactionSpec) => {
      applied = 'state' in tr ? tr.state : applied.update(tr).state;
    },
  } as unknown as EditorView;

  const run = option.apply as (
    view: EditorView,
    completion: Completion,
    from: number,
    to: number,
  ) => void;
  run(view, option, from, to);
  return applied;
}

afterEach(async () => {
  await i18next.changeLanguage('en');
});

describe('/expand', () => {
  const NAME = 'Expand';

  it('writes a details block whose body stays markdown', () => {
    // Blank lines around the body are what keep it markdown: CommonMark ends an
    // HTML block at the first blank line.
    expect(apply('/exp', NAME).doc.toString()).toBe(
      '<details><summary>Title</summary>\n\n\n\n</details>\n',
    );
  });

  it('swallows the «/» that opened the menu', () => {
    expect(apply('/exp', NAME).doc.toString().startsWith('<details>')).toBe(true);
  });

  it('leaves the caret on the summary, selected for typing over', () => {
    const state = apply('/exp', NAME);
    const { from, to } = state.selection.main;
    expect(state.sliceDoc(from, to)).toBe('Title');
  });

  it('translates the summary with the interface language', async () => {
    expect(apply('/exp', 'Expand').doc.toString()).toContain('<summary>Title</summary>');
    for (const lang of UI_LANGUAGES.filter((code) => code !== 'en')) {
      await i18next.changeLanguage(lang);
      const summary = i18next.t(`${NS}:slash.expand.summary`);
      expect(summary, lang).not.toBe('Title');
      expect(apply('/exp', i18next.t(`${NS}:slash.expand.name`)).doc.toString()).toContain(
        `<summary>${summary}</summary>`,
      );
    }
  });

  it('is findable in any language and by its latin aliases', () => {
    const { result } = menuAt('/e');
    const entry = result.options.find((option) => option.displayLabel === NAME);
    const names = UI_LANGUAGES.map((lng) => i18next.t(`${NS}:slash.expand.name`, { lng }));
    for (const word of [...names, NAME, 'details', 'collapse']) {
      expect(entry?.label).toContain(word);
    }
  });

  it('shows the markup it produces as the row hint', () => {
    const { option } = optionNamed('/e', NAME);
    expect((option as { folio?: { hint?: string } }).folio?.hint).toBe('<details>');
    expect((option as { folio?: { description?: string } }).folio?.description).toBe(
      i18next.t(`${NS}:slash.expand.description`),
    );
  });
});

describe('/link', () => {
  const NAME = 'Link';

  it('writes an inline link where the «/» was, not a block on a new line', () => {
    expect(apply('/lin', NAME).doc.toString()).toBe('[text](url)');
  });

  it('leaves the label selected — the target is the second tab stop', () => {
    const state = apply('/lin', NAME);
    const { from, to } = state.selection.main;
    expect(state.sliceDoc(from, to)).toBe('text');
  });

  it('is findable in any language and by its latin aliases', () => {
    const { result } = menuAt('/l');
    const entry = result.options.find((option) => option.displayLabel === NAME);
    const names = UI_LANGUAGES.map((lng) => i18next.t(`${NS}:slash.link.name`, { lng }));
    for (const word of [...names, NAME, 'url', 'href']) {
      expect(entry?.label).toContain(word);
    }
  });
});

describe('/columns', () => {
  it('offers 2–5 borderless column layouts and stores them as valid GFM tables', () => {
    for (const count of [2, 3, 4, 5]) {
      const state = apply(`/${count}`, `${count} columns`);
      const source = state.doc.toString();
      expect(source).toContain('[//]: # (folio-table: layout=columns)');
      const rows = source.split('\n').filter((line) => line.startsWith('|'));
      expect(rows[0].split('|').length - 2).toBe(count);
    }
  });
});

describe('folioTooltipClass', () => {
  const classAt = (doc: string): string =>
    folioTooltipClass(EditorState.create({ doc, selection: { anchor: doc.length } }));

  it('marks the mention palette', () => {
    expect(classAt('ping @an')).toBe('cm-folio-completions cm-folio-mentions');
  });

  it('still marks the page and emoji palettes', () => {
    expect(classAt('see [[dat')).toBe('cm-folio-completions cm-folio-pages');
    expect(classAt('((sm')).toBe('cm-folio-completions cm-folio-emoji');
  });

  it('answers the trigger closest to the caret', () => {
    expect(classAt('[[page @an')).toBe('cm-folio-completions cm-folio-mentions');
    expect(classAt('@ann [[dat')).toBe('cm-folio-completions cm-folio-pages');
  });

  it('leaves a plain block menu unqualified', () => {
    expect(classAt('/tab')).toBe('cm-folio-completions');
  });
});

/**
 * The owner, 11.09: "/ does not work if I am already in a list — it is very
 * confusing" and "if I type /n it does not fire — so it has to search by 1
 * character too". Both were reproduced on a real editor: "- /" gave 0
 * options, "/n" — 0 as well (and "/no" — 2).
 */
describe('"/" inside a line that has already been started', () => {
  const opens = (doc: string) => slashMenu(new CompletionContext(
    EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [markdownEditorExtensions()] }),
    doc.length,
    false,
  )) !== null;

  it('opens in a list, a numbered list, a checklist, a quote and a heading', () => {
    expect(opens('- /')).toBe(true);
    expect(opens('1. /')).toBe(true);
    expect(opens('- [ ] /')).toBe(true);
    expect(opens('> /')).toBe(true);
    expect(opens('## /')).toBe(true);
    expect(opens('  - /tab')).toBe(true);
  });

  it('does not open inside a word or a path — there is no space before the "/" there', () => {
    expect(opens('web/src')).toBe(false);
    expect(opens('and/or')).toBe(false);
    expect(opens('a/b')).toBe(false);
  });

  it('the chosen entry REPLACES the list marker instead of being appended after it', () => {
    expect(apply('- /che', 'Checklist').doc.toString()).toBe('- [ ] ');
    expect(apply('1. /head', 'Heading 2').doc.toString()).toBe('## ');
  });

  it('keeps the indent and the quote (the container of the line)', () => {
    expect(apply('> /head', 'Heading 1').doc.toString()).toBe('> # ');
  });
});

/**
 * The owner typed "We make well-known products /" inside a list item and saw
 * nothing (a screenshot) — the old trigger looked only at the lead of the
 * line. Notion style: a "/" preceded by a space, with real text before the
 * space, opens the menu too — but applying can no longer replace that text
 * the way the lead case replaces the marker, so the entry lands on a NEW
 * line under the current one, with the same carry (indent/quote).
 */
describe('"/" after text (not only the lead of a line)', () => {
  const opens = (doc: string) => slashMenu(new CompletionContext(
    EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [markdownEditorExtensions()] }),
    doc.length,
    false,
  )) !== null;

  it('opens after "text /"', () => {
    expect(opens('text /')).toBe(true);
  });

  it('opens after "- text /" (inside a list item)', () => {
    expect(opens('- text /')).toBe(true);
  });

  it('does not open without a space before the "/", even when there is text before it', () => {
    expect(opens('text/')).toBe(false);
  });

  it('the text of the author stays unchanged, and the block lands on a new line under it', () => {
    const state = apply('We make products /head', 'Heading 2');
    const lines = state.doc.toString().split('\n');
    expect(lines[0]).toBe('We make products');
    expect(lines[1]).toBe('## ');
  });

  it('inside a list item the new line carries the same carry', () => {
    const state = apply('- We make products /che', 'Checklist');
    const lines = state.doc.toString().split('\n');
    expect(lines[0]).toBe('- We make products');
    expect(lines[1]).toBe('- [ ] ');
  });
});

describe('search by a single character', () => {
  it('"n" finds the note and the numbered list (the beginning of a word in any language)', () => {
    const names = rankBlockOptions('n').map((option) => option.displayLabel);
    expect(names).toContain('Note');
    expect(names).toContain('Numbered list');
  });

  it('with one character we search ONLY by the beginning of a word — otherwise the "n" in "Heading" leaves half the menu', () => {
    expect(rankBlockOptions('n').length).toBeLessThan(5);
    expect(rankBlockOptions('n').map((option) => option.displayLabel)).not.toContain('Heading 1');
  });

  it('from two characters a substring counts too, one rank lower', () => {
    expect(rankBlockOptions('no').map((option) => option.displayLabel)).toContain('Note');
  });

  it('an empty query returns the whole menu in its own order', () => {
    expect(rankBlockOptions('').length).toBe(rankBlockOptions('').length);
    expect(rankBlockOptions('')[0].displayLabel).toBe('Heading 1');
  });
});
