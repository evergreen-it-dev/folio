import { describe, expect, it } from 'vitest';
import { createMinimaxStreamFilter, parseMinimaxModel } from './minimax.js';

function feed(chunks: string[]): { text: string; reasoning: string } {
  const filter = createMinimaxStreamFilter();
  let text = '';
  let reasoning = '';
  for (const chunk of chunks) {
    const out = filter.push(chunk);
    text += out.text;
    reasoning += out.reasoning;
  }
  return { text: text + filter.flush(), reasoning };
}

describe('createMinimaxStreamFilter', () => {
  const source = '<think>first</think>\n\nAnswer one. <think>second</think>Answer two.<minimax:tool_call>name</minimax:tool_call> End.';

  it('gives the same result however the text is split across chunks', () => {
    const whole = feed([source]);
    expect(whole).toEqual({ text: 'Answer one. Answer two. End.', reasoning: 'firstsecond' });
    expect(feed(source.split(''))).toEqual(whole);
    for (let cut = 1; cut < source.length; cut += 1) {
      expect(feed([source.slice(0, cut), source.slice(cut)])).toEqual(whole);
    }
  });

  it('drops an unclosed hidden block and keeps text that only looks like a tag', () => {
    expect(feed(['Answer <think>never closed'])).toEqual({ text: 'Answer ', reasoning: 'never closed' });
    expect(feed(['a < b and <thi'])).toEqual({ text: 'a < b and <thi', reasoning: '' });
  });
});

describe('parseMinimaxModel', () => {
  it('turns the thinking suffix into a flag', () => {
    expect(parseMinimaxModel('MiniMax-M3-thinking')).toEqual({ model: 'MiniMax-M3', thinking: true });
    expect(parseMinimaxModel('MiniMax-M3.1-Flash')).toEqual({ model: 'MiniMax-M3.1-Flash', thinking: false });
  });
});
