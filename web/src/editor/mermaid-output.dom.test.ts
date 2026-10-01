// @vitest-environment jsdom
/**
 * The end of round 25's first two items: whatever the canvas affordances write,
 * mermaid itself must be able to read.
 *
 * mermaid-ops.test.ts asserts the exact text; this one hands that same text to
 * the real `mermaid.parse`. It is the check that matters for the diagram types
 * that had no (+) before — a gantt task whose only metadata is a duration, or a
 * mindmap child at a hand-computed indent, are exactly the kind of thing that
 * looks right in a diff and still fails to render.
 *
 * jsdom rather than node: mermaid's parser reaches for `document` while it
 * initialises.
 */
import { MermaidWysiwygEditor } from '@visimer/core';
import mermaid from 'mermaid';
import { beforeAll, describe, expect, it } from 'vitest';
import { addChild, addEntity, connectEntities, splitEdge, type CanvasEditor } from './mermaid-ops';

const editorFor = (code: string): CanvasEditor => new MermaidWysiwygEditor({ code });

beforeAll(() => {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
});

/** Runs the mutation, then asks mermaid whether the result is a diagram. */
async function expectParses(editor: CanvasEditor): Promise<void> {
  await expect(mermaid.parse(editor.code), editor.code).resolves.toBeTruthy();
}

describe('what the add button writes', () => {
  it.each([
    ['timeline', 'timeline\n  title X\n  2024 : Idea', 'New period : New event'],
    ['gantt with dates', 'gantt\n  title X\n  dateFormat YYYY-MM-DD\n  section A\n  T1 :a1, 2026-01-05, 7d', 'New task'],
    ['gantt bare', 'gantt\n  title X\n  section A\n  T1 :1d', 'New task'],
    ['mindmap', 'mindmap\n  root((Folio))\n    Pages', 'New idea'],
    ['pie', 'pie showData\n  title X\n  "Dev" : 45', 'New slice'],
    ['sequence', 'sequenceDiagram\n  participant A\n  A->>B: hi', 'New participant'],
    ['class', 'classDiagram\n  class Page', 'NewClass'],
    ['er', 'erDiagram\n  SPACE ||--o{ PAGE : contains', 'NEW_ENTITY'],
  ])('parses after adding to a %s', async (_name, code, text) => {
    const editor = editorFor(code);
    expect(addEntity(editor, null, text)).not.toBeNull();
    await expectParses(editor);
  });

  it('parses after a mindmap child is indented under its parent', async () => {
    const editor = editorFor('mindmap\n  root((Folio))\n    Pages\n      Markdown\n    Collab');
    expect(addChild(editor, 'item:2', 'New idea')).toBe('item:3');
    await expectParses(editor);
  });
});

describe('what the edge (+) and the link handle write', () => {
  it.each([
    ['flowchart', 'flowchart TD\n  A[Start] --> B[End]', 'edge:A->B#0', 'New node'],
    ['flowchart, dotted and labelled', 'flowchart TD\n  A[Start] -. yes .-> B[End]', 'edge:A->B#0', 'New node'],
    ['state', 'stateDiagram-v2\n  [*] --> Draft\n  Draft --> Published: publish', 'trans:Draft->Published#0', 'New state'],
    ['state from [*]', 'stateDiagram-v2\n  [*] --> Draft', 'trans:[*]->Draft#0', 'New state'],
    ['class', 'classDiagram\n  class A\n  class B\n  A <|-- B', 'rel:A->B#0', 'NewClass'],
    ['er', 'erDiagram\n  SPACE ||--o{ PAGE : contains', 'erel:SPACE->PAGE#0', 'NEW_ENTITY'],
  ])('parses after splitting an edge in a %s', async (_name, code, edgeId, text) => {
    const editor = editorFor(code);
    expect(splitEdge(editor, null, edgeId, text)).not.toBeNull();
    await expectParses(editor);
  });

  it.each([
    ['flowchart', 'flowchart TD\n  A[Start]\n  B[End]', 'node:A', 'node:B'],
    ['state', 'stateDiagram-v2\n  [*] --> Draft\n  Draft --> Published: publish', 'state:Published', 'state:Draft'],
    ['class', 'classDiagram\n  class A\n  class B', 'class:A', 'class:B'],
    ['er', 'erDiagram\n  SPACE ||--o{ PAGE : contains', 'entity:PAGE', 'entity:SPACE'],
  ])('parses after a link is dragged in a %s', async (_name, code, source, target) => {
    const editor = editorFor(code);
    expect(connectEntities(editor, source, target)).toBe(true);
    await expectParses(editor);
  });
});
