/**
 * Round 17 — reading-mode rendering of folio's extended tables.
 *
 * Two independent rehype passes, both deliberately conservative: anything they
 * cannot make sense of they leave exactly as remark-gfm produced it, so a
 * damaged (or simply ordinary) table always renders as an ordinary table.
 *
 * 1. `rehypeTableExtensions` — the merge layer and the metadata line. GFM
 *    throws away the one thing that distinguishes a merged cell from an empty
 *    one (`||` tight versus `|  |` spaced), so this pass goes back to the
 *    markdown source for every table it sees, using the positions remark
 *    attached, re-reads the pipe rows with the shared splitter and rebuilds the
 *    rows: covered cells are dropped, anchors get `colSpan`/`rowSpan`,
 *    backgrounds become classes and column widths become a `<colgroup>`.
 *
 * 2. `rehypeCellLists` — the cell-level list structure becomes a real (and
 *    really nested) `<ul>`/`<ol>`, which is what makes a Confluence-style
 *    "card" cell readable. Leading spaces are the nesting, two per level;
 *    github collapses them and shows a flat list, which is the intended
 *    degradation. Round 28 made this the whole reason a table with lists in
 *    its cells no longer has to fall back to raw HTML, so WHICH lines count as
 *    list items is no longer this file's opinion: it is `parseCellLines` in
 *    tableSyntax.ts, the contract the editable grid shares verbatim.
 *
 * Both run before rehype-sanitize, so everything they add is vetted like any
 * other markup. Backgrounds are classes, never inline styles — the sanitizer
 * does not pass `style`, and it is right not to.
 */
import { visit } from 'unist-util-visit';
import type { Element, ElementContent, Root, Text } from 'hast';
import {
  bgClass,
  cellKey,
  computeLayout,
  fitRow,
  isTableAttrLine,
  parseCellLines,
  parseTableAttrLine,
  splitCellBreaks,
  splitPipeRow,
  type CellLine,
  type TableAttrs,
} from './tableSyntax';

/** The bit of a vfile these plugins need: the markdown they are rendering. */
interface SourceFile {
  value?: unknown;
}

const isElement = (node: ElementContent | undefined, tag: string): node is Element =>
  node?.type === 'element' && node.tagName === tag;

function elementChildren(node: Element): Element[] {
  return node.children.filter((child): child is Element => child.type === 'element');
}

function addClass(node: Element, className: string): void {
  const properties = (node.properties ??= {});
  const current = properties.className;
  if (Array.isArray(current)) current.push(className);
  else if (typeof current === 'string') properties.className = [current, className];
  else properties.className = [className];
}

/* ------------------------------------------------------- merges + attrs -- */

interface TableSource {
  /** Pipe rows: header first, then body rows. The delimiter row is dropped. */
  cells: string[][];
  spanLeft: boolean[][];
  attrs: TableAttrs;
  /**
   * Body rows (0-based, as GFM counts them) that were metadata lines rather
   * than data — the legacy placement. GFM made a row out of each, so the tree
   * has to lose them too.
   */
  dropped: number[];
}

/**
 * Re-read one table from the markdown source. `startLine`/`endLine` are 1-based
 * and inclusive, exactly as hast positions report them.
 */
