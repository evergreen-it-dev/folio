/**
 * Round 26 (DATA TABLES) — collab.ts's table-kind branches.
 *
 * Three layers, deliberately:
 *
 *  1. CONCURRENCY MATRIX (spec-tables.md §6.1) — every row of that table gets
 *     its own test. These fork two Y.Docs from a common state, let each apply
 *     its own edits, then merge BOTH ways with real Y.applyUpdate/
 *     encodeStateAsUpdate. That is exactly the merge the websocket sync
 *     protocol performs — same CRDT, same ops, no server needed — so these
 *     stay fast enough to run on every change while still testing the real
 *     thing rather than a simulation of it.
 *
 *  2. SEEDING / RECONCILIATION / SEATBELT — real PG + real files, calling
 *     bindState/persistDoc directly and simulating a server restart mid-edit.
 *     Mirrors the "THE DOUBLING fix" suite's style in gitNative.test.ts.
 *
 *  3. REAL WEBSOCKETS — a real http server, real y-websocket clients, real
 *     auth (three cookie sessions + one anonymous share-link guest all editing
 *     at once). This is the evidence for spec §6.2/§17.6: live collaborative
 *     table editing over sockets, not "optimistic REST".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import WS from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as collab from './collab.js';
import * as authStore from './auth/store.js';
import * as shares from './shares.js';
import { query } from './db/pool.js';
import { getOutOfListLabels, isTableParseError, parseTableFile, serializeTableFile } from '../shared/tables/index.js';
import type { TableColumn, TableDoc, TableRow } from '../shared/contracts.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const COLUMNS: TableColumn[] = [
  { id: 'week', name: 'Week', type: 'select', options: [{ value: 'W8', color: 'blue' }, { value: 'W9', color: 'green' }] },
  { id: 'owner', name: 'Owner', type: 'text' },
  { id: 'goal', name: 'Goal', type: 'longtext' },
  { id: 'done', name: 'Done', type: 'checkbox' },
  { id: 'status', name: 'Status', type: 'status', options: [{ value: 'TODO', color: 'gray' }, { value: 'DONE', color: 'green' }] },
];

function row(id: string, week: string, owner: string, goal: string, done: boolean, status: string): TableRow {
  return { id, values: { week, owner, goal, done, status } };
}

function fixtureDoc(id = '01jcxyz8q0w3m4e5r6'): TableDoc {
  return {
    meta: { id, version: 1, rowIds: 'column' },
    head: '# Weekly Plan\n\nIntro prose.\n\n',
    tail: '\nTrailing prose.\n',
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
    rows: [
      row('r0000001', 'W8', 'sk', 'Ship the thing', false, 'TODO'),
      row('r0000002', 'W8', 'va', 'Review the other thing', false, 'TODO'),
      row('r0000003', 'W9', 'sk', 'Plan next week', true, 'DONE'),
    ],
  };
}

/** A plain (ESM) Y.Doc seeded from `doc` and marked seeded, as bindState would leave it. */
function seededYDoc(doc: TableDoc = fixtureDoc()): Y.Doc {
  const ydoc = new Y.Doc();
  ydoc.transact(() => {
    collab.seedTableYDoc(ydoc, doc);
    collab.tableRoots(ydoc).meta.set('seeded', true);
  });
  return ydoc;
}

/** A second client's copy of `base`, holding the SAME ops (what a real sync produces). */
function fork(base: Y.Doc): Y.Doc {
  const d = new Y.Doc();
  Y.applyUpdate(d, Y.encodeStateAsUpdate(base));
  return d;
}

/** Full bidirectional sync, exactly what y-websocket does on reconnect. */
function sync(a: Y.Doc, b: Y.Doc): void {
  const fromA = Y.encodeStateAsUpdate(a);
  const fromB = Y.encodeStateAsUpdate(b);
  Y.applyUpdate(a, fromB);
  Y.applyUpdate(b, fromA);
}

