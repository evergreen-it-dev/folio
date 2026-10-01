// @vitest-environment jsdom
/**
 * The canvas strip above the visual mermaid editor (round 21): the answer to
 * the owner's "how do I add a node?".
 *
 * `@visimer/react` is faked here — a real canvas needs mermaid, fonts and
 * layout, none of which jsdom has — but the fake owns a REAL
 * `MermaidWysiwygEditor`, so the buttons are exercised against the same op
 * compiler that runs in the browser and the assertions are on actual mermaid.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { MermaidWysiwygEditor } from '@visimer/core';
import type { ShapeId } from '@visimer/core';

const canvas = vi.hoisted(() => ({
  editor: null as InstanceType<typeof import('@visimer/core').MermaidWysiwygEditor> | null,
  /** every value of the `tool` prop the pane has asked for, in order */
  tools: [] as Array<string | undefined>,
}));

vi.mock('@visimer/react', async () => {
  const { useEffect, useRef } = await import('react');
  const { MermaidWysiwygEditor: Editor } = await import('@visimer/core');

  return {
    MermaidWysiwyg: (props: {
      code: string;
      tool?: string;
      className?: string;
      onReady?: (editor: unknown, view: unknown) => void;
    }) => {
      const host = useRef<HTMLDivElement>(null);
      canvas.tools.push(props.tool);
      useEffect(() => {
        const editor = new Editor({ code: props.code });
        canvas.editor = editor;
        props.onReady?.(editor, {
          container: host.current!,
          addNode: (shape: ShapeId = 'rect', label = 'New node') => {
            editor.dispatch({ type: 'addNode', shape, label });
          },
          on: () => () => {},
        });
        // Mount-only, exactly like the real binding's own effect.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <div ref={host} className={props.className} />;
    },
  };
});

vi.mock('mermaid', () => ({ default: { initialize: () => {}, render: async () => ({ svg: '' }), parse: async () => true } }));

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: {},
  interpolation: { escapeValue: false },
});

const { MermaidVisualPane } = await import('./mermaid-visual');

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  canvas.editor = null;
  canvas.tools.length = 0;
});

/** One macrotask through React's scheduler. */
const flush = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

/**
 * Mounts the pane and lets the lazily imported canvas resolve: the module
 * promise, the Suspense retry and the canvas's own mount effect each need a
 * turn before the bar can know what kind of diagram it is looking at.
 */
async function mount(code: string): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(<MermaidVisualPane code={code} onCodeChange={() => {}} />);
  });
  // `lazy` only suspends the first time in a file — the module is cached after
  // that — so this waits on the outcome rather than on a fixed number of ticks.
  for (let i = 0; i < 20 && container.querySelector('.folio-modal__canvas') === null; i++) {
    await flush();
  }
  await flush();
  return container;
}

const chips = (container: HTMLElement): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('.folio-modal__canvasbar .folio-modal__chip'));

describe('mermaid canvas bar', () => {
  it('offers the node and connect actions for a flowchart', async () => {
    const container = await mount('flowchart TD\n  A[Start] --> B[End]');

    expect(chips(container).map((chip) => chip.textContent)).toEqual(['+ Node', 'Connect']);
    expect(container.querySelector('.folio-modal__canvashint')?.textContent).toContain('link');
  });

  it('adds a node to the diagram when the button is pressed', async () => {
    const container = await mount('flowchart TD\n  A[Start] --> B[End]');

    act(() => chips(container)[0].click());

    expect(canvas.editor?.code).toContain('C[New node]');
  });

  it('puts the canvas into connect mode and back', async () => {
    const container = await mount('flowchart TD\n  A[Start] --> B[End]');
    const connect = chips(container)[1];

    expect(connect.getAttribute('aria-pressed')).toBe('false');
    act(() => connect.click());
    expect(connect.getAttribute('aria-pressed')).toBe('true');
    expect(canvas.tools.at(-1)).toBe('connect');

    act(() => connect.click());
    expect(canvas.tools.at(-1)).toBe('select');
  });

  /**
   * Round 25's second item, in one table: the owner's "not all types have (+)
   * — the timeline, the gantt and the mindmap do not, and they should". The label names what
   * the type actually grows, and the connect chip only appears where an edge is
   * a thing that exists.
   */
  it.each([
    ['timeline\n  title X\n  2024 : Idea', '+ Period', false],
    ['gantt\n  title X\n  section A\n  T1 :1d', '+ Task', false],
    ['mindmap\n  root((Folio))\n    Pages', '+ Idea', false],
    ['pie\n  "Dev" : 45', '+ Slice', false],
    ['sequenceDiagram\n  participant A\n  A->>B: hi', '+ Participant', false],
    ['classDiagram\n  class Page', '+ Class', true],
    ['erDiagram\n  SPACE ||--o{ PAGE : contains', '+ Entity', true],
  ])('offers a meaningful add for %s', async (code, label, connectable) => {
    const container = await mount(code);

    const labels = chips(container).map((chip) => chip.textContent);
    expect(labels[0]).toBe(label);
    expect(labels.includes('Connect')).toBe(connectable);
  });

  it('writes a valid line when the timeline add button is pressed', async () => {
    const container = await mount('timeline\n  title X\n  2024 : Idea');

    act(() => chips(container)[0].click());

    expect(canvas.editor?.code.split('\n')).toContain('  New period : New event');
  });

  /**
   * QA-3: the hint under the bar used to be picked off `connect` alone, so a
   * sequence diagram — not connectable, and with `plusIntent` deliberately
   * returning null for every one of its entities — was promised a (+) on its
   * participants that never appeared. It now names the affordance visimer
   * really draws there: the plus on the lifeline.
   */
  it('does not promise a (+) on a sequence participant', async () => {
    const container = await mount('sequenceDiagram\n  participant A\n  A->>B: hi');
    const hint = container.querySelector('.folio-modal__canvashint')?.textContent ?? '';

    expect(hint).toContain('on a lifeline');
    expect(hint).not.toContain('on an element');
  });

  it('still promises one where hovering an entity really offers it', async () => {
    const container = await mount('gantt\n  title X\n  section A\n  T1 :1d');
    expect(container.querySelector('.folio-modal__canvashint')?.textContent).toContain(
      'on an element',
    );
  });

  it('shows no bar at all for a document visimer cannot model', async () => {
    const container = await mount('not a diagram');

    expect(container.querySelector('.folio-modal__canvasbar')).toBeNull();
  });
});