function readTableSource(lines: string[], startLine: number, endLine: number): TableSource | null {
  const block = lines.slice(startLine - 1, endLine);
  if (block.length < 2) return null;

  let attrs: TableAttrs = { bg: {}, width: {} };
  const merge = (next: TableAttrs) => {
    attrs = {
      bg: { ...attrs.bg, ...next.bg },
      width: { ...attrs.width, ...next.width },
      ...(next.layout ?? attrs.layout ? { layout: next.layout ?? attrs.layout } : {}),
    };
  };

  // The metadata line lives above the table (see tableSyntax.ts). One blank
  // line between the two is the form we write; none is tolerated on read.
  for (let at = startLine - 2; at >= 0 && at >= startLine - 3; at--) {
    const line = lines[at];
    if (line === undefined) break;
    if (line.trim() === '') continue;
    const parsed = parseTableAttrLine(line);
    if (parsed) merge(parsed);
    break;
  }

  const header = splitPipeRow(block[0]);
  const width = header.cells.length;
  if (width === 0) return null;

  const cells: string[][] = [fitRow(header.cells, width, '')];
  const spanLeft: boolean[][] = [fitRow(header.spanLeft, width, false)];

  const dropped: number[] = [];
  block.slice(2).forEach((line, index) => {
    // The DEV-PLAN's original placement — a metadata line inside the body.
    // Read it and drop the row; the editor rewrites it above the table on the
    // next edit, because inside the body it is a visible row to github.
    if (isTableAttrLine(line)) {
      const parsed = parseTableAttrLine(line);
      if (parsed) merge(parsed);
      dropped.push(index);
      return;
    }
    const row = splitPipeRow(line);
    cells.push(fitRow(row.cells, width, ''));
    spanLeft.push(fitRow(row.spanLeft, width, false));
  });

  return { cells, spanLeft, attrs, dropped };
}

/** The `<tr>`s of a table, header first — the order `readTableSource` uses. */
function tableRows(table: Element): { head: Element[]; body: Element[] } | null {
  const head: Element[] = [];
  const body: Element[] = [];
  for (const section of elementChildren(table)) {
    if (section.tagName === 'thead') head.push(...elementChildren(section).filter((r) => r.tagName === 'tr'));
    else if (section.tagName === 'tbody' || section.tagName === 'tfoot') {
      body.push(...elementChildren(section).filter((r) => r.tagName === 'tr'));
    } else if (section.tagName === 'tr') body.push(section);
  }
  if (head.length !== 1) return null;
  return { head, body };
}

/** Remove rows from whichever section holds them (and empty sections with it). */
function detachRows(table: Element, gone: ReadonlySet<Element>): void {
  for (const section of elementChildren(table)) {
    section.children = section.children.filter(
      (child) => !(child.type === 'element' && gone.has(child)),
    );
  }
  table.children = table.children.filter(
    (child) =>
      !(
        child.type === 'element' &&
        (child.tagName === 'tbody' || child.tagName === 'tfoot') &&
        elementChildren(child).length === 0
      ),
  );
}

export function rehypeTableExtensions() {
  return (tree: Root, file: SourceFile) => {
    const source = typeof file?.value === 'string' ? file.value : '';
    if (!source) return;
    const lines = source.split('\n');

    visit(tree, 'element', (node) => {
      if (node.tagName !== 'table') return;
      const position = node.position;
      if (!position) return;

      const rows = tableRows(node);
      if (!rows) return;

      const read = readTableSource(lines, position.start.line, position.end.line);
      if (!read) return;

      if (read.dropped.length > 0) {
        const gone = new Set(read.dropped.map((index) => rows.body[index]).filter(Boolean));
        if (gone.size !== read.dropped.length) return;
        detachRows(node, gone);
        rows.body = rows.body.filter((row) => !gone.has(row));
      }

      // Anything that doesn't line up exactly means the source we re-read is
      // not the source this table came from (an indented table, a table inside
      // a blockquote, a parser difference we didn't foresee). Leave it alone.
      const all = [...rows.head, ...rows.body];
      if (all.length !== read.cells.length) return;
      const width = read.cells[0].length;
      if (all.some((row) => elementChildren(row).length !== width)) return;

      applyLayout(node, all, read, width);
    });
  };
}

