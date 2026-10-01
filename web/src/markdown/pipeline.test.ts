import { beforeAll, describe, expect, it } from 'vitest';
import i18next from 'i18next';
import { renderMarkdownToHtml } from './pipeline';
import { extractHeadings } from './headings';
import { createHeadingIdCursor } from './headingIds';
import './i18n/register';

// Pinned rather than left to the standalone fallback's own default, so the
// text assertions below check the language they are written against.
beforeAll(async () => {
  await i18next.changeLanguage('en');
});

const opts = { space: 'engineering', pagePath: 'architecture/data-flow.md' };

function cursorFor(markdown: string) {
  return createHeadingIdCursor(extractHeadings(markdown));
}

describe('renderMarkdownToHtml: GFM alerts', () => {
  it('turns a [!NOTE] blockquote into a styled div and strips the marker', () => {
    const html = renderMarkdownToHtml('> [!NOTE]\n> All content is files.', opts);
    expect(html).toContain('class="md-alert md-alert-note"');
    expect(html).toContain('data-alert="note"');
    expect(html).not.toContain('[!NOTE]');
    expect(html).toContain('All content');
  });

  // Round 22 (SHELL-5): the label used to come from CSS alone
  // (`content: attr(data-alert)`, capitalized), which can only ever show
  // the English marker keyword. It's now resolved via i18next at render
  // time into a separate data-alert-label attribute, in the language this
  // file's own beforeAll pins.
  it('carries a locale-translated label in data-alert-label, distinct from the machine-readable data-alert type', () => {
    const html = renderMarkdownToHtml('> [!NOTE]\n> body', opts);
    expect(html).toContain('data-alert="note"');
    expect(html).toContain('data-alert-label="Note"');
  });

  it('translates every alert type label under the pinned locale', () => {
    const expected: Record<string, string> = {
      NOTE: 'Note',
      TIP: 'Tip',
      IMPORTANT: 'Important',
      WARNING: 'Warning',
      CAUTION: 'Caution',
    };
    for (const [marker, label] of Object.entries(expected)) {
      const html = renderMarkdownToHtml(`> [!${marker}]\n> body`, opts);
      expect(html).toContain(`data-alert-label="${label}"`);
    }
  });

  it('supports all five alert types', () => {
    for (const [marker, cls] of [
      ['NOTE', 'md-alert-note'],
      ['TIP', 'md-alert-tip'],
      ['IMPORTANT', 'md-alert-important'],
      ['WARNING', 'md-alert-warning'],
      ['CAUTION', 'md-alert-caution'],
    ]) {
      const html = renderMarkdownToHtml(`> [!${marker}]\n> body`, opts);
      expect(html).toContain(cls);
    }
  });

  it('leaves a plain blockquote (no marker) alone', () => {
    const html = renderMarkdownToHtml('> just a quote', opts);
    expect(html).not.toContain('md-alert');
    expect(html).toContain('<blockquote>');
  });
});

