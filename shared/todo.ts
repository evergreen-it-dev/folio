/**
 * The TODO marker: one definition shared by the editor highlight
 * (web/src/editor/todo-highlight.ts), the reading-mode highlight
 * (web/src/markdown/todoMarks.ts) and the page panel's list
 * (web/src/markdown/todos.ts), so all three always agree on what a TODO is.
 *
 * Exact upper case, whole word: `TODO` and `TODO:` match, `TODOS`, `todo` and
 * a TODO glued to a letter or digit of any script do not.
 */
export const TODO_PATTERN_SOURCE = '(?<![\\p{L}\\p{N}_])TODO(?![\\p{L}\\p{N}_])';

/** Offsets of every TODO in `text`, ascending. */
export function findTodoOffsets(text: string): number[] {
  const pattern = new RegExp(TODO_PATTERN_SOURCE, 'gu');
  const offsets: number[] = [];
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) offsets.push(match.index);
  return offsets;
}

/** Length of the marker, for a caller turning an offset into a range. */
export const TODO_LENGTH = 'TODO'.length;

/**
 * A link whose only text is a URL or an e-mail address (what GFM's autolink
 * literals produce): a TODO inside it belongs to the address, not the prose.
 * Decided on the text alone so the markdown tree and the rendered tree, which
 * carry different hrefs, reach the same answer.
 */
export function isBareAddressText(value: string): boolean {
  return /^(?:(?:https?|ftp):\/\/|www\.)\S*$/i.test(value) || /^\S+@\S+\.\S+$/.test(value);
}
