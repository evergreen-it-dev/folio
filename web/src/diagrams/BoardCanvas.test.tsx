// @vitest-environment jsdom
/**
 * DEV-PLAN Round 21 (DIAGRAMS) — the board's "View | Edit" toggle.
 * Exercises the real BoardCanvas against a mocked @excalidraw/excalidraw (the
 * real package pulls in canvas rendering that jsdom can't do, and has never
 * been under component test in this zone) so the actual prop threading —
 * not just the pure resolveViewModeEnabled() logic already covered by
 * boardMode.test.ts — is verified: localStorage default/selection really
 * reaches the `viewModeEnabled` prop Excalidraw is mounted with.
 *
 * Also covers the Round 21 share-interference finding: useHandleLibrary's
 * own mount effect calls the library-persistence adapter synchronously
 * (confirmed by reading the installed package's dist source), so it's now
 * gated to edit mode only (see BoardCanvas.tsx's `isEditingNow`) — a board
 * opened in view mode (the new default) must never engage it at all.
 *
 * And the owner-reported export bug: Excalidraw's built-in "Export image"
 * dialog saves through the File System Access API, which the owner
 * reproduced failing silently. BoardExportMenu/BoardCanvas's own
 * exportBoardPng/exportBoardSvg/copyBoardToClipboard replace it with
 * exportToBlob/exportToSvg/exportToClipboard + our own downloadBlob
 * (Blob + <a download>, see download.ts, mocked here — its own DOM mechanics
 * are covered directly by download.test.ts) — this file verifies BoardCanvas
 * actually wires the button to those calls, with the right options and a
 * filename derived from the loaded page's title/path, and that the built-in
 * dialog is disabled via UIOptions.
 *
 * Round 29 (LIVE COLLABORATION): mounting `<BoardCanvas pageId=... />` with
 * no shareToken is now the COLLAB path (see BoardCanvas.tsx's module
 * docblock) — the scene comes from a Y.Doc, not from GET/PUT. `./boardCollab`
 * is mocked wholesale here: `useBoardCollabSession` hands back a session
 * backed by a REAL `Y.Doc` (so the real, unmocked ./boardYdoc read/write
 * logic this file doesn't otherwise touch is still exercised end to end),
 * and `useBoardSynced` reports synced immediately — this file's own tests
 * are about mode/export/chrome wiring, not about collab sync timing (that is
 * BoardCanvas.viewport.test.tsx's and boardYdoc.test.ts's job). `fetch` is
 * still stubbed: the collab path keeps a lightweight GET purely for
 * path/title (export filenames) and 401 detection — see BoardCanvas.tsx's
 * metadata effect.
 */
import { useEffect } from 'react';
import { act } from '@testing-library/react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import * as Y from 'yjs';
import BoardCanvas, { CHROME_MEASURE_FALLBACK_MS } from './BoardCanvas';
import { emitLocalPageSynced } from '../app/offline/events';
import { createLocalPage, localPageMeta, removeLocalPage, resetLocalPagesForTests } from '../app/offline/localPages';
import { boardRoots } from './boardYdoc';
import { BOARD_MODE_KEY } from './boardMode';
import { STICKY_NOTE_COLORS, STICKY_NOTE_SIZE } from './boardStickyNotes';
import './i18n/register';

const state = vi.hoisted(() => ({
  lastExcalidrawProps: {} as { viewModeEnabled?: boolean; UIOptions?: unknown },
  schedulerFlush: vi.fn(),
  fakeApi: {
    id: 'fake-excalidraw-api',
    getSceneElements: vi.fn(() => []),
    getSceneElementsIncludingDeleted: vi.fn(() => []),
    // Viewport fields (offsetLeft/offsetTop/width/height/scrollX/scrollY/zoom)
    // are here for the sticky-note palette's own coordinate math (see
    // boardStickyNotes.ts's screenToSceneCoords/sceneToScreenCoords) — a
    // plain 800x600 canvas at 100% zoom, un-scrolled, flush with the
    // viewport's own top-left corner. `someExistingKey` stays alongside them:
    // the export tests below assert it survives an appState spread via
    // toMatchObject (a PARTIAL match), so adding fields here doesn't disturb them.
    getAppState: vi.fn(() => ({
      someExistingKey: 'kept-as-is',
      offsetLeft: 0,
      offsetTop: 0,
      width: 800,
      height: 600,
      scrollX: 0,
      scrollY: 0,
      zoom: { value: 1 },
    })),
    getFiles: vi.fn(() => ({})),
    updateScene: vi.fn(),
    addFiles: vi.fn(),
    setActiveTool: vi.fn(),
  },
  lastUseHandleLibraryArgs: undefined as { excalidrawAPI: unknown } | undefined,
  // Each takes an explicit (unused) `_opts` param so vi.fn() infers a
  // one-argument call signature — without it, TS infers `[]` from the
  // implementation's own arity and `.mock.calls[0][0]` stops type-checking
  // below, even though the real functions are always called with one options
  // object (that's the whole point of asserting on it).
  exportToSvg: vi.fn(async (_opts: unknown) => ({ outerHTML: '<svg data-fake-export="1"></svg>' })),
  exportToBlob: vi.fn(async (_opts: unknown) => new Blob(['fake-png-bytes'], { type: 'image/png' })),
  exportToClipboard: vi.fn(async (_opts: unknown) => {}),
  downloadBlob: vi.fn(),
  /** Fresh per mountReady() call — see the ./boardCollab mock below. */
  collabSession: null as ReturnType<typeof buildFakeSession> | null,
  /** The `space` BoardCanvas last passed to useBoardCollabSession (offline mode: what a board's unsynced edits are filed under). */
  lastSessionSpace: undefined as string | undefined,
}));

