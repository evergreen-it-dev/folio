/**
 * Pure redirection logic for arrow-key travel around block widgets and a
 * callout's label line — see block-nav.ts's module doc for why this is
 * tested separately from `view.moveVertically`/`moveByChar` (jsdom has no
 * `getClientRects`, so real vertical motion can't be driven end-to-end in a
 * DOM test; what CAN be checked without a browser, table-nav.ts style, is
 * "given the position a step landed on, where should it actually go").
 */
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { HEADER_ROW } from './gfm-table';
import type { BlockSpec } from './live-decorations';
import { horizontalTarget, tableEscape, verticalTarget } from './block-nav';

const TABLE_SOURCE = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'].join('\n');

function docOf(text: string) {
  return EditorState.create({ doc: text }).doc;
}

describe('verticalTarget', () => {
  it('landing inside a table going down opens its header cell', () => {
    const doc = docOf(`before\n${TABLE_SOURCE}\nafter`);
    const tableFrom = doc.toString().indexOf('| a');
    const tableTo = tableFrom + TABLE_SOURCE.length;
    const blocks: BlockSpec[] = [{ kind: 'table', from: tableFrom, to: tableTo, source: TABLE_SOURCE }];

    // "landed" stands in for wherever moveVertically's pixel math put the
    // caret — anywhere inside the table's span must redirect the same way.
    const target = verticalTarget(doc, blocks, new Set(), tableFrom + 3, true);

    expect(target).toEqual({ table: { from: tableFrom, ref: { row: HEADER_ROW, col: 0 } } });
  });

  it('landing inside a table going up opens its last row', () => {
    const doc = docOf(`before\n${TABLE_SOURCE}\nafter`);
    const tableFrom = doc.toString().indexOf('| a');
    const tableTo = tableFrom + TABLE_SOURCE.length;
    const blocks: BlockSpec[] = [{ kind: 'table', from: tableFrom, to: tableTo, source: TABLE_SOURCE }];

    const target = verticalTarget(doc, blocks, new Set(), tableTo - 2, false);

    expect(target).toEqual({ table: { from: tableFrom, ref: { row: 1, col: 0 } } });
  });

  it('landing on a callout label line steps over it, into the body below', () => {
    const text = '# Heading\n> [!NOTE]\n> body text';
    const doc = docOf(text);
    const labelLine = doc.lineAt(text.indexOf('[!NOTE]')).number;

    // Down from the heading naturally lands on the label line (line 2).
    const landed = doc.line(labelLine).from + 2;
    const target = verticalTarget(doc, [], new Set([labelLine]), landed, true);

    expect(target).not.toBeNull();
    const pos = (target as { pos: number }).pos;
    expect(doc.lineAt(pos).number).toBe(3); // the body line, not the label line
  });

  it('steps over a non-table block widget (e.g. an image) entirely', () => {
    const text = 'before\n![alt](img.png)\nafter';
    const doc = docOf(text);
    const imgFrom = text.indexOf('![alt]');
    const imgTo = imgFrom + '![alt](img.png)'.length;
    const blocks: BlockSpec[] = [{ kind: 'image', from: imgFrom, to: imgTo, alt: 'alt', src: 'img.png' }];

    const target = verticalTarget(doc, blocks, new Set(), imgFrom + 2, true);

    expect(target).toEqual({ pos: imgTo + 1 });
  });

  it('returns null when the naive landing spot is not inside anything', () => {
    const doc = docOf('one\ntwo\nthree');
    expect(verticalTarget(doc, [], new Set(), doc.line(2).from, true)).toBeNull();
  });

  it('chains: a label line with no body line before a table still opens the table', () => {
    // No blank/body line between them on purpose — the label-line skip must
    // hand off directly into the table-entry check on the very next hop.
    const text = '> [!NOTE]\n' + TABLE_SOURCE;
    const doc = docOf(text);
    const labelLine = 1;
    const tableFrom = text.indexOf('| a');
    const blocks: BlockSpec[] = [{ kind: 'table', from: tableFrom, to: tableFrom + TABLE_SOURCE.length, source: TABLE_SOURCE }];

    // Simulate landing on the label line first (as if arriving from a heading
    // right above the callout); the loop must carry on into the table.
    const target = verticalTarget(doc, blocks, new Set([labelLine]), doc.line(labelLine).from, true);

    expect(target).toEqual({ table: { from: tableFrom, ref: { row: HEADER_ROW, col: 0 } } });
  });

  it('a label line followed by real callout body text lands on the body, not the table beyond it', () => {
    const text = '> [!NOTE]\n> body\n' + TABLE_SOURCE;
    const doc = docOf(text);
    const labelLine = 1;
    const tableFrom = text.indexOf('| a');
    const blocks: BlockSpec[] = [{ kind: 'table', from: tableFrom, to: tableFrom + TABLE_SOURCE.length, source: TABLE_SOURCE }];

    const target = verticalTarget(doc, blocks, new Set([labelLine]), doc.line(labelLine).from, true);

    expect(target).toEqual({ pos: doc.line(2).from }); // "> body", not the table
  });
});

describe('horizontalTarget', () => {
  it('steps clean over a table, landing just past it', () => {
    const doc = docOf(`end\n${TABLE_SOURCE}\nafter`);
    const tableFrom = doc.toString().indexOf('| a');
    const tableTo = tableFrom + TABLE_SOURCE.length;
    const blocks: BlockSpec[] = [{ kind: 'table', from: tableFrom, to: tableTo, source: TABLE_SOURCE }];

    expect(horizontalTarget(doc, blocks, tableFrom, true)).toBe(tableTo + 1);
    expect(horizontalTarget(doc, blocks, tableTo, false)).toBe(tableFrom - 1);
  });

  it('returns null outside any block', () => {
    const doc = docOf('plain text');
    expect(horizontalTarget(doc, [], 4, true)).toBeNull();
  });
});

/**
 * The owner, 24.09 and 29.09.2026: a click in the margin around a table puts
 * the caret on the table's first or last character, which unfolds it.
 */
describe('tableEscape', () => {
  const table = { from: 20, to: 60 };

  it('sends a caret from the upper half to the line above, from the lower half to the line below', () => {
    expect(tableEscape(100, table, 20)).toEqual({ pos: 19 });
    expect(tableEscape(100, table, 30)).toEqual({ pos: 19 });
    expect(tableEscape(100, table, 60)).toEqual({ pos: 61 });
  });

  it('asks for a new line below a table that ends the document — there is nowhere else to keep writing', () => {
    expect(tableEscape(60, table, 60)).toEqual({ insertLine: 60 });
  });

  it('goes below a table that starts the document', () => {
    expect(tableEscape(100, { from: 0, to: 40 }, 0)).toEqual({ pos: 41 });
  });

  // PageDown over a table taller than the page lands in its upper half.
  it('keeps the keyboard going the way it was going, whichever half it landed in', () => {
    expect(tableEscape(100, table, 20, 5)).toEqual({ pos: 61 });
    expect(tableEscape(100, table, 60, 90)).toEqual({ pos: 19 });
  });

  it('does not turn a caret around that was moving up into the first table of the page', () => {
    expect(tableEscape(100, { from: 0, to: 40 }, 0, 70)).toBeNull();
  });
});
