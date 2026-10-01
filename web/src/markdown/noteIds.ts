import { visit, SKIP } from 'unist-util-visit';
import type { Root, Element } from 'hast';

/**
 * Threaded through every segment's renderMarkdownToHtml call for one page —
 * mirrors headingIds.ts's HeadingIdCursor and tables.ts's TableIndexCursor
 * exactly, and for the same reason (a mermaid fence splitting one page's
 * markdown across several independent pipeline runs — see pipeline.ts's
 * docblock). Unlike HeadingIdCursor this doesn't need a pre-computed entry
 * list: a note's DOM id is just its running position, not a content-derived
 * slug, so a bare counter is all the cursor has to carry.
 */
export interface NoteIdCursor {
  index: number;
}

export function createNoteIdCursor(): NoteIdCursor {
  return { index: 0 };
}

function hasClass(node: Element, name: string): boolean {
  return Array.isArray(node.properties?.className) && node.properties.className.includes(name);
}

/**
 * Stamps `data-note-index="N"` on every callout `<div>` (remarkAlerts's own
 * `md-alert`/`data-alert` — checked here via `data-alert`'s mere presence,
 * not by type, since a note entry's kind isn't this plugin's concern) and
 * every checked-or-unchecked task `<li class="task-list-item">`, in exactly
 * the order markdown/notes.ts's extractNotes() finds the same two node
 * shapes walking the raw markdown — so `entries[N]` from that function and
 * `[data-note-index="N"]` in the rendered DOM are always the same entry. A
 * click in reading mode (no CodeMirror view to scroll, unlike source/live —
 * see app/outline/OutlinePanel.tsx) resolves through this id.
 *
 * A `<table>`'s own subtree is skipped entirely, deliberately, and this is
 * the one place the two numberings could otherwise desync: a checklist
 * marker inside a table cell only becomes a real `<li>`/`<input type=checkbox>`
 * here, in hast, via tableExtensions.ts's rehypeCellLists (which this plugin
 * runs after) — reading a `[ ]`/`[x]` out of `<br>`-joined cell text that
 * extractNotes has no way to see, because GFM table cells are inline-only in
 * mdast and never contain a real `listItem` node there. Counting it here
 * would shift every id after it out of step with extractNotes's list, so
 * table-cell checklists are simply never offered as Notes entries — see
 * notes.test.ts's mdast/hast parity test, which covers exactly this case.
 */
export function rehypeAssignNoteIds(cursor: NoteIdCursor | undefined) {
  return (tree: Root) => {
    if (!cursor) return;
    visit(tree, 'element', (node: Element) => {
      if (node.tagName === 'table') return SKIP;

      const isCallout = node.tagName === 'div' && typeof node.properties?.dataAlert === 'string';
      const isTask = node.tagName === 'li' && hasClass(node, 'task-list-item');
      if (!isCallout && !isTask) return;

      node.properties = { ...node.properties, dataNoteIndex: String(cursor.index) };
      cursor.index += 1;
    });
  };
}