function applyLayout(table: Element, rows: Element[], read: TableSource, width: number): void {
  const layout = computeLayout(read.cells, read.spanLeft);

  rows.forEach((row, r) => {
    const cells = elementChildren(row);
    const kept: ElementContent[] = [];

    cells.forEach((cell, c) => {
      const box = layout.grid[r]?.[c];
      if (!box) return;
      if (box.row !== r || box.col !== c) return; // covered by a merge

      if (box.colSpan > 1) (cell.properties ??= {}).colSpan = box.colSpan;
      if (box.rowSpan > 1) (cell.properties ??= {}).rowSpan = box.rowSpan;

      const token = read.attrs.bg[cellKey(r - 1, c)];
      if (token) addClass(cell, bgClass(token));
      kept.push(cell);
    });

    row.children = kept;
  });

  applyWidths(table, read.attrs, width);
  if (read.attrs.layout === 'columns') addClass(table, 'folio-layout-columns');
}

/**
 * Column widths as a `<colgroup>`. `width` on `<col>` is a presentational
 * attribute the HTML rendering spec still defines (and every browser honours),
 * which matters here: the sanitizer does not pass `style`, and the widths are
 * arbitrary percentages, so a class palette could not express them. Percentages
 * that do not add up to 100 are left exactly as written — the browser
 * distributes the remainder, and the table stays a table either way.
 */
function applyWidths(table: Element, attrs: TableAttrs, width: number): void {
  const widths = Object.entries(attrs.width)
    .map(([col, value]) => [Number(col) - 1, value] as const)
    .filter(([col]) => col >= 0 && col < width);
  if (widths.length === 0) return;

  const map = new Map(widths);
  const group: Element = {
    type: 'element',
    tagName: 'colgroup',
    properties: {},
    children: Array.from({ length: width }, (_, col): ElementContent => {
      const value = map.get(col);
      return {
        type: 'element',
        tagName: 'col',
        properties: value ? { width: value } : {},
        children: [],
      };
    }),
  };
  table.children.unshift(group);
  addClass(table, 'folio-table-sized');
}

/* ------------------------------------------------------------ cell lists -- */

/**
 * One `<br>`-separated line of a cell, classified — the hast-side counterpart
 * of tableSyntax.ts's `CellLine`. It carries hast children instead of a string,
 * and that is the whole reason this runs on the tree: everything after the
 * marker is ordinary inline markdown (bold, a link, code, a mention pill) that
 * remark has already parsed, and it moves into the `<li>` exactly as it would
 * have stayed in the cell. Nothing inline is ever re-parsed here.
 */
interface RenderLine {
  kind: 'text' | 'bullet' | 'task' | 'ordered';
  /** 1-based nesting, as the contract counts it; 0 for a paragraph line. */
  depth: number;
  checked: boolean;
  content: ElementContent[];
}

/**
 * Round 21's checklist marker — the one marker still read here rather than
 * taken from the round-28 contract, because `parseCellLines` has no case for
 * `[ ]`/`[x]` and reads such a line as a paragraph.
 */
const TASK = /^([ \t]*)\[([ xX])\][ \t]+/;

/** The contract's indent rule, two spaces per level, for the marker it doesn't own. */
function taskDepth(spaces: string): number {
  return Math.floor(spaces.replace(/\t/g, '  ').length / 2) + 1;
}

/** Split a cell's inline children into lines at every `<br>`. */
function splitLines(children: ElementContent[]): ElementContent[][] {
  const lines: ElementContent[][] = [[]];
  for (const child of children) {
    if (isElement(child, 'br')) lines.push([]);
    else lines[lines.length - 1].push(child);
  }
  return lines;
}

/**
 * How many characters of `raw` the marker took (indent + bullet + the spacing
 * after it), or -1 when that can't be located. Deliberately derived from the
 * contract's own output rather than from a second copy of its regex — a second
 * copy is exactly how this pass drifted before round 28, recognising `•` but
 * not the `- ` the DEV-PLAN writes. `line.text` is the item with the marker
 * already stripped, so where that text starts is where the marker ended.
 */
function markerWidth(raw: string, line: CellLine): number {
  const segment = splitCellBreaks(raw)[0] ?? raw;
  // Marker alone in this text node: the item's content is in the nodes after it.
  if (line.text === '') return segment.length;
  const at = segment.indexOf(line.text);
  return at < 0 ? -1 : at;
}

