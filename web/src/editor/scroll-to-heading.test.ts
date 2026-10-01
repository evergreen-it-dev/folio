// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { extractHeadings } from '../markdown/headings';
import {
  clearMountedEditorView,
  headingPositions,
  mountedEditorView,
  scrollActiveEditorToHeading,
  scrollToHeading,
  setMountedEditorView,
} from './scroll-to-heading';

interface StubView {
  view: EditorView;
  dispatched: { selection?: { from: number }; effects?: unknown }[];
  focused: number;
}

function stubView(doc: string): StubView {
  const stub: StubView = {
    dispatched: [],
    focused: 0,
    view: {
      state: EditorState.create({ doc }),
      focus: () => {
        stub.focused++;
      },
      dispatch: (spec: { selection?: { from: number }; effects?: unknown }) => {
        stub.dispatched.push(spec);
      },
    } as unknown as EditorView,
  };
  return stub;
}

describe('headingPositions', () => {
  it('produces exactly the slugs the outline panel and the pipeline use', () => {
    // Everything that could make a hand-rolled slugifier drift: dedupe, a link,
    // inline code, punctuation, Cyrillic, and a `#` line inside a fence.
    const markdown = [
      '---',
      'icon: book',
      '---',
      '# Overview',
      'text',
      '## Setup',
      '## Setup',
      '## [Docs](https://example.com/x)',
      '## Use `npm run build`, please!',
      '## Übersicht des Abschnitts',
      '```sh',
      '# not a heading',
      '```',
      'Underlined',
      '----------',
      '',
    ].join('\n');

    expect(headingPositions(markdown).map((heading) => heading.slug)).toEqual(
      extractHeadings(markdown).map((heading) => heading.slug),
    );
  });

  it('points at the first character of each heading', () => {
    const markdown = 'intro\n\n## Second\n\ntext\n\n### Third\n';
    expect(headingPositions(markdown)).toEqual([
      { slug: 'second', pos: markdown.indexOf('## Second') },
      { slug: 'third', pos: markdown.indexOf('### Third') },
    ]);
  });

  it('shifts offsets past a frontmatter block', () => {
    const markdown = '---\nicon: 📘\ncover: /a.png\n---\n# Title\n\nbody\n';
    expect(headingPositions(markdown)).toEqual([{ slug: 'title', pos: markdown.indexOf('# Title') }]);
  });

  it('finds nothing in a document with no headings', () => {
    expect(headingPositions('just prose\n')).toEqual([]);
  });
});

describe('scrollToHeading', () => {
  it('puts the caret on the heading line and asks for a scroll', () => {
    const doc = 'intro\n\n## Second\n\ntext\n';
    const stub = stubView(doc);

    expect(scrollToHeading(stub.view, 'second')).toBe(true);
    expect(stub.dispatched).toHaveLength(1);
    expect(stub.dispatched[0].selection?.from).toBe(doc.indexOf('## Second'));
    expect(stub.dispatched[0].effects).toBeDefined();
    expect(stub.focused).toBe(1);
  });

  it('tells a repeated heading apart by its deduped slug', () => {
    const doc = '# Setup\n\ntext\n\n# Setup\n\nmore\n';
    const stub = stubView(doc);

    expect(scrollToHeading(stub.view, 'setup-2')).toBe(true);
    expect(stub.dispatched[0].selection?.from).toBe(doc.lastIndexOf('# Setup'));
  });

  it('returns false — and touches nothing — for a slug the document does not have', () => {
    const stub = stubView('# Title\n\nbody\n');
    expect(scrollToHeading(stub.view, 'missing')).toBe(false);
    expect(stub.dispatched).toEqual([]);
    expect(stub.focused).toBe(0);
  });
});

describe('the mounted editor view', () => {
  it('is what scrollActiveEditorToHeading works on, and false when there is none', () => {
    const stub = stubView('# Title\n\nbody\n');
    expect(scrollActiveEditorToHeading('title')).toBe(false);

    setMountedEditorView(stub.view);
    expect(mountedEditorView()).toBe(stub.view);
    expect(scrollActiveEditorToHeading('title')).toBe(true);
    expect(stub.dispatched).toHaveLength(1);

    clearMountedEditorView(stub.view);
    expect(mountedEditorView()).toBeNull();
  });

  it('ignores a clear from a view that has already been replaced', () => {
    const first = stubView('# One\n');
    const second = stubView('# Two\n');
    setMountedEditorView(first.view);
    setMountedEditorView(second.view);

    clearMountedEditorView(first.view);
    expect(mountedEditorView()).toBe(second.view);
    clearMountedEditorView(second.view);
  });
});
