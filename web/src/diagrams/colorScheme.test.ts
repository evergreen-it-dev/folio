// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getColorScheme, subscribeColorScheme } from './colorScheme';

/**
 * Round 27 fix: this module used to read ONLY `prefers-color-scheme`, so a
 * reader on a light OS who explicitly picked the dark theme got light mermaid
 * diagrams and a light excalidraw canvas on a dark page. The rule under test
 * is the one every stylesheet already follows: `data-theme` wins, the OS only
 * decides for "system" (attribute absent).
 */

type Listener = () => void;

/** Minimal matchMedia stand-in: jsdom's own never matches and can't be flipped. */
function stubMatchMedia(prefersDark: boolean) {
  const listeners = new Set<Listener>();
  const mql = {
    matches: prefersDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mql),
  );
  window.matchMedia = globalThis.matchMedia;
  return {
    /** Flip the OS preference and fire the change event, like a real MQL. */
    set(next: boolean) {
      mql.matches = next;
      listeners.forEach((fn) => fn());
    },
    listenerCount: () => listeners.size,
  };
}

/** MutationObserver delivers asynchronously (microtask) — let it drain. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  vi.unstubAllGlobals();
});

describe('getColorScheme', () => {
  it('follows the OS preference when no theme is chosen (data-theme absent)', () => {
    stubMatchMedia(true);
    expect(getColorScheme()).toBe('dark');
    stubMatchMedia(false);
    expect(getColorScheme()).toBe('light');
  });

  it('lets an explicit data-theme="dark" beat a LIGHT OS preference', () => {
    stubMatchMedia(false);
    document.documentElement.setAttribute('data-theme', 'dark');
    expect(getColorScheme()).toBe('dark');
  });

  it('lets an explicit data-theme="light" beat a DARK OS preference', () => {
    stubMatchMedia(true);
    document.documentElement.setAttribute('data-theme', 'light');
    expect(getColorScheme()).toBe('light');
  });

  it('falls back to light when matchMedia is unavailable and nothing is chosen', () => {
    vi.stubGlobal('matchMedia', undefined);
    // @ts-expect-error deliberately simulating an environment without matchMedia
    window.matchMedia = undefined;
    expect(getColorScheme()).toBe('light');
  });
});

describe('subscribeColorScheme', () => {
  it('notifies when the OS preference flips', () => {
    const media = stubMatchMedia(false);
    const onChange = vi.fn();
    const off = subscribeColorScheme(onChange);

    media.set(true);
    expect(onChange).toHaveBeenLastCalledWith('dark');
    media.set(false);
    expect(onChange).toHaveBeenLastCalledWith('light');

    off();
    expect(media.listenerCount()).toBe(0);
  });

  it('notifies when the app writes data-theme (no media change involved)', async () => {
    stubMatchMedia(false);
    const onChange = vi.fn();
    const off = subscribeColorScheme(onChange);

    document.documentElement.setAttribute('data-theme', 'dark');
    await flush();
    expect(onChange).toHaveBeenLastCalledWith('dark');

    // Back to "system" — SettingsProvider REMOVES the attribute for that.
    document.documentElement.removeAttribute('data-theme');
    await flush();
    expect(onChange).toHaveBeenLastCalledWith('light');
    off();
  });

  it('keeps reporting the chosen theme, not the OS one, after an OS flip', () => {
    const media = stubMatchMedia(false);
    document.documentElement.setAttribute('data-theme', 'dark');
    const onChange = vi.fn();
    const off = subscribeColorScheme(onChange);

    media.set(true);
    expect(onChange).toHaveBeenLastCalledWith('dark');
    media.set(false);
    expect(onChange).toHaveBeenLastCalledWith('dark');
    off();
  });

  it('stops observing data-theme once unsubscribed', async () => {
    stubMatchMedia(false);
    const onChange = vi.fn();
    subscribeColorScheme(onChange)();

    document.documentElement.setAttribute('data-theme', 'dark');
    await flush();
    expect(onChange).not.toHaveBeenCalled();
  });
});
