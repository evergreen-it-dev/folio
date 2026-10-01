/**
 * Round PDF: a `.pdf` file in a space's directory becomes a first-class,
 * read-only page (kind 'pdf') the same way a `.excalidraw.svg` becomes a
 * board — scanned, given a stable id kept in the index (never written into the file), titled
 * from its filename. Exercised directly through storage.scanSpace (real PG
 * + real fs, no HTTP layer — see slugRename.test.ts's own doc comment for
 * why this codebase's tests never spin up Fastify).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';

/** Scan never parses a PDF, so a tiny header-and-trailer file is enough. */
async function samplePdfBytes(): Promise<Buffer> {
  return Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
}

describe('pdf pages (round PDF, real fs + real PG)', () => {
  let teardownSchema: () => Promise<void>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  it('indexes a .pdf file as a pdf page with the right title and a stable id across two scans', async () => {
    const space = await storage.createSpace(`PDF Pages ${Date.now()}`, null);
    try {
      const dir = storage.getSpaceDir(space.slug);
      const original = await samplePdfBytes();
      await fs.writeFile(path.join(dir, 'Quarterly Report.pdf'), original);

      await storage.scanSpace(space.slug);
      const entries = await storage.listEntries(space.slug);
      const first = entries.find((e) => e.relPath === 'Quarterly Report.pdf');
      expect(first).toBeDefined();
      expect(first?.kind).toBe('pdf');
      expect(first?.title).toBe('Quarterly Report.pdf'); // a file page keeps the extension in its title
      // No plain_text/tsvector content — search by title only (see
      // upsertPagesIndexRow: only 'doc'/'table' populate plainText).
      expect(first?.body).toBeUndefined();

      // The id survives a second scan unchanged — kept in pages_index and
      // resolved by path (server/storage.ts "PDF pages"), never written into
      // the file — not re-minted just because the file was re-read.
      await storage.scanSpace(space.slug);
      const entriesAgain = await storage.listEntries(space.slug);
      const second = entriesAgain.find((e) => e.relPath === 'Quarterly Report.pdf');
      expect(second?.id).toBe(first?.id);
      expect(second?.kind).toBe('pdf');
      // The owner's file is never rewritten — not by the first scan, not by the second.
      expect(await fs.readFile(path.join(dir, 'Quarterly Report.pdf'))).toEqual(original);
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('survives a rename/move — the id travels with the file, not the path', async () => {
    const space = await storage.createSpace(`PDF Pages Move ${Date.now()}`, null);
    try {
      const dir = storage.getSpaceDir(space.slug);
      await fs.writeFile(path.join(dir, 'notes.pdf'), await samplePdfBytes());
      await storage.scanSpace(space.slug);
      const before = (await storage.listEntries(space.slug)).find((e) => e.relPath === 'notes.pdf');
      expect(before).toBeDefined();

      await storage.movePage(before!.id, 'archive');
      const after = await storage.requireEntry(before!.id);
      expect(after.relPath).toBe('archive/notes.pdf');
      expect(after.kind).toBe('pdf');
      expect(after.id).toBe(before!.id);

      // Renamed outside Folio (git mv, folder move): same size, old file gone → same id.
      await fs.rename(path.join(dir, 'archive', 'notes.pdf'), path.join(dir, 'archive', 'renamed.pdf'));
      await storage.scanSpace(space.slug);
      const renamed = (await storage.listEntries(space.slug)).find((e) => e.relPath === 'archive/renamed.pdf');
      expect(renamed?.id).toBe(before!.id);
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('rejects creating a pdf page through the generic create-page endpoint', async () => {
    const space = await storage.createSpace(`PDF Pages Create Reject ${Date.now()}`, null);
    try {
      await expect(storage.createPage({ space: space.slug, parentPath: '', title: 'Whatever', kind: 'pdf' })).rejects.toThrow();
    } finally {
      await deleteTestSpace(space.slug);
    }
  });
});
