import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as authStore from './auth/store.js';
import * as userConfluenceCredentials from './userConfluenceCredentials.js';
import {
  applyStorageRepairs,
  assignPaths,
  bgClass,
  buildTurndownService,
  composePageBody,
  convertPageHtml,
  emoticonToText,
  extractConfluenceAttachmentName,
  extractConfluenceContentId,
  extractJiraIssueKeys,
  normalizeUnresolvedConfluenceHref,
  getJob,
  hexToBgToken,
  parseConfluenceUrl,
  parseHexColor,
  preprocessConfluenceDom,
  preprocessTables,
  resolveBgToken,
  resolveImportAuth,
  resolveOrCreateTargetSpace,
  startImportJob,
  stripConfluenceCruft,
  type PageConversionContext,
  type PathAssignable,
} from './confluenceImport.js';

/** A no-op context for tests that don't care about link/image resolution. */
const NOOP_CTX: PageConversionContext = { resolveLink: () => undefined, resolveImage: () => undefined };

/** Polls `check` until it returns true or `timeoutMs` elapses. */
async function pollUntil(check: () => boolean, timeoutMs = 10_000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil: condition not met within ${timeoutMs}ms`);
}

describe('confluenceImport.ts pure pieces (round 12, no network)', () => {
  describe('parseConfluenceUrl', () => {
    it('extracts the numeric page id from a spaces/.../pages/NNNN URL', () => {
      const parsed = parseConfluenceUrl('https://wiki.example.org/wiki/spaces/ENG/pages/1000000007/Onboarding');
      expect(parsed.base).toBe('https://wiki.example.org/wiki');
      expect(parsed.pageId).toBe('1000000007');
      expect(parsed.spaceKey).toBe('ENG');
    });

    it('extracts the numeric page id from a viewpage.action?pageId= URL', () => {
      const parsed = parseConfluenceUrl('https://old.example.com/wiki/pages/viewpage.action?pageId=42');
      expect(parsed.base).toBe('https://old.example.com/wiki');
      expect(parsed.pageId).toBe('42');
    });

    it('falls back to a title guess for a "pretty" URL with no numeric id', () => {
      const parsed = parseConfluenceUrl('https://x.atlassian.net/wiki/spaces/ENG/pages/onboarding-guide');
      expect(parsed.pageId).toBeUndefined();
      expect(parsed.spaceKey).toBe('ENG');
      expect(parsed.titleGuess).toBe('onboarding guide');
    });

    it('rejects a URL with no /wiki segment at all', () => {
      expect(() => parseConfluenceUrl('https://example.com/not-confluence/page/1')).toThrow();
    });
  });

  describe('preprocessTables', () => {
    it('collapses block tags inside td/th to a single line, marking breaks for the caller to restore as <br> later', () => {
      // preprocessTables runs BEFORE turndown; the ¶BR¶ marker (restored to a
      // literal <br> by convertPageHtml's own final pass, exercised in the full
      // fixture below) exists specifically so turndown's own HTML parser never
      // sees a bare <br> that would otherwise break out of the table cell.
      const html = '<table><tr><td><p>First line.</p><p>Second line.</p></td><td>Plain<br>Break</td></tr></table>';
      const out = preprocessTables(html);
      expect(out).not.toContain('<p>');
      expect(out).not.toContain('<br>');
      expect(out).toContain('First line.¶BR¶Second line.');
      expect(out).toContain('Plain¶BR¶Break');
    });

    it('flattens a list inside a cell into bullet-prefixed segments', () => {
      const html = '<table><tr><td><ul><li>One</li><li>Two</li></ul></td></tr></table>';
      const out = preprocessTables(html);
      expect(out).not.toContain('<ul>');
      expect(out).not.toContain('<li>');
      expect(out).toContain('• One');
      expect(out).toContain('• Two');
    });
  });

  describe('stripConfluenceCruft', () => {
    it('removes CDATA leftovers and rbtoc anchor-TOC divs', () => {
      const html = '<![CDATA[junk]]><div class="rbtoc12345"><ul><li>ignored toc entry</li></ul></div><p>Real content.</p>';
      const out = stripConfluenceCruft(html);
      expect(out).not.toContain('CDATA');
      expect(out).not.toContain('ignored toc entry');
      expect(out).toContain('Real content.');
    });

    it('removes anchor-only TOC target paragraphs', () => {
      const html = '<p><a name="anchor-1"></a></p><p>Kept paragraph.</p>';
      const out = stripConfluenceCruft(html);
      expect(out).not.toContain('name="anchor-1"');
      expect(out).toContain('Kept paragraph.');
    });
  });

  describe('convertPageHtml: the full fixture (table + panel + code + anchor-TOC + CDATA + image + internal link)', () => {
    const fixtureHtml = `
      <![CDATA[stray]]>
      <div class="rbtoc99"><ul><li>fake toc</li></ul></div>
      <div class="confluence-information-macro confluence-information-macro-information">
        <p>Heads up: read this first.</p>
      </div>
      <p>Some intro text with an <a href="/wiki/spaces/ENG/pages/222/Other-Page">internal link</a>
      and an external one <a href="https://example.com/x">external link</a>.</p>
      <table>
        <tr><th>Name</th><th>Notes</th></tr>
        <tr><td>Alpha</td><td>Line one.<br>Line two.</td></tr>
      </table>
      <pre class="syntaxhighlighter" data-syntaxhighlighter-params="brush: js">const x = 1;</pre>
      <p><img src="/wiki/download/attachments/111/diagram.png?version=1" alt="Diagram" /></p>
    `;

    function convertFixture() {
      const td = buildTurndownService();
      const ctx: PageConversionContext = {
        resolveLink: (href) => (href.includes('/pages/222/') ? '../other-page.md' : undefined),
        resolveImage: (src) => (src.includes('diagram.png') ? '/a/deadbeef/diagram.png' : undefined),
      };
      return convertPageHtml(td, fixtureHtml, ctx);
    }

    it('produces a GFM alert for the Confluence panel', () => {
      const md = convertFixture();
      expect(md).toContain('> [!NOTE]');
      expect(md).toContain('> Heads up: read this first.');
    });

    it('rewrites the internal link relative and leaves the external link untouched', () => {
      const md = convertFixture();
      expect(md).toContain('[internal link](../other-page.md)');
      expect(md).toContain('[external link](https://example.com/x)');
    });

    it('produces a valid GFM table with the <br>-joined cell collapsed to one line', () => {
      // Round 16: a <p>/<p> cell is now classified "complex" (see the
      // dedicated describe block below) and would emit a clean HTML table
      // instead of a pipe row -- this fixture uses a literal <br> instead,
      // which stays "inline-simple" and exercises the exact same
      // marker-then-restore mechanism (neutralizeBreaksForPipeTable).
      const md = convertFixture();
      expect(md).toMatch(/\|\s*Name\s*\|\s*Notes\s*\|/);
      expect(md).toMatch(/\|\s*---\s*\|\s*---\s*\|/); // GFM separator row, whatever turndown-plugin-gfm's exact spacing is
      const alphaLine = md.split('\n').find((l) => l.includes('Alpha'));
      expect(alphaLine).toBeDefined();
      expect(alphaLine).toContain('Line one.');
      expect(alphaLine).toContain('Line two.');
      expect(alphaLine?.includes('\n')).toBe(false); // the whole row is genuinely one line -- a real GFM table row
    });

    it('converts the syntaxhighlighter block to a fenced code block with the right language', () => {
      const md = convertFixture();
      expect(md).toContain('```js');
      expect(md).toContain('const x = 1;');
      expect(md).toContain('```');
    });

    it('resolves the image through the asset store and drops the CDATA/rbtoc cruft entirely', () => {
      const md = convertFixture();
      expect(md).toContain('![Diagram](/a/deadbeef/diagram.png)');
      expect(md).not.toContain('CDATA');
      expect(md).not.toContain('fake toc');
    });

    it('drops an image that could not be resolved, keeping only its alt text', () => {
      const td = buildTurndownService();
      const html = '<img src="/wiki/download/attachments/1/missing.png" alt="Missing" />';
      const md = convertPageHtml(td, html, { resolveLink: () => undefined, resolveImage: () => undefined });
      expect(md).toContain('Missing');
      expect(md).not.toContain('missing.png');
    });
  });

  describe('Round 16: export_view DOM preprocessing (expand macros, lozenges, comment markers, table classification)', () => {
    describe('preprocessConfluenceDom (direct, pre-turndown HTML)', () => {
      describe('expand macros -> <details><summary>', () => {
        it('pairs a button[aria-controls] control with its own #expander-content-<id> container', () => {
          const html = `
            <p>Intro.</p>
            <button type="button" class="aui-button aui-button-link" aria-controls="expander-content-99" aria-expanded="true">
              <span class="expand-icon aui-icon aui-iconfont-chevron-down" aria-hidden="true"></span>
              <span class="expand-control-text conf-macro-render">Show details</span>
            </button>
            <div id="expander-content-99" class="expand-content"><p>Hidden content here.</p></div>
          `;
          const out = preprocessConfluenceDom(html, NOOP_CTX);
          expect(out).toContain('<details>');
          expect(out).toContain('<summary>Show details</summary>');
          expect(out).toContain('<p>Hidden content here.</p>');
          expect(out).not.toContain('aui-button');
          expect(out).not.toContain('expand-control');
          expect(out).not.toContain('expander-content-99');
          expect(out).not.toContain('<button');
        });

        it('pairs the classic on-prem .expand-control/.expand-content sibling shape (no aria-controls at all)', () => {
          const html = `
            <div class="expand-container conf-macro output-block" data-hasbody="true" data-macro-name="expand">
              <div class="expand-control">
                <span class="expand-icon aui-icon aui-iconfont-chevron-right"></span>
                <span class="expand-control-text">Click here to expand...</span>
              </div>
              <div class="expand-content"><p>Classic macro body.</p></div>
            </div>
          `;
          const out = preprocessConfluenceDom(html, NOOP_CTX);
          expect(out).toContain('<details>');
          expect(out).toContain('<summary>Click here to expand...</summary>');
          expect(out).toContain('<p>Classic macro body.</p>');
          expect(out).not.toContain('expand-container');
          expect(out).not.toContain('expand-control');
          expect(out).not.toContain('conf-macro');
        });

        it('degrades to a bold label when no paired container exists anywhere (the real "BA - Business Analyst" prod gap)', () => {
          // Reproduces a real imported page: the button's aria-controls id never
          // appears anywhere in export_view -- no container to pair with at all.
          const html = `
            <p><strong>Key resources</strong></p>
            <button type="button" id="expand-button-402043770" class="aui-button aui-button-link aui-button-link-icon-text" aria-expanded="true" aria-controls="expander-content-402043770">
              <span class="expand-icon aui-icon aui-icon-small aui-iconfont-chevron-down" aria-hidden="true"></span>
              <span class="expand-control-text conf-macro-render">what do we offer?</span>
            </button>
            <p>first item, second item</p>
          `;
          const out = preprocessConfluenceDom(html, NOOP_CTX);
          expect(out).not.toContain('<details>');
          expect(out).not.toContain('<button');
          expect(out).not.toContain('aui-');
          expect(out).not.toContain('expander-content');
          expect(out).toContain('<strong>what do we offer?</strong>');
          expect(out).toContain('first item');
        });
      });

      it('unwraps span.inline-comment-marker to bare text, dropping data-ref', () => {
        const html = '<p>See <span class="inline-comment-marker" data-ref="abc-123">the note above</span> for context.</p>';
        const out = preprocessConfluenceDom(html, NOOP_CTX);
        expect(out).toContain('the note above');
        expect(out).not.toContain('inline-comment-marker');
        expect(out).not.toContain('data-ref');
        expect(out).not.toContain('<span');
      });

      it('converts span.status-macro (aui-lozenge) to <strong>, dropping its classes and keeping its colour as a dot', () => {
        const html = '<p>Level: <span class="status-macro aui-lozenge aui-lozenge-error">MUST HAVE</span></p>';
        const out = preprocessConfluenceDom(html, NOOP_CTX);
        expect(out).toContain('<strong>🔴 MUST HAVE</strong>');
        expect(out).not.toContain('status-macro');
        expect(out).not.toContain('aui-lozenge');
      });

      it('keeps each aui-lozenge colour distinguishable — the whole point of a row of status macros', () => {
        const html =
          '<p><span class="status-macro aui-lozenge aui-lozenge-success">DONE</span>' +
          '<span class="status-macro aui-lozenge aui-lozenge-moved">HOLD</span>' +
          '<span class="status-macro aui-lozenge aui-lozenge-current">NOW</span></p>';
        const out = preprocessConfluenceDom(html, NOOP_CTX);
        expect(out).toContain('<strong>🟢 DONE</strong>');
        expect(out).toContain('<strong>🟡 HOLD</strong>');
        expect(out).toContain('<strong>🔵 NOW</strong>');
      });

      it('leaves a colourless (default grey) lozenge unmarked — the absence of a highlight is itself the signal', () => {
        const html = '<p><span class="status-macro aui-lozenge">STARTER</span></p>';
        const out = preprocessConfluenceDom(html, NOOP_CTX);
        expect(out).toContain('<strong>STARTER</strong>');
      });

      describe('table classification: simple (inline-only) vs complex', () => {
        it('classifies an evenly-shaped, all-<td>, inline-only table as simple and forces an all-<th> heading row', () => {
          const html = '<table><tr><td>Name</td><td>Notes</td></tr><tr><td>Alpha</td><td>Fine.</td></tr></table>';
          const out = preprocessConfluenceDom(html, NOOP_CTX);
          expect(out).toContain('<th>Name</th><th>Notes</th>');
          expect(out).toContain('<td>Alpha</td><td>Fine.</td>');
          expect(out).not.toContain('data-folio-raw-table');
        });

        it('classifies a table with a nested <ul> in one cell as SIMPLE (round 28) and rewrites the list as cell lines', () => {
          // Round 16 froze this shape as raw HTML; round 28 gives a list in a
          // cell a pipe-table representation of its own, so the same markup is
          // now a real table. The marker is still in its pre-turndown form
          // here -- convertPageHtml's final string pass renders it (see the
          // round 28 integration tests below for the finished markdown).
          const html = `
            <table class="confluenceTable" data-table-width="800">
              <colgroup><col style="width: 100px;"></colgroup>
              <tbody>
                <tr><td class="junk" style="color:red">
                  <strong>Requirements</strong>
                  <ul><li>First item</li><li>Second item</li></ul>
                  <button type="button" class="aui-button">copy</button>
                </td></tr>
              </tbody>
            </table>
          `;
          const out = preprocessConfluenceDom(html, NOOP_CTX);
          expect(out).not.toContain('data-folio-raw-table');
          expect(out).not.toContain('<ul>');
          expect(out).not.toContain('<li>');
          expect(out).toContain('First item');
          expect(out).toContain('Second item');
          expect(out).not.toContain('<button');
          expect(out).not.toContain('<colgroup');
        });

        it('a cell whose list sits next to a nested table stays complex, list untouched — the nesting is still real', () => {
          const html =
            '<table><tbody><tr><td class="junk"><ul><li>First item</li></ul>' +
            '<table><tbody><tr><td>Inner</td></tr></tbody></table></td></tr></tbody></table>';
          const out = preprocessConfluenceDom(html, NOOP_CTX);
          expect(out).toContain('data-folio-raw-table="1"');
          expect(out).toContain('<li>First item</li>');
          expect(out).not.toContain('class=');
        });

        it('classifies a table with a ragged cell count per row as complex, even with zero disqualifying tags', () => {
          // The real prod symptom (see the module doc comment above
          // preprocessConfluenceDom in confluenceImport.ts): a Confluence
          // "layout" table with 5 cells in row 1, then 2 in row 2 -- no
          // colspan/rowspan, no lists, every cell pure inline content.
          const html = '<table><tr><td>A</td><td>B</td><td>C</td></tr><tr><td>D</td><td>E</td></tr></table>';
          const out = preprocessConfluenceDom(html, NOOP_CTX);
          expect(out).toContain('data-folio-raw-table="1"');
        });

        it('classifies a table with a real colspan as complex, even with a consistent literal cell count per row', () => {
          const html = '<table><tr><td colspan="2">Merged A</td></tr><tr><td colspan="2">Merged B</td></tr></table>';
          const out = preprocessConfluenceDom(html, NOOP_CTX);
          expect(out).toContain('data-folio-raw-table="1"');
        });
      });
    });

    describe('convertPageHtml integration (final markdown shape)', () => {
      it('an expand macro converts to a <details><summary> HTML block, blank-line separated from surrounding text', () => {
        const td = buildTurndownService();
        const html = `
          <p>Before.</p>
          <button type="button" class="aui-button" aria-controls="expander-content-1">
            <span class="expand-control-text">More info</span>
          </button>
          <div id="expander-content-1"><p>Extra detail.</p></div>
          <p>After.</p>
        `;
        const md = convertPageHtml(td, html, NOOP_CTX);
        expect(md).toContain('<details><summary>More info</summary>');
        // Round 28b reversed round 16's "the body stays HTML" decision: the
        // TAGS have no markdown equivalent, the body does. `<p>` is gone, the
        // text is a markdown paragraph.
        expect(md).not.toContain('<p>Extra detail.</p>');
        expect(md).toContain('\n\nExtra detail.\n\n');
        expect(md).not.toContain('aui-button');
        expect(md).toMatch(/Before\.\n\n<details>/);
        expect(md).toMatch(/<\/details>\n\nAfter\./);
      });

      it('a status-macro lozenge converts to **TEXT** markdown when it is plain running text (not inside a raw HTML table)', () => {
        const td = buildTurndownService();
        const html = '<p>Priority: <span class="status-macro aui-lozenge aui-lozenge-error">MUST HAVE</span></p>';
        const md = convertPageHtml(td, html, NOOP_CTX);
        expect(md).toContain('**🔴 MUST HAVE**');
        expect(md).not.toContain('status-macro');
        expect(md).not.toContain('aui-lozenge');
      });

      it('an inline-comment-marker unwraps to bare text in the final markdown', () => {
        const td = buildTurndownService();
        const html = '<p>See <span class="inline-comment-marker" data-ref="xyz">the point above</span>.</p>';
        const md = convertPageHtml(td, html, NOOP_CTX);
        expect(md).toContain('the point above');
        expect(md).not.toContain('inline-comment-marker');
        expect(md).not.toContain('data-ref');
      });

      it('a simple table with NO <th> row at all still produces a proper GFM pipe table (the actual turndown-plugin-gfm root cause)', () => {
        // turndown-plugin-gfm's own `tables` rule `.keep()`s (raw outerHTML
        // passthrough) any table whose first row isn't an all-<th> heading
        // row -- completely unrelated to cell complexity. This is exactly
        // what the real prod symptom hits: its table is 100% <td>, no <th>
        // anywhere, so without ensureHeadingRow it would ALSO have gone raw
        // even after every button/span in it was cleaned up.
        const td = buildTurndownService();
        const html = '<table><tr><td>Column A</td><td>Column B</td></tr><tr><td>Row1 A</td><td>Row1<br>B</td></tr></table>';
        const md = convertPageHtml(td, html, NOOP_CTX);
        expect(md).toMatch(/\|\s*Column A\s*\|\s*Column B\s*\|/);
        expect(md).toMatch(/\|\s*---\s*\|\s*---\s*\|/);
        const dataLine = md.split('\n').find((l) => l.includes('Row1 A'));
        expect(dataLine).toBeDefined();
        expect(dataLine).toContain('Row1<br>B');
        expect(dataLine?.includes('\n')).toBe(false);
        expect(md).not.toContain('<table'); // NOT a raw-HTML passthrough
      });

      it('a table with a nested <ul> in one cell now produces a PIPE table whose cell carries the list as round 28 lines', () => {
        const td = buildTurndownService();
        const html = `
          <table class="confluenceTable"><tbody>
            <tr><td class="x"><strong>Tasks</strong><ul><li>One</li><li>Two</li></ul></td>
            <td><button type="button" class="aui-button">x</button>Other</td></tr>
          </tbody></table>
        `;
        const md = convertPageHtml(td, html, NOOP_CTX);
        expect(md).not.toContain('<table');
        expect(md).toContain('| **Tasks**<br>• One<br>• Two |');
        expect(md).not.toContain('<ul>');
        expect(md).not.toContain('<li>');
        expect(md).not.toContain('<button');
        expect(md).not.toContain('confluenceTable');
        expect(md).not.toContain('data-folio-raw-table'); // internal marker never leaks into the output
      });

      it('resolves a link and an image inside a complex table (turndown would otherwise never visit them once frozen as raw HTML)', () => {
        const td = buildTurndownService();
        // The colspan is what keeps this table complex: since round 28 a list
        // in a cell no longer does, and this test is about the RAW branch.
        const html = `
          <table><tbody><tr><td colspan="2">
            <ul><li>See <a href="/wiki/spaces/ENG/pages/222/Other-Page">the other page</a></li></ul>
            <img src="/wiki/download/attachments/1/pic.png" alt="Pic">
          </td></tr></tbody></table>
        `;
        const ctx: PageConversionContext = {
          resolveLink: (href) => (href.includes('/pages/222/') ? '../other-page.md' : undefined),
          resolveImage: (src) => (src.includes('pic.png') ? '/a/deadbeef/pic.png' : undefined),
        };
        const md = convertPageHtml(td, html, ctx);
        expect(md).toContain('href="../other-page.md"');
        expect(md).toContain('src="/a/deadbeef/pic.png"');
      });

      it('a heading + complex table + surrounding text keeps converting correctly around the raw HTML table block', () => {
        const td = buildTurndownService();
        const html = `
          <h2>Team Roles</h2>
          <p>Intro paragraph.</p>
          <table><tbody><tr><td colspan="2"><ul><li>Alpha</li><li>Beta</li></ul></td></tr></tbody></table>
          <p>Closing paragraph.</p>
        `;
        const md = convertPageHtml(td, html, NOOP_CTX);
        expect(md).toContain('## Team Roles');
        expect(md).toContain('Intro paragraph.');
        expect(md).toContain('Closing paragraph.');
        expect(md).toContain('<table');
        expect(md).toContain('<li>Alpha</li>');
        const headingIdx = md.indexOf('Team Roles');
        const introIdx = md.indexOf('Intro paragraph.');
        const tableIdx = md.indexOf('<table');
        const closingIdx = md.indexOf('Closing paragraph.');
        expect(headingIdx).toBeLessThan(introIdx);
        expect(introIdx).toBeLessThan(tableIdx);
        expect(tableIdx).toBeLessThan(closingIdx);
      });

      it('reproduces the real prod symptom (page 01M0GDCYTNF5P63X6T50SK15SN, "BA - Business Analyst"): dangling expand buttons, comment markers, lozenges and a ragged layout table all clean up together', () => {
        // Trimmed to 2 columns then 1 (the real page is 5, then 2, then 2) --
        // same ragged shape, same button/span markup, same missing
        // expander-content container as the real imported page.
        const td = buildTurndownService();
        const html = `<table><tbody><tr><td><strong>Key resources</strong><br>
          <button type="button" id="expand-button-1" class="aui-button aui-button-link aui-button-link-icon-text" aria-expanded="true" aria-controls="expander-content-1">
            <span class="expand-icon aui-icon aui-icon-small aui-iconfont-chevron-down" aria-hidden="true"></span>
            <span class="expand-control-text conf-macro-render">what do we offer?</span>
          </button><br>
          • <span class="inline-comment-marker" data-ref="r1">class A clients</span>
        </td><td><strong>Strength</strong><br>
          software knowledge <span class="status-macro aui-lozenge aui-lozenge-error">MUST HAVE</span>
        </td></tr>
        <tr><td>People</td></tr>
        </tbody></table>`;
        const md = convertPageHtml(td, html, NOOP_CTX);
        for (const junk of ['aui-button', 'expand-control', 'inline-comment-marker', 'status-macro', 'aui-lozenge', 'expander-content', 'data-ref', 'conf-macro-render']) {
          expect(md).not.toContain(junk);
        }
        expect(md).toContain('what do we offer?');
        expect(md).toContain('class A clients');
        expect(md).toContain('MUST HAVE');
        expect(md).toContain('People');
      });
    });
  });

  describe('round 16b: cell background colour -> palette token', () => {
    describe('parseHexColor', () => {
      it('accepts a 6-digit hex with or without a leading #', () => {
        expect(parseHexColor('#FFFAE6')).toBe('#fffae6');
        expect(parseHexColor('FFFAE6')).toBe('#fffae6');
      });

      it('expands a 3-digit hex', () => {
        expect(parseHexColor('#abc')).toBe('#aabbcc');
      });

      it('accepts rgb()/rgba() as a defensive fallback beyond the forms DEV-PLAN names', () => {
        expect(parseHexColor('rgb(255, 250, 230)')).toBe('#fffae6');
        expect(parseHexColor('rgba(255, 250, 230, 1)')).toBe('#fffae6');
      });

      it('treats a fully-transparent rgba() as no colour', () => {
        expect(parseHexColor('rgba(255, 250, 230, 0)')).toBeNull();
      });

      it('treats transparent/inherit/empty keywords as no colour', () => {
        expect(parseHexColor('transparent')).toBeNull();
        expect(parseHexColor('inherit')).toBeNull();
        expect(parseHexColor('')).toBeNull();
        expect(parseHexColor('   ')).toBeNull();
      });

      it('treats unrecognized text as no colour, without throwing (defensive: never fail the import over a colour it cannot parse)', () => {
        expect(parseHexColor('chartreuse')).toBeNull();
        expect(parseHexColor('not-a-colour-at-all')).toBeNull();
        expect(() => parseHexColor('¯\\_(ツ)_/¯')).not.toThrow();
      });
    });

    describe("hexToBgToken: Confluence's own reference palette (subtle + bold swatches, from this round's DEV-PLAN task)", () => {
      it('maps both yellow swatches to yellow', () => {
        expect(hexToBgToken('#FFFAE6')).toBe('yellow');
        expect(hexToBgToken('#FFF0B3')).toBe('yellow');
      });

      it('maps both green swatches to green', () => {
        expect(hexToBgToken('#E3FCEF')).toBe('green');
        expect(hexToBgToken('#ABF5D1')).toBe('green');
      });

      it('maps both blue swatches to blue', () => {
        expect(hexToBgToken('#DEEBFF')).toBe('blue');
        expect(hexToBgToken('#B3D4FF')).toBe('blue');
      });

      it('maps both red(-pink) swatches to red', () => {
        expect(hexToBgToken('#FFEBE6')).toBe('red');
        expect(hexToBgToken('#FFBDAD')).toBe('red');
      });

      it('maps both purple swatches to purple', () => {
        expect(hexToBgToken('#EAE6FF')).toBe('purple');
        expect(hexToBgToken('#C0B6F2')).toBe('purple');
      });

      it('maps both teal swatches to teal', () => {
        expect(hexToBgToken('#E6FCFF')).toBe('teal');
        expect(hexToBgToken('#B3F5FF')).toBe('teal');
      });

      it("maps both grey swatches to gray -- via the saturation check, NOT hue (see the next test for why that order matters)", () => {
        expect(hexToBgToken('#F4F5F7')).toBe('gray');
        expect(hexToBgToken('#DFE1E6')).toBe('gray');
      });

      it('a low-saturation hex reads as gray even though its bare hue would otherwise land in the blue bucket', () => {
        // #F4F5F7 (Confluence's own grey-subtle swatch) measures h~220 s~16% --
        // 220 alone sits inside the blue bucket (202-236deg). If saturation
        // weren't checked FIRST, Confluence's own grey swatch would come out
        // "blue". This is the actual reason for the DEV-PLAN's stated order
        // ("hex -> HSL, low saturation -> gray, otherwise the nearest bucket").
        expect(hexToBgToken('#F4F5F7')).toBe('gray');
      });

      it('a saturated custom colour in the red/yellow gap maps to orange -- no Confluence swatch lands here, but the token exists for the editor\'s own palette (round 17) and for a hand-picked colour on re-import', () => {
        expect(hexToBgToken('#ff8000')).toBe('orange'); // h=30deg, centred in the 25-40deg bucket
      });

      it('a saturated pink/magenta wraps back around 360deg into red', () => {
        expect(hexToBgToken('#ffc0cb')).toBe('red'); // h=349.5deg
      });
    });

    describe('resolveBgToken', () => {
      it('resolves a recognized colour straight through to its token', () => {
        expect(resolveBgToken('#FFFAE6')).toBe('yellow');
      });

      it('returns null for missing/empty/unrecognized input, never throwing', () => {
        expect(resolveBgToken(null)).toBeNull();
        expect(resolveBgToken(undefined)).toBeNull();
        expect(resolveBgToken('')).toBeNull();
        expect(resolveBgToken('not-a-colour')).toBeNull();
      });
    });

    describe('bgClass', () => {
      it('renders "folio-bg-<token>" -- the contract shared with web/src/markdown/tableSyntax.ts (round 17)', () => {
        expect(bgClass('yellow')).toBe('folio-bg-yellow');
        expect(bgClass('gray')).toBe('folio-bg-gray');
      });
    });

    // What keeps every table in this block on the COMPLEX branch is the
    // `<details>` in a cell (round 16's shape for an expand macro inside a
    // table -- a real Confluence page shape, and one of the two structures a
    // pipe cell still genuinely cannot hold). It used to be a `<ul>`; round 28
    // gave lists a pipe representation, so a list no longer freezes a table
    // and would send these through the metadata-line branch instead. The
    // colours, the assertions and the code path under test are unchanged.
    describe('preprocessConfluenceDom: a complex table gets folio-bg-<token> classes on its cells', () => {
      it('reads data-highlight-colour and writes the class, stripping the original attribute', () => {
        const html = '<table><tr><td data-highlight-colour="#FFFAE6"><details><summary>Item</summary></details></td></tr></table>';
        const out = preprocessConfluenceDom(html, NOOP_CTX);
        expect(out).toContain('class="folio-bg-yellow"');
        expect(out).not.toContain('data-highlight-colour');
      });

      it('reads an inline style="background-color: #rrggbb" and writes the class, stripping the style', () => {
        const html = '<table><tr><td style="background-color: #DEEBFF"><details><summary>Item</summary></details></td></tr></table>';
        const out = preprocessConfluenceDom(html, NOOP_CTX);
        expect(out).toContain('class="folio-bg-blue"');
        expect(out).not.toContain('style=');
        expect(out).not.toContain('background-color');
      });

      it('reads a highlight-<hex> class and replaces it with the folio-bg-<token> class', () => {
        const html = '<table><tr><td class="highlight-FFEBE6"><details><summary>Item</summary></details></td></tr></table>';
        const out = preprocessConfluenceDom(html, NOOP_CTX);
        expect(out).toContain('class="folio-bg-red"');
        expect(out).not.toContain('highlight-FFEBE6');
      });

      it('reads a highlightColour<hex>-shaped class too (defensive form named in DEV-PLAN)', () => {
        const html = '<table><tr><td class="highlightColourABF5D1"><details><summary>Item</summary></details></td></tr></table>';
        const out = preprocessConfluenceDom(html, NOOP_CTX);
        expect(out).toContain('class="folio-bg-green"');
      });

      it('an unrecognized colour value leaves the cell with no class at all -- never throws, never guesses', () => {
        const html = '<table><tr><td data-highlight-colour="chartreuse"><details><summary>Item</summary></details></td></tr></table>';
        expect(() => preprocessConfluenceDom(html, NOOP_CTX)).not.toThrow();
        const out = preprocessConfluenceDom(html, NOOP_CTX);
        expect(out).not.toContain('folio-bg');
        expect(out).not.toContain('data-highlight-colour');
        expect(out).not.toContain('class=');
      });

      it("each of 5 columns in a card-layout row gets its own colour, matching the owner's reference case shape", () => {
        const html = `
          <table><tbody><tr>
            <td data-highlight-colour="#FFFAE6"><details><summary>A</summary></details></td>
            <td data-highlight-colour="#E3FCEF"><details><summary>B</summary></details></td>
            <td data-highlight-colour="#DEEBFF"><details><summary>C</summary></details></td>
            <td data-highlight-colour="#FFEBE6"><details><summary>D</summary></details></td>
            <td data-highlight-colour="#EAE6FF"><details><summary>E</summary></details></td>
          </tr></tbody></table>
        `;
        const out = preprocessConfluenceDom(html, NOOP_CTX);
        for (const token of ['yellow', 'green', 'blue', 'red', 'purple']) {
          expect(out).toContain(`class="folio-bg-${token}"`);
        }
      });

      it('a row-level colour (style on <tr>) fills every cell that has none of its own; a cell with its own colour keeps it', () => {
        const html = `
          <table><tr style="background-color:#E3FCEF">
            <td><details><summary>Inherits the row</summary></details></td>
            <td data-highlight-colour="#FFEBE6"><details><summary>Keeps its own</summary></details></td>
          </tr></table>
        `;
        const out = preprocessConfluenceDom(html, NOOP_CTX);
        const cells = out.match(/<td[^>]*>/g) ?? [];
        expect(cells).toHaveLength(2);
        expect(cells[0]).toContain('folio-bg-green');
        expect(cells[1]).toContain('folio-bg-red');
      });

      it('a table with no colour anywhere gets no folio-bg class (regression: matches the existing no-class-at-all assertion for a plain complex table)', () => {
        const html = '<table><tr><td class="confluenceTd"><details><summary>Plain</summary></details></td></tr></table>';
        const out = preprocessConfluenceDom(html, NOOP_CTX);
        expect(out).not.toContain('folio-bg');
      });
    });

    describe('convertPageHtml: a simple table gets the folio-table bg metadata line', () => {
      it('one coloured cell -> a metadata line directly above the table, exactly one blank line between', () => {
        const td = buildTurndownService();
        const html =
          '<table><tr><td>Name</td><td>Status</td></tr>' +
          '<tr><td data-highlight-colour="#FFFAE6">Alpha</td><td style="background-color:#E3FCEF">OK</td></tr></table>';
        const md = convertPageHtml(td, html, NOOP_CTX);

        expect(md).toContain('[//]: # (folio-table: bg=A2:yellow,B2:green)');
        const lines = md.split('\n');
        const markerIdx = lines.findIndex((l) => l.includes('folio-table: bg='));
        expect(markerIdx).toBeGreaterThanOrEqual(0);
        expect(lines[markerIdx + 1]).toBe(''); // exactly one blank line
        expect(lines[markerIdx + 2]).toMatch(/\|\s*Name\s*\|\s*Status\s*\|/); // table starts right after
        expect(md).not.toContain('¶FOLIO-TABLE-BG'); // marker never leaks
        expect(md).not.toContain('data-highlight-colour');
        expect(md).not.toContain('background-color');
      });

      it('no coloured cells -> no metadata line and no marker at all (regression: unchanged from pre-round-16b output)', () => {
        const td = buildTurndownService();
        const html = '<table><tr><td>Column A</td><td>Column B</td></tr><tr><td>Row1 A</td><td>Row1 B</td></tr></table>';
        const md = convertPageHtml(td, html, NOOP_CTX);
        expect(md).toMatch(/\|\s*Column A\s*\|\s*Column B\s*\|/);
        expect(md).toMatch(/\|\s*---\s*\|\s*---\s*\|/);
        expect(md).toMatch(/\|\s*Row1 A\s*\|\s*Row1 B\s*\|/);
        expect(md).not.toContain('folio-table');
        expect(md).not.toContain('¶FOLIO');
        expect(md.split('\n')).toHaveLength(3); // exactly the 3 pipe-table lines -- nothing extra inserted
      });

      it("a header-row cell's colour survives ensureHeadingRow's td->th rewrite (the case that would silently lose colour if read AFTER it)", () => {
        const td = buildTurndownService();
        // Zero real <th> anywhere -- the "layout table" shape this file's own
        // round-16 module comment calls out as the routine real-world case.
        // Row 0's plain <td> gets rebuilt into a fresh, attribute-less <th> by
        // ensureHeadingRow, so this only passes if colour is read BEFORE that.
        const html = '<table><tr><td data-highlight-colour="#EAE6FF">Header</td></tr><tr><td>Body</td></tr></table>';
        const md = convertPageHtml(td, html, NOOP_CTX);
        expect(md).toContain('[//]: # (folio-table: bg=A1:purple)');
      });

      it('multiple simple tables on the same page each get their own correctly-matched metadata line', () => {
        const td = buildTurndownService();
        const html = `
          <p>Intro.</p>
          <table><tr><td>H1</td></tr><tr><td data-highlight-colour="#FFFAE6">One</td></tr></table>
          <p>Between.</p>
          <table><tr><td>H2</td></tr><tr><td data-highlight-colour="#DEEBFF">Two</td></tr></table>
        `;
        const md = convertPageHtml(td, html, NOOP_CTX);
        expect(md).toContain('[//]: # (folio-table: bg=A2:yellow)');
        expect(md).toContain('[//]: # (folio-table: bg=A2:blue)');
        expect(md.indexOf('bg=A2:yellow')).toBeLessThan(md.indexOf('Two'));
        expect(md.indexOf('bg=A2:blue')).toBeGreaterThan(md.indexOf('One'));
      });
    });
  });

  describe('assignPaths (tree -> folders, translit reuse)', () => {
    it('a page with imported children becomes dir/index.md; a leaf becomes dir/page.md', () => {
      const pages = new Map<string, PathAssignable>([
        ['root', { id: 'root', title: 'Root', children: ['a', 'b'] }],
        ['a', { id: 'a', title: 'Section A', children: ['a1'] }], // goes through translitSlug
        ['a1', { id: 'a1', title: 'Leaf One', children: [] }],
        ['b', { id: 'b', title: 'Leaf B', children: [] }],
      ]);
      const rel = assignPaths('root', pages, '');
      expect(rel.get('root')).toBe('index.md');
      expect(rel.get('a')).toBe('section-a/index.md'); // has an imported child -> directory
      expect(rel.get('a1')).toBe('section-a/leaf-one.md');
      expect(rel.get('b')).toBe('leaf-b.md'); // no children -> plain file, not a directory
    });

    it('nests under a non-empty baseDir (targetPath) instead of the space root', () => {
      const pages = new Map<string, PathAssignable>([
        ['root', { id: 'root', title: 'Root', children: ['a'] }],
        ['a', { id: 'a', title: 'Child', children: [] }],
      ]);
      const rel = assignPaths('root', pages, 'imported/confluence');
      expect(rel.get('root')).toBe('imported/confluence/index.md');
      expect(rel.get('a')).toBe('imported/confluence/child.md');
    });

    it('gives colliding sibling slugs a -2, -3, ... suffix, in child order', () => {
      const pages = new Map<string, PathAssignable>([
        ['root', { id: 'root', title: 'Root', children: ['a', 'b', 'c'] }],
        ['a', { id: 'a', title: 'Notes', children: [] }],
        ['b', { id: 'b', title: 'Notes', children: [] }],
        ['c', { id: 'c', title: 'Notes', children: [] }],
      ]);
      const rel = assignPaths('root', pages, '');
      expect(rel.get('a')).toBe('notes.md');
      expect(rel.get('b')).toBe('notes-2.md');
      expect(rel.get('c')).toBe('notes-3.md');
    });

    it('a child whose page was never fetched (e.g. filtered by includeChildren=false) is simply skipped, not a dangling directory', () => {
      const pages = new Map<string, PathAssignable>([['root', { id: 'root', title: 'Root', children: ['ghost'] }]]);
      const rel = assignPaths('root', pages, '');
      expect(rel.get('root')).toBe('index.md'); // root itself has no FETCHED children -> stays a leaf-shaped root (still index.md, since it's the root)
      expect(rel.has('ghost')).toBe(false);
    });
  });

  describe('composePageBody (round 19 point 5b: valid `[!NOTE]` placeholder for a page that converted to nothing)', () => {
    it('a page with real converted content is used as-is -- no placeholder inserted', () => {
      const body = composePageBody('Hello', 'Some **real** content.');
      expect(body).toBe('# Hello\n\nSome **real** content.\n');
      expect(body).not.toContain('[!NOTE]');
    });

    it('an empty conversion result (genuinely blank page, or macro-only content this importer drops) gets a `[!NOTE]` placeholder -- valid bracket syntax, never the broken `> !NOTE`', () => {
      const body = composePageBody('Empty Page', '');
      expect(body).toContain('# Empty Page');
      expect(body).toContain('> [!NOTE]');
      expect(body).not.toMatch(/>\s*!NOTE(?!\])/); // never the broken bracket-less form
    });

    it('a conversion result that is whitespace-only is treated the same as empty', () => {
      const body = composePageBody('Whitespace Only', '   \n\n  ');
      expect(body).toContain('> [!NOTE]');
    });
  });
});