function buildFakeSession(pageId: string) {
  const doc = new Y.Doc();
  return {
    pageId,
    doc,
    provider: { destroy: vi.fn() } as never,
    awareness: { setLocalStateField: vi.fn(), getStates: () => new Map(), clientID: 0, on: vi.fn(), off: vi.fn() } as never,
    user: { name: 'Test User', color: '#1971c2', colorLight: '#1971c233' },
    ...boardRoots(doc),
  };
}

vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: (props: { viewModeEnabled?: boolean; excalidrawAPI?: (api: unknown) => void }) => {
    state.lastExcalidrawProps = props;
    // Mimics the real package handing back its imperative API from an
    // effect (not synchronously during render) — calling a parent-owned
    // setState-driving callback belongs in an effect, not a child's render
    // body. Runs on every commit; BoardCanvas's own setExcalidrawApi bails
    // out on the repeat calls since `state.fakeApi` is a stable reference.
    useEffect(() => {
      props.excalidrawAPI?.(state.fakeApi);
    });
    return null;
  },
  exportToSvg: state.exportToSvg,
  exportToBlob: state.exportToBlob,
  exportToClipboard: state.exportToClipboard,
  loadFromBlob: vi.fn(async () => ({ elements: [], appState: {}, files: {} })),
  getSceneVersion: vi.fn(() => 0),
  reconcileElements: vi.fn((_local: unknown, remote: unknown) => remote),
  restoreElements: vi.fn((elements: unknown) => elements),
  CaptureUpdateAction: { IMMEDIATELY: 'IMMEDIATELY', NEVER: 'NEVER', EVENTUALLY: 'EVENTUALLY' },
  THEME: { LIGHT: 'light', DARK: 'dark' },
  MIME_TYPES: { excalidraw: 'application/vnd.excalidraw+json', png: 'image/png' },
  useHandleLibrary: vi.fn((args: { excalidrawAPI: unknown }) => {
    state.lastUseHandleLibraryArgs = args;
  }),
  // Sticky notes (board plugin): a simple passthrough is enough to keep
  // BoardCanvas's module-level import from resolving to `undefined` — see
  // boardStickyNotes.test.ts for real coverage of what these two produce,
  // and the sticky-palette-visibility test below for the one thing about the
  // feature this file itself asserts on.
  convertToExcalidrawElements: vi.fn((skeletons: unknown[]) => skeletons),
  ROUNDNESS: { LEGACY: 1, PROPORTIONAL_RADIUS: 2, ADAPTIVE_RADIUS: 3 },
}));

// Round 29: the collab session/hooks are mocked, not the Y.Doc plumbing
// underneath them — ./boardYdoc (write/read) runs for real against
// state.collabSession's own Y.Doc, so this file also exercises that it's
// wired up correctly, just not the WebsocketProvider/network part of it.
vi.mock('./boardCollab', () => ({
  useBoardCollabSession: (pageId: string, _url?: string, _params?: unknown, space?: string) => {
    state.lastSessionSpace = space;
    return pageId ? state.collabSession : null;
  },
  useBoardSynced: (session: unknown) => session !== null,
  useBoardConnectionStatus: () => 'connected' as const,
  useBoardPeers: () => [],
  publishBoardPointer: vi.fn(),
  throttledPointerPublisher: vi.fn(() => ({ publish: vi.fn(), cancel: vi.fn() })),
}));

// Isolates this file's assertions to "did BoardCanvas ask the existing
// save-cycle to flush", not "does flush() itself work" — the latter is
// already covered end to end by autosaveScheduler.test.ts. Round 29: the
// collab (non-share) path never builds this scheduler at all any more (see
// BoardCanvas.tsx) — kept mocked mainly so the share-path code path (not
// exercised by THIS file, see BoardCanvas.share.test.tsx-shaped coverage
// living directly in the component's own docblock/contract instead) still
// resolves cleanly, and so a regression that started building it again on
// the collab path would be visible via schedulerFlush unexpectedly firing.
vi.mock('./autosaveScheduler', () => ({
  createAutosaveScheduler: vi.fn(() => ({
    flush: state.schedulerFlush,
    notifyChange: vi.fn(),
    cancel: vi.fn(),
  })),
}));