/**
 * Read one line's list marker off its first text node, removing it. Which
 * markers exist and how indentation nests are tableSyntax.ts's call, not this
 * file's; a line the contract doesn't call an item stays a paragraph line.
 */
function readLine(nodes: ElementContent[]): RenderLine {
  const first = nodes[0];
  const text = first?.type === 'text' ? (first as Text) : null;
  const value = text?.value ?? '';

  const task = TASK.exec(value);
  if (task) {
    text!.value = value.slice(task[0].length);
    return { kind: 'task', depth: taskDepth(task[1]), checked: task[2] !== ' ', content: nodes };
  }

  const plain: RenderLine = { kind: 'text', depth: 0, checked: false, content: nodes };
  const [line] = parseCellLines(value);
  if (!line?.marker) return plain;
  const width = markerWidth(value, line);
  if (width < 0) return plain;

  text!.value = value.slice(width);
  return {
    kind: line.marker === 'ol' ? 'ordered' : 'bullet',
    depth: line.depth,
    checked: false,
    content: nodes,
  };
}

function listItem(line: RenderLine): Element {
  const children: ElementContent[] = [...line.content];
  if (line.kind === 'task') {
    children.unshift({
      type: 'element',
      tagName: 'input',
      properties: { type: 'checkbox', disabled: true, checked: line.checked },
      children: [],
    });
  }
  return { type: 'element', tagName: 'li', properties: {}, children };
}

/**
 * Build one list (and its sub-lists) from a run of list lines, starting at
 * `at`. Returns the element and the index after the run at this level. Depth
 * is not clamped: the format puts no ceiling on nesting (DEV-PLAN round 28 —
 * "we do not introduce restrictions"), it only stops promising it will look good.
 */
function buildList(lines: RenderLine[], at: number, level: number): { node: Element; next: number } {
  const ordered = lines[at].kind === 'ordered';
  const list: Element = {
    type: 'element',
    tagName: ordered ? 'ol' : 'ul',
    properties: {},
    children: [],
  };

  let index = at;
  while (index < lines.length && lines[index].kind !== 'text' && lines[index].depth >= level) {
    if (lines[index].depth > level) {
      const nested = buildList(lines, index, lines[index].depth);
      const previous = list.children[list.children.length - 1];
      if (previous?.type === 'element') previous.children.push(nested.node);
      else list.children.push(nested.node);
      index = nested.next;
      continue;
    }
    // A different marker at the same level starts a new list of its own.
    if ((lines[index].kind === 'ordered') !== ordered) break;
    list.children.push(listItem(lines[index]));
    index++;
  }
  return { node: list, next: index };
}

export function rehypeCellLists() {
  return (tree: Root) => {
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'td' && node.tagName !== 'th') return;
      const raw = splitLines(node.children);
      if (raw.length < 1) return;

      const lines = raw.map(readLine);
      if (!lines.some((line) => line.kind !== 'text')) return; // nothing to build

      // Paragraph lines and lists come out in the order they were written —
      // a cell is allowed to mix them (DEV-PLAN round 28), and "intro, list,
      // conclusion" is what a Confluence card cell usually is.
      const out: ElementContent[] = [];
      let index = 0;
      while (index < lines.length) {
        if (lines[index].kind === 'text') {
          if (lines[index].content.length > 0) {
            // Between two paragraph lines the `<br>` IS the line break. After
            // a list it would be a second one — `</ul>` already ended the line.
            const last = out[out.length - 1];
            if (out.length > 0 && !isElement(last, 'ul') && !isElement(last, 'ol')) {
              out.push({ type: 'element', tagName: 'br', properties: {}, children: [] });
            }
            out.push(...lines[index].content);
          }
          index++;
          continue;
        }
        const { node: list, next } = buildList(lines, index, lines[index].depth);
        out.push(list);
        index = next;
      }
      node.children = out;
    });
  };
}
