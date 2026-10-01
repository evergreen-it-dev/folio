/**
 * What a diagram on the visimer canvas can actually be asked to grow — one
 * place, per diagram type, so the overlay (mermaid-plus.ts) and the bar above
 * the canvas (mermaid-visual.tsx) never have to know mermaid syntax.
 *
 * Round 25, from the owner: "not all types have (+) — the timeline, the gantt
 * and the mindmap do not, and they should", and "(+) on an edge and the ability
 * to pull an edge from node to node are missing". Both are answered here; the affordances
 * that draw them are next door.
 *
 * The audit of @visimer/core 1.1.2 behind this file (dist/index.d.ts +
 * dist/index.js, which is what actually ships — the packages' `src` trees are
 * stale):
 *
 *  | type                     | add                     | connect      | delete edge          |
 *  |--------------------------|-------------------------|--------------|----------------------|
 *  | flowchart                | `addNode`               | `connect`    | `deleteEdge`         |
 *  | stateDiagram             | `st.addState`           | `st.connect` | `st.deleteTransition`|
 *  | classDiagram             | `cl.addClass`           | `cl.connect` | `cl.deleteRelation`  |
 *  | erDiagram                | `er.addEntity`          | `er.connect` | `er.deleteRelation`  |
 *  | sequenceDiagram          | `seq.addParticipant`    | —            | —                    |
 *  | gantt                    | `gantt.addTask`         | —            | —                    |
 *  | pie                      | `pie.addSlice`          | —            | —                    |
 *  | timeline / mindmap /     | `li.addItem`            | —            | —                    |
 *  | journey / kanban / …     |                         |              |                      |
 *
 * Only the first four have a semantic notion of an edge, and they are exactly
 * the four whose entities visimer's own drag-to-connect accepts (`node:`,
 * `state:`, `class:`, `entity:` — see @visimer/dom's `onSvgPointerUp`). So the
 * link affordance and the edge (+) are offered for those four and nothing else.
 *
 * `li.addItem` appends at the END of the document with the LAST item's indent
 * and trims the text it is given, so it cannot express "a CHILD of this node" —
 * which is precisely what a mindmap (+) has to mean. That one case is written
 * as a single minimal text insert instead (`addChild`), which is still a
 * one-edit change through the editor's own `applyEdits`, so the code pane's
 * caret survives it exactly like an op.
 */
import type { MermaidWysiwygEditor } from '@visimer/core';
import type { MermaidCanvasView } from '@visimer/dom';

/**
 * The parts of visimer this zone touches. Structural on purpose: it keeps the
 * surface we depend on visible in one place, and lets the tests drive the logic
 * with a plain object instead of a real canvas.
 */
export type CanvasEditor = Pick<
  MermaidWysiwygEditor,
  'code' | 'selection' | 'result' | 'dispatch' | 'applyEdits' | 'setSelection' | 'on'
>;
export type Canvas = Pick<MermaidCanvasView, 'container' | 'addNode' | 'on'>;

/* ------------------------------------------------------------- families -- */

/** The four diagram kinds that have nodes AND edges between them. */
export type GraphFamily = 'flowchart' | 'state' | 'class' | 'er';

interface FamilyInfo {
  /** Entity-id prefix of a node in this family. */
  node: string;
  /** Entity-id prefix of an edge in this family. */
  edge: string;
}

const FAMILIES: Record<GraphFamily, FamilyInfo> = {
  flowchart: { node: 'node:', edge: 'edge:' },
  state: { node: 'state:', edge: 'trans:' },
  class: { node: 'class:', edge: 'rel:' },
  er: { node: 'entity:', edge: 'erel:' },
};

/** Which family this document is, or null when it has no node/edge model. */
export function familyOf(editor: CanvasEditor): GraphFamily | null {
  const result = editor.result;
  if (result.flowchart) return 'flowchart';
  if (result.state) return 'state';
  if (result.classGraph) return 'class';
  if (result.er) return 'er';
  return null;
}

