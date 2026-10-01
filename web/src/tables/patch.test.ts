import { describe, expect, it } from 'vitest';
import type { TableRow } from '@shared/contracts';
import { applyPatch, applyPatches, makeEmptyRow, makeRowId, translateOperations } from './patch';
import { makeMockTableDoc } from './fixtures';

/**
 * Round 26 (DATA TABLES) — the grid⇄patch seam.
 *
 * These are the rules wave 3 depends on: COLLAB-TABLES receives exactly
 * these TablePatch objects and replays them into the Y.Doc. If the
 * translation is wrong here, concurrent editing corrupts data in ways the
 * CRDT itself cannot detect — so this is the highest-value test file in the
 * zone despite being the least visual.
 */

function row(id: string, values: Record<string, unknown>): TableRow {
  return { id, values: values as TableRow['values'] };
}

describe('translateOperations', () => {
  it('reads DELETE indexes from the OLD array, not the new one', () => {
    // The asymmetry that silently deletes the wrong rows when got backwards:
    // the grid removed index 1, so the new array no longer contains it.
    const previous = [row('a', {}), row('b', {}), row('c', {})];
    const next = [row('a', {}), row('c', {})];
    const patches = translateOperations(previous, next, [
      { type: 'DELETE', fromRowIndex: 1, toRowIndex: 2 },
    ]);
    expect(patches).toEqual([{ kind: 'rows:delete', ids: ['b'] }]);
  });

  it('reads CREATE indexes from the NEW array', () => {
    const previous = [row('a', {})];
    const next = [row('a', {}), row('b', { task: 'new' })];
    const patches = translateOperations(previous, next, [
      { type: 'CREATE', fromRowIndex: 1, toRowIndex: 2 },
    ]);
    expect(patches).toEqual([{ kind: 'rows:create', at: 1, rows: [next[1]] }]);
  });

  it('emits only the cells that actually changed, not the whole row', () => {
    // A paste over a wide block would otherwise produce thousands of no-op
    // cell writes, each a real CRDT op and a real undo entry.
    const previous = [row('a', { x: 1, y: 2, z: 3 })];
    const next = [row('a', { x: 1, y: 99, z: 3 })];
    const patches = translateOperations(previous, next, [
      { type: 'UPDATE', fromRowIndex: 0, toRowIndex: 1 },
    ]);
    expect(patches).toEqual([{ kind: 'rows:update', rows: [{ id: 'a', values: { y: 99 } }] }]);
  });

  it('emits nothing at all when an UPDATE changed no value', () => {
    const previous = [row('a', { x: 1 })];
    const next = [row('a', { x: 1 })];
    expect(translateOperations(previous, next, [{ type: 'UPDATE', fromRowIndex: 0, toRowIndex: 1 }])).toEqual([]);
  });

  it('treats an id absent from the old array as a full write', () => {
    const previous = [row('a', { x: 1 })];
    const next = [row('b', { x: 7 })];
    const patches = translateOperations(previous, next, [
      { type: 'UPDATE', fromRowIndex: 0, toRowIndex: 1 },
    ]);
    expect(patches).toEqual([{ kind: 'rows:update', rows: [{ id: 'b', values: { x: 7 } }] }]);
  });

  it('normalises a cleared cell to null rather than dropping the key', () => {
    const previous = [row('a', { x: 'v' })];
    const next = [row('a', {})];
    const patches = translateOperations(previous, next, [
      { type: 'UPDATE', fromRowIndex: 0, toRowIndex: 1 },
    ]);
    expect(patches).toEqual([{ kind: 'rows:update', rows: [{ id: 'a', values: { x: null } }] }]);
  });

  it('handles several operations from one onChange call', () => {
    const previous = [row('a', { x: 1 }), row('b', { x: 2 })];
    const next = [row('a', { x: 9 }), row('b', { x: 2 }), row('c', { x: 3 })];
    const patches = translateOperations(previous, next, [
      { type: 'UPDATE', fromRowIndex: 0, toRowIndex: 1 },
      { type: 'CREATE', fromRowIndex: 2, toRowIndex: 3 },
    ]);
    expect(patches.map((patch) => patch.kind)).toEqual(['rows:update', 'rows:create']);
  });
});

