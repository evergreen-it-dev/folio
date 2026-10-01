import { describe, expect, it } from 'vitest';
import { createSlugDeduper, extractHeadings } from './headings';
import { slugify } from './slugify';

describe('slugify', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('strips punctuation but keeps letters/numbers/hyphens', () => {
    expect(slugify('What is this, exactly?!')).toBe('what-is-this-exactly');
  });

  it('keeps non-ASCII letters as native slugs instead of transliterating', () => {
    expect(slugify('Wie funktioniert das für Übungen?')).toBe('wie-funktioniert-das-für-übungen');
  });

  it('collapses repeated whitespace to a single hyphen', () => {
    expect(slugify('Too   many    spaces')).toBe('too-many-spaces');
  });
});

describe('createSlugDeduper', () => {
  it('leaves the first occurrence bare and suffixes -2, -3, ... after that', () => {
    const dedupe = createSlugDeduper();
    expect(dedupe('Overview')).toBe('overview');
    expect(dedupe('Overview')).toBe('overview-2');
    expect(dedupe('Overview')).toBe('overview-3');
  });

  it('tracks distinct base slugs independently', () => {
    const dedupe = createSlugDeduper();
    expect(dedupe('Setup')).toBe('setup');
    expect(dedupe('Usage')).toBe('usage');
    expect(dedupe('Setup')).toBe('setup-2');
  });
});

describe('extractHeadings', () => {
  it('extracts headings in document order with their level', () => {
    const md = '# Title\n\nIntro.\n\n## Setup\n\nText.\n\n### Details\n';
    expect(extractHeadings(md)).toEqual([
      { level: 1, text: 'Title', slug: 'title' },
      { level: 2, text: 'Setup', slug: 'setup' },
      { level: 3, text: 'Details', slug: 'details' },
    ]);
  });

  it('flattens inline formatting to plain text', () => {
    const md = '## **Bold** and `code` heading\n';
    expect(extractHeadings(md)[0].text).toBe('Bold and code heading');
  });

  it('dedupes repeated heading text across the whole document', () => {
    const md = '# Doc\n\n## Overview\n\nA.\n\n## Overview\n\nB.\n';
    const headings = extractHeadings(md);
    expect(headings.map((h) => h.slug)).toEqual(['doc', 'overview', 'overview-2']);
  });

  it('does not treat a heading-like line inside a fenced code block as a heading', () => {
    const md = '# Real heading\n\n```\n# not a heading\n```\n';
    expect(extractHeadings(md)).toEqual([{ level: 1, text: 'Real heading', slug: 'real-heading' }]);
  });

  it('does not pick up a mermaid fence\'s content (no pre-split needed)', () => {
    const md = '# Diagram\n\n```mermaid\nflowchart LR\n  A --> B\n```\n';
    expect(extractHeadings(md)).toEqual([{ level: 1, text: 'Diagram', slug: 'diagram' }]);
  });

  it('returns an empty array for markdown with no headings', () => {
    expect(extractHeadings('Just a paragraph.\n')).toEqual([]);
  });

  it('strips a leading frontmatter block instead of picking up a fake heading from it (round 5: icon/cover)', () => {
    // Without stripping, "icon: ..." directly above the closing --- parses
    // as a CommonMark setext h2 underline — a real bug this guards against.
    const md = '---\nicon: "📄"\ncover: "/a/x/y.png"\n---\n\n# Real Title\n\n## Setup\n';
    expect(extractHeadings(md)).toEqual([
      { level: 1, text: 'Real Title', slug: 'real-title' },
      { level: 2, text: 'Setup', slug: 'setup' },
    ]);
  });

  it('dedupes a heading repeated many times into that many distinct, correctly-numbered entries, not an accumulation', () => {
    // Regression coverage for a reported "same entry ~15 times" outline bug
    // — investigated live (2026-08-21): could not reproduce with corrected
    // page content across repeated refetches (window focus/blur cycles) or
    // repeated page-switch navigation, and extractHeadings/createSlugDeduper
    // hold no module-level state that could leak across calls or renders —
    // each call starts a fresh Map (see createSlugDeduper). This guards the
    // one part of that hypothesis that *was* worth pinning down: a document
    // whose H1 genuinely repeats N times must still produce exactly N
    // distinct, sequentially-suffixed entries — never more, never fewer.
    const md = Array.from({ length: 15 }, () => '# Data flow').join('\n\n');
    const headings = extractHeadings(md);
    expect(headings).toHaveLength(15);
    expect(headings.map((h) => h.slug)).toEqual([
      'data-flow',
      ...Array.from({ length: 14 }, (_, i) => `data-flow-${i + 2}`),
    ]);
  });

  it('is idempotent — calling it repeatedly on the same input never accumulates state across calls', () => {
    const md = '# Doc\n\n## Overview\n\nA.\n\n## Overview\n\nB.\n';
    const first = extractHeadings(md);
    const second = extractHeadings(md);
    const third = extractHeadings(md);
    expect(first).toEqual(second);
    expect(second).toEqual(third);
    expect(third).toHaveLength(3);
  });
});