describe('renderMarkdownToHtml: relative links & images', () => {
  it('rewrites a relative .md link href to a data-folio-link with the resolved path', () => {
    const html = renderMarkdownToHtml('See [onboarding](../onboarding.md).', opts);
    expect(html).toContain('data-folio-link="onboarding.md"');
  });

  it('rewrites a relative image src to the /files/<space>/... route', () => {
    const html = renderMarkdownToHtml('![Alt](./assets/x.excalidraw.svg)', opts);
    expect(html).toContain('src="/files/engineering/architecture/assets/x.excalidraw.svg"');
  });

  it('leaves an app-absolute /a/<sha> asset-store image src untouched (regression: reading mode broke it into /files/<space>//a/...)', () => {
    const src = '/a/55446e5b2c96b64068fa56d9c1c7af37ce95398100e67f3f3cbd8043eeea3a57/c1%20-%20virtualbg-sk1.jpg';
    const html = renderMarkdownToHtml(`![Picture](${src})`, opts);
    expect(html).toContain(`src="${src}"`);
    expect(html).not.toContain('/files/');
  });

  it('leaves an app-absolute link href untouched', () => {
    const html = renderMarkdownToHtml('[file](/a/deadbeef/file.pdf)', opts);
    expect(html).toContain('href="/a/deadbeef/file.pdf"');
    expect(html).not.toContain('data-folio-link');
  });

  it('marks external links target=_blank rel=noopener and leaves the href untouched', () => {
    const html = renderMarkdownToHtml('[docs](https://example.com/docs)', opts);
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toMatch(/rel="noopener noreferrer"/);
    expect(html).not.toContain('data-folio-link');
  });

  it('does not touch same-page hash links', () => {
    const html = renderMarkdownToHtml('[jump](#section)', opts);
    expect(html).toContain('href="#section"');
    expect(html).not.toContain('data-folio-link');
  });

  it('rewrites a non-markdown relative link to the /files/<space>/... route, same as images (round 8)', () => {
    const html = renderMarkdownToHtml('[zip](./export.zip)', opts);
    expect(html).not.toContain('data-folio-link');
    expect(html).toContain('href="/files/engineering/architecture/export.zip"');
  });

  it('preserves a hash fragment after rewriting a non-markdown relative link', () => {
    const html = renderMarkdownToHtml('[doc](./notes.pdf#page=3)', opts);
    expect(html).toContain('href="/files/engineering/architecture/notes.pdf#page=3"');
  });

  // Round 25 (owner feedback): a rewritten /files/... link is an uploaded
  // file (pdf/zip/etc.), a real download/new-tab destination exactly like an
  // external link — not in-app navigation, so it gets the same target/rel
  // treatment. renderMarkdownToHtml is the one shared pipeline behind both
  // the reading view and the editor's hover link-preview card (which renders
  // a previewed page's body through this same function — see link-preview.tsx),
  // so this one assertion covers both surfaces.
  it('marks a rewritten non-markdown relative link target=_blank rel=noopener, same as an external link (round 25)', () => {
    const html = renderMarkdownToHtml('[zip](./export.zip)', opts);
    expect(html).toContain('href="/files/engineering/architecture/export.zip"');
    expect(html).toContain('target="_blank"');
    expect(html).toMatch(/rel="noopener noreferrer"/);
  });

  it('keeps target=_blank rel=noopener when a hash fragment is also preserved (round 25)', () => {
    const html = renderMarkdownToHtml('[doc](./notes.pdf#page=3)', opts);
    expect(html).toContain('href="/files/engineering/architecture/notes.pdf#page=3"');
    expect(html).toContain('target="_blank"');
    expect(html).toMatch(/rel="noopener noreferrer"/);
  });

  // Negative case: an internal page link is SPA navigation (index.tsx
  // intercepts the click via data-folio-link), never a new-tab destination —
  // round 25 must not touch this branch.
  it('does not add target/rel to an internal markdown-page data-folio-link (round 25)', () => {
    const html = renderMarkdownToHtml('See [onboarding](../onboarding.md).', opts);
    expect(html).toContain('data-folio-link="onboarding.md"');
    expect(html).not.toContain('target=');
    expect(html).not.toContain('rel=');
  });
});

