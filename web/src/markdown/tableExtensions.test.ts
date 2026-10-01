/**
 * Round 17 — extended tables, reading side.
 *
 * The first block is the round's acceptance gate and the reason the syntax
 * looks the way it does: a fixture using EVERY extension, run through a plain
 * remark-gfm pipeline with none of our plugins in it, has to come out as an
 * ordinary table with the same number of rows and columns, and with no trace of
 * the metadata line. That is what "github/gitlab still show it as a table"
 * means, checked rather than assumed.
 */
import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { renderMarkdownToHtml } from './pipeline';
import { folioSanitizeSchema } from './sanitizeSchema';
import { cellHasList } from './tableSyntax';

const opts = { space: 'engineering', pagePath: 'notes/tables.md' };

/**
 * The case this round is accepted on, in miniature: a Confluence-style card
 * board — five columns, one pastel background each, nested bullet lists inside
 * the cells, percentage widths — plus a vertical merge and a full-width
 * summary row, so every extension is exercised at once.
 */
const FIXTURE = [
  '[//]: # (folio-table: bg=HA:red,HB:green,HC:yellow,HD:blue,HE:purple,A1:gray; w=1:20%,2:20%,3:20%,4:20%,5:20%)',
  '',
  '| Discovery | Delivery | Support | Growth | Ops |',
  '| :-------- | :------- | :------ | :----- | :-- |',
  '| • Interviews<br>  • Scripts<br>• Personas | • Sprints | • Tickets | • Experiments | • Runbooks |',
  '| ^^ | done | done | done | done |',
  '| Summary for the whole board |||||',
].join('\n');

/**
 * Round 28's own case, in the form the DEV-PLAN writes it: the ASCII `- `
 * marker (not just round 17's `•`), nesting, a numbered list, a cell that
 * mixes paragraphs with a list, inline markdown inside an item, and one cell
 * with no list at all — which has to come out untouched.
 */
const LIST_FIXTURE = [
  '| What to do | Who | When |',
  '| --- | --- | --- |',
  '| - collect requirements<br>- agree with the client<br>  - by email<br>  - on a call | BA | Q3 |',
  '| First:<br>1. a draft<br>2. a review<br>Then the release. | Lead | Q4 |',
  '| • a **bold** item<br>• a [link](other.md) and `code` | QA | — |',
  '| Line **one**<br>-5 degrees — and that is it | PM | — |',
].join('\n');

/** remark-gfm and nothing else — a stand-in for github/gitlab. */
function plainGfm(markdown: string): string {
  return String(
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype)
      .use(rehypeStringify)
      .processSync(markdown),
  );
}

const count = (html: string, pattern: RegExp): number => html.match(pattern)?.length ?? 0;

describe('GFM compatibility (round 17 acceptance gate)', () => {
  const html = plainGfm(FIXTURE);

  it('is still one table with the same number of rows and columns', () => {
    expect(html).toContain('<table>');
    expect(count(html, /<tr>/g)).toBe(4); // header + three body rows
    const rows = html.split('<tr>').slice(1);
    for (const row of rows) expect(count(row, /<t[dh][ >]/g)).toBe(5);
  });

  it('does not print the metadata line anywhere', () => {
    expect(html).not.toContain('folio-table');
    expect(html).not.toContain('[//]');
  });

  it('keeps every cell of text — the extensions only add empty cells and ^^', () => {
    expect(html).toContain('Summary for the whole board');
    expect(html).toContain('Interviews');
    expect(html).toContain('^^'); // legible in a plain renderer, and lossless
  });

  it('leaves nothing after the table either', () => {
    const after = plainGfm(`${FIXTURE}\n\nafter\n`);
    expect(after).toContain('<p>after</p>');
    expect(count(after, /<table>/g)).toBe(1);
  });

  // A merged HEADER is the one place a colspan could break GFM outright: the
  // header row has to keep matching the delimiter row cell for cell, and tight
  // pipes still count as cells, so it does.
  it('survives a merge in the header row, delimiter match and all', () => {
    const banner = ['| Banner |||', '| --- | --- | --- |', '| 1 | 2 | 3 |'].join('\n');
    const html = plainGfm(banner);
    expect(count(html, /<th[ >]/g)).toBe(3);
    expect(count(html, /<td[ >]/g)).toBe(3);

    const ours = renderMarkdownToHtml(banner, opts);
    expect(ours).toContain('<th colspan="3">Banner</th>');
    expect(count(ours, /<th[ >]/g)).toBe(1);
  });
});

