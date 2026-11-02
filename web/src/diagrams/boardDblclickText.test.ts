import { describe, expect, it } from 'vitest';
import { containerForDblclickText, type DblclickElement } from './boardDblclickText';

function el(id: string, over: Partial<DblclickElement> = {}): DblclickElement {
  return { id, type: 'rectangle', x: 0, y: 0, width: 100, height: 100, ...over };
}

const NO_GROUPS = { selectedElementIds: {}, selectedGroupIds: {} };
const groups = (selectedGroupIds: Record<string, boolean>) => ({ selectedElementIds: {}, selectedGroupIds });
const nearCorner = { x: 10, y: 10 };

describe('containerForDblclickText', () => {
  it('returns an empty rectangle for a click away from its centre', () => {
    expect(containerForDblclickText([el('r')], NO_GROUPS, nearCorner)).toBe('r');
  });

  it('covers ellipses and diamonds', () => {
    expect(containerForDblclickText([el('e', { type: 'ellipse' })], NO_GROUPS, nearCorner)).toBe('e');
    expect(containerForDblclickText([el('d', { type: 'diamond' })], NO_GROUPS, nearCorner)).toBe('d');
  });

  it('returns null on empty canvas', () => {
    expect(containerForDblclickText([el('r')], NO_GROUPS, { x: 500, y: 500 })).toBeNull();
    expect(containerForDblclickText([], NO_GROUPS, nearCorner)).toBeNull();
  });

  it('leaves shapes that already have bound text to Excalidraw', () => {
    const r = el('r', { boundElements: [{ id: 't', type: 'text' }] });
    expect(containerForDblclickText([r], NO_GROUPS, nearCorner)).toBeNull();
  });

  it('still redirects when the shape only has arrows bound to it', () => {
    const r = el('r', { boundElements: [{ id: 'a', type: 'arrow' }] });
    expect(containerForDblclickText([r], NO_GROUPS, nearCorner)).toBe('r');
  });

  it('uses the topmost element and ignores deleted ones', () => {
    const below = el('below');
    const above = el('above');
    expect(containerForDblclickText([below, above], NO_GROUPS, nearCorner)).toBe('above');
    expect(containerForDblclickText([below, el('above', { isDeleted: true })], NO_GROUPS, nearCorner)).toBe('below');
  });

  it('returns null when free text or an image is on top', () => {
    for (const type of ['text', 'image', 'freedraw']) {
      expect(containerForDblclickText([el('r'), el('x', { type })], NO_GROUPS, nearCorner)).toBeNull();
    }
  });

  it('reaches a shape inside a frame (frames come after their children)', () => {
    const frame = el('f', { type: 'frame', x: -50, y: -50, width: 300, height: 300 });
    expect(containerForDblclickText([el('r'), frame], NO_GROUPS, nearCorner)).toBe('r');
    expect(containerForDblclickText([el('r'), frame], NO_GROUPS, { x: 200, y: 200 })).toBeNull();
  });

  it('skips arrows and lines when finding what is under the point', () => {
    expect(containerForDblclickText([el('r'), el('a', { type: 'arrow' })], NO_GROUPS, nearCorner)).toBe('r');
    expect(containerForDblclickText([el('r'), el('l', { type: 'line' })], NO_GROUPS, nearCorner)).toBe('r');
  });

  it('leaves the double-click to Excalidraw while an arrow or line is selected', () => {
    const sel = { selectedElementIds: { a: true }, selectedGroupIds: {} };
    expect(containerForDblclickText([el('r'), el('a', { type: 'arrow' })], sel, nearCorner)).toBeNull();
    expect(containerForDblclickText([el('r'), el('a', { type: 'line' })], sel, nearCorner)).toBeNull();
    expect(containerForDblclickText([el('r')], { selectedElementIds: { r: true }, selectedGroupIds: {} }, nearCorner)).toBe('r');
  });

  it('does not take a locked shape', () => {
    expect(containerForDblclickText([el('r', { locked: true })], NO_GROUPS, nearCorner)).toBeNull();
  });

  it('leaves a shape in a selected group to Excalidraw (entering the group)', () => {
    const r = el('r', { groupIds: ['g1'] });
    expect(containerForDblclickText([r], groups({ g1: true }), nearCorner)).toBeNull();
  });

  it('redirects a shape in a group that is not selected', () => {
    const r = el('r', { groupIds: ['g1'] });
    expect(containerForDblclickText([r], NO_GROUPS, nearCorner)).toBe('r');
    expect(containerForDblclickText([r], groups({ g2: true }), nearCorner)).toBe('r');
  });

  it('treats the bounding-box edge as outside, like Excalidraw', () => {
    expect(containerForDblclickText([el('r')], NO_GROUPS, { x: 0, y: 50 })).toBeNull();
    expect(containerForDblclickText([el('r')], NO_GROUPS, { x: 100, y: 50 })).toBeNull();
  });
});
