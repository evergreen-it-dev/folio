/**
 * Round 23 (EXPORT), Stage 3 — DOCX.
 *
 * A .docx is a ZIP of OOXML, so these tests unzip the produced file and
 * assert against `word/document.xml` directly rather than against a byte
 * count — the two claims that matter (a NATIVE Word table whose header row
 * is marked repeating, and a board embedded as a raster with the page title
 * as a caption) are both invisible from the outside otherwise.
 */
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeScenePayload } from '../confluenceWhiteboard.js';
import * as authStore from '../auth/store.js';
import { setUpTestSchema, deleteTestSpace } from '../db/testSchema.js';
import * as storage from '../storage.js';
import { singlePage } from './collect.js';
import { renderDocx } from './docx.js';
import { assembleMarkdown } from './markdown.js';
import { closeBrowser, findChromium } from './pdf.js';

const BASE = 'https://folio.example.com';

async function openDocx(buf: Buffer): Promise<{ documentXml: string; mediaFiles: string[] }> {
  const zip = await JSZip.loadAsync(buf);
  const documentXml = await zip.file('word/document.xml')!.async('string');
  const mediaFiles = Object.keys(zip.files).filter((n) => n.startsWith('word/media/'));
  return { documentXml, mediaFiles };
}

describe('R23 export — DOCX', () => {
  let teardownSchema: () => Promise<void>;
  let space: string;
  let chromium: string | undefined;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const user = await authStore.createUser({ email: `export-docx-${Date.now()}@test.local`, name: 'Docx', passwordHash: 'x', isAdmin: false });
    const created = await storage.createSpace(`Export DOCX ${Date.now()}`, user.id);
    space = created.slug;
    chromium = await findChromium();
  }, 30_000);

  afterAll(async () => {
    await closeBrowser();
    await deleteTestSpace(space);
    await teardownSchema();
  }, 30_000);

  it('produces a real .docx (ZIP + OOXML) with headings, lists and inline styling', async () => {
    const meta = await storage.createPage({ space, parentPath: '', title: `Docx Basics ${Date.now()}`, kind: 'doc' });
    await storage.writeDocBody(
      meta.id,
      ['# Title', '', 'Some **bold** and *italic* and ++under++ text.', '', '- first', '- second', '', '1. one', '2. two', '', '> quoted', '', '```', 'code line', '```'].join('\n'),
    );
    const entry = await storage.requireEntry(meta.id);
    const { markdown } = await assembleMarkdown(singlePage(entry), { baseUrl: BASE });

    const buf = await renderDocx({ markdown, entry, baseUrl: BASE });
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK'); // it really is a zip

    const { documentXml } = await openDocx(buf);
    expect(documentXml).toContain('Title');
    expect(documentXml).toContain('Heading1');
    expect(documentXml).toContain('<w:b/>'); // bold run
    expect(documentXml).toContain('<w:i/>'); // italic run
    expect(documentXml).toContain('<w:u w:val="single"/>'); // ++underline++ run
    expect(documentXml).toContain('first');
    expect(documentXml).toContain('one');
    expect(documentXml).toContain('quoted');
    expect(documentXml).toContain('code line');

    await storage.deletePage(meta.id);
  }, 60_000);

  it('a status tag becomes a shaded, capitalised run — never the raw :status[…] syntax', async () => {
    const meta = await storage.createPage({ space, parentPath: '', title: `Docx Status ${Date.now()}`, kind: 'doc' });
    await storage.writeDocBody(meta.id, '# Docx Status\n\nLevel: :status[Selected]{color=green} and :status[Plain]\n');
    const entry = await storage.requireEntry(meta.id);
    const { markdown } = await assembleMarkdown(singlePage(entry), { baseUrl: BASE });

    const { documentXml } = await openDocx(await renderDocx({ markdown, entry, baseUrl: BASE }));
    expect(documentXml).not.toContain(':status[');
    expect(documentXml).toContain('Selected');
    expect(documentXml).toContain('w:fill="e3fcef"'); // green lozenge background
    expect(documentXml).toContain('w:fill="dfe1e6"'); // grey default
    expect(documentXml).toContain('<w:caps/>');

    await storage.deletePage(meta.id);
  }, 60_000);

  it('a data table becomes a NATIVE Word table with the header row marked repeating', async () => {
    const meta = await storage.createPage({ space, parentPath: '', title: `Docx Table ${Date.now()}`, kind: 'doc' });
    await storage.writeDocBody(meta.id, '# Docx Table\n\n| Name | Due |\n| --- | --- |\n| Alpha | 2026-01-15 |\n| Beta | 2026-02-01 |\n');
    const entry = await storage.requireEntry(meta.id);
    const { markdown } = await assembleMarkdown(singlePage(entry), { baseUrl: BASE });

    const { documentXml } = await openDocx(await renderDocx({ markdown, entry, baseUrl: BASE }));
    expect(documentXml).toContain('<w:tbl>'); // a real table, not preformatted text
    expect(documentXml).toContain('<w:tblHeader/>'); // the spec's actual requirement
    expect((documentXml.match(/<w:tblHeader\/>/g) ?? []).length).toBe(1); // exactly the first row
    expect(documentXml).toContain('Alpha');
    expect(documentXml).toContain('2026-02-01');

    await storage.deletePage(meta.id);
  }, 60_000);

  it('a page separator becomes a real page break', async () => {
    const meta = await storage.createPage({ space, parentPath: '', title: `Docx Break ${Date.now()}`, kind: 'doc' });
    const entry = await storage.requireEntry(meta.id);
    const { documentXml } = await openDocx(await renderDocx({ markdown: '# A\n\ntext\n\n---\n\n# B\n\nmore\n', entry, baseUrl: BASE }));
    expect(documentXml).toContain('w:type="page"');
    await storage.deletePage(meta.id);
  }, 60_000);

  it('an empty document does not crash the packer', async () => {
    const meta = await storage.createPage({ space, parentPath: '', title: `Docx Empty ${Date.now()}`, kind: 'doc' });
    const entry = await storage.requireEntry(meta.id);
    const buf = await renderDocx({ markdown: '', entry, baseUrl: BASE });
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
    await storage.deletePage(meta.id);
  }, 60_000);

  it('a board is embedded as a rasterized PNG with the page title as its caption', async (ctx) => {
    if (!chromium) {
      // eslint-disable-next-line no-console
      console.warn('[R23] no system chromium — the DOCX board-rasterization test is skipped (set CHROMIUM_PATH to run it)');
      return ctx.skip();
    }

    const board = await storage.createPage({ space, parentPath: '', title: `Docx Board ${Date.now()}`, kind: 'board' });
    const scene = {
      type: 'excalidraw',
      version: 2,
      source: 'test',
      elements: [{ id: 't1', type: 'text', x: 0, y: 0, width: 80, height: 20, text: 'boxed', originalText: 'boxed', frameId: null, isDeleted: false }],
      appState: {},
      files: {},
    };
    await storage.writeBoardSvg(
      board.id,
      `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60"><metadata><!-- payload-start -->${encodeScenePayload(
        scene as never,
      )}<!-- payload-end --></metadata><rect width="120" height="60" fill="#ccd"/></svg>\n`,
      true,
    );
    const entry = await storage.requireEntry(board.id);
    const { markdown } = await assembleMarkdown(singlePage(entry), { baseUrl: BASE });

    const { documentXml, mediaFiles } = await openDocx(await renderDocx({ markdown, entry, baseUrl: BASE }));
    expect(mediaFiles.length).toBeGreaterThan(0); // the raster actually made it in
    expect(documentXml).toContain('<w:drawing>');
    expect(documentXml).toContain(entry.title); // caption = the board page's title
    // The extracted scene text rides along too, so the DOCX is readable as content.
    expect(documentXml).toContain('boxed');

    await storage.deletePage(board.id);
  }, 120_000);
});
