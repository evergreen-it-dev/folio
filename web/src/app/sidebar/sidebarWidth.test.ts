import { describe, expect, it } from 'vitest';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  nextWidthForKey,
} from './sidebarWidth';

describe('clampSidebarWidth', () => {
  it('leaves an in-range width untouched', () => {
    expect(clampSidebarWidth(320)).toBe(320);
  });

  it('clamps below the minimum', () => {
    expect(clampSidebarWidth(50)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it('clamps above the maximum', () => {
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_WIDTH);
  });

  it('accepts the exact boundaries', () => {
    expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH)).toBe(SIDEBAR_MAX_WIDTH);
  });

  it('falls back to the default for a corrupted (non-finite) stored value', () => {
    expect(clampSidebarWidth(NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Infinity)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe('nextWidthForKey', () => {
  it('ArrowRight grows by the step, ArrowLeft shrinks by the step', () => {
    expect(nextWidthForKey(300, 'ArrowRight')).toBe(316);
    expect(nextWidthForKey(300, 'ArrowLeft')).toBe(284);
  });

  it('clamps at the max when growing past it', () => {
    expect(nextWidthForKey(SIDEBAR_MAX_WIDTH - 5, 'ArrowRight')).toBe(SIDEBAR_MAX_WIDTH);
  });

  it('clamps at the min when shrinking past it', () => {
    expect(nextWidthForKey(SIDEBAR_MIN_WIDTH + 5, 'ArrowLeft')).toBe(SIDEBAR_MIN_WIDTH);
  });

  it('Home jumps to the minimum, End jumps to the maximum', () => {
    expect(nextWidthForKey(350, 'Home')).toBe(SIDEBAR_MIN_WIDTH);
    expect(nextWidthForKey(350, 'End')).toBe(SIDEBAR_MAX_WIDTH);
  });

  it('returns null for a key the handle does not respond to', () => {
    expect(nextWidthForKey(300, 'Tab')).toBeNull();
    expect(nextWidthForKey(300, 'a')).toBeNull();
  });
});
