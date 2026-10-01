/**
 * What every diagram type on the visimer canvas can be asked to grow
 * (round 25).
 *
 * Driven against a REAL `MermaidWysiwygEditor` rather than a mock of one: the
 * whole point of the feature is the mermaid text it produces, and that text is
 * written by visimer's own op compiler. A stub would only prove that we call
 * the methods we call. The canvas VIEW is faked where one is needed at all,
 * because it needs mermaid, fonts and a layout engine to draw anything.
 */
import { MermaidWysiwygEditor } from '@visimer/core';
import type { ShapeId } from '@visimer/core';
import { describe, expect, it } from 'vitest';
import {
  addChild,
  addConnectedNode,
  addEntity,
  connectEntities,
  describeDiagram,
  edgeFamily,
  familyOf,
  nodeFamily,
  plusIntent,
  runPlus,
  splitEdge,
  type Canvas,
  type CanvasEditor,
} from './mermaid-ops';

const FLOW = 'flowchart TD\n  A[Start] --> B[End]';
const STATE = 'stateDiagram-v2\n  [*] --> Draft\n  Draft --> Published: publish';
const SEQUENCE = 'sequenceDiagram\n  participant A\n  participant S\n  A->>S: hi';
const CLASS = 'classDiagram\n  class Page {\n    +string id\n  }\n  class Space\n  Space "1" --> "*" Page';
const ER = 'erDiagram\n  SPACE ||--o{ PAGE : contains';
const PIE = 'pie showData\n  title Time\n  "Dev" : 45\n  "Review" : 25';
const GANTT = 'gantt\n  title X\n  section A\n  T1 :1d\n  section B\n  T2 :1d';
const TIMELINE = 'timeline\n  title History\n  2024 : Idea\n  2026 : Release';
const MINDMAP = 'mindmap\n  root((Folio))\n    Pages\n      Markdown\n    Collab';

const editorFor = (code: string): CanvasEditor => new MermaidWysiwygEditor({ code });

/** The one thing the real view's `addNode` does that concerns us. */
function fakeView(editor: CanvasEditor): Canvas {
  return {
    container: { } as HTMLElement,
    addNode: (shape: ShapeId = 'rect', label = 'New node') => {
      editor.dispatch({ type: 'addNode', shape, label });
    },
    on: (() => () => {}) as Canvas['on'],
  };
}

describe('familyOf / nodeFamily / edgeFamily', () => {
  it('names the four diagram kinds that have nodes and edges', () => {
    expect(familyOf(editorFor(FLOW))).toBe('flowchart');
    expect(familyOf(editorFor(STATE))).toBe('state');
    expect(familyOf(editorFor(CLASS))).toBe('class');
    expect(familyOf(editorFor(ER))).toBe('er');
    for (const code of [SEQUENCE, PIE, GANTT, TIMELINE, MINDMAP]) {
      expect(familyOf(editorFor(code)), code.slice(0, 12)).toBeNull();
    }
  });

  it('reads an entity id back to its family', () => {
    expect(nodeFamily('node:A')).toBe('flowchart');
    expect(nodeFamily('state:Draft')).toBe('state');
    expect(nodeFamily('class:Page')).toBe('class');
    expect(nodeFamily('entity:PAGE')).toBe('er');
    expect(edgeFamily('edge:A->B#0')).toBe('flowchart');
    expect(edgeFamily('trans:A->B#0')).toBe('state');
    expect(edgeFamily('rel:A->B#0')).toBe('class');
    expect(edgeFamily('erel:A->B#0')).toBe('er');
    // Neither: visimer draws its own lifeline plus for participants.
    expect(nodeFamily('participant:A')).toBeNull();
    expect(edgeFamily('participant:A')).toBeNull();
  });
});

