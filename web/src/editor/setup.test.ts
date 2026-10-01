/**
 * Composition smoke test: the extension stack must build a valid EditorState
 * (facets combine, state fields initialise, the markdown parser runs). Anything
 * that needs a real DOM is verified by hand — see the editor's README notes in
 * the agent report.
 */
import { syntaxTree } from '@codemirror/language';
import { Compartment, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { liveModeFacet, livePreview, livePreviewConfig, pageContextFacet } from './live-preview';
import { markdownEditorExtensions } from './markdown-setup';

function makeState(live: boolean, doc: string) {
  const mode = new Compartment();
  return EditorState.create({
    doc,
    extensions: [
      markdownEditorExtensions(),
      livePreview,
      mode.of(livePreviewConfig(live, { space: 'eng', pagePath: 'a/b.md', pageId: 'PAGE1' })),
    ],
  });
}

describe('editor extensions', () => {
  it('builds a state and parses markdown', () => {
    const state = makeState(true, '# Title\n\n**bold**\n');
    expect(syntaxTree(state).topNode.name).toBe('Document');
    expect(state.facet(liveModeFacet)).toBe(true);
    expect(state.facet(pageContextFacet)).toEqual({ space: 'eng', pagePath: 'a/b.md', pageId: 'PAGE1' });
  });

  it('recognises GFM constructs so task lists and strikethrough work', () => {
    const state = makeState(true, '- [ ] todo\n\n~~gone~~\n');
    const names: string[] = [];
    syntaxTree(state).iterate({ enter: (node) => void names.push(node.name) });
    expect(names).toContain('TaskMarker');
    expect(names).toContain('Strikethrough');
  });

  it('builds the block-widget field over an /expand block with a table inside', () => {
    // The whole stack, not just the spec computation: creating the state runs
    // blockWidgets' `create`, so a decoration set this document cannot express
    // (overlapping block replacements) fails right here.
    const state = makeState(
      true,
      'intro\n\n<details><summary>Head</summary>\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n</details>\n\nafter\n',
    );
    expect(state.doc.lines).toBe(12);
  });

  it('defaults to source mode when no live config is supplied', () => {
    const state = EditorState.create({ extensions: [markdownEditorExtensions(), livePreview] });
    expect(state.facet(liveModeFacet)).toBe(false);
  });
});