describe('applyPatch', () => {
  it('preserves object identity of rows a patch does not touch', () => {
    // The grid needs a referentially stable array or it re-renders every
    // visible cell per keystroke (spec §12a, constraint 4).
    const doc = makeMockTableDoc();
    const untouched = doc.rows[1];
    const next = applyPatch(doc, {
      kind: 'rows:update',
      rows: [{ id: doc.rows[0]!.id, values: { task: 'changed' } }],
    });
    expect(next.rows[1]).toBe(untouched);
    expect(next.rows[0]).not.toBe(doc.rows[0]);
    expect(next.rows[0]?.values.task).toBe('changed');
  });

  it('merges a partial cell update instead of replacing the row', () => {
    const doc = makeMockTableDoc();
    const before = doc.rows[0]!;
    const next = applyPatch(doc, { kind: 'rows:update', rows: [{ id: before.id, values: { task: 'x' } }] });
    expect(next.rows[0]?.values.status).toBe(before.values.status);
  });

  it('inserts created rows at the requested index', () => {
    const doc = makeMockTableDoc();
    const fresh = makeEmptyRow(doc, 'zzz');
    const next = applyPatch(doc, { kind: 'rows:create', at: 0, rows: [fresh] });
    expect(next.rows[0]?.id).toBe('zzz');
    expect(next.rows).toHaveLength(doc.rows.length + 1);
  });

  it('drops a deleted column and its values', () => {
    const doc = makeMockTableDoc();
    const next = applyPatch(doc, { kind: 'columns:delete', id: 'status' });
    expect(next.columns.some((column) => column.id === 'status')).toBe(false);
    expect('status' in (next.rows[0]?.values ?? {})).toBe(false);
  });

  it('refuses to delete the last remaining view (spec §5)', () => {
    const doc = makeMockTableDoc();
    const single = { ...doc, views: [doc.views[0]!] };
    expect(applyPatch(single, { kind: 'views:delete', id: single.views[0]!.id }).views).toHaveLength(1);
  });

  it('moves a row without losing it', () => {
    const doc = makeMockTableDoc();
    const moved = doc.rows[0]!.id;
    const next = applyPatch(doc, { kind: 'rows:move', id: moved, to: 2 });
    expect(next.rows).toHaveLength(doc.rows.length);
    expect(next.rows[2]?.id).toBe(moved);
  });

  it('is a no-op for a move of an unknown row id', () => {
    const doc = makeMockTableDoc();
    expect(applyPatch(doc, { kind: 'rows:move', id: 'nope', to: 0 })).toBe(doc);
  });
});

describe('applyPatches', () => {
  it('folds a sequence in order', () => {
    const doc = makeMockTableDoc();
    const next = applyPatches(doc, [
      { kind: 'rows:delete', ids: [doc.rows[0]!.id] },
      { kind: 'rows:create', at: 0, rows: [makeEmptyRow(doc, 'new1')] },
    ]);
    expect(next.rows[0]?.id).toBe('new1');
    expect(next.rows).toHaveLength(doc.rows.length);
  });
});

describe('makeEmptyRow', () => {
  it('seeds a checkbox as false and everything else as null', () => {
    const doc = makeMockTableDoc();
    const fresh = makeEmptyRow(doc, 'x');
    expect(fresh.values.blocked).toBe(false);
    expect(fresh.values.task).toBeNull();
  });
});

describe('makeRowId', () => {
  it('produces 8 characters of the Crockford base32 alphabet (spec §2.5)', () => {
    expect(makeRowId()).toMatch(/^[0123456789abcdefghjkmnpqrstvwxyz]{8}$/);
  });

  it('is deterministic given a seeded source, so ids are testable', () => {
    const constant = () => 0;
    expect(makeRowId(constant)).toBe('00000000');
  });
});
