// @vitest-environment jsdom
/**
 * Round 26 (DATA TABLES) — the React hooks over a table's Y.Doc.
 *
 * Every hook here takes a primitive (a Y.Doc, a Y.UndoManager) rather than
 * the session object, which is exactly what lets these run against a REAL
 * Y.Doc with no websocket, no server and no mock. `useTableCollab` itself is
 * the thin composition that adds the provider — the only part that genuinely
 * needs a socket, and which server/collabTables.test.ts covers end to end
 * against a real one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import * as Y from 'yjs';
import type { TableColumn, TableDoc, TableRow } from '@shared/contracts';
import { TABLE_LOCAL_ORIGIN, seedTableYDoc, tableRoots, undoScope } from './ydoc';
import { tableCellText, useTableDoc, useTablePatchSink, useTableUndo } from './useTableCollab';

afterEach(cleanup);

const COLUMNS: TableColumn[] = [
  { id: 'owner', name: 'Owner', type: 'text' },
  { id: 'goal', name: 'Goal', type: 'longtext' },
];

function row(id: string, owner: string, goal: string): TableRow {
  return { id, values: { owner, goal } };
}

function fixtureDoc(): TableDoc {
  return {
    meta: { id: '01table', version: 1, rowIds: 'column' },
    head: '# Plan\n\n',
    tail: '',
    columns: COLUMNS.map((c) => ({ ...c })),
    views: [
      { id: 'all', name: 'All', columns: { hidden: [], order: [], width: {} }, sort: [], filter: { op: 'and', rules: [] }, frozen: 0, rowHeight: 'short' },
    ],
    rows: [row('r1', 'sk', 'Ship it'), row('r2', 'va', 'Review it')],
  };
}

function seeded(): Y.Doc {
  const ydoc = new Y.Doc();
  ydoc.transact(() => {
    seedTableYDoc(ydoc, fixtureDoc());
    tableRoots(ydoc).meta.set('seeded', true);
  });
  return ydoc;
}

describe('useTableDoc', () => {
  it('reports "not seeded yet" for a room the server has not populated — the UI must show a skeleton, not an empty table', () => {
    const ydoc = new Y.Doc();
    const { result } = renderHook(() => useTableDoc(ydoc));
    expect(result.current.seeded).toBe(false);
    expect(result.current.doc).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('exposes the seeded table and re-renders when the CRDT changes', () => {
    const ydoc = seeded();
    const { result } = renderHook(() => useTableDoc(ydoc));

    expect(result.current.seeded).toBe(true);
    expect(result.current.doc).toEqual(fixtureDoc());

    act(() => {
      ydoc.transact(() => tableRoots(ydoc).rows.get(0).set('owner', 'changed'), TABLE_LOCAL_ORIGIN);
    });
    expect(result.current.doc!.rows[0].values.owner).toBe('changed');
  });

  it('re-renders for a REMOTE update too, not only local edits', () => {
    const ydoc = seeded();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    const { result } = renderHook(() => useTableDoc(ydoc));

    peer.transact(() => tableRoots(peer).rows.get(1).set('owner', 'from-peer'), 'peer');
    act(() => {
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer)); // what the websocket delivers
    });
    expect(result.current.doc!.rows[1].values.owner).toBe('from-peer');
  });

  it('returns a REFERENTIALLY STABLE snapshot between changes (an unstable one is an infinite render loop)', () => {
    const ydoc = seeded();
    const { result, rerender } = renderHook(() => useTableDoc(ydoc));
    const first = result.current;
    rerender();
    rerender();
    expect(result.current).toBe(first);

    act(() => {
      ydoc.transact(() => tableRoots(ydoc).rows.get(0).set('owner', 'x'), TABLE_LOCAL_ORIGIN);
    });
    expect(result.current).not.toBe(first);
    const second = result.current;
    rerender();
    expect(result.current).toBe(second);
  });

  it('surfaces a structurally invalid CRDT as an error rather than throwing through the render', () => {
    const ydoc = seeded();
    const { result } = renderHook(() => useTableDoc(ydoc));
    act(() => {
      ydoc.transact(() => tableRoots(ydoc).columns.get(0).set('type', 'nonsense'), TABLE_LOCAL_ORIGIN);
    });
    expect(result.current.doc).toBeNull();
    expect(result.current.error).toMatch(/invalid column/);
    expect(result.current.seeded).toBe(true);
  });

  it('handles a null doc (first render, before the provider exists)', () => {
    const { result } = renderHook(() => useTableDoc(null));
    expect(result.current).toEqual({ doc: null, error: null, seeded: false });
  });
});

describe('useTablePatchSink', () => {
  it('applies a patch under the LOCAL origin, so it lands in this client\'s undo stack', () => {
    const ydoc = seeded();
    const origins: unknown[] = [];
    ydoc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin));

    const { result } = renderHook(() => useTablePatchSink(ydoc));
    act(() => result.current({ kind: 'rows:update', rows: [{ id: 'r1', values: { owner: 'sunk' } }] }));

    expect(origins).toEqual([TABLE_LOCAL_ORIGIN]);
    expect(tableRoots(ydoc).rows.get(0).get('owner')).toBe('sunk');
  });

  it('batch() collapses many patches into one transaction', () => {
    const ydoc = seeded();
    let transactions = 0;
    ydoc.on('afterTransaction', () => transactions++);

    const { result } = renderHook(() => useTablePatchSink(ydoc));
    act(() =>
      result.current.batch([
        { kind: 'rows:update', rows: [{ id: 'r1', values: { owner: 'a' } }] },
        { kind: 'rows:update', rows: [{ id: 'r2', values: { owner: 'b' } }] },
      ]),
    );
    expect(transactions).toBe(1);
  });

  it('is a safe no-op with no doc yet', () => {
    const { result } = renderHook(() => useTablePatchSink(null));
    expect(() => result.current({ kind: 'rows:delete', ids: ['r1'] })).not.toThrow();
  });
});

describe('useTableUndo', () => {
  it('tracks canUndo/canRedo and only ever rolls back this client\'s own changes', () => {
    const ydoc = seeded();
    const undoManager = new Y.UndoManager(undoScope(ydoc), { trackedOrigins: new Set([TABLE_LOCAL_ORIGIN]), captureTimeout: 0 });
    const { result } = renderHook(() => useTableUndo(undoManager));

    expect(result.current.canUndo).toBe(false);

    act(() => {
      ydoc.transact(() => tableRoots(ydoc).rows.get(0).set('owner', 'mine'), TABLE_LOCAL_ORIGIN);
    });
    expect(result.current.canUndo).toBe(true);

    // A collaborator's change must not enter this stack.
    act(() => {
      ydoc.transact(() => tableRoots(ydoc).rows.get(1).set('owner', 'theirs'), 'remote');
    });

    act(() => result.current.undo());
    expect(tableRoots(ydoc).rows.get(0).get('owner')).toBe('sk'); // mine rolled back
    expect(tableRoots(ydoc).rows.get(1).get('owner')).toBe('theirs'); // theirs untouched
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);

    act(() => result.current.redo());
    expect(tableRoots(ydoc).rows.get(0).get('owner')).toBe('mine');
  });

  it('is inert with no undo manager yet', () => {
    const { result } = renderHook(() => useTableUndo(null));
    expect(result.current.canUndo).toBe(false);
    expect(() => result.current.undo()).not.toThrow();
  });
});

describe('tableCellText', () => {
  it('hands back the live Y.Text of a longtext cell, for a character-level cell editor', () => {
    const ydoc = seeded();
    const text = tableCellText(ydoc, 'r2', 'goal');
    expect(text).toBeInstanceOf(Y.Text);
    expect(text!.toString()).toBe('Review it');
    text!.insert(0, 'Carefully ');
    expect(tableRoots(ydoc).rows.get(1).get('goal')!.toString()).toBe('Carefully Review it');
  });

  it('returns null for a scalar cell, an unknown row, or an unknown column', () => {
    const ydoc = seeded();
    expect(tableCellText(ydoc, 'r1', 'owner')).toBeNull();
    expect(tableCellText(ydoc, 'nope', 'goal')).toBeNull();
    expect(tableCellText(ydoc, 'r1', 'nope')).toBeNull();
  });
});
