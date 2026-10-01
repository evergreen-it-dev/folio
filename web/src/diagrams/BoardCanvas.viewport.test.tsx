// @vitest-environment jsdom
/**
 * Owner report: "a default fit to screen mode is missing — so that the whole
 * scheme fits, and/or saving the zoom". Split into its own file (rather
 * than folded into BoardCanvas.test.tsx) purely to keep each mock setup
 * legible — this file's `@excalidraw/excalidraw` mock differs from the other
 * one (it needs to capture `initialData`/`onChange` and a stubbable
 * `scrollToContent`, which the mode/export-menu tests never touch).
 *
 * `./boardViewport` is mocked wholesale: this file only asserts that
 * BoardCanvas *calls* readStoredViewport/createViewportPersister with the
 * right arguments at the right times and reacts correctly to what they
 * return — not that the debounce/localStorage plumbing itself works, which
 * is already covered end to end by boardViewport.test.ts.
 *
 * Round 29 (LIVE COLLABORATION): the board's initial scene now comes from a
 * Y.Doc, not from an svg's embedded scene — see BoardCanvas.tsx's module
 * docblock. `./boardCollab` is mocked the same way BoardCanvas.test.tsx
 * mocks it (a real `Y.Doc` behind the fake session, `useBoardSynced`
 * reporting synced immediately), and each test seeds that Y.Doc's `elements`
 * map directly (via ./boardYdoc's real, unmocked write helpers) instead of
 * stubbing `loadFromBlob`'s return value the way the pre-Round-29 version of
 * this file did.
 *
 * Honesty note (see the owner's own instruction): jsdom never lays out a
 * real canvas, so Excalidraw's real `scrollToContent` is never exercised —
 * only the mocked `fakeApi.scrollToContent` stands in for it, and the canvas
 * size it would have measured is supplied by `state.canvasSize`. These tests
 * verify the *contract* (readStoredViewport wins over fit-to-screen; an
 * empty or unmeasured scene never calls scrollToContent; onChange forwards
 * scrollX/scrollY/zoom to the persister; the persister is flushed on
 * unmount) — not what the framed board actually looks like on screen. That
 * still needs a real browser; QA-3 measured it with
 * .qa/qa3-bdfix-8-verify.mjs (cold load: 100% before, 280% after).
 *
 * QA-3 finding №2 is the reason this file's Excalidraw mock now reproduces
 * the real MOUNT ORDER rather than a convenient one — see the mock's own
 * comment. The previous mock handed back the imperative API from an effect,
 * *after* the load had already resolved, which is not what the package does;
 * that single inaccuracy let a fit-to-screen that could never fire in a
 * browser pass here for weeks.
 */
import { useEffect } from 'react';
import { act } from '@testing-library/react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import * as Y from 'yjs';
import BoardCanvas from './BoardCanvas';
import { applyLocalElements, boardRoots } from './boardYdoc';
import type { BoardViewport } from './boardViewport';
import './i18n/register';

