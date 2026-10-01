// @vitest-environment jsdom
/**
 * Live mode's diagram block. Round 21 made a click the way into the editor;
 * 11.09 the owner took that back — a diagram is read far more often than it
 * is edited, and click-to-edit made it impossible to simply grab and look
 * closer. Now the press pans, Ctrl/Cmd+wheel zooms, and the editor is behind
 * a DOUBLE click (or the pencil, which was always there).
 *
 * `../diagrams` is mocked: rendering real mermaid needs a layout engine jsdom
 * does not have, and none of it decides what a click does.
 */
import { EditorState, type StateEffect } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import type { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../diagrams', () => ({ MermaidBlock: () => null }));

const { blockAnchorField, editorServicesFacet } = await import('./editor-services');
const { MermaidWidget } = await import('./mermaid-widgets');

const DOC = ['```mermaid', 'flowchart TD', '  A --> B', '```', '', 'after'].join('\n');

interface Harness {
  dom: HTMLElement;
  host: HTMLElement;
  pencil: HTMLElement;
  tools: string[];
  stage: HTMLElement;
  opened: Array<{ code: string }>;
  effects: Array<StateEffect<unknown>>;
  selections: number[];
}

function mount(doc = DOC): Harness {
  const opened: Array<{ code: string }> = [];
  const effects: Array<StateEffect<unknown>> = [];
  const selections: number[] = [];

  const state = EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage }),
      blockAnchorField,
      editorServicesFacet.of({
        openMermaidEditor: (request) => void opened.push({ code: request.code }),
        createChildPage: async () => null,
      }),
    ],
  });

  const view = {
    state,
    // The widget replaces the fence, so CodeMirror reports its start.
    posAtDOM: () => 0,
    focus: () => {},
    dom: document.body,
    dispatch: (spec: { effects?: StateEffect<unknown> | StateEffect<unknown>[]; selection?: { anchor: number } }) => {
      if (spec.effects) effects.push(...(Array.isArray(spec.effects) ? spec.effects : [spec.effects]));
      if (spec.selection) selections.push(spec.selection.anchor);
    },
  } as unknown as EditorView;

  const dom = new MermaidWidget('flowchart TD\n  A --> B').toDOM(view);
  document.body.append(dom);
  return {
    dom,
    host: dom.querySelector<HTMLElement>('.cm-md-mermaid__host')!,
    // The pencil is the LAST tool — the zoom trio sits before it.
    pencil: [...dom.querySelectorAll<HTMLElement>('.cm-md-blocktools button')].at(-1)!,
    tools: [...dom.querySelectorAll<HTMLElement>('.cm-md-blocktools button')].map((b) => b.getAttribute('aria-label') ?? ''),
    stage: dom.querySelector<HTMLElement>('.cm-md-mermaid__stage')!,
    opened,
    effects,
    selections,
  };
}

const click = (node: EventTarget): boolean =>
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
const dblclick = (node: EventTarget): boolean =>
  node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0 }));
const pointerdown = (node: EventTarget): boolean =>
  node.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('MermaidWidget in live mode', () => {
  it('opens the visual editor on a DOUBLE click on the diagram', () => {
    const page = mount();

    dblclick(page.host);

    expect(page.opened).toEqual([{ code: 'flowchart TD\n  A --> B' }]);
    // The anchor the modal re-resolves the block through at save time.
    expect(page.effects).toHaveLength(1);
  });

  it('a single click does NOT open it — that press is for panning', () => {
    const page = mount();

    click(page.host);

    expect(page.opened).toEqual([]);
  });

  it('never puts the caret into the fence instead', () => {
    const page = mount();

    // The press is swallowed so CodeMirror does not move the selection into
    // the replaced range, which is what used to reveal the source.
    expect(pointerdown(page.host)).toBe(false);
    dblclick(page.host);

    expect(page.selections).toEqual([]);
  });

  it('keeps the pencil as the second way in', () => {
    const page = mount();

    click(page.pencil);

    expect(page.opened).toEqual([{ code: 'flowchart TD\n  A --> B' }]);
  });

  it('ignores anything but the primary button', () => {
    const page = mount();

    page.host.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 2 }));

    expect(page.opened).toEqual([]);
  });

  it('offers three zoom tools before the pencil', () => {
    const page = mount();

    // Labels are translated (the suite runs in whatever language i18n booted
    // in), so this asserts the SHAPE of the toolbar; which button edits is
    // covered by the pencil test above.
    expect(page.tools).toHaveLength(4);
    expect(new Set(page.tools).size).toBe(4);
  });

  it('zoom buttons scale the stage, and fit puts it back', () => {
    const page = mount();
    const [zoomOut, zoomIn, fit] = [...page.dom.querySelectorAll<HTMLElement>('.cm-md-blocktools button')];

    expect(page.stage.style.transform).toContain('scale(1)');
    click(zoomIn);
    expect(page.stage.style.transform).not.toContain('scale(1)');
    click(zoomOut);
    expect(page.stage.style.transform).toContain('scale(1)');

    click(zoomIn);
    click(fit);
    expect(page.stage.style.transform).toBe('translate(0px, 0px) scale(1)');
  });

  it('zooms on Ctrl+wheel and leaves a plain wheel to the page', () => {
    const page = mount();

    const plain = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -200 });
    page.host.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    expect(page.stage.style.transform).toContain('scale(1)');

    const zoomed = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -200, ctrlKey: true });
    page.host.dispatchEvent(zoomed);
    expect(zoomed.defaultPrevented).toBe(true);
    expect(page.stage.style.transform).not.toContain('scale(1)');
  });
});
