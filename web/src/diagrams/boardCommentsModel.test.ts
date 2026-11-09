import { describe, expect, it } from 'vitest';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { CommentThread } from '@shared/comments';
import { commentButtonTarget, commentableElement, containerToScenePoint, deletedTargetThreads, elementAtPoint, elementPreview, threadElementId, threadsByElement } from './boardCommentsModel';
import { sceneToContainerPoint } from './reactionsModel';

function el(id: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}): ExcalidrawElement {
  return { id, type: 'rectangle', x, y, width: w, height: h, angle: 0, strokeWidth: 0, strokeColor: 'transparent', roughness: 0, isDeleted: false, ...extra } as unknown as ExcalidrawElement;
}
function thread(id: string, elementId?: string): CommentThread {
  return {
    id,
    pageId: 'p',
    anchorFrom: null,
    anchorTo: null,
    quotedText: null,
    target: elementId ? { kind: 'board_element', elementId, label: 'x' } : null,
    status: 'open',
    createdBy: null,
    createdAt: '',
    resolvedBy: null,
    resolvedAt: null,
    comments: [],
  };
}

describe('board comment targets', () => {
  it('reads the element id of a board thread only', () => {
    expect(threadElementId(thread('t', 'e1'))).toBe('e1');
    expect(threadElementId(thread('t'))).toBeUndefined();
  });

  it('marks threads whose element left the scene, keeps the rest', () => {
    const threads = [thread('a', 'e1'), thread('b', 'gone'), thread('c')];
    expect([...deletedTargetThreads(threads, new Set(['e1']))]).toEqual(['b']);
    expect([...threadsByElement(threads).keys()]).toEqual(['e1', 'gone']);
  });

  it('hit test: the smallest element under the point wins, a label answers with its container', () => {
    const frame = el('frame', 0, 0, 500, 500, { type: 'frame' });
    const box = el('box', 100, 100, 100, 50);
    const label = el('label', 110, 110, 40, 20, { type: 'text', containerId: 'box' });
    expect(elementAtPoint([frame, box, label], { x: 120, y: 120 })?.id).toBe('box');
    expect(elementAtPoint([frame, box, label], { x: 400, y: 400 })?.id).toBe('frame');
    expect(elementAtPoint([frame, box, label], { x: 900, y: 900 })).toBeNull();
    expect(elementAtPoint([{ ...box, isDeleted: true } as ExcalidrawElement], { x: 120, y: 120 })).toBeNull();
    expect(commentableElement(label, new Map([['box', box]])).id).toBe('box');
  });

  it('container -> scene is the inverse of scene -> container', () => {
    const vp = { scrollX: 30, scrollY: -12, zoom: { value: 1.5 }, offsetLeft: 10, offsetTop: 4 };
    const origin = { left: 7, top: 3 };
    const px = sceneToContainerPoint({ x: 42, y: 77 }, vp, origin);
    const back = containerToScenePoint(px, vp, origin);
    expect(back.x).toBeCloseTo(42);
    expect(back.y).toBeCloseTo(77);
  });
});

describe('comment button and preview', () => {
  const idle = { activeTool: { type: 'selection' } };
  it('one selected element (or a shape with its label) gets the button; several or none do not', () => {
    const box = el('box', 0, 0, 10, 10);
    const label = el('label', 1, 1, 5, 5, { type: 'text', containerId: 'box' });
    const other = el('other', 50, 50, 10, 10);
    expect(commentButtonTarget([box, label, other], { ...idle, selectedElementIds: { label: true } })?.id).toBe('box');
    expect(commentButtonTarget([box, label, other], { ...idle, selectedElementIds: { box: true, label: true } })?.id).toBe('box');
    expect(commentButtonTarget([box, other], { ...idle, selectedElementIds: { box: true, other: true } })).toBeNull();
    expect(commentButtonTarget([box], { ...idle, selectedElementIds: {} })).toBeNull();
    expect(commentButtonTarget([box], { ...idle, viewModeEnabled: true, selectedElementIds: { box: true } })).toBeNull();
  });

  it('previews a shape by its bound text, else its type', () => {
    const box = el('box', 0, 0, 10, 10, { boundElements: [{ id: 'label', type: 'text' }] });
    const label = el('label', 1, 1, 5, 5, { type: 'text', text: 'Ship it', originalText: 'Ship it', containerId: 'box' });
    expect(elementPreview(box, [box, label])).toBe('Ship it');
    expect(elementPreview(el('x', 0, 0, 1, 1, { type: 'ellipse' }), [])).toBe('ellipse');
  });
});