/**
 * Spins a real, minimal local Confluence-shaped server for ONE page (no
 * children, no attachments) — enough to exercise startImportJob's full
 * happy path with no real network access. `authHeaders` records every
 * incoming request's raw Authorization header (round 22b's own tests use
 * this to prove a resolved credential's decrypted token was ACTUALLY sent,
 * not just returned by resolveImportAuth) — additive, unused by the
 * pre-existing tests below.
 */
function startMockConfluence(pageId: string, title: string, exportHtml: string): Promise<{ base: string; server: http.Server; authHeaders: string[] }> {
  return new Promise((resolve) => {
    const authHeaders: string[] = [];
    const server = http.createServer((req, res) => {
      authHeaders.push(req.headers.authorization ?? '');
      const url = new URL(req.url ?? '/', 'http://internal');
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === `/wiki/rest/api/content/${pageId}/child/page`) {
        res.end(JSON.stringify({ results: [], size: 0 }));
      } else if (url.pathname === `/wiki/rest/api/content/${pageId}/child/attachment`) {
        res.end(JSON.stringify({ results: [] }));
      } else if (url.pathname === `/wiki/rest/api/content/${pageId}`) {
        res.end(JSON.stringify({ id: pageId, title, ancestors: [], body: { export_view: { value: exportHtml } } }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ message: `mock: no handler for ${url.pathname}` }));
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, server, authHeaders });
    });
  });
}

