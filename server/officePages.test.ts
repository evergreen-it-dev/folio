/**
 * Round OFFICE: a `.docx`/`.xlsx`/`.pptx` file in a space's directory becomes
 * a first-class, read-only page (kind 'office') exactly the way a `.pdf`
 * already does (see server/storage.ts's "Binary page files" module doc
 * comment) — scanned, given a stable id kept in the index (never written
 * into the file), titled from its filename. Exercised directly through
 * storage.scanSpace (real PG + real fs, no HTTP layer — see
 * slugRename.test.ts's own doc comment for why this codebase's tests never
 * spin up Fastify). Mirrors server/pdfPages.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import { query } from './db/pool.js';
import * as storage from './storage.js';

/** Scan never parses an office file, so any small valid zip (the OOXML magic bytes) is enough. */
async function sampleDocxBytes(): Promise<Buffer> {
  // "PK\x03\x04" is the ZIP local-file-header signature every OOXML format
  // shares — the rest of the bytes are never read by a scan, only stat'd.
  return Buffer.from('PK\x03\x04\x14\x00\x00\x00\x00\x00', 'latin1');
}

describe('office pages (round OFFICE, real fs + real PG)', () => {
  let teardownSchema: () => Promise<void>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  it('indexes a .docx file as an office page with the right title and a stable id across two scans', async () => {
    const space = await storage.createSpace(`Office Pages ${Date.now()}`, null);
    try {
      const dir = storage.getSpaceDir(space.slug);
      const original = await sampleDocxBytes();
      await fs.writeFile(path.join(dir, 'Quarterly Report.docx'), original);

      await storage.scanSpace(space.slug);
      const entries = await storage.listEntries(space.slug);
      const first = entries.find((e) => e.relPath === 'Quarterly Report.docx');
      expect(first).toBeDefined();
      expect(first?.kind).toBe('office');
      expect(first?.title).toBe('Quarterly Report.docx'); // a file page keeps the extension in its title
      // No plain_text/tsvector content — search by title only (see
      // upsertPagesIndexRow: only 'doc'/'table' populate plainText).
      expect(first?.body).toBeUndefined();

      // The id survives a second scan unchanged — kept in pages_index and
      // resolved by path (server/storage.ts "Binary page files"), never
      // written into the file — not re-minted just because the file was re-read.
      await storage.scanSpace(space.slug);
      const entriesAgain = await storage.listEntries(space.slug);
      const second = entriesAgain.find((e) => e.relPath === 'Quarterly Report.docx');
      expect(second?.id).toBe(first?.id);
      expect(second?.kind).toBe('office');
      // The owner's file is never rewritten — not by the first scan, not by the second.
      expect(await fs.readFile(path.join(dir, 'Quarterly Report.docx'))).toEqual(original);
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('indexes .xlsx and .pptx under the same kind, distinguished only by extension', async () => {
    const space = await storage.createSpace(`Office Pages Formats ${Date.now()}`, null);
    try {
      const dir = storage.getSpaceDir(space.slug);
      await fs.writeFile(path.join(dir, 'Budget.xlsx'), await sampleDocxBytes());
      await fs.writeFile(path.join(dir, 'Pitch.pptx'), await sampleDocxBytes());
      await storage.scanSpace(space.slug);

      const entries = await storage.listEntries(space.slug);
      const xlsx = entries.find((e) => e.relPath === 'Budget.xlsx');
      const pptx = entries.find((e) => e.relPath === 'Pitch.pptx');
      expect(xlsx?.kind).toBe('office');
      expect(xlsx?.title).toBe('Budget.xlsx');
      expect(pptx?.kind).toBe('office');
      expect(pptx?.title).toBe('Pitch.pptx');
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('survives a rename/move — the id travels with the file, not the path', async () => {
    const space = await storage.createSpace(`Office Pages Move ${Date.now()}`, null);
    try {
      const dir = storage.getSpaceDir(space.slug);
      await fs.writeFile(path.join(dir, 'notes.docx'), await sampleDocxBytes());
      await storage.scanSpace(space.slug);
      const before = (await storage.listEntries(space.slug)).find((e) => e.relPath === 'notes.docx');
      expect(before).toBeDefined();

      await storage.movePage(before!.id, 'archive');
      const after = await storage.requireEntry(before!.id);
      expect(after.relPath).toBe('archive/notes.docx');
      expect(after.kind).toBe('office');
      expect(after.id).toBe(before!.id);

      // Renamed outside Folio (git mv, folder move): same size, old file gone → same id.
      await fs.rename(path.join(dir, 'archive', 'notes.docx'), path.join(dir, 'archive', 'renamed.docx'));
      await storage.scanSpace(space.slug);
      const renamed = (await storage.listEntries(space.slug)).find((e) => e.relPath === 'archive/renamed.docx');
      expect(renamed?.id).toBe(before!.id);
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('a rescan re-derives the title when the naming rule changed under an untouched file', async () => {
    // The mtime+size fast path used to skip such a file forever, so the title
    // rule change (16.09: extensions in file page titles) never reached rows
    // indexed before it. Simulated here by writing the OLD title straight into
    // the row and rescanning without touching the file.
    const space = await storage.createSpace(`PDF Office Retitle ${Date.now()}`, null);
    try {
      const dir = storage.getSpaceDir(space.slug);
      await fs.writeFile(path.join(dir, 'Deck.pptx'), await sampleDocxBytes());
      await storage.scanSpace(space.slug);
      const before = (await storage.listEntries(space.slug)).find((e) => e.relPath === 'Deck.pptx');
      expect(before?.title).toBe('Deck.pptx');

      await query('UPDATE pages_index SET title = $2 WHERE id = $1', [before!.id, 'Deck']);
      await storage.scanSpace(space.slug);

      const after = (await storage.listEntries(space.slug)).find((e) => e.relPath === 'Deck.pptx');
      expect(after?.title).toBe('Deck.pptx');
      expect(after?.id).toBe(before!.id); // the same page, not a new one
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('an order/icon set via setBinaryPageOrder/setBinaryPageIcon survives a rescan that actually re-indexes the file', async () => {
    // Regression guard for the sidebar drag bug: order/icon for a pdf/office
    // page live ONLY in pages_index (see storage.setBinaryPageOrder's doc
    // comment) — nothing on disk carries them, so indexBinaryFile must look
    // the existing row up by id and carry them forward, or a rescan silently
    // resets both back to their defaults.
    const space = await storage.createSpace(`Office Pages Order ${Date.now()}`, null);
    try {
      const dir = storage.getSpaceDir(space.slug);
      const filePath = path.join(dir, 'notes.docx');
      await fs.writeFile(filePath, await sampleDocxBytes());
      await storage.scanSpace(space.slug);
      const before = (await storage.listEntries(space.slug)).find((e) => e.relPath === 'notes.docx');
      expect(before).toBeDefined();

      const entry = await storage.requireEntry(before!.id);
      await storage.setBinaryPageOrder(entry, 20);
      await storage.setBinaryPageIcon(entry, '📄');

      // Bump the mtime so the rescan takes the REAL re-index path rather than
      // the mtime+size "unchanged" skip — the skip path never touches the
      // row at all, so it would pass even without the fix.
      const future = new Date(Date.now() + 60_000);
      await fs.utimes(filePath, future, future);
      await storage.scanSpace(space.slug);

      const after = await storage.requireEntry(before!.id);
      expect(after.explicitOrder).toBe(20);
      expect(after.icon).toBe('📄');
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('rejects creating an office page through the generic create-page endpoint', async () => {
    const space = await storage.createSpace(`Office Pages Create Reject ${Date.now()}`, null);
    try {
      await expect(storage.createPage({ space: space.slug, parentPath: '', title: 'Whatever', kind: 'office' })).rejects.toThrow();
    } finally {
      await deleteTestSpace(space.slug);
    }
  });
});
