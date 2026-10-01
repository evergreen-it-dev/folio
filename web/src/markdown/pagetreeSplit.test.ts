import { describe, expect, it } from 'vitest';
import { splitMermaidFences } from './mermaidSplit';
import { parsePagetreeDepth, splitPagetreeDirectives } from './pagetreeSplit';

function split(markdown: string) {
  return splitPagetreeDirectives(splitMermaidFences(markdown));
}

describe('parsePagetreeDepth', () => {
  it('defaults to 2 when absent', () => {
    expect(parsePagetreeDepth(undefined)).toBe(2);
    expect(parsePagetreeDepth(null)).toBe(2);
    expect(parsePagetreeDepth('')).toBe(2);
  });

  it('parses a valid in-range value', () => {
    expect(parsePagetreeDepth('3')).toBe(3);
    expect(parsePagetreeDepth('1')).toBe(1);
    expect(parsePagetreeDepth('5')).toBe(5);
  });

  it('clamps below the minimum and above the maximum', () => {
    expect(parsePagetreeDepth('0')).toBe(1);
    expect(parsePagetreeDepth('-3')).toBe(1);
    expect(parsePagetreeDepth('99')).toBe(5);
  });

  it('falls back to the default for garbage input', () => {
    expect(parsePagetreeDepth('abc')).toBe(2);
  });
});

describe('splitPagetreeDirectives', () => {
  it('leaves plain markdown with no directive as a single text segment', () => {
    const segments = split('# Title\n\nJust a paragraph.\n');
    expect(segments).toEqual([{ type: 'text', value: '# Title\n\nJust a paragraph.\n' }]);
  });

  it('extracts a leaf ::pagetree{depth=N} directive as its own segment', () => {
    const segments = split('# Title\n\n::pagetree{depth=3}\n\nAfter.\n');
    expect(segments.map((s) => s.type)).toEqual(['text', 'pagetree', 'text']);
    const pagetree = segments[1];
    expect(pagetree.type === 'pagetree' && pagetree.depth).toBe(3);
    expect((segments[0] as { value: string }).value).toContain('# Title');
    expect((segments[2] as { value: string }).value).toContain('After.');
  });

  it('defaults depth to 2 when the attribute is omitted', () => {
    const segments = split('::pagetree\n');
    const pagetree = segments.find((s) => s.type === 'pagetree');
    expect(pagetree && pagetree.type === 'pagetree' && pagetree.depth).toBe(2);
  });

  it('extracts a container form :::pagetree{depth=N} ... ::: directive', () => {
    const segments = split(':::pagetree{depth=1}\n:::\n');
    expect(segments.some((s) => s.type === 'pagetree' && s.depth === 1)).toBe(true);
  });

  it('handles multiple directives in one document, each split out independently', () => {
    const segments = split('Before.\n\n::pagetree{depth=1}\n\nMiddle.\n\n::pagetree{depth=4}\n\nAfter.\n');
    expect(segments.map((s) => s.type)).toEqual(['text', 'pagetree', 'text', 'pagetree', 'text']);
    expect((segments[1] as { depth: number }).depth).toBe(1);
    expect((segments[3] as { depth: number }).depth).toBe(4);
  });

  it('does not treat a directive-like string inside a fenced code block as a real directive', () => {
    const segments = split('```\n::pagetree{depth=2}\n```\n');
    expect(segments.every((s) => s.type !== 'pagetree')).toBe(true);
  });

  it('does not treat inline code containing directive-like text as a directive', () => {
    const segments = split('Use `::pagetree{depth=2}` to embed a page tree.');
    expect(segments.every((s) => s.type !== 'pagetree')).toBe(true);
  });

  it('passes mermaid segments through untouched', () => {
    const segments = split('```mermaid\ngraph TD; A-->B;\n```\n\n::pagetree\n');
    expect(segments.map((s) => s.type)).toEqual(['mermaid', 'pagetree']);
  });

  it('drops a text segment that becomes blank after extraction (directive alone on its own line)', () => {
    const segments = split('::pagetree{depth=2}\n');
    expect(segments).toEqual([{ type: 'pagetree', depth: 2 }]);
  });
});
