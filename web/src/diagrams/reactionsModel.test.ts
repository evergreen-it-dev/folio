import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import {
  indexReactions,
  isReactable,
  parseReactionKey,
  reactionTarget,
  reactionKey,
  sceneToContainerPoint,
  toggleReaction,
} from './reactionsModel';

const rect = (over: Record<string, unknown> = {}) =>
  ({ id: 'r1', type: 'rectangle', x: 10, y: 20, width: 100, height: 50, angle: 0, version: 3, versionNonce: 1, isDeleted: false, ...over }) as unknown as ExcalidrawElement;

describe('reaction keys', () => {
  it('round-trips and rejects malformed keys', () => {
    expect(parseReactionKey(reactionKey('el1', '👍', 'guest:Amber Fox'))).toEqual({ elementId: 'el1', emoji: '👍', userId: 'guest:Amber Fox' });
    expect(parseReactionKey('nonsense')).toBeNull();
    expect(parseReactionKey('a|b')).toBeNull();
    expect(parseReactionKey('a|b|')).toBeNull();
  });
});

describe('toggleReaction (Y.Map)', () => {
  it('sets a key per (element, emoji, user) and deletes it on the second toggle', () => {
    const doc = new Y.Doc();
    const map = doc.getMap('reactions');
    expect(toggleReaction(doc, map, 'e1', '👍', 'u1', undefined, () => 5)).toBe(true);
    expect(map.get(reactionKey('e1', '👍', 'u1'))).toEqual({ at: 5 });
    expect(toggleReaction(doc, map, 'e1', '👍', 'u1')).toBe(false);
    expect(map.size).toBe(0);
  });

  it('keeps both reactions when two clients react to the same shape concurrently, in both merge directions', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    toggleReaction(a, a.getMap('reactions'), 'e1', '👍', 'alice', undefined, () => 2);
    toggleReaction(b, b.getMap('reactions'), 'e1', '👍', 'bob', undefined, () => 1);
    toggleReaction(b, b.getMap('reactions'), 'e1', '🎉', 'bob', undefined, () => 3);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    for (const doc of [a, b]) {
      const index = indexReactions(doc.getMap('reactions'));
      expect(index.get('e1')?.get('👍')).toEqual(['bob', 'alice']); // oldest first
      expect(index.get('e1')?.get('🎉')).toEqual(['bob']);
    }
  });

  it('a removal propagates and does not disturb other users', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    toggleReaction(a, a.getMap('reactions'), 'e1', '👍', 'alice');
    toggleReaction(a, a.getMap('reactions'), 'e1', '👍', 'bob');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    toggleReaction(b, b.getMap('reactions'), 'e1', '👍', 'alice');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect(indexReactions(a.getMap('reactions')).get('e1')?.get('👍')).toEqual(['bob']);
  });

  it('indexReactions skips malformed keys', () => {
    const doc = new Y.Doc();
    const map = doc.getMap('reactions');
    map.set('garbage', { at: 1 });
    map.set(reactionKey('e1', '❤️', 'u1'), 'not-an-object');
    expect([...indexReactions(map).get('e1')!.get('❤️')!]).toEqual(['u1']);
    expect(indexReactions(map).has('garbage')).toBe(false);
  });
});

describe('geometry', () => {
  it('skips connectors, deleted elements and bound text', () => {
    expect(isReactable(rect({ type: 'arrow' }))).toBe(false);
    expect(isReactable(rect({ isDeleted: true }))).toBe(false);
    expect(isReactable(rect({ type: 'text', containerId: 'r1' }))).toBe(false);
    expect(isReactable(rect({ type: 'text', containerId: null }))).toBe(true);
  });
  it('maps scene to container pixels through scroll, zoom and offsets', () => {
    const vp = { scrollX: -50, scrollY: 10, zoom: { value: 2 }, offsetLeft: 300, offsetTop: 80 };
    expect(sceneToContainerPoint({ x: 100, y: 0 }, vp, { left: 300, top: 80 })).toEqual({ x: 100, y: 20 });
  });
});

describe('reactionTarget (when the add button shows)', () => {
  const a = rect({ id: 'a' });
  const b = rect({ id: 'b', x: 300 });
  const label = rect({ id: 'label', type: 'text', containerId: 'a' });
  const arrow = rect({ id: 'arr', type: 'arrow' });
  const free = rect({ id: 'free', type: 'text', containerId: null });
  const scene = [a, b, label, arrow, free];
  const state = (over: Record<string, unknown> = {}, ids: string[] = ['a']) => ({
    selectedElementIds: Object.fromEntries(ids.map((id) => [id, true])),
    viewModeEnabled: false,
    activeTool: { type: 'selection' },
    cursorButton: 'up',
    ...over,
  });

  it('is the single selected element, including free text', () => {
    expect(reactionTarget(scene, state())?.id).toBe('a');
    expect(reactionTarget(scene, state({}, ['free']))?.id).toBe('free');
  });
  it('maps a selected bound label (alone or with its container) to the container', () => {
    expect(reactionTarget(scene, state({}, ['label']))?.id).toBe('a');
    expect(reactionTarget(scene, state({}, ['a', 'label']))?.id).toBe('a');
  });
  it('is null with no selection, a multi-selection, a stale id, or a non-reactable element', () => {
    expect(reactionTarget(scene, state({}, []))).toBeNull();
    expect(reactionTarget(scene, { ...state(), selectedElementIds: { a: false } })).toBeNull();
    expect(reactionTarget(scene, state({}, ['a', 'b']))).toBeNull();
    expect(reactionTarget(scene, state({}, ['gone']))).toBeNull();
    expect(reactionTarget(scene, state({}, ['arr']))).toBeNull();
  });
  it('is null in View mode and with any tool other than selection', () => {
    expect(reactionTarget(scene, state({ viewModeEnabled: true }))).toBeNull();
    expect(reactionTarget(scene, state({ activeTool: { type: 'hand' } }))).toBeNull();
    expect(reactionTarget(scene, state({ activeTool: { type: 'rectangle' } }))).toBeNull();
  });
  it.each([
    ['cursorButton', 'down'],
    ['isResizing', true],
    ['isRotating', true],
    ['selectedElementsAreBeingDragged', true],
    ['editingTextElement', {}],
    ['newElement', {}],
    ['multiElement', {}],
    ['resizingElement', {}],
    ['selectionElement', {}],
  ])('is null while a gesture is in progress (%s)', (key, value) => {
    expect(reactionTarget(scene, state({ [key]: value }))).toBeNull();
  });
});