describe('renderMarkdownToHtml: shareToken (round 8, public /share/:token route)', () => {
  const shareOpts = { ...opts, shareToken: 'abc123' };

  it('appends ?share=<token> to a rewritten image src', () => {
    const html = renderMarkdownToHtml('![Alt](./assets/x.png)', shareOpts);
    expect(html).toContain('src="/files/engineering/architecture/assets/x.png?share=abc123"');
  });

  it('appends ?share=<token> to a rewritten non-markdown relative link', () => {
    const html = renderMarkdownToHtml('[zip](./export.zip)', shareOpts);
    expect(html).toContain('href="/files/engineering/architecture/export.zip?share=abc123"');
  });

  // Round 25: the target/rel addition and the share-token query are
  // independent concerns on the same href — a guest on the public share
  // route still gets a new-tab download link, not an in-page one.
  it('still marks target=_blank rel=noopener on a rewritten link carrying a share token (round 25)', () => {
    const html = renderMarkdownToHtml('[zip](./export.zip)', shareOpts);
    expect(html).toContain('target="_blank"');
    expect(html).toMatch(/rel="noopener noreferrer"/);
  });

  it('puts the share query before a preserved hash fragment', () => {
    const html = renderMarkdownToHtml('[doc](./notes.pdf#page=3)', shareOpts);
    expect(html).toContain('href="/files/engineering/architecture/notes.pdf?share=abc123#page=3"');
  });

  it('URL-encodes the token', () => {
    const html = renderMarkdownToHtml('![Alt](./x.png)', { ...opts, shareToken: 'a b/c' });
    expect(html).toContain('share=a%20b%2Fc');
  });

  it('does not touch a markdown-page data-folio-link (not a /files/ URL)', () => {
    const html = renderMarkdownToHtml('See [onboarding](../onboarding.md).', shareOpts);
    expect(html).toContain('data-folio-link="onboarding.md"');
    expect(html).not.toContain('share=abc123');
  });

  it('leaves URLs untouched when no token is given (normal authenticated view)', () => {
    const html = renderMarkdownToHtml('![Alt](./x.png)', opts);
    expect(html).toContain('src="/files/engineering/architecture/x.png"');
    expect(html).not.toContain('share=');
  });
});

describe('renderMarkdownToHtml: ==highlight== (shared/highlight.ts)', () => {
  it('turns ==text==\'s optional {.token} into a coloured <mark>, sanitized className intact', () => {
    const html = renderMarkdownToHtml('a ==b=={.green} c', opts);
    expect(html).toContain('<mark class="folio-hl folio-hl-green">b</mark>');
    expect(html).not.toContain('{.green}');
  });

  it('defaults to yellow with no {.token}, and keeps legacy <mark> rendering exactly as before (round 21)', () => {
    const html = renderMarkdownToHtml('==sun== and <mark>yellow</mark>', opts);
    expect(html).toContain('<mark class="folio-hl folio-hl-yellow">sun</mark>');
    expect(html).toContain('<mark>yellow</mark>');
  });
});

describe('renderMarkdownToHtml: sanitization', () => {
  it('keeps the format toolbar\'s inline formatting tags (round 21: mark/ins/u survive with their markup)', () => {
    const html = renderMarkdownToHtml('<mark>yellow</mark> and <ins>underlined</ins> and <u>imported</u>', opts);
    expect(html).toContain('<mark>yellow</mark>');
    expect(html).toContain('<ins>underlined</ins>');
    expect(html).toContain('<u>imported</u>');
  });

  it('strips <script> tags and inline event handlers from raw HTML', () => {
    const html = renderMarkdownToHtml('<script>alert(1)</script>\n\n<div onclick="alert(1)">hi</div>', opts);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('onclick');
    expect(html).toContain('hi');
  });

  it('strips javascript: URLs from links', () => {
    const html = renderMarkdownToHtml('[bad](javascript:alert(1))', opts);
    expect(html).not.toContain('javascript:alert');
  });

  it('allows details/summary raw HTML through', () => {
    const html = renderMarkdownToHtml('<details><summary>More</summary>hidden text</details>', opts);
    expect(html).toContain('<details>');
    expect(html).toContain('<summary>More</summary>');
    expect(html).toContain('hidden text');
  });
});

describe('renderMarkdownToHtml: task lists', () => {
  it('renders checked/unchecked task items as disabled checkboxes', () => {
    const html = renderMarkdownToHtml('- [x] done\n- [ ] todo', opts);
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('disabled');
    expect(html).toMatch(/checked(="")?[^>]*>\s*done|checked[^>]*>\s*done/);
    expect(html).toContain('class="task-list-item"');
  });
});

