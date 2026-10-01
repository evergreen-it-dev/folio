import { EditorState, type Extension, type Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

const LEADING_H1 = /^#\s+\S/;

/** Gives the document its structural H1 back without touching the rest of the markdown. */
export function ensureProtectedPageTitle(markdown: string, title: string): string {
  const safe = title.trim() || 'Untitled';
  const firstEnd = markdown.indexOf('\n');
  const first = firstEnd === -1 ? markdown : markdown.slice(0, firstEnd);
  if (LEADING_H1.test(first)) return markdown;
  if (/^#\s*/.test(first)) {
    return `# ${safe}${firstEnd === -1 ? '' : markdown.slice(firstEnd)}`;
  }
  return `# ${safe}\n\n${markdown}`;
}

function userChangedDocument(tr: Transaction): boolean {
  return tr.docChanged && (
    tr.isUserEvent('input') ||
    tr.isUserEvent('delete') ||
    tr.isUserEvent('move') ||
    tr.isUserEvent('undo') ||
    tr.isUserEvent('redo')
  );
}

/** A single change that replaces the WHOLE old document (Ctrl+A → Delete / a paste over everything). */
function replacesWholeDocument(tr: Transaction): boolean {
  let whole = false;
  let count = 0;
  tr.changes.iterChanges((fromA, toA) => {
    count += 1;
    if (fromA === 0 && toA === tr.startState.doc.length) whole = true;
  });
  return whole && count === 1;
}

/** All changes lie inside the OLD first line (an edit/erase of the heading itself). */
function confinedToFirstLine(tr: Transaction): boolean {
  const firstTo = tr.startState.doc.line(1).to;
  let confined = true;
  let count = 0;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    count += 1;
    if (toA > firstTo || inserted.toString().includes('\n')) confined = false;
  });
  return confined && count > 0;
}

/**
 * The H1 of a page can be renamed, but cannot be erased or glued to the first
 * paragraph. This is a local UX guard; the repair below separately heals old documents.
 *
 * The exception (06.09.2026, "deleting everything is impossible"): a
 * replacement of the whole document — Ctrl+A → Delete or a paste over a
 * selection of everything — is NOT rejected but repaired: the heading goes
 * back to its place, the rest of the change is applied. Otherwise the user
 * can neither clear the page nor paste new text in place of the old.
 */
export function protectPageTitle(): Extension {
  const reject = EditorState.changeFilter.of((tr) => {
    if (!userChangedDocument(tr)) return true;
    const first = tr.newDoc.line(1).text;
    // "# " without text — the user erased the heading to type a new one; that
    // is allowed (06.09.2026, "it is impossible to overwrite it completely"). A
    // line without `#` at all is either a replacement of the whole document or
    // an edit within the first line only; both cases are repaired by the
    // transactionFilter below.
    if (/^#\s*$/.test(first)) return true;
    if (!LEADING_H1.test(first)) return replacesWholeDocument(tr) || confinedToFirstLine(tr);

    const oldFirst = tr.startState.doc.line(1);
    let erasedBoundary = false;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (fromA <= oldFirst.to && toA > oldFirst.to && !inserted.toString().includes('\n')) {
        erasedBoundary = true;
      }
    });
    return !erasedBoundary;
  });

  const repair = EditorState.transactionFilter.of((tr) => {
    if (!userChangedDocument(tr)) return tr;
    const first = tr.newDoc.line(1).text;
    if (LEADING_H1.test(first) || /^#\s*$/.test(first)) return tr;
    if (!replacesWholeDocument(tr)) {
      // The user selected the whole title INCLUDING the hidden `# ` marker and
      // typed over it: keep what they typed, put the marker back.
      if (!confinedToFirstLine(tr)) return tr;
      return [tr, { changes: { from: 0, insert: '# ' }, sequential: true }];
    }
    const oldFirst = tr.startState.doc.line(1).text;
    const title = LEADING_H1.test(oldFirst) ? oldFirst : '# Untitled';
    const prefix = `${title}\n\n`;
    const body = tr.newDoc.toString();
    const caret = body.length === 0 ? prefix.length : prefix.length + body.length;
    return [tr, { changes: { from: 0, insert: prefix }, selection: { anchor: caret }, sequential: true }];
  });

  return [reject, repair];
}

/**
 * Double-click on the H1 selects the TITLE TEXT (after the `# ` marker, before
 * the line break), so typing replaces the title in place. CodeMirror's own
 * word/line selection on this line ended up spanning the line break — the
 * caret landed on the next line and the title could not be retyped
 * (06.09.2026, owner: "the caret is at the bottom anyway").
 */
export function selectTitleOnDoubleClick(): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.detail < 2 || event.button !== 0) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      const line = view.state.doc.lineAt(pos);
      if (line.number !== 1) return false;
      const marker = /^#\s*/.exec(line.text);
      if (!marker) return false;
      event.preventDefault();
      view.dispatch({ selection: { anchor: line.from + marker[0].length, head: line.to } });
      view.focus();
      return true;
    },
  });
}
