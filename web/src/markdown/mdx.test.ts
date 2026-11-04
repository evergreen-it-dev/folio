import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import i18next from 'i18next';
import { isMdxPagePath, mdxToMarkdown } from './mdx';
import { stripFrontmatter } from './frontmatter';
import { renderMarkdownToHtml } from './pipeline';
import './i18n/register';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

// Real Nimbus pages (MIT, Copyright (c) 2025 Cloudflare, Inc.).
const fixture = (name: string): string =>
  fs.readFileSync(new URL(`../../../shared/fixtures/nimbus/${name}.mdx`, import.meta.url), 'utf8');

const render = (markdown: string): string => renderMarkdownToHtml(mdxToMarkdown(stripFrontmatter(markdown)), { space: 'docs', pagePath: 'concepts/forecasts.mdx' });

describe('isMdxPagePath', () => {
  it('goes by the path alone', () => {
    expect(isMdxPagePath('a/b.mdx')).toBe(true);
    expect(isMdxPagePath('A/B.MDX')).toBe(true);
    expect(isMdxPagePath('a/b.md')).toBe(false);
    expect(isMdxPagePath(undefined)).toBe(false);
    expect(isMdxPagePath('')).toBe(false);
  });
});

describe('mdxToMarkdown', () => {
  it('leaves plain Markdown exactly as it is', () => {
    const text = '# Title\n\nText with <kbd>K</kbd> and {not mdx here}.\n\n- a\n- b\n';
    expect(mdxToMarkdown(text)).toBe(text);
  });

  it('drops ESM lines and comment lines, keeps everything in a fence', () => {
    const text = 'import A from "a";\n\nBefore.\n\n{/* a comment */}\n\n```mdx\nimport B from "b";\n{/* shown */}\n```\n';
    const out = mdxToMarkdown(text);
    expect(out).not.toContain('import A');
    expect(out).not.toContain('a comment');
    expect(out).toContain('import B from "b";');
    expect(out).toContain('{/* shown */}');
    expect(out).toContain('Before.');
  });

  it('turns a component into a labelled box with its Markdown body, nested components nesting', () => {
    const out = mdxToMarkdown('<Tabs syncKey="os">\n  <TabItem label="macOS">\n    Press **K**.\n  </TabItem>\n</Tabs>');
    expect(out).toContain('<span class="folio-mdx__tag">Tabs</span>');
    expect(out).toContain('<code class="folio-mdx__attrs">syncKey=&quot;os&quot;</code>');
    expect(out).toContain('<span class="folio-mdx__tag">TabItem</span> <span class="folio-mdx__title">macOS</span>');
    // the body was dedented, so it is a paragraph and not an indented code block
    expect(out).toMatch(/\n\nPress \*\*K\*\*\.\n\n/);
  });
});

describe('rendering a Nimbus page the way Reading does', () => {
  it('forecasts.mdx: no import text, the component is a box, the tabs keep their tables', () => {
    const html = render(fixture('forecasts'));
    expect(html).not.toContain('@/components/diagrams/ForecastPipeline');
    expect(html).toContain('folio-mdx__tag">ForecastPipeline<');
    expect(html).toContain('folio-mdx__tag">Tabs<');
    expect((html.match(/folio-mdx__tag">TabItem</g) ?? []).length).toBe(3);
    expect((html.match(/<table/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('The global model covers the whole planet');
    expect(html).toContain('folio-mdx__tag">Aside<');
  });

  it('writing-pages.mdx: Steps, Tabs with fences, raw <dl>/<details> and footnotes all still render', () => {
    const html = render(fixture('writing-pages'));
    expect(html).toContain('folio-mdx__title">Add a component<');
    expect(html).toContain('npx @cloudflare/nimbus-docs add accordion');
    expect(html).toContain('<dl>');
    expect(html).toContain('<details>');
    expect(html).toContain('<mark>highlights</mark>');
  });

  it('code-group.mdx: the export lines are not content, the expression props do not leak out as text', () => {
    const html = render(fixture('code-group'));
    expect(html).not.toContain('export const');
    expect(html).not.toContain('import { Code }');
  });
});

describe('component heads stay short', () => {
  it('shows a long expression attribute as {…}', () => {
    const out = mdxToMarkdown('<Example code={\'<CodeGroup>\\n```ts\\nexport const POST = 1;\\n```\\n</CodeGroup>\'} lang="md">\n  body\n</Example>');
    expect(out).toContain('code={…} lang=&quot;md&quot;');
    expect(out).not.toContain('export const POST');
  });

  it('keeps a short expression and cuts an endless attribute list', () => {
    const out = mdxToMarkdown(`<Card n={3} ${'a="x" '.repeat(60)}/>`);
    expect(out).toContain('n={3}');
    expect(out).toContain('…</code>');
  });
});
