/**
 * The one list of "blocks you can insert" — and, for each, the edit that
 * inserts it.
 *
 * Round 25 gave the editor a pinned toolbar with the same commands the «/»
 * menu offers. Two lists would drift apart within a round, so there is one:
 * this module owns the items and the insertion, slash-menu.ts wraps them as
 * completions (its trigger character has to be swallowed, hence the extra
 * character it reaches back for), and pin-toolbar.ts wraps them as buttons.
 *
 * Every `insert` replaces the range it is handed, so both callers describe
 * *what to replace* and nothing else: the menu passes the «/» along with the
 * query the user typed, the toolbar passes the caret (or a freshly opened
 * blank line under it).
 */
import { pickedCompletion, snippet, type Completion } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import i18next from 'i18next';
import { UI_LANGUAGES } from '../i18n/languages';
import { emojiFavouritesFacet } from './emoji-complete';
import { openEmojiPicker } from './emoji-popover';
import { serializeGfmTable } from './gfm-table';
import type { IconName } from './icons';
import { NS, t } from './i18n';
import { requestTableFocus } from './table-widget';
import { pickImageFiles } from './uploads';

export interface BlockItem {
  /** Translation id: `slash.<id>.name` / `.description`. */
  id: string;
  /** Extra latin words that should also match, on top of the localized names. */
  aliases: string;
  /** Markdown the entry produces — markup, not prose, so it is not translated. */
  hint: string;
  icon: IconName;
  badge?: string;
  /** Nudges an entry down the list when a near-duplicate name would outrank it. */
  demote?: number;
  /**
   * The marker this entry writes at the start of a line, for the entries that
   * are a *line style* rather than a block of their own — a heading, a list
   * item, a task. Present means `runBlockCommand` (the toolbar) converts the
   * line the caret is on instead of opening a new one below it; see the
   * comment there. The «/» menu never looks at it: it always replaces the «/»
   * and the query, which is already exactly the line the author is on.
   */
  linePrefix?: string;
  /**
   * Replace `[from, to)` with what this command produces. `completion` is the
   * autocomplete entry when the «/» menu is driving, and null when a button is.
   */
  insert(view: EditorView, from: number, to: number, completion: Completion | null): void;
}

const lines = (...parts: string[]) => parts.join('\n');

/** The annotation autocomplete expects, and nothing at all for a plain click. */
const picked = (completion: Completion | null) =>
  completion ? { annotations: pickedCompletion.of(completion), userEvent: 'input.complete' } : {};

/** A static snippet, parsed once. */
function snippetInsert(template: string): BlockItem['insert'] {
  const run = snippet(template);
  return (view, from, to, completion) => run(view, completion, from, to);
}

/** A snippet whose body is translated, so it can only be parsed at use time. */
function lazySnippet(build: () => string): BlockItem['insert'] {
  return (view, from, to, completion) => snippet(build())(view, completion, from, to);
}

/** A fresh 2x2 grid with empty cells, written exactly as the serializer would. */
const EMPTY_TABLE = serializeGfmTable({
  header: ['', ''],
  align: [null, null],
  rows: [
    ['', ''],
    ['', ''],
  ],
});

/**
 * Replaces the range with a table, parks the caret *after* the block so the
 * grid widget renders instead of its source, and asks the widget to open its
 * first header cell. Landing the user in a working grid is the whole point;
 * leaving the caret inside the markdown would show the raw pipes instead.
 */
const insertTable: BlockItem['insert'] = (view, from, to, completion) => {
  const line = view.state.doc.lineAt(from);
  const before = view.state.sliceDoc(line.from, from);
  // Start at the line beginning when only whitespace precedes the range, so the
  // table is never indented (an indented table stays plain source).
  const blank = before.trim() === '';
  const start = blank ? line.from : from;
  const insert = `${blank ? '' : '\n'}${EMPTY_TABLE}\n`;
  const tableFrom = blank ? line.from : from + 1;

  // Before the dispatch: the widget mounts synchronously inside it and reads
  // the request while rendering.
  requestTableFocus(tableFrom);
  view.dispatch({
    changes: { from: start, to, insert },
    selection: { anchor: start + insert.length },
    scrollIntoView: true,
    ...picked(completion),
  });
};

/**
 * Confluence-style layout columns stored as a borderless, one-row GFM table.
 * The metadata is an invisible CommonMark link definition, so GitHub still
 * renders a normal table and no column content is trapped in proprietary HTML.
 */
