import { describe, expect, it } from 'vitest';
import { isKeyboardOpen, keyboardSafeHeight } from './visualViewport';

describe('keyboardSafeHeight', () => {
  it('leaves the layout to CSS while the keyboard is closed', () => {
    expect(keyboardSafeHeight(null, 56)).toBeNull();
    // A collapsing address bar is not a keyboard.
    expect(keyboardSafeHeight({ height: 760, offsetTop: 0, layoutHeight: 812 }, 56)).toBeNull();
  });

  it('with the keyboard open, ends the container on the visible bottom edge', () => {
    const box = { height: 480, offsetTop: 0, layoutHeight: 812 };
    expect(isKeyboardOpen(box)).toBe(true);
    expect(keyboardSafeHeight(box, 56)).toBe(424);
  });

  it('counts the scroll iOS applies to reveal the focused field', () => {
    const box = { height: 480, offsetTop: 40, layoutHeight: 812 };
    expect(keyboardSafeHeight(box, 56)).toBe(464);
  });

  it('never collapses the container below its floor', () => {
    const box = { height: 200, offsetTop: 0, layoutHeight: 812 };
    expect(keyboardSafeHeight(box, 120)).toBe(160);
  });
});