const state = vi.hoisted(() => ({
  lastExcalidrawProps: {} as {
    initialData?: { elements?: unknown[]; appState?: Record<string, unknown> };
    onChange?: (elements: unknown[], appState: Record<string, unknown>, files: unknown) => void;
  },
  /**
   * The canvas size Excalidraw reports in the appState it hands to onChange.
   * Real Excalidraw passes through a 0x0 pre-layout state before its own
   * resize observer has measured anything; a fit-to-screen fired against
   * that would divide by nothing, so BoardCanvas gates on it and tests can
   * replay it by setting this to zeroes.
   */
  canvasSize: { width: 1200, height: 800 },
  fakeApi: {
    id: 'fake-excalidraw-api',
    getSceneElements: vi.fn((): unknown[] => []),
    getSceneElementsIncludingDeleted: vi.fn((): unknown[] => []),
    getAppState: vi.fn(() => ({})),
    getFiles: vi.fn(() => ({})),
    scrollToContent: vi.fn(),
    updateScene: vi.fn(),
    addFiles: vi.fn(),
  },
  viewport: {
    stored: null as BoardViewport | null,
    readStoredViewport: vi.fn((_pageId: string) => state.viewport.stored),
    persisterNotifyChange: vi.fn(),
    persisterFlush: vi.fn(),
    persisterCancel: vi.fn(),
    createViewportPersister: vi.fn((_pageId: string, _delayMs: number) => ({
      notifyChange: state.viewport.persisterNotifyChange,
      flush: state.viewport.persisterFlush,
      cancel: state.viewport.persisterCancel,
    })),
  },
  /** Fresh per mountReady() call — see the ./boardCollab mock below. */
  collabSession: null as ReturnType<typeof buildFakeSession> | null,
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
  Excalidraw: (props: {
    excalidrawAPI?: (api: unknown) => void;
    initialData?: { elements?: unknown[] };
    onChange?: (elements: unknown[], appState: Record<string, unknown>, files: unknown) => void;
  }) => {
    state.lastExcalidrawProps = props as typeof state.lastExcalidrawProps;
    useEffect(() => {
      // The ORDER here is the whole point of this mock, and getting it wrong
      // is what let QA-3 finding №2 ship green: the real package (0.18.1)
      // calls `excalidrawAPI(api)` from its App **constructor**, while the
      // scene only materializes later and asynchronously in
      // `initializeScene` (from componentDidMount). So the API always
      // arrives FIRST, against an empty scene — `state.fakeApi
      // .getSceneElements()` deliberately keeps returning [] here...
      props.excalidrawAPI?.(state.fakeApi);
      // ...and only then does Excalidraw emit its first onChange carrying
      // the real elements plus the canvas size it has by now measured. Any
      // "fit the board to the screen once" logic has to hang off THIS, not
      // off the API handing itself over.
      props.onChange?.(
        props.initialData?.elements ?? [],
        { scrollX: 0, scrollY: 0, zoom: { value: 1 }, ...state.canvasSize },
        {},
      );
    });
    return null;
  },
  exportToSvg: vi.fn(async () => ({ outerHTML: '<svg></svg>' })),
  exportToBlob: vi.fn(async () => new Blob()),
  exportToClipboard: vi.fn(async () => {}),
  loadFromBlob: vi.fn(async () => ({ elements: [], appState: {}, files: {} })),
  getSceneVersion: vi.fn(() => 0),
  reconcileElements: vi.fn((_local: unknown, remote: unknown) => remote),
  restoreElements: vi.fn((elements: unknown) => elements),
  CaptureUpdateAction: { IMMEDIATELY: 'IMMEDIATELY', NEVER: 'NEVER', EVENTUALLY: 'EVENTUALLY' },
  THEME: { LIGHT: 'light', DARK: 'dark' },
  MIME_TYPES: { excalidraw: 'application/vnd.excalidraw+json', png: 'image/png' },
  useHandleLibrary: vi.fn(),
  // Sticky notes (board plugin): this file's own tests never insert one, so a
  // simple passthrough is enough to keep BoardCanvas's module-level import
  // from resolving to `undefined` — see boardStickyNotes.test.ts for the real
  // coverage of what these two actually produce.
  convertToExcalidrawElements: vi.fn((skeletons: unknown[]) => skeletons),
  ROUNDNESS: { LEGACY: 1, PROPORTIONAL_RADIUS: 2, ADAPTIVE_RADIUS: 3 },
}));

vi.mock('./boardViewport', () => ({
  readStoredViewport: state.viewport.readStoredViewport,
  createViewportPersister: state.viewport.createViewportPersister,
}));

// See BoardCanvas.test.tsx's own comment on this mock — same shape, same
// reasoning: a real Y.Doc backs the fake session so ./boardYdoc's read/write
// logic runs for real, only the WebsocketProvider/network part is faked out.
vi.mock('./boardCollab', () => ({
  useBoardCollabSession: (pageId: string) => (pageId ? state.collabSession : null),
  useBoardSynced: (session: unknown) => session !== null,
  useBoardConnectionStatus: () => 'connected' as const,
  useBoardPeers: () => [],
  publishBoardPointer: vi.fn(),
  throttledPointerPublisher: vi.fn(() => ({ publish: vi.fn(), cancel: vi.fn() })),
}));

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The auto-fit defers its scrollToContent by one frame (it fires from
  // inside Excalidraw's own componentDidUpdate — see BoardCanvas's
  // autoFitOnFirstScene). Running frames synchronously keeps the assertions
  // exact instead of racing jsdom's ~16ms rAF timer. Assigned rather than
  // vi.stubGlobal'd because afterEach unstubs globals wholesale.
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
  await i18next.changeLanguage('en');
});

const activeRoots: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  // Unmount BEFORE clearing the mocks: BoardCanvas's own unmount cleanup
  // calls viewportPersisterRef.current?.flush(), so clearing first would let
  // that trailing call leak into the next test's initial assertions.
  for (const { root, container } of activeRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
  state.lastExcalidrawProps = {};
  state.canvasSize = { width: 1200, height: 800 };
  state.fakeApi.getSceneElements.mockClear();
  state.fakeApi.scrollToContent.mockClear();
  state.fakeApi.updateScene.mockClear();
  state.fakeApi.addFiles.mockClear();
  state.viewport.stored = null;
  state.viewport.readStoredViewport.mockClear();
  state.viewport.createViewportPersister.mockClear();
  state.viewport.persisterNotifyChange.mockClear();
  state.viewport.persisterFlush.mockClear();
  state.viewport.persisterCancel.mockClear();
  state.collabSession = null;
});