function rowById(doc: TableDoc, id: string): TableRow {
  const r = doc.rows.find((x) => x.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
}

const CLIENT_A = 'client-a';
const CLIENT_B = 'client-b';

// ===========================================================================
// 1. Concurrency matrix — spec §6.1, one test per row of that table
// ===========================================================================

describe('spec §6.1 concurrency matrix', () => {
  it('MATRIX: different cells edited concurrently — both edits survive, order irrelevant', () => {
    const base = seededYDoc();
    const a = fork(base);
    const b = fork(base);

    a.transact(() => collab.tableRoots(a).rows.get(0).set('owner', 'alice'), CLIENT_A);
    b.transact(() => collab.tableRoots(b).rows.get(1).set('owner', 'bob'), CLIENT_B);

    sync(a, b);

    for (const doc of [collab.tableDocFromYDoc(a), collab.tableDocFromYDoc(b)]) {
      expect(rowById(doc, 'r0000001').values.owner).toBe('alice');
      expect(rowById(doc, 'r0000002').values.owner).toBe('bob');
    }
  });

  it('MATRIX: the SAME scalar cell edited concurrently — one deterministic winner, both clients agree', () => {
    const base = seededYDoc();
    const a = fork(base);
    const b = fork(base);

    a.transact(() => collab.tableRoots(a).rows.get(0).set('status', 'DONE'), CLIENT_A);
    b.transact(() => collab.tableRoots(b).rows.get(0).set('status', 'TODO'), CLIENT_B);

    sync(a, b);

    const fromA = rowById(collab.tableDocFromYDoc(a), 'r0000001').values.status;
    const fromB = rowById(collab.tableDocFromYDoc(b), 'r0000001').values.status;
    // The point is convergence, not which one won: both clients see the SAME
    // single value (never a merged/duplicated one), which is what makes the
    // loser see a clean value swap rather than corruption.
    expect(fromA).toBe(fromB);
    expect(['DONE', 'TODO']).toContain(fromA);
  });

  it('MATRIX: the SAME scalar cell, other scalar types (number/date/checkbox) — same single-winner outcome', () => {
    const doc = fixtureDoc();
    doc.columns.push({ id: 'points', name: 'Points', type: 'number' }, { id: 'due', name: 'Due', type: 'date' });
    for (const r of doc.rows) {
      r.values.points = 1;
      r.values.due = '2026-01-01';
    }
    const base = seededYDoc(doc);
    const a = fork(base);
    const b = fork(base);

    a.transact(() => {
      const m = collab.tableRoots(a).rows.get(0);
      m.set('points', 10);
      m.set('due', '2026-03-03');
      m.set('done', true);
    }, CLIENT_A);
    b.transact(() => {
      const m = collab.tableRoots(b).rows.get(0);
      m.set('points', 20);
      m.set('due', '2026-04-04');
      m.set('done', false);
    }, CLIENT_B);

    sync(a, b);

    const ra = rowById(collab.tableDocFromYDoc(a), 'r0000001').values;
    const rb = rowById(collab.tableDocFromYDoc(b), 'r0000001').values;
    expect(ra).toEqual(rb);
    expect([10, 20]).toContain(ra.points);
    expect(['2026-03-03', '2026-04-04']).toContain(ra.due);
    expect(typeof ra.done).toBe('boolean');
  });

  it('MATRIX: the SAME longtext cell edited concurrently — character-level merge, no text lost', () => {
    const base = seededYDoc();
    const a = fork(base);
    const b = fork(base);

    // Both append to the same Y.Text, at different offsets — this is the case
    // a plain "last writer wins" value would silently destroy.
    a.transact(() => {
      const t = collab.tableRoots(a).rows.get(0).get('goal') as Y.Text;
      t.insert(0, 'URGENT: ');
    }, CLIENT_A);
    b.transact(() => {
      const t = collab.tableRoots(b).rows.get(0).get('goal') as Y.Text;
      t.insert(t.length, ' (by Friday)');
    }, CLIENT_B);

    sync(a, b);

    const merged = String(rowById(collab.tableDocFromYDoc(a), 'r0000001').values.goal);
    expect(merged).toBe('URGENT: Ship the thing (by Friday)');
    expect(String(rowById(collab.tableDocFromYDoc(b), 'r0000001').values.goal)).toBe(merged);
  });

  it('MATRIX: two clients each add a row — both rows survive, ids distinct, order deterministic', () => {
    const base = seededYDoc();
    const a = fork(base);
    const b = fork(base);

    a.transact(() => collab.tableRoots(a).rows.push([buildRowLike('r000000a', 'from A')]), CLIENT_A);
    b.transact(() => collab.tableRoots(b).rows.push([buildRowLike('r000000b', 'from B')]), CLIENT_B);

    sync(a, b);

    const docA = collab.tableDocFromYDoc(a);
    const docB = collab.tableDocFromYDoc(b);
    expect(docA.rows).toHaveLength(5);
    expect(docA.rows.map((r) => r.id)).toEqual(docB.rows.map((r) => r.id)); // deterministic, identical on both
    expect(new Set(docA.rows.map((r) => r.id)).size).toBe(5); // no id collision, nothing merged together
    expect(rowById(docA, 'r000000a').values.owner).toBe('from A');
    expect(rowById(docA, 'r000000b').values.owner).toBe('from B');
  });

  it('MATRIX: a row deleted while another client is mid-edit on it — stays deleted, the edit dissolves', () => {
    const base = seededYDoc();
    const a = fork(base);
    const b = fork(base);

    a.transact(() => collab.tableRoots(a).rows.delete(1, 1), CLIENT_A); // deletes r0000002
    b.transact(() => {
      const m = collab.tableRoots(b).rows.get(1);
      m.set('owner', 'edited-into-the-void');
      (m.get('goal') as Y.Text).insert(0, 'still typing ');
    }, CLIENT_B);

    sync(a, b);

    for (const doc of [collab.tableDocFromYDoc(a), collab.tableDocFromYDoc(b)]) {
      expect(doc.rows.map((r) => r.id)).toEqual(['r0000001', 'r0000003']);
      expect(JSON.stringify(doc)).not.toContain('edited-into-the-void');
    }
    // ...and the file written from this doc carries no trace of the orphan.
    expect(serializeTableFile(collab.tableDocFromYDoc(a))).not.toContain('edited-into-the-void');
  });

  it('MATRIX: a column deleted while another client writes a cell in it — orphan never serialized, undo restores it', () => {
    const base = seededYDoc();
    const a = fork(base);
    const b = fork(base);

    // A's deletion is undoable, scoped to A's own origin (spec §6 rule 7).
    const undoA = new Y.UndoManager(collab.tableRoots(a).columns, { trackedOrigins: new Set([CLIENT_A]) });
    a.transact(() => collab.tableRoots(a).columns.delete(1, 1), CLIENT_A); // deletes `owner`
    b.transact(() => collab.tableRoots(b).rows.get(0).set('owner', 'written-after-delete'), CLIENT_B);

    sync(a, b);

    const merged = collab.tableDocFromYDoc(a);
    expect(merged.columns.map((c) => c.id)).toEqual(['week', 'goal', 'done', 'status']);
    // The orphaned key is NOT part of the structural doc and NOT in the file...
    expect(rowById(merged, 'r0000001').values.owner).toBeUndefined();
    expect(serializeTableFile(merged)).not.toContain('written-after-delete');
    // ...but it IS still in the CRDT, which is what makes undo restore it.
    expect(collab.tableRoots(a).rows.get(0).get('owner')).toBe('written-after-delete');

    undoA.undo();
    const restored = collab.tableDocFromYDoc(a);
    expect(restored.columns.map((c) => c.id)).toContain('owner');
    expect(rowById(restored, 'r0000001').values.owner).toBe('written-after-delete');
  });

  it('MATRIX: a column deleted while a view sorts/filters/hides it — no dangling reference reaches the file', () => {
    const doc = fixtureDoc();
    doc.views[0] = {
      ...doc.views[0],
      columns: { hidden: ['owner'], order: ['week', 'owner', 'goal'], width: { owner: 200 } },
      sort: [{ column: 'owner', dir: 'asc' }],
      filter: { op: 'and', rules: [{ column: 'owner', operator: 'is', value: 'sk' }] },
    };
    const ydoc = seededYDoc(doc);
    ydoc.transact(() => collab.tableRoots(ydoc).columns.delete(1, 1), CLIENT_A);

    const view = collab.tableDocFromYDoc(ydoc).views[0];
    expect(view.columns.hidden).not.toContain('owner');
    expect(view.columns.order).not.toContain('owner');
    expect(view.columns.width).not.toHaveProperty('owner');
    expect(view.sort).toHaveLength(0);
    expect(view.filter.rules).toHaveLength(0);

    // And the serialized file re-parses cleanly, with no reference to a column that isn't there.
    const reparsed = parseTableFile(serializeTableFile(collab.tableDocFromYDoc(ydoc)));
    expect(isTableParseError(reparsed)).toBe(false);
  });

  it('MATRIX: an option renamed while another client sets the old label — rename is one operation, the late cell is flagged out-of-list', () => {
    const base = seededYDoc();
    const a = fork(base);
    const b = fork(base);

    // A renames DONE -> SHIPPED and rewrites every referencing cell in ONE
    // transaction (spec §6.1: "the server rewrites the label in all cells
    // with one operation").
    a.transact(() => {
      const r = collab.tableRoots(a);
      const statusCol = r.columns.get(4);
      const opts = statusCol.get('options') as Y.Array<Y.Map<unknown>>;
      opts.get(1).set('value', 'SHIPPED');
      for (let i = 0; i < r.rows.length; i++) {
        if (r.rows.get(i).get('status') === 'DONE') r.rows.get(i).set('status', 'SHIPPED');
      }
    }, CLIENT_A);

    // B, concurrently and unaware, sets the OLD label on a different row.
    b.transact(() => collab.tableRoots(b).rows.get(0).set('status', 'DONE'), CLIENT_B);

    sync(a, b);

    const merged = collab.tableDocFromYDoc(a);
    const statusCol = merged.columns.find((c) => c.id === 'status')!;
    expect(statusCol.options?.map((o) => o.value)).toEqual(['TODO', 'SHIPPED']);
    expect(rowById(merged, 'r0000003').values.status).toBe('SHIPPED'); // renamed in the same operation
    expect(rowById(merged, 'r0000001').values.status).toBe('DONE'); // the late write keeps its label...
    // ...and is reported as "outside the list" rather than silently dropped, so the
    // next normalization pass can fix it (spec §2.4).
    expect(getOutOfListLabels(statusCol, 'DONE')).toEqual(['DONE']);
  });

  it("MATRIX: a column's type changed concurrently with a cell edit — the late value is converted by the codec, the file stays valid", () => {
    const doc = fixtureDoc();
    doc.columns.push({ id: 'points', name: 'Points', type: 'text' });
    for (const r of doc.rows) r.values.points = '7';
    const base = seededYDoc(doc);
    const a = fork(base);
    const b = fork(base);

    // A converts text -> number, folding the re-derived row values into the
    // SAME transaction (never a schema change and a value change apart).
    a.transact(() => {
      const r = collab.tableRoots(a);
      r.columns.get(5).set('type', 'number');
      for (let i = 0; i < r.rows.length; i++) r.rows.get(i).set('points', 7);
    }, CLIENT_A);

    // B, still on the old type, writes free text into that column.
    b.transact(() => collab.tableRoots(b).rows.get(0).set('points', 'not a number'), CLIENT_B);

    sync(a, b);

    const merged = collab.tableDocFromYDoc(a);
    expect(merged.columns.find((c) => c.id === 'points')!.type).toBe('number');
    expect(collab.tableDocFromYDoc(b)).toEqual(merged); // both clients converge

    // Which of the two writes to r0000001.points wins is a CRDT tie-break on
    // clientID and is deliberately NOT asserted — Yjs picks, and either answer
    // is correct per spec §6.1. What IS asserted is the invariant the spec
    // actually promises: the late, unconvertible value is run through the new
    // type's codec, so it can never leave garbage in a number column or break
    // the file.
    const reparsed = parseTableFile(serializeTableFile(merged));
    expect(isTableParseError(reparsed)).toBe(false);
    if (!isTableParseError(reparsed)) {
      expect(rowById(reparsed, 'r0000002').values.points).toBe(7); // untouched rows converted cleanly
      expect(rowById(reparsed, 'r0000003').values.points).toBe(7);
      const contested = rowById(reparsed, 'r0000001').values.points;
      expect(contested === null || contested === 7).toBe(true); // a number or empty — never 'not a number'
      expect(serializeTableFile(merged)).not.toContain('not a number');
    }
  });

  it('MATRIX: a view edited while another client edits rows — independent, both land', () => {
    const base = seededYDoc();
    const a = fork(base);
    const b = fork(base);

    a.transact(() => {
      collab.tableRoots(a).views.get(0).set('sort', [{ column: 'week', dir: 'desc' }]);
    }, CLIENT_A);
    b.transact(() => collab.tableRoots(b).rows.get(2).set('owner', 'changed'), CLIENT_B);

    sync(a, b);

    const merged = collab.tableDocFromYDoc(a);
    expect(merged.views[0].sort).toEqual([{ column: 'week', dir: 'desc' }]);
    expect(rowById(merged, 'r0000003').values.owner).toBe('changed');
  });

  it('MATRIX: two clients editing the SAME view — last writer wins, both converge', () => {
    const base = seededYDoc();
    const a = fork(base);
    const b = fork(base);

    a.transact(() => collab.tableRoots(a).views.get(0).set('rowHeight', 'tall'), CLIENT_A);
    b.transact(() => collab.tableRoots(b).views.get(0).set('rowHeight', 'medium'), CLIENT_B);

    sync(a, b);

    const fromA = collab.tableDocFromYDoc(a).views[0].rowHeight;
    const fromB = collab.tableDocFromYDoc(b).views[0].rowHeight;
    expect(fromA).toBe(fromB);
    expect(['tall', 'medium']).toContain(fromA);
  });

  it('spec §6 rule 7: an UndoManager scoped to one origin never undoes a collaborator\'s change', () => {
    const ydoc = seededYDoc();
    const roots = collab.tableRoots(ydoc);
    const undoA = new Y.UndoManager([roots.rows, roots.columns, roots.views], { trackedOrigins: new Set([CLIENT_A]) });

    ydoc.transact(() => roots.rows.get(0).set('owner', 'A-edit'), CLIENT_A);
    ydoc.transact(() => roots.rows.get(1).set('owner', 'B-edit'), CLIENT_B);

    undoA.undo();

    const doc = collab.tableDocFromYDoc(ydoc);
    expect(rowById(doc, 'r0000001').values.owner).toBe('sk'); // A's own edit rolled back
    expect(rowById(doc, 'r0000002').values.owner).toBe('B-edit'); // B's is untouched
  });
});

/** A row Y.Map shaped like the fixture's — what a client builds before pushing it into `rows`. */
function buildRowLike(id: string, owner: string): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set('id', id);
  m.set('week', 'W9');
  m.set('owner', owner);
  m.set('goal', new Y.Text());
  m.set('done', false);
  m.set('status', 'TODO');
  return m;
}

