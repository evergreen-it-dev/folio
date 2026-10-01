/**
 * Round FORMS — server/forms/service.ts + the paired-creation/write path in
 * server/storage.ts. Real fs + real PG (server/db/testSchema.ts), same
 * conventions as server/tables/service.test.ts and server/officePages.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpTestSchema, deleteTestSpace } from '../db/testSchema.js';
import * as storage from '../storage.js';
import * as tables from '../tables/service.js';
import { FormValidationError, renamePairedTableBestEffort, resolvePairedTableId, submitForm } from './service.js';
import type { TableColumn } from '../../shared/contracts.js';

describe('server/forms (real fs + real PG)', () => {
  let teardownSchema: () => Promise<void>;
  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  it('"+ → Form" creates the form AND a paired table in one shot, table nested UNDER the form', async () => {
    const space = await storage.createSpace(`Forms Create ${Date.now()}`, null);
    try {
      const meta = await storage.createPage({ space: space.slug, parentPath: '', title: 'Registration', kind: 'form' });
      expect(meta.kind).toBe('form');
      expect(meta.path).toBe('registration.form.md');

      const form = await storage.readFreshFormDoc(meta.id);
      expect(form.fields).toHaveLength(1); // sensible starter: one text column
      expect(form.public).toBe(false);
      // Nesting (owner decision): the table lives in the form's OWN child
      // directory, `<formSlug>/`, not as a sibling.
      expect(form.table).toBe('registration/registration.table.md');

      const tableId = await storage.getEntryIdByExactPath(space.slug, form.table);
      expect(tableId).toBeDefined();
      const tableEntry = await storage.requireEntry(tableId!);
      expect(tableEntry.kind).toBe('table');
      const tableDoc = await storage.readFreshTableDoc(tableId!);
      expect(tableDoc.columns.map((c) => c.id)).toEqual([form.fields[0].columnId]);

      // The tree agrees: the table shows up as the FORM's own child.
      const formEntry = await storage.requireEntry(meta.id);
      const children = await storage.getSubtree(formEntry, 1);
      expect(children.map((c) => c.id)).toEqual([tableId]);
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('"Create a form" on an existing table derives one field per column, form nested UNDER the table', async () => {
    const space = await storage.createSpace(`Forms From Table ${Date.now()}`, null);
    try {
      const columns: TableColumn[] = [
        { id: 'name', name: 'Name', type: 'text' },
        { id: 'attends', name: 'Attending', type: 'checkbox' },
      ];
      const table = await storage.createPage({ space: space.slug, parentPath: '', title: 'Event Signup', kind: 'table', columns });
      const formMeta = await storage.createFormFromTable(table.id);
      expect(formMeta.kind).toBe('form');
      // Nesting (owner decision, opposite direction from the paired-creation
      // case above): the NEW form lives in the EXISTING table's own child
      // directory, `<tableSlug>/`.
      expect(formMeta.path).toBe('event-signup/event-signup.form.md');

      const form = await storage.readFreshFormDoc(formMeta.id);
      expect(form.table).toBe('event-signup.table.md');
      expect(form.fields).toEqual([
        { columnId: 'name', label: 'Name', help: undefined, required: false, kind: 'text' },
        { columnId: 'attends', label: 'Attending', help: undefined, required: false, kind: 'checkbox' },
      ]);

      // The tree agrees: the form shows up as the TABLE's own child.
      const tableEntry = await storage.requireEntry(table.id);
      const children = await storage.getSubtree(tableEntry, 1);
      expect(children.map((c) => c.id)).toEqual([formMeta.id]);

      // Deleting the form never deletes the paired table.
      await storage.deletePage(formMeta.id);
      const tableStillThere = await storage.requireEntry(table.id);
      expect(tableStillThere.kind).toBe('table');
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('submitForm appends exactly one row with the submitted values, plus submitted_at/submitter', async () => {
    const space = await storage.createSpace(`Forms Submit ${Date.now()}`, null);
    try {
      const columns: TableColumn[] = [{ id: 'name', name: 'Name', type: 'text' }, { id: 'age', name: 'Age', type: 'number' }];
      const table = await storage.createPage({ space: space.slug, parentPath: '', title: 'Signup', kind: 'table', columns });
      const formMeta = await storage.createFormFromTable(table.id);
      // Mark the name field required, same as the "missing required field" test below expects.
      const form = await storage.readFreshFormDoc(formMeta.id);
      await storage.writeFormDoc(formMeta.id, { ...form, fields: form.fields.map((f) => (f.columnId === 'name' ? { ...f, required: true } : f)) });

      const formEntry = await storage.requireEntry(formMeta.id);
      const result = await submitForm(formEntry, 'Ivan Petrenko', { name: 'Maria', age: '30' });
      expect(result.rowId).toMatch(/^[0-9a-z]{8}$/);

      const doc = await storage.readFreshTableDoc(table.id);
      expect(doc.rows).toHaveLength(1);
      expect(doc.rows[0].values.name).toBe('Maria');
      expect(doc.rows[0].values.age).toBe(30);
      expect(doc.rows[0].values.submitter).toBe('Ivan Petrenko');
      // BUGFIX regression (owner repro: "Submitted at" rendered as an empty
      // date input after a real submit): the value must be a LOCAL
      // `YYYY-MM-DDTHH:mm:ss` string, no `Z`/milliseconds — the exact shape
      // the table model's `date, time: true` cell reads back into an
      // `<input type="datetime-local">` (see shared/forms/fields.test.ts's
      // formatSubmittedAt tests for why anything else renders empty there).
      expect(doc.rows[0].values.submitted_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

      // A second submission appends a SECOND row — never overwrites the first.
      await submitForm(formEntry, 'anonymous', { name: 'Oleh' });
      const docAfter = await storage.readFreshTableDoc(table.id);
      expect(docAfter.rows).toHaveLength(2);
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('rejects a submission missing a required field, without writing a row', async () => {
    const space = await storage.createSpace(`Forms Required ${Date.now()}`, null);
    try {
      const columns: TableColumn[] = [{ id: 'name', name: 'Name', type: 'text' }];
      const table = await storage.createPage({ space: space.slug, parentPath: '', title: 'Required Field', kind: 'table', columns });
      const formMeta = await storage.createFormFromTable(table.id);
      const form = await storage.readFreshFormDoc(formMeta.id);
      await storage.writeFormDoc(formMeta.id, { ...form, fields: form.fields.map((f) => ({ ...f, required: true })) });

      const formEntry = await storage.requireEntry(formMeta.id);
      await expect(submitForm(formEntry, 'anonymous', {})).rejects.toBeInstanceOf(FormValidationError);

      const doc = await storage.readFreshTableDoc(table.id);
      expect(doc.rows).toHaveLength(0);
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  // Owner finding #1: the «Edit form» dialog had no way to add a field.
  // web/src/app/routes/FormDefinitionEditor.tsx's "+ Add field" now creates
  // the matching column through server/tables/service.ts#addColumn (the
  // SAME writer the table's own AddColumnButton uses — never a second one)
  // and only then saves the form's own field list via storage.writeFormDoc.
  // These two calls are exactly what that save flow does server-side; this
  // pins the contract between them without needing a browser.
  it('adding a field adds the matching column to the paired table; deleting a field leaves the column in place', async () => {
    const space = await storage.createSpace(`Forms Add Field ${Date.now()}`, null);
    try {
      const columns: TableColumn[] = [{ id: 'name', name: 'Name', type: 'text' }];
      const table = await storage.createPage({ space: space.slug, parentPath: '', title: 'Add Field', kind: 'table', columns });
      const formMeta = await storage.createFormFromTable(table.id);
      const form = await storage.readFreshFormDoc(formMeta.id);
      expect(form.fields.map((f) => f.columnId)).toEqual(['name']);

      // "+ Add field" -> a Long text column, then the field is appended and saved.
      const newColumn = await tables.addColumn(table.id, { name: 'Comment', type: 'longtext' });
      await storage.writeFormDoc(formMeta.id, {
        ...form,
        fields: [...form.fields, { columnId: newColumn.id, label: 'Comment', required: false, kind: 'longtext' }],
      });

      const tableAfterAdd = await storage.readFreshTableDoc(table.id);
      expect(tableAfterAdd.columns.map((c) => c.id)).toEqual(['name', newColumn.id]);
      const formAfterAdd = await storage.readFreshFormDoc(formMeta.id);
      expect(formAfterAdd.fields.map((f) => f.columnId)).toEqual(['name', newColumn.id]);

      // Deleting the field from the form must NOT drop the table's column —
      // answers already collected in it must survive.
      await storage.writeFormDoc(formMeta.id, {
        ...formAfterAdd,
        fields: formAfterAdd.fields.filter((f) => f.columnId !== newColumn.id),
      });

      const formAfterDelete = await storage.readFreshFormDoc(formMeta.id);
      expect(formAfterDelete.fields.map((f) => f.columnId)).toEqual(['name']);
      const tableAfterDelete = await storage.readFreshTableDoc(table.id);
      expect(tableAfterDelete.columns.map((c) => c.id)).toEqual(['name', newColumn.id]); // column untouched
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  // Owner ask (22.09.2026, sidebar screenshot): renaming a form left its
  // nested table stuck showing "New form" — the default title from creation.
  // Both places a form rename lands (server/routes.ts's rename route, and
  // pageChanges.ts's undo path) call storage.renameFormDirect and then this
  // module's renamePairedTableBestEffort — mirrored here directly rather
  // than through a route, same "directly-testable module function" split
  // this module's own doc comment already uses for submitForm.
  it('renaming a form also renames its paired table title', async () => {
    const space = await storage.createSpace(`Forms Rename ${Date.now()}`, null);
    try {
      const columns: TableColumn[] = [{ id: 'name', name: 'Name', type: 'text' }];
      const table = await storage.createPage({ space: space.slug, parentPath: '', title: 'New form', kind: 'table', columns });
      const formMeta = await storage.createFormFromTable(table.id);

      await storage.renameFormDirect(formMeta.id, 'A basic survey about products');
      const formDoc = await storage.readFreshFormDoc(formMeta.id);
      const formEntry = await storage.requireEntry(formMeta.id);
      await renamePairedTableBestEffort(formEntry, formDoc.table, 'A basic survey about products');

      const tableAfter = await storage.requireEntry(table.id);
      expect(tableAfter.title).toBe('A basic survey about products');
      // The table's FILE/slug never moves — only its title (H1) changes, so
      // the form's `table` frontmatter reference stays valid.
      expect(tableAfter.relPath).toBe(table.path);
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  // Owner report (22.09.2026, second round: "I renamed it and nothing happened"). The
  // rename used to look the table up by the STORED path alone, so a pair
  // whose `form.table` had gone stale (a move/slug rename — the same
  // staleness that broke "Edit form" saving) silently renamed nothing,
  // best-effort swallowing the miss. It must now go through the shared
  // self-healing resolver instead.
  it('renames the paired table even when the stored table path has gone stale', async () => {
    const space = await storage.createSpace(`Forms Rename Stale ${Date.now()}`, null);
    try {
      // "+ → Form" shape: the table is the form's own CHILD, which is the
      // layout the owner's broken pair has. Renaming the TABLE's slug (a
      // leaf with no children of its own) leaves it nested exactly where it
      // was but changes its path, so `form.table` — written once at pairing
      // and never rewritten — goes stale. The old exact-path lookup found
      // nothing here and, being best-effort, renamed nothing at all.
      const formMeta = await storage.createPage({ space: space.slug, parentPath: '', title: 'Survey', kind: 'form' });
      const formDoc = await storage.readFreshFormDoc(formMeta.id);
      const tableId = (await storage.getEntryIdByExactPath(space.slug, formDoc.table))!;
      expect(tableId).toBeDefined();

      await storage.renamePageSlug(tableId, 'answers');
      expect(await storage.getEntryIdByExactPath(space.slug, formDoc.table)).toBeUndefined();

      const formEntry = await storage.requireEntry(formMeta.id);
      await renamePairedTableBestEffort(formEntry, formDoc.table, 'Questions for training');

      expect((await storage.requireEntry(tableId)).title).toBe('Questions for training');
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  // Reverse direction is intentionally asymmetric: a table can be the target
  // of several forms, so renaming the TABLE must not touch any form's title.
  it('renaming a table leaves its paired form untouched', async () => {
    const space = await storage.createSpace(`Tables Rename ${Date.now()}`, null);
    try {
      const columns: TableColumn[] = [{ id: 'name', name: 'Name', type: 'text' }];
      const table = await storage.createPage({ space: space.slug, parentPath: '', title: 'Event Signup', kind: 'table', columns });
      const formMeta = await storage.createFormFromTable(table.id);
      const formBefore = await storage.readFreshFormDoc(formMeta.id);

      await storage.renameTableFile(table.id, 'A basic survey about the team');

      const formAfter = await storage.readFreshFormDoc(formMeta.id);
      expect(formAfter.title).toBe(formBefore.title);
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  // Owner repro (22.09.2026, prod screenshot): "Edit form" permanently
  // refused to save with a "waiting for the table" banner that waiting never
  // fixed. Root cause: `form.table` (a space-root-relative path, snapshotted
  // once at pairing) is never rewritten by movePage/renamePageSlug — so a
  // slug rename on the TABLE side of a "+ → Form" pair (table nested UNDER
  // the form) leaves the form pointing at a path nothing lives at any more.
  // resolvePairedTableId must still resolve the pair by its TREE position
  // (the table is still the form's own child) rather than staying stuck on
  // the stale path, and heal the stored path so the next lookup is cheap.
  it('resolvePairedTableId still finds the paired table after its slug changes, and heals the stale path', async () => {
    const space = await storage.createSpace(`Forms Stale Path ${Date.now()}`, null);
    try {
      const meta = await storage.createPage({ space: space.slug, parentPath: '', title: 'Questions for training', kind: 'form' });
      const formBefore = await storage.readFreshFormDoc(meta.id);
      const staleTablePath = formBefore.table;
      const tableId = await storage.getEntryIdByExactPath(space.slug, staleTablePath);
      expect(tableId).toBeDefined();

      // Rename the TABLE's slug — same operation a drag-and-drop or an
      // explicit slug edit performs; nothing about the form is touched.
      const renamed = await storage.renamePageSlug(tableId!, 'answers');
      expect(renamed.meta.path).not.toBe(staleTablePath);
      // The stale path really is gone — the naive exact-path lookup this
      // bug relied on would 404 here.
      expect(await storage.getEntryIdByExactPath(space.slug, staleTablePath)).toBeUndefined();

      const formEntry = await storage.requireEntry(meta.id);
      const resolvedId = await resolvePairedTableId(formEntry, staleTablePath);
      expect(resolvedId).toBe(tableId);

      // Self-healed: the next resolution no longer needs the tree fallback.
      const formAfter = await storage.readFreshFormDoc(meta.id);
      expect(formAfter.table).toBe(renamed.meta.path);
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  // The other half of the same bugfix: when the pair is genuinely broken —
  // not just stale, actually gone — the user must be told WHY instead of
  // being sent back to "try again in a moment" forever (this exact message
  // is what web/src/app/errorText.ts's `formTableNotFound` rule matches).
  it('resolvePairedTableId reports which path it looked for when the table is truly gone', async () => {
    const space = await storage.createSpace(`Forms Table Gone ${Date.now()}`, null);
    try {
      const meta = await storage.createPage({ space: space.slug, parentPath: '', title: 'Survey', kind: 'form' });
      const form = await storage.readFreshFormDoc(meta.id);
      const tableId = await storage.getEntryIdByExactPath(space.slug, form.table);
      await storage.deletePage(tableId!, 'test-user');

      const formEntry = await storage.requireEntry(meta.id);
      await expect(resolvePairedTableId(formEntry, form.table)).rejects.toThrow(
        `the table paired with this form was not found (looked for "${form.table}")`,
      );
    } finally {
      await deleteTestSpace(space.slug);
    }
  });
});
