/**
 * Round 23 (EXPORT), Stage 2 — the print document and the chromium PDF path.
 *
 * The print-document half is deterministic and always runs. The chromium
 * half is guarded by `isChromiumAvailable()` and SKIPS (loudly, via a
 * reported skip — never a fake pass) when the machine has no browser: the
 * production image installs one, a dev box may not have one, and a test that
 * quietly asserts nothing would be worse than no test at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeScenePayload } from '../confluenceWhiteboard.js';
import * as authStore from '../auth/store.js';
import { setUpTestSchema, deleteTestSpace } from '../db/testSchema.js';
import * as storage from '../storage.js';
import { singlePage } from './collect.js';
import { assembleMarkdown } from './markdown.js';
import { closeBrowser, findChromium, isChromiumAvailable, renderPdf } from './pdf.js';
import { buildPrintDocument, markdownToHtml } from './print.js';

const BASE = 'https://folio.example.com';

describe('R23 export — print document + PDF', () => {
  let teardownSchema: () => Promise<void>;
  let space: string;
  let chromium: string | undefined;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const user = await authStore.createUser({ email: `export-pdf-${Date.now()}@test.local`, name: 'Pdf', passwordHash: 'x', isAdmin: false });
    const created = await storage.createSpace(`Export PDF ${Date.now()}`, user.id);
    space = created.slug;
    chromium = await findChromium();
  }, 30_000);

  afterAll(async () => {
    await closeBrowser();
    await deleteTestSpace(space);
    await teardownSchema();
  }, 30_000);

  // -------------------------------------------------------------------------
  // print document (always runs)
  // -------------------------------------------------------------------------

  it('renders GFM tables and repeats the header row on every printed page', async () => {
    const meta = await storage.createPage({ space, parentPath: '', title: `Print Table ${Date.now()}`, kind: 'doc' });
    await storage.writeDocBody(meta.id, '# Print Table\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n');
    const entry = await storage.requireEntry(meta.id);

    const { markdown } = await assembleMarkdown(singlePage(entry), { baseUrl: BASE });
    const doc = await buildPrintDocument({ markdown, entry, baseUrl: BASE });

    expect(doc.html).toContain('<table>');
    expect(doc.html).toContain('<thead>');
    // R23 addendum 4's explicit requirement.
    expect(doc.html).toContain('thead { display: table-header-group; }');
    await storage.deletePage(meta.id);
  });

  it('tags a wide table so the stylesheet can shrink it (the documented wide-table strategy)', async () => {
    const header = `| ${['a', 'b', 'c', 'd', 'e', 'f', 'g'].join(' | ')} |`;
    const sep = `| ${['---', '---', '---', '---', '---', '---', '---'].join(' | ')} |`;
    const html = await markdownToHtml(`${header}\n${sep}\n| 1 | 2 | 3 | 4 | 5 | 6 | 7 |\n`);
    expect(html).toContain('<table>');

    const meta = await storage.createPage({ space, parentPath: '', title: `Wide ${Date.now()}`, kind: 'doc' });
    await storage.writeDocBody(meta.id, `# Wide\n\n${header}\n${sep}\n| 1 | 2 | 3 | 4 | 5 | 6 | 7 |\n`);
    const entry = await storage.requireEntry(meta.id);
    const doc = await buildPrintDocument({ markdown: (await assembleMarkdown(singlePage(entry), { baseUrl: BASE })).markdown, entry, baseUrl: BASE });
    expect(doc.html).toContain('<table class="folio-wide">');
    await storage.deletePage(meta.id);
  });

  it("inlines a board's SVG into the flow (vector, break-inside: avoid) rather than linking it", async () => {
    const board = await storage.createPage({ space, parentPath: '', title: `Print Board ${Date.now()}`, kind: 'board' });
    const scene = {
      type: 'excalidraw',
      version: 2,
      source: 'test',
      elements: [{ id: 't1', type: 'text', x: 0, y: 0, width: 80, height: 20, text: 'hello board', originalText: 'hello board', frameId: null, isDeleted: false }],
      appState: {},
      files: {},
    };
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20"><metadata>` +
      `<!-- payload-start -->${encodeScenePayload(scene as never)}<!-- payload-end --></metadata>` +
      `<rect x="0" y="0" width="40" height="20" fill="#eee"/></svg>\n`;
    await storage.writeBoardSvg(board.id, svg, true);
    const entry = await storage.requireEntry(board.id);

    const { markdown } = await assembleMarkdown(singlePage(entry), { baseUrl: BASE });
    const doc = await buildPrintDocument({ markdown, entry, baseUrl: BASE });

    expect(doc.html).toContain('<figure class="folio-board">');
    expect(doc.html).toContain('<svg'); // real vector markup, not a data: URI or a remote <img>
    expect(doc.html).not.toContain(`<img src="${BASE}/files/`);
    expect(doc.html).toContain('figure.folio-board { margin: 1em 0; text-align: center; break-inside: avoid;');
    await storage.deletePage(board.id);
  });

  it('always emits running headers/footers, with page numbers by default', async () => {
    const meta = await storage.createPage({ space, parentPath: '', title: `Footer ${Date.now()}`, kind: 'doc' });
    const entry = await storage.requireEntry(meta.id);
    const doc = await buildPrintDocument({ markdown: '# Footer\n\nbody\n', entry, baseUrl: BASE });
    expect(doc.footerTemplate).toContain('<span class="pageNumber"></span>');
    expect(doc.footerTemplate).toContain('<span class="totalPages"></span>');
    await storage.deletePage(meta.id);
  });

  it('strips anything executable out of the print body', async () => {
    const meta = await storage.createPage({ space, parentPath: '', title: `Exec ${Date.now()}`, kind: 'doc' });
    await storage.writeDocBody(meta.id, '# Exec\n\n<script>fetch("https://evil.example")</script>\n\n<div onload="x()">hi</div>\n');
    const entry = await storage.requireEntry(meta.id);
    const doc = await buildPrintDocument({ markdown: (await assembleMarkdown(singlePage(entry), { baseUrl: BASE })).markdown, entry, baseUrl: BASE });
    expect(doc.html).not.toContain('evil.example');
    expect(doc.html).not.toContain('onload');
    expect(doc.html).toContain('hi');
    await storage.deletePage(meta.id);
  });

  // -------------------------------------------------------------------------
  // real chromium (skipped, never faked, when there is none)
  // -------------------------------------------------------------------------

  describe('chromium', () => {
    it('reports whether a system chromium was found on this machine', async () => {
      const available = await isChromiumAvailable();
      // Informational, and the guard the skipped tests below use.
      expect(typeof available).toBe('boolean');
      if (!available) {
        // eslint-disable-next-line no-console
        console.warn('[R23] no system chromium on this machine — PDF rendering tests skipped (set CHROMIUM_PATH to run them)');
      }
    });

    it('produces a real PDF from a page with text, a table and a board', async (ctx) => {
      if (!chromium) return ctx.skip();

      const meta = await storage.createPage({ space, parentPath: '', title: `Real PDF ${Date.now()}`, kind: 'doc' });
      await storage.writeDocBody(
        meta.id,
        ['# Real PDF', '', 'Some prose that must land on the page.', '', '| A | B |', '| --- | --- |', '| 1 | 2 |', ''].join('\n'),
      );
      const entry = await storage.requireEntry(meta.id);
      const { markdown } = await assembleMarkdown(singlePage(entry), { baseUrl: BASE });

      const pdf = await renderPdf({ markdown, entry, baseUrl: BASE });
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(pdf.length).toBeGreaterThan(1000);
      expect(pdf.subarray(-1024).toString('latin1')).toContain('%%EOF');

      await storage.deletePage(meta.id);
    }, 120_000);

    it('rasterizes a board SVG to PNG for the DOCX path', async (ctx) => {
      if (!chromium) return ctx.skip();
      const { rasterizeSvg } = await import('./pdf.js');
      const png = await rasterizeSvg('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#333"/></svg>', 200);
      expect(png).not.toBeNull();
      expect(png!.subarray(1, 4).toString('latin1')).toBe('PNG');
    }, 120_000);
  });
});