describe('confluenceImport.ts: targetSpace bug fix (real PG + a real local mock server, no real Confluence)', () => {
  let teardownSchema: () => Promise<void>;
  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  describe('resolveOrCreateTargetSpace', () => {
    it('a name that matches no existing space (by slug or by translit) creates a new one, with the caller as admin', async () => {
      const user = await authStore.createUser({ email: 'new-space@confimport-test.local', name: 'Owner', passwordHash: 'x', isAdmin: false });
      const name = `Brand New Space ${Date.now()}`;
      const resolved = await resolveOrCreateTargetSpace(name, user.id);
      expect(resolved.isNew).toBe(true);
      expect(await storage.spaceExists(resolved.slug)).toBe(true);
      expect(await authStore.getMembershipRole(resolved.slug, user.id)).toBe('admin');
      await deleteTestSpace(resolved.slug);
    });

    it('an input that IS already an existing slug resolves to it, isNew:false (no duplicate created)', async () => {
      const user = await authStore.createUser({ email: 'existing-slug@confimport-test.local', name: 'Owner', passwordHash: 'x', isAdmin: false });
      const existing = await storage.createSpace(`Pre Existing ${Date.now()}`, user.id);
      const resolved = await resolveOrCreateTargetSpace(existing.slug, user.id);
      expect(resolved).toEqual({ slug: existing.slug, isNew: false });
      await deleteTestSpace(existing.slug);
    });

    it('a NAME that translit-slugs to an already-existing space resolves to THAT space, not a fresh "-2" duplicate', async () => {
      const user = await authStore.createUser({ email: 'translit-match@confimport-test.local', name: 'Owner', passwordHash: 'x', isAdmin: false });
      const stamp = Date.now();
      const existing = await storage.createSpace(`Engineering Docs ${stamp}`, user.id); // slug becomes "engineering-docs-<stamp>"-ish (translit'd + lowercased)
      // Re-typing the EXACT same display name (as "new space" mode's free-text field would) must resolve to the space that name already maps to, not create a near-duplicate.
      const resolved = await resolveOrCreateTargetSpace(`Engineering Docs ${stamp}`, user.id);
      expect(resolved).toEqual({ slug: existing.slug, isNew: false });
      const allWithPrefix = (await storage.listSpaces()).filter((s) => s.slug.startsWith(`engineering-docs-${stamp}`));
      expect(allWithPrefix.length).toBe(1); // exactly the original -- no "-2" sibling got created
      await deleteTestSpace(existing.slug);
    });
  });

  it('THE BUG, reproduced then fixed: importing into a nonexistent target-space NAME creates the space (creator admin) and the job proceeds past space resolution into the actual network walk', async () => {
    const user = await authStore.createUser({ email: 'proceeds@confimport-test.local', name: 'Owner', passwordHash: 'x', isAdmin: false });
    const desiredName = `New Import Target ${Date.now()}`;

    // Mirrors exactly what the route now does: resolve/create BEFORE starting the job.
    const resolved = await resolveOrCreateTargetSpace(desiredName, user.id);
    expect(resolved.isNew).toBe(true);
    expect(await storage.spaceExists(resolved.slug)).toBe(true);
    expect(await authStore.getMembershipRole(resolved.slug, user.id)).toBe('admin');

    const job = startImportJob(
      {
        pageUrl: 'https://nonexistent-confluence-host-xyz.invalid/wiki/spaces/ENG/pages/999/Test',
        auth: { kind: 'pat', token: 'irrelevant-for-this-test' },
        targetPath: '',
        includeChildren: false,
        targetSpace: resolved.slug,
      },
      user.id,
      { name: user.name, email: user.email },
    );
    // Pre-fix, this never even got this far: the ROUTE itself 404'd on "space not
    // found" before startImportJob was ever called. Now the job's targetSpace is
    // correct from its very first (queued/running) state, not just once it finishes.
    expect(job.targetSpace).toBe(resolved.slug);

    await pollUntil(() => getJob(job.id)?.status === 'error', 15_000);
    expect(getJob(job.id)?.error).toBeTruthy();
    expect(getJob(job.id)?.error).not.toContain('irrelevant-for-this-test'); // token never leaks into the error

    // The space itself is untouched by the later network failure -- it was
    // already fully created (and the creator already admin) before the walk began.
    expect(await storage.spaceExists(resolved.slug)).toBe(true);
    expect(await authStore.getMembershipRole(resolved.slug, user.id)).toBe('admin');

    await deleteTestSpace(resolved.slug);
    // Real PG + git init + a mock HTTP server: under a full parallel suite this
    // brushes against the default 5s (seen at 5006ms) while passing comfortably
    // in isolation.
  }, 15_000);

  it('HAPPY PATH end-to-end against a real local mock Confluence server: new space created, page imported, content correct, job reaches done', async () => {
    const user = await authStore.createUser({ email: 'happy-path@confimport-test.local', name: 'Owner', passwordHash: 'x', isAdmin: false });
    const { base, server } = await startMockConfluence('42', 'Hello From Mock Confluence', '<p>Hello <strong>world</strong>.</p>');
    let slug: string | undefined;
    try {
      const desiredName = `Happy Path Import ${Date.now()}`;
      const resolved = await resolveOrCreateTargetSpace(desiredName, user.id);
      slug = resolved.slug;

      const job = startImportJob(
        { pageUrl: `${base}/wiki/spaces/ENG/pages/42/Hello`, auth: { kind: 'pat', token: 'mock-token' }, targetPath: '', includeChildren: false, targetSpace: resolved.slug },
        user.id,
        { name: user.name, email: user.email },
      );

      await pollUntil(() => getJob(job.id)?.status === 'done', 15_000);
      expect(getJob(job.id)?.error).toBeNull();
      expect(getJob(job.id)?.targetSpace).toBe(resolved.slug);

      const rootPage = await storage.resolve(resolved.slug, ''); // '' -> falls back to the space's own index.md
      const body = await storage.readFreshDocBody(rootPage.id);
      expect(body).toContain('# Hello From Mock Confluence');
      expect(body).toContain('Hello **world**.');
    } finally {
      await new Promise((r) => server.close(r));
      if (slug) await deleteTestSpace(slug);
    }
  }, 20_000); // vitest's default 5s test-level timeout is shorter than the pollUntil ceiling above

  it('round 19 point 5b, end-to-end: a genuinely empty Confluence page imports with a valid `[!NOTE]` placeholder, not a blank body', async () => {
    const user = await authStore.createUser({ email: 'empty-page@confimport-test.local', name: 'Owner', passwordHash: 'x', isAdmin: false });
    // export_view for a page that's blank in Confluence -- e.g. a title-only "folder" page -- often comes back as just a stray empty paragraph.
    const { base, server } = await startMockConfluence('43', 'An Empty Page', '<p> </p>');
    let slug: string | undefined;
    try {
      const desiredName = `Empty Page Import ${Date.now()}`;
      const resolved = await resolveOrCreateTargetSpace(desiredName, user.id);
      slug = resolved.slug;

      const job = startImportJob(
        { pageUrl: `${base}/wiki/spaces/ENG/pages/43/Empty`, auth: { kind: 'pat', token: 'mock-token' }, targetPath: '', includeChildren: false, targetSpace: resolved.slug },
        user.id,
        { name: user.name, email: user.email },
      );

      await pollUntil(() => getJob(job.id)?.status === 'done', 15_000);
      expect(getJob(job.id)?.error).toBeNull();

      const rootPage = await storage.resolve(resolved.slug, '');
      const body = await storage.readFreshDocBody(rootPage.id);
      expect(body).toContain('# An Empty Page');
      expect(body).toContain('> [!NOTE]'); // valid bracket syntax -- what web/src/markdown/alerts.ts actually recognizes
      expect(body).not.toMatch(/>\s*!NOTE(?!\])/); // never the broken bracket-less form seen in prod
    } finally {
      await new Promise((r) => server.close(r));
      if (slug) await deleteTestSpace(slug);
    }
  }, 20_000);

  describe('resolveImportAuth (round 22b: saved Confluence credentials -- credentialId / save=true)', () => {
    it('rejects a credentialId that does not exist, or belongs to someone else, with a 404 -- never a 403 that would confirm the id is real', async () => {
      const owner = await authStore.createUser({ email: 'resolve-auth-owner@confimport-test.local', name: 'Owner', passwordHash: 'x', isAdmin: false });
      const intruder = await authStore.createUser({ email: 'resolve-auth-intruder@confimport-test.local', name: 'Intruder', passwordHash: 'x', isAdmin: false });
      const cred = await userConfluenceCredentials.saveCredential(owner.id, 'wiki.resolve-auth-test.com', 'pat', 'owner-only-token');

      await expect(
        resolveImportAuth(intruder.id, 'https://wiki.resolve-auth-test.com/wiki/spaces/X/pages/1/Y', { credentialId: cred.id }),
      ).rejects.toMatchObject({ status: 404 });

      await expect(
        resolveImportAuth(intruder.id, 'https://wiki.resolve-auth-test.com/wiki/spaces/X/pages/1/Y', { credentialId: randomUUID() }),
      ).rejects.toMatchObject({ status: 404 });

      // ...but the owner's own credentialId still resolves fine.
      const auth = await resolveImportAuth(owner.id, 'https://wiki.resolve-auth-test.com/wiki/spaces/X/pages/1/Y', { credentialId: cred.id });
      expect(auth).toEqual({ kind: 'pat', token: 'owner-only-token' });
    });

    it('rejects a call with neither credentialId nor auth (defensive -- the route\'s own confluenceImportBodySchema already enforces this before a real request gets here)', async () => {
      const user = await authStore.createUser({ email: 'resolve-auth-neither@confimport-test.local', name: 'Neither', passwordHash: 'x', isAdmin: false });
      await expect(resolveImportAuth(user.id, 'https://example.com/wiki/spaces/X/pages/1/Y', {})).rejects.toMatchObject({ status: 400 });
    });

    it('a "pat" credentialId resolves to a Bearer auth object, and a full import run actually sends the DECRYPTED token as the Authorization header', async () => {
      const user = await authStore.createUser({ email: 'resolve-auth-happy@confimport-test.local', name: 'Owner', passwordHash: 'x', isAdmin: false });
      const { base, server, authHeaders } = await startMockConfluence('50', 'Via Saved Credential', '<p>Body.</p>');
      let slug: string | undefined;
      try {
        const host = new URL(base).host;
        const cred = await userConfluenceCredentials.saveCredential(user.id, host, 'pat', 'saved-pat-token');

        const pageUrl = `${base}/wiki/spaces/ENG/pages/50/Hello`;
        const auth = await resolveImportAuth(user.id, pageUrl, { credentialId: cred.id });
        expect(auth).toEqual({ kind: 'pat', token: 'saved-pat-token' });

        const resolved = await resolveOrCreateTargetSpace(`Via Credential ${Date.now()}`, user.id);
        slug = resolved.slug;
        const job = startImportJob(
          { pageUrl, auth, targetPath: '', includeChildren: false, targetSpace: resolved.slug },
          user.id,
          { name: user.name, email: user.email },
        );
        await pollUntil(() => getJob(job.id)?.status === 'done', 15_000);
        expect(getJob(job.id)?.error).toBeNull();

        expect(authHeaders).toContain('Bearer saved-pat-token'); // proves the DECRYPTED token was actually used, not just returned
      } finally {
        await new Promise((r) => server.close(r));
        if (slug) await deleteTestSpace(slug);
      }
    }, 20_000);

    it('a "cloud" credentialId resolves to a Basic auth object built from the decrypted token + stored email, sent as such over the wire', async () => {
      const user = await authStore.createUser({ email: 'resolve-auth-cloud@confimport-test.local', name: 'Cloud Owner', passwordHash: 'x', isAdmin: false });
      const { base, server, authHeaders } = await startMockConfluence('51', 'Via Cloud Credential', '<p>Body.</p>');
      let slug: string | undefined;
      try {
        const host = new URL(base).host;
        const cred = await userConfluenceCredentials.saveCredential(user.id, host, 'cloud', 'atl-token', { email: 'me@example.com' });

        const pageUrl = `${base}/wiki/spaces/ENG/pages/51/Hello`;
        const auth = await resolveImportAuth(user.id, pageUrl, { credentialId: cred.id });
        expect(auth).toEqual({ kind: 'basic', token: 'atl-token', email: 'me@example.com' }); // 'cloud' (stored) <-> 'basic' (wire) -- see confluenceImport.ts's own comment on this mapping

        const resolved = await resolveOrCreateTargetSpace(`Via Cloud Credential ${Date.now()}`, user.id);
        slug = resolved.slug;
        const job = startImportJob(
          { pageUrl, auth, targetPath: '', includeChildren: false, targetSpace: resolved.slug },
          user.id,
          { name: user.name, email: user.email },
        );
        await pollUntil(() => getJob(job.id)?.status === 'done', 15_000);
        expect(getJob(job.id)?.error).toBeNull();

        const expectedHeader = `Basic ${Buffer.from('me@example.com:atl-token').toString('base64')}`;
        expect(authHeaders).toContain(expectedHeader);
      } finally {
        await new Promise((r) => server.close(r));
        if (slug) await deleteTestSpace(slug);
      }
    }, 20_000);

    it('save=true persists a raw one-off credential, and a REPEAT import against the same host then succeeds via credentialId alone, with no raw token in sight', async () => {
      const user = await authStore.createUser({ email: 'resolve-auth-save@confimport-test.local', name: 'Saver', passwordHash: 'x', isAdmin: false });
      const { base, server, authHeaders } = await startMockConfluence('52', 'Save Then Reuse', '<p>Body.</p>');
      let slug1: string | undefined;
      let slug2: string | undefined;
      try {
        const pageUrl = `${base}/wiki/spaces/ENG/pages/52/Hello`;
        const host = new URL(base).host;

        // First run: raw token + save=true -- nothing saved for this host yet.
        expect(await userConfluenceCredentials.getDecryptedTokenForHost(user.id, host)).toBeUndefined();
        const firstAuth = await resolveImportAuth(user.id, pageUrl, { auth: { kind: 'pat', token: 'first-run-token' }, save: true });
        expect(firstAuth).toEqual({ kind: 'pat', token: 'first-run-token' }); // the import itself still uses the raw auth as given, save is a side effect

        const resolved1 = await resolveOrCreateTargetSpace(`Save Then Reuse 1 ${Date.now()}`, user.id);
        slug1 = resolved1.slug;
        const job1 = startImportJob(
          { pageUrl, auth: firstAuth, targetPath: '', includeChildren: false, targetSpace: resolved1.slug },
          user.id,
          { name: user.name, email: user.email },
        );
        await pollUntil(() => getJob(job1.id)?.status === 'done', 15_000);
        expect(getJob(job1.id)?.error).toBeNull();

        // The credential is now saved for this host, decrypted token intact.
        expect(await userConfluenceCredentials.getDecryptedTokenForHost(user.id, host)).toEqual({ token: 'first-run-token', kind: 'pat' });

        // "Repeat import": credentialId ONLY, no raw token anywhere in this call -- must resolve to the SAME saved token.
        const list = await userConfluenceCredentials.listForUser(user.id);
        const credentialId = list.find((c) => c.host === host)!.id;
        const secondAuth = await resolveImportAuth(user.id, pageUrl, { credentialId });
        expect(secondAuth).toEqual({ kind: 'pat', token: 'first-run-token' });

        const resolved2 = await resolveOrCreateTargetSpace(`Save Then Reuse 2 ${Date.now()}`, user.id);
        slug2 = resolved2.slug;
        const job2 = startImportJob(
          { pageUrl, auth: secondAuth, targetPath: '', includeChildren: false, targetSpace: resolved2.slug },
          user.id,
          { name: user.name, email: user.email },
        );
        await pollUntil(() => getJob(job2.id)?.status === 'done', 15_000);
        expect(getJob(job2.id)?.error).toBeNull();

        // Both runs actually authenticated on the wire with the SAME decrypted token.
        expect(authHeaders.filter((h) => h === 'Bearer first-run-token').length).toBeGreaterThanOrEqual(2);
      } finally {
        await new Promise((r) => server.close(r));
        if (slug1) await deleteTestSpace(slug1);
        if (slug2) await deleteTestSpace(slug2);
      }
    }, 30_000);

    it('save=true with a cloud auth missing an email fails the save with a 400 -- no partial/invalid row left behind', async () => {
      const user = await authStore.createUser({ email: 'resolve-auth-save-bad@confimport-test.local', name: 'BadSave', passwordHash: 'x', isAdmin: false });
      await expect(
        resolveImportAuth(user.id, 'https://wiki.save-bad-test.com/wiki/spaces/X/pages/1/Y', { auth: { kind: 'basic', token: 'tok' }, save: true }),
      ).rejects.toMatchObject({ status: 400 });
      expect(await userConfluenceCredentials.getDecryptedTokenForHost(user.id, 'wiki.save-bad-test.com')).toBeUndefined();
    });
  });
});

