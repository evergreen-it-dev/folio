import { describe, expect, it } from 'vitest';
import { minimalReplace } from './text-edit';

/** Apply the replacement the way CodeMirror would, to check it round-trips. */
const apply = (from: string, to: string): string => {
  const change = minimalReplace(from, to);
  if (!change) return from;
  return from.slice(0, change.from) + change.insert + from.slice(change.to);
};

describe('minimalReplace', () => {
  it('reports no change when the two strings match', () => {
    expect(minimalReplace('flowchart TD', 'flowchart TD')).toBeNull();
  });

  it('touches only the word that changed', () => {
    expect(minimalReplace('flowchart TD\n  A[Start] --> B', 'flowchart TD\n  A[Begin] --> B')).toEqual(
      { from: 17, to: 22, insert: 'Begin' },
    );
  });

  it('describes a pure insertion as an empty range', () => {
    const change = minimalReplace('A --> B', 'A --> B\nB --> C');
    expect(change).toEqual({ from: 7, to: 7, insert: '\nB --> C' });
  });

  it('describes a pure deletion as an empty insert', () => {
    expect(minimalReplace('A --> B\nB --> C', 'A --> B')).toEqual({ from: 7, to: 15, insert: '' });
  });

  it('never lets the trimmed suffix run past the trimmed prefix', () => {
    // 'aaa' -> 'aa': prefix and suffix both want the same characters.
    expect(apply('aaa', 'aa')).toBe('aa');
    expect(apply('aa', 'aaa')).toBe('aaa');
    expect(apply('', 'abc')).toBe('abc');
    expect(apply('abc', '')).toBe('');
  });

  it('round-trips a realistic canvas edit', () => {
    const before = 'flowchart TD\n  A[Start] --> B{OK?}\n  B -->|yes| C[Done]';
    const after = 'flowchart TD\n  A[Start] --> B{OK?}\n  B -->|yes| C[Done]\n  B -->|no| D[Stop]';
    expect(apply(before, after)).toBe(after);
    expect(apply(after, before)).toBe(before);
  });
});