// Isolates this file's assertions to "did BoardCanvas ask for the right
// blob/filename", not "does the anchor-click download mechanism itself
// work" — the latter is already covered end to end by download.test.ts.
vi.mock('./download', () => ({
  downloadBlob: state.downloadBlob,
}));

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await i18next.changeLanguage('en');
});

const activeRoots: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  state.schedulerFlush.mockClear();
  state.exportToSvg.mockClear();
  state.exportToBlob.mockClear();
  state.exportToClipboard.mockClear();
  state.downloadBlob.mockClear();
  state.fakeApi.updateScene.mockClear();
  state.fakeApi.addFiles.mockClear();
  state.fakeApi.setActiveTool.mockClear();
  state.lastExcalidrawProps = {};
  state.lastUseHandleLibraryArgs = undefined;
  state.collabSession = null;
  state.lastSessionSpace = undefined;
  resetLocalPagesForTests();
  for (const { root, container } of activeRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

interface FetchOverrides {
  title?: string;
  path?: string;
  space?: string;
}

/** Stubs the GET BoardCanvas's collab path uses purely for path/title metadata — see BoardCanvas.tsx's metadata effect. The board's SCENE comes from the (mocked) Y.Doc session, not from this response. */
function stubFetch({ title = 'My Board', path = 'diagrams/my-board.excalidraw.svg', space }: FetchOverrides = {}) {
  const fetchMock = vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ title, path, ...(space ? { space } : {}) }) }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Generous microtask+macrotask flush, matching the pattern already used in web/src/app/share/ShareButton.boardRepro.test.tsx for a fetch-driven load effect. */
async function flushAll() {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

/**
 * Production wraps the whole router (including `/share/:token`) in a single
 * `QueryClientProvider` (see App.tsx) — `useOptionalSessionUser()` (collabIdentity.ts),
 * now called from BoardCanvas as part of today's share-identity fix, relies on that
 * ambient client via react-query's `useQuery`. These tests mount BoardCanvas directly,
 * bypassing App.tsx entirely, so each mountReady() call supplies its own throwaway
 * client — fresh per mount so no query state leaks between tests.
 */
function renderBoard(pageId: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <BoardCanvas pageId={pageId} />
    </QueryClientProvider>
  );
}

async function mountReady(pageId = 'board-1', fetchOverrides?: FetchOverrides): Promise<HTMLElement> {
  stubFetch(fetchOverrides);
  state.collabSession = buildFakeSession(pageId);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  activeRoots.push({ root, container });
  await act(async () => {
    root.render(renderBoard(pageId));
    await flushAll();
  });
  return container;
}

function modeButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('[role="group"] button'));
}

function exportTrigger(container: HTMLElement): HTMLButtonElement {
  return container.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement;
}

function exportMenuItem(container: HTMLElement, label: string): HTMLButtonElement {
  const items = Array.from(container.querySelectorAll('[role="menuitem"]')) as HTMLButtonElement[];
  const found = items.find((el) => el.textContent?.includes(label));
  if (!found) throw new Error(`export menu item "${label}" not found`);
  return found;
}

describe('BoardCanvas board mode toggle (DEV-PLAN Round 21)', () => {
  it('defaults to "View" — Excalidraw mounts with viewModeEnabled=true and nothing is written to storage yet', async () => {
    expect(localStorage.getItem(BOARD_MODE_KEY)).toBeNull();
    const container = await mountReady();

    expect(state.lastExcalidrawProps.viewModeEnabled).toBe(true);
    const buttons = modeButtons(container);
    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    expect(localStorage.getItem(BOARD_MODE_KEY)).toBeNull();
  });

  it('respects a stored "edit" choice on open — Excalidraw mounts already editable, no click needed', async () => {
    localStorage.setItem(BOARD_MODE_KEY, 'edit');
    const container = await mountReady();

    expect(state.lastExcalidrawProps.viewModeEnabled).toBe(false);
    const buttons = modeButtons(container);
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
  });

  it('clicking "Edit" threads viewModeEnabled=false through to Excalidraw and persists the choice', async () => {
    const container = await mountReady();
    const [, editButton] = modeButtons(container);

    await act(async () => {
      editButton.click();
    });

    expect(state.lastExcalidrawProps.viewModeEnabled).toBe(false);
    expect(localStorage.getItem(BOARD_MODE_KEY)).toBe('edit');
  });

  it('switching back to "View" never calls the (share-only) autosave scheduler\'s flush — the collab path has nothing debounced to flush, every edit already landed in the Y.Doc', async () => {
    localStorage.setItem(BOARD_MODE_KEY, 'edit');
    const container = await mountReady();
    expect(state.schedulerFlush).not.toHaveBeenCalled();

    const [viewButton] = modeButtons(container);
    await act(async () => {
      viewButton.click();
    });

    expect(state.schedulerFlush).not.toHaveBeenCalled();
    expect(state.lastExcalidrawProps.viewModeEnabled).toBe(true);
    expect(localStorage.getItem(BOARD_MODE_KEY)).toBe('view');
  });

  it('switching TO "Edit" does not touch the flush path either', async () => {
    const container = await mountReady(); // starts in view (default)
    const [, editButton] = modeButtons(container);

    await act(async () => {
      editButton.click();
    });

    expect(state.schedulerFlush).not.toHaveBeenCalled();
  });
});

