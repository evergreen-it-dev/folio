/**
 * Round 23 follow-up ("an agent needs STRUCTURE, not a dump of strings") — unit
 * coverage for `extractBoardStructure`/`boardStructureYaml` in isolation
 * (markdown.test.ts covers the integration into `pageSourceMarkdown`/
 * `assembleMarkdown`). Pure — no PG, no fs; every fixture is a hand-built
 * excalidraw scene run through the same `encodeScenePayload` codec
 * `confluenceWhiteboard.ts` writes with.
 *
 * The main thing under test is the GRAPH, not the text: that an arrow's
 * `startBinding`/`endBinding` becomes an `edges[].from`/`to` pair naming the
 * short ids of the shapes it connects, that a shape's bound caption folds
 * into that shape rather than becoming a second node, and that frames group
 * their contents while unframed elements land under the top-level `nodes`.
 */
import { describe, expect, it } from 'vitest';
import * as yaml from 'js-yaml';
import { encodeScenePayload } from '../confluenceWhiteboard.js';
import { boardStructureYaml, extractBoardStructure } from './boardText.js';

function sceneSvg(elements: unknown[]): string {
  const scene = { type: 'excalidraw', version: 2, source: 'test', elements, appState: {}, files: {} };
  const payload = encodeScenePayload(scene as never);
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">' +
    '<metadata><!-- payload-type:application/vnd.excalidraw+json -->' +
    `<!-- payload-start -->${payload}<!-- payload-end --></metadata></svg>\n`
  );
}

function shape(id: string, type: string, x: number, y: number, frameId: string | null = null) {
  return { id, type, x, y, width: 100, height: 60, frameId, containerId: null, isDeleted: false };
}

function boundLabel(id: string, containerId: string, x: number, y: number, text: string) {
  return { id, type: 'text', x, y, width: 80, height: 20, text, originalText: text, containerId, frameId: null, isDeleted: false };
}

function freeText(id: string | undefined, x: number, y: number, text: string, frameId: string | null = null) {
  return { id, type: 'text', x, y, width: 80, height: 20, text, originalText: text, frameId, isDeleted: false };
}

function arrow(id: string, x: number, y: number, fromId?: string, toId?: string) {
  return {
    id,
    type: 'arrow',
    x,
    y,
    width: 100,
    height: 0,
    points: [
      [0, 0],
      [100, 0],
    ],
    startBinding: fromId ? { elementId: fromId, focus: 0, gap: 4 } : null,
    endBinding: toId ? { elementId: toId, focus: 0, gap: 4 } : null,
    isDeleted: false,
  };
}