/** The family an entity id belongs to when it names a node, else null. */
export function nodeFamily(entityId: string): GraphFamily | null {
  for (const [family, info] of Object.entries(FAMILIES) as [GraphFamily, FamilyInfo][]) {
    if (entityId.startsWith(info.node)) return family;
  }
  return null;
}

/** The family an entity id belongs to when it names an edge, else null. */
export function edgeFamily(entityId: string): GraphFamily | null {
  for (const [family, info] of Object.entries(FAMILIES) as [GraphFamily, FamilyInfo][]) {
    if (entityId.startsWith(info.edge)) return family;
  }
  return null;
}

/** Strip the family prefix off a node id: `node:A` → `A`. */
function bare(entityId: string, family: GraphFamily): string {
  return entityId.slice(FAMILIES[family].node.length);
}

/* ------------------------------------------------------------ what's new -- */

/**
 * The kind of thing an "add" produces. Drives both the bar's button label and
 * the default text the new entity carries (`mermaid.new.<kind>` in i18n), so a
 * timeline says "period" and a gantt says "task" rather than all of them
 * saying "node".
 */
export type AddKind =
  | 'node'
  | 'state'
  | 'class'
  | 'entity'
  | 'participant'
  | 'task'
  | 'slice'
  | 'period'
  | 'idea'
  | 'item';

const FAMILY_ADD: Record<GraphFamily, AddKind> = {
  flowchart: 'node',
  state: 'state',
  class: 'class',
  er: 'entity',
};

/** Line-item chart types that deserve their own word for "one more of these". */
const LINE_ITEM_ADD: Record<string, AddKind> = {
  timeline: 'period',
  mindmap: 'idea',
};

/**
 * Which sentence honestly describes what hovering the canvas offers here.
 *
 * Round 28 (QA-3). This exists because the bar used to pick between two
 * sentences off `connect`, and a sequence diagram fell down the gap: it is not
 * connectable, so it got "(+) on an element adds one more" — while
 * `plusIntent` deliberately returns null for every sequence entity, so no (+)
 * ever appeared. The hint has to follow the affordance, not the edge model.
 *
 *  - `connected` — hovering an entity offers a (+) that adds a NEIGHBOUR, and a
 *    link handle; a (+) on an edge splits it. The graph families.
 *  - `flat` — hovering an entity offers a (+) that adds one more of the same
 *    (gantt, pie, timeline, kanban) or a child (mindmap).
 *  - `lifeline` — ours offers nothing, because visimer draws its own (+) along
 *    each lifeline: click inserts a message there, drag reaches another
 *    participant. Sequence diagrams only. See `plusIntent`.
 */
export type CanvasHint = 'connected' | 'flat' | 'lifeline';

export interface DiagramSupport {
  /** visimer's own type id (`flowchart`, `timeline`, …), or null if unknown. */
  type: string | null;
  /** What the bar's add button creates, or null when nothing can be added. */
  add: AddKind | null;
  /** Whether entities in this diagram can be wired to one another. */
  connect: boolean;
  /** What to promise the author about hovering. Unused when `add` is null — no bar. */
  hint: CanvasHint;
}

/**
 * What this document supports — the single question the canvas bar asks.
 *
 * `add` is non-null for every diagram type visimer can edit, which is the whole
 * point of round 25's second item: the button exists everywhere and always does
 * something meaningful for the type it is looking at.
 */
export function describeDiagram(editor: CanvasEditor): DiagramSupport {
  const result = editor.result;
  const type = result.typeInfo?.id ?? null;
  const family = familyOf(editor);
  if (family) return { type, add: FAMILY_ADD[family], connect: true, hint: 'connected' };
  if (result.sequence) return { type, add: 'participant', connect: false, hint: 'lifeline' };
  if (result.gantt) return { type, add: 'task', connect: false, hint: 'flat' };
  if (result.pie) return { type, add: 'slice', connect: false, hint: 'flat' };
  if (result.lineItems) {
    return { type, add: LINE_ITEM_ADD[result.lineItems.typeId] ?? 'item', connect: false, hint: 'flat' };
  }
  return { type, add: null, connect: false, hint: 'flat' };
}

