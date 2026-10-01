/**
 * Smallest single replacement turning `from` into `to` — the common prefix and
 * suffix are trimmed off, so only the part that really changed is dispatched.
 *
 * Used when the visual mermaid canvas writes back into the source pane: a
 * whole-document replace would reset the caret and the undo history of the code
 * editor on every click on the canvas.
 */
export interface TextReplacement {
  from: number;
  to: number;
  insert: string;
}

export function minimalReplace(from: string, to: string): TextReplacement | null {
  if (from === to) return null;

  let start = 0;
  const max = Math.min(from.length, to.length);
  while (start < max && from[start] === to[start]) start++;

  let end = 0;
  while (
    end < max - start &&
    from[from.length - 1 - end] === to[to.length - 1 - end]
  ) {
    end++;
  }

  return {
    from: start,
    to: from.length - end,
    insert: to.slice(start, to.length - end),
  };
}
