/**
 * The bridge between imperative CodeMirror widgets and the React chrome around
 * the editor (the mermaid modal), plus the position anchor a widget uses to
 * find "its" block again after remote edits have shifted the document.
 *
 * Round 21: tables no longer have a modal at all — the inline grid widget is
 * the one and only table editor, so nothing here talks about them any more.
 */
import { Facet, MapMode, StateEffect, StateField } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

export interface MermaidEditRequest {
  view: EditorView;
  /** Fence body at the moment the editor was opened. */
  code: string;
}

export interface CreateChildPageRequest {
  markdown: string;
  title: string;
}

export interface CreatedChildPage {
  id: string;
  /** Space-relative path — feeds paths.ts's relativePath to build the link back. */
  path: string;
  title: string;
}

export interface EditorServices {
  openMermaidEditor(request: MermaidEditRequest): void;
  /**
   * Paste-chooser's "insert as a link" branch (paste-chooser.ts): create a
   * child of the current page, write `markdown` into it, and hand back enough
   * to link to it. Resolves to null on failure — the caller shows its own
   * toast rather than this service throwing.
   */
  createChildPage(request: CreateChildPageRequest): Promise<CreatedChildPage | null>;
}

const NO_SERVICES: EditorServices = {
  openMermaidEditor: () => {},
  createChildPage: async () => null,
};

export const editorServicesFacet = Facet.define<EditorServices, EditorServices>({
  combine: (values) => values[values.length - 1] ?? NO_SERVICES,
});

/** Set (or clear) the document position the open modal is editing. */
export const setBlockAnchor = StateEffect.define<number | null>();

/**
 * A single mapped position. While the modal is open the document keeps taking
 * remote updates, so the anchor is what tells us where the block ended up — or
 * that it was deleted (`null`).
 */
/** Put the caret inside a widget's range so its markdown source is revealed. */
export function revealSource(view: EditorView, dom: HTMLElement): void {
  const pos = view.posAtDOM(dom);
  view.focus();
  view.dispatch({
    selection: { anchor: Math.min(pos + 1, view.state.doc.length) },
    scrollIntoView: true,
  });
}

export const blockAnchorField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setBlockAnchor)) return effect.value;
    if (value === null) return null;
    if (!tr.docChanged) return value;
    return tr.changes.mapPos(value, 1, MapMode.TrackDel);
  },
});