describe('BoardCanvas share-interference fix: useHandleLibrary gated to edit mode', () => {
  it('passes excalidrawAPI: null to useHandleLibrary while the default "View" mode is active — the hydration never runs for a plain viewer', async () => {
    await mountReady();
    expect(state.lastUseHandleLibraryArgs?.excalidrawAPI).toBeNull();
  });

  it('passes the real excalidrawAPI to useHandleLibrary once switched to "Edit"', async () => {
    const container = await mountReady();
    const [, editButton] = modeButtons(container);

    await act(async () => {
      editButton.click();
    });

    expect(state.lastUseHandleLibraryArgs?.excalidrawAPI).toBe(state.fakeApi);
  });

  it('a board opened directly into "Edit" (stored choice) gets the real excalidrawAPI without needing a click', async () => {
    localStorage.setItem(BOARD_MODE_KEY, 'edit');
    await mountReady();
    expect(state.lastUseHandleLibraryArgs?.excalidrawAPI).toBe(state.fakeApi);
  });

  it('switching back to "View" degates useHandleLibrary again (excalidrawAPI back to null)', async () => {
    localStorage.setItem(BOARD_MODE_KEY, 'edit');
    const container = await mountReady();
    expect(state.lastUseHandleLibraryArgs?.excalidrawAPI).toBe(state.fakeApi);

    const [viewButton] = modeButtons(container);
    await act(async () => {
      viewButton.click();
    });

    expect(state.lastUseHandleLibraryArgs?.excalidrawAPI).toBeNull();
  });
});