describe('describeDiagram', () => {
  it('offers an add for every diagram type visimer can edit', () => {
    const kinds = Object.fromEntries(
      (
        [
          ['flowchart', FLOW],
          ['state', STATE],
          ['sequence', SEQUENCE],
          ['class', CLASS],
          ['er', ER],
          ['pie', PIE],
          ['gantt', GANTT],
          ['timeline', TIMELINE],
          ['mindmap', MINDMAP],
        ] as const
      ).map(([name, code]) => [name, describeDiagram(editorFor(code)).add]),
    );

    expect(kinds).toEqual({
      flowchart: 'node',
      state: 'state',
      sequence: 'participant',
      class: 'class',
      er: 'entity',
      pie: 'slice',
      gantt: 'task',
      timeline: 'period',
      mindmap: 'idea',
    });
  });

  it('marks exactly the four graph families as connectable', () => {
    expect(describeDiagram(editorFor(FLOW)).connect).toBe(true);
    expect(describeDiagram(editorFor(CLASS)).connect).toBe(true);
    expect(describeDiagram(editorFor(TIMELINE)).connect).toBe(false);
    expect(describeDiagram(editorFor(GANTT)).connect).toBe(false);
  });

  it('offers nothing for a document visimer cannot model at all', () => {
    expect(describeDiagram(editorFor('not a diagram at all'))).toEqual({
      type: null,
      add: null,
      connect: false,
      hint: 'flat',
    });
  });

  /**
   * QA-3: the canvas bar promised «(+) on an element adds one more» to every
   * non-connectable type, sequence diagrams included — where `plusIntent`
   * deliberately offers nothing. The hint now follows the affordance.
   */
  it('promises a flat (+) only where hovering an entity actually offers one', () => {
    const hintFor = (code: string) => describeDiagram(editorFor(code)).hint;
    expect(hintFor(FLOW)).toBe('connected');
    expect(hintFor(CLASS)).toBe('connected');
    expect(hintFor(GANTT)).toBe('flat');
    expect(hintFor(PIE)).toBe('flat');
    expect(hintFor(TIMELINE)).toBe('flat');
    expect(hintFor(MINDMAP)).toBe('flat');
    expect(hintFor(SEQUENCE)).toBe('lifeline');
  });

  it('agrees with plusIntent about which entities offer a (+)', () => {
    const editor = editorFor(SEQUENCE);
    const entities = ['participant:A', 'participant:S', ...(editor.result.sequence?.events ?? []).map((e) => e.entityId)];
    expect(entities.length).toBeGreaterThan(2);
    for (const id of entities) expect(plusIntent(editor, id), id).toBeNull();
    expect(describeDiagram(editor).hint).not.toBe('flat');

    // …and the types that do answer it still say `flat`.
    const gantt = editorFor(GANTT);
    const task = gantt.result.gantt?.tasks[0]?.entityId;
    expect(task).toBeTruthy();
    expect(plusIntent(gantt, task!)).not.toBeNull();
    expect(describeDiagram(gantt).hint).toBe('flat');
  });
});

describe('addEntity', () => {
  it('adds a flowchart node through the view, so its label editor opens', () => {
    const editor = editorFor(FLOW);
    expect(addEntity(editor, fakeView(editor), 'New node')).toBe('node:C');
    expect(editor.code).toContain('C[New node]');
  });

  it('writes a valid line for each of the chart types that used to have no (+)', () => {
    const cases: Array<[code: string, text: string, expected: string]> = [
      [TIMELINE, 'New period : New event', '  New period : New event'],
      [GANTT, 'New task', '  New task :1d'],
      [MINDMAP, 'New idea', '    New idea'],
      [PIE, 'New slice', '  "New slice" : 10'],
    ];
    for (const [code, text, expected] of cases) {
      const editor = editorFor(code);
      expect(addEntity(editor, null, text), code.slice(0, 8)).not.toBeNull();
      expect(editor.code.split('\n')).toContain(expected);
    }
  });

  it('adds a participant to a sequence diagram, which visimer had no bar for', () => {
    const editor = editorFor(SEQUENCE);
    expect(addEntity(editor, null, 'New participant')).toBe('participant:New participant');
    expect(editor.code).toContain('participant New participant');
  });

  it('adds nothing to a document with no diagram in it', () => {
    const editor = editorFor('nonsense');
    expect(addEntity(editor, null, 'New')).toBeNull();
    expect(editor.code).toBe('nonsense');
  });
});

