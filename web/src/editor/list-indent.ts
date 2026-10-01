/**
 * Tab / Shift+Tab inside a list item: nest one level in, un-nest one level
 * out. There was no Tab binding at all before this (owner: pressing Tab in a
 * list just moved focus off the editor), and `indentWithTab` is deliberately
 * not used anywhere in this app — Tab has to keep moving focus everywhere
 * else, so this only claims the key when the caret (or the whole selection)
 * sits on a list line.
 */
import { completionStatus } from '@codemirror/autocomplete';
import { Prec, type ChangeSpec, type EditorState, type Extension, type Line } from '@codemirror/state';
import { EditorView, keymap, type Command } from '@codemirror/view';
import { lineLead } from './block-commands';

/**
 * The four shapes `lineLead`'s marker can take for an actual list line —
 * bullet, task box, ordered — reconstructed so a heading's marker (also
 * matched by `LINE_MARKER` over there) is told apart from a list one.
 */
const LIST_MARKER = /^(?:[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)$/;

interface ListLine {
  line: Line;
  carry: string;
  marker: string;
}

/** `null` unless `lineNumber` is an actual list line (bullet/ordered/task). */
function listLineAt(state: EditorState, lineNumber: number): ListLine | null {
  const line = state.doc.line(lineNumber);
  const { carry, marker } = lineLead(line.text);
  if (!LIST_MARKER.test(marker)) return null;
  return { line, carry, marker };
}

/** The leading whitespace of `carry` — never a blockquote `>`, so dedenting a
 *  list inside a quote stops at the quote's own edge instead of eating it. */
function leadingIndentWidth(carry: string): number {
  return /^[ \t]*/.exec(carry)?.[0].length ?? 0;
}

/**
 * Width of one nesting level for the list line at `lineNumber`: the offset
 * where the nearest enclosing item's own text starts — found by walking
 * upward for the first earlier list line with a smaller indent. With no such
 * parent, the width of this line's own marker, bullet only for a task box
 * (`- [ ] ` → 2, not 6): indenting only has to clear the bullet to read as a
 * real CommonMark nested list, and lining up with the checkbox as well would
 * over-indent every plain sibling nested under a task.
 */
function levelWidth(state: EditorState, lineNumber: number): number {
  const self = listLineAt(state, lineNumber);
  if (!self) return 0;
  const selfIndent = self.carry.length;
  for (let n = lineNumber - 1; n >= 1; n--) {
    const candidate = listLineAt(state, n);
    if (candidate && candidate.carry.length < selfIndent) {
      return candidate.carry.length + candidate.marker.length;
    }
  }
  const bullet = /^[-*+][ \t]+/.exec(self.marker);
  if (bullet && /\[[ xX]\]/.test(self.marker)) return bullet[0].length;
  return self.marker.length;
}

/**
 * A nested ORDERED item has to restart its numbering — `1.` under its parent,
 * not the `2.` it carried as a sibling (owner, 17.09: "a child list cannot be
 * made"). Returns the change that rewrites this line's number, or null for
 * a bullet/task line, which needs none.
 *
 * The number itself: one more than the nearest earlier line that will sit at
 * the SAME indent after the move and is ordered, else 1.
 */
function renumberChange(state: EditorState, item: ListLine, indentAfter: number, lineNumber: number): ChangeSpec | null {
  const ordered = /^(\d+)([.)])([ \t]+)$/.exec(item.marker);
  if (!ordered) return null;

  let previous = 0;
  for (let n = lineNumber - 1; n >= 1; n--) {
    const candidate = listLineAt(state, n);
    if (!candidate) break; // an empty line or text — the list has ended here
    if (candidate.carry.length < indentAfter) break; // this is already the parent
    if (candidate.carry.length > indentAfter) continue; // nested deeper — not a sibling
    const siblingNumber = /^(\d+)[.)]/.exec(candidate.marker);
    previous = siblingNumber ? Number.parseInt(siblingNumber[1], 10) : 0;
    break;
  }

  const next = `${previous + 1}${ordered[2]}${ordered[3]}`;
  if (next === item.marker) return null;
  const from = item.line.from + item.carry.length;
  return { from, to: from + item.marker.length, insert: next };
}

/** Every line the selection touches, or `null` the moment one isn't a list
 *  line — Tab/Shift+Tab only fire when the *whole* selection is inside lists. */
function selectedListLines(state: EditorState): ListLine[] | null {
  const range = state.selection.main;
  const first = state.doc.lineAt(range.from).number;
  const last = state.doc.lineAt(range.to).number;
  const lines: ListLine[] = [];
  for (let n = first; n <= last; n++) {
    const item = listLineAt(state, n);
    if (!item) return null;
    lines.push(item);
  }
  return lines;
}

/**
 * Tab: indent every touched line by the same amount — one level, computed
 * once from the first line — and keep the selection (CodeMirror maps it
 * through the changes on its own). Returns false, unconsumed, the moment the
 * caret isn't on a list line, so plain Tab keeps doing whatever it normally
 * does; also false while a completion popup (the «/» or emoji menu) is open,
 * so Tab still belongs to it.
 */
export const listIndent: Command = (view) => {
  if (completionStatus(view.state) === 'active') return false;
  const lines = selectedListLines(view.state);
  if (!lines || lines.length === 0) return false;

  const width = levelWidth(view.state, lines[0].line.number);
  const pad = ' '.repeat(width);
  const changes: ChangeSpec[] = [];
  for (const item of lines) {
    changes.push({ from: item.line.from, insert: pad });
    const renumber = renumberChange(view.state, item, item.carry.length + width, item.line.number);
    if (renumber) changes.push(renumber);
  }
  view.dispatch({ changes, scrollIntoView: true, userEvent: 'input.indent' });
  return true;
};

/** Shift+Tab: the reverse — removes one level, clamped so a line never loses
 *  more than the plain whitespace indent it actually has (never below column
 *  0, and never into a blockquote's own `>`). */
export const listDedent: Command = (view) => {
  if (completionStatus(view.state) === 'active') return false;
  const lines = selectedListLines(view.state);
  if (!lines || lines.length === 0) return false;

  const width = levelWidth(view.state, lines[0].line.number);
  const changes: ChangeSpec[] = [];
  for (const item of lines) {
    const removable = Math.min(width, leadingIndentWidth(item.carry));
    if (removable > 0) changes.push({ from: item.line.from, to: item.line.from + removable, insert: '' });
    const renumber = renumberChange(view.state, item, item.carry.length - removable, item.line.number);
    if (renumber) changes.push(renumber);
  }
  if (changes.length > 0) view.dispatch({ changes, scrollIntoView: true, userEvent: 'input.dedent' });
  return true;
};

/** Whether the caret (or selection) sits on a list line — the same gate
 *  `listIndent`/`listDedent` check before running. Toolbar buttons use this to
 *  decide enabled vs. disabled without duplicating the list-line logic. */
export function listIndentAvailable(state: EditorState): boolean {
  const lines = selectedListLines(state);
  return lines !== null && lines.length > 0;
}

/** Above `defaultKeymap` (added last, at base precedence in markdown-setup.ts)
 *  so a list line's Tab/Shift+Tab reach here first; everywhere else the two
 *  commands return false and the key falls through to its usual behaviour. */
export const listIndentKeymap: Extension = Prec.high(
  keymap.of([
    { key: 'Tab', run: listIndent },
    { key: 'Shift-Tab', run: listDedent },
  ]),
);