describe('BoardCanvas export menu (owner-reported export bug)', () => {
  it('passes UIOptions.canvasActions.saveAsImage: false to Excalidraw, hiding the broken built-in export dialog', async () => {
    await mountReady();
    expect(state.lastExcalidrawProps.UIOptions).toEqual({ canvasActions: { saveAsImage: false } });
  });

  it('renders the export menu regardless of view/edit mode (exporting is read-only)', async () => {
    const container = await mountReady(); // default view mode
    expect(exportTrigger(container)).not.toBeNull();
  });

  it('clicking PNG calls exportToBlob with a forced white/light background at 2x scale, and downloads it under a name derived from the page path', async () => {
    const container = await mountReady('board-1', {
      title: 'My Board',
      path: 'diagrams/my-board.excalidraw.svg',
    });

    act(() => exportTrigger(container).click());
    await act(async () => {
      exportMenuItem(container, 'PNG').click();
      await flushAll();
    });

    expect(state.exportToBlob).toHaveBeenCalledTimes(1);
    const opts = state.exportToBlob.mock.calls[0][0] as {
      mimeType?: string;
      appState?: Record<string, unknown>;
    };
    expect(opts.mimeType).toBe('image/png');
    expect(opts.appState).toMatchObject({
      exportBackground: true,
      viewBackgroundColor: '#ffffff',
      exportWithDarkMode: false,
      exportScale: 2,
      // The live appState is spread first, so an unrelated existing key
      // survives the override — this isn't a hardcoded new appState object.
      someExistingKey: 'kept-as-is',
    });

    expect(state.downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = state.downloadBlob.mock.calls[0] as [Blob, string];
    expect(blob).toBeInstanceOf(Blob);
    expect(filename).toBe('my-board.png');
  });

  it('clicking SVG calls exportToSvg with an embedded scene and a forced white/light background, and downloads it under a name derived from the page path', async () => {
    const container = await mountReady('board-1', {
      title: 'My Board',
      path: 'diagrams/my-board.excalidraw.svg',
    });

    act(() => exportTrigger(container).click());
    await act(async () => {
      exportMenuItem(container, 'SVG').click();
      await flushAll();
    });

    expect(state.exportToSvg).toHaveBeenCalledTimes(1);
    const opts = state.exportToSvg.mock.calls[0][0] as { appState?: Record<string, unknown> };
    expect(opts.appState).toMatchObject({
      exportBackground: true,
      viewBackgroundColor: '#ffffff',
      exportWithDarkMode: false,
      exportEmbedScene: true,
    });

    expect(state.downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = state.downloadBlob.mock.calls[0] as [Blob, string];
    expect(blob.type).toBe('image/svg+xml');
    expect(filename).toBe('my-board.svg');
  });

  it('falls back to a sanitized title, then the generic name, when the page has no usable path', async () => {
    const container = await mountReady('board-1', { title: 'Sales Q1', path: '' });

    act(() => exportTrigger(container).click());
    await act(async () => {
      exportMenuItem(container, 'PNG').click();
      await flushAll();
    });

    const [, filename] = state.downloadBlob.mock.calls[0] as [Blob, string];
    expect(filename).toBe('Sales Q1.png');
  });

  it('clicking "copy to clipboard" calls exportToClipboard with type: png and never touches downloadBlob', async () => {
    const container = await mountReady();

    act(() => exportTrigger(container).click());
    await act(async () => {
      exportMenuItem(container, 'Copy to clipboard').click();
      await flushAll();
    });

    expect(state.exportToClipboard).toHaveBeenCalledTimes(1);
    const opts = state.exportToClipboard.mock.calls[0][0] as { type?: string };
    expect(opts.type).toBe('png');
    expect(state.downloadBlob).not.toHaveBeenCalled();
  });
});

/**
 * QA-3 finding №1 + Round 25b-1 §§1,3 — where our own chrome is allowed to
 * sit. jsdom has no layout, so the *measured values* can only be verified in
 * a real browser (they are, by .qa/qa3-bdfix-8-verify.mjs's hit-test at 375,
 * 1280, 1366, 1440, 1512, 1600 and 1920). What IS pinned here is the
 * mechanism: the offsets are inline, computed values rather than the CSS
 * breakpoint that produced the bug, and the compact row really is one
 * button.
 */
describe('BoardCanvas chrome placement', () => {
  /** Our own top-right row — identified by the fit-to-screen button it always contains on desktop. */
  function chromeRow(container: HTMLElement): HTMLElement {
    const fit = container.querySelector('button[aria-label="Fit to screen"]');
    const row = (fit ?? container.querySelector('button[aria-haspopup="menu"]'))?.closest('div.absolute');
    if (!(row instanceof HTMLElement)) throw new Error('chrome row not found');
    return row;
  }

  it('positions the row with a measured inline offset on BOTH axes, NOT a top-3/max-md:top-16 breakpoint or a right-3 class', async () => {
    const container = await mountReady();
    const row = chromeRow(container);

    expect(row.style.top).not.toBe('');
    // QA-3 finding №3: the row can now have to dodge a tall right-edge strip
    // sideways, so `right` is measured too — a `right-3` class would fight
    // that inline value the moment it has to move.
    expect(row.style.right).not.toBe('');
    // The exact rule QA-3 №1 was caused by must not come back: it could not
    // know where Excalidraw's centred tool island or its corner-anchored
    // library trigger actually are.
    expect(row.className).not.toContain('max-md:top-16');
    expect(row.className.split(/\s+/)).not.toContain('top-3');
    expect(row.className.split(/\s+/)).not.toContain('right-3');
  });

  it('positions the save chip with a measured inline offset, not the old hard-coded bottom-14 — Round 29: the chip now shows the collab connection state ("Live") rather than a REST save cycle', async () => {
    const container = await mountReady();

    const chip = Array.from(container.querySelectorAll('div.absolute')).find((el) =>
      /\bLive\b/.test(el.textContent ?? ''),
    ) as HTMLElement | undefined;
    if (!chip) throw new Error('save-state chip not rendered');
    expect(chip.style.bottom).not.toBe('');
    // Round 25b-1 §3: 3.5rem was tuned for Excalidraw's desktop help island
    // and sat 6px inside its full-width mobile one.
    expect(chip.className).not.toContain('bottom-14');
  });

  it('keeps the full desktop row (fit button + export menu + mode toggle) when matchMedia says desktop', async () => {
    const container = await mountReady();
    expect(container.querySelector('button[aria-label="Fit to screen"]')).not.toBeNull();
    expect(exportTrigger(container).textContent).toContain('Export');
    expect(modeButtons(container)).toHaveLength(2);
  });

  it('collapses the whole row into one icon-only menu below md (Round 25b-1 §1)', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    const container = await mountReady();
    const row = chromeRow(container);

    // exactly one control in the row, carrying no text at all
    expect(row.querySelectorAll('button')).toHaveLength(1);
    expect(row.textContent).toBe('');
    expect(exportTrigger(container).getAttribute('aria-label')).toBe('Board menu');
    // ...and the desktop-only pieces are gone from the row
    expect(container.querySelector('button[aria-label="Fit to screen"]')).toBeNull();
    expect(modeButtons(container)).toHaveLength(0);

    // everything still reachable, one tap deeper
    act(() => exportTrigger(container).click());
    expect(exportMenuItem(container, 'Fit to screen')).not.toBeNull();
    expect(exportMenuItem(container, 'PNG')).not.toBeNull();
    expect(Array.from(container.querySelectorAll('[role="menuitemradio"]')).map((el) => el.textContent)).toEqual([
      'View',
      'Edit',
    ]);
  });

  it('below md, a stored desktop "edit" choice does not open the board in edit mode (Round 25b-1 §2)', async () => {
    localStorage.setItem(BOARD_MODE_KEY, 'edit');
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );

    await mountReady();

    expect(state.lastExcalidrawProps.viewModeEnabled).toBe(true);
    // the desktop preference itself is left alone
    expect(localStorage.getItem(BOARD_MODE_KEY)).toBe('edit');
  });
});