describe('connectEntities', () => {
  it('wires two flowchart nodes — what the link handle ends in', () => {
    const editor = editorFor('flowchart TD\n  A[Start]\n  B[End]');
    expect(connectEntities(editor, 'node:A', 'node:B')).toBe(true);
    expect(editor.code.split('\n')).toContain('  A --> B');
  });

  it('wires two states, two classes and two ER entities', () => {
    const state = editorFor(STATE);
    expect(connectEntities(state, 'state:Published', 'state:Draft')).toBe(true);
    expect(state.code).toContain('Published --> Draft');

    const cls = editorFor(CLASS);
    expect(connectEntities(cls, 'class:Page', 'class:Space')).toBe(true);
    expect(cls.code).toContain('Page --> Space');

    const er = editorFor(ER);
    expect(connectEntities(er, 'entity:PAGE', 'entity:SPACE')).toBe(true);
    expect(er.code).toContain('PAGE ||--o{ SPACE');
  });

  it('refuses a node to itself, and two entities from different families', () => {
    const editor = editorFor(FLOW);
    expect(connectEntities(editor, 'node:A', 'node:A')).toBe(false);
    expect(connectEntities(editor, 'node:A', 'state:Draft')).toBe(false);
    expect(editor.code).toBe(FLOW);
  });
});

describe('addConnectedNode', () => {
  it('writes the node and the edge into the flowchart source', () => {
    const editor = editorFor(FLOW);
    expect(addConnectedNode(editor, fakeView(editor), 'node:A', 'New node')).toBe('node:C');
    expect(editor.code).toBe(
      ['flowchart TD', '  A[Start] --> B[End]', '  C[New node]', '  A --> C'].join('\n'),
    );
  });

  it('writes the state and the transition into a state diagram', () => {
    const editor = editorFor(STATE);
    expect(addConnectedNode(editor, null, 'state:Draft', 'New state')).toBe('state:s1');
    expect(editor.code).toContain('s1: New state');
    expect(editor.code).toContain('Draft --> s1');
  });

  it('leaves the document alone for an entity that cannot grow one', () => {
    const editor = editorFor(FLOW);
    expect(addConnectedNode(editor, fakeView(editor), 'edge:A->B#0', 'New')).toBeNull();
    expect(editor.code).toBe(FLOW);
  });
});

describe('splitEdge', () => {
  it('turns A --> B into A --> N --> B', () => {
    const editor = editorFor(FLOW);
    expect(splitEdge(editor, fakeView(editor), 'edge:A->B#0', 'New node')).toBe('node:C');
    expect(editor.code).toBe(
      ['flowchart TD', '  A[Start]', '  B[End]', '  C[New node]', '  A --> C', '  C --> B'].join('\n'),
    );
  });

  it('keeps the edge label on the first half and the arrow style on both', () => {
    const editor = editorFor('flowchart TD\n  A[Start] -. yes .-> B[End]');
    expect(splitEdge(editor, fakeView(editor), 'edge:A->B#0', 'N')).toBe('node:C');
    expect(editor.code).toContain('A -.->|yes| C');
    expect(editor.code).toContain('C -.-> B');
    expect(editor.code).not.toContain('A -. yes .-> B');
  });

  it('splits a state transition, label and all', () => {
    const editor = editorFor(STATE);
    expect(splitEdge(editor, null, 'trans:Draft->Published#0', 'New state')).toBe('state:s1');
    expect(editor.code.split('\n')).toEqual([
      'stateDiagram-v2',
      '  [*] --> Draft',
      '  s1: New state',
      '  Draft --> s1: publish',
      '  s1 --> Published',
    ]);
  });

  it('splits a transition that starts at the [*] pseudo-state', () => {
    const editor = editorFor('stateDiagram-v2\n  [*] --> Draft');
    expect(splitEdge(editor, null, 'trans:[*]->Draft#0', 'S')).toBe('state:s1');
    expect(editor.code).toContain('[*] --> s1');
    expect(editor.code).toContain('s1 --> Draft');
    expect(editor.code).not.toContain('[*] --> Draft');
  });

  it('splits a class relation, keeping its arrow kind', () => {
    const editor = editorFor('classDiagram\n  class A\n  class B\n  A <|-- B');
    expect(splitEdge(editor, null, 'rel:A->B#0', 'NewClass')).toBe('class:NewClass');
    expect(editor.code).toContain('A <|-- NewClass');
    expect(editor.code).toContain('NewClass <|-- B');
  });

  it('splits an ER relation', () => {
    const editor = editorFor(ER);
    expect(splitEdge(editor, null, 'erel:SPACE->PAGE#0', 'NEW_ENTITY')).toBe('entity:NEW_ENTITY');
    expect(editor.code).toContain('SPACE ||--o{ NEW_ENTITY : contains');
    expect(editor.code).toContain('NEW_ENTITY ||--o{ PAGE');
  });

  it('does nothing for an edge id the document does not have', () => {
    const editor = editorFor(FLOW);
    expect(splitEdge(editor, fakeView(editor), 'edge:A->Z#0', 'N')).toBeNull();
    expect(editor.code).toBe(FLOW);
  });
});