/**
 * Round 28 puts lists inside cells, so it goes through the same gate: the file
 * we write is still, to a parser with none of our plugins in it, ONE ordinary
 * table. This is the check that a list in a cell never becomes block markup in
 * the source — the moment it did, the table would stop being a table.
 */
describe('GFM compatibility: a table with lists in its cells (round 28)', () => {
  const html = plainGfm(LIST_FIXTURE);

  it('is still one table with the same number of rows and columns', () => {
    expect(count(html, /<table>/g)).toBe(1);
    expect(count(html, /<tr>/g)).toBe(5); // header + four body rows
    const rows = html.split('<tr>').slice(1);
    for (const row of rows) expect(count(row, /<t[dh][ >]/g)).toBe(3);
  });

  it('shows the items as plain text — no list markup, no debris', () => {
    expect(html).not.toContain('<ul>');
    expect(html).not.toContain('<ol>');
    expect(html).not.toContain('<li>');
    expect(html).toContain('collect requirements');
    expect(html).toContain('on a call');
    expect(html).toContain('a draft');
    expect(html).toContain('<strong>bold</strong>'); // inline markdown is still inline markdown
  });

  it('leaves nothing after the table either', () => {
    const after = plainGfm(`${LIST_FIXTURE}\n\nafter\n`);
    expect(after).toContain('<p>after</p>');
    expect(count(after, /<table>/g)).toBe(1);
    expect(count(after, /<tr>/g)).toBe(5);
  });
});

describe('renderMarkdownToHtml: merged cells', () => {
  it('renders a run of tight pipes as one cell spanning those columns', () => {
    const html = renderMarkdownToHtml(FIXTURE, opts);
    expect(html).toContain('colspan="5"');
    const last = html.split('<tr>').pop() ?? '';
    expect(count(last, /<td/g)).toBe(1);
  });

  it('renders ^^ as a vertical merge and drops the marker cell', () => {
    const html = renderMarkdownToHtml(FIXTURE, opts);
    expect(html).toContain('rowspan="2"');
    expect(html).not.toContain('^^');
  });

  it('leaves a genuinely empty cell alone — only tight pipes merge', () => {
    const html = renderMarkdownToHtml('| a | b | c |\n| - | - | - |\n| x |   | z |', opts);
    expect(html).not.toContain('colspan');
    expect(count(html.split('<tr>').pop() ?? '', /<td/g)).toBe(3);
  });

  it('keeps ^^ literal in the first body row, where there is nothing to merge into', () => {
    const html = renderMarkdownToHtml('| a | b |\n| - | - |\n| ^^ | y |', opts);
    expect(html).not.toContain('rowspan');
    expect(html).toContain('^^');
  });
});

describe('renderMarkdownToHtml: cell backgrounds', () => {
  it('paints header and body cells from the metadata line, as classes', () => {
    const html = renderMarkdownToHtml(FIXTURE, opts);
    expect(html).toContain('folio-bg-red');
    expect(html).toContain('folio-bg-green');
    expect(html).toContain('folio-bg-purple');
    expect(html).toContain('folio-bg-gray');
    expect(html).not.toContain('style=');
  });

  // The round-16b importer writes these same classes straight onto the <td>s
  // of the complex tables it converts to raw HTML. Nothing but the sanitizer
  // stands between that and the page, so this is the contract's other end.
  it('lets the same classes through on a raw HTML table', () => {
    const html = renderMarkdownToHtml(
      '<table><tbody><tr><td class="folio-bg-teal">x</td></tr></tbody></table>',
      opts,
    );
    expect(html).toContain('class="folio-bg-teal"');
  });

  it('ignores a colour outside the palette instead of writing it out', () => {
    const html = renderMarkdownToHtml(
      '[//]: # (folio-table: bg=A1:#ff0000,B1:green)\n\n| a | b |\n| - | - |\n| x | y |',
      opts,
    );
    expect(html).not.toContain('#ff0000');
    expect(html).toContain('folio-bg-green');
  });
});

