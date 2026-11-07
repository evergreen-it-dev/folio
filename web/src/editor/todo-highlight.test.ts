import { Text } from '@codemirror/state';
import { GFM, parser } from '@lezer/markdown';
import { describe, expect, it } from 'vitest';
import { computeTodoRanges } from './todo-highlight';

const md = parser.configure(GFM);

const marked = (source: string): string[] => {
  const doc = Text.of(source.split('\n'));
  return computeTodoRanges({ doc, tree: md.parse(source), ranges: [{ from: 0, to: doc.length }] }).map(
    (range) => `${range.from}:${source.slice(range.from, range.to)}`,
  );
};

describe('computeTodoRanges', () => {
  it('marks the whole word, also before a colon, and every one on a line', () => {
    expect(marked('a (TODO: @ann) TODO')).toEqual(['3:TODO', '15:TODO']);
  });

  it('leaves TODOS, todo, code, strikethrough and URLs alone', () => {
    const source = ['TODOS todo', '`TODO`', '```', 'TODO', '```', '~~TODO x~~', 'https://a.b/TODO', '<https://a.b/TODO>'].join('\n');
    expect(marked(source)).toEqual([]);
  });
});
