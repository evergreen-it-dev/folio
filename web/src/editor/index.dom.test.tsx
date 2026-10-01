// @vitest-environment jsdom
/**
 * The editor's chrome row: which mode a page opens in, in what order the
 * three buttons stand, and what else is allowed on that row (rounds 21-22, and
 * round 27's connection dot and command-panel button).
 *
 * The collab session is mocked as "not connected yet", which is enough for
 * every question here and keeps a real CodeMirror/Yjs stack out of the test:
 * reading mode renders markdown, the other two render the connecting hint, and
 * the chrome row is the same either way.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// Type-only: erased, so it does not pull the module in before i18next is ready.
import type { EditorMode } from './index';

/**
 * `vi.hoisted` because the mock factory below is hoisted above every import and
 * cannot close over an ordinary `const`. Mutable so a test can say what the
 * collab socket is doing — the connection dot has three states and they are the
 * whole point of the last describe block.
 */
const collab = vi.hoisted(() => ({ status: 'connected', peers: 0 }));

vi.mock('./collab', () => ({
  useCollabSession: () => null,
  useConnectionStatus: () => collab.status,
  useSynced: () => true,
  usePeerCount: () => collab.peers,
  useDocumentText: () => '# Page body',
}));

vi.mock('../markdown', () => ({
  Markdown: ({ markdown }: { markdown: string }) => <p className="mock-markdown">{markdown}</p>,
}));

vi.mock('../emoji', () => ({ useEmojiFavorites: () => ({ favorites: [] as string[] }) }));

// Before the editor's own i18n module, which only initialises i18next when
// nobody else has — the React binding has to be in place for useTranslation.
await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: {},
  interpolation: { escapeValue: false },
});

const { PageEditor } = await import('./index');
// The panel's own state, which the chrome button renders from and writes to.
// `toggleToolbarPinned` here stands in for what the ⌥⇧P handler does inside the
// editor — no CodeMirror view is mounted in this file, so the shortcut itself is
// exercised in pin-toolbar-hotkey.dom.test.ts, on the same channel.
const { toggleToolbarPinned, toolbarHotkeyLabel, toolbarPinnedNow } = await import('./pin-toolbar');

const MODE_KEY = 'folio.editor.mode';
const TOOLBAR_KEY = 'folio.editor.toolbar';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

/**
 * jsdom ships no `matchMedia` at all, so the editor's own guard treats every
 * test as a desktop unless a test says otherwise — which is what keeps the
 * three-button assertions below meaningful. `compactViewport()` is the phone.
 */
function stubMatchMedia(matches: boolean): void {
  const listeners = new Set<() => void>();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (media: string) => ({
      media,
      matches,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    }),
  });
}

const compactViewport = (): void => stubMatchMedia(true);

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  document.querySelectorAll('.folio-tablemenu').forEach((menu) => menu.remove());
  delete (window as { matchMedia?: unknown }).matchMedia;
  localStorage.clear();
  collab.status = 'connected';
  collab.peers = 0;
});

function mount(props: { readOnly?: boolean; chromeStart?: boolean; mode?: EditorMode } = {}): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  // PageEditor reads useQueryClient() for paste-chooser.ts's "create a child
  // page" service — no query actually runs in these chrome-row tests.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PageEditor
          pageId="PAGE1"
          space="eng"
          pagePath="a/b.md"
          collabUrl="ws://localhost/collab"
          readOnly={props.readOnly}
          defaultMode={props.mode}
          chromeStart={props.chromeStart ? <button type="button">Add a cover</button> : undefined}
        />
      </QueryClientProvider>,
    );
  });
  return container;
}

const modeButtons = (container: HTMLElement): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('.folio-editor__mode'));

const panelToggle = (container: HTMLElement): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>('.folio-editor__panel-toggle');

const statusBadge = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>('.folio-editor__status');

const activeMode = (container: HTMLElement): string | null =>
  modeButtons(container).find((button) => button.getAttribute('aria-pressed') === 'true')?.textContent ?? null;

