/**
 * Round 26 (DATA TABLES) — server/tables/service.ts, the single write path.
 * Real fs + real PG (server/db/testSchema.ts), same conventions as
 * server/storage.test.ts. `collab.isDocLive(id)` is false throughout (no WS
 * connections are opened in this test file), so every write here exercises
 * the DIRECT (non-collab) branch of `applyPatch` — the collab-routed branch
 * depends on `collab.editTableDoc`, which is the documented integration gap
 * (see service.ts's module doc comment and the round report).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpTestSchema, deleteTestSpace } from '../db/testSchema.js';
import * as storage from '../storage.js';
import * as service from './service.js';
import type { TableColumn } from '../../shared/contracts.js';

describe('server/tables/service.ts (real fs + real PG)', () => {
  let teardownSchema: () => Promise<void>;
  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  const OWNER: TableColumn = { id: 'owner', name: 'Owner', type: 'text' };
  const WEEK: TableColumn = { id: 'week', name: 'Week', type: 'select', options: [{ value: 'W8', color: 'blue' }, { value: 'W9', color: 'green' }] };
  const STATUS: TableColumn = {
    id: 'status',
    name: 'Status',
    type: 'status',
    options: [
      { value: 'PLANNING', color: 'purple' },
      { value: 'IN PROG', color: 'blue' },
      { value: 'DONE', color: 'green' },
    ],
  };

  async function makeTable(title: string, columns: TableColumn[] = [OWNER, WEEK, STATUS]) {
    const space = await storage.createSpace(`${title} ${Date.now()}`, null);
    const meta = await storage.createPage({ space: space.slug, parentPath: '', title, kind: 'table', columns });
    return { spaceSlug: space.slug, pageId: meta.id };
  }

  // -------------------------------------------------------------------
  // Rows
  // -------------------------------------------------------------------

  describe('rows', () => {
    it('insertRows mints ids, fills column defaults, and persists to the file', async () => {
      const { spaceSlug, pageId } = await makeTable('Insert Rows');
      try {
        const { rows } = await service.insertRows(pageId, [
          { owner: 'alice', week: 'W8', status: 'PLANNING' },
          { owner: 'bob' }, // week/status omitted -> default (null, since these columns have no `default`)
        ]);
        expect(rows).toHaveLength(2);
        expect(rows[0].id).toMatch(/^[0-9a-z]{8}$/);
        expect(rows[1].values).toEqual({ owner: 'bob', week: null, status: null });

        const doc = await storage.readFreshTableDoc(pageId);
        expect(doc.rows).toHaveLength(2);
        expect(doc.rows.map((r) => r.values.owner)).toEqual(['alice', 'bob']);
      } finally {
        await deleteTestSpace(spaceSlug);
      }
    });

    it('updateRowCells patches only the given columns, leaving the rest untouched', async () => {
      const { spaceSlug, pageId } = await makeTable('Update Row');
      try {
        const { rows } = await service.insertRows(pageId, [{ owner: 'alice', week: 'W8', status: 'PLANNING' }]);
        const updated = await service.updateRowCells(pageId, rows[0].id, { status: 'DONE' });
        expect(updated.values).toEqual({ owner: 'alice', week: 'W8', status: 'DONE' });

        await expect(service.updateRowCells(pageId, 'no-such-row', { status: 'DONE' })).rejects.toMatchObject({ status: 404 });
      } finally {
        await deleteTestSpace(spaceSlug);
      }
    });

    it('deleteRow removes exactly that row; a missing rowId 404s', async () => {
      const { spaceSlug, pageId } = await makeTable('Delete Row');
      try {
        const { rows } = await service.insertRows(pageId, [{ owner: 'alice' }, { owner: 'bob' }]);
        await service.deleteRow(pageId, rows[0].id);
        const doc = await storage.readFreshTableDoc(pageId);
        expect(doc.rows.map((r) => r.id)).toEqual([rows[1].id]);

        await expect(service.deleteRow(pageId, rows[0].id)).rejects.toMatchObject({ status: 404 });
      } finally {
        await deleteTestSpace(spaceSlug);
      }
    });

    it('bulkRows updates or deletes several rows at once, silently ignoring unknown ids', async () => {
      const { spaceSlug, pageId } = await makeTable('Bulk Rows');
      try {
        const { rows } = await service.insertRows(pageId, [{ owner: 'a' }, { owner: 'b' }, { owner: 'c' }]);
        const updateResult = await service.bulkRows(pageId, [rows[0].id, rows[1].id, 'ghost-id'], { status: 'DONE' });
        expect(updateResult.affected).toBe(2); // "ghost-id" doesn't count

        const afterUpdate = await storage.readFreshTableDoc(pageId);
        expect(afterUpdate.rows.filter((r) => r.values.status === 'DONE')).toHaveLength(2);

        const deleteResult = await service.bulkRows(pageId, [rows[2].id]);
        expect(deleteResult.affected).toBe(1);
        const afterDelete = await storage.readFreshTableDoc(pageId);
        expect(afterDelete.rows).toHaveLength(2);
      } finally {
        await deleteTestSpace(spaceSlug);
      }
    });

    it('enforces the hard row-count limit (spec §13) instead of silently accepting an oversized insert', async () => {
      const { spaceSlug, pageId } = await makeTable('Row Limit', [OWNER]);
      try {
        // Seed the doc directly at just past the hard limit rather than really inserting
        // 20,000+ rows through the service (slow) — insertRows' OWN limit check runs
        // against `current rows + new rows`, so seeding the file directly is a faithful,
        // fast way to get it there.
        const doc = await storage.readFreshTableDoc(pageId);
        const manyRows = Array.from({ length: 20_000 }, (_, i) => ({ id: `r${String(i).padStart(7, '0')}`, values: { owner: `u${i}` } }));
        await storage.writeTableDoc(pageId, { ...doc, rows: manyRows });

        await expect(service.insertRows(pageId, [{ owner: 'one-too-many' }])).rejects.toMatchObject({ status: 400 });
      } finally {
        await deleteTestSpace(spaceSlug);
      }
    }, 20_000);
  });

  // -------------------------------------------------------------------
  // Columns
  // -------------------------------------------------------------------

  describe('columns', () => {
    it('addColumn derives a stable [a-z0-9_]{1,32} id from the name (translit), with _2 on collision', async () => {
      const { spaceSlug, pageId } = await makeTable('Add Column', [OWNER]);
      try {
        const col1 = await service.addColumn(pageId, { name: 'Start date', type: 'date' });
        expect(col1.id).toMatch(/^[a-z0-9_]{1,32}$/);
        expect(col1.id).toBe('start-date'.replace(/-/g, '_')); // translitSlug then '-' -> '_'

        const col2 = await service.addColumn(pageId, { name: 'Start date', type: 'text' }); // same name again
        expect(col2.id).not.toBe(col1.id);
        expect(col2.id.endsWith('_2')).toBe(true);

        const doc = await storage.readFreshTableDoc(pageId);
        expect(doc.columns.map((c) => c.id)).toEqual(['owner', col1.id, col2.id]);
      } finally {
        await deleteTestSpace(spaceSlug);
      }
    });

    it('updateColumn on a type change converts existing row values and reports converted/cleared counts', async () => {
      const { spaceSlug, pageId } = await makeTable('Column Type Change', [{ id: 'n', name: 'N', type: 'text' }]);
      try {
        await service.insertRows(pageId, [{ n: '42' }, { n: 'not-a-number' }, { n: null }]);
        const result = await service.updateColumn(pageId, 'n', { type: 'number' });
        expect(result.column.type).toBe('number');
        expect(result.converted).toBe(1); // "42" -> 42
        expect(result.cleared).toBe(1); // "not-a-number" -> null under `number`

        const doc = await storage.readFreshTableDoc(pageId);
        const values = doc.rows.map((r) => r.values.n);
        expect(values).toEqual([42, null, null]);
      } finally {
        await deleteTestSpace(spaceSlug);
      }
    });

    it('deleteColumn drops the column from rows AND scrubs it out of every view\'s hidden/order/sort/filter', async () => {
      const { spaceSlug, pageId } = await makeTable('Delete Column');
      try {
        await service.insertRows(pageId, [{ owner: 'a', week: 'W8', status: 'DONE' }]);
        await service.addView(pageId, {
          name: 'By status',
          columns: { hidden: ['week'], order: ['status', 'week', 'owner'], width: {} },
          sort: [{ column: 'week', dir: 'asc' }],
          filter: { op: 'and', rules: [{ column: 'week', operator: 'is', value: 'W8' }] },
          frozen: 0,
          rowHeight: 'short',
        });

        await service.deleteColumn(pageId, 'week');

        const doc = await storage.readFreshTableDoc(pageId);
        expect(doc.columns.map((c) => c.id)).toEqual(['owner', 'status']);
        expect(doc.rows[0].values).not.toHaveProperty('week');
        const view = doc.views.find((v) => v.name === 'By status')!;
        expect(view.columns.hidden).not.toContain('week');
        expect(view.columns.order).not.toContain('week');
        expect(view.sort.some((s) => s.column === 'week')).toBe(false);
        expect(view.filter.rules.some((r) => r.column === 'week')).toBe(false);
      } finally {
        await deleteTestSpace(spaceSlug);
      }
    });
  });

  // -------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------

  describe('views', () => {
    it('deleteView refuses to delete the last remaining view (spec §5)', async () => {
      const { spaceSlug, pageId } = await makeTable('Last View');
      try {
        const doc = await storage.readFreshTableDoc(pageId);
        expect(doc.views).toHaveLength(1); // the auto-created default view
        await expect(service.deleteView(pageId, doc.views[0].id)).rejects.toMatchObject({ status: 400 });
      } finally {
        await deleteTestSpace(spaceSlug);
      }
    });

    it('addView + deleteView works once there is more than one view', async () => {
      const { spaceSlug, pageId } = await makeTable('Two Views');
      try {
        const extra = await service.addView(pageId, { name: 'Second view', columns: { hidden: [], order: [], width: {} }, sort: [], filter: { op: 'and', rules: [] }, frozen: 0, rowHeight: 'short' });
        const doc = await storage.readFreshTableDoc(pageId);
        const firstViewId = doc.views.find((v) => v.id !== extra.id)!.id;
        await service.deleteView(pageId, firstViewId);
        const after = await storage.readFreshTableDoc(pageId);
        expect(after.views.map((v) => v.id)).toEqual([extra.id]);
      } finally {
        await deleteTestSpace(spaceSlug);
      }
    });
  });

  // -------------------------------------------------------------------
  // Query (filter/sort/search/view) — thin wrapper over shared/tables/query.ts,
  // this just proves the plumbing (view resolution, pagination) is correct;
  // the filter/sort semantics themselves are shared/tables/query.test.ts's job.
  // -------------------------------------------------------------------

  describe('queryRows', () => {
    it('applies a view\'s filter/sort, supports overriding q/limit/offset, and reports total vs page size', async () => {
      const { spaceSlug, pageId } = await makeTable('Query Rows');
      try {
        await service.insertRows(pageId, [
          { owner: 'alice', week: 'W9', status: 'DONE' },
          { owner: 'bob', week: 'W8', status: 'PLANNING' },
          { owner: 'carol', week: 'W8', status: 'IN PROG' },
        ]);
        const view = await service.addView(pageId, {
          name: 'W8 only',
          columns: { hidden: [], order: [], width: {} },
          sort: [{ column: 'owner', dir: 'asc' }],
          filter: { op: 'and', rules: [{ column: 'week', operator: 'is', value: 'W8' }] },
          frozen: 0,
          rowHeight: 'short',
        });

        const result = await service.queryRows(pageId, { view: view.id });
        expect(result.rows.map((r) => r.values.owner)).toEqual(['bob', 'carol']); // filtered + sorted by view
        expect(result.total).toBe(2);

        const searched = await service.queryRows(pageId, { view: view.id, q: 'carol' });
        expect(searched.rows.map((r) => r.values.owner)).toEqual(['carol']);

        const paged = await service.queryRows(pageId, { limit: 1, offset: 1, sort: [{ column: 'owner', dir: 'asc' }] });
        expect(paged.total).toBe(3); // total reflects the full (unpaginated) match count
        expect(paged.rows).toHaveLength(1);
        expect(paged.rows[0].values.owner).toBe('bob'); // alice, [bob], carol
      } finally {
        await deleteTestSpace(spaceSlug);
      }
    });
  });

  // -------------------------------------------------------------------
  // Export / import (spec §10)
  // -------------------------------------------------------------------

  describe('export / import', () => {
    it('exportTable(csv) renders exactly the columns/rows of the requested scope', async () => {
      const { spaceSlug, pageId } = await makeTable('Export CSV', [OWNER, WEEK]);
      try {
        await service.insertRows(pageId, [{ owner: 'alice', week: 'W8' }]);
        const result = await service.exportTable(pageId, { format: 'csv', scope: 'all' });
        expect(result.data).toContain('Owner,Week');
        expect(result.data).toContain('alice,W8');
      } finally {
        await deleteTestSpace(spaceSlug);
      }
    });

    it('export(yaml) -> import(yaml, mode:replace) round-trips a table (spec §10: byte-for-byte-equivalent structure)', async () => {
      const src = await makeTable('YAML Export Source', [OWNER, WEEK]);
      const dst = await makeTable('YAML Import Target', [OWNER]); // deliberately a DIFFERENT starting schema
      try {
        await service.insertRows(src.pageId, [{ owner: 'alice', week: 'W8' }, { owner: 'bob', week: 'W9' }]);
        const exported = await service.exportTable(src.pageId, { format: 'yaml', scope: 'all' });

        const importResult = await service.importTable(dst.pageId, { format: 'yaml', data: exported.data, mode: 'replace' });
        expect(importResult.imported).toBe(2);

        const dstDoc = await storage.readFreshTableDoc(dst.pageId);
        expect(dstDoc.columns.map((c) => c.id)).toEqual(['owner', 'week']); // schema replaced too (YAML replace)
        expect(dstDoc.rows.map((r) => r.values.owner).sort()).toEqual(['alice', 'bob']);
      } finally {
        await deleteTestSpace(src.spaceSlug);
        await deleteTestSpace(dst.spaceSlug);
      }
    });

    it('importTable(csv, mode: append) matches by header name and leaves the existing schema untouched', async () => {
      const { spaceSlug, pageId } = await makeTable('CSV Import Append', [OWNER, WEEK]);
      try {
        await service.insertRows(pageId, [{ owner: 'existing', week: 'W8' }]);
        const csv = 'Owner,Week\r\nalice,W9\r\nbob,W8\r\n';
        const result = await service.importTable(pageId, { format: 'csv', data: csv, mode: 'append' });
        expect(result.imported).toBe(2);

        const doc = await storage.readFreshTableDoc(pageId);
        expect(doc.rows).toHaveLength(3); // existing + 2 imported
        expect(doc.columns.map((c) => c.id)).toEqual(['owner', 'week']); // schema unchanged (csv import is rows-only)
      } finally {
        await deleteTestSpace(spaceSlug);
      }
    });

    it('inferImportColumns proposes types from a pasted grid without writing anything (spec §10.1)', async () => {
      const { spaceSlug, pageId } = await makeTable('Infer Preview');
      try {
        const grid = [
          ['Task', 'Status', 'Done'],
          ...Array.from({ length: 20 }, (_, i) => [`Task ${i}`, i % 2 === 0 ? 'DONE' : 'PLANNING', i % 2 === 0 ? 'x' : '']),
        ];
        const columns = service.inferImportColumns(grid);
        expect(columns.map((c) => c.type)).toEqual(['text', 'status', 'checkbox']);

        // no write happened — the table this was scoped under is untouched
        const doc = await storage.readFreshTableDoc(pageId);
        expect(doc.rows).toEqual([]);
      } finally {
        await deleteTestSpace(spaceSlug);
      }
    });
  });

  // -------------------------------------------------------------------
  // Table creation helper (used by the folio_table_create MCP tool)
  // -------------------------------------------------------------------

  describe('createTable', () => {
    it('creates a table page with the given column schema', async () => {
      const space = await storage.createSpace(`Create Table Helper ${Date.now()}`, null);
      try {
        const meta = await service.createTable(space.slug, '', 'Helper Table', [OWNER]);
        expect(meta.kind).toBe('table');
        const doc = await storage.readFreshTableDoc(meta.id);
        expect(doc.columns.map((c) => c.id)).toEqual(['owner']);
      } finally {
        await deleteTestSpace(space.slug);
      }
    });
  });
});