/* ------------------------------------------------------------------ add -- */

/**
 * Add one free-standing entity of whatever kind this diagram takes, and return
 * its entity id (or null when the diagram takes none).
 *
 * Flowcharts go through the VIEW rather than the editor: `view.addNode` runs
 * the same op and additionally arms visimer's inline label editor on whatever
 * it created, so the node appears with its name selected and the author just
 * types. The op result is not returned from there, but `dispatch` selects what
 * it creates, so the new entity is the selection — guarded by a check that the
 * code actually changed and that the selected id looks like a node.
 */
export function addEntity(editor: CanvasEditor, view: Canvas | null, text: string): string | null {
  const result = editor.result;

  if (result.flowchart) {
    if (view) {
      const before = editor.code;
      view.addNode('rect', text);
      if (editor.code !== before) {
        const created = editor.selection[0];
        return created?.startsWith('node:') ? created : null;
      }
    }
    return editor.dispatch({ type: 'addNode', shape: 'rect', label: text })?.created?.[0] ?? null;
  }
  if (result.state) return editor.dispatch({ type: 'st.addState', label: text })?.created?.[0] ?? null;
  if (result.classGraph) return editor.dispatch({ type: 'cl.addClass', name: text })?.created?.[0] ?? null;
  if (result.er) return editor.dispatch({ type: 'er.addEntity', name: text })?.created?.[0] ?? null;
  if (result.sequence) {
    return editor.dispatch({ type: 'seq.addParticipant', name: text })?.created?.[0] ?? null;
  }
  if (result.gantt) return editor.dispatch({ type: 'gantt.addTask', name: text })?.created?.[0] ?? null;
  if (result.pie) return editor.dispatch({ type: 'pie.addSlice', label: text })?.created?.[0] ?? null;
  if (result.lineItems) return editor.dispatch({ type: 'li.addItem', text })?.created?.[0] ?? null;
  return null;
}

/**
 * Wire two existing entities together. Both must be nodes of the same family —
 * a stale hover across a template swap would otherwise compile an edge between
 * two different graphs.
 */
export function connectEntities(editor: CanvasEditor, sourceId: string, targetId: string): boolean {
  const family = nodeFamily(sourceId);
  if (!family || family !== nodeFamily(targetId) || sourceId === targetId) return false;
  if (family !== familyOf(editor)) return false;
  const source = bare(sourceId, family);
  const target = bare(targetId, family);
  const before = editor.code;
  switch (family) {
    case 'flowchart':
      editor.dispatch({ type: 'connect', source, target });
      break;
    case 'state':
      editor.dispatch({ type: 'st.connect', source, target });
      break;
    case 'class':
      editor.dispatch({ type: 'cl.connect', source, target });
      break;
    case 'er':
      editor.dispatch({ type: 'er.connect', source, target });
      break;
  }
  return editor.code !== before;
}

/**
 * Add a node and wire it to an existing one — what the (+) on a node does.
 * Returns the new entity id, or null when nothing could be added.
 */
export function addConnectedNode(
  editor: CanvasEditor,
  view: Canvas | null,
  entityId: string,
  text: string,
): string | null {
  const family = nodeFamily(entityId);
  if (!family || family !== familyOf(editor)) return null;

  const created = addEntity(editor, view, text);
  if (!created || nodeFamily(created) !== family) return null;
  connectEntities(editor, entityId, created);
  return created;
}

/* ----------------------------------------------------------- split edge -- */

/** Source, target and the styling of an edge, read out of the semantic graph. */
interface EdgeShape {
  source: string;
  target: string;
  label: string | null;
  /** flowchart only: keeps a dotted/thick arrow dotted/thick after the split. */
  line?: 'solid' | 'thick' | 'dotted' | 'invisible';
  arrowEnd?: 'arrow' | 'open' | 'circle' | 'cross';
  /** class diagrams only: `<|--`, `*--`, … */
  relation?: string;
}