describe('addChild', () => {
  it('indents a mindmap idea one level under the node it came from', () => {
    const editor = editorFor(MINDMAP);
    // `item:2` is the `Pages` line.
    expect(addChild(editor, 'item:2', 'New idea')).toBe('item:3');
    expect(editor.code.split('\n')).toEqual([
      'mindmap',
      '  root((Folio))',
      '    Pages',
      '      New idea',
      '      Markdown',
      '    Collab',
    ]);
    expect(editor.selection).toEqual(['item:3']);
  });

  it('is a single edit, so the code pane keeps its caret', () => {
    const editor = editorFor(MINDMAP);
    const edits: number[] = [];
    editor.on('change', (event) => edits.push(event.edits.length));
    addChild(editor, 'item:2', 'New idea');
    expect(edits).toEqual([1]);
  });
});

describe('plusIntent', () => {
  it('grows a node and splits an edge in every graph family', () => {
    expect(plusIntent(editorFor(FLOW), 'node:A')).toEqual({ kind: 'grow', add: 'node', entityId: 'node:A' });
    expect(plusIntent(editorFor(FLOW), 'edge:A->B#0')).toEqual({
      kind: 'split',
      add: 'node',
      entityId: 'edge:A->B#0',
    });
    expect(plusIntent(editorFor(CLASS), 'class:Page')?.kind).toBe('grow');
    expect(plusIntent(editorFor(ER), 'erel:SPACE->PAGE#0')?.kind).toBe('split');
  });

  it('adds a CHILD on a mindmap and a SIBLING on a flat list', () => {
    expect(plusIntent(editorFor(MINDMAP), 'item:2')).toEqual({
      kind: 'child',
      add: 'idea',
      entityId: 'item:2',
    });
    expect(plusIntent(editorFor(TIMELINE), 'item:2')).toEqual({ kind: 'append', add: 'period' });
  });

  it('keeps a gantt task inside the section it was hovered in', () => {
    const editor = editorFor(GANTT);
    expect(plusIntent(editor, 'task:5')).toEqual({ kind: 'append', add: 'task', section: 'B' });

    const intent = plusIntent(editor, 'task:3');
    expect(intent).not.toBeNull();
    runPlus(editor, null, intent!, 'New task');
    expect(editor.code.split('\n')).toEqual([
      'gantt',
      '  title X',
      '  section A',
      '  T1 :1d',
      '  New task :1d',
      '  section B',
      '  T2 :1d',
    ]);
  });

  it('offers nothing on a subgraph or a sequence participant', () => {
    expect(plusIntent(editorFor('flowchart TD\n  subgraph one\n  A\n  end'), 'subgraph:one')).toBeNull();
    expect(plusIntent(editorFor(SEQUENCE), 'participant:A')).toBeNull();
  });
});