describe('emoticons -> text (cloud custom / server codepoint / legacy class)', () => {
  it('converts a Cloud atlassian-custom emoji whose fallback is its own shortcode', () => {
    expect(
      emoticonToText({ fallback: ':check_mark:', shortname: ':check_mark:', emojiId: 'atlassian-check_mark', alt: null, className: 'emoticon emoticon-tick' }),
    ).toBe('✅');
    expect(
      emoticonToText({ fallback: ':minus:', shortname: ':minus:', emojiId: 'atlassian-minus', alt: null, className: 'emoticon emoticon-minus' }),
    ).toBe('➖');
  });

  it('keeps a real unicode fallback as-is', () => {
    expect(emoticonToText({ fallback: '🚩', shortname: ':triangular_flag_on_post:', emojiId: '1f6a9', alt: null, className: 'emoticon emoticon-blue-star' })).toBe('🚩');
  });

  it('derives the emoji from hex codepoints when Server/DC gives no fallback (words-y alt must lose)', () => {
    expect(
      emoticonToText({ fallback: null, shortname: ':triangular_flag_on_post:', emojiId: '1f6a9', alt: 'triangular flag', className: 'emoticon emoticon-1f6a9' }),
    ).toBe('🚩');
    expect(emoticonToText({ fallback: null, shortname: null, emojiId: '1f441-fe0f', alt: 'eye', className: 'emoticon' })).toBe('👁️');
  });

  it('maps a legacy Server emoticon by its class when nothing else is present', () => {
    expect(emoticonToText({ fallback: null, shortname: null, emojiId: null, alt: '(thumbs up)', className: 'emoticon emoticon-thumbs-up' })).toBe('👍');
  });

  it('falls back to the shortcode text for a completely unknown emoji', () => {
    expect(emoticonToText({ fallback: ':mystery_thing:', shortname: ':mystery_thing:', emojiId: 'atlassian-mystery_thing', alt: null, className: 'emoticon' })).toBe(':mystery_thing:');
  });

  it('convertPageHtml end-to-end: cloud custom emoticon lands as emoji, not shortcode', () => {
    const td = buildTurndownService();
    const html = '<p>done <img class="emoticon emoticon-tick" data-emoji-id="atlassian-check_mark" data-emoji-shortname=":check_mark:" data-emoji-fallback=":check_mark:" src="/x.png"/> yes</p>';
    const md = convertPageHtml(td, html, NOOP_CTX);
    expect(md).toContain('done ✅ yes');
  });
});