describe('renderMarkdownToHtml: tables', () => {
  it('wraps tables in a horizontally-scrollable container', () => {
    const html = renderMarkdownToHtml('| A | B |\n| --- | --- |\n| 1 | 2 |', opts);
    expect(html).toContain('class="folio-table-wrap"');
    expect(html).toMatch(/<div class="folio-table-wrap"><table>/);
  });

  // Round 16: server/confluenceImport.ts neutralizes a literal <br> inside a
  // SIMPLE (pipe) table's cell into a ¶BR¶ marker during import, then
  // restores it to a literal `<br>` once the whole page is back to plain
  // markdown text — this is what an already-imported page's cell actually
  // looks like on disk, so that's what's asserted here rather than a
  // handwritten one-off.
  it('renders a literal <br> inside a pipe-table cell as a real line break, not escaped text', () => {
    const html = renderMarkdownToHtml('| A | B |\n| --- | --- |\n| line1<br>line2 | x |', opts);
    expect(html).toContain('<td>line1<br>line2</td>');
    expect(html).not.toContain('&lt;br&gt;');
  });

  // Round 16: a "complex" Confluence table (colspan/rowspan, or a cell with
  // block content — see isSimpleTable in confluenceImport.ts) is imported as
  // a raw, already-sanitized-on-the-server HTML <table>, not GFM pipe syntax.
  it('renders a raw HTML table (colspan/rowspan, nested list) with the same wrap/classes as a pipe table', () => {
    const html = renderMarkdownToHtml(
      '<table><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody>' +
        '<tr><td rowspan="2">Owner</td><td>Ann</td></tr>' +
        '<tr><td>Bob</td></tr>' +
        '<tr><td colspan="2"><ul><li>one</li><li>two</li></ul></td></tr>' +
        '</tbody></table>',
      opts,
    );
    expect(html).toContain('<div class="folio-table-wrap"><table>');
    expect(html).toContain('<td rowspan="2">Owner</td>');
    expect(html).toContain('<td colspan="2"><ul><li>one</li><li>two</li></ul></td>');
  });
});

describe('renderMarkdownToHtml: fit/scroll toggle', () => {
  it('appends a fit/scroll toggle button after an ordinary (unsized) table', () => {
    const html = renderMarkdownToHtml('| A | B |\n| --- | --- |\n| 1 | 2 |', opts);
    // The button comes AFTER the table, not before — the wrap/table prefix
    // above must stay an exact match for the two toContain assertions there.
    expect(html).toContain(
      '<button type="button" class="folio-table-toggle" data-table-toggle="0" aria-label="Show original column widths (scroll)"></button>',
    );
    expect(html.indexOf('</table>')).toBeLessThan(html.indexOf('folio-table-toggle'));
  });

  it('numbers several tables in one page in document order', () => {
    const html = renderMarkdownToHtml(
      '| A | B |\n| --- | --- |\n| 1 | 2 |\n\ntext\n\n| C | D |\n| --- | --- |\n| 3 | 4 |',
      opts,
    );
    expect(html).toContain('data-table-toggle="0"');
    expect(html).toContain('data-table-toggle="1"');
  });

  it('does NOT add a toggle to a table with explicit column widths — folio-table-sized is already permanently fixed-layout', () => {
    const html = renderMarkdownToHtml(
      '[//]: # (folio-table: w=1:30%,2:30%)\n\n| a | b |\n| - | - |\n| x | y |',
      opts,
    );
    expect(html).toContain('folio-table-sized');
    expect(html).not.toContain('folio-table-toggle');
  });

  it('still counts a sized table against the page-wide index, so a later unsized table keeps a stable position', () => {
    const html = renderMarkdownToHtml(
      '[//]: # (folio-table: w=1:30%,2:30%)\n\n| a | b |\n| - | - |\n| x | y |\n\ntext\n\n| C | D |\n| --- | --- |\n| 3 | 4 |',
      opts,
    );
    expect(html).not.toContain('data-table-toggle="0"');
    expect(html).toContain('data-table-toggle="1"');
  });
});