/**
 * Read an edge out of the graph rather than out of its id: an entity id is
 * `edge:<src>-><tgt>#<n>`, and a mermaid id may itself contain `->`, so parsing
 * the string would silently mis-split some diagrams. It also gets us the label
 * and the arrow style, which the halves should keep.
 */
function edgeShape(editor: CanvasEditor, family: GraphFamily, edgeId: string): EdgeShape | null {
  const result = editor.result;
  if (family === 'flowchart') {
    const edge = result.flowchart?.edges.find((e) => e.entityId === edgeId);
    if (!edge) return null;
    return {
      source: edge.source,
      target: edge.target,
      label: edge.label,
      line: edge.seg.line,
      arrowEnd: edge.seg.arrowEnd,
    };
  }
  if (family === 'state') {
    const trans = result.state?.transitions.find((t) => t.entityId === edgeId);
    return trans ? { source: trans.source, target: trans.target, label: trans.label } : null;
  }
  if (family === 'class') {
    const rel = result.classGraph?.relations.find((r) => r.entityId === edgeId);
    return rel
      ? { source: rel.source, target: rel.target, label: rel.label, relation: rel.stmt.op }
      : null;
  }
  const rel = result.er?.relations.find((r) => r.entityId === edgeId);
  return rel ? { source: rel.source, target: rel.target, label: rel.label } : null;
}

/** One half of a split edge. The label rides on the first half only. */
function connectHalf(
  editor: CanvasEditor,
  family: GraphFamily,
  shape: EdgeShape,
  source: string,
  target: string,
  label: string | null,
): boolean {
  const before = editor.code;
  switch (family) {
    case 'flowchart':
      editor.dispatch({
        type: 'connect',
        source,
        target,
        line: shape.line,
        arrowEnd: shape.arrowEnd,
        ...(label ? { label } : {}),
      });
      break;
    case 'state':
      editor.dispatch({ type: 'st.connect', source, target, ...(label ? { label } : {}) });
      break;
    case 'class':
      editor.dispatch({
        type: 'cl.connect',
        source,
        target,
        ...(shape.relation ? { op: shape.relation as never } : {}),
        ...(label ? { label } : {}),
      });
      break;
    case 'er':
      editor.dispatch({ type: 'er.connect', source, target, ...(label ? { label } : {}) });
      break;
  }
  return editor.code !== before;
}

/** Remove an edge once both halves are in place. */
function dropEdge(editor: CanvasEditor, family: GraphFamily, edgeId: string): void {
  switch (family) {
    case 'flowchart':
      editor.dispatch({ type: 'deleteEdge', edgeId });
      break;
    case 'state':
      editor.dispatch({ type: 'st.deleteTransition', transId: edgeId });
      break;
    case 'class':
      editor.dispatch({ type: 'cl.deleteRelation', relId: edgeId });
      break;
    case 'er':
      editor.dispatch({ type: 'er.deleteRelation', relId: edgeId });
      break;
  }
}

/**
 * Put a new node in the middle of an existing edge: `A --> B` becomes
 * `A --> N` plus `N --> B`. Returns the new node's entity id, or null.
 *
 * The order is add, wire, wire, delete — never delete first. An edge's id is
 * its (source, target) occurrence counter, and neither new edge shares that
 * pair, so the original id is still valid on the last step; deleting first
 * would instead risk dropping an endpoint that nothing else references yet.
 */
export function splitEdge(
  editor: CanvasEditor,
  view: Canvas | null,
  edgeId: string,
  text: string,
): string | null {
  const family = edgeFamily(edgeId);
  if (!family || family !== familyOf(editor)) return null;
  const shape = edgeShape(editor, family, edgeId);
  if (!shape) return null;

  const created = addEntity(editor, view, text);
  if (!created || nodeFamily(created) !== family) return null;
  const middle = bare(created, family);

  if (!connectHalf(editor, family, shape, shape.source, middle, shape.label)) return created;
  if (!connectHalf(editor, family, shape, middle, shape.target, null)) return created;
  dropEdge(editor, family, edgeId);
  return created;
}