/**
 * QA-3 finding №3, second half — the owner could not confirm the
 * MutationObserver/rAF timing fix live: their dev-tool tab reported
 * `document.visibilityState === 'hidden'`, and a queued requestAnimationFrame
 * callback simply never runs in a hidden tab (confirmed separately: no
 * callback within 1.5s). A real browser can't settle whether the recompute
 * actually reacts to a late-arriving obstacle, so this reproduces it
 * DETERMINISTICALLY instead: jsdom's real MutationObserver/requestAnimationFrame
 * are replaced with fully manual stand-ins (captured, never auto-invoked), so
 * every step below is driven by an explicit call or a fake-timer advance —
 * nothing here depends on real elapsed time or a real animation frame ever
 * actually occurring.
 *
 * jsdom never lays anything out, so every rect below is supplied by stubbing
 * `getBoundingClientRect` on Element.prototype itself, dispatched by class —
 * set up BEFORE mount so even the very first, synchronous measurement (the
 * `measure()` call inside the layout effect, same paint as mount) already
 * sees it, exactly like a real browser would.
 */
describe('BoardCanvas chrome offset recompute timing (an obstacle that appears AFTER the initial measurement)', () => {
  /** Bare DOMRect-shaped object; jsdom's own getBoundingClientRect always returns zeros, so every rect here is explicit. */
  function stubRect(left: number, top: number, right: number, bottom: number): DOMRect {
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
      x: left,
      y: top,
      toJSON() {
        return this;
      },
    } as DOMRect;
  }

  /** The div this file's own `chromeRow()` locates too, found independently here since it's local to the sibling describe block above. */
  function findChromeRow(container: HTMLElement): HTMLElement {
    const row = container.querySelector('div.absolute.z-20');
    if (!(row instanceof HTMLElement)) throw new Error('chrome row not found');
    return row;
  }

  /** BoardCanvas's own containerRef div — the `<Excalidraw>` subtree and our chrome both live inside it. */
  function findBoardContainer(container: HTMLElement): HTMLElement {
    const el = container.querySelector('div.relative.h-full.w-full');
    if (!(el instanceof HTMLElement)) throw new Error('board container not found');
    return el;
  }

  /**
   * Dispatches by class rather than by element identity, and is installed
   * BEFORE mount: the board container (133..812 high, 0..375 wide — the
   * owner's own numbers), our chrome row (335,145..363,173 — also the
   * owner's numbers, at the plain corner inset), and Excalidraw's two
   * top-band obstacles used across both tests below. Anything else — every
   * other element mount touches — falls back to jsdom's usual zero rect.
   *
   * A SINGLE prototype-level mock, dispatching by class, on purpose: once
   * Element.prototype.getBoundingClientRect is already a mock (from this
   * very call), `vi.spyOn` on any one INSTANCE of it does not shadow that
   * instance the way it would for a real method — it recognizes the
   * existing mock and hands back that SAME mock object, so a later
   * `.mockReturnValue(...)` on what looks like a per-element spy actually
   * overwrites the shared prototype mock for every element. Routing every
   * rect through this one function's classList dispatch sidesteps that
   * trap entirely rather than fighting it per test.
   */
  function stubChromeGeometry(stripRect: DOMRect = stubRect(338, 213, 375, 315)) {
    return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const classes = this.classList;
      if (classes.contains('relative') && classes.contains('h-full') && classes.contains('w-full')) {
        return stubRect(0, 133, 375, 812);
      }
      if (classes.contains('z-20')) {
        return stubRect(335, 145, 363, 173);
      }
      if (classes.contains('App-toolbar-container')) {
        return stubRect(25, 149, 350, 189);
      }
      if (classes.contains('mobile-misc-tools-container')) {
        return stripRect;
      }
      return stubRect(0, 0, 0, 0);
    });
  }

  /** Fake ctor that captures the callback it was constructed with — `observe`/`disconnect` are no-ops; the test decides exactly when (or whether) the callback runs. */
  function fakeObserverCtor<Cb>(assign: (cb: Cb) => void) {
    return class {
      constructor(cb: Cb) {
        assign(cb);
      }
      observe() {}
      disconnect() {}
    };
  }

  it('reacts to an obstacle inserted after mount via MutationObserver -> requestAnimationFrame, with no user action', async () => {
    let rafCallback: FrameRequestCallback | null = null;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: FrameRequestCallback) => {
        rafCallback = cb;
        return 1;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    let mutationCallback: MutationCallback | null = null;
    vi.stubGlobal('MutationObserver', fakeObserverCtor<MutationCallback>((cb) => (mutationCallback = cb)));
    stubChromeGeometry();

    const container = await mountReady();
    const boardEl = findBoardContainer(container);
    const row = findChromeRow(container);

    // Mount's own layout effect always schedules a "second pass" (fonts,
    // async layout) on top of its synchronous first measurement — consume it
    // now, before the obstacle exists, so what follows is unambiguously
    // triggered BY the obstacle, not by that unrelated pass.
    expect(rafCallback).not.toBeNull();
    act(() => rafCallback?.(0));

    // Baseline: nothing to dodge yet, so the row sits at the plain corner inset.
    expect(row.style.top).toBe('12px');
    expect(row.style.right).toBe('12px');

    // Excalidraw's own mobile toolbar lands LATE — after our own first
    // measurement already ran (QA-3 finding №2/№3's second half: the very
    // first measurement after a mode switch can miss it entirely).
    const toolbar = document.createElement('div');
    toolbar.className = 'App-toolbar-container';
    boardEl.appendChild(toolbar);

    expect(mutationCallback).not.toBeNull();
    act(() => {
      mutationCallback?.(
        [{ type: 'childList', target: boardEl, addedNodes: [toolbar] } as unknown as MutationRecord],
        null as unknown as MutationObserver,
      );
    });

    // schedule() ran and queued a fresh rAF — but nothing recomputed until it's actually invoked.
    expect(row.style.top).toBe('12px');
    act(() => rafCallback?.(0));

    // Pushed below the toolbar's bottom edge (189 - containerTop 133 + CHROME_ISLAND_GAP 8); not a right-edge strip, so `right` is untouched.
    expect(row.style.top).toBe('64px');
    expect(row.style.right).toBe('12px');
  });

  it('falls back to a short setTimeout when requestAnimationFrame is queued but never calls back — the hidden-tab case the owner could not reproduce live', async () => {
    let rafCallback: FrameRequestCallback | null = null;
    const raf = vi.fn((cb: FrameRequestCallback) => {
      rafCallback = cb; // captured, but this test never invokes it — simulating a hidden tab where it simply never runs
      return 1;
    });
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    let mutationCallback: MutationCallback | null = null;
    vi.stubGlobal('MutationObserver', fakeObserverCtor<MutationCallback>((cb) => (mutationCallback = cb)));
    // Already overlapping the row's own (unpushed) span — unlike the first
    // test, this one skips the toolbar so the strip alone has to trigger the
    // sideways dodge, with no vertical push to get it there first (the
    // "tall strip that DOES overlap the row at its current position" case
    // from boardChromeLayout.test.ts, not the toolbar-then-strip one).
    stubChromeGeometry(stubRect(338, 120, 375, 420));

    const container = await mountReady();
    const boardEl = findBoardContainer(container);
    const row = findChromeRow(container);

    // Consume mount's own automatic second pass the same way the first test
    // does, so the fallback timer below is unambiguously the strip's doing.
    expect(rafCallback).not.toBeNull();
    act(() => rafCallback?.(0));
    expect(row.style.right).toBe('12px');

    const strip = document.createElement('div');
    strip.className = 'mobile-misc-tools-container';
    boardEl.appendChild(strip);

    // Restricted to just setTimeout/clearTimeout: vi.useFakeTimers() fakes
    // requestAnimationFrame too by default, which would silently replace our
    // OWN rAF stub above — defeating the "rAF is queued but never calls
    // back" premise this test relies on.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      act(() => {
        mutationCallback?.(
          [{ type: 'childList', target: boardEl, addedNodes: [strip] } as unknown as MutationRecord],
          null as unknown as MutationObserver,
        );
      });

      // rAF was re-queued (and, per this test, will never call back) —
      // nothing has recomputed yet, and the fallback timer hasn't elapsed.
      expect(row.style.right).toBe('12px');

      act(() => {
        vi.advanceTimersByTime(CHROME_MEASURE_FALLBACK_MS);
      });

      // The setTimeout fallback alone did this — rafCallback was never
      // invoked again after the consumed mount pass above. The row dodges
      // the strip sideways (right = containerRight 375 - strip.left 338 +
      // CHROME_ISLAND_GAP 8); top is untouched, since nothing pushed it down.
      expect(row.style.right).toBe('45px');
      expect(row.style.top).toBe('12px');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('BoardCanvas sticky-note palette (Miro-style stickies, owner request)', () => {
  /**
   * `role="toolbar"`, not `group` — deliberately distinct from
   * BoardModeToggle's own `role="group"` so this file's `modeButtons()`
   * helper (which greps `[role="group"] button` indiscriminately) never
   * folds the palette's own swatch buttons into a mode-toggle assertion —
   * see StickyNotePalette.tsx's own comment on the choice.
   */
  function paletteEl(container: HTMLElement): HTMLElement | null {
    return container.querySelector('[role="toolbar"]');
  }

  it('is not rendered in the default "View" (view-only) mode', async () => {
    const container = await mountReady();
    expect(paletteEl(container)).toBeNull();
  });

  it('appears, with one swatch per configured colour, once switched to "Edit"', async () => {
    const container = await mountReady();
    const [, editButton] = modeButtons(container);

    await act(async () => {
      editButton.click();
    });

    const palette = paletteEl(container);
    expect(palette).toBeTruthy();
    expect(palette?.querySelectorAll('button').length).toBe(STICKY_NOTE_COLORS.length);
  });

  it('disappears again when switching back to "View"', async () => {
    localStorage.setItem(BOARD_MODE_KEY, 'edit');
    const container = await mountReady();
    expect(paletteEl(container)).toBeTruthy();

    const [viewButton] = modeButtons(container);
    await act(async () => {
      viewButton.click();
    });

    expect(paletteEl(container)).toBeNull();
  });

  it('clicking a swatch inserts one standard-size, opaque, correctly-coloured sticky centred on the viewport, and switches the active tool to selection', async () => {
    localStorage.setItem(BOARD_MODE_KEY, 'edit');
    const container = await mountReady();

    const palette = paletteEl(container);
    const swatches = Array.from(palette?.querySelectorAll('button') ?? []) as HTMLButtonElement[];
    const pinkIndex = STICKY_NOTE_COLORS.findIndex((c) => c.id === 'pink');
    // Mount itself already drives a few harmless updateScene calls (e.g. the
    // collaborators effect, with an empty peers list) — cleared here so the
    // count below is unambiguously "how many times did THIS click insert".
    state.fakeApi.updateScene.mockClear();
    await act(async () => {
      swatches[pinkIndex].click();
    });

    expect(state.fakeApi.setActiveTool).toHaveBeenCalledWith({ type: 'selection' });
    expect(state.fakeApi.updateScene).toHaveBeenCalledTimes(1);
    const { elements } = state.fakeApi.updateScene.mock.calls[0][0] as {
      elements: Array<{ type: string; width: number; height: number; x: number; y: number; backgroundColor: string }>;
    };
    const inserted = elements.at(-1);
    expect(inserted?.type).toBe('rectangle');
    expect(inserted?.width).toBe(STICKY_NOTE_SIZE);
    expect(inserted?.height).toBe(STICKY_NOTE_SIZE);
    expect(inserted?.backgroundColor).toBe(STICKY_NOTE_COLORS[pinkIndex].value);
    // Viewport is 800x600 at 100% zoom, un-scrolled (see fakeApi.getAppState) — centre is (400, 300).
    expect(inserted?.x).toBe(400 - STICKY_NOTE_SIZE / 2);
    expect(inserted?.y).toBe(300 - STICKY_NOTE_SIZE / 2);
  });
});