describe('renderMarkdownToHtml: column widths', () => {
  it('emits a colgroup the sanitizer passes through', () => {
    const html = renderMarkdownToHtml(FIXTURE, opts);
    expect(html).toContain('<colgroup>');
    expect(count(html, /<col /g)).toBe(5);
    expect(html).toContain('width="20%"');
    expect(html).toContain('folio-table-sized');
  });

  it('does not renormalise widths that add up to something other than 100%', () => {
    const html = renderMarkdownToHtml(
      '[//]: # (folio-table: w=1:30%,2:30%)\n\n| a | b |\n| - | - |\n| x | y |',
      opts,
    );
    expect(count(html, /width="30%"/g)).toBe(2);
    expect(count(html, /<tr>/g)).toBe(2);
  });

  it('accepts pixels as well as percentages, and drops anything else', () => {
    const html = renderMarkdownToHtml(
      '[//]: # (folio-table: w=1:120px,2:9rem)\n\n| a | b |\n| - | - |\n| x | y |',
      opts,
    );
    expect(html).toContain('width="120px"');
    expect(html).not.toContain('9rem');
  });
});

describe('renderMarkdownToHtml: metadata line', () => {
  it('never renders as content', () => {
    const html = renderMarkdownToHtml(FIXTURE, opts);
    expect(html).not.toContain('folio-table:');
    expect(html).not.toContain('[//]');
  });

  it('reads the DEV-PLAN placement under the delimiter row, and drops that row', () => {
    const legacy = [
      '| a | b |',
      '| - | - |',
      '[//]: # (folio-table: bg=A1:yellow)',
      '| x | y |',
    ].join('\n');
    const html = renderMarkdownToHtml(legacy, opts);
    expect(html).toContain('folio-bg-yellow');
    expect(html).not.toContain('folio-table:');
    expect(count(html, /<tr>/g)).toBe(2);
  });

  it('degrades to an ordinary table when the metadata line is damaged', () => {
    const broken = '[//]: # (folio-table: bg=;;; w=nonsense)\n\n| a | b |\n| - | - |\n| x | y |';
    const html = renderMarkdownToHtml(broken, opts);
    expect(html).toContain('<table>');
    expect(html).not.toContain('folio-bg');
    expect(html).not.toContain('<colgroup>');
    expect(count(html, /<tr>/g)).toBe(2);
  });

  it('leaves an ordinary table completely untouched', () => {
    const plain = '| a | b |\n| - | - |\n| x | y |';
    const html = renderMarkdownToHtml(plain, opts);
    expect(html).not.toContain('colspan');
    expect(html).not.toContain('rowspan');
    expect(html).not.toContain('colgroup');
    expect(html).toContain('<td>x</td>');
  });
});

