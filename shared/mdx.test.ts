import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { docExtOf, isDirIndexName, isMdxPath, mdxTagAttributes, scanMdxBlocks, stripDocExt } from './mdx';

// Fixtures are verbatim pages of github.com/cloudflare/nimbus (MIT, Copyright (c) 2025 Cloudflare, Inc.) — see the
// comment at the top of each file's front matter.
const fixture = (name: string): string => fs.readFileSync(new URL(`./fixtures/nimbus/${name}.mdx`, import.meta.url), 'utf8');
const body = (raw: string): string => raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');

describe('path helpers', () => {
  it('knows an .mdx file from a .md one, whatever the case', () => {
    expect(isMdxPath('guides/deploy.mdx')).toBe(true);
    expect(isMdxPath('GUIDES/DEPLOY.MDX')).toBe(true);
    expect(isMdxPath('guides/deploy.md')).toBe(false);
    expect(docExtOf('a/b.mdx')).toBe('.mdx');
    expect(docExtOf('a/b.md')).toBe('.md');
    expect(docExtOf('a/b.pdf')).toBe('');
    expect(stripDocExt('a/b.mdx')).toBe('a/b');
    expect(stripDocExt('a/b.md')).toBe('a/b');
    expect(stripDocExt('a/b.table.md')).toBe('a/b.table');
  });

  it('treats index/README of either dialect as a directory page', () => {
    for (const name of ['index.md', 'index.mdx', 'README.md', 'README.mdx']) expect(isDirIndexName(name)).toBe(true);
    for (const name of ['readme.txt', 'indexes.mdx', 'my-index.md']) expect(isDirIndexName(name)).toBe(false);
  });
});

describe('scanMdxBlocks on real Nimbus pages', () => {
  it('forecasts.mdx: an import, a self-closing component, a Tabs with Markdown inside, an Aside', () => {
    const text = body(fixture('forecasts'));
    const blocks = scanMdxBlocks(text);
    for (const b of blocks) expect(text.slice(b.from, b.to)).toBe(b.source);
    expect(blocks[0]).toMatchObject({ kind: 'esm', source: 'import { ForecastPipeline } from "@/components/diagrams/ForecastPipeline";' });
    expect(blocks[1]).toMatchObject({ kind: 'jsx', name: 'ForecastPipeline', selfClosing: true, source: '<ForecastPipeline client:visible />' });
    const tabs = blocks.find((b) => b.name === 'Tabs')!;
    expect(tabs.openTag).toBe('<Tabs syncKey="model">');
    expect(tabs.source.startsWith('<Tabs syncKey="model">')).toBe(true);
    expect(tabs.source.endsWith('</Tabs>')).toBe(true);
    // the tables inside the tabs are the component's body, not blocks of their own
    expect(tabs.body).toContain('| Property | Value |');
    expect(tabs.source.match(/<TabItem /g)).toHaveLength(3);
    expect(blocks.filter((b) => b.name === 'TabItem')).toHaveLength(0);
    expect(blocks.find((b) => b.name === 'Aside')?.openTag).toBe('<Aside type="tip">');
  });

  it('code-group.mdx: multi-line template-literal exports are one block each; expression props stay in the component', () => {
    const text = body(fixture('code-group'));
    const blocks = scanMdxBlocks(text);
    const esm = blocks.filter((b) => b.kind === 'esm');
    expect(esm[0].source.split('\n')).toHaveLength(4); // the four import lines
    const pythonExport = esm.find((b) => b.source.startsWith('export const pythonSample'))!;
    expect(pythonExport.source.endsWith(')`;')).toBe(true);
    expect(pythonExport.source).toContain('headers={"Authorization": f"Bearer {KEY}"},');
    const serverExport = esm.find((b) => b.source.startsWith('export const serverSample'))!;
    expect(serverExport.source).toContain('export const POST = async');
    for (const b of esm) expect(/^(import|export) /.test(b.source)).toBe(true);
    const jsx = blocks.filter((b) => b.kind === 'jsx');
    expect(jsx.length).toBeGreaterThan(0);
    // sorted, never overlapping
    for (let i = 1; i < blocks.length; i++) expect(blocks[i].from).toBeGreaterThanOrEqual(blocks[i - 1].to);
  });

  it('writing-pages.mdx: Aside, Steps with Step children, Tabs holding indented fences; <dl>/<details> and fenced MDX are left alone', () => {
    const text = body(fixture('writing-pages'));
    const blocks = scanMdxBlocks(text);
    expect(blocks.map((b) => b.name)).toEqual(['Aside', 'Steps', 'Tabs', 'Aside']);
    const steps = blocks.find((b) => b.name === 'Steps')!;
    expect(steps.body).toContain('<Step title="Add a component">');
    const tabs = blocks.find((b) => b.name === 'Tabs')!;
    // the closing tag of the Tabs is found after fences that sit inside the tab bodies
    expect(tabs.source.endsWith('</Tabs>')).toBe(true);
    expect(tabs.source).toContain('pnpm dlx @cloudflare/nimbus-docs add accordion');
    // the fenced `mdx` example (front matter + text) and the raw HTML blocks are not MDX blocks
    expect(blocks.some((b) => b.source.startsWith('<dl>') || b.source.startsWith('<details>'))).toBe(false);
  });
});

