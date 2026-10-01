/**
 * Round 26 (DATA TABLES) — the client half of the structured table Y.Doc.
 *
 * These are the browser-side counterparts of server/collabTables.test.ts's
 * matrix: same CRDT, same merge, exercised through the patch vocabulary the
 * grid actually emits (`TablePatch`) rather than through raw Y calls.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { TableColumn, TableDoc, TableRow } from '@shared/contracts';
import type { TablePatch } from '../types';
import {
  TABLE_LOCAL_ORIGIN,
  applyTablePatch,
  applyTablePatches,
  isTableYDocSeeded,
  pruneDanglingColumnRefs,
  seedTableYDoc,
  setYText,
  tableDocFromYDoc,
  tableRoots,
  undoScope,
} from './ydoc';

const COLUMNS: TableColumn[] = [
  { id: 'week', name: 'Week', type: 'select', options: [{ value: 'W8', color: 'blue' }, { value: 'W9', color: 'green' }] },
  { id: 'owner', name: 'Owner', type: 'text' },
  { id: 'goal', name: 'Goal', type: 'longtext' },
  { id: 'done', name: 'Done', type: 'checkbox' },
];

function row(id: string, owner: string, goal: string): TableRow {
  return { id, values: { week: 'W8', owner, goal, done: false } };
}

function fixtureDoc(): TableDoc {
  return {
    meta: { id: '01table', version: 1, rowIds: 'column' },
    head: '# Plan\n\n',
    tail: '\nAfter.\n',
    columns: COLUMNS.map((c) => ({ ...c })),
    views: [
      {
        id: 'all',
        name: 'All records',
        columns: { hidden: [], order: [], width: {} },
        sort: [],
        filter: { op: 'and', rules: [] },
        frozen: 0,
        rowHeight: 'short',
      },
    ],
    rows: [row('r1', 'sk', 'Ship it'), row('r2', 'va', 'Review it'), row('r3', 'ab', 'Plan it')],
  };
}

function seeded(doc: TableDoc = fixtureDoc()): Y.Doc {
  const ydoc = new Y.Doc();
  ydoc.transact(() => {
    seedTableYDoc(ydoc, doc);
    tableRoots(ydoc).meta.set('seeded', true);
  });
  return ydoc;
}

function fork(base: Y.Doc): Y.Doc {
  const d = new Y.Doc();
  Y.applyUpdate(d, Y.encodeStateAsUpdate(base));
  return d;
}

function sync(a: Y.Doc, b: Y.Doc): void {
  const fromA = Y.encodeStateAsUpdate(a);
  const fromB = Y.encodeStateAsUpdate(b);
  Y.applyUpdate(a, fromB);
  Y.applyUpdate(b, fromA);
}

function byId(doc: TableDoc, id: string): TableRow {
  const r = doc.rows.find((x) => x.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
}

describe('structured table Y.Doc (client)', () => {
  it('seeds into the six roots and round-trips back to the same TableDoc', () => {
    const original = fixtureDoc();
    const ydoc = seeded(original);
    const roots = tableRoots(ydoc);

    expect(roots.columns.length).toBe(4);
    expect(roots.rows.length).toBe(3);
    expect(roots.views.length).toBe(1);
    expect(roots.head.toString()).toBe('# Plan\n\n');
    expect(roots.rows.get(0).get('goal')).toBeInstanceOf(Y.Text); // longtext is mergeable
    expect(roots.rows.get(0).get('done')).toBe(false); // scalars are plain values
    expect(isTableYDocSeeded(ydoc)).toBe(true);

    expect(tableDocFromYDoc(ydoc)).toEqual(original);
  });

  it('an unseeded doc reports itself as unseeded, so the UI can show a skeleton instead of an empty table', () => {
    const ydoc = new Y.Doc();
    expect(isTableYDocSeeded(ydoc)).toBe(false);
    ydoc.transact(() => seedTableYDoc(ydoc, fixtureDoc()));
    expect(isTableYDocSeeded(ydoc)).toBe(false); // content alone is not "seeded" — the server sets the marker
  });

  it('tableDocFromYDoc throws (rather than rendering nonsense) when the CRDT holds an invalid column', () => {
    const ydoc = seeded();
    ydoc.transact(() => tableRoots(ydoc).columns.get(0).set('type', 'not-a-real-type'));
    expect(() => tableDocFromYDoc(ydoc)).toThrow(/invalid column/);
  });
});

describe('applyTablePatch (the grid vocabulary)', () => {
  it('rows:create inserts at a position, rows:update writes only the named cells', () => {
    const ydoc = seeded();
    applyTablePatches(ydoc, [
      { kind: 'rows:create', at: 1, rows: [row('rNew', 'zz', 'Inserted')] },
      { kind: 'rows:update', rows: [{ id: 'r3', values: { owner: 'patched' } }] },
    ]);
    const doc = tableDocFromYDoc(ydoc);
    expect(doc.rows.map((r) => r.id)).toEqual(['r1', 'rNew', 'r2', 'r3']);
    expect(byId(doc, 'r3').values.owner).toBe('patched');
    expect(byId(doc, 'r3').values.goal).toBe('Plan it'); // untouched cells preserved
  });

  it('rows:update on a longtext cell splices rather than replacing, keeping a collaborator\'s concurrent typing', () => {
    const base = seeded();
    const a = fork(base);
    const b = fork(base);

    applyTablePatches(a, [{ kind: 'rows:update', rows: [{ id: 'r1', values: { goal: 'Ship it today' } }] }]);
    b.transact(() => {
      const t = tableRoots(b).rows.get(0).get('goal') as Y.Text;
      t.insert(0, 'PLEASE ');
    }, 'other');

    sync(a, b);
    expect(String(byId(tableDocFromYDoc(a), 'r1').values.goal)).toBe('PLEASE Ship it today');
  });

  it('rows:delete and rows:update address rows BY ID, so a concurrent insert above them changes nothing', () => {
    const ydoc = seeded();
    applyTablePatches(ydoc, [{ kind: 'rows:create', at: 0, rows: [row('r0', 'first', 'On top')] }]);
    applyTablePatches(ydoc, [
      { kind: 'rows:update', rows: [{ id: 'r2', values: { owner: 'still-r2' } }] },
      { kind: 'rows:delete', ids: ['r3'] },
    ]);
    const doc = tableDocFromYDoc(ydoc);
    expect(doc.rows.map((r) => r.id)).toEqual(['r0', 'r1', 'r2']);
    expect(byId(doc, 'r2').values.owner).toBe('still-r2');
    expect(byId(doc, 'r1').values.owner).toBe('sk');
  });

  it('a patch naming a row that no longer exists dissolves instead of throwing', () => {
    const ydoc = seeded();
    applyTablePatches(ydoc, [{ kind: 'rows:delete', ids: ['r2'] }]);
    expect(() => applyTablePatches(ydoc, [{ kind: 'rows:update', rows: [{ id: 'r2', values: { owner: 'ghost' } }] }])).not.toThrow();
    expect(JSON.stringify(tableDocFromYDoc(ydoc))).not.toContain('ghost');
  });

  it('a patch naming a column that no longer exists does not mint an orphan key', () => {
    const ydoc = seeded();
    applyTablePatches(ydoc, [{ kind: 'columns:delete', id: 'owner' }]);
    applyTablePatches(ydoc, [{ kind: 'rows:update', rows: [{ id: 'r1', values: { owner: 'late' } }] }]);
    // The pre-existing value is still there (undo restores it); the LATE write
    // never created one, because there was no column to write into.
    expect(tableRoots(ydoc).rows.get(0).get('owner')).toBe('sk');
  });

  it('columns:delete leaves cell values in the CRDT but out of the structural doc, and undo brings them back', () => {
    const ydoc = seeded();
    const undo = new Y.UndoManager(undoScope(ydoc), { trackedOrigins: new Set([TABLE_LOCAL_ORIGIN]) });

    applyTablePatches(ydoc, [{ kind: 'columns:delete', id: 'owner' }]);
    const after = tableDocFromYDoc(ydoc);
    expect(after.columns.map((c) => c.id)).toEqual(['week', 'goal', 'done']);
    expect(byId(after, 'r1').values.owner).toBeUndefined();
    expect(tableRoots(ydoc).rows.get(0).get('owner')).toBe('sk'); // still in the CRDT

    undo.undo();
    const restored = tableDocFromYDoc(ydoc);
    expect(restored.columns.map((c) => c.id)).toEqual(['week', 'owner', 'goal', 'done']);
    expect(byId(restored, 'r1').values.owner).toBe('sk');
  });

  it('views:delete refuses to remove the last view (spec §5)', () => {
    const ydoc = seeded();
    applyTablePatches(ydoc, [{ kind: 'views:delete', id: 'all' }]);
    expect(tableDocFromYDoc(ydoc).views.map((v) => v.id)).toEqual(['all']);

    applyTablePatches(ydoc, [
      {
        kind: 'views:create',
        view: { id: 'mine', name: 'Mine', columns: { hidden: [], order: [], width: {} }, sort: [], filter: { op: 'and', rules: [] }, frozen: 0, rowHeight: 'short' },
      },
    ]);
    applyTablePatches(ydoc, [{ kind: 'views:delete', id: 'all' }]);
    expect(tableDocFromYDoc(ydoc).views.map((v) => v.id)).toEqual(['mine']);
  });

  it('a batch is ONE transaction, so it is one undo step and one write-back', () => {
    const ydoc = seeded();
    let transactions = 0;
    ydoc.on('afterTransaction', () => transactions++);
    const patches: TablePatch[] = [
      { kind: 'rows:update', rows: [{ id: 'r1', values: { owner: 'a' } }] },
      { kind: 'rows:update', rows: [{ id: 'r2', values: { owner: 'b' } }] },
      { kind: 'rows:delete', ids: ['r3'] },
    ];
    applyTablePatches(ydoc, patches);
    expect(transactions).toBe(1);

    const undo = new Y.UndoManager(undoScope(ydoc), { trackedOrigins: new Set([TABLE_LOCAL_ORIGIN]) });
    applyTablePatches(ydoc, [{ kind: 'rows:update', rows: [{ id: 'r1', values: { owner: 'c' } }] }]);
    undo.undo();
    expect(byId(tableDocFromYDoc(ydoc), 'r1').values.owner).toBe('a');
  });

  it('an empty batch produces no transaction at all', () => {
    const ydoc = seeded();
    let transactions = 0;
    ydoc.on('afterTransaction', () => transactions++);
    applyTablePatches(ydoc, []);
    expect(transactions).toBe(0);
  });
});

describe('undo scoping (spec §6 rule 7)', () => {
  it('Cmd+Z never rolls back a collaborator\'s change, or the server\'s reconcile pass', () => {
    const ydoc = seeded();
    const undo = new Y.UndoManager(undoScope(ydoc), { trackedOrigins: new Set([TABLE_LOCAL_ORIGIN]) });

    applyTablePatches(ydoc, [{ kind: 'rows:update', rows: [{ id: 'r1', values: { owner: 'mine' } }] }]);
    // A remote update arrives (the provider is the origin for those) ...
    ydoc.transact(() => tableRoots(ydoc).rows.get(1).set('owner', 'theirs'), 'remote-provider');
    // ... and so does the server's reconcile pass.
    ydoc.transact(() => tableRoots(ydoc).rows.get(2).set('owner', 'server'), 'folio:table:seed');

    undo.undo();

    const doc = tableDocFromYDoc(ydoc);
    expect(byId(doc, 'r1').values.owner).toBe('sk'); // only my own change came back
    expect(byId(doc, 'r2').values.owner).toBe('theirs');
    expect(byId(doc, 'r3').values.owner).toBe('server');
    expect(undo.canUndo()).toBe(false);
  });

  it('the undo scope covers columns, views and prose — not just rows', () => {
    const ydoc = seeded();
    const undo = new Y.UndoManager(undoScope(ydoc), { trackedOrigins: new Set([TABLE_LOCAL_ORIGIN]) });

    applyTablePatches(ydoc, [{ kind: 'columns:update', id: 'owner', patch: { name: 'Responsible' } }]);
    undo.undo();
    expect(tableDocFromYDoc(ydoc).columns.find((c) => c.id === 'owner')!.name).toBe('Owner');

    applyTablePatches(ydoc, [{ kind: 'views:update', id: 'all', patch: { rowHeight: 'tall' } }]);
    undo.undo();
    expect(tableDocFromYDoc(ydoc).views[0].rowHeight).toBe('short');

    ydoc.transact(() => setYText(tableRoots(ydoc).head, '# Renamed\n\n'), TABLE_LOCAL_ORIGIN);
    undo.undo();
    expect(tableRoots(ydoc).head.toString()).toBe('# Plan\n\n');
  });
});

describe('concurrent merge through the client patch path', () => {
  it('two clients editing different cells both land', () => {
    const base = seeded();
    const a = fork(base);
    const b = fork(base);
    applyTablePatches(a, [{ kind: 'rows:update', rows: [{ id: 'r1', values: { owner: 'A' } }] }]);
    applyTablePatches(b, [{ kind: 'rows:update', rows: [{ id: 'r2', values: { owner: 'B' } }] }]);
    sync(a, b);
    for (const d of [tableDocFromYDoc(a), tableDocFromYDoc(b)]) {
      expect(byId(d, 'r1').values.owner).toBe('A');
      expect(byId(d, 'r2').values.owner).toBe('B');
    }
  });

  it('two clients adding rows keep both, and converge on the same order', () => {
    const base = seeded();
    const a = fork(base);
    const b = fork(base);
    applyTablePatches(a, [{ kind: 'rows:create', at: 3, rows: [row('rA', 'a', 'A row')] }]);
    applyTablePatches(b, [{ kind: 'rows:create', at: 3, rows: [row('rB', 'b', 'B row')] }]);
    sync(a, b);
    const ids = tableDocFromYDoc(a).rows.map((r) => r.id);
    expect(ids).toEqual(tableDocFromYDoc(b).rows.map((r) => r.id));
    expect(ids).toContain('rA');
    expect(ids).toContain('rB');
    expect(ids).toHaveLength(5);
  });

  it('one client deletes a row while another edits it — the row stays gone, the edit dissolves', () => {
    const base = seeded();
    const a = fork(base);
    const b = fork(base);
    applyTablePatches(a, [{ kind: 'rows:delete', ids: ['r2'] }]);
    applyTablePatches(b, [{ kind: 'rows:update', rows: [{ id: 'r2', values: { owner: 'into-the-void' } }] }]);
    sync(a, b);
    for (const d of [tableDocFromYDoc(a), tableDocFromYDoc(b)]) {
      expect(d.rows.map((r) => r.id)).toEqual(['r1', 'r3']);
      expect(JSON.stringify(d)).not.toContain('into-the-void');
    }
  });
});

describe('pruneDanglingColumnRefs', () => {
  it('strips hidden/order/width/sort/filter references to a column that is gone', () => {
    const view = fixtureDoc().views[0];
    const withRefs = {
      ...view,
      columns: { hidden: ['owner', 'gone'], order: ['week', 'gone'], width: { week: 100, gone: 50 } },
      sort: [{ column: 'gone', dir: 'asc' as const }],
      filter: { op: 'and' as const, rules: [{ column: 'gone', operator: 'is' as const, value: 'x' }] },
    };
    const pruned = pruneDanglingColumnRefs(withRefs, new Set(['week', 'owner']));
    expect(pruned.columns.hidden).toEqual(['owner']);
    expect(pruned.columns.order).toEqual(['week']);
    expect(pruned.columns.width).toEqual({ week: 100 });
    expect(pruned.sort).toEqual([]);
    expect(pruned.filter.rules).toEqual([]);
  });

  it('returns the SAME object when nothing dangles, so React sees no change', () => {
    const view = fixtureDoc().views[0];
    expect(pruneDanglingColumnRefs(view, new Set(['week', 'owner', 'goal', 'done']))).toBe(view);
  });
});

describe('setYText', () => {
  it('touches only the differing span, leaving the rest of the text\'s CRDT identity alone', () => {
    const ydoc = new Y.Doc();
    const t = ydoc.getText('t');
    t.insert(0, 'the quick brown fox');

    const deltas: unknown[] = [];
    t.observe((e) => deltas.push(e.changes.delta));
    setYText(t, 'the quick red fox');

    expect(t.toString()).toBe('the quick red fox');
    // One retain + one delete + one insert, not a wholesale rewrite.
    expect(JSON.stringify(deltas)).toContain('"retain":10');
    expect(JSON.stringify(deltas)).not.toContain('"delete":19');
  });

  it('is a complete no-op when the text already matches', () => {
    const ydoc = new Y.Doc();
    const t = ydoc.getText('t');
    t.insert(0, 'unchanged');
    let events = 0;
    t.observe(() => events++);
    setYText(t, 'unchanged');
    expect(events).toBe(0);
  });
});
