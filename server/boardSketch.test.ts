/**
 * AI assistant (Cursor SDK), board builder — one focused smoke test per the
 * round's instructions: buildSceneFromSketch's output must pass
 * confluenceWhiteboard.ts's own selfcheckWhiteboardSvg (the SAME guard every
 * imported/edited board goes through), not a separate hand-rolled assertion
 * set.
 */
import { describe, expect, it } from 'vitest';
import { renderSceneSvg, selfcheckWhiteboardSvg } from './confluenceWhiteboard.js';
import { buildSceneFromSketch, type BoardSketch } from './boardSketch.js';

describe('boardSketch.ts: buildSceneFromSketch', () => {
  it('builds a scene (frame, shapes, text, elbowed + straight edges with labels) that passes the whiteboard selfcheck', () => {
    const sketch: BoardSketch = {
      background: '#ffffff',
      nodes: [
        { id: 'frame1', type: 'frame', label: 'Flow', x: 0, y: 0, w: 900, h: 200 },
        { id: 'start', type: 'ellipse', label: 'Start', x: 40, y: 60, frame: 'frame1' },
        { id: 'end', type: 'rectangle', label: 'Done', x: 640, y: 60, background: '#F8E6A0', frame: 'frame1' },
        // Outside any frame, and with a long label narrow-wrapped by the diamond's
        // own max-width formula — exercises the "grow the container" path without
        // risking a frame-containment failure from the growth.
        { id: 'decide', type: 'diamond', label: 'A very long label that should force the container to grow taller than its default height', x: 300, y: 400 },
        { id: 'note', type: 'text', label: 'Freestanding note, no container', x: 40, y: 700, w: 200 },
      ],
      edges: [
        { from: 'start', to: 'decide', label: 'go' },
        { from: 'decide', to: 'end', elbowed: false, color: '#0B66E4' },
        { from: 'decide', to: 'note', start: 'arrow', end: null },
      ],
    };

    const scene = buildSceneFromSketch(sketch);
    const svg = renderSceneSvg(scene);
    const count = selfcheckWhiteboardSvg(svg);
    expect(count).toBe(scene.elements.length);
    expect(svg).toContain('<svg');
    expect(svg).toContain('payload-start');
  });

  it('rejects an edge that references an unknown node id', () => {
    const sketch: BoardSketch = {
      nodes: [{ id: 'a', type: 'rectangle', x: 0, y: 0 }],
      edges: [{ from: 'a', to: 'missing' }],
    };
    expect(() => buildSceneFromSketch(sketch)).toThrow(/unknown node/);
  });

  it('rejects a node placed in an unknown frame', () => {
    const sketch: BoardSketch = {
      nodes: [{ id: 'a', type: 'rectangle', x: 0, y: 0, frame: 'nope' }],
      edges: [],
    };
    expect(() => buildSceneFromSketch(sketch)).toThrow(/unknown frame/);
  });
});