describe('renderMarkdownToHtml: lists inside cells', () => {
  const html = renderMarkdownToHtml(LIST_FIXTURE, opts);

  it('turns a run of • lines into a real list, nested by indentation', () => {
    const html = renderMarkdownToHtml(FIXTURE, opts);
    // "Interviews" holds a nested list; "Personas" is back at the top level.
    expect(html).toMatch(/<ul><li>Interviews<ul><li>Scripts<\/li><\/ul><\/li>/);
    expect(html).toContain('<li>Personas</li>');
  });

  it('renders the DEV-PLAN dash form as a real list, sub-items nested inside their parent', () => {
    expect(html).toContain(
      '<td><ul><li>collect requirements</li>' +
        '<li>agree with the client<ul><li>by email</li><li>on a call</li></ul></li></ul></td>',
    );
  });

  // The marker alphabet is tableSyntax.ts's, not this renderer's. Before round
  // 28 the renderer kept its own copy and knew only `•`, so the DEV-PLAN's own
  // `- ` form came out as a line of dashes. These two assertions per marker are
  // what keeps the two ends tied together.
  it.each(['-', '*', '+', '•', '◦'])('reads `%s` as a marker, exactly as the contract does', (marker) => {
    expect(cellHasList(`${marker} item`)).toBe(true);
    const cell = renderMarkdownToHtml(`| a |\n| - |\n| ${marker} item |`, opts);
    expect(cell).toContain('<td><ul><li>item</li></ul></td>');
  });

  it('nests as deep as it is written — the format sets no ceiling', () => {
    const deep = renderMarkdownToHtml('| a |\n| - |\n| • l1<br>  • l2<br>    • l3<br>      • l4 |', opts);
    expect(deep).toContain(
      '<td><ul><li>l1<ul><li>l2<ul><li>l3<ul><li>l4</li></ul></li></ul></li></ul></li></ul></td>',
    );
  });

  it('renders a numbered list as an <ol>', () => {
    expect(html).toContain('<ol><li>a draft</li><li>a review</li></ol>');
  });

  it('keeps paragraphs and the list in the order they were written', () => {
    expect(html).toContain('<td>First:<ol><li>a draft</li><li>a review</li></ol>Then the release.</td>');
  });

  it('leaves the inline markdown of an item alone — it is rendered by remark, not by us', () => {
    expect(html).toContain(
      '<td><ul><li>a <strong>bold</strong> item</li>' +
        '<li>a <a href="other.md" data-folio-link="notes/other.md">link</a> and <code>code</code></li></ul></td>',
    );
  });

  it('does not touch a mention inside an item', () => {
    const mentioned = renderMarkdownToHtml('| a |\n| - |\n| - hello @ann |', {
      ...opts,
      mentionLookup: (handle) => (handle === 'ann' ? 'Ann Doe' : undefined),
    });
    expect(mentioned).toContain('<li>hello <span class="folio-mention" title="Ann Doe">@ann</span></li>');
  });

  // Every assertion above is made on the output of the FULL pipeline, sanitizer
  // included — but a silently dropped tag is exactly the failure mode that
  // looks like "the list just isn't there", so the schema is asserted directly.
  it('passes the sanitizer: every tag the pass emits is in the schema', () => {
    const allowed = new Set(folioSanitizeSchema.tagNames ?? []);
    for (const tag of ['ul', 'ol', 'li', 'br', 'input']) expect(allowed.has(tag)).toBe(true);
    const checklist = renderMarkdownToHtml('| a |\n| - |\n| [x] done<br>• plain |', opts);
    expect(checklist).toContain('<ul><li><input type="checkbox" disabled checked>done</li>');
    expect(checklist).toContain('<li>plain</li>');
  });

  it('renders a checklist line as a checkbox item', () => {
    const html = renderMarkdownToHtml('| a |\n| - |\n| [x] done<br>[ ] todo |', opts);
    expect(html).toContain('<input type="checkbox" disabled checked>');
    expect(html).toContain('<li><input type="checkbox" disabled>todo</li>');
  });

  it('keeps a plain line as a plain line', () => {
    const html = renderMarkdownToHtml('| a |\n| - |\n| Title<br>• one |', opts);
    expect(html).toContain('<td>Title<ul>');
    expect(html).toContain('<li>one</li>');
  });

  it('leaves a cell with no list markers alone', () => {
    const html = renderMarkdownToHtml('| a |\n| - |\n| just text |', opts);
    expect(html).toContain('<td>just text</td>');
  });

  // "Not a byte changed" for a cell that holds no list: its own line break, its
  // inline markup, a leading `-5` that is a temperature and not a bullet, and
  // an em-dash mid-sentence all come out exactly as they went in.
  it('does not touch a cell that has no items, line breaks and dashes included', () => {
    expect(html).toContain('<td>Line <strong>one</strong><br>-5 degrees — and that is it</td>');
  });
});