/**
 * Offline mode: a board created while there was no network is not on the
 * server, so nothing about opening it may ask the server — its identity
 * (path/title for export names, space for the unsynced-pages list) comes from
 * the local registry — and once the server has created it, the same mounted
 * board takes the real path without reloading.
 */
describe('BoardCanvas a board created offline (local page)', () => {
  function pageRequests(): string[] {
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    return calls.map((call) => String(call[0])).filter((url) => url.includes('/api/pages/'));
  }

  it('is ready without a single page request, takes its space from the registry, and names exports after the registry entry', async () => {
    const page = await createLocalPage({ space: 'ops', parentPath: '', title: 'Sketch', kind: 'board' });
    const container = await mountReady(page.id);

    expect(pageRequests()).toEqual([]);
    expect(state.lastSessionSpace).toBe('ops');
    // Ready and editable: Excalidraw is mounted, and the mode toggle is there.
    expect(state.lastExcalidrawProps.viewModeEnabled).toBeDefined();
    expect(modeButtons(container)).toHaveLength(2);

    act(() => exportTrigger(container).click());
    await act(async () => {
      exportMenuItem(container, 'PNG').click();
      await flushAll();
    });
    const [, filename] = state.downloadBlob.mock.calls[0] as [Blob, string];
    expect(filename).toBe('sketch.png');
  });

  it('a server board still fetches its metadata, and its space (from the response) reaches the session', async () => {
    await mountReady('board-1', { title: 'My Board', path: 'diagrams/my-board.excalidraw.svg', space: 'eng' });
    expect(pageRequests()).toHaveLength(1);
    expect(state.lastSessionSpace).toBe('eng');
  });

  it('when the server creates the board, the mounted board picks up the real path and space — no reload, no new fetch', async () => {
    const page = await createLocalPage({ space: 'ops', parentPath: '', title: 'Sketch', kind: 'board' });
    const container = await mountReady(page.id);

    await act(async () => {
      await removeLocalPage(page.id);
      emitLocalPageSynced({ ...localPageMeta(page), space: 'ops', path: 'sketches/sketch-2.excalidraw.svg', order: 4 });
      await flushAll();
    });

    expect(pageRequests()).toEqual([]);
    act(() => exportTrigger(container).click());
    await act(async () => {
      exportMenuItem(container, 'PNG').click();
      await flushAll();
    });
    const [, filename] = state.downloadBlob.mock.calls[0] as [Blob, string];
    expect(filename).toBe('sketch-2.png');
  });
});
