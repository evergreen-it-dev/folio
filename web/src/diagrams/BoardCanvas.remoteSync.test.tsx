// @vitest-environment jsdom
/**
 * Board collab contract fix (fix/board-collab-contract) — regression tests
 * for the "everything jumps/appears/disappears/edits fight each other"
 * report. Root cause (see BoardCanvas.tsx's remote-sync effect and its own
 * comment): applying a remote Y.Map change through `updateScene({ elements })`
 * WITHOUT `captureUpdate: CaptureUpdateAction.NEVER` makes Excalidraw treat
 * the peer's edit as this tab's own local edit — it lands in local undo
 * history and re-enters onChange as if the user had just drawn it, which
 * then gets written straight back into the Y.Doc. Two things close that
 * loop, both asserted here directly against BoardCanvas + a REAL Y.Doc (only
 * the Excalidraw component itself is mocked out — canvas rendering doesn't
 * exist in jsdom):
 *
 *  (a) applying a remote change calls `updateScene` with
 *      `captureUpdate: CaptureUpdateAction.NEVER`.
 *  (b) the version barrier: once that remote change has been applied, the
 *      very next onChange Excalidraw fires for THAT SAME scene must NOT
 *      write anything back into the Y.Map — the barrier recognizes "already
 *      in sync" rather than re-broadcasting what was just received.
 *
 * `getSceneVersion`/`reconcileElements`/`restoreElements` are mocked with
 * small deterministic stand-ins (sum-of-versions / remote-wins / pass-through)
 * rather than the real package — the point of these tests is the CONTRACT
 * (when is updateScene called, with what option, does onChange then write or
 * not), not re-verifying reconcileElements' own merge algorithm, which
 * belongs to @excalidraw/excalidraw itself.
 */
import { useEffect } from 'react';
import { act } from '@testing-library/react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import * as Y from 'yjs';
import BoardCanvas from './BoardCanvas';
import { boardRoots, BOARD_LOCAL_ORIGIN } from './boardYdoc';
import './i18n/register';

interface FakeElement {
  id: string;
  version: number;
  versionNonce: number;
  index: string;
  isDeleted: boolean;
  type: string;
  updated: number;
}

function fakeElement(overrides: Partial<FakeElement> & { id: string; version: number }): FakeElement {
  return {
    versionNonce: 1,
    index: 'a0',
    isDeleted: false,
    type: 'rectangle',
    updated: Date.now(),
    ...overrides,
  };
}

const state = vi.hoisted(() => ({
  lastExcalidrawProps: {} as {
    excalidrawAPI?: (api: unknown) => void;
    onChange?: (elements: unknown[], appState: Record<string, unknown>, files: unknown) => void;
  },
  fakeApi: {
    id: 'fake-excalidraw-api',
    getSceneElements: vi.fn((): unknown[] => []),
    getSceneElementsIncludingDeleted: vi.fn((): unknown[] => []),
    getAppState: vi.fn(() => ({})),
    getFiles: vi.fn(() => ({})),
    updateScene: vi.fn(),
    addFiles: vi.fn(),
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
    onChange?: (elements: unknown[], appState: Record<string, unknown>, files: unknown) => void;
  }) => {
    state.lastExcalidrawProps = props;
    useEffect(() => {
      props.excalidrawAPI?.(state.fakeApi);
    });
    return null;
  },
  exportToSvg: vi.fn(async () => ({ outerHTML: '<svg></svg>' })),
  exportToBlob: vi.fn(async () => new Blob()),
  exportToClipboard: vi.fn(async () => {}),
  loadFromBlob: vi.fn(async () => ({ elements: [], appState: {}, files: {} })),
  // Deterministic stand-in: sum of `version` fields — monotonic in exactly
  // the way that matters for the barrier (an unchanged scene reports an
  // unchanged version; a genuinely edited one reports a higher one).
  getSceneVersion: vi.fn((elements: readonly { version?: number }[]) =>
    elements.reduce((sum, el) => sum + (el.version ?? 0), 0),
  ),
  // "Remote always wins" stand-in — real @excalidraw/excalidraw's own merge
  // algorithm is exercised by the package's own test suite, not this file.
  reconcileElements: vi.fn((_local: unknown, remote: unknown) => remote),
  // Pass-through — this file isn't exercising restoreElements' own field
  // repair, just that it's in the pipeline ahead of reconcileElements.
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
  await i18next.changeLanguage('en');
});

const activeRoots: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of activeRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
  state.lastExcalidrawProps = {};
  state.fakeApi.getSceneElements.mockReturnValue([]);
  state.fakeApi.getSceneElementsIncludingDeleted.mockReturnValue([]);
  state.fakeApi.getAppState.mockReturnValue({});
  state.fakeApi.updateScene.mockClear();
  state.fakeApi.addFiles.mockClear();
  state.collabSession = null;
});

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ title: '', path: '' }) })),
  );
}

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