describe('extractBoardStructure', () => {
  it('an empty scene yields no frames/nodes/edges', () => {
    expect(extractBoardStructure(sceneSvg([]))).toEqual({ frames: [], nodes: [], edges: [] });
  });

  it('an unreadable/absent scene yields no frames/nodes/edges, not a throw', () => {
    expect(extractBoardStructure('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>')).toEqual({
      frames: [],
      nodes: [],
      edges: [],
    });
  });

  it('a shape and its bound caption fold into ONE node, not two', () => {
    const structure = extractBoardStructure(
      sceneSvg([shape('box1', 'rectangle', 0, 0), boundLabel('lbl1', 'box1', 10, 10, 'Gateway')]),
    );
    expect(structure.nodes).toEqual([{ id: 'n1', type: 'rectangle', text: 'Gateway' }]);
  });

  it('an arrow becomes an edge naming the short ids of the shapes it binds', () => {
    const structure = extractBoardStructure(
      sceneSvg([
        shape('a', 'rectangle', 0, 0),
        boundLabel('a-lbl', 'a', 0, 0, 'Start'),
        shape('b', 'rectangle', 300, 0),
        boundLabel('b-lbl', 'b', 300, 0, 'End'),
        arrow('arr1', 100, 20, 'a', 'b'),
      ]),
    );
    expect(structure.nodes).toEqual([
      { id: 'n1', type: 'rectangle', text: 'Start' },
      { id: 'n2', type: 'rectangle', text: 'End' },
    ]);
    expect(structure.edges).toEqual([{ from: 'n1', to: 'n2' }]);
  });

  it("an arrow's own bound label becomes the edge's text", () => {
    const structure = extractBoardStructure(
      sceneSvg([
        shape('a', 'rectangle', 0, 0),
        boundLabel('a-lbl', 'a', 0, 0, 'Start'),
        shape('b', 'rectangle', 300, 0),
        boundLabel('b-lbl', 'b', 300, 0, 'End'),
        arrow('arr1', 100, 20, 'a', 'b'),
        boundLabel('arr1-label', 'arr1', 150, 20, 'on failure'),
      ]),
    );
    expect(structure.edges).toEqual([{ from: 'n1', to: 'n2', text: 'on failure' }]);
  });

  it('an unlabelled shape that an arrow touches still becomes a node, with no text field', () => {
    const structure = extractBoardStructure(
      sceneSvg([shape('a', 'rectangle', 0, 0), shape('b', 'ellipse', 300, 0), arrow('arr1', 100, 0, 'a', 'b')]),
    );
    expect(structure.nodes).toEqual([
      { id: 'n1', type: 'rectangle' },
      { id: 'n2', type: 'ellipse' },
    ]);
    expect(structure.edges).toEqual([{ from: 'n1', to: 'n2' }]);
  });

  it("an arrow endpoint that binds to nothing (or to a deleted element) resolves to null, never dangling or omitted", () => {
    const structure = extractBoardStructure(sceneSvg([shape('a', 'rectangle', 0, 0), arrow('arr1', 100, 0, 'a', 'ghost')]));
    expect(structure.edges).toEqual([{ from: 'n1', to: null }]);
  });

  it('a free-floating text element with no id at all still becomes a node (id is optional on read)', () => {
    const structure = extractBoardStructure(sceneSvg([freeText(undefined, 0, 0, 'no id here')]));
    expect(structure.nodes).toEqual([{ id: 'n1', type: 'text', text: 'no id here' }]);
  });

  it('frames group their own elements in reading order; unframed elements land under the top-level nodes', () => {
    const structure = extractBoardStructure(
      sceneSvg([
        { id: 'f1', type: 'frame', x: 0, y: 0, width: 400, height: 200, name: 'Backend', isDeleted: false },
        shape('t2', 'rectangle', 200, 40, 'f1'),
        boundLabel('t2-lbl', 't2', 200, 40, 'queue'),
        shape('t1', 'rectangle', 10, 40, 'f1'),
        boundLabel('t1-lbl', 't1', 10, 40, 'api gateway'),
        freeText('t3', 10, 300, 'standalone note'),
      ]),
    );
    expect(structure.frames).toEqual([
      {
        name: 'Backend',
        nodes: [
          { id: 'n1', type: 'rectangle', text: 'api gateway' },
          { id: 'n2', type: 'rectangle', text: 'queue' },
        ],
      },
    ]);
    expect(structure.nodes).toEqual([{ id: 'n3', type: 'text', text: 'standalone note' }]);
  });

  it('an unnamed frame gets a positional fallback name; an empty frame is omitted entirely', () => {
    const structure = extractBoardStructure(
      sceneSvg([
        { id: 'f1', type: 'frame', x: 0, y: 0, width: 100, height: 100, name: '', isDeleted: false },
        { id: 'f2', type: 'frame', x: 200, y: 0, width: 100, height: 100, name: '  ', isDeleted: false },
        freeText('t1', 10, 10, 'inside', 'f1'),
      ]),
    );
    // f2 has no qualifying element in it — dropped, not emitted as `nodes: []`.
    expect(structure.frames).toEqual([{ name: 'Frame 1', nodes: [{ id: 'n1', type: 'text', text: 'inside' }] }]);
  });

  it('a deleted element contributes nothing', () => {
    const structure = extractBoardStructure(
      sceneSvg([{ ...freeText('t1', 0, 0, 'gone'), isDeleted: true }]),
    );
    expect(structure).toEqual({ frames: [], nodes: [], edges: [] });
  });
});

describe('boardStructureYaml', () => {
  it('returns null for an empty scene — the caller then emits only the picture', () => {
    expect(boardStructureYaml(sceneSvg([]))).toBeNull();
  });

  it('omits frames/nodes/edges keys that would be empty, rather than emitting `key: []`', () => {
    const out = boardStructureYaml(sceneSvg([freeText('t1', 0, 0, 'solo')]));
    expect(out).not.toBeNull();
    expect(out).not.toContain('frames:');
    expect(out).not.toContain('edges:');
    expect(out).toContain('nodes:');
  });

  it('round-trips through YAML parsing back to the same structure', () => {
    const svg = sceneSvg([
      { id: 'f1', type: 'frame', x: 0, y: 0, width: 400, height: 200, name: 'Backend', isDeleted: false },
      shape('a', 'rectangle', 10, 40, 'f1'),
      boundLabel('a-lbl', 'a', 10, 40, 'api gateway'),
      shape('b', 'rectangle', 10, 300),
      boundLabel('b-lbl', 'b', 10, 300, 'queue'),
      arrow('arr1', 100, 100, 'a', 'b'),
      boundLabel('arr1-label', 'arr1', 100, 100, 'publishes'),
    ]);
    const dumped = boardStructureYaml(svg);
    expect(dumped).not.toBeNull();
    const parsed = yaml.load(dumped!);
    expect(parsed).toEqual(extractBoardStructure(svg));
  });

  it('is a fixed, documented schema: frames -> nodes -> edges, each with the fields the docblock promises', () => {
    const svg = sceneSvg([
      { id: 'f1', type: 'frame', x: 0, y: 0, width: 400, height: 200, name: 'Backend', isDeleted: false },
      shape('a', 'rectangle', 10, 40, 'f1'),
      boundLabel('a-lbl', 'a', 10, 40, 'api gateway'),
      shape('b', 'rectangle', 10, 300),
      arrow('arr1', 100, 100, 'a', 'b'),
    ]);
    const dumped = boardStructureYaml(svg)!;
    const order = ['frames:', 'nodes:', 'edges:'].map((key) => dumped.indexOf(key)).filter((i) => i !== -1);
    expect(order).toEqual([...order].sort((a, b) => a - b)); // frames before nodes before edges, always
  });
});