function stubFetch() {
  const fetchMock = vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ title: 'My Board', path: 'diagrams/my-board.excalidraw.svg' }) }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Same generous flush as BoardCanvas.test.tsx — long enough to clear the fetch-driven metadata effect and the excalidrawAPI-appears effect chain that follows it (no artificial delay of its own — see BoardCanvas.tsx's fit-to-screen effect). */
async function flushAll() {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

interface SceneElementFixture {
  id: string;
  version?: number;
  versionNonce?: number;
  index?: string;
}

/** Seeds the fake session's `elements` Y.Map — the collab-path equivalent of the old loadFromBlob-mocked "restored scene". Call BEFORE mountReady(). */
function seedScene(pageId: string, elements: SceneElementFixture[]): void {
  const session = buildFakeSession(pageId);
  state.collabSession = session;
  const withDefaults = elements.map((el) => ({ isDeleted: false, version: 1, versionNonce: 1, index: 'a0', type: 'rectangle', x: 0, y: 0, width: 1, height: 1, ...el }));
  applyLocalElements(session.doc, session.elements, withDefaults as never);
}

/**
 * Production wraps the whole router (including `/share/:token`) in a single
 * `QueryClientProvider` (see App.tsx) — `useOptionalSessionUser()` (collabIdentity.ts),
 * now called from BoardCanvas as part of today's share-identity fix, relies on that
 * ambient client via react-query's `useQuery`. These tests mount BoardCanvas directly,
 * bypassing App.tsx entirely, so each render supplies its own throwaway client — fresh
 * per mount so no query state leaks between tests.
 */
function renderBoard(pageId: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <BoardCanvas pageId={pageId} />
    </QueryClientProvider>
  );
}

async function mountReady(pageId = 'board-1'): Promise<HTMLElement> {
  stubFetch();
  if (!state.collabSession) state.collabSession = buildFakeSession(pageId);
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

describe('BoardCanvas viewport restore (a saved viewport always wins over fit-to-screen)', () => {
  it('reads the stored viewport for this exact pageId', async () => {
    await mountReady('board-42');
    expect(state.viewport.readStoredViewport).toHaveBeenCalledWith('board-42');
  });

  it('folds a stored viewport into initialData.appState (restored-scene branch) and never calls scrollToContent', async () => {
    state.viewport.stored = { scrollX: 111, scrollY: -222, zoom: 1.5 };
    seedScene('board-1', [{ id: 'a' }]);

    await mountReady();

    const appState = state.lastExcalidrawProps.initialData?.appState as Record<string, unknown>;
    expect(appState).toMatchObject({
      scrollX: 111,
      scrollY: -222,
      zoom: { value: 1.5 },
    });
    expect(state.fakeApi.scrollToContent).not.toHaveBeenCalled();
  });

  it('folds a stored viewport into initialData.appState even for a brand-new (empty Y.Doc) board', async () => {
    state.viewport.stored = { scrollX: 5, scrollY: 6, zoom: 0.8 };

    await mountReady();

    const appState = state.lastExcalidrawProps.initialData?.appState as Record<string, unknown>;
    expect(appState).toMatchObject({ scrollX: 5, scrollY: 6, zoom: { value: 0.8 } });
    expect(state.fakeApi.scrollToContent).not.toHaveBeenCalled();
  });
});

describe('BoardCanvas fit-to-screen on first open (no stored viewport yet)', () => {
  /**
   * QA-3 finding №2 — the regression this whole block exists for. The old
   * implementation fired off an effect keyed on the imperative API arriving
   * and gave up (permanently — it cleared its one-shot flag first) when the
   * scene was still empty at that instant, which in a real browser it always
   * is. Note what this test deliberately does NOT do: it never makes
   * `getSceneElements()` return anything. The fit has to happen off the
   * scene Excalidraw actually reports through onChange, so an implementation
   * that reads the API at handover time cannot pass this.
   */
  it('fits once the scene arrives through onChange, even though the API was handed over with an empty scene', async () => {
    state.viewport.stored = null;
    state.fakeApi.getSceneElements.mockReturnValue([]);
    seedScene('board-1', [{ id: 'a' }]);

    await mountReady();

    expect(state.fakeApi.scrollToContent).toHaveBeenCalledTimes(1);
    expect(state.fakeApi.scrollToContent).toHaveBeenCalledWith(undefined, { fitToViewport: true, animate: false });
  });

  it('fits exactly once, however many onChange events follow', async () => {
    state.viewport.stored = null;
    seedScene('board-1', [{ id: 'a' }]);
    await mountReady();

    act(() => {
      state.lastExcalidrawProps.onChange?.(
        [{ id: 'a' }],
        { scrollX: 0, scrollY: 0, zoom: { value: 1 }, width: 1200, height: 800 },
        {},
      );
    });

    expect(state.fakeApi.scrollToContent).toHaveBeenCalledTimes(1);
  });

  it('waits for a measured canvas — an onChange carrying a 0x0 appState never triggers a fit', async () => {
    state.viewport.stored = null;
    state.canvasSize = { width: 0, height: 0 }; // Excalidraw's own pre-layout state
    seedScene('board-1', [{ id: 'a' }]);

    await mountReady();

    expect(state.fakeApi.scrollToContent).not.toHaveBeenCalled();
  });

  it('never calls scrollToContent for a genuinely empty/new board (nothing in the Y.Doc at all)', async () => {
    state.viewport.stored = null;

    await mountReady();

    expect(state.fakeApi.scrollToContent).not.toHaveBeenCalled();
  });

  it('never calls scrollToContent when the restored scene has zero elements — an empty canvas is never fed to fit-to-screen', async () => {
    state.viewport.stored = null;
    state.fakeApi.getSceneElements.mockReturnValue([]);
    // an empty Y.Doc — the default from mountReady's own fallback session.

    await mountReady();

    expect(state.fakeApi.scrollToContent).not.toHaveBeenCalled();
  });

  it('a stored viewport still wins: content loads through onChange and no fit happens', async () => {
    state.viewport.stored = { scrollX: 9, scrollY: 9, zoom: 1.25 };
    seedScene('board-1', [{ id: 'a' }]);

    await mountReady();

    expect(state.fakeApi.scrollToContent).not.toHaveBeenCalled();
  });
});

describe('BoardCanvas viewport persistence wiring', () => {
  it('forwards scrollX/scrollY/zoom.value from onChange to the persister on every change (pan/zoom, not just element edits)', async () => {
    seedScene('board-1', [{ id: 'a' }]);
    await mountReady();

    act(() => {
      state.lastExcalidrawProps.onChange?.([], { scrollX: 10, scrollY: 20, zoom: { value: 2 } }, {});
    });

    expect(state.viewport.persisterNotifyChange).toHaveBeenCalledWith({ scrollX: 10, scrollY: 20, zoom: 2 });
  });

  it('flushes the viewport persister on unmount, same as the autosave scheduler', async () => {
    stubFetch();
    state.collabSession = buildFakeSession('board-1');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(renderBoard('board-1'));
      await flushAll();
    });

    expect(state.viewport.persisterFlush).not.toHaveBeenCalled();
    act(() => root.unmount());
    expect(state.viewport.persisterFlush).toHaveBeenCalledTimes(1);
    container.remove();
  });
});

