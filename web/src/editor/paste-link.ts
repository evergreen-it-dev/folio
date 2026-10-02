/**
 * Pasting a URL over selected text makes the text a link.
 *
 * The owner, 02.10.2026: "if I want to add a link to text, then when text is
 * selected, pasting simply replaces the selected text with the link itself
 * instead of embedding the link into the text — the way it was in Confluence".
 * So a selection plus a clipboard that is exactly one `http(s)` URL becomes
 * `[selection](url)`; every other paste is left to the handlers behind this one
 * (`markdownPasteChooser`, `assetUploads`, CodeMirror's own text paste).
 *
 * The rules live in format.ts (`pastedUrl`, `linkOverSelectionEdit`), shared
 * with the table cell's own paste listener. What is added here is what only the
 * document knows: whether the selection sits in a code block, in raw HTML, or
 * runs across table cells — none of which a line of text can tell.
 *
 * Mode-independent on purpose: source mode writes the same markdown.
 */
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorSelection, type EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { linkOverSelectionEdit, pastedUrl, type FormatEdit } from './format';

/** Nodes in which a pasted URL is just text: code, raw HTML, link syntax already in place. */
const PLAIN_NODES = new Set([
  'InlineCode',
  'FencedCode',
  'CodeBlock',
  'CodeText',
  'Comment',
  'CommentBlock',
  'HTMLBlock',
  'HTMLTag',
  'Link',
  'Image',
  'URL',
  'Autolink',
  'LinkReference',
]);

interface Surroundings {
  /** Selection edge sits in a node where the paste stays plain. */
  plain: boolean;
  inTable: boolean;
  /** The table cell holding the edge, as an identity (`from`-`to`), or null. */
  cell: string | null;
}

function surroundings(state: EditorState, pos: number, side: -1 | 1): Surroundings {
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, pos + 1), 50) ?? syntaxTree(state);
  const found: Surroundings = { plain: false, inTable: false, cell: null };
  for (let node: SyntaxNode | null = tree.resolve(pos, side); node; node = node.parent) {
    if (PLAIN_NODES.has(node.name)) found.plain = true;
    if (node.name === 'Table') found.inTable = true;
    if (node.name === 'TableCell' && found.cell === null) found.cell = `${node.from}-${node.to}`;
  }
  return found;
}

/**
 * The link edit for the main selection of `state`, in document coordinates, or
 * null when the paste has to stay a plain replacement.
 */
export function pasteLinkEdit(state: EditorState, url: string): FormatEdit | null {
  const range = state.selection.main;
  if (state.selection.ranges.length !== 1 || range.empty || state.readOnly) return null;

  const line = state.doc.lineAt(range.from);
  if (range.to > line.to) return null; // one line only; blocks and cells further apart are plain too

  const first = surroundings(state, range.from, 1);
  const last = surroundings(state, range.to, -1);
  if (first.plain || last.plain) return null;
  // A table row in source mode: both ends must sit in the same cell.
  if ((first.inTable || last.inTable) && (first.cell === null || first.cell !== last.cell)) return null;
  // ...and a `|` in the address would split the row.
  if ((first.inTable || last.inTable) && url.includes('|')) return null;

  const edit = linkOverSelectionEdit(line.text, range.from - line.from, range.to - line.from, url);
  if (!edit) return null;
  return {
    changes: edit.changes.map((change) => ({
      from: change.from + line.from,
      to: change.to + line.from,
      insert: change.insert,
    })),
    selection: { from: edit.selection.from + line.from, to: edit.selection.to + line.from },
  };
}

/**
 * Ahead of the other paste handlers in the extension list (it rides along with
 * `markdownEditorExtensions()`, which comes first): it only ever claims a
 * paste with a selection, no files and a lone URL on the clipboard, so rich
 * HTML pastes and image uploads reach their own handlers exactly as before.
 */
export const pasteLinkOverSelection: Extension = EditorView.domEventHandlers({
  paste(event, view) {
    const data = event.clipboardData;
    if (!data || (data.files && data.files.length > 0)) return false;
    if (view.state.selection.main.empty) return false;
    const url = pastedUrl(data.getData('text/plain') ?? '');
    if (!url) return false;
    const edit = pasteLinkEdit(view.state, url);
    if (!edit) return false;

    event.preventDefault();
    view.dispatch({
      changes: edit.changes,
      selection: EditorSelection.single(edit.selection.from, edit.selection.to),
      scrollIntoView: true,
      // One transaction: a single undo brings the original text back.
      userEvent: 'input.paste',
    });
    return true;
  },
});