describe('renderMarkdownToHtml: @mentions (round 15)', () => {
  const lookup = (handle: string): string | undefined => ({ ann: 'Ann Lee' })[handle];

  it('wraps a known handle in a folio-mention span with the display name as title', () => {
    const html = renderMarkdownToHtml('ping @ann please', { ...opts, mentionLookup: lookup });
    expect(html).toContain('<span class="folio-mention" title="Ann Lee">@ann</span>');
  });

  it('leaves an unknown handle as plain text', () => {
    const html = renderMarkdownToHtml('ping @ghost please', { ...opts, mentionLookup: lookup });
    expect(html).not.toContain('folio-mention');
    expect(html).toContain('@ghost');
  });

  it('does not match an e-mail address', () => {
    const html = renderMarkdownToHtml('contact ann@example.com for help', { ...opts, mentionLookup: lookup });
    expect(html).not.toContain('folio-mention');
    expect(html).toContain('ann@example.com');
  });

  it('does not highlight a handle inside inline code or a fenced code block', () => {
    const html = renderMarkdownToHtml('`@ann` and\n\n```\n@ann\n```\n', { ...opts, mentionLookup: lookup });
    expect(html).not.toContain('folio-mention');
    expect(html).toContain('@ann');
  });

  it('wraps every known handle when several appear in the same paragraph', () => {
    const bothKnown = (handle: string): string | undefined => ({ ann: 'Ann Lee', bob: 'Bob Smith' })[handle];
    const html = renderMarkdownToHtml('cc @ann and @bob', { ...opts, mentionLookup: bothKnown });
    expect(html).toContain('title="Ann Lee">@ann</span>');
    expect(html).toContain('title="Bob Smith">@bob</span>');
  });

  it('leaves every @handle as plain text when no lookup is given at all', () => {
    const html = renderMarkdownToHtml('ping @ann please', opts);
    expect(html).not.toContain('folio-mention');
    expect(html).toContain('@ann');
  });
});

describe('renderMarkdownToHtml: heading ids (round 5)', () => {
  it('assigns no id when no cursor is given (backwards compatible)', () => {
    const html = renderMarkdownToHtml('## Setup\n', opts);
    expect(html).not.toContain('id=');
  });

  it('consumes ids from the given cursor in document order, prefixed the way rehype-sanitize\'s default DOM-clobbering guard always prefixes id (see HEADING_ID_PREFIX)', () => {
    const markdown = '# Title\n\n## Setup\n';
    const html = renderMarkdownToHtml(markdown, opts, cursorFor(markdown));
    expect(html).toContain('<h1 id="user-content-title">Title</h1>');
    expect(html).toContain('<h2 id="user-content-setup">');
  });
});

describe('renderMarkdownToHtml: collapsible sections (round 5)', () => {
  it('wraps an h2 section (up to the next h2) in a collapsible div with a toggle button and stub', () => {
    const markdown = '# Doc\n\n## First\n\nBody one.\n\n## Second\n\nBody two.\n';
    const html = renderMarkdownToHtml(markdown, opts, cursorFor(markdown));

    expect(html).toContain('class="folio-collapsible" data-collapse-slug="first"');
    expect(html).toContain('data-collapse-toggle="first"');
    expect(html).toContain('class="folio-collapsible-body"');
    // One real block ("Body one.") — not inflated by the whitespace text
    // nodes remark-rehype inserts between block elements. Grammatical
    // singular ("hidden block", not "hidden blocks") is itself a small
    // correctness check: this string now comes from i18next's count-based
    // plural key selection (the collapsible.hiddenBlocks_* keys of the
    // bundles), not one fixed string — count=1 selecting the wrong form
    // would fail this assertion.
    expect(html).toContain('1 hidden block</div>');
    expect(html).toContain('aria-label="Collapse section"');
    // "Second" starts a new section, not absorbed into "First"'s body.
    // (data-collapse-slug is NOT DOM-clobber-prefixed — only `id` is — so
    // this attribute needs no prefix, unlike the heading's own id below.)
    const firstBodyEnd = html.indexOf('folio-collapsible-body');
    const secondHeadingIndex = html.indexOf('id="user-content-second"');
    expect(secondHeadingIndex).toBeGreaterThan(firstBodyEnd);
  });

  it('picks the plural form for a 2-block section — distinct from the "one" form', () => {
    const markdown = '## Section\n\nOne.\n\nTwo.\n';
    const html = renderMarkdownToHtml(markdown, opts, cursorFor(markdown));
    expect(html).toContain('2 hidden blocks</div>');
    expect(html).not.toContain('2 hidden block<');
  });

  it('does not wrap h1 or h4+ headings', () => {
    const markdown = '# Title\n\nIntro.\n\n#### Deep\n\nText.\n';
    const html = renderMarkdownToHtml(markdown, opts, cursorFor(markdown));
    expect(html).not.toContain('folio-collapsible');
  });
});