describe('PageEditor mode', () => {
  it('opens a page in reading mode when the reader has never chosen', () => {
    const container = mount();

    expect(container.querySelector('.folio-editor')?.getAttribute('data-mode')).toBe('reading');
    expect(activeMode(container)).toBe('Reading');
    expect(container.querySelector('.mock-markdown')?.textContent).toBe('# Page body');
  });

  it('ignores a stored choice — every page opens in reading', () => {
    // 17.09: the mode is no longer carried between pages. A link sent to a
    // chat has to open in reading even for somebody who has just been editing.
    localStorage.setItem(MODE_KEY, 'source');
    const container = mount();

    expect(container.querySelector('.folio-editor')?.getAttribute('data-mode')).toBe('reading');
    expect(activeMode(container)).toBe('Reading');
    expect(container.querySelector('.mock-markdown')?.textContent).toBe('# Page body');
  });

  it('ignores a stored value that is not a mode', () => {
    localStorage.setItem(MODE_KEY, 'wysiwyg');
    expect(mount().querySelector('.folio-editor')?.getAttribute('data-mode')).toBe('reading');
  });

  it('lists the modes reading first, then live, then source', () => {
    // Round 25 renamed the middle one: "Live" said nothing about what it does.
    expect(modeButtons(mount()).map((button) => button.textContent)).toEqual([
      'Reading',
      'Live edit',
      'Source',
    ]);
  });

  it('keeps the picked mode on this page, and carries it to no other', () => {
    const container = mount();

    act(() => modeButtons(container)[1].click());

    expect(container.querySelector('.folio-editor')?.getAttribute('data-mode')).toBe('live');
    // Nothing was written: the next page opens in reading again.
    expect(localStorage.getItem(MODE_KEY)).toBeNull();
  });

  it('keeps the outer share-page scroll when the inner reader is not the real scroller', () => {
    const container = mount();
    const reading = container.querySelector<HTMLElement>('.folio-editor__reading')!;

    container.style.overflowY = 'auto';
    reading.style.overflowY = 'auto';
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 10_000 },
    });
    Object.defineProperties(reading, {
      clientHeight: { configurable: true, value: 2_000 },
      scrollHeight: { configurable: true, value: 2_000 },
    });
    container.scrollTop = 4_321;

    act(() => modeButtons(container)[1].click());

    expect(container.scrollTop).toBe(4_321);
  });

  it('shows no toggle at all to a reader who cannot edit', () => {
    const container = mount({ readOnly: true });

    expect(modeButtons(container)).toHaveLength(0);
    expect(container.querySelector('.folio-editor__readonly')).not.toBeNull();
  });
});

/**
 * Round 26. On the owner's phone the three-way switch took the whole chrome
 * row, pushing "Add a cover" and the connection badge off it. Below the
 * 768px breakpoint it collapses to one button that opens the same three modes
 * as a menu — the editor's existing popup-menu, not a new kind of dropdown.
 */