function columnsItem(count: number): BlockItem {
  const empty = new Array<string>(count).fill('');
  const source = serializeGfmTable({
    header: [...empty],
    align: new Array(count).fill(null),
    rows: [[...empty]],
    attrs: { bg: {}, width: {}, layout: 'columns' },
  });
  const insert: BlockItem['insert'] = (view, from, to, completion) => {
    const line = view.state.doc.lineAt(from);
    const before = view.state.sliceDoc(line.from, from);
    const blank = before.trim() === '';
    const start = blank ? line.from : from;
    const text = `${blank ? '' : '\n'}${source}\n`;
    const tableFrom = blank ? line.from : from + 1;
    requestTableFocus(tableFrom, { row: 0, col: 0 });
    view.dispatch({
      changes: { from: start, to, insert: text },
      selection: { anchor: start + text.length },
      scrollIntoView: true,
      ...picked(completion),
    });
  };
  return {
    id: `columns${count}`,
    aliases: `${count} columns cols layout`,
    hint: `▥ × ${count}`,
    icon: 'table',
    badge: String(count),
    insert,
  };
}

/**
 * Opens the emoji palette at the caret. In live mode the caret may sit at the
 * edge of a widgetised block (a rendered table or diagram); the emoji then
 * lands at that block edge, which is the same place any typed character would.
 */
const insertEmoji: BlockItem['insert'] = (view, from, to, completion) => {
  view.dispatch({ changes: { from, to, insert: '' }, ...picked(completion) });
  const at = view.state.selection.main.head;
  const coords = view.coordsAtPos(at);
  openEmojiPicker({
    x: coords?.left ?? 0,
    y: coords?.bottom ?? 0,
    favourites: view.state.facet(emojiFavouritesFacet),
    onPick: (emoji) => {
      const head = view.state.selection.main.head;
      view.dispatch({ changes: { from: head, insert: emoji }, selection: { anchor: head + emoji.length } });
    },
    onClose: () => view.focus(),
  });
};

/** Opens the OS file picker and hands the result to the upload pipeline. */
const insertImage: BlockItem['insert'] = (view, from, to, completion) => {
  view.dispatch({ changes: { from, to, insert: '' }, ...picked(completion) });
  pickImageFiles(view);
};

/**
 * A collapsible block, written as the `<details>` HTML every markdown renderer
 * (and Confluence's export) understands.
 *
 * The blank lines around the body are load-bearing: CommonMark ends an HTML
 * block at the first blank line, so the body is parsed as ordinary markdown and
 * `</details>` closes it as an HTML block of its own. Written on one line
 * instead, the body would be raw HTML and no markdown inside it would render.
 */
const insertExpand = lazySnippet(() =>
  lines(`<details><summary>\${${t('slash.expand.summary')}}</summary>`, '', '${}', '', '</details>', ''),
);

const insertMermaid = lazySnippet(() => lines('```mermaid', t('slash.mermaid.code'), '```', ''));