/* ------------------------------------------------ line items and friends -- */

/**
 * A child of the hovered mindmap node: one line, indented two spaces deeper,
 * inserted directly after it. Mermaid reads the first more-indented line after
 * a node as that node's child, so this is the minimal correct edit — and it is
 * a single insert, so the code pane diffs it to one change and keeps its caret.
 */
export function addChild(editor: CanvasEditor, itemId: string, text: string): string | null {
  const graph = editor.result.lineItems;
  const item = graph?.items.find((i) => i.entityId === itemId);
  if (!item) return null;
  const line = editor.result.lines[item.lineIndex];
  if (!line) return null;
  const body = text.replace(/\n/g, ' ').trim();
  if (!body) return null;

  editor.applyEdits([{ start: line.end, end: line.end, text: `\n${line.indent}  ${body}` }], 'canvas');
  const created = `item:${item.lineIndex + 1}`;
  editor.setSelection([created], 'canvas');
  return created;
}

/* --------------------------------------------------------- the (+) itself -- */

/**
 * What a (+) hanging off one entity would do. `add` is the word for the thing
 * it creates, so the tooltip and the default text come from the same key.
 */
export type PlusIntent =
  | { kind: 'grow'; add: AddKind; entityId: string }
  | { kind: 'split'; add: AddKind; entityId: string }
  | { kind: 'child'; add: AddKind; entityId: string }
  /** One more of the same, optionally inside the hovered task's gantt section. */
  | { kind: 'append'; add: AddKind; section?: string | null };

/**
 * The intent for the entity under the pointer, or null when hovering it offers
 * nothing (a subgraph, a sequence participant — visimer draws its own lifeline
 * plus for those, and a second one would be two buttons for one job).
 */
export function plusIntent(editor: CanvasEditor, entityId: string): PlusIntent | null {
  const family = familyOf(editor);
  if (family) {
    if (nodeFamily(entityId) === family) {
      return { kind: 'grow', add: FAMILY_ADD[family], entityId };
    }
    if (edgeFamily(entityId) === family) {
      return { kind: 'split', add: FAMILY_ADD[family], entityId };
    }
    return null;
  }

  const support = describeDiagram(editor);
  if (!support.add) return null;
  if (editor.result.gantt && entityId.startsWith('task:')) {
    // The section the hovered bar lives in, so a (+) on "Stage 2" does not drop
    // the new task at the bottom of "Stage 1".
    const task = editor.result.gantt.tasks.find((t) => t.entityId === entityId);
    return { kind: 'append', add: 'task', section: task?.section ?? null };
  }
  if (editor.result.pie && entityId.startsWith('slice:')) return { kind: 'append', add: 'slice' };
  if (editor.result.lineItems && entityId.startsWith('item:')) {
    // Only a mindmap has a hierarchy for a child to hang off; a timeline or a
    // kanban column is a flat list, where "one more" is the honest meaning.
    if (editor.result.lineItems.typeId === 'mindmap') {
      return { kind: 'child', add: support.add, entityId };
    }
    return { kind: 'append', add: support.add };
  }
  return null;
}

/** Carry out an intent. Returns the created entity id, or null. */
export function runPlus(
  editor: CanvasEditor,
  view: Canvas | null,
  intent: PlusIntent,
  text: string,
): string | null {
  switch (intent.kind) {
    case 'grow':
      return addConnectedNode(editor, view, intent.entityId, text);
    case 'split':
      return splitEdge(editor, view, intent.entityId, text);
    case 'child':
      return addChild(editor, intent.entityId, text);
    case 'append':
      if (intent.section != null && editor.result.gantt) {
        return (
          editor.dispatch({ type: 'gantt.addTask', section: intent.section, name: text })?.created?.[0] ?? null
        );
      }
      return addEntity(editor, view, text);
  }
}
