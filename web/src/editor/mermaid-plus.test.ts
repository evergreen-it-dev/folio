// @vitest-environment jsdom
/**
 * The affordances drawn over the mermaid canvas (rounds 21 and 25): the (+)
 * that grows a node, the (+) that drops a node into an edge, and the link
 * handle that drags a connection from one node to another.
 *
 * Driven against a REAL `MermaidWysiwygEditor` — the assertions are on the
 * mermaid text that comes out. The canvas VIEW is faked, because it needs
 * mermaid, fonts and a layout engine to draw anything, but it is faked to
 * behave the way the real one does (`addNode` = dispatch the flowchart op,
 * nothing else). `elementFromPoint` is injected for the same reason: jsdom has
 * no layout, so nothing is ever "under" a coordinate there.
 */
import { MermaidWysiwygEditor } from '@visimer/core';
import type { ShapeId } from '@visimer/core';
import { afterEach, describe, expect, it } from 'vitest';
import { attachCanvasAffordances, edgeAnchor, plusAnchor } from './mermaid-plus';
import type { Canvas, CanvasEditor } from './mermaid-ops';

const FLOW = 'flowchart TD\n  A[Start] --> B[End]';
const TIMELINE = 'timeline\n  title History\n  2024 : Idea\n  2026 : Release';

const editorFor = (code: string): CanvasEditor => new MermaidWysiwygEditor({ code });

function fakeView(
  editor: CanvasEditor,
  container: HTMLElement,
): Canvas & { renders: Array<(payload: { ok: boolean }) => void> } {
  const renders: Array<(payload: { ok: boolean }) => void> = [];
  return {
    container,
    renders,
    addNode: (shape: ShapeId = 'rect', label = 'New node') => {
      editor.dispatch({ type: 'addNode', shape, label });
    },
    on: ((event: string, fn: (payload: { ok: boolean }) => void) => {
      if (event === 'render') renders.push(fn);
      return () => {
        const at = renders.indexOf(fn);
        if (at >= 0) renders.splice(at, 1);
      };
    }) as Canvas['on'],
  };
}

/** A canvas container holding the entity elements visimer marks up. */
function canvasDom(...entityIds: string[]): { container: HTMLElement; nodes: HTMLElement[] } {
  const container = document.createElement('div');
  const nodes = entityIds.map((entityId) => {
    const node = document.createElement('div');
    node.setAttribute('data-mw-entity', entityId);
    node.append(document.createElement('span')); // the text inside the node
    container.append(node);
    return node;
  });
  document.body.append(container);
  return { container, nodes };
}

interface Harness {
  container: HTMLElement;
  nodes: HTMLElement[];
  group: HTMLElement;
  plus: HTMLButtonElement;
  link: HTMLButtonElement;
  view: ReturnType<typeof fakeView>;
  /** What the injected `elementFromPoint` answers with from now on. */
  setUnder(element: Element | null): void;
  detach: () => void;
}

/** The overlay over a canvas whose only elements are the ids handed in. */
function mount(editor: CanvasEditor, entityIds: string[]): Harness {
  const { container, nodes } = canvasDom(...entityIds);
  const view = fakeView(editor, container);
  let under: Element | null = null;
  const detach = attachCanvasAffordances({
    view,
    editor,
    plusTitle: (intent) => `plus:${intent.kind}`,
    linkTitle: 'link',
    newText: () => 'New node',
    elementAt: () => under,
  });
  return {
    container,
    nodes,
    view,
    setUnder: (element) => {
      under = element;
    },
    group: container.querySelector<HTMLElement>('.folio-mermaid-affordance')!,
    plus: container.querySelector<HTMLButtonElement>('.folio-mermaid-plus')!,
    link: container.querySelector<HTMLButtonElement>('.folio-mermaid-link')!,
    detach,
  };
}

const hover = (target: Element): void => {
  target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
};

/** jsdom has no PointerEvent, and the listeners only care about the type. */
const pointer = (target: EventTarget, type: string, x = 0, y = 0): void => {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
};

const detachers: Array<() => void> = [];

afterEach(() => {
  for (const off of detachers.splice(0)) off();
  document.body.innerHTML = '';
});

const keep = (harness: Harness): Harness => {
  detachers.push(harness.detach);
  return harness;
};

