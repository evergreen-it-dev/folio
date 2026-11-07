// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import i18next from 'i18next';
import { extractTodos } from './todos';
import { renderMarkdownToHtml } from './pipeline';
import './i18n/register';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

const opts = { space: 'engineering', pagePath: 'architecture/data-flow.md' };

describe('extractTodos', () => {
  it('makes one entry per source line, even inside one paragraph, with its assignee', () => {
    const markdown = [
      'This is the mini learning loops',
      'skills for the discovery agent (TODO: @Skravtsov)',
      'Orchestrator for research - Mr Researcher',
    ].join('\n');
    const todos = extractTodos(markdown);
    expect(todos).toHaveLength(1);
    expect(todos[0].text).toBe('skills for the discovery agent (TODO: @Skravtsov)');
    expect(todos[0].assignees).toEqual(['skravtsov']);
    expect(todos[0].index).toBe(0);
  });

  it('collects every handle on the line and one entry per line', () => {
    const todos = extractTodos('TODO @ann and @bob.smith\nplain\nTODO again TODO');
    expect(todos.map((todo) => todo.assignees)).toEqual([['ann', 'bob.smith'], []]);
    expect(todos.map((todo) => todo.index)).toEqual([0, 1]);
  });

  it('takes the assignee from the other columns of a table row', () => {
    const todos = extractTodos('| Task | Owner |\n| --- | --- |\n| TODO ship it | @ann |\n| done | @bob |');
    expect(todos.map((todo) => [todo.text, todo.assignees])).toEqual([['TODO ship it', ['ann']]]);
  });

  it('resolves the markup of the line', () => {
    expect(extractTodos('## TODO **ship** [the docs](x.md)')[0].text).toBe('TODO ship the docs');
  });

  it('skips code, strikethrough, bare URLs, TODOS, todo and a non-ASCII letter next to it', () => {
    const markdown = [
      '`TODO inline`',
      '',
      '```',
      'TODO fenced',
      '```',
      '',
      '    TODO indented',
      '',
      '~~TODO done~~',
      '',
      'https://example.com/TODO/x',
      '',
      'TODOS and todo',
      '',
      '\u0414TODO and TODO\u0434',
    ].join('\n');
    expect(extractTodos(markdown)).toEqual([]);
  });

  it('gives a checked task no entry but keeps its number', () => {
    const todos = extractTodos('- [x] TODO old\n- [ ] TODO new');
    expect(todos.map((todo) => [todo.text, todo.index])).toEqual([['TODO new', 1]]);
  });

  it('points pos at the TODO in the original markdown, frontmatter included', () => {
    const markdown = '---\ntitle: x\n---\n\nfirst line\nsee &amp; TODO now\n';
    const [todo] = extractTodos(markdown);
    expect(markdown.slice(todo.pos, todo.pos + 4)).toBe('TODO');
    expect(markdown.slice(todo.pos - 5, todo.pos)).toBe('amp; ');
  });
});

describe('extractTodos / rehypeTodoMarks: numbering parity', () => {
  it('stamps data-todo-index on every qualifying match, in the order extractTodos counts them', () => {
    const markdown = [
      'intro TODO one',
      'TODO two and TODO three',
      '',
      '- [x] TODO done item',
      '',
      '`TODO code` ~~TODO struck~~ TODOS',
      '',
      '| a |',
      '| - |',
      '| TODO in cell |',
      '',
      '# Heading TODO @ann',
      '',
      '- TODO last',
    ].join('\n');

    const entries = extractTodos(markdown);
    document.body.innerHTML = renderMarkdownToHtml(markdown, opts);
    const spans = Array.from(document.body.querySelectorAll<HTMLElement>('.folio-todo'));

    expect(spans.map((span) => span.dataset.todoIndex)).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    expect(spans.every((span) => span.textContent === 'TODO')).toBe(true);
    expect(entries.map((entry) => entry.index)).toEqual([0, 1, 4, 5, 6]);
    for (const entry of entries) {
      const span = document.body.querySelector(`[data-todo-index="${entry.index}"]`)!;
      expect(span.closest('p, h1, td, li')?.textContent).toContain(entry.text.split(' ')[0]);
    }
  });

  it('highlights without numbering when embedded', () => {
    document.body.innerHTML = renderMarkdownToHtml('TODO x', { ...opts, embedded: true });
    const span = document.body.querySelector<HTMLElement>('.folio-todo')!;
    expect(span).not.toBeNull();
    expect(span.dataset.todoIndex).toBeUndefined();
  });
});