/** The explicit "Fit to screen" button — the only one of our own top-row controls carrying a plain aria-label (export uses aria-haspopup, mode toggle uses aria-pressed). */
function fitToScreenButton(container: HTMLElement): HTMLButtonElement {
  const found = container.querySelector('button[aria-label]') as HTMLButtonElement | null;
  if (!found) throw new Error('fit-to-screen button not found');
  return found;
}

describe('BoardCanvas explicit fit-to-screen button (owner report: no such control exists today)', () => {
  it('is rendered once the board is ready, even in the default view-only mode', async () => {
    const container = await mountReady();
    expect(fitToScreenButton(container)).not.toBeNull();
  });

  it('clicking it calls scrollToContent(undefined, { fitToViewport: true, animate: true }) — animated, unlike the silent on-load fit', async () => {
    state.fakeApi.getSceneElements.mockReturnValue([{ id: 'a' }]);
    const container = await mountReady();

    act(() => fitToScreenButton(container).click());

    expect(state.fakeApi.scrollToContent).toHaveBeenCalledWith(undefined, { fitToViewport: true, animate: true });
  });

  it('is a no-op on an empty scene — never feeds zoomToFit an empty scene', async () => {
    state.fakeApi.getSceneElements.mockReturnValue([]);
    const container = await mountReady();

    act(() => fitToScreenButton(container).click());

    expect(state.fakeApi.scrollToContent).not.toHaveBeenCalled();
  });
});