describe('renderMarkdownToHtml: directive fallback (round 13, defense in depth)', () => {
  // The primary path for ::pagetree is pagetreeSplit.ts extracting it before
  // this function ever runs (see markdown/index.tsx) — these test what
  // happens if one somehow still reaches here directly, which is what makes
  // the spec's "no directive without a defined text fallback" rule actually
  // true at the rendering level.
  it('renders a leaf ::pagetree directive as sanitized fallback text, never raw/unhandled', () => {
    const html = renderMarkdownToHtml('::pagetree{depth=2}', opts);
    expect(html).toContain('class="folio-directive-fallback"');
    expect(html).toContain('page tree');
    expect(html).not.toContain('::pagetree');
  });

  it('falls back to the raw directive name for an unknown leaf directive (still never unhandled/raw syntax)', () => {
    const html = renderMarkdownToHtml('::mystery{x=1}', opts);
    expect(html).toContain('class="folio-directive-fallback"');
    expect(html).toContain('::mystery');
  });

  it('names an empty container directive without collapsing it to an inline span', () => {
    const html = renderMarkdownToHtml(':::pagetree{depth=1}\n:::', opts);
    expect(html).toContain('class="folio-directive-fallback-block"');
    expect(html).toContain('data-directive-label="page tree"');
  });
});

/**
 * The bug this covers was content LOSS, not a cosmetic fallback: for a
 * `:::name … :::` block the body IS the node's children, and the fallback
 * plugin used to overwrite them (`data.hChildren = [text]`) exactly as it
 * does for a leaf directive — so `:::note` / text / `:::` rendered as the
 * five characters "::note" and every word the author wrote inside was gone.
 * That hits Confluence imports and any foreign wiki markup (`:::info`,
 * `:::warning`, `:::note`) hardest, since none of those names are ones this
 * codebase knows.
 */
describe('renderMarkdownToHtml: unknown CONTAINER directive keeps its body', () => {
  const source = [
    ':::note',
    'The first paragraph of the body.',
    '',
    '- a list item',
    '- a second item',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    'The last paragraph.',
    ':::',
  ].join('\n');

  it('renders every block of a multi-block body', () => {
    const html = renderMarkdownToHtml(source, opts);
    expect(html).toContain('The first paragraph of the body.');
    expect(html).toContain('a list item');
    expect(html).toContain('a second item');
    expect(html).toContain('const x = 1;');
    expect(html).toContain('The last paragraph.');
  });

  it('keeps the body blocks as real elements, not flattened text', () => {
    const html = renderMarkdownToHtml(source, opts);
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>');
    expect(html).toContain('<code class="language-js">');
  });

  it('degrades the directive itself to a neutral named block', () => {
    const html = renderMarkdownToHtml(':::note\nbody\n:::', opts);
    expect(html).toContain('<div class="folio-directive-fallback-block" data-directive-label="::note">');
    // The old inline-span shape would have replaced the body outright.
    expect(html).not.toContain('class="folio-directive-fallback"');
  });

  it('survives the sanitizer (the label attribute is on the allowlist)', () => {
    const html = renderMarkdownToHtml(':::warning\ncareful\n:::', opts);
    expect(html).toContain('data-directive-label="::warning"');
    expect(html).toContain('careful');
  });

  it('keeps nested markdown inside the body working (links, emphasis)', () => {
    const html = renderMarkdownToHtml(':::info\nsee [here](./other.md) and *important*\n:::', opts);
    expect(html).toContain('data-folio-link="architecture/other.md"');
    expect(html).toContain('<em>important</em>');
  });

  it('still sanitizes dangerous content inside a kept body', () => {
    const html = renderMarkdownToHtml(':::note\n<script>alert(1)</script>\n:::', opts);
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('<script');
  });
});

