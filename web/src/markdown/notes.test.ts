// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import i18next from 'i18next';
import { extractNotes } from './notes';
import { renderMarkdownToHtml } from './pipeline';
import './i18n/register';

// Same reasoning as pipeline.test.ts's own pin: check what a real user sees today.
beforeAll(async () => {
  await i18next.changeLanguage('en');
});

const opts = { space: 'engineering', pagePath: 'architecture/data-flow.md' };

describe('extractNotes', () => {
  it('finds every callout type, in document order, with the marker stripped', () => {
    const markdown = [
      '> [!NOTE]',
      '> a note',
      '',
      '> [!TIP]',
      '> a tip',
      '',
      '> [!IMPORTANT]',
      '> important body',
      '',
      '> [!WARNING]',
      '> warning body',
      '',
      '> [!CAUTION]',
      '> caution body',
      '',
    ].join('\n');

    const entries = extractNotes(markdown);
    expect(entries.map((e) => e.kind)).toEqual(['note', 'tip', 'important', 'warning', 'caution']);
    expect(entries.map((e) => e.text)).toEqual([
      'a note',
      'a tip',
      'important body',
      'warning body',
      'caution body',
    ]);
    expect(entries.every((e) => e.checked === false)).toBe(true);
  });

  it('falls back to the (translated) type label when a callout has no body', () => {
    const entries = extractNotes('> [!NOTE]\n');
    expect(entries).toEqual([{ kind: 'note', checked: false, text: i18next.t('markdown:alerts.note'), pos: 0 }]);
  });

  it('takes only the first non-empty line of a multi-line/multi-paragraph body', () => {
    const markdown = '> [!TIP]\n>\n> first line\n> second line\n';
    const entries = extractNotes(markdown);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('first line');
  });

  it('finds checked and unchecked checklist items, with checked flagged separately', () => {
    const markdown = '- [ ] todo one\n- [x] done one\n';
    const entries = extractNotes(markdown);
    expect(entries).toEqual([
      { kind: 'task', checked: false, text: 'todo one', pos: markdown.indexOf('- [ ]') },
      { kind: 'task', checked: true, text: 'done one', pos: markdown.indexOf('- [x]') },
    ]);
  });

  it('does not treat an ordinary (non-checklist) list item as an entry', () => {
    expect(extractNotes('- plain bullet\n- another\n')).toEqual([]);
  });

  it('keeps document order across mixed headings/paragraphs/callouts/tasks', () => {
    const markdown = [
      '# Title',
      '',
      'intro',
      '',
      '- [ ] first',
      '',
      '> [!WARNING]',
      '> careful',
      '',
      '- [x] second',
      '',
    ].join('\n');

    const entries = extractNotes(markdown);
    expect(entries.map((e) => e.kind)).toEqual(['task', 'warning', 'task']);
    expect(entries.map((e) => e.checked)).toEqual([false, false, true]);
    expect(entries.map((e) => e.text)).toEqual(['first', 'careful', 'second']);
    // Document order: each entry's own offset should increase monotonically.
    expect(entries[0].pos).toBeLessThan(entries[1].pos);
    expect(entries[1].pos).toBeLessThan(entries[2].pos);
  });

  it('ignores a callout/checklist written inside a fenced code block', () => {
    const markdown = ['```md', '- [ ] fake task', '> [!NOTE]', '> fake note', '```', ''].join('\n');
    expect(extractNotes(markdown)).toEqual([]);
  });

  it('shifts offsets past a frontmatter block', () => {
    const markdown = '---\nicon: 📘\ncover: /a.png\n---\n- [ ] todo\n';
    const entries = extractNotes(markdown);
    expect(entries).toHaveLength(1);
    expect(entries[0].pos).toBe(markdown.indexOf('- [ ] todo'));
  });

  it('does not see a checklist marker written inside a table cell', () => {
    // GFM table cells are inline-only in mdast — a `[ ]`/`[x]` line there only
    // becomes a real checklist item at the hast/rendering stage
    // (tableExtensions.ts's rehypeCellLists), which extractNotes never runs —
    // see noteIds.ts's own doc comment for the deliberate consequence.
    const markdown = '| a |\n| - |\n| [ ] cell task |\n';
    expect(extractNotes(markdown)).toEqual([]);
  });

  it('finds a checked item nested inside a callout, and a callout nested inside a list item, each as its own entry', () => {
    const markdown = ['- outer item', '  > [!TIP]', '  > callout body', '  >', '  > - [x] nested task', ''].join(
      '\n',
    );
    const entries = extractNotes(markdown);
    expect(entries.map((e) => e.kind)).toEqual(['tip', 'task']);
    expect(entries[0].text).toBe('callout body');
    expect(entries[1]).toMatchObject({ kind: 'task', checked: true, text: 'nested task' });
  });
});

/**
 * KRITICHNO (see the task brief): extractNotes (mdast, raw markdown) and
 * noteIds.ts's rehypeAssignNoteIds (hast, the rendered pipeline) must find
 * the same entries in the same order, or a Notes-panel click in reading mode
 * (data-note-index lookup) lands on the wrong element. Exercised here on one
 * document nesting a checklist item inside a callout, a callout inside a
 * list item, AND a checklist marker inside a table cell — the one case that
 * genuinely can't agree (see notes.ts/noteIds.ts's own doc comments): a
 * table cell's `[ ]`/`[x]` line has no mdast listItem at all, so this test
 * asserts both sides agree to drop it entirely, rather than forcing a count
 * match some other way.
 */
describe('extractNotes / rehypeAssignNoteIds: numbering parity', () => {
  it('stamps data-note-index on exactly the entries extractNotes finds, in the same order', () => {
    const markdown = [
      '- outer item',
      '  > [!TIP]',
      '  > callout body',
      '  >',
      '  > - [ ] nested task',
      '',
      '| a |',
      '| - |',
      '| [ ] cell task |',
      '',
      '- [x] top-level done',
      '',
    ].join('\n');

    const entries = extractNotes(markdown);
    expect(entries.map((e) => e.kind)).toEqual(['tip', 'task', 'task']);

    const html = renderMarkdownToHtml(markdown, opts);
    document.body.innerHTML = html;
    const stamped = Array.from(document.body.querySelectorAll<HTMLElement>('[data-note-index]'));

    expect(stamped).toHaveLength(entries.length);

    const byIndex = stamped.slice().sort((a, b) => Number(a.dataset.noteIndex) - Number(b.dataset.noteIndex));
    byIndex.forEach((el, i) => {
      expect(el.dataset.noteIndex).toBe(String(i));
      if (entries[i].kind === 'task') {
        expect(el.tagName).toBe('LI');
        expect(el.className).toContain('task-list-item');
        const checkbox = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
        expect(checkbox.checked).toBe(entries[i].checked);
      } else {
        expect(el.tagName).toBe('DIV');
        expect(el.dataset.alert).toBe(entries[i].kind);
      }
    });

    // The table-cell checklist marker produced no entry on either side.
    expect(html).toContain('cell task');
    const tableCell = document.body.querySelector('td, th');
    expect(tableCell?.querySelector('[data-note-index]')).toBeNull();
  });
});