// ===========================================================================
// 2. Seeding, reconciliation and the seatbelt — real PG, real files
// ===========================================================================

describe('table bindState / persistDoc (real PG + real files)', () => {
  let teardownSchema: () => Promise<void>;
  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  /** Creates a real table page whose file holds the fixture's rows. */
  async function makeTablePage(label: string): Promise<{ space: string; id: string; absPath: string }> {
    const space = await storage.createSpace(`${label} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, null);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Weekly Plan', kind: 'table', columns: COLUMNS });
    const base = fixtureDoc(page.id);
    await storage.writeTableDoc(page.id, base);
    const entry = await storage.requireEntry(page.id);
    expect(entry.kind).toBe('table');
    return { space: space.slug, id: page.id, absPath: entry.absPath };
  }

  async function readFile(absPath: string): Promise<TableDoc> {
    const parsed = parseTableFile(await fs.readFile(absPath, 'utf8'));
    if (isTableParseError(parsed)) throw new Error(parsed.message);
    return parsed;
  }

  it('SEED: a blank Y.Doc is populated into the six structural roots, and marked seeded', async () => {
    const { space, id } = await makeTablePage('Table Seed');
    try {
      const ydoc = new Y.Doc();
      await collab.bindState(id, ydoc);

      const roots = collab.tableRoots(ydoc);
      expect(roots.columns.length).toBe(5);
      expect(roots.rows.length).toBe(3);
      expect(roots.views.length).toBe(1);
      expect(roots.head.toString()).toContain('# Weekly Plan');
      expect(roots.tail.toString()).toContain('Trailing prose');
      expect(roots.meta.get('id')).toBe(id);
      expect(collab.isTableYDocSeeded(ydoc)).toBe(true);

      // longtext cells are Y.Text (character-mergeable), scalars are plain values.
      expect(roots.rows.get(0).get('goal')).toBeInstanceOf(Y.Text);
      expect(roots.rows.get(0).get('done')).toBe(false);

      // ...and the whole thing materializes back to exactly the file's doc.
      expect(collab.tableDocFromYDoc(ydoc)).toEqual(fixtureDoc(id));

      // The first-ever bind stores a snapshot immediately (the restart window closes here).
      expect(await collab.loadSnapshot(id)).toBeDefined();
    } finally {
      await deleteTestSpace(space);
    }
  });

  it('RESTART: a client holding the table across a restart does not get its rows doubled', async () => {
    const { space, id } = await makeTablePage('Table Doubling');
    try {
      const beforeRestart = new Y.Doc();
      await collab.bindState(id, beforeRestart);
      const client = fork(beforeRestart);

      // Server restarts: brand new empty Y.Doc for the same room.
      const afterRestart = new Y.Doc();
      await collab.bindState(id, afterRestart);

      sync(afterRestart, client);

      expect(collab.tableDocFromYDoc(afterRestart).rows).toHaveLength(3);
      expect(collab.tableDocFromYDoc(client).rows).toHaveLength(3);
      expect(collab.tableDocFromYDoc(afterRestart).columns).toHaveLength(5);
      expect(collab.tableDocFromYDoc(afterRestart).head).toBe(fixtureDoc(id).head); // not head+head
    } finally {
      await deleteTestSpace(space);
    }
  });

  it('RECONCILE: an external one-cell edit is applied by key; every other row emits ZERO operations', async () => {
    const { space, id, absPath } = await makeTablePage('Table Reconcile Cell');
    try {
      const first = new Y.Doc();
      await collab.bindState(id, first);

      // Server "down": the file is edited externally (git pull / another tool).
      const onDisk = await readFile(absPath);
      onDisk.rows[1].values.owner = 'externally-changed';
      await fs.writeFile(absPath, serializeTableFile(onDisk), 'utf8');

      const afterRestart = new Y.Doc();
      await collab.bindState(id, afterRestart);

      // Watch what a connected collaborator would see from here on.
      const touched: string[] = [];
      collab.tableRoots(afterRestart).rows.observeDeep((events) => {
        for (const e of events) {
          const t = e.target as Y.Map<unknown>;
          if (typeof (t as { get?: unknown }).get === 'function') touched.push(String(t.get('id') ?? '?'));
        }
      });
      // A second bind of the SAME (already-reconciled) doc against the SAME
      // file must be a complete no-op — this is the "no spurious diff" property.
      await collab.bindState(id, afterRestart);
      expect(touched).toEqual([]);

      const doc = collab.tableDocFromYDoc(afterRestart);
      expect(rowById(doc, 'r0000002').values.owner).toBe('externally-changed');
      expect(rowById(doc, 'r0000001').values.owner).toBe('sk'); // untouched
      expect(rowById(doc, 'r0000003').values.owner).toBe('sk');
    } finally {
      await deleteTestSpace(space);
    }
  });

  it('RECONCILE: an external row REORDER is a permutation — the moved row produces NO value diff, unmoved rows are not touched at all', async () => {
    const { space, id, absPath } = await makeTablePage('Table Reconcile Order');
    try {
      const ydoc = new Y.Doc();
      await collab.bindState(id, ydoc);

      // Remember the identity of the two rows that do NOT move.
      const roots = collab.tableRoots(ydoc);
      const untouched1 = roots.rows.get(0);
      const untouched2 = roots.rows.get(1);

      // Every observed VALUE change from here on — what a collaborator sees.
      const valueChanges: string[] = [];
      roots.rows.observeDeep((events) => {
        for (const e of events) {
          if (e instanceof Y.YMapEvent) {
            for (const key of e.keysChanged) valueChanges.push(`${String((e.target as Y.Map<unknown>).get('id'))}.${key}`);
          }
        }
      });

      // The file is reordered externally: r0000003 moves to the front. No
      // row's id or values change — only their order.
      const onDisk = await readFile(absPath);
      onDisk.rows = [onDisk.rows[2], onDisk.rows[0], onDisk.rows[1]];
      await fs.writeFile(absPath, serializeTableFile(onDisk), 'utf8');

      // The server rebinds the SAME live doc (a reconnect / rescan), which is
      // when reconciliation runs against the changed file.
      await collab.bindState(id, ydoc);

      const doc = collab.tableDocFromYDoc(ydoc);
      expect(doc.rows.map((r) => r.id)).toEqual(['r0000003', 'r0000001', 'r0000002']);
      // THE ASSERTION THIS TEST EXISTS FOR: not one cell value was reported as
      // changed. A position-based reconcile would have rewritten all three rows.
      expect(valueChanges).toEqual([]);
      // And the two rows that did not move kept their exact CRDT identity —
      // any concurrent edit in flight on them still merges.
      expect(collab.tableRoots(ydoc).rows.get(1)).toBe(untouched1);
      expect(collab.tableRoots(ydoc).rows.get(2)).toBe(untouched2);
      // Values are all still correct, matched by id and not shifted by one.
      expect(rowById(doc, 'r0000001').values.owner).toBe('sk');
      expect(rowById(doc, 'r0000002').values.owner).toBe('va');
      expect(rowById(doc, 'r0000003').values.status).toBe('DONE');
    } finally {
      await deleteTestSpace(space);
    }
  });

  it('RECONCILE: a row inserted at the TOP of the file shifts nobody — matching is by id, not by position', async () => {
    const { space, id, absPath } = await makeTablePage('Table Reconcile Insert');
    try {
      const ydoc = new Y.Doc();
      await collab.bindState(id, ydoc);

      const onDisk = await readFile(absPath);
      onDisk.rows.unshift(row('r0000000', 'W7', 'newbie', 'Brand new row', false, 'TODO'));
      await fs.writeFile(absPath, serializeTableFile(onDisk), 'utf8');

      await collab.bindState(id, ydoc);

      const doc = collab.tableDocFromYDoc(ydoc);
      expect(doc.rows.map((r) => r.id)).toEqual(['r0000000', 'r0000001', 'r0000002', 'r0000003']);
      // The classic position-matching bug: every row's data slides down by one.
      expect(rowById(doc, 'r0000001').values.owner).toBe('sk');
      expect(rowById(doc, 'r0000002').values.owner).toBe('va');
      expect(rowById(doc, 'r0000003').values.owner).toBe('sk');
      expect(rowById(doc, 'r0000000').values.owner).toBe('newbie');
    } finally {
      await deleteTestSpace(space);
    }
  });

  it('RECONCILE: columns and views are matched by id too — a renamed column keeps its cell data', async () => {
    const { space, id, absPath } = await makeTablePage('Table Reconcile Columns');
    try {
      const ydoc = new Y.Doc();
      await collab.bindState(id, ydoc);

      const onDisk = await readFile(absPath);
      onDisk.columns[1] = { ...onDisk.columns[1], name: 'Responsible' }; // same id, new display name
      onDisk.columns = [onDisk.columns[1], onDisk.columns[0], ...onDisk.columns.slice(2)]; // and reordered
      onDisk.views.push({
        id: 'mine',
        name: 'Mine',
        columns: { hidden: [], order: [], width: {} },
        sort: [],
        filter: { op: 'and', rules: [] },
        frozen: 0,
        rowHeight: 'short',
      });
      await fs.writeFile(absPath, serializeTableFile(onDisk), 'utf8');

      await collab.bindState(id, ydoc);

      const doc = collab.tableDocFromYDoc(ydoc);
      expect(doc.columns.map((c) => c.id)).toEqual(['owner', 'week', 'goal', 'done', 'status']);
      expect(doc.columns.find((c) => c.id === 'owner')!.name).toBe('Responsible');
      expect(rowById(doc, 'r0000001').values.owner).toBe('sk'); // data followed the id, not the position
      expect(doc.views.map((v) => v.id)).toEqual(['all', 'mine']);
    } finally {
      await deleteTestSpace(space);
    }
  });

  it('RECONCILE: a row deleted from the file wins over the live doc', async () => {
    const { space, id, absPath } = await makeTablePage('Table Reconcile Delete');
    try {
      const ydoc = new Y.Doc();
      await collab.bindState(id, ydoc);

      const onDisk = await readFile(absPath);
      onDisk.rows = onDisk.rows.filter((r) => r.id !== 'r0000002');
      await fs.writeFile(absPath, serializeTableFile(onDisk), 'utf8');

      await collab.bindState(id, ydoc);
      expect(collab.tableDocFromYDoc(ydoc).rows.map((r) => r.id)).toEqual(['r0000001', 'r0000003']);
    } finally {
      await deleteTestSpace(space);
    }
  });

  it('SEATBELT (a): a Y.Doc that was never seeded cannot overwrite the file', async () => {
    const { space, id, absPath } = await makeTablePage('Table Seatbelt Unseeded');
    try {
      const before = await fs.readFile(absPath, 'utf8');
      // Deliberately shaped so that ONLY guard (a) can refuse it: it has MORE
      // rows than the file (so the shrink guard (d) can't fire) and a full
      // schema (so the blank guard (e) can't either) — it is simply a Y.Doc
      // that never went through a completed seed.
      const rogue = new Y.Doc();
      const extra = fixtureDoc(id);
      extra.rows.push(row('r0000009', 'W9', 'rogue', 'Never seeded', false, 'TODO'));
      rogue.transact(() => collab.seedTableYDoc(rogue, extra));
      expect(collab.isTableYDocSeeded(rogue)).toBe(false);

      await collab.persistDoc(id, rogue);
      expect(await fs.readFile(absPath, 'utf8')).toBe(before);
    } finally {
      await deleteTestSpace(space);
    }
  });

  it("SEATBELT (b): a doc whose table id doesn't match the file's cannot overwrite it", async () => {
    const { space, id, absPath } = await makeTablePage('Table Seatbelt Id');
    try {
      const before = await fs.readFile(absPath, 'utf8');
      const wrong = seededYDoc(fixtureDoc('01someothertableid'));
      await collab.persistDoc(id, wrong);
      expect(await fs.readFile(absPath, 'utf8')).toBe(before);
    } finally {
      await deleteTestSpace(space);
    }
  });

  it('SEATBELT (d): an unconfirmed-seeded doc with fewer rows than the file is refused', async () => {
    const { space, id, absPath } = await makeTablePage('Table Seatbelt Shrink');
    try {
      const before = await fs.readFile(absPath, 'utf8');
      const partial = seededYDoc({ ...fixtureDoc(id), rows: [row('r0000001', 'W8', 'sk', 'Ship the thing', false, 'TODO')] });
      expect(collab.isDocSeeded(id)).toBe(false); // never went through ensureDocSeeded
      await collab.persistDoc(id, partial);
      expect(await fs.readFile(absPath, 'utf8')).toBe(before);
    } finally {
      await deleteTestSpace(space);
    }
  });

  it('SEATBELT (e): a doc with neither rows nor columns is refused even though it IS marked seeded', async () => {
    const { space, id, absPath } = await makeTablePage('Table Seatbelt Blank');
    try {
      const before = await fs.readFile(absPath, 'utf8');
      const blank = seededYDoc({ ...fixtureDoc(id), rows: [], columns: [] });
      expect(collab.isTableYDocSeeded(blank)).toBe(true);
      await collab.persistDoc(id, blank);
      expect(await fs.readFile(absPath, 'utf8')).toBe(before);
    } finally {
      await deleteTestSpace(space);
    }
  });

  it('SEATBELT: an unparseable table file leaves the doc unseeded, and the broken file is never overwritten', async () => {
    const { space, id, absPath } = await makeTablePage('Table Seatbelt Broken');
    try {
      const broken = '---\nfolio: table\nversion: 1\nid: ' + id + '\ncolumns: []\n---\n\n# Broken\n\nno markers here at all\n';
      await fs.writeFile(absPath, broken, 'utf8');

      const ydoc = new Y.Doc();
      await collab.bindState(id, ydoc);
      expect(collab.isTableYDocSeeded(ydoc)).toBe(false);
      expect(collab.tableRoots(ydoc).rows.length).toBe(0); // nothing invented from a file we can't read

      await collab.persistDoc(id, ydoc);
      expect(await fs.readFile(absPath, 'utf8')).toBe(broken); // byte-identical
    } finally {
      await deleteTestSpace(space);
    }
  });

  it('WRITE-BACK: a seeded doc\'s edits reach the file through serializeTableFile, and a no-op change does not rewrite it', async () => {
    const { space, id, absPath } = await makeTablePage('Table Write Back');
    try {
      const ydoc = new Y.Doc();
      await collab.bindState(id, ydoc);

      ydoc.transact(() => collab.tableRoots(ydoc).rows.get(0).set('owner', 'persisted'));
      await collab.persistDoc(id, ydoc);
      expect((await readFile(absPath)).rows[0].values.owner).toBe('persisted');

      // A write that changes the CRDT but not the serialization must not touch the file.
      const stat = await fs.stat(absPath);
      ydoc.transact(() => collab.tableRoots(ydoc).rows.get(0).set('a-column-that-does-not-exist', 'orphan'));
      await collab.persistDoc(id, ydoc);
      expect((await fs.stat(absPath)).mtimeMs).toBe(stat.mtimeMs);
      expect(await fs.readFile(absPath, 'utf8')).not.toContain('orphan');
    } finally {
      await deleteTestSpace(space);
    }
  });

  it("WRITE-BACK: a head with its trailing newline deleted is normalized, so the file still parses", async () => {
    const { space, id, absPath } = await makeTablePage('Table Head Newline');
    try {
      const ydoc = new Y.Doc();
      await collab.bindState(id, ydoc);

      const head = collab.tableRoots(ydoc).head;
      ydoc.transact(() => head.delete(head.length - 2, 2)); // strip the blank line before the marker
      expect(head.toString().endsWith('\n')).toBe(false);

      await collab.persistDoc(id, ydoc);
      const reparsed = parseTableFile(await fs.readFile(absPath, 'utf8'));
      expect(isTableParseError(reparsed)).toBe(false); // would be "expected exactly one begin marker" without the fix
    } finally {
      await deleteTestSpace(space);
    }
  });

  it('doc-kind pages are completely unaffected by the table branches', async () => {
    const space = await storage.createSpace(`Doc Kind Untouched ${Date.now()}`, null);
    try {
      const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Plain Doc', kind: 'doc' });
      await storage.writeDocBody(page.id, '# Plain Doc\n\nOriginal body.\n');

      const ydoc = new Y.Doc();
      await collab.bindState(page.id, ydoc);
      expect(ydoc.getText('content').toString()).toBe('# Plain Doc\n\nOriginal body.\n');
      expect(collab.tableRoots(ydoc).rows.length).toBe(0); // no table roots ever populated

      ydoc.transact(() => ydoc.getText('content').insert(ydoc.getText('content').length, '\nAppended.\n'));
      await collab.persistDoc(page.id, ydoc);
      expect(await storage.readFreshDocBody(page.id)).toContain('Appended.');
    } finally {
      await deleteTestSpace(space.slug);
    }
  });
});

// ===========================================================================
// 3. editTableDoc / getLiveTable / applyH1Rename — the exported API surface
// ===========================================================================

describe('table collab API (editTableDoc, getLiveTable, applyH1Rename)', () => {
  let teardownSchema: () => Promise<void>;
  let liveDocs: Map<string, Y.Doc>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const { createRequire } = await import('node:module');
    const nodeRequire = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    liveDocs = (nodeRequire('y-websocket/bin/utils') as { docs: Map<string, Y.Doc> }).docs;
  });
  afterAll(async () => {
    await teardownSchema();
  });

  async function makeLiveTable(label: string): Promise<{ space: string; id: string; ydoc: Y.Doc; absPath: string }> {
    const space = await storage.createSpace(`${label} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, null);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Weekly Plan', kind: 'table', columns: COLUMNS });
    await storage.writeTableDoc(page.id, fixtureDoc(page.id));
    const ydoc = new Y.Doc();
    await collab.bindState(page.id, ydoc);
    liveDocs.set(page.id, ydoc);
    const entry = await storage.requireEntry(page.id);
    return { space: space.slug, id: page.id, ydoc, absPath: entry.absPath };
  }

  it('editTableDoc applies the REST (`type`) patch vocabulary', async () => {
    const { space, id } = await makeLiveTable('Api Rest Patch');
    try {
      const after = await collab.editTableDoc(id, [
        { type: 'insertRows', rows: [row('r0000004', 'W9', 'zz', 'New via REST', false, 'TODO')] },
        { type: 'updateRows', rowIds: ['r0000001', 'r0000002'], values: { status: 'DONE' } },
        { type: 'deleteRows', rowIds: ['r0000003'] },
      ]);
      expect(after.rows.map((r) => r.id)).toEqual(['r0000001', 'r0000002', 'r0000004']);
      expect(rowById(after, 'r0000001').values.status).toBe('DONE');
      expect(rowById(after, 'r0000002').values.status).toBe('DONE');
      expect(rowById(after, 'r0000004').values.owner).toBe('zz');
    } finally {
      liveDocs.delete(id);
      await deleteTestSpace(space);
    }
  });

  it('editTableDoc applies the grid (`kind`) patch vocabulary, including positional insert and move', async () => {
    const { space, id } = await makeLiveTable('Api Grid Patch');
    try {
      const after = await collab.editTableDoc(id, [
        { kind: 'rows:create', at: 0, rows: [row('r0000000', 'W7', 'first', 'Inserted at the top', false, 'TODO')] },
        { kind: 'rows:update', rows: [{ id: 'r0000002', values: { owner: 'patched' } }] },
        { kind: 'rows:move', id: 'r0000003', to: 0 },
      ]);
      expect(after.rows.map((r) => r.id)).toEqual(['r0000003', 'r0000000', 'r0000001', 'r0000002']);
      expect(rowById(after, 'r0000002').values.owner).toBe('patched');
      expect(rowById(after, 'r0000003').values.status).toBe('DONE'); // the moved row kept its values
    } finally {
      liveDocs.delete(id);
      await deleteTestSpace(space);
    }
  });

  it('editTableDoc: a whole-collection replace still keeps surviving ids\' CRDT identity', async () => {
    const { space, id, ydoc } = await makeLiveTable('Api Replace');
    try {
      const survivor = collab.tableRoots(ydoc).rows.get(0);
      await collab.editTableDoc(id, {
        type: 'replaceRows',
        rows: [row('r0000001', 'W8', 'sk', 'Ship the thing', false, 'TODO'), row('r000000x', 'W9', 'new', 'Fresh', false, 'TODO')],
      });
      const roots = collab.tableRoots(ydoc);
      expect(roots.rows.toArray().map((m) => m.get('id'))).toEqual(['r0000001', 'r000000x']);
      expect(roots.rows.get(0)).toBe(survivor); // untouched, not deleted-and-recreated
    } finally {
      liveDocs.delete(id);
      await deleteTestSpace(space);
    }
  });

  it('editTableDoc: a column type change folds schema + re-derived values into ONE transaction', async () => {
    const { space, id, ydoc } = await makeLiveTable('Api Column Type');
    try {
      let transactions = 0;
      ydoc.on('afterTransaction', () => transactions++);
      const after = await collab.editTableDoc(id, {
        type: 'updateColumn',
        columnId: 'owner',
        column: { type: 'select', options: [{ value: 'sk', color: 'blue' }, { value: 'va', color: 'green' }] },
        rowValues: { r0000001: 'sk', r0000002: 'va', r0000003: 'sk' },
      });
      expect(transactions).toBe(1);
      expect(after.columns.find((c) => c.id === 'owner')!.type).toBe('select');
      expect(rowById(after, 'r0000002').values.owner).toBe('va');
    } finally {
      liveDocs.delete(id);
      await deleteTestSpace(space);
    }
  });

  it('editTableDoc: an edit whose target was concurrently deleted dissolves instead of erroring', async () => {
    const { space, id } = await makeLiveTable('Api Dissolve');
    try {
      await collab.editTableDoc(id, { type: 'deleteRows', rowIds: ['r0000002'] });
      const after = await collab.editTableDoc(id, { type: 'updateRows', rowIds: ['r0000002'], values: { owner: 'ghost' } });
      expect(after.rows.map((r) => r.id)).toEqual(['r0000001', 'r0000003']);
      expect(JSON.stringify(after)).not.toContain('ghost');
    } finally {
      liveDocs.delete(id);
      await deleteTestSpace(space);
    }
  });

  it('editTableDoc: spec §5 — the last view cannot be deleted through the CRDT either', async () => {
    const { space, id } = await makeLiveTable('Api Last View');
    try {
      const after = await collab.editTableDoc(id, { type: 'deleteView', viewId: 'all' });
      expect(after.views.map((v) => v.id)).toEqual(['all']);
    } finally {
      liveDocs.delete(id);
      await deleteTestSpace(space);
    }
  });

  it('editTableDoc throws when there is no live room, so a caller can never think a write landed', async () => {
    await expect(collab.editTableDoc('01no-such-page', { type: 'deleteRows', rowIds: [] })).rejects.toThrow(/no live collab room/);
  });

  it('isLiveTable / getLiveTable reflect the live structural doc', async () => {
    const { space, id, ydoc } = await makeLiveTable('Api Live Read');
    try {
      expect(collab.isLiveTable(id)).toBe(true);
      expect(collab.getLiveTable(id)).toEqual(fixtureDoc(id));
      ydoc.transact(() => collab.tableRoots(ydoc).rows.get(0).set('owner', 'live'));
      expect(rowById(collab.getLiveTable(id)!, 'r0000001').values.owner).toBe('live');
      expect(collab.isLiveTable('01no-such-page')).toBe(false);
      expect(collab.getLiveTable('01no-such-page')).toBeUndefined();
    } finally {
      liveDocs.delete(id);
      await deleteTestSpace(space);
    }
  });

  it('applyH1Rename rewrites the H1 inside `head`, leaving rows and the prose around it alone', async () => {
    const { space, id, ydoc, absPath } = await makeLiveTable('Api Rename');
    try {
      expect(await collab.applyH1Rename(id, 'Renamed Plan')).toBe(true);

      const head = collab.tableRoots(ydoc).head.toString();
      expect(head).toContain('# Renamed Plan');
      expect(head).toContain('Intro prose.'); // surrounding prose untouched
      expect(collab.getLiveTable(id)!.rows).toHaveLength(3);
      expect((await storage.requireEntry(id)).title).toBe('Renamed Plan'); // index patched immediately

      await collab.persistDoc(id, ydoc);
      expect(await fs.readFile(absPath, 'utf8')).toContain('# Renamed Plan');
    } finally {
      liveDocs.delete(id);
      await deleteTestSpace(space);
    }
  });
});