/**
 * The owner's report, 11.09: "time renders badly" — in the incident log every
 * time came out as `15::16` in a muted font. `remark-directive` is an
 * extension of the PARSER, so it takes the `:16` inside an ordinary `15:16`,
 * and the old fallback added a second colon and wrapped it all in its span.
 */
describe('renderMarkdownToHtml: a colon in ordinary text', () => {
  it('a time stays a time, without an extra colon and without a wrapper', () => {
    const html = renderMarkdownToHtml('At 15:16 — the socket, at 17:25–17:27 too.', {} as never);
    expect(html).toContain('At 15:16 — the socket, at 17:25–17:27 too.');
    expect(html).not.toContain('folio-directive-fallback');
    expect(html).not.toContain('::16');
  });

  it('ratios and ports are not directives either', () => {
    expect(renderMarkdownToHtml('3:1 and 9:05', {} as never)).toContain('3:1 and 9:05');
  });

  it('but a declared ::pagetree still has its visible fallback', () => {
    expect(renderMarkdownToHtml('::pagetree{depth=2}', {} as never)).toContain('folio-directive-fallback');
  });
});

/**
 * Round 34: the owner reported that a nested list in Reading (the same dash
 * on every level, almost no indent, the marker running over the text on the
 * deepest level) reads differently from Live edit. The markup itself stays
 * an ordinary, natively nested `<ul><li>` without any special classes —
 * alignment/markers per level are done by markdown.css alone (checked
 * separately in a browser); here we pin that rehype/remark add nothing extra
 * that would have to be touched in the pipeline, and that nesting is not lost.
 */
describe('renderMarkdownToHtml: nested lists', () => {
  it('nests <ul><li> natively on every level without special classes or flags', () => {
    const html = renderMarkdownToHtml('- one\n  - two\n    - three\n', opts);
    expect(html).toBe(
      '<ul>\n<li>one\n<ul>\n<li>two\n<ul>\n<li>three</li>\n</ul>\n</li>\n</ul>\n</li>\n</ul>',
    );
  });

  it('a numbered list nests the same way without special classes', () => {
    const html = renderMarkdownToHtml('1. one\n   1. two\n', opts);
    expect(html).toBe('<ol>\n<li>one\n<ol>\n<li>two</li>\n</ol>\n</li>\n</ol>');
  });

  it('a checklist stays a task-list-item, not an ordinary <li> — the per-level markers must not touch it', () => {
    const html = renderMarkdownToHtml('- [ ] a task\n- [x] done\n', opts);
    expect(html).toContain('class="contains-task-list"');
    expect(html).toContain('class="task-list-item"');
    expect(html).toContain('type="checkbox"');
  });
});

/**
 * Round 34: the owner reported that a table right after a note (without an
 * empty line) stays raw `| … |` text in Reading, and is drawn as a table in
 * Live edit. Checked against the live remark-gfm (not from memory of the
 * specification): a table row does NOT interrupt a paragraph that lazily
 * continues inside a blockquote/callout — and this is confirmed right here
 * by the second test: the same table WITHOUT a callout, after an ordinary
 * paragraph without an empty line, renders as a REAL table (a GFM table can
 * interrupt an ordinary paragraph, just not a lazy continuation in a
 * blockquote). So Reading mode is correct per GFM/CommonMark; it is the live
 * widget of the editor that draws a table where there should be none (moved
 * to the report for the editor agent, the editor/** files were not touched
 * here). Reading now only marks these lines visually (`.folio-stray-table`,
 * strayTable.ts) instead of silently merging them into an unreadable line of
 * prose.
 */