describe('anchors', () => {
  it('centres the node affordance on its bottom edge, in container coordinates', () => {
    const container = document.createElement('div');
    const node = document.createElement('div');
    container.getBoundingClientRect = () => ({ left: 40, top: 100 }) as DOMRect;
    node.getBoundingClientRect = () => ({ left: 90, top: 160, width: 60, bottom: 200 }) as DOMRect;

    expect(plusAnchor(container, node)).toEqual({ left: 80, top: 100 });
  });

  it('walks an edge path to its midpoint rather than using its bounding box', () => {
    const container = document.createElement('div');
    container.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    // A bent arrow: the box centre would sit well off the line.
    const path = Object.assign(document.createElement('div'), {
      getTotalLength: () => 100,
      getPointAtLength: () => ({ x: 30, y: 70 }),
      getScreenCTM: () => ({ a: 1, b: 0, c: 0, d: 1, e: 5, f: 6 }),
    }) as unknown as Element;

    expect(edgeAnchor(container, path)).toEqual({ left: 35, top: 76 });
  });

  it('falls back to the box centre when the target cannot do SVG geometry', () => {
    const container = document.createElement('div');
    const plain = document.createElement('div');
    container.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    plain.getBoundingClientRect = () => ({ left: 10, top: 20, width: 40, height: 10 }) as DOMRect;

    expect(edgeAnchor(container, plain)).toEqual({ left: 30, top: 25 });
  });
});

describe('hover affordance', () => {
  it('shows the pair on a node and hides it again off one', () => {
    const editor = editorFor(FLOW);
    const { container, nodes, group, plus, link } = keep(mount(editor, ['node:A']));

    expect(group.hidden).toBe(true);
    // The pointer is over the label inside the node, not the node element.
    hover(nodes[0].firstElementChild!);
    expect(group.hidden).toBe(false);
    expect(plus.title).toBe('plus:grow');
    expect(link.hidden).toBe(false);

    hover(container);
    expect(group.hidden).toBe(true);
  });

  it('offers the (+) but no link handle on an edge — an edge cannot start one', () => {
    const editor = editorFor(FLOW);
    const { nodes, group, plus, link } = keep(mount(editor, ['edge:A->B#0']));

    hover(nodes[0]);
    expect(group.hidden).toBe(false);
    expect(plus.title).toBe('plus:split');
    expect(link.hidden).toBe(true);
  });

  it('reaches diagram types that used to get nothing at all', () => {
    const editor = editorFor(TIMELINE);
    const { nodes, group, plus, link } = keep(mount(editor, ['item:2']));

    hover(nodes[0]);
    expect(group.hidden).toBe(false);
    expect(plus.title).toBe('plus:append');
    expect(link.hidden).toBe(true);
  });

  it('stays up while the pointer travels onto it', () => {
    const editor = editorFor(FLOW);
    const { nodes, group } = keep(mount(editor, ['node:A']));

    hover(nodes[0]);
    hover(group);
    expect(group.hidden).toBe(false);
  });

  it('ignores entities that offer nothing', () => {
    const editor = editorFor(FLOW);
    const { nodes, group } = keep(mount(editor, ['subgraph:one']));

    hover(nodes[0]);
    expect(group.hidden).toBe(true);
  });

  it('hides on a canvas re-render, when the measured SVG is replaced', () => {
    const editor = editorFor(FLOW);
    const { nodes, group, view } = keep(mount(editor, ['node:A']));

    hover(nodes[0]);
    expect(group.hidden).toBe(false);
    for (const fn of view.renders) fn({ ok: true });
    expect(group.hidden).toBe(true);
  });
});

describe('the (+)', () => {
  it('adds a connected node when clicked, and gets out of the way', () => {
    const editor = editorFor(FLOW);
    const { nodes, group, plus } = keep(mount(editor, ['node:A']));

    hover(nodes[0]);
    plus.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(editor.code).toContain('C[New node]');
    expect(editor.code).toContain('A --> C');
    // The SVG is about to be replaced; the old coordinates are meaningless.
    expect(group.hidden).toBe(true);
  });

  it('drops a node into the middle of an edge', () => {
    const editor = editorFor(FLOW);
    const { nodes, plus } = keep(mount(editor, ['edge:A->B#0']));

    hover(nodes[0]);
    plus.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(editor.code.split('\n')).toEqual([
      'flowchart TD',
      '  A[Start]',
      '  B[End]',
      '  C[New node]',
      '  A --> C',
      '  C --> B',
    ]);
  });
});