describe('extractConfluenceContentId: every real link shape from the migration inventory', () => {
  it('handles pages, edit-v2, folder, whiteboard, database and viewpage forms', () => {
    expect(extractConfluenceContentId('https://x.atlassian.net/wiki/spaces/DOCS/pages/123/T?atlOrigin=abc')).toEqual({ id: '123', kind: 'page' });
    expect(extractConfluenceContentId('https://x.atlassian.net/wiki/spaces/DOCS/pages/edit-v2/456')).toEqual({ id: '456', kind: 'page' });
    expect(extractConfluenceContentId('https://x.atlassian.net/wiki/spaces/DOCS/folder/789?a=1')).toEqual({ id: '789', kind: 'folder' });
    expect(extractConfluenceContentId('https://x.atlassian.net/wiki/spaces/DOCS/whiteboard/321?atl_f=PAGETREE')).toEqual({ id: '321', kind: 'whiteboard' });
    expect(extractConfluenceContentId('https://x.atlassian.net/wiki/spaces/DOCS/database/654')).toEqual({ id: '654', kind: 'database' });
    expect(extractConfluenceContentId('https://tracker.example/wiki/pages/viewpage.action?pageId=999&x=1')).toEqual({ id: '999', kind: 'page' });
    expect(extractConfluenceContentId('https://x.atlassian.net/wiki/spaces/DOCS/overview')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The "import Confluence properly" round. Every fixture string below is
// VERBATIM markup from a real Confluence page (captured under
// .qa/imp/, which is not committed — hence inlined here rather than read from
// disk), trimmed to the smallest excerpt that still reproduces the defect.
// ---------------------------------------------------------------------------

/** Page 1651081222 "Widget 2.0": a `jira` macro whose applink is down. */
const JIRA_EXPORT_HTML =
  '<ul><li><p>multi-scenario widget<span class="aui-message aui-message-warning jim-error-message jim-error-message-single">\n' +
  '        <span class="icon-in-pdf"></span>\n     Unable to render Jira issues macro, execution error.\n    </span>\n </p></li></ul>';
const JIRA_STORAGE_XML =
  '<p>multi-scenario widget<ac:structured-macro ac:name="jira" ac:schema-version="1" ac:macro-id="00000000-0000-4000-8000-000000000001">' +
  '<ac:parameter ac:name="key">PROJ-37</ac:parameter><ac:parameter ac:name="serverId">00000000-0000-4000-8000-000000000000</ac:parameter>' +
  '<ac:parameter ac:name="server">System Jira</ac:parameter></ac:structured-macro></p>';

/** A real on-prem page: an `atlassian-*` emoticon the
 *  on-prem renderer drops entirely — note it is simply ABSENT from the export. */
const EMOTICON_EXPORT_HTML = '<p><strong> Problems the team sees (and proposed solutions)</strong></p>';
const EMOTICON_STORAGE_XML =
  '<p><ac:emoticon ac:name="warning" ac:emoji-id="atlassian-warning" /><strong> Problems the team sees (and proposed solutions)</strong></p>';

describe('storage-format repairs: what export_view failed to render or never emitted', () => {
  describe('jira macros (245 pages of the reference space)', () => {
    it('extracts every issue key from the storage source, in document order', () => {
      expect(extractJiraIssueKeys(JIRA_STORAGE_XML)).toEqual(['PROJ-37']);
      expect(extractJiraIssueKeys(JIRA_STORAGE_XML + JIRA_STORAGE_XML.replace('PROJ-37', 'DEMO-1243'))).toEqual(['PROJ-37', 'DEMO-1243']);
      expect(extractJiraIssueKeys('<p>no macros here</p>')).toEqual([]);
    });

    it('replaces the rendered error sentence with the issue key the author actually wrote', () => {
      const md = convertPageHtml(buildTurndownService(), JIRA_EXPORT_HTML, { ...NOOP_CTX, storageXml: JIRA_STORAGE_XML });
      expect(md).not.toContain('Unable to render Jira issues macro');
      expect(md).toContain('multi-scenario widget PROJ-37'); // and not glued onto the last word
    });

    it('links the key when the caller knows where this instance\'s Jira lives', () => {
      const md = convertPageHtml(buildTurndownService(), JIRA_EXPORT_HTML, {
        ...NOOP_CTX,
        storageXml: JIRA_STORAGE_XML,
        jiraBrowseUrl: (key) => `https://jira.example.com/browse/${key}`,
      });
      expect(md).toContain('[PROJ-37](https://jira.example.com/browse/PROJ-37)');
    });

    it('drops the error sentence rather than guessing when the macro/error counts disagree', () => {
      // Two error spans, one macro: the Nth-span-is-the-Nth-macro pairing this
      // relies on cannot hold, so nothing is paired — but the error text still
      // must not survive into the page.
      const md = convertPageHtml(buildTurndownService(), JIRA_EXPORT_HTML + JIRA_EXPORT_HTML, { ...NOOP_CTX, storageXml: JIRA_STORAGE_XML });
      expect(md).not.toContain('Unable to render Jira issues macro');
      expect(md).not.toContain('PROJ-37');
    });

    it('leaves the HTML untouched when no storage was fetched at all', () => {
      expect(applyStorageRepairs(JIRA_EXPORT_HTML, '')).toBe(JIRA_EXPORT_HTML);
    });
  });

  describe('classic <ac:emoticon> the on-prem renderer drops (>300 pages of the reference space)', () => {
    it('puts an atlassian-* emoticon back exactly where its author wrote it', () => {
      const md = convertPageHtml(buildTurndownService(), EMOTICON_EXPORT_HTML, { ...NOOP_CTX, storageXml: EMOTICON_STORAGE_XML });
      expect(md).toBe('**⚠️ Problems the team sees (and proposed solutions)**');
    });

    it('places each of several emoticons against its own anchor text, in order', () => {
      const exportHtml = '<ul><li>First list item</li><li>Second list item</li><li>Third list item</li></ul>';
      const storageXml =
        '<ul><li><ac:emoticon ac:name="tick" ac:emoji-id="atlassian-check_mark" />First list item</li>' +
        '<li><ac:emoticon ac:name="cross" ac:emoji-id="atlassian-cross_mark" />Second list item</li>' +
        '<li><ac:emoticon ac:name="question" ac:emoji-id="atlassian-question_mark" />Third list item</li></ul>';
      const md = convertPageHtml(buildTurndownService(), exportHtml, { ...NOOP_CTX, storageXml });
      expect(md).toContain('-   ✅ First list item');
      expect(md).toContain('-   ❌ Second list item');
      expect(md).toContain('-   ❓ Third list item');
    });

    it('never duplicates an emoticon the renderer DID emit (unicode codepoint ids)', () => {
      // 1651081222's own shape: ac:emoji-id="2b50" renders as an <img>, so the
      // storage pass must leave it alone. Measured across the ten fixtures:
      // unicode-id emoticons in storage == <img class="emoticon"> in export, on
      // every page.
      const exportHtml = '<p>Rating <img class="emoticon emoticon-2b50" data-emoji-id="2b50" alt="star" src="/x.png"/> high</p>';
      const storageXml = '<p>Rating <ac:emoticon ac:name="blue-star" ac:emoji-id="2b50" /> high</p>';
      const md = convertPageHtml(buildTurndownService(), exportHtml, { ...NOOP_CTX, storageXml });
      expect(md).toBe('Rating ⭐ high');
    });

    it('skips an emoticon whose surrounding text is nowhere in the render, rather than misplacing it', () => {
      const md = convertPageHtml(buildTurndownService(), '<p>A completely different text</p>', {
        ...NOOP_CTX,
        storageXml: EMOTICON_STORAGE_XML,
      });
      expect(md).toBe('A completely different text');
    });
  });
});

describe('export_view cruft that leaked into the page body', () => {
  it('removes a single-quoted toc-macro div — the shape on-prem actually writes (175 pages of the reference space)', () => {
    const html =
      "<p>Before.</p><div class='toc-macro rbtoc1788086156812'>\n<ul class='toc-indentation'>\n" +
      "<li><a href='#Widget2.0-Crisp'>Crisp</a></li>\n</ul>\n</div><p>After.</p>";
    expect(stripConfluenceCruft(html)).not.toContain('Crisp');
    const md = convertPageHtml(buildTurndownService(), html, NOOP_CTX);
    expect(md).toBe('Before.\n\nAfter.');
  });

  it('drops the <style> block a toc macro drags along, empty C comment and all (163 pages of the reference space)', () => {
    const html =
      "<p>Before.</p><style type='text/css'>/*<![CDATA[*/\ndiv.rbtoc1788086156812 {padding: 0px;}\n/*]]>*/</style><p>After.</p>";
    const md = convertPageHtml(buildTurndownService(), html, NOOP_CTX);
    expect(md).toBe('Before.\n\nAfter.');
    expect(md).not.toContain('*');
  });
});

describe('callouts, panels and code blocks', () => {
  const infoMacro = (kind: string, label: string, body: string): string =>
    `<div role="region" aria-label="${label}" class="confluence-information-macro  confluence-information-macro-${kind}" >` +
    `<span role="presentation" class="aui-icon aui-icon-small aui-iconfont-warning confluence-information-macro-icon" ></span>` +
    `<div class="confluence-information-macro-body"><p>${body}</p></div></div>`;

  it('maps each Confluence callout kind to its own GFM alert instead of collapsing all of them to NOTE', () => {
    const td = buildTurndownService();
    expect(convertPageHtml(td, infoMacro('note', 'Note', 'The process needs a description!'), NOOP_CTX)).toContain('> [!WARNING]');
    expect(convertPageHtml(td, infoMacro('warning', 'Warning', 'Careful'), NOOP_CTX)).toContain('> [!CAUTION]');
    expect(convertPageHtml(td, infoMacro('information', 'Info', 'For your information'), NOOP_CTX)).toContain('> [!NOTE]');
    expect(convertPageHtml(td, infoMacro('tip', 'Tip', 'A piece of advice'), NOOP_CTX)).toContain('> [!TIP]');
  });

  it('quotes a callout exactly once — the inner -body div must not produce a second nested alert', () => {
    const md = convertPageHtml(buildTurndownService(), infoMacro('note', 'Note', 'The process needs a description!'), NOOP_CTX);
    expect(md.match(/\[!WARNING\]/g)).toHaveLength(1);
    expect(md).not.toContain('> >');
    expect(md).toBe('> [!WARNING]\n> The process needs a description!');
  });

  it('keeps a bare `panel` macro\'s heading as a real heading instead of burying it in a blockquote', () => {
    // 13 of the 14 `panel` macros across the fixtures wrap nothing but a
    // section heading — Confluence's "coloured box", not a callout.
    const html =
      '<div class="panel" style="background-color: #DEEBFF;border-width: 1px;"><div class="panelContent" style="background-color: #DEEBFF;">\n' +
      '<h3 id="x-Prioritization"><strong>Task prioritization and the task flow</strong></h3>\n</div></div>';
    const md = convertPageHtml(buildTurndownService(), html, NOOP_CTX);
    expect(md).toContain('## **Task prioritization and the task flow**');
    expect(md).not.toContain('[!NOTE]');
  });

  it('still treats a bare `panel` holding plain prose as a note', () => {
    const html = '<div class="panel"><div class="panelContent">\n<p>The documentation portal.</p>\n</div></div>';
    expect(convertPageHtml(buildTurndownService(), html, NOOP_CTX)).toBe('> [!NOTE]\n> The documentation portal.');
  });

  it('does not wrap a `code` macro in a callout — its own div carries the class `panel` (93 pages of the reference space)', () => {
    const html =
      '<div class="code panel pdl" style="border-width: 1px;"><div class="codeContent panelContent pdl">\n' +
      '<pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: jscript; gutter: false">Acme client\n  ▼\n  Product</pre>\n</div></div>';
    const md = convertPageHtml(buildTurndownService(), html, NOOP_CTX);
    expect(md).toBe('```jscript\nAcme client\n  ▼\n  Product\n```');
    expect(md).not.toContain('>');
  });
});

describe('table classification against real Confluence markup', () => {
  /** Page 1651081222's own table: a <colgroup>, and every cell's content wrapped in a <p>. */
  const COLGROUP_TABLE =
    '<table data-table-width="760" data-layout="default" class="confluenceTable"><colgroup><col style="width: 413.0px;"/>' +
    '<col style="width: 93.0px;"/></colgroup><tbody>\n<tr><th class="confluenceTh"><p><strong>Wish</strong></p></th>' +
    '<th class="confluenceTh"><p><strong>Priority</strong></p></th></tr>\n' +
    '<tr><td class="confluenceTd"><p>Multi-scenario mode</p></td><td class="confluenceTd"><p>HIGH</p></td></tr>\n</tbody></table>';

  it('converts a colgroup+<p>-in-every-cell table to a real pipe table (was raw HTML on 25 of 44 fixture tables)', () => {
    const md = convertPageHtml(buildTurndownService(), COLGROUP_TABLE, NOOP_CTX);
    expect(md).not.toContain('<table');
    expect(md).toContain('| **Wish** | **Priority** |');
    expect(md).toContain('| Multi-scenario mode | HIGH |');
  });

  it('joins a cell\'s several paragraphs with <br> rather than giving up on the whole table', () => {
    const html =
      '<table><tbody><tr><td><p>Heading</p></td><td><p>First line.</p><p>Second line.</p></td></tr>' +
      '<tr><td><p>More</p></td><td><p>One.</p></td></tr></tbody></table>';
    const md = convertPageHtml(buildTurndownService(), html, NOOP_CTX);
    expect(md).not.toContain('<table');
    expect(md).toContain('| First line.<br>Second line. |');
  });

  it('converts a table with a real list in a cell to a pipe table, the list written as round 28 cell lines (was raw HTML until round 28)', () => {
    const html =
      '<table><tbody><tr><td><p>Responsible</p></td><td><ul><li><p>C-level</p></li><li><p>Customer</p></li></ul></td></tr></tbody></table>';
    const md = convertPageHtml(buildTurndownService(), html, NOOP_CTX);
    expect(md).not.toContain('<table');
    expect(md).toContain('| Responsible | • C-level<br>• Customer |');
  });

  it('converts an emoticon inside a list-bearing table cell to the emoji, not to its English alt text', () => {
    const html =
      '<table><tbody><tr><td><ul><li>Tool <img class="emoticon emoticon-2692" data-emoji-id="2692" alt="hammer and pick" src="/x.png"/></li></ul></td></tr></tbody></table>';
    const md = convertPageHtml(buildTurndownService(), html, NOOP_CTX);
    expect(md).toContain('⚒');
    expect(md).not.toContain('hammer and pick');
  });
});

/**
 * Round 28 — a list inside a table cell.
 *
 * The format under test is NORMATIVELY web/src/markdown/tableSyntax.ts's
 * "lists inside a cell" section (`parseCellLines`/`formatCellLines`): lines
 * split on `<br>`, `•` for a bullet item and `1.` for a numbered one, two
 * spaces of indent per nesting level before the marker, and a line without a
 * marker is a plain paragraph line in the same cell. Asserted here as literal
 * strings rather than by importing that module: `server/**` is its own
 * tsconfig project and does not reach into `web/**` — the importer's job is
 * to WRITE this shape, and a literal is the most direct statement of it.
 */
describe('round 28: a list inside a table cell', () => {
  const cellOf = (md: string, row = 2): string => {
    const line = md.split('\n').filter((l) => l.startsWith('|'))[row] ?? '';
    return line;
  };

  it('a one-level bullet list becomes `• ` lines joined by <br>, and the table becomes a real pipe table', () => {
    const html =
      '<table><tbody><tr><td>What to do</td><td>Who</td></tr>' +
      '<tr><td><ul><li>collect requirements</li><li>agree with the client</li></ul></td><td>BA</td></tr></tbody></table>';
    const md = convertPageHtml(buildTurndownService(), html, NOOP_CTX);
    expect(md).not.toContain('<table');
    expect(md).not.toContain('<ul>');
    expect(md).toContain('| • collect requirements<br>• agree with the client | BA |');
  });

  it('a nested list keeps its level: two spaces per level, before the marker', () => {
    const html =
      '<table><tbody><tr><td>H</td></tr><tr><td><ul>' +
      '<li>collect requirements<ul><li>by email<ul><li>with a copy</li></ul></li><li>on a call</li></ul></li>' +
      '<li>agree</li></ul></td></tr></tbody></table>';
    const md = convertPageHtml(buildTurndownService(), html, NOOP_CTX);
    expect(md).not.toContain('<table');
    expect(cellOf(md)).toBe('| • collect requirements<br>  • by email<br>    • with a copy<br>  • on a call<br>• agree |');
  });

  it('an <ol> is numbered consecutively, a bullet nested under it keeps its own marker, and the outer count survives the nesting', () => {
    const html =
      '<table><tbody><tr><td>H</td></tr><tr><td><ol>' +
      '<li>First<ul><li>detail</li></ul></li><li>Second</li><li>Third</li></ol></td></tr></tbody></table>';
    const md = convertPageHtml(buildTurndownService(), html, NOOP_CTX);
    expect(md).not.toContain('<table');
    // Never `1\.` -- turndown's own escaping would make the line unreadable to
    // parseCellLines, which is why the marker travels as a token, not as text.
    expect(md).not.toContain('1\\.');
    expect(cellOf(md)).toBe('| 1. First<br>  • detail<br>2. Second<br>3. Third |');
  });

  it('a nested <ol> starts its own count at 1 while the outer one keeps counting', () => {
    const html =
      '<table><tbody><tr><td>H</td></tr><tr><td><ol>' +
      '<li>First<ol><li>Inner A</li><li>Inner B</li></ol></li><li>Second</li></ol></td></tr></tbody></table>';
    const md = convertPageHtml(buildTurndownService(), html, NOOP_CTX);
    expect(cellOf(md)).toBe('| 1. First<br>  1. Inner A<br>  2. Inner B<br>2. Second |');
  });

  it('a Confluence inline task list becomes `[ ]`/`[x]` lines, not bullets — the same construct the confluence-tasks rule writes outside a table', () => {
    // The real export_view shape from .qa/imp/1000000003 and 1000000008,
    // inlined verbatim (that directory is git-excluded, so a test may not read
    // from it). `li.checked` is the completed state.
    const html =
      '<table><tbody><tr><td>Channels</td></tr><tr><td>' +
      '<ul class="inline-task-list" data-inline-tasks-content-id="1000000003">' +
      '<li class="checked" data-inline-task-id="1"><span class="placeholder-inline-tasks">telegram </span></li>' +
      '<li class="checked" data-inline-task-id="2"><span class="placeholder-inline-tasks">viber </span></li>' +
      '<li data-inline-task-id="3"><span class="placeholder-inline-tasks">whatsapp </span></li>' +
      '</ul></td></tr></tbody></table>';
    const md = convertPageHtml(buildTurndownService(), html, NOOP_CTX);
    expect(md).not.toContain('<table');
    // Never `\[` -- turndown escapes a literal bracket, which is the third
    // reason the marker travels as a token rather than as its final text.
    expect(md).not.toContain('\\[');
    expect(cellOf(md)).toBe('| [x] telegram<br>[x] viber<br>[ ] whatsapp |');
  });

  it('a list next to paragraphs in the same cell: each paragraph is its own marker-less line, separated by <br>', () => {
    const html =
      '<table><tbody><tr><td>H</td></tr><tr><td>' +
      '<p>Intro</p><ul><li>one</li><li>two</li></ul><p>Summary</p>' +
      '</td></tr></tbody></table>';
    const md = convertPageHtml(buildTurndownService(), html, NOOP_CTX);
    expect(md).not.toContain('<table');
    expect(cellOf(md)).toBe('| Intro<br>• one<br>• two<br>Summary |');
  });

  it('inline markup inside an item survives the conversion — bold, link, code', () => {
    const html =
      '<table><tbody><tr><td>H</td></tr><tr><td><ul>' +
      '<li>Take <strong>all</strong> contacts</li>' +
      '<li>See <a href="/wiki/spaces/ENG/pages/222/Other">another page</a></li>' +
      '<li>Run <code>npm run build</code></li>' +
      '</ul></td></tr></tbody></table>';
    const ctx: PageConversionContext = {
      resolveLink: (href) => (href.includes('/pages/222/') ? '../other.md' : undefined),
      resolveImage: () => undefined,
    };
    const md = convertPageHtml(buildTurndownService(), html, ctx);
    expect(cellOf(md)).toBe('| • Take **all** contacts<br>• See [another page](../other.md)<br>• Run `npm run build` |');
  });

  it('an empty <li> (Confluence\'s `<li><p><br/></p></li>` filler) does not become a bullet with no text', () => {
    const html =
      '<table><tbody><tr><td>H</td></tr><tr><td><ul>' +
      '<li><p>one</p></li><li><p><br/></p></li><li><p>two</p></li></ul></td></tr></tbody></table>';
    const md = convertPageHtml(buildTurndownService(), html, NOOP_CTX);
    expect(cellOf(md)).toBe('| • one<br>• two |');
  });

  it('a table that is complex for a reason OTHER than its lists keeps them nested in the clean-HTML branch', () => {
    // Nothing is gained by flattening a list into a table that is going to
    // the raw branch anyway (real fixture: page 1786478593, ragged 5/2 with a
    // colspan AND a rowspan AND lists) -- there a real <ul> renders better.
    const html = '<table><tbody><tr><td colspan="2"><ul><li>Alpha</li><li>Beta</li></ul></td></tr></tbody></table>';
    const md = convertPageHtml(buildTurndownService(), html, NOOP_CTX);
    expect(md).toContain('<table');
    expect(md).toContain('<li>Alpha</li>');
    expect(md).not.toContain('•');
  });

  /**
   * Round 17's IRON RULE, applied to round 28's output: whatever we write must
   * still be a valid GFM pipe table to a renderer that knows none of our
   * extensions. The pipeline below is deliberately plugin-free apart from
   * remark-gfm — the same shape as plainGfm() in
   * web/src/markdown/tableExtensions.test.ts.
   */
  describe('GFM compatibility gate (round 17 iron rule)', () => {
    const plainGfm = (markdown: string): string =>
      String(unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeStringify).processSync(markdown));

    const SOURCE =
      '<table><tbody>' +
      '<tr><td>What to do</td><td>Who</td></tr>' +
      '<tr><td><p>Intro</p><ul><li>collect requirements<ul><li>by email</li><li>on a call</li></ul></li><li>agree</li></ul></td><td>BA</td></tr>' +
      '<tr><td><ol><li>First</li><li>Second</li></ol></td><td>PM</td></tr>' +
      '</tbody></table>';

    const html = plainGfm(`${convertPageHtml(buildTurndownService(), SOURCE, NOOP_CTX)}\n\nafter\n`);

    it('parses as ONE table with the same rows and columns, and nothing leaks out of it', () => {
      expect((html.match(/<table>/g) ?? []).length).toBe(1);
      expect((html.match(/<tr>/g) ?? []).length).toBe(3); // header + two body rows
      for (const row of html.split('<tr>').slice(1)) expect((row.match(/<t[dh][ >]/g) ?? []).length).toBe(2);
      expect(html).toContain('<p>after</p>'); // the table ends where it should
    });

    it('every item of every list is still readable text in the cell, bullets and all', () => {
      for (const text of ['Intro', 'collect requirements', 'by email', 'on a call', 'agree', 'First', 'Second']) {
        expect(html).toContain(text);
      }
      expect(html).toContain('•');
      expect(html).toContain('1.');
      expect(html).not.toContain('¶'); // no internal marker survives into the file
    });
  });
});

/**
 * Round 28b — an expand macro's WRAPPER stays HTML, its BODY becomes markdown.
 *
 * Round 16 `.keep()`-ed `<details>`/`<summary>`, which froze the whole block
 * verbatim; round 28b prints the tags by hand and lets turndown convert what is
 * between them, separated by the blank lines CommonMark needs. All the markup
 * below is VERBATIM export_view (structure copied from page 2440233005's own
 * expand macros: `.expand-container` > `.expand-control` > `button
 * [aria-controls]`, then `.expand-content` > `.table-wrap` > `table
 * .confluenceTable`), inlined here rather than read from .qa/ — that directory
 * is git-excluded and a test reading from it fails for everyone else.
 */
describe('round 28b: the body of an expand macro', () => {
  /** One real expand macro, `body` dropped in as its content. */
  const expandMacro = (label: string, body: string, id = 1859768100): string =>
    `<div id="expander-${id}" class="expand-container"><div id="expander-control-${id}" class="expand-control">` +
    `<button type="button" id="expand-button-${id}" class="aui-button aui-button-link aui-button-link-icon-text" aria-expanded="true" aria-controls="expander-content-${id}" >` +
    `<span class="expand-icon aui-icon aui-icon-small aui-iconfont-chevron-down" aria-hidden="true"></span>` +
    `<span class="expand-control-text conf-macro-render">${label}</span></button></div>` +
    `<div role="region" id="expander-content-${id}" class="expand-content" aria-labelledby="expand-button-${id}">${body}</div></div>`;

  /** The workflow table from page 2440233005, cut to two columns and two rows. */
  const WORKFLOW_TABLE =
    '<div class="table-wrap"><table data-table-width="1800" data-layout="default" class="confluenceTable">' +
    '<colgroup><col style="width: 167.0px;"/><col style="width: 415.0px;"/></colgroup><tbody>' +
    '<tr><th data-highlight-colour="#4c9aff" class="confluenceTh"><p style="text-align: center;"><strong>General PreSale</strong> </p></th>' +
    '<th data-highlight-colour="#e3fcef" class="confluenceTh"><p style="text-align: center;"><strong>Demand Generation</strong></p></th></tr>' +
    '<tr><td class="confluenceTd"><p><strong>BDM / Sales</strong></p></td>' +
    '<td class="confluenceTd"><p>Builds the lead flow<br/>Organizes Discovery</p></td></tr>' +
    '</tbody></table></div>';

  describe('the shape itself', () => {
    it('prints the tags verbatim and the body as markdown, one blank line on each side', () => {
      const md = convertPageHtml(buildTurndownService(), expandMacro('Workflows', '<p>Body <strong>text</strong>.</p>'), NOOP_CTX);
      // The blank lines are the whole point: CommonMark ends an HTML block at
      // the first of them, so what follows parses as markdown, and the bare
      // `</details>` line opens a second HTML block that closes the element.
      expect(md).toBe('<details><summary>Workflows</summary>\n\nBody **text**.\n\n</details>');
    });

    it('writes the same one-line opening fragment the editor\'s own /expand command does', () => {
      // web/src/editor/block-commands.ts `insertExpand`, and what
      // live-decorations.ts `parseDetailsOpen` reads back: `<details>` and the
      // whole `<summary>…</summary>` on the opening line, nothing else on it.
      const md = convertPageHtml(buildTurndownService(), expandMacro('Heading', '<p>body</p>'), NOOP_CTX);
      const [first, ...rest] = md.split('\n');
      expect(first).toBe('<details><summary>Heading</summary>');
      expect(rest[0]).toBe('');
      expect(rest[rest.length - 1]).toBe('</details>');
    });

    it('keeps `open` and any other attribute on the tag, and the summary\'s own escaping', () => {
      const md = convertPageHtml(buildTurndownService(), '<details open><summary>A &amp; B &lt;c&gt;</summary><p>body</p></details>', NOOP_CTX);
      expect(md).toBe('<details open=""><summary>A &amp; B &lt;c&gt;</summary>\n\nbody\n\n</details>');
    });

    it('an expand with nothing in it is still a well-formed pair of fragments', () => {
      const md = convertPageHtml(buildTurndownService(), expandMacro('Nothing', '<p>&nbsp;</p>'), NOOP_CTX);
      expect(md).toBe('<details><summary>Nothing</summary>\n\n</details>');
    });

    it('a stray <summary> with no <details> around it still keeps its own markup', () => {
      const md = convertPageHtml(buildTurndownService(), '<p>x</p><summary>orphan</summary>', NOOP_CTX);
      expect(md).toContain('<summary>orphan</summary>');
    });
  });

  describe('what this unblocks', () => {
    it('a simple table inside an expand is finally a pipe table (13 of them on page 2440233005 alone)', () => {
      const md = convertPageHtml(buildTurndownService(), expandMacro('General Pre-Sale Flow', WORKFLOW_TABLE), NOOP_CTX);
      expect(md).toContain('| **General PreSale** | **Demand Generation** |');
      expect(md).toContain('| --- | --- |');
      expect(md).toContain('| **BDM / Sales** | Builds the lead flow<br>Organizes Discovery |');
      expect(md).not.toContain('<table'); // nothing frozen, nothing left of the Confluence markup
      expect(md).not.toContain('confluenceTd');
      // Round 16b's background metadata rides along, one blank line above the
      // table, which is where readTableSource (web/src/markdown/
      // tableExtensions.ts) looks for it.
      expect(md).toMatch(/\[\/\/\]: # \(folio-table: bg=A1:blue,B1:green\)\n\n\| \*\*General PreSale\*\*/);
    });

    it('links inside an expand are rewritten — the leak round 16 left open', () => {
      const ctx: PageConversionContext = {
        resolveLink: (href) => (href.includes('pageId=777') ? './target/index.md' : undefined),
        resolveImage: () => undefined,
      };
      const body =
        '<p><a href="https://wiki.example/wiki/pages/viewpage.action?pageId=777">Imported page</a>, ' +
        '<a href="https://docs.google.com/document/d/abc/edit">external</a>, ' +
        '<a class="confluence-userlink" href="/wiki/display/~jane@example.com">Jane</a></p>';
      const md = convertPageHtml(buildTurndownService(), expandMacro('Links', body), ctx);
      expect(md).toContain('[Imported page](./target/index.md)'); // rewritten to the imported page
      expect(md).toContain('[external](https://docs.google.com/document/d/abc/edit)'); // genuinely external, left alone
      expect(md).toContain('Jane'); // @mention reduced to the display name
      expect(md).not.toContain('display/~jane@example.com'); // …and the corporate address is gone
      expect(md).not.toContain('<a '); // NOTHING inside the block is raw HTML any more
    });

    it('images inside an expand are rewritten too (same rule, same reason)', () => {
      const ctx: PageConversionContext = {
        resolveLink: () => undefined,
        resolveImage: (src) => (src.includes('diagram.png') ? '/a/sha256/diagram.png' : undefined),
      };
      const body = '<p><img src="/wiki/download/attachments/1/diagram.png" alt="Diagram"/></p>';
      const md = convertPageHtml(buildTurndownService(), expandMacro('Picture', body), ctx);
      expect(md).toContain('![Diagram](/a/sha256/diagram.png)');
    });

    it('headings, lists and code inside an expand convert like anywhere else', () => {
      const body =
        '<h2>Head</h2><ul><li><p>one</p></li><li><p>two</p></li></ul>' +
        '<pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: js">const x = 1;</pre>';
      const md = convertPageHtml(buildTurndownService(), expandMacro('Rich', body), NOOP_CTX);
      expect(md).toContain('## Head'); // a real heading, so it reaches the page outline
      expect(md).toContain('-   one');
      expect(md).toContain('```js\nconst x = 1;\n```');
    });
  });

  describe('what deliberately did NOT change', () => {
    it('a table too complex for pipes still comes out as clean HTML, on its own line inside the block', () => {
      const body = '<table><tbody><tr><td><table><tr><td>nested</td></tr></table></td><td>x</td></tr></tbody></table>';
      const md = convertPageHtml(buildTurndownService(), expandMacro('Complex', body), NOOP_CTX);
      expect(md).toMatch(/<details><summary>Complex<\/summary>\n\n<table>/);
      expect(md).toMatch(/<\/table>\n\n<\/details>/);
      expect(md).toContain('<td>nested</td>'); // the nesting a pipe table cannot express is preserved
    });

    it('an expand inside a TABLE CELL is still frozen verbatim with its table', () => {
      // COMPLEX_CELL_TAGS has DETAILS, so the cell's table takes the raw-HTML
      // branch and `folio-raw-table` prints its outerHTML — the details never
      // gets a rule of its own. Unchanged by round 28b, and it has to be:
      // half a `<details>` inside a table cell would be neither.
      const cell = expandMacro('In cell', '<p>body</p>');
      const md = convertPageHtml(buildTurndownService(), `<table><tbody><tr><td>${cell}</td><td>plain</td></tr></tbody></table>`, NOOP_CTX);
      expect(md).toContain('<td><details><summary>In cell</summary><p>body</p></details></td>');
      expect(md).not.toContain('\n\n<details>');
    });

    it('nested expands still nest, outer body and all', () => {
      const inner = expandMacro('Inner', `<p>Inner body.</p>${WORKFLOW_TABLE}`, 2);
      const md = convertPageHtml(buildTurndownService(), `<p>Before.</p>${expandMacro('Outer', `<p>Outer body.</p>${inner}`)}<p>After.</p>`, NOOP_CTX);
      expect(md).toMatch(/Before\.\n\n<details><summary>Outer<\/summary>\n\nOuter body\.\n\n<details><summary>Inner<\/summary>/);
      expect(md).toMatch(/<\/details>\n\n<\/details>\n\nAfter\./); // inner closes, then outer
      expect((md.match(/<details>/g) ?? []).length).toBe(2);
      expect((md.match(/<\/details>/g) ?? []).length).toBe(2);
    });
  });

  /**
   * Round 17's IRON RULE for the new shape. `allowDangerousHtml` is the one
   * difference from plainGfm() in web/src/markdown/tableExtensions.test.ts, and
   * it has to be: without it remark-rehype DROPS every html node, so the
   * `<details>` would not be in the output to assert about. Everything else is
   * the same plugin-free chain — no rehype-raw, none of Folio's own passes.
   */
  describe('GFM compatibility gate (round 17 iron rule)', () => {
    const plainGfmRaw = (markdown: string): string =>
      String(
        unified()
          .use(remarkParse)
          .use(remarkGfm)
          .use(remarkRehype, { allowDangerousHtml: true })
          .use(rehypeStringify, { allowDangerousHtml: true })
          .processSync(markdown),
      );

    const md = convertPageHtml(buildTurndownService(), `${expandMacro('General Pre-Sale Flow', WORKFLOW_TABLE)}<p>after</p>`, NOOP_CTX);
    const html = plainGfmRaw(md);

    it('is still ONE <details>, opened and closed', () => {
      expect((html.match(/<details[ >]/g) ?? []).length).toBe(1);
      expect((html.match(/<\/details>/g) ?? []).length).toBe(1);
      expect(html).toContain('<summary>General Pre-Sale Flow</summary>');
    });

    it('the table inside it is a real table to a renderer that knows none of our extensions', () => {
      const inside = html.slice(html.indexOf('<details'), html.indexOf('</details>'));
      expect((inside.match(/<table>/g) ?? []).length).toBe(1);
      expect((inside.match(/<tr>/g) ?? []).length).toBe(2); // header + one body row
      expect(inside).toContain('<th>');
      expect(inside).toContain('Builds the lead flow');
      expect(inside).not.toContain('[//]'); // the metadata line stays invisible
      expect(inside).not.toContain('¶');
    });

    it('does not eat what follows the block', () => {
      expect(html).toContain('<p>after</p>');
      expect(html.indexOf('<p>after</p>')).toBeGreaterThan(html.indexOf('</details>'));
    });
  });
});

describe('attachments and links', () => {
  const PDF_ASSET = { url: '/a/abc123/Product_Overview%20(1).pdf', filename: 'Product_Overview (1).pdf', isImage: false };
  const assetCtx: PageConversionContext = {
    resolveLink: () => undefined,
    resolveImage: () => undefined,
    resolveAsset: (url) => (extractConfluenceAttachmentName(url)?.startsWith('Product_Overview') ? PDF_ASSET : undefined),
  };

  it('reads the attachment filename out of a view-file macro\'s ?preview= URL, not the host page id', () => {
    const href =
      '/wiki/spaces/DOCS/pages/1000000001/Title?preview=%2F1000000001%2F1000000002%2FProduct_Overview+%281%29.pdf';
    expect(extractConfluenceAttachmentName(href)).toBe('Product_Overview (1).pdf');
    expect(extractConfluenceAttachmentName('/wiki/download/attachments/1651081222/image-20240212-163349.png?api=v2')).toBe('image-20240212-163349.png');
    expect(extractConfluenceAttachmentName('/wiki/download/thumbnails/1651081222/diagram.svg')).toBe('diagram.svg');
    expect(extractConfluenceAttachmentName('/wiki/spaces/DOCS/pages/1000000001/Title')).toBeNull();
  });

  it('points a view-file link at the stored file — it used to point back at the page you were reading (42 pages of the reference space)', () => {
    const html =
      '<p class="media-group"><a href="/wiki/spaces/DOCS/pages/1000000001/Title?preview=%2F1000000001%2F1000000002%2FProduct_Overview+%281%29.pdf">file</a></p>';
    const md = convertPageHtml(buildTurndownService(), html, assetCtx);
    expect(md).toBe('[file](/a/abc123/Product_Overview%20(1).pdf)');
  });

  it('renders a non-image attachment as a link, never as an <img> with a video behind it', () => {
    const html = '<img src="/wiki/download/attachments/1/Product_Overview+%281%29.pdf" alt="Workflows"/>';
    expect(convertPageHtml(buildTurndownService(), html, assetCtx)).toBe('[Workflows](/a/abc123/Product_Overview%20(1).pdf)');
  });

  it('keeps the alt text as plain words when nothing resolves — never `![alt]()`, an image with an empty src', () => {
    const html = '<p><img src="/wiki/download/attachments/1/Workflows.mp4" alt="Workflows.mp4"/></p>';
    const md = convertPageHtml(buildTurndownService(), html, NOOP_CTX);
    expect(md).not.toContain('](');
    expect(md).toBe('Workflows.mp4');
  });

  it('absolutizes a root-relative Confluence link, which would otherwise 404 on Folio\'s own host', () => {
    expect(normalizeUnresolvedConfluenceHref('/wiki/spaces/DOCS/pages/1000000004/Test', 'https://wiki.example.org/wiki')).toBe(
      'https://wiki.example.org/wiki/spaces/DOCS/pages/1000000004/Test',
    );
  });

  it('rewrites an edit-v2 link to the page\'s view URL — following one dropped the reader into Confluence\'s editor', () => {
    expect(
      normalizeUnresolvedConfluenceHref('https://example-team.atlassian.net/wiki/spaces/DOCS/pages/edit-v2/1000000005', 'https://wiki.example.org/wiki'),
    ).toBe('https://example-team.atlassian.net/wiki/spaces/DOCS/pages/1000000005');
  });

  it('leaves an ordinary absolute link and a bare anchor alone', () => {
    expect(normalizeUnresolvedConfluenceHref('https://wiki.example.org/wiki/pages/viewpage.action?pageId=1', 'https://wiki.example.org/wiki')).toBeUndefined();
    expect(normalizeUnresolvedConfluenceHref('#section', 'https://wiki.example.org/wiki')).toBeUndefined();
    expect(normalizeUnresolvedConfluenceHref('', 'https://wiki.example.org/wiki')).toBeUndefined();
  });

  it('reduces a user mention to the person\'s name — its href spells out their corporate email', () => {
    const html =
      '<p>The process needs a description! <a class="confluence-userlink user-mention" data-username="jdoe@example.com" ' +
      'href="https://wiki.example.org/wiki/display/~jdoe@example.com">JD</a> will add it to the rules</p>';
    const md = convertPageHtml(buildTurndownService(), html, NOOP_CTX);
    expect(md).toBe('The process needs a description! JD will add it to the rules');
    expect(md).not.toContain('jdoe@example.com');
  });
});

describe('macros that used to vanish, and heading/list shape', () => {
  it('turns a pagetree macro into Folio\'s own ::pagetree directive (26 pages of the reference space, previously silent)', () => {
    const html =
      '<p>Before.</p><div class="plugin_pagetree">\n<div class="plugin_pagetree_children_list"><div class="plugin_pagetree_children">\n</div></div>\n' +
      '<fieldset class="hidden"><input type="hidden" name="treePageId" value="1621655573"></fieldset></div><p>After.</p>';
    const md = convertPageHtml(buildTurndownService(), html, NOOP_CTX);
    expect(md).toBe('Before.\n\n::pagetree\n\nAfter.');
  });

  it('turns an iframe embed into a link to what it framed instead of dropping it', () => {
    const html = '<p><iframe src="https://www.figma.com/embed?url=x" title="Diagram"></iframe></p>';
    expect(convertPageHtml(buildTurndownService(), html, NOOP_CTX)).toBe('[Diagram](https://www.figma.com/embed?url=x)');
  });

  it('demotes body headings by one so composePageBody\'s title stays the only H1', () => {
    const html = '<h1>What widgets do competitors have?</h1><h2>Crisp</h2><h6>A detail</h6>';
    const md = convertPageHtml(buildTurndownService(), html, NOOP_CTX);
    expect(md).toBe('## What widgets do competitors have?\n\n### Crisp\n\n###### A detail');
    expect(composePageBody('Widget 2.0', md).match(/^# /gm)).toHaveLength(1);
  });

  it('leaves a body that already starts at H2 exactly where it is', () => {
    expect(convertPageHtml(buildTurndownService(), '<h2>Section</h2><h3>Subsection</h3>', NOOP_CTX)).toBe('## Section\n\n### Subsection');
  });

  it('renders Confluence\'s <li><p>text</p></li> as a tight list, not one padded with blank lines', () => {
    const html = '<ul><li><p>First</p></li><li><p>Second</p></li></ul>';
    expect(convertPageHtml(buildTurndownService(), html, NOOP_CTX)).toBe('-   First\n-   Second');
  });

  it('keeps a list item that really is two paragraphs as two paragraphs', () => {
    const html = '<ul><li><p>First paragraph</p><p>Second paragraph</p></li></ul>';
    const md = convertPageHtml(buildTurndownService(), html, NOOP_CTX);
    expect(md).toContain('First paragraph');
    expect(md).toContain('Second paragraph');
    expect(md).not.toBe('-   First paragraph Second paragraph');
  });
});