describe('renderMarkdownToHtml: a table without an empty line before it', () => {
  const tableLines = '| Key | Status |\n|---|---|\n| a | b |';

  it('right after a callout — stays the text of the paragraph, marked as .folio-stray-table', () => {
    const html = renderMarkdownToHtml(`> [!NOTE]\n> The text of the note\n${tableLines}\n`, opts);
    expect(html).toContain('<div class="md-alert md-alert-note"');
    expect(html).toContain('folio-stray-table'); // the paragraph itself is marked — see strayTable.ts
    expect(html).toContain('The text of the note');
    expect(html).not.toContain('<table>');
    expect(html).not.toContain('folio-table-wrap');
    // the raw lines do not disappear — they are visible, only marked as "raw".
    expect(html).toContain('Key');
    expect(html).toContain('|---|---|');
  });

  it('right after an ordinary paragraph (without a callout) — it is a REAL table, GFM allows interrupting a paragraph', () => {
    const html = renderMarkdownToHtml(`just text\n${tableLines}\n`, opts);
    expect(html).toContain('<p>just text</p>');
    expect(html).toContain('folio-table-wrap');
    expect(html).toContain('<table>');
    expect(html).not.toContain('folio-stray-table');
  });

  it('with an empty line before it inside a callout — a real table too (not a lazy continuation)', () => {
    const html = renderMarkdownToHtml(`> [!NOTE]\n> The text of the note\n>\n> ${tableLines.split('\n').join('\n> ')}\n`, opts);
    expect(html).toContain('folio-table-wrap');
    expect(html).toContain('<table>');
    expect(html).not.toContain('folio-stray-table');
  });
});

// Owner ask, 22.09.2026: a pasted Folio page URL (exactly what TreeRow's own
// "Copy link" produces) must render as the page — its title,
// clickable, in-app — not the naked URL. `folioLinks` overrides
// rehypeFolioPageLinks' resolve/ensureResolve (see rehypeFolioLinks.ts's own
// doc comment) so this exercises the real pipeline wiring end-to-end without
// touching folioLinkIndex.ts's session-wide cache.
describe('renderMarkdownToHtml: a link to a Folio page (round 22.09.2026)', () => {
  const ORIGIN = 'https://folio.example.com';
  const URL = `${ORIGIN}/s/team-sales/p/01M320X0C31RCCZN6HYD6YQ7J0`;

  it('a resolved title replaces the raw URL, with in-app nav wired up', () => {
    const html = renderMarkdownToHtml(URL, {
      ...opts,
      origin: ORIGIN,
      folioLinks: {
        resolve: () => ({ title: 'Roadmap Q4', navPath: '/s/team-sales/p/01M320X0C31RCCZN6HYD6YQ7J0' }),
      },
    });
    expect(html).toContain('>Roadmap Q4</a>');
    expect(html).toContain('data-folio-nav="/s/team-sales/p/01M320X0C31RCCZN6HYD6YQ7J0"');
    expect(html).not.toContain(URL);
  });

  it('an unresolved link keeps showing the plain URL — never an error or an empty label', () => {
    let requested = 0;
    const html = renderMarkdownToHtml(URL, {
      ...opts,
      origin: ORIGIN,
      folioLinks: {
        resolve: () => undefined,
        ensureResolve: () => {
          requested += 1;
        },
      },
    });
    expect(html).toContain(URL);
    expect(html).not.toContain('data-folio-nav');
    expect(requested).toBe(1); // resolution was kicked off, just hasn't landed
  });

  it('a foreign URL is left as an ordinary external link', () => {
    const html = renderMarkdownToHtml('https://example.com/anything', { ...opts, origin: ORIGIN });
    expect(html).toContain('href="https://example.com/anything"');
    expect(html).not.toContain('data-folio-nav');
  });
});