export const BLOCK_ITEMS: readonly BlockItem[] = [
  { id: 'heading1', aliases: 'heading h1', hint: '# …', icon: 'heading', badge: '1', linePrefix: '# ', insert: snippetInsert('# ${}') },
  { id: 'heading2', aliases: 'heading h2', hint: '## …', icon: 'heading', badge: '2', linePrefix: '## ', insert: snippetInsert('## ${}') },
  { id: 'heading3', aliases: 'heading h3', hint: '### …', icon: 'heading', badge: '3', linePrefix: '### ', insert: snippetInsert('### ${}') },
  { id: 'text', aliases: 'text paragraph', hint: '', icon: 'text', linePrefix: '', insert: snippetInsert('${}') },
  { id: 'list', aliases: 'list bullet ul', hint: '- …', icon: 'list', linePrefix: '- ', insert: snippetInsert('- ${}') },
  { id: 'ordered', aliases: 'ordered list ol numbered', hint: '1. …', icon: 'listOrdered', linePrefix: '1. ', insert: snippetInsert('1. ${}') },
  { id: 'task', aliases: 'task todo checklist check', hint: '- [ ] …', icon: 'checklist', linePrefix: '- [ ] ', insert: snippetInsert('- [ ] ${}') },
  { id: 'table', aliases: 'table grid', hint: '| … | … |', icon: 'table', insert: insertTable },
  columnsItem(2),
  columnsItem(3),
  columnsItem(4),
  columnsItem(5),
  { id: 'code', aliases: 'code fence', hint: '``` …', icon: 'code', insert: snippetInsert(lines('```${}', '', '```', '')) },
  { id: 'mermaid', aliases: 'mermaid diagram flowchart', hint: '```mermaid', icon: 'diagram', insert: insertMermaid },
  { id: 'image', aliases: 'image picture img upload', hint: '', icon: 'image', insert: insertImage },
  // Tab walks the two stops: the label first, then the target. The floating
  // and pinned toolbars offer the same thing over a selection — see
  // format.ts's `linkEdit`, which is what those hosts run.
  { id: 'link', aliases: 'link url href anchor', hint: '[…](…)', icon: 'link', insert: snippetInsert('[${text}](${url})') },
  { id: 'imageLink', aliases: 'image link url', hint: '![…](…)', icon: 'image', insert: snippetInsert('![${alt}](${path.png})'), demote: 30 },
  { id: 'quote', aliases: 'quote blockquote', hint: '> …', icon: 'quote', insert: snippetInsert('> ${}') },
  { id: 'note', aliases: 'note callout info', hint: '> [!NOTE]', icon: 'info', insert: snippetInsert(lines('> [!NOTE]', '> ${}')) },
  { id: 'tip', aliases: 'tip callout', hint: '> [!TIP]', icon: 'bulb', insert: snippetInsert(lines('> [!TIP]', '> ${}')) },
  { id: 'important', aliases: 'important callout', hint: '> [!IMPORTANT]', icon: 'alert', insert: snippetInsert(lines('> [!IMPORTANT]', '> ${}')) },
  { id: 'warning', aliases: 'warning callout', hint: '> [!WARNING]', icon: 'alert', insert: snippetInsert(lines('> [!WARNING]', '> ${}')) },
  { id: 'expand', aliases: 'expand details collapse toggle spoiler', hint: '<details>', icon: 'expand', insert: insertExpand },
  { id: 'emoji', aliases: 'emoji smile icon', hint: '(( / :name', icon: 'bulb', insert: insertEmoji },
  { id: 'pagetree', aliases: 'pagetree tree children subpages', hint: '::pagetree', icon: 'listTree', insert: snippetInsert(lines('::pagetree{depth=2}', '${}')) },
  { id: 'divider', aliases: 'divider hr line', hint: '---', icon: 'divider', insert: snippetInsert(lines('---', '${}')) },
];

export const blockItemById = (id: string): BlockItem | undefined => BLOCK_ITEMS.find((item) => item.id === id);

/**
 * Every language's name joins the match string, so a query typed in any of the
 * interface languages finds the entry regardless of which one is active.
 */
export function matchText(item: BlockItem): string {
  const names = UI_LANGUAGES.map((lng) => i18next.t(`${NS}:slash.${item.id}.name`, { lng }));
  return [...new Set(names), item.aliases].join(' ');
}

/**
 * Ids that earn their own button on the pinned toolbar, in order — the ones
 * the owner named for round 25: headings, lists, the check-list, the table,
 * code, mermaid, an image, the callouts, the divider and the page tree.
 * Everything else lands in the toolbar's overflow menu, derived below rather
 * than written out a second time.
 */
export const TOOLBAR_PRIMARY: readonly string[] = [
  'heading1',
  'heading2',
  'heading3',
  'list',
  'ordered',
  'task',
  'table',
  'code',
  'mermaid',
  'image',
  'note',
  'tip',
  'important',
  'warning',
  'divider',
  'pagetree',
];

/**
 * Already buttons of their own in the formatting group — and both act on the
 * selection, which `runBlockCommand` (the overflow menu's caller) would have
 * thrown away by opening a fresh line first.
 */
const TOOLBAR_SKIP: readonly string[] = ['quote', 'link'];

export const toolbarPrimaryItems = (): BlockItem[] =>
  TOOLBAR_PRIMARY.map(blockItemById).filter((item): item is BlockItem => item != null);

export const toolbarOverflowItems = (): BlockItem[] =>
  BLOCK_ITEMS.filter((item) => !TOOLBAR_PRIMARY.includes(item.id) && !TOOLBAR_SKIP.includes(item.id));

/* ------------------------------------------------------- caret placement -- */

/**
 * The container a line already sits in — its indent and any blockquote
 * markers. A new line marker goes INSIDE it: `> text` asked to be a heading
 * becomes `> ## text`, a heading in a quote, not an unquoted one.
 */