// ===========================================================================
// 3b. SERVER <-> CLIENT STRUCTURE PARITY
//
// server/collab.ts and web/src/tables/collab/ydoc.ts each describe the same
// six-root Y.Doc, in two files, because the server module can't run in a
// browser and shared/tables/** belongs to another agent this round. That
// duplication is the single most dangerous thing about this design: if the
// two layouts drift, the server and the browser read each other's CRDT as
// garbage, and the failure is silent.
//
// These tests are the guard. They seed with one side and read with the other,
// in BOTH directions, and merge real updates across the boundary — so any
// divergence in root names, cell encoding, or nesting fails here rather than
// in production. (The client module is pure Yjs + zod; it imports no DOM, so
// a server-side test can load it directly.)
// ===========================================================================

describe('server <-> client Y.Doc structure parity', () => {
  it('a doc seeded by the SERVER reads correctly through the CLIENT module', async () => {
    const client = await import('../web/src/tables/collab/ydoc.js');
    const original = fixtureDoc();
    const ydoc = seededYDoc(original); // seeded with server/collab.ts's builders

    expect(client.isTableYDocSeeded(ydoc)).toBe(true);
    expect(client.tableDocFromYDoc(ydoc)).toEqual(original);
  });

  it('a doc seeded by the CLIENT reads correctly through the SERVER module', async () => {
    const client = await import('../web/src/tables/collab/ydoc.js');
    const original = fixtureDoc();
    const ydoc = new Y.Doc();
    ydoc.transact(() => {
      client.seedTableYDoc(ydoc, original);
      client.tableRoots(ydoc).meta.set('seeded', true);
    });

    expect(collab.isTableYDocSeeded(ydoc)).toBe(true);
    expect(collab.tableDocFromYDoc(ydoc)).toEqual(original);
  });

  it('a client patch and a server patch merge into one consistent table', async () => {
    const client = await import('../web/src/tables/collab/ydoc.js');
    const base = seededYDoc();
    const browser = fork(base);
    const server = fork(base);

    // Browser edits through the grid vocabulary...
    client.applyTablePatches(browser, [
      { kind: 'rows:update', rows: [{ id: 'r0000001', values: { owner: 'from-browser' } }] },
      { kind: 'rows:create', at: 0, rows: [row('r000000c', 'W9', 'client-row', 'Added in the browser', false, 'TODO')] },
    ]);
    // ...while the server applies a REST patch to the same room.
    server.transact(() => {
      const roots = collab.tableRoots(server);
      roots.rows.get(1).set('status', 'DONE');
    }, 'server');

    sync(browser, server);

    const viaClient = client.tableDocFromYDoc(browser);
    const viaServer = collab.tableDocFromYDoc(server);
    expect(viaClient).toEqual(viaServer); // both modules see the identical table
    expect(rowById(viaServer, 'r0000001').values.owner).toBe('from-browser');
    expect(rowById(viaServer, 'r0000002').values.status).toBe('DONE');
    expect(rowById(viaServer, 'r000000c').values.owner).toBe('client-row');

    // ...and it serializes to a valid file.
    const reparsed = parseTableFile(serializeTableFile(viaServer));
    expect(isTableParseError(reparsed)).toBe(false);
  });

  it('both modules agree on the root names and the transaction origins', async () => {
    const client = await import('../web/src/tables/collab/ydoc.js');
    const ydoc = seededYDoc();
    const s = collab.tableRoots(ydoc);
    const c = client.tableRoots(ydoc);
    // Same underlying Y types, not merely equal-looking ones.
    expect(c.meta).toBe(s.meta);
    expect(c.head).toBe(s.head);
    expect(c.tail).toBe(s.tail);
    expect(c.columns).toBe(s.columns);
    expect(c.rows).toBe(s.rows);
    expect(c.views).toBe(s.views);
    // The client's undo stack must not track the server's reconcile origin.
    expect(client.TABLE_LOCAL_ORIGIN).not.toBe(collab.TABLE_SEED_ORIGIN);
    expect(client.TABLE_LOCAL_ORIGIN).not.toBe(collab.TABLE_EDIT_ORIGIN);
  });
});

