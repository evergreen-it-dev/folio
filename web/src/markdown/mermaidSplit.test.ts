import { describe, expect, it } from 'vitest';
import { splitMermaidFences } from './mermaidSplit';

describe('splitMermaidFences', () => {
  it('returns a single text segment when there is no mermaid fence', () => {
    const md = '# Title\n\nSome *text* and a [link](./x.md).';
    expect(splitMermaidFences(md)).toEqual([{ type: 'text', value: md }]);
  });

  it('splits out a single top-level mermaid fence', () => {
    const md = ['Before.', '', '```mermaid', 'flowchart LR', '  A --> B', '```', '', 'After.'].join('\n');
    const segments = splitMermaidFences(md);
    expect(segments).toEqual([
      { type: 'text', value: 'Before.\n' },
      { type: 'mermaid', code: 'flowchart LR\n  A --> B' },
      { type: 'text', value: '\nAfter.' },
    ]);
  });

  it('splits multiple mermaid fences and keeps the text between them', () => {
    const md = ['```mermaid', 'pie', '```', 'middle', '```mermaid', 'gantt', '```'].join('\n');
    const segments = splitMermaidFences(md);
    expect(segments.filter((s) => s.type === 'mermaid')).toEqual([
      { type: 'mermaid', code: 'pie' },
      { type: 'mermaid', code: 'gantt' },
    ]);
    expect(segments.some((s) => s.type === 'text' && s.value.includes('middle'))).toBe(true);
  });

  it('does not split a mermaid fence nested inside another fenced block', () => {
    const md = ['```text', 'Example:', '```mermaid', 'flowchart LR', 'A --> B', '```', '```'].join('\n');
    const segments = splitMermaidFences(md);
    expect(segments).toEqual([{ type: 'text', value: md }]);
  });

  it('supports tilde fences, dropping the empty leading text segment', () => {
    const md = ['~~~mermaid', 'pie title x', '~~~'].join('\n');
    expect(splitMermaidFences(md)).toEqual([{ type: 'mermaid', code: 'pie title x' }]);
  });

  it('is case-insensitive on the "mermaid" info string and ignores trailing text', () => {
    const md = ['```Mermaid ', 'sequenceDiagram', '```'].join('\n');
    const segments = splitMermaidFences(md);
    expect(segments.some((s) => s.type === 'mermaid' && s.code === 'sequenceDiagram')).toBe(true);
  });

  it('treats an unterminated mermaid fence as running to the end of the document', () => {
    const md = ['intro', '```mermaid', 'flowchart LR', 'A --> B'].join('\n');
    const segments = splitMermaidFences(md);
    expect(segments).toEqual([
      { type: 'text', value: 'intro' },
      { type: 'mermaid', code: 'flowchart LR\nA --> B' },
    ]);
  });

  it('only looks at the first info-string token, like CommonMark language matching', () => {
    const md = ['```mermaid {theme: forest}', 'flowchart LR', '```'].join('\n');
    const segments = splitMermaidFences(md);
    expect(segments.some((s) => s.type === 'mermaid' && s.code === 'flowchart LR')).toBe(true);

    const other = ['```js mermaid-ish', 'const x = 1;', '```'].join('\n');
    expect(splitMermaidFences(other)).toEqual([{ type: 'text', value: other }]);
  });

  it('strips a leading frontmatter block before splitting (round 5: icon/cover round-trip through markdown)', () => {
    const md = '---\nicon: "📄"\n---\n\nBefore.\n\n```mermaid\npie\n```\n';
    const segments = splitMermaidFences(md);
    expect(segments[0]).toEqual({ type: 'text', value: '\nBefore.\n' });
    expect(segments.some((s) => s.type === 'mermaid' && s.code === 'pie')).toBe(true);
    expect(segments.every((s) => s.type !== 'text' || !s.value.includes('icon:'))).toBe(true);
  });
});