const LINE_CARRY = /^[ \t]*(?:>[ \t]?)*/;

/**
 * The line marker a line-style command replaces. Task before bullet, because
 * `- [ ] x` starts with a bullet too.
 */
const LINE_MARKER = /^(?:#{1,6}[ \t]+|[-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d+[.)][ \t]+)/;

/**
 * Splits what a line opens with into its container (`carry` — indent and any
 * blockquote markers) and its line marker (`marker` — heading hashes, bullet,
 * task box, ordered number). Exported for slash-menu.ts: the «/» trigger has
 * to know whether everything before the slash is just this lead, so that «/»
 * typed inside a list item still opens the menu (owner, 11.09: "it does not
 * work if I am already in a list"), and the entry that is picked then replaces the marker
 * instead of writing a second one after it.
 */
export function lineLead(text: string): { carry: string; marker: string } {
  const carry = LINE_CARRY.exec(text)?.[0] ?? '';
  const marker = LINE_MARKER.exec(text.slice(carry.length))?.[0] ?? '';
  return { carry, marker };
}

/**
 * Restyle every line the selection touches as `prefix`.
 *
 * The old marker goes and the text stays, so this is a conversion, not an
 * insertion: `Heading 2` on a paragraph makes that paragraph a heading, and
 * `Text` on a heading makes it a paragraph again. The selection is mapped
 * with `assoc: 1` so a caret sitting on a blank line ends up AFTER the marker
 * that was just written there, ready to type — the same place the old
 * insert-a-fresh-block path used to leave it.
 */
function restyleLines(view: EditorView, prefix: string): void {
  const state = view.state;
  const range = state.selection.main;
  const first = state.doc.lineAt(range.from).number;
  const last = state.doc.lineAt(range.to).number;

  const changes: { from: number; to: number; insert: string }[] = [];
  for (let number = first; number <= last; number++) {
    const line = state.doc.line(number);
    const carry = LINE_CARRY.exec(line.text)?.[0] ?? '';
    const marker = LINE_MARKER.exec(line.text.slice(carry.length))?.[0] ?? '';
    if (marker === prefix) continue;
    changes.push({ from: line.from + carry.length, to: line.from + carry.length + marker.length, insert: prefix });
  }
  if (changes.length === 0) return;

  const set = state.changes(changes);
  view.dispatch({
    changes: set,
    selection: { anchor: set.mapPos(range.anchor, 1), head: set.mapPos(range.head, 1) },
    scrollIntoView: true,
  });
}

/**
 * What a toolbar button does — which is not always what the «/» menu entry
 * behind it does.
 *
 * Two contracts live in this one strip, and round 28 (QA-3) is where they were
 * told apart:
 *
 *  - **Line styles** (headings, the lists, the task) are a property of the
 *    line the caret is on, exactly like B/I/U are a property of the selection.
 *    A toolbar that answers "Heading 2" with a *new, empty* `## ` below the
 *    paragraph you meant to promote is answering a question nobody asked, and
 *    it leaves an empty heading behind when the author gives up on it. These
 *    convert in place; nothing is destroyed, the text keeps its text.
 *  - **Blocks** (a table, a fence, a diagram, a callout, an image, a divider)
 *    are new content. Those still land on a line of their own, because there
 *    is no way to turn a paragraph into a table without eating it: a blank
 *    line is used as-is, and a line with text on it keeps its text while the
 *    block opens below.
 *
 * The «/» menu goes through `item.insert` directly and is unaffected — there
 * the range being replaced IS the line the author is typing on.
 */
export function runBlockCommand(view: EditorView, item: BlockItem): void {
  if (item.linePrefix !== undefined) {
    restyleLines(view, item.linePrefix);
    view.focus();
    return;
  }

  const state = view.state;
  const range = state.selection.main;
  const line = state.doc.lineAt(range.from);
  const lineEnd = state.doc.lineAt(range.to).to;

  if (line.text.trim() === '') {
    item.insert(view, line.from, Math.max(line.to, lineEnd), null);
  } else {
    view.dispatch({ changes: { from: lineEnd, insert: '\n' }, selection: { anchor: lineEnd + 1 } });
    const fresh = view.state.doc.lineAt(view.state.selection.main.head);
    item.insert(view, fresh.from, fresh.to, null);
  }
  view.focus();
}