// ===========================================================================
// 4. REAL WEBSOCKETS — spec §6.2/§17.6 evidence
// ===========================================================================

function waitSynced(provider: WebsocketProvider, timeoutMs = 10_000): Promise<void> {
  if (provider.synced) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sync timeout')), timeoutMs);
    const onSync = (isSynced: boolean) => {
      if (isSynced) {
        clearTimeout(t);
        provider.off('sync', onSync);
        resolve();
      }
    };
    provider.on('sync', onSync);
  });
}

async function pollUntil(check: () => Promise<boolean> | boolean, timeoutMs = 15_000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil: condition not met within ${timeoutMs}ms`);
}

/**
 * y-websocket constructs `new WebSocketPolyfill(url)` with no options, so a
 * cookie session can only be attached by wrapping the ws client class — the
 * same trick a browser gets for free by sending its own cookie jar.
 */
function cookieWs(token: string): typeof globalThis.WebSocket {
  return class extends WS {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, { headers: { Cookie: `folio_session=${token}` } });
    }
  } as unknown as typeof globalThis.WebSocket;
}

describe('LIVE table editing over real websockets (spec §6.2 / §17.6)', () => {
  let teardownSchema: () => Promise<void>;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    collab.initCollab();
    server = http.createServer();
    collab.attachToServer(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await teardownSchema();
  });

  it('three logged-in clients and one anonymous share-link guest edit the same table at once', async () => {
    const owner = await authStore.createUser({ email: `t-owner-${Date.now()}@collab-test.local`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Live Table ${Date.now()}`, owner.id);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Weekly Plan', kind: 'table', columns: COLUMNS });
    await storage.writeTableDoc(page.id, fixtureDoc(page.id));

    const users = [owner];
    for (const name of ['Bea', 'Cy']) {
      const u = await authStore.createUser({ email: `t-${name}-${Date.now()}@collab-test.local`, name, passwordHash: 'x', isAdmin: false });
      users.push(u);
    }
    for (const u of users) await authStore.setMembership(space.slug, u.id, 'editor');
    const tokens = await Promise.all(users.map((u) => authStore.createSession(u.id)));

    const shareLink = await shares.createShareLink(page.id, owner.id, 'edit', 'http://fallback.test');
    const shareToken = shareLink.url.split('/share/')[1];

    const providers: WebsocketProvider[] = [];
    try {
      // --- three cookie-authenticated clients ------------------------------
      const clients = tokens.map((t) => {
        const doc = new Y.Doc();
        const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, page.id, doc, {
          WebSocketPolyfill: cookieWs(t.token),
          connect: true,
          disableBc: true,
        });
        providers.push(provider);
        return { doc, provider };
      });
      // --- plus one anonymous guest on a share link ------------------------
      const guestDoc = new Y.Doc();
      const guestProvider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, page.id, guestDoc, {
        params: { share: shareToken },
        WebSocketPolyfill: WS as unknown as typeof globalThis.WebSocket,
        connect: true,
        disableBc: true,
      });
      providers.push(guestProvider);
      const guest = { doc: guestDoc, provider: guestProvider };
      const all = [...clients, guest];

      await Promise.all(all.map((c) => waitSynced(c.provider)));

      // Every client received the REAL table over the wire — empty local docs,
      // exact equality (the round-8 P0 lesson: never assert with pre-seeded text).
      for (const c of all) {
        await pollUntil(() => collab.tableRoots(c.doc).rows.length === 3);
        expect(collab.tableDocFromYDoc(c.doc)).toEqual(fixtureDoc(page.id));
      }

      // --- all four edit AT THE SAME TIME ---------------------------------
      clients[0].doc.transact(() => collab.tableRoots(clients[0].doc).rows.get(0).set('owner', 'by-alice'), 'local');
      clients[1].doc.transact(() => collab.tableRoots(clients[1].doc).rows.get(1).set('status', 'DONE'), 'local');
      clients[2].doc.transact(() => {
        const t = collab.tableRoots(clients[2].doc).rows.get(2).get('goal') as Y.Text;
        t.insert(t.length, ' + carol was here');
      }, 'local');
      guest.doc.transact(() => {
        const rows = collab.tableRoots(guest.doc).rows;
        rows.push([buildRowLike('r000000g', 'by-guest')]);
      }, 'local');

      // Every client converges on all four edits, over the socket.
      for (const c of all) {
        await pollUntil(() => {
          const d = collab.tableDocFromYDoc(c.doc);
          return (
            d.rows.length === 4 &&
            d.rows[0].values.owner === 'by-alice' &&
            d.rows[1].values.status === 'DONE' &&
            String(d.rows[2].values.goal ?? '').includes('carol was here') &&
            d.rows.some((r) => r.id === 'r000000g')
          );
        });
      }
      const converged = collab.tableDocFromYDoc(clients[0].doc);
      for (const c of all) expect(collab.tableDocFromYDoc(c.doc)).toEqual(converged);

      // ...and the debounced write-back put all of it in the real file.
      const entry = await storage.requireEntry(page.id);
      await pollUntil(async () => (await fs.readFile(entry.absPath, 'utf8')).includes('by-guest'));
      const parsed = parseTableFile(await fs.readFile(entry.absPath, 'utf8'));
      expect(isTableParseError(parsed)).toBe(false);
      if (!isTableParseError(parsed)) {
        expect(parsed.rows).toHaveLength(4);
        expect(rowById(parsed, 'r0000001').values.owner).toBe('by-alice');
        expect(rowById(parsed, 'r0000002').values.status).toBe('DONE');
        expect(String(rowById(parsed, 'r0000003').values.goal)).toContain('carol was here');
        expect(rowById(parsed, 'r000000g').values.owner).toBe('by-guest');
      }

      // The page went through ensureDocSeeded, so a genuine bulk delete by a
      // real (seeded) session is ALLOWED — the seatbelt targets unseeded docs,
      // not small tables.
      expect(collab.isDocSeeded(page.id)).toBe(true);
      clients[0].doc.transact(() => collab.tableRoots(clients[0].doc).rows.delete(0, 3), 'local');
      await pollUntil(async () => {
        const p = parseTableFile(await fs.readFile(entry.absPath, 'utf8'));
        return !isTableParseError(p) && p.rows.length === 1;
      });
    } finally {
      for (const p of providers) p.destroy();
      await query('DELETE FROM ydoc_state WHERE page_id = $1', [page.id]).catch(() => undefined);
      await deleteTestSpace(space.slug);
    }
  }, 60_000);

  it('a view-mode share guest can watch a table live but cannot write to it', async () => {
    const owner = await authStore.createUser({ email: `t-ro-${Date.now()}@collab-test.local`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Live Table RO ${Date.now()}`, owner.id);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Weekly Plan', kind: 'table', columns: COLUMNS });
    await storage.writeTableDoc(page.id, fixtureDoc(page.id));
    await authStore.setMembership(space.slug, owner.id, 'editor');

    const editorSession = await authStore.createSession(owner.id);
    const viewLink = await shares.createShareLink(page.id, owner.id, 'view', 'http://fallback.test');
    const viewToken = viewLink.url.split('/share/')[1];

    const providers: WebsocketProvider[] = [];
    try {
      const editorDoc = new Y.Doc();
      const editorProvider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, page.id, editorDoc, {
        WebSocketPolyfill: cookieWs(editorSession.token),
        connect: true,
        disableBc: true,
      });
      providers.push(editorProvider);
      await waitSynced(editorProvider);
      await pollUntil(() => collab.tableRoots(editorDoc).rows.length === 3);

      const viewerDoc = new Y.Doc();
      const viewerProvider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, page.id, viewerDoc, {
        params: { share: viewToken },
        WebSocketPolyfill: WS as unknown as typeof globalThis.WebSocket,
        connect: true,
        disableBc: true,
      });
      providers.push(viewerProvider);
      await waitSynced(viewerProvider);

      // Reads land...
      editorDoc.transact(() => collab.tableRoots(editorDoc).rows.get(0).set('owner', 'editor-wrote'), 'local');
      await pollUntil(() => collab.tableDocFromYDoc(viewerDoc).rows[0]?.values.owner === 'editor-wrote');

      // ...writes do not.
      viewerDoc.transact(() => collab.tableRoots(viewerDoc).rows.get(1).set('owner', 'VIEWER-SHOULD-NOT-WRITE'), 'local');
      await new Promise((r) => setTimeout(r, 600));
      expect(collab.tableDocFromYDoc(editorDoc).rows[1].values.owner).toBe('va');
    } finally {
      for (const p of providers) p.destroy();
      await query('DELETE FROM ydoc_state WHERE page_id = $1', [page.id]).catch(() => undefined);
      await deleteTestSpace(space.slug);
    }
  }, 60_000);
});
