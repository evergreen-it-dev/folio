// @vitest-environment jsdom
/**
 * The toolbar hotkey on a Mac (round 26).
 *
 * Its own file because it has to lie about the platform before CodeMirror is
 * loaded: `browser.mac` in @codemirror/view and `mac` in w3c-keyname are both
 * read from `navigator.platform` at module-evaluation time, so the stub has to
 * be in place before the first `import` of either — hence the dynamic imports
 * below, and hence no static import of anything that reaches them.
 *
 * What this pins down is the bug the owner hit: ⌥⇧P did nothing on his Mac, so
 * once the strip was unpinned there was no way back at all. `firstTest` below
 * is the proof, and it is also the canary — if the platform stub ever stops
 * taking effect, that test fails loudly rather than passing for the wrong
 * reason.
 */
import { afterEach, describe, expect, it } from 'vitest';

Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });

const { EditorSelection, EditorState } = await import('@codemirror/state');
const { EditorView, keymap } = await import('@codemirror/view');
const { livePreview, livePreviewConfig } = await import('./live-preview');
const { markdownEditorExtensions } = await import('./markdown-setup');
const { TOOLBAR_HOTKEY, isToolbarPinned, matchesToolbarHotkey, subscribeToolbarPinned, toolbarPinnedNow } =
  await import('./pin-toolbar');

/**
 * What a Mac actually sends for ⌥⇧P. The Option layer has already turned the
 * character into «∏» by the time the page sees it; only `code` (and the legacy
 * `keyCode`) still say which key was pressed.
 */
function macAltShiftP(): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: '∏',
    code: 'KeyP',
    keyCode: 80,
    altKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  } as KeyboardEventInit);
}

/** `EditorView` arrives as a value from a dynamic import, so the type comes off it. */
type View = InstanceType<typeof EditorView>;

const views: View[] = [];

function mount(): View {
  const view = new EditorView({
    state: EditorState.create({
      doc: 'hello',
      extensions: [
        markdownEditorExtensions(),
        livePreview,
        livePreviewConfig(true, { space: 'eng', pagePath: 'a.md', pageId: 'P1' }),
      ],
      selection: EditorSelection.single(5),
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
  localStorage.clear();
});

describe('why the hotkey is not a keymap entry', () => {
  it('is dead as a plain CodeMirror binding on a Mac — the bug, reproduced', () => {
    // Exactly what round 25 registered: `keymap.of([{ key: 'Alt-Shift-p' }])`.
    let fired = 0;
    const view = new EditorView({
      state: EditorState.create({
        doc: 'hello',
        extensions: [keymap.of([{ key: TOOLBAR_HOTKEY, run: () => (fired += 1, true) }])],
      }),
      parent: document.body,
    });
    views.push(view);

    view.contentDOM.dispatchEvent(macAltShiftP());

    // CodeMirror looks the binding up by `event.key` («∏»), and refuses its own
    // fallback to the physical key for plain Alt combinations on macOS — see
    // the `!(browser.mac && event.altKey && ...)` guard in its `runHandlers`.
    // On Windows and Linux this same press does fire, which is why the hotkey
    // looked fine everywhere except on the machine that reported it.
    expect(fired).toBe(0);
  });
});

describe('matchesToolbarHotkey', () => {
  const match = (init: KeyboardEventInit): boolean =>
    matchesToolbarHotkey(new KeyboardEvent('keydown', { altKey: true, shiftKey: true, ...init }));

  it('accepts the Mac press, whose character is not a P at all', () => {
    expect(match({ key: '∏', code: 'KeyP', keyCode: 80 })).toBe(true);
  });

  it('accepts the Windows and Linux press', () => {
    expect(match({ key: 'P', code: 'KeyP', keyCode: 80 })).toBe(true);
  });

  it('accepts a synthetic press that carries no code, by keyCode', () => {
    expect(match({ key: '∏', keyCode: 80 })).toBe(true);
  });

  it('accepts a layout where P is not the physical KeyP', () => {
    // Dvorak: the key that types «p» is where QWERTY keeps R.
    expect(match({ key: 'p', code: 'KeyR', keyCode: 82 })).toBe(true);
  });

  it('ignores another letter', () => {
    expect(match({ key: 'B', code: 'KeyB', keyCode: 66 })).toBe(false);
  });

  it('ignores the same key without both modifiers', () => {
    expect(matchesToolbarHotkey(new KeyboardEvent('keydown', { key: 'P', code: 'KeyP', altKey: true }))).toBe(false);
    expect(matchesToolbarHotkey(new KeyboardEvent('keydown', { key: 'P', code: 'KeyP', shiftKey: true }))).toBe(false);
  });

  it('leaves ⌘⌥⇧P and ⌃⌥⇧P to whoever else wants them', () => {
    expect(match({ key: 'P', code: 'KeyP', keyCode: 80, metaKey: true })).toBe(false);
    expect(match({ key: 'P', code: 'KeyP', keyCode: 80, ctrlKey: true })).toBe(false);
  });
});

describe('the hotkey in a real editor, on a Mac', () => {
  it('hides the strip and brings it back, one press each way', () => {
    const view = mount();
    expect(isToolbarPinned(view.state)).toBe(true);

    view.contentDOM.dispatchEvent(macAltShiftP());
    expect(isToolbarPinned(view.state)).toBe(false);
    expect(document.querySelector('.cm-folio-toolbar')).toBeNull();

    view.contentDOM.dispatchEvent(macAltShiftP());
    expect(isToolbarPinned(view.state)).toBe(true);
    expect(document.querySelector('.cm-folio-toolbar')).not.toBeNull();
  });

  it('toggles once per press, not twice', () => {
    // The handler sits at Prec.highest and returns true, so CodeMirror's own
    // key handling never sees the event — a second toggle from a leftover
    // keymap binding would land the strip back where it started.
    const view = mount();
    view.contentDOM.dispatchEvent(macAltShiftP());
    expect(isToolbarPinned(view.state)).toBe(false);
  });

  it('claims the press, so the browser cannot also act on it', () => {
    const view = mount();
    const event = macAltShiftP();
    view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('writes the new state through to storage', () => {
    const view = mount();
    view.contentDOM.dispatchEvent(macAltShiftP());
    expect(localStorage.getItem('folio.editor.toolbar')).toBe('off');
  });

  /**
   * Round 27 moved the visible show/hide control out of the editor and into the
   * chrome row, where it renders from this module's shared state rather than
   * from the view. The shortcut has to keep that state honest — otherwise a
   * press hides the panel and leaves the button still drawn as pressed, which
   * is a worse version of the bug this whole file exists for.
   */
  it('tells the chrome-row button what it just did', () => {
    const view = mount();
    const seen: boolean[] = [];
    const stop = subscribeToolbarPinned((pinned) => seen.push(pinned));

    view.contentDOM.dispatchEvent(macAltShiftP());
    view.contentDOM.dispatchEvent(macAltShiftP());
    stop();

    expect(seen).toEqual([false, true]);
    expect(toolbarPinnedNow()).toBe(true);
  });
});