describe('the link handle', () => {
  it('connects the node it was dragged from to the node it was dropped on', () => {
    const editor = editorFor('flowchart TD\n  A[Start]\n  B[End]');
    const { container, nodes, link, setUnder } = keep(mount(editor, ['node:A', 'node:B']));
    // Everything the drag hit-tests resolves to the second node.
    setUnder(nodes[1]);

    hover(nodes[0]);
    pointer(link, 'pointerdown', 10, 10);
    expect(container.classList.contains('folio-mermaid--linking')).toBe(true);
    pointer(document, 'pointermove', 80, 90);
    expect(nodes[1].getAttribute('data-folio-link-target')).toBe('true');
    pointer(document, 'pointerup', 80, 90);

    expect(editor.code.split('\n')).toContain('  A --> B');
    expect(container.classList.contains('folio-mermaid--linking')).toBe(false);
    expect(nodes[1].hasAttribute('data-folio-link-target')).toBe(false);
  });

  it('refuses to connect a node to itself', () => {
    const editor = editorFor('flowchart TD\n  A[Start]\n  B[End]');
    const before = editor.code;
    const { nodes, link, setUnder } = keep(mount(editor, ['node:A', 'node:B']));
    setUnder(nodes[0]);

    hover(nodes[0]);
    pointer(link, 'pointerdown', 10, 10);
    pointer(document, 'pointerup', 12, 12);

    expect(editor.code).toBe(before);
  });

  it('draws a ghost edge while dragging and takes it away afterwards', () => {
    const editor = editorFor('flowchart TD\n  A[Start]\n  B[End]');
    const { container, nodes, link } = keep(mount(editor, ['node:A', 'node:B']));
    const ghost = container.querySelector<SVGElement>('.folio-mermaid-ghost')!;

    expect(ghost.style.display).toBe('none');
    hover(nodes[0]);
    pointer(link, 'pointerdown', 10, 10);
    pointer(document, 'pointermove', 44, 55);
    expect(ghost.style.display).toBe('');
    expect(ghost.querySelector('line')?.getAttribute('x2')).toBe('44');

    pointer(document, 'pointerup', 44, 55);
    expect(ghost.style.display).toBe('none');
  });

  it('drops nothing when the pointer is released over empty canvas', () => {
    const editor = editorFor('flowchart TD\n  A[Start]\n  B[End]');
    const before = editor.code;
    const { nodes, link } = keep(mount(editor, ['node:A', 'node:B']));

    hover(nodes[0]);
    pointer(link, 'pointerdown', 10, 10);
    pointer(document, 'pointerup', 400, 400);

    expect(editor.code).toBe(before);
  });

  it('is called off by Escape', () => {
    const editor = editorFor('flowchart TD\n  A[Start]\n  B[End]');
    const before = editor.code;
    const { container, nodes, link } = keep(mount(editor, ['node:A', 'node:B']));

    hover(nodes[0]);
    pointer(link, 'pointerdown', 10, 10);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    expect(container.classList.contains('folio-mermaid--linking')).toBe(false);
    pointer(document, 'pointerup', 80, 90);
    expect(editor.code).toBe(before);
  });
});

describe('teardown', () => {
  it('takes the overlay and its listeners away', () => {
    const editor = editorFor(FLOW);
    const { container, nodes, detach } = mount(editor, ['node:A']);

    detach();
    expect(container.querySelector('.folio-mermaid-affordance')).toBeNull();
    expect(container.querySelector('.folio-mermaid-ghost')).toBeNull();
    // Nothing left listening: a hover after teardown must not resurrect it.
    hover(nodes[0]);
    expect(container.querySelector('.folio-mermaid-affordance')).toBeNull();
  });

  it('unbinds the document listeners a drag installed', () => {
    const editor = editorFor('flowchart TD\n  A[Start]\n  B[End]');
    const { nodes, link, detach } = mount(editor, ['node:A', 'node:B']);

    hover(nodes[0]);
    pointer(link, 'pointerdown', 10, 10);
    detach();

    const before = editor.code;
    pointer(document, 'pointerup', 80, 90);
    expect(editor.code).toBe(before);
  });
});