describe('PageEditor mode switch on a phone', () => {
  const menuButton = (container: HTMLElement): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>('.folio-editor__mode-menu');
  const menuItems = (): HTMLButtonElement[] =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('.folio-tablemenu__item'));

  const openMenuFrom = (container: HTMLElement): void => {
    act(() => menuButton(container)!.click());
  };

  /** A real pointer tap. jsdom's `.click()` sends no mousedown; a browser does,
      and the menu's outside-press dismissal runs off that one. */
  const tap = (node: HTMLElement): void => {
    act(() => {
      node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  };

  it('collapses the three buttons into one naming the current mode', () => {
    compactViewport();
    const container = mount();

    expect(modeButtons(container)).toHaveLength(0);
    expect(menuButton(container)?.textContent).toBe('Reading');
  });

  it('keeps the segmented control on a desktop', () => {
    stubMatchMedia(false);
    const container = mount();

    expect(menuButton(container)).toBeNull();
    expect(modeButtons(container)).toHaveLength(3);
  });

  it('offers all three modes in the menu, with the current one marked', () => {
    compactViewport();
    const container = mount();

    openMenuFrom(container);

    expect(menuItems().map((item) => item.textContent)).toEqual([
      'Reading',
      'Live edit',
      'Source',
    ]);
    expect(menuItems()[0].dataset.selected).toBe('true');
    expect(menuItems()[1].dataset.selected).toBeUndefined();
  });

  it('switches and remembers the mode picked from the menu', () => {
    compactViewport();
    const container = mount();

    openMenuFrom(container);
    act(() => menuItems()[2].click());

    expect(container.querySelector('.folio-editor')?.getAttribute('data-mode')).toBe('source');
    expect(localStorage.getItem(MODE_KEY)).toBeNull(); // the choice lives on this page only
    expect(menuButton(container)?.textContent).toBe('Source');
    // The menu closes on its way out; nothing is left hanging over the page.
    expect(menuItems()).toHaveLength(0);
  });

  it('reports its own open state to assistive tech', () => {
    compactViewport();
    const container = mount();

    expect(menuButton(container)!.getAttribute('aria-haspopup')).toBe('menu');
    expect(menuButton(container)!.getAttribute('aria-expanded')).toBe('false');

    openMenuFrom(container);
    expect(menuButton(container)!.getAttribute('aria-expanded')).toBe('true');
  });

  it('names the current mode for a screen reader, not just in the visible label', () => {
    compactViewport();
    const container = mount();

    expect(menuButton(container)!.getAttribute('aria-label')).toContain('Reading');
  });

  it('closes the menu on a second activation instead of stacking another', () => {
    // `.click()` alone is the keyboard path: Enter and Space send no mousedown.
    compactViewport();
    const container = mount();

    openMenuFrom(container);
    expect(menuItems()).toHaveLength(3);

    openMenuFrom(container);
    expect(menuItems()).toHaveLength(0);
  });

  it('closes on a real second tap, which dismisses the menu before the click', () => {
    // The browser gesture jsdom's `.click()` skips: mousedown reaches
    // popup-menu's outside-click dismissal first, so by the time the click
    // arrives the menu is already gone. Without the guard for that, the button
    // would reopen it on every tap and never dismiss it.
    compactViewport();
    const container = mount();
    const button = menuButton(container)!;

    tap(button);
    expect(menuItems()).toHaveLength(3);

    tap(button);
    expect(menuItems()).toHaveLength(0);
    expect(button.getAttribute('aria-expanded')).toBe('false');

    // And a third tap opens it again rather than staying stuck shut.
    tap(button);
    expect(menuItems()).toHaveLength(3);
  });

  it('does not swallow a tap after a press that never became a click', () => {
    // Finger down on the button, dragged off, released elsewhere: the menu is
    // dismissed but no click follows, so the "this press already closed it"
    // flag is left standing. The next real tap must still open the menu.
    compactViewport();
    const container = mount();
    const button = menuButton(container)!;

    tap(button);
    expect(menuItems()).toHaveLength(3);

    act(() => {
      button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    expect(menuItems()).toHaveLength(0);

    tap(button);
    expect(menuItems()).toHaveLength(3);
  });

  it('leaves nothing behind in the body when the editor unmounts', () => {
    compactViewport();
    const container = mount();
    openMenuFrom(container);
    expect(menuItems()).toHaveLength(3);

    const entry = mounted.pop()!;
    act(() => entry.root.unmount());
    entry.container.remove();

    expect(document.querySelector('.folio-tablemenu')).toBeNull();
  });

  it('still leaves room for the chrome-start slot beside it', () => {
    compactViewport();
    const container = mount({ chromeStart: true, mode: 'live' });

    // The whole point of the collapse: the badge and "Add a cover" keep
    // their place on the row instead of being pushed off by the switch. Round 27
    // took the badge's words away, so what is checked is its accessible name —
    // the dot is still there and still says which state it is in.
    expect(container.querySelector('.folio-editor__chrome-start')).not.toBeNull();
    expect(statusBadge(container)?.getAttribute('aria-label')).toContain('connected');
    expect(menuButton(container)).not.toBeNull();
    // And the round-27 button fits beside it rather than pushing anything off.
    expect(panelToggle(container)).not.toBeNull();
  });

  it('shows no switch at all to a reader who cannot edit', () => {
    compactViewport();
    const container = mount({ readOnly: true });

    expect(menuButton(container)).toBeNull();
    expect(container.querySelector('.folio-editor__readonly')).not.toBeNull();
  });
});

describe('PageEditor chrome-start slot', () => {
  it('is left out entirely in reading mode', () => {
    const container = mount({ chromeStart: true });

    expect(container.querySelector('.folio-editor__chrome-start')).toBeNull();
    expect(container.textContent).not.toContain('Add a cover');
  });

  it('comes back as soon as the page is being edited', () => {
    const container = mount({ chromeStart: true });

    act(() => modeButtons(container)[1].click());

    expect(container.querySelector('.folio-editor__chrome-start')).not.toBeNull();
    expect(container.textContent).toContain('Add a cover');
  });

  it('stays hidden for a read-only page, which is always reading', () => {
    const container = mount({ chromeStart: true, readOnly: true });

    expect(container.querySelector('.folio-editor__chrome-start')).toBeNull();
  });
});

/**
 * Round 27. The command panel's show/hide control used to be a full-width
 * chevron strip inside the editor; the owner asked for a button beside the mode
 * switch instead. The toggle and the ⌥⇧P shortcut behind it did not change —
 * pin-toolbar.ts still owns both, and this is the button's half of it.
 */
describe('PageEditor command-panel button', () => {
  it('stands beside the mode switch, not inside the editor', () => {
    const container = mount({ mode: 'live' });

    const row = container.querySelector('.folio-editor__chrome')!;
    expect(panelToggle(container)).not.toBeNull();
    expect(row.contains(panelToggle(container))).toBe(true);
    // Adjacent to the switch, which is what "a button next to the mode" asked for.
    expect(panelToggle(container)!.nextElementSibling).toBe(row.querySelector('.folio-editor__modes'));
  });

  it('says what it does and names the shortcut, for a pointer and a screen reader', () => {
    const button = panelToggle(mount({ mode: 'live' }))!;

    expect(button.getAttribute('aria-label')).toBe(`Show the command toolbar (${toolbarHotkeyLabel()})`);
    expect(button.title).toBe(button.getAttribute('aria-label'));
  });

  it('shows the panel state, and toggles it on a click', () => {
    const container = mount({ mode: 'live' });
    const button = panelToggle(container)!;

    // Pinned is the default, so the button starts pressed.
    expect(button.getAttribute('aria-pressed')).toBe('true');

    act(() => button.click());

    expect(toolbarPinnedNow()).toBe(false);
    expect(localStorage.getItem(TOOLBAR_KEY)).toBe('off');
    expect(button.getAttribute('aria-pressed')).toBe('false');

    act(() => button.click());

    expect(toolbarPinnedNow()).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('opens already unpressed on a page left with the panel hidden', () => {
    localStorage.setItem(TOOLBAR_KEY, 'off');

    expect(panelToggle(mount({ mode: 'live' }))!.getAttribute('aria-pressed')).toBe('false');
  });

  it('follows a toggle it did not make — the ⌥⇧P press inside the editor', () => {
    // The shortcut runs against the CodeMirror view, which this file does not
    // mount; `toggleToolbarPinned` is the same write on the same channel. What
    // matters here is that the button re-renders instead of sitting stale.
    const button = panelToggle(mount({ mode: 'live' }))!;
    expect(button.getAttribute('aria-pressed')).toBe('true');

    act(() => toggleToolbarPinned());

    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps working after a remount, so the subscription is not left dangling', () => {
    const first = mount({ mode: 'live' });
    act(() => panelToggle(first)!.click());

    const entry = mounted.pop()!;
    act(() => entry.root.unmount());
    entry.container.remove();

    const second = mount({ mode: 'live' });
    expect(panelToggle(second)!.getAttribute('aria-pressed')).toBe('false');
    act(() => panelToggle(second)!.click());
    expect(toolbarPinnedNow()).toBe(true);
  });

  it('is left out of reading mode, where there is no panel to show', () => {
    // Reading mode mounts no editor at all: a toggle there would point at
    // nothing, and the row is tight enough on a phone without it.
    expect(panelToggle(mount())).toBeNull();
  });

  it('is left out for a reader who cannot edit', () => {
    expect(panelToggle(mount({ readOnly: true, mode: 'live' }))).toBeNull();
  });
});

/**
 * Round 27. The badge used to read "connected" beside a coloured dot; the
 * owner asked for the dot alone with the wording on hover. Two things had to
 * survive that: a screen reader still has to hear the state, and a reader who
 * cannot tell green from red still has to see it.
 */
describe('PageEditor connection dot', () => {
  const dot = (container: HTMLElement): SVGSVGElement | null =>
    container.querySelector<SVGSVGElement>('.folio-editor__dot');

  it('shows the dot and no wording on the row', () => {
    const container = mount();

    expect(dot(container)).not.toBeNull();
    expect(container.querySelector('.folio-editor__chrome')!.textContent).not.toContain('connected');
  });

  it('still announces itself as connected', () => {
    const badge = statusBadge(mount())!;

    expect(badge.getAttribute('role')).toBe('img');
    expect(badge.getAttribute('aria-label')).toBe('Collaboration: connected');
    // Same sentence as the hover tooltip: one wording, two ways to reach it.
    expect(badge.getAttribute('title')).toBe(badge.getAttribute('aria-label'));
  });

  it('still announces itself as offline', () => {
    collab.status = 'offline';
    const badge = statusBadge(mount())!;

    expect(badge.getAttribute('aria-label')).toBe('Collaboration: offline');
    expect(badge.getAttribute('title')).toBe(badge.getAttribute('aria-label'));
  });

  it('announces the third state too, rather than falling back to a bare key', () => {
    collab.status = 'connecting';
    expect(statusBadge(mount())!.getAttribute('aria-label')).toBe('Collaboration: connecting');
  });

  it('tells the states apart by shape, not only by colour', () => {
    // The point: green-vs-red is the pair a red-green colour-blind reader
    // cannot separate, so the glyph itself has to differ. Connected is a filled
    // disc; the others are open rings, and offline is struck through.
    const connected = dot(mount())!;
    expect(connected.querySelector('circle')!.getAttribute('fill')).toBe('currentColor');
    expect(connected.querySelector('path')).toBeNull();

    collab.status = 'offline';
    const offline = dot(mount())!;
    expect(offline.querySelector('circle')!.getAttribute('fill')).toBe('none');
    expect(offline.querySelector('path')).not.toBeNull();

    collab.status = 'connecting';
    const connecting = dot(mount())!;
    expect(connecting.querySelector('circle')!.getAttribute('fill')).toBe('none');
    // Only offline carries the strike; connecting is a plain ring.
    expect(connecting.querySelector('path')).toBeNull();
  });

  it('keeps the state on the wrapper, which is what colours the glyph', () => {
    collab.status = 'offline';
    expect(statusBadge(mount())!.dataset.status).toBe('offline');
  });

  it('folds the peer count into the tooltip instead of dropping it', () => {
    collab.peers = 2;
    const badge = statusBadge(mount())!;

    expect(badge.getAttribute('aria-label')).toContain('connected');
    expect(badge.getAttribute('aria-label')).toContain('2');
    expect(badge.querySelector('.folio-editor__peers')).toBeNull();
  });

  it('leaves the peer count out when there is nobody else on the page', () => {
    expect(statusBadge(mount())!.getAttribute('aria-label')).toBe('Collaboration: connected');
  });
});