describe('scanMdxBlocks: rules', () => {
  it('skips fenced code, whatever it shows', () => {
    const text = ['```mdx', 'import X from "x";', '<Aside>', 'hi', '</Aside>', '```', '', '~~~', '<Card />', '~~~'].join('\n');
    expect(scanMdxBlocks(text)).toEqual([]);
  });

  it('keeps a component that never closes as plain text (the author is still typing it)', () => {
    expect(scanMdxBlocks('<Aside type="note">\nunfinished\n')).toEqual([]);
  });

  it('does not make a block of inline JSX in a paragraph', () => {
    expect(scanMdxBlocks('<Badge>new</Badge> in front of a sentence')).toEqual([]);
    expect(scanMdxBlocks('Text with <Badge>new</Badge> inside')).toEqual([]);
  });

  it('counts nested components of the same name and ignores a `>` inside an attribute expression', () => {
    const text = '<Box a={x > 1 ? "}" : "{"}>\n  <Box>inner</Box>\n  tail\n</Box>\n\nafter';
    const [block, ...rest] = scanMdxBlocks(text);
    expect(rest).toEqual([]);
    expect(block.source).toBe('<Box a={x > 1 ? "}" : "{"}>\n  <Box>inner</Box>\n  tail\n</Box>');
    expect(block.openTag).toBe('<Box a={x > 1 ? "}" : "{"}>');
    expect(mdxTagAttributes(block.openTag!)).toBe('a={x > 1 ? "}" : "{"}');
  });

  it('ignores a close tag written in inline code or a fence inside the body', () => {
    const text = '<Aside>\nUse `</Aside>` to close it.\n\n```html\n</Aside>\n```\n</Aside>\n';
    const blocks = scanMdxBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source.endsWith('```\n</Aside>')).toBe(true);
  });

  it('a multi-line self-closing component and a fragment are blocks', () => {
    const text = '<Card\n  title="One"\n  icon="x"\n/>\n\n<>\n  <A />\n</>\n';
    const blocks = scanMdxBlocks(text);
    expect(blocks.map((b) => [b.kind, b.name, b.selfClosing])).toEqual([
      ['jsx', 'Card', true],
      ['jsx', '', false],
    ]);
  });

  it('an ESM statement runs past a blank line while brackets or a template literal are open', () => {
    const text = 'export const a = {\n  x: 1,\n\n  y: 2,\n};\n\nexport const b = `one\n\ntwo`;\n\nplain';
    const blocks = scanMdxBlocks(text);
    expect(blocks.map((b) => b.source)).toEqual(['export const a = {\n  x: 1,\n\n  y: 2,\n};', 'export const b = `one\n\ntwo`;']);
  });

  it('works on CRLF text: offsets stay byte-exact', () => {
    const text = 'import A from "a";\r\n\r\n<Aside>\r\n  hi\r\n</Aside>\r\n\r\nend\r\n';
    const blocks = scanMdxBlocks(text);
    expect(blocks.map((b) => b.kind)).toEqual(['esm', 'jsx']);
    for (const b of blocks) expect(text.slice(b.from, b.to)).toBe(b.source);
    expect(blocks[1].source).toBe('<Aside>\r\n  hi\r\n</Aside>');
  });

  it('plain Markdown has no blocks', () => {
    expect(scanMdxBlocks('# Title\n\nText with <kbd>K</kbd>.\n\n<details>\n<summary>x</summary>\n\ny\n</details>\n')).toEqual([]);
  });
});
