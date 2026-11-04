// @vitest-environment jsdom
/**
 * An MDX block is a read-only preview of text that stays in the file: a JSX component shows as a labelled box with
 * its Markdown body, the import lines as code, and a click reveals the source (where it is edited as plain text).
 */
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { act } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MdxBlockWidget } from './mdx-widget';

// From the Nimbus starter docs (MIT, Copyright (c) 2025 Cloudflare, Inc.).
const ASIDE = '<Aside type="tip" title="Preview as you write">\n  The dev server **reloads** the page on every save.\n</Aside>';
const IMPORT = 'import { ForecastPipeline } from "@/components/diagrams/ForecastPipeline";';

function stubView(doc: string): { view: EditorView; reveals: () => number } {
  let reveals = 0;
  const view = {
    state: EditorState.create({ doc }),
    posAtDOM: () => 0,
    focus: () => {},
    dispatch: () => {
      reveals++;
    },
  } as unknown as EditorView;
  return { view, reveals: () => reveals };
}

async function mount(kind: 'esm' | 'jsx', source: string): Promise<{ dom: HTMLElement; reveals: () => number }> {
  const stub = stubView(source);
  const widget = new MdxBlockWidget(kind, source, 'docs', 'guides/deploy.mdx', 'en');
  let dom!: HTMLElement;
  await act(async () => {
    dom = widget.toDOM(stub.view);
    document.body.append(dom);
  });
  return { dom, reveals: stub.reveals };
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('MdxBlockWidget', () => {
  it('draws a component as a labelled box holding its Markdown, with a badge', async () => {
    const { dom } = await mount('jsx', ASIDE);
    expect(dom.classList.contains('cm-md-mdxblock--jsx')).toBe(true);
    expect(dom.querySelector('.folio-mdx__tag')?.textContent).toBe('Aside');
    expect(dom.querySelector('.folio-mdx__title')?.textContent).toBe('Preview as you write');
    expect(dom.querySelector('strong')?.textContent).toBe('reloads');
    expect(dom.querySelector('.cm-md-mdxblock__badge')?.textContent).toBe('MDX component');
    expect(dom.contentEditable).toBe('false');
  });

  it('draws import lines as code, text for text (nothing is interpreted)', async () => {
    const { dom } = await mount('esm', `${IMPORT}\nexport const x = "<b>not html</b>";`);
    expect(dom.classList.contains('cm-md-mdxblock--esm')).toBe(true);
    expect(dom.querySelector('code')?.textContent).toBe(`${IMPORT}\nexport const x = "<b>not html</b>";`);
    expect(dom.querySelector('b')).toBeNull();
    expect(dom.querySelector('.cm-md-mdxblock__badge')?.textContent).toBe('MDX import');
  });

  it('a click reveals the source instead of acting on the preview', async () => {
    const { dom, reveals } = await mount('jsx', ASIDE);
    dom.querySelector('.folio-mdx__tag')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    expect(reveals()).toBe(1);
  });

  it('equal blocks are equal (no redraw on every keystroke elsewhere)', () => {
    const a = new MdxBlockWidget('jsx', ASIDE, 's', 'p.mdx', 'en');
    expect(a.eq(new MdxBlockWidget('jsx', ASIDE, 's', 'p.mdx', 'en'))).toBe(true);
    expect(a.eq(new MdxBlockWidget('jsx', `${ASIDE} `, 's', 'p.mdx', 'en'))).toBe(false);
    expect(a.eq(new MdxBlockWidget('esm', ASIDE, 's', 'p.mdx', 'en'))).toBe(false);
  });
});