async function mountReady(pageId = 'board-1'): Promise<{ container: HTMLElement; session: NonNullable<typeof state.collabSession> }> {
  stubFetch();
  const session = buildFakeSession(pageId);
  state.collabSession = session;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  activeRoots.push({ root, container });
  await act(async () => {
    root.render(renderBoard(pageId));
    await flushAll();
  });
  return { container, session };
}

/** Simulates a peer's edit landing over the wire: written under a foreign origin, exactly like the real WebsocketProvider relaying another client's update — never BOARD_LOCAL_ORIGIN. */
function applyRemoteWrite(session: NonNullable<typeof state.collabSession>, element: FakeElement): void {
  session.doc.transact(() => {
    session.elements.set(element.id, element);
  }, 'remote-peer');
}

describe('remote apply uses captureUpdate: NEVER (audit item 1)', () => {
  it('a Y.Map change from another origin calls updateScene with captureUpdate: CaptureUpdateAction.NEVER', async () => {
    const { session } = await mountReady();
    state.fakeApi.updateScene.mockClear();

    const remoteEl = fakeElement({ id: 'r1', version: 5 });
    act(() => {
      applyRemoteWrite(session, remoteEl);
    });

    expect(state.fakeApi.updateScene).toHaveBeenCalledTimes(1);
    const call = state.fakeApi.updateScene.mock.calls[0][0] as { elements?: unknown[]; captureUpdate?: string };
    expect(call.captureUpdate).toBe('NEVER');
    expect(call.elements).toEqual([remoteEl]);
  });

  it('a Y.Map change tagged with THIS tab\'s own local origin does NOT re-trigger updateScene (no self-echo)', async () => {
    const { session } = await mountReady();
    state.fakeApi.updateScene.mockClear();

    act(() => {
      session.doc.transact(() => {
        session.elements.set('r1', fakeElement({ id: 'r1', version: 1 }));
      }, BOARD_LOCAL_ORIGIN);
    });

    expect(state.fakeApi.updateScene).not.toHaveBeenCalled();
  });
});

describe('version barrier: the onChange that follows a remote apply does not write it back (audit item 2)', () => {
  it('does not write to the Y.Map when the post-apply onChange reports the same scene VERSION, even if Excalidraw reassigned a versionNonce internally applying it', async () => {
    // This is deliberately NOT the same object/nonce as what was written to
    // the room: applying an update through updateScene is exactly the kind
    // of internal store operation that can hand an element a fresh
    // versionNonce even though nothing about its content actually changed
    // (see the audit's item 1 comment on captureUpdate). writeElementsToMap's
    // OWN per-element dedupe only catches an identical (version, nonce) pair
    // — it would NOT catch this by itself, which is exactly why the barrier
    // has to gate on the whole-scene VERSION instead: this test is red
    // without it.
    const { session } = await mountReady();

    const remoteEl = fakeElement({ id: 'r1', version: 5, versionNonce: 1 });
    act(() => {
      applyRemoteWrite(session, remoteEl);
    });
    const reappliedEl = { ...remoteEl, versionNonce: 7 };
    state.fakeApi.getSceneElementsIncludingDeleted.mockReturnValue([reappliedEl]);

    const localOriginUpdates: unknown[] = [];
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin === BOARD_LOCAL_ORIGIN) localOriginUpdates.push(origin);
    };
    session.doc.on('update', onUpdate);

    act(() => {
      // appState/files deliberately carry nothing new (no viewBackgroundColor
      // key, no files) so only the elements-barrier path is under test.
      state.lastExcalidrawProps.onChange?.([reappliedEl], { zoom: { value: 1 } }, {});
    });

    session.doc.off('update', onUpdate);
    expect(localOriginUpdates).toHaveLength(0);
    // and the map still holds exactly what the remote write put there — the
    // reassigned-nonce echo never overwrote it
    expect(session.elements.get('r1')).toEqual(remoteEl);
  });

  it('DOES write to the Y.Map once the scene genuinely advances past the last synced version', async () => {
    const { session } = await mountReady();

    const remoteEl = fakeElement({ id: 'r1', version: 5 });
    act(() => {
      applyRemoteWrite(session, remoteEl);
    });

    // The user now drags the element locally — a real, newer edit.
    const editedEl = fakeElement({ id: 'r1', version: 6, versionNonce: 2 });
    state.fakeApi.getSceneElementsIncludingDeleted.mockReturnValue([editedEl]);

    act(() => {
      state.lastExcalidrawProps.onChange?.([editedEl], { zoom: { value: 1 } }, {});
    });

    expect(session.elements.get('r1')).toMatchObject({ version: 6 });
  });
});
