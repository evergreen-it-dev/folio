import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import i18next from 'i18next';
import {
  Excalidraw,
  exportToSvg,
  exportToBlob,
  exportToClipboard,
  loadFromBlob,
  getSceneVersion,
  reconcileElements,
  restoreElements,
  CaptureUpdateAction,
  THEME,
  MIME_TYPES,
  useHandleLibrary,
} from '@excalidraw/excalidraw';
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  NormalizedZoomValue,
  BinaryFileData,
  Collaborator,
  SocketId,
} from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import * as Y from 'yjs';
import '@excalidraw/excalidraw/index.css';
import { AlertCircle, Maximize, RotateCw } from 'lucide-react';
import type { PageDoc, SharedPagePayload, ShareLinkMode, SpaceRole } from '@shared/contracts';
import { usePagePresence, usePublishPagePresence } from '../app/presence';
import { useOptionalSessionUser } from '../app/collabIdentity';
import { getLocalPage, onLocalPageSynced } from '../app/offline';
import { useColorScheme } from './colorScheme';
import { useConnectivity } from '../app/offline/connectivity';
import { createAutosaveScheduler, type AutosaveScheduler } from './autosaveScheduler';
import { getBoardEndpoints } from './boardEndpoints';
import {
  useBoardCollabSession,
  useBoardConnectionStatus,
  useBoardPeers,
  useBoardSynced,
  anonUser,
  throttledPointerPublisher,
} from './boardCollab';
import {
  BOARD_LOCAL_ORIGIN,
  applyLocalBoardFields,
  applyLocalElements,
  applyLocalFiles,
  boardFieldsFromMap,
  createThrottledElementsWriter,
  filesFromMap,
  orderedElementsFromMap,
  type ThrottledElementsWriter,
} from './boardYdoc';
import { mapToExcalidrawLangCode } from './langCode';
import { folioLibraryAdapter } from './libraries/libraryPersistence';
import { BoardModeToggle } from './BoardModeToggle';
import {
  COMPACT_VIEWPORT_QUERY,
  initialBoardMode,
  isCompactViewport,
  resolveViewModeEnabled,
  storeBoardMode,
  type BoardMode,
} from './boardMode';
import {
  CHROME_EDGE_GAP,
  CHROME_ISLAND_GAP,
  EXCALIDRAW_BOTTOM_OBSTACLES,
  EXCALIDRAW_TOP_OBSTACLES,
  bottomOffsetClearing,
  collectObstacleRects,
  topOffsetClearing,
} from './boardChromeLayout';
import { readStoredViewport, createViewportPersister, type ViewportPersister } from './boardViewport';
import { BoardExportMenu } from './BoardExportMenu';
import { downloadBlob } from './download';
import { exportFilename } from './exportFilename';
import { BoardReactions } from './BoardReactions';
import { StickyNotePalette, STICKY_NOTE_DRAG_MIME } from './StickyNotePalette';
import { createStickyNoteElements, screenToSceneCoords, sceneToScreenCoords, type StickyNoteColorId } from './boardStickyNotes';
import { trackBoardEdit } from '../analytics';
import './i18n/register';

const AUTOSAVE_DELAY_MS = 1500;
/**
 * A failed autosave (e.g. a transient 502/503/504 during a redeploy, per the
 * P0 report) must not just sit there until the user happens to draw
 * something else — that "next edit resaves everything since" path already
 * falls out of the scheduler's own version gate (its `lastSavedVersion` is
 * bumped optimistically inside runSave regardless of whether `save()`
 * actually succeeded, so a later real edit still looks dirty and re-fires).
 * This is the fallback for "the failed save WAS the user's last action":
 * retry it unattended after a short wait instead of leaving it stuck on the
 * manual retry button.
 *
 * Round 29: only the SHARE path still uses this REST scheduler at all — see
 * this file's module docblock below.
 */
const AUTOSAVE_ERROR_RETRY_MS = 10_000;
/**
 * Fallback height for the chrome row when it hasn't been measured yet (jsdom,
 * or the very first paint) — just enough to keep the "new board" hint from
 * landing on top of it. The measured height wins the moment there is one.
 */
const CHROME_ROW_FALLBACK_HEIGHT = 32;
/**
 * Fallback delay for the chrome-offset re-measure when requestAnimationFrame
 * never fires (a backgrounded/hidden tab — confirmed: its callback simply
 * never runs). Short enough that a visible tab, where rAF wins the race
 * every time, never perceives it; long enough that it isn't itself a source
 * of redundant recomputes on a normal frame. See the layout effect below.
 */
export const CHROME_MEASURE_FALLBACK_MS = 120;
/** Debounce for viewport (pan/zoom) persistence — shorter than autosave: there's no server round-trip, no scene-version gate, and nothing bad happens if the last write lands a bit more eagerly. */
const VIEWPORT_SAVE_DELAY_MS = 500;
/**
 * Collab path only — same interval the official multiplayer client uses for
 * its periodic full-scene resync (SYNC_FULL_SCENE_INTERVAL_MS). A pure
 * self-heal: every tick, this tab's own current scene is pushed through
 * writeElementsToMap again, which is a no-op for every element whose version
 * already matches what's in the room and only actually writes something that
 * genuinely drifted (a dropped websocket frame, a missed observer callback).
 */
const SYNC_FULL_SCENE_INTERVAL_MS = 20_000;
/**
 * Collab path only — throttles this tab's OWN local element writes into the
 * Y.Doc (see createThrottledElementsWriter's own docblock for the exact
 * reliability gap this closes: two separate `doc.transact()` calls from the
 * same client landing only milliseconds apart — exactly what an interactive
 * drag/resize produces, one write for the freshly-created element, a second
 * moments later for its real size — were reproducibly observed to reach the
 * server but not both survive to an already-connected peer, even well past
 * this client's own periodic resync). 250ms keeps every acceptance scenario
 * ("draws in A, appears in B within a second") comfortably inside its
 * budget while giving consecutive onChange calls from one gesture room to
 * land as a SINGLE transaction instead of a burst.
 */
const ELEMENTS_WRITE_THROTTLE_MS = 250;

/**
 * Merges a saved viewport (if any) into an initialData appState. A stored
 * viewport always wins over Excalidraw's own default view — see
 * boardViewport.ts's docblock for why this lives in localStorage rather than
 * the file. `zoom.value` is a branded NormalizedZoomValue at Excalidraw's own
 * type level; boardViewport.ts stores a plain number (it has no dependency on
 * excalidraw's types), so the re-brand happens here, at the one place that
 * actually needs it.
 */
function applyStoredViewport(
  appState: ExcalidrawInitialDataState['appState'],
  viewport: ReturnType<typeof readStoredViewport>,
): ExcalidrawInitialDataState['appState'] {
  if (!viewport) return appState;
  return {
    ...appState,
    scrollX: viewport.scrollX,
    scrollY: viewport.scrollY,
    zoom: { value: viewport.zoom as NormalizedZoomValue },
  };
}

/**
 * Must match UNAUTHORIZED_EVENT in web/src/app/api.ts byte-for-byte.
 * diagrams/ can't import from app/ (that's the exact app/<->markdown/
 * circular-import edge api.ts's own comment on this event warns about), so
 * every module outside app/ that wants a 401 to drop the app back to the
 * login screen has to redeclare this event name and dispatch it by hand.
 */
const UNAUTHORIZED_EVENT = 'folio:unauthorized';

function reportUnauthorized(): void {
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}

export interface BoardCanvasProps {
  pageId: string;
  /**
   * Present for a guest viewing/editing via a share link (round 8) instead
   * of an authenticated session. Routes load/save through the public
   * /api/share/:token endpoints instead of /api/pages/:id — see
   * boardEndpoints.ts. When set, `pageId` is unused for network purposes
   * (share tokens resolve their own page server-side) and may be passed as
   * `''` if the caller doesn't have a real id up front.
   *
   * Round 29: a share link ALSO never opens a collab room (see this file's
   * module docblock) — a shareToken board still goes through the original
   * GET+PUT-with-debounce path in full.
   */
  shareToken?: string;
  /**
   * Required to actually arm editing/autosave for a share token — omitting
   * it (or 'view') is the safe default. Even 'edit' only takes effect if
   * GET /api/share/:token's own `mode` agrees; a caller passing the wrong
   * value degrades to read-only rather than ever over-trusting itself.
   * Ignored (irrelevant) when shareToken is absent — the authenticated path
   * is always fully editable, same as before.
   */
  shareMode?: ShareLinkMode;
}

type LoadState =
  | { status: 'loading' }
  | {
      status: 'ready';
      initialData: ExcalidrawInitialDataState;
      isNew: boolean;
      editable: boolean;
      /**
       * The page's own `path`/`title` (PageMeta). Used only to name PNG/SVG
       * exports (exportFilename.ts); '' is a safe default (exportFilename
       * falls back to a generic name), so missing metadata never breaks the
       * load. On the collab path these can arrive AFTER 'ready' (the scene
       * itself never waits on this fetch — see the module docblock) and get
       * folded in later; see the metadata effect below.
       */
      path: string;
      title: string;
    }
  | { status: 'error'; reason: 'unauthorized' | 'invalid-link' | 'failed' };

type SaveState =
  | 'idle'
  | 'saving'
  | 'saved'
  | 'error'
  | 'unauthorized'
  | 'invalid-link'
  | 'connecting'
  | 'connected'
  | 'offline';

/**
 * The real Excalidraw board editor. This module is the one that pulls in
 * @excalidraw/excalidraw (a large dependency) — it must only ever be reached
 * through BoardEditor's React.lazy() boundary so pages that never open a
 * board don't pay for it. One instance is scoped to exactly one pageId: the
 * public BoardEditor remounts us (via `key`) when the page changes, so we
 * don't need to handle pageId changing under us mid-life.
 *
 * DEV-PLAN Round 29 (LIVE COLLABORATION) — two entirely separate persistence
 * paths, chosen by whether a share token is present:
 *
 *  - No shareToken (the normal, authenticated board — PageContent.tsx only
 *    ever mounts BoardEditor for a role that can already edit; a viewer gets
 *    StaticBoardView instead, so this path is ALWAYS fully editable): a
 *    `Y.Doc` collab room at the same `/collab` websocket endpoint and room
 *    name (pageId) the prose editor and tables already use — see
 *    ./boardCollab.ts and ./boardYdoc.ts. The scene comes from the Y.Doc
 *    after its first sync, `onChange` writes straight into the CRDT (no
 *    export-to-svg, no PUT, no debounce — the server now persists), and a
 *    remote Y.Map change is reconciled into the live Excalidraw scene via
 *    the package's own `reconcileElements` (the same function excalidraw.com
 *    uses for its collaboration mode). The old GET/PUT/autosave-scheduler
 *    machinery below is entirely unused on this path.
 *
 *  - shareToken present: unchanged from round 8/21 — GET the svg, PUT it
 *    back through the existing debounced autosave scheduler. A share link
 *    never opens a collab room this round: BoardCanvasProps.pageId may be
 *    `''` for a share guest (the token resolves the page server-side), and
 *    the app layer that WOULD wire a collab `?share=` param through (the way
 *    it already does for documents/tables — see SharedPageView.tsx) belongs
 *    to another zone and another round.
 *
 * Load-state contract for the share path (P0 fix, unchanged): a failed load
 * must NEVER be treated as an empty board — the previous version did exactly
 * that (any loadFromBlob throw, including a genuine network/401/500 failure,
 * fell back to "start blank"), so the very next autosave PUT a blank scene
 * over a real file the first time the backend hiccuped. Exactly one of three
 * outcomes now:
 *   - fetched svg embeds a real scene                -> ready, restore it
 *   - fetched svg has NO embedded-scene marker at all -> ready, genuinely
 *     new (this is what the server's own bare creation skeleton — see
 *     server/storage.ts's board-create path — looks like, and it's the ONLY
 *     signal that means "safe to start blank", checked BEFORE ever calling
 *     loadFromBlob rather than inferred from whether it happened to throw)
 *   - anything else: request failed outright (network/401/5xx), or the svg
 *     claims to embed a scene but loadFromBlob couldn't decode it (corrupt/
 *     truncated file) -> 'error': read-only banner, autosave structurally
 *     never arms (the effect below that builds the scheduler only ever
 *     runs off a 'ready' state, and <Excalidraw> itself isn't even mounted
 *     in 'error', so there is no onChange to arm it with regardless)
 *
 * The collab path has no analogous hard error state: exactly like the prose
 * editor and tables (see editor/collab.ts's ConnectionBadge — no blocking
 * error screen there either), a connection problem shows as the save chip
 * going 'offline' rather than replacing the board with a banner — the
 * WebsocketProvider keeps retrying on its own, and there is no local REST
 * call whose failure needs a distinct "retry" affordance.
 *
 * Offline mode: a board created while there was no network (a "local page",
 * app/offline/localPages.ts) is 'ready' and editable like any other collab
 * board — its session hands out the Y.Doc only after the board's content has
 * been loaded from disk (boardCollab.ts / app/collabOffline.ts), so `synced`
 * means "the content is here" and the scene is built from it exactly once.
 * What differs is where the page's identity comes from: path/title/space are
 * read from the local registry instead of GET /api/pages/:id (which would
 * 404, or fail outright, for a page the server has never heard of), and
 * nothing on this path makes a REST call. The save chip needs no special case
 * — the session's socket is deliberately not connected, which is exactly the
 * existing 'offline' chip, never a claim that anything was saved. When the
 * server creates the board (`onLocalPageSynced`) the SAME session connects
 * and this component carries on as a normal collaborative board; only the
 * page's metadata is refreshed.
 *
 * Share links (round 8) reuse the share-path contract end to end: a 401/404
 * from a share endpoint maps to its own 'invalid-link' outcome (never
 * 'unauthorized' — a guest was never logged in, so bouncing them at the
 * app's session gate would be wrong) instead of the generic 'failed', and a
 * view-mode (or mode-mismatched) token adds a fourth `editable: false`
 * flavor of 'ready' that mounts Excalidraw with `viewModeEnabled` and never
 * builds an autosave scheduler at all — same "never arm off anything but a
 * confirmed-good, confirmed-editable load" principle as the rest of this
 * contract.
 *
 * Round 21 adds a second, independent input to that same `viewModeEnabled`
 * prop: the "View | Edit" toggle (boardMode state + BoardModeToggle
 * below), a *preference* the user can flip at will, on top of the *permission*
 * `editable` already resolved above. See boardMode.ts's resolveViewModeEnabled
 * for how the two combine — `editable: false` always wins, so the toggle
 * (rendered only when `load.editable`) can never grant an edit a load didn't
 * already allow.
 */
export default function BoardCanvas({ pageId, shareToken, shareMode }: BoardCanvasProps) {
  const { t } = useTranslation('diagrams');
  const scheme = useColorScheme();
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const connectivity = useConnectivity();
  const [reloadTick, setReloadTick] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [showNewHint, setShowNewHint] = useState(false);
  // Mirrors apiRef below as React state rather than a plain ref, purely so
  // useHandleLibrary (whose own effect keys off this value — see its
  // [excalidrawAPI] dependency array in @excalidraw/excalidraw's source)
  // actually re-runs once Excalidraw mounts and hands us its imperative
  // API. apiRef stays the source of truth for every *imperative* read
  // (performSave, the autosave scheduler's getVersion, the remote-sync
  // effect) — those close over the ref intentionally so they don't need to
  // be rebuilt on every API change; this second copy exists only because a
  // ref mutation alone can't trigger the re-render useHandleLibrary's effect
  // (and the remote-sync/collaborators effects below) depend on.
  const [excalidrawApi, setExcalidrawApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [langCode, setLangCode] = useState(() => mapToExcalidrawLangCode(i18next.language));
  // Round 21 (DIAGRAMS): the board's own "View | Edit" toggle —
  // independent of `load.editable` (which is a *permission*, resolved from
  // the session/share-link; this is a *preference*, initialized once from
  // localStorage and never touched by a load/reload). resolveViewModeEnabled
  // combines the two for the actual prop Excalidraw gets, below.
  // Round 25b-1 §2: `initialBoardMode`, not `readStoredBoardMode` — on a
  // phone-sized viewport a board always opens in "View" regardless of
  // what the same person last chose at their desk (BOARD_MODE_KEY is one
  // global key shared by every screen). See boardMode.ts.
  const [boardMode, setBoardMode] = useState<BoardMode>(() => initialBoardMode());
  // Round 25b-1 §1: below Tailwind's `md` the whole chrome row collapses into
  // a single icon menu. Kept as reactive state (not a bare CSS breakpoint)
  // because the row's *composition* changes, not just its spacing — and
  // because the offset measurement below has to re-run when it flips.
  const [compact, setCompact] = useState<boolean>(isCompactViewport);
  // Round 21 follow-up (share-interference/export bug): Excalidraw's own
  // built-in "Export image" dialog (canvasActions.saveAsImage) saves PNG/SVG
  // through browser-fs-access -> the File System Access API, which the
  // owner reproduced failing *silently* (showSaveFilePicker exists, but
  // handle.createWritable() is rejected by the browser/platform policy).
  // BoardExportMenu below is our own reliable replacement (Blob + <a
  // download>, see download.ts) — the built-in dialog is hidden entirely
  // rather than left alongside it: there is no public prop to keep just its
  // "copy to clipboard" while disabling just its disk-save (that split only
  // exists for the *separate* .excalidraw-scene JSON export dialog, via
  // ExportOpts.saveFileToDisk on canvasActions.export — confirmed by reading
  // the installed package's own dist source; canvasActions.saveAsImage is a
  // plain boolean with no such option). Functionally nothing is lost: our
  // own menu covers PNG, SVG, *and* clipboard. Memoized because it's a
  // constant — canvasActions.saveAsImage never changes at runtime — not
  // because the memo comparator strictly requires it (its own areEqual
  // compares canvasActions key-by-key by value, not by object identity).
  const excalidrawUIOptions = useMemo(() => ({ canvasActions: { saveAsImage: false } }), []);

  // Measured, never guessed: how far our own floating chrome has to sit from
  // the canvas corners so it never covers one of Excalidraw's islands. See
  // boardChromeLayout.ts for why a CSS breakpoint can't answer this, and for
  // why `right` exists at all now (QA-3 finding №3: a tall strip pinned to
  // the right edge has to be dodged sideways, not chased downward). `right`
  // doubles as the horizontal offset for the "new board" hint below the
  // row — the hint tracks the row's own corner, never computes one of its
  // own, since it is always meant to sit flush under wherever the row ended
  // up.
  const [chromeOffsets, setChromeOffsets] = useState({
    top: CHROME_EDGE_GAP,
    right: CHROME_EDGE_GAP,
    hintTop: CHROME_EDGE_GAP + CHROME_ROW_FALLBACK_HEIGHT + CHROME_ISLAND_GAP,
    bottom: CHROME_EDGE_GAP,
  });

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chromeRowRef = useRef<HTMLDivElement | null>(null);
  const saveChipRef = useRef<HTMLDivElement | null>(null);
  const schedulerRef = useRef<AutosaveScheduler | null>(null);
  const initialVersionRef = useRef<number | null>(null);
  /** Pending unattended retry after a failed save — see AUTOSAVE_ERROR_RETRY_MS. Share path only. */
  const errorRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  // Owner report ("fit to screen / saving the zoom is missing"): true
  // exactly when the load effect just decided this page has no saved
  // viewport yet AND has real content to look at — the only case where an
  // automatic fit-to-screen (rather than a restored scroll/zoom, already
  // folded into initialData.appState via applyStoredViewport) makes sense.
  // Consumed by the effect below once excalidrawApi is available, then reset
  // to false so it never re-fires from an unrelated re-render.
  const fitToScreenPendingRef = useRef(false);
  // One persister per mounted instance — safe because BoardCanvas is scoped
  // to exactly one pageId for its whole lifetime (see the module docblock);
  // pageId never changes under an existing instance, only reloadTick does,
  // which this persister doesn't need to know about.
  const viewportPersisterRef = useRef<ViewportPersister | null>(null);
  if (viewportPersisterRef.current === null) {
    viewportPersisterRef.current = createViewportPersister(pageId, VIEWPORT_SAVE_DELAY_MS);
  }
  /** path/title fetched independently of the collab scene (see the metadata effect below) — read once by the ready-builder effect, in case it resolves before the Y.Doc has synced. */
  const metaRef = useRef({ path: '', title: '' });
  /**
   * Collab path only — mirrors the official client's own
   * `lastBroadcastedOrReceivedSceneVersion`. Two writers, one gate:
   *  - onChange (below) only writes this tab's scene into the Y.Doc when its
   *    version has grown past this ref, then bumps the ref to match.
   *  - the remote-apply effect sets this ref to the RECONCILED version
   *    BEFORE calling updateScene, so the onChange that call triggers
   *    (captureUpdate: NEVER keeps it out of local undo history, but
   *    Excalidraw still fires onChange) sees "nothing new to broadcast" and
   *    skips the write — without this, a just-received remote edit would
   *    otherwise be echoed straight back into the Y.Map on the next tick.
   * Deliberately starts (and stays, until real traffic moves it) at 0 rather
   * than being seeded from the just-loaded scene's version — see the
   * scheduler-building effect below for why seeding it from
   * `load.initialData.elements` specifically is unsafe.
   */
  const lastSyncedSceneVersionRef = useRef<number>(0);
  /** Collab path only — throttles cursor broadcasts (CURSOR_SYNC_TIMEOUT); built/torn down alongside the session below. */
  const pointerPublisherRef = useRef<ReturnType<typeof throttledPointerPublisher> | null>(null);
  /** Collab path only — coalesces rapid local element writes (see createThrottledElementsWriter's own docblock); built/torn down alongside the session below. */
  const elementsWriterRef = useRef<ThrottledElementsWriter | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Round 29 made boards live over the collab socket, but a share link stayed
  // on the old GET/PUT path — so a board opened by link joined no room at all:
  // no guests in presence, no guest cursors, and every change travelled by
  // autosave + refetch instead of the socket (owner, 15.09: "with an external
  // link anonymous users and their cursors are not visible, the delay is very big").
  // server/collab.ts has admitted `?share=<token>` on `/collab` for a while
  // (editor for an edit link, read-only viewer otherwise) — documents and
  // tables already used it. Boards now do too; the share fetch below is kept
  // only for what the socket can't tell us: whether the link is valid, and
  // its mode, path and title.
  const useCollab = true;
  const collabUrl = useMemo(() => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`, []);
  const collabParams = useMemo(() => (shareToken ? { share: shareToken } : undefined), [shareToken]);
  // Declared BEFORE the session hook on purpose: on unmount React runs effect
  // cleanups in declaration order, and the session's own cleanup closes the
  // Y.Doc's persistence (and the socket). The still-pending throttled write —
  // the last <250ms of drawing — has to reach the doc while both are still
  // attached, or a stroke made just before navigating away is lost; offline it
  // would be lost for good, because nothing else holds it. The writer's own
  // cleanup further down flushes again (a no-op by then) for a session change.
  useEffect(() => () => elementsWriterRef.current?.flush(), []);
  // The page's space, as soon as this component learns it (the registry for a
  // local board, the metadata fetch for a server one). It is not needed to
  // open the session — only to file an edit made while the socket is down in
  // the unsynced-pages list — so the session reads it lazily and a late
  // answer never rebuilds it.
  const [pageSpace, setPageSpace] = useState<string | undefined>(undefined);
  const session = useBoardCollabSession(pageId, collabUrl, collabParams, pageSpace);
  /** Share link only: what the share endpoint said about the link — null until it answers. */
  const [shareAccess, setShareAccess] = useState<{ editable: boolean; path: string; title: string } | null>(null);
  // Fix/share-identity: a share-link visitor who's ALSO logged in (session
  // cookie present) may have a real role on this exact page — one the
  // collab socket already honours over the link's own static mode (see
  // server/collab.ts's attachToServer: session wins whenever it grants at
  // least viewer access). Without asking, this component could only guess
  // editability from the share link's mode, and would show full editing
  // affordances for a tab the server is silently dropping every write from
  // (or, in reverse, lock out someone whose real permissions exceed a
  // view-only link). `sessionUser` is null for a genuine anonymous guest —
  // no point spending a round trip asking for a role that can't exist.
  const sessionUser = useOptionalSessionUser();
  const [mySessionRole, setMySessionRole] = useState<SpaceRole | null | 'unknown'>('unknown');
  const synced = useBoardSynced(session);
  const connectionStatus = useBoardConnectionStatus(session);
  const peers = useBoardPeers(session);
  // Round (page presence): a share-link viewer never reaches this component
  // (BoardEditor.tsx / PageContent.tsx — viewers get StaticBoardView instead,
  // no collab session at all), so presence here only ever covers editors —
  // same pre-existing gap as the board's own peer cursors above.
  // Emoji reactions (reactionsModel.ts, Y.Map `reactions`): who is reacting, and the names known for tooltips.
  // A signed-in user reacts under their real id (stable across devices); an anonymous
  // share-link guest under their per-browser guest identity.
  const reactionUserId = useMemo(
    () => session?.user.id ?? sessionUser?.id ?? `guest:${session?.user.name ?? anonUser().name}`,
    [session, sessionUser],
  );
  const reactionNames = useMemo(() => {
    const out: Record<string, string> = {};
    for (const peer of peers) if (peer.user.id) out[peer.user.id] = peer.user.name;
    return out;
  }, [peers]);
  const presencePeople = usePagePresence(session?.awareness ?? null, session?.user ?? null);
  usePublishPagePresence(presencePeople);

  // Live language switching (round 18): Folio's language switcher calls
  // i18next.changeLanguage() with no page reload, so the board's own UI
  // (toolbar/menus/dialogs — everything langCode drives) has to pick that
  // up the same way every other zone's i18n does: subscribe once, keep the
  // mapped code in state, let the prop change do the rest (Excalidraw's own
  // App re-localizes on a langCode prop change — see its
  // componentDidUpdate — no remount needed on our end either).
  useEffect(() => {
    const handleLanguageChanged = (lng: string) => setLangCode(mapToExcalidrawLangCode(lng));
    i18next.on('languageChanged', handleLanguageChanged);
    return () => {
      i18next.off('languageChanged', handleLanguageChanged);
    };
  }, []);

  // Wires up Excalidraw's own "Browse libraries" flow: a redirect back from
  // libraries.excalidraw.com lands on this same page with #addLibrary=<url>
  // in the hash; this hook (a) checks for that hash on mount and again on
  // every hashchange, fetching and installing the referenced library, and
  // (b) hydrates + persists the sidebar's item list via folioLibraryAdapter
  // (localStorage, folio:-prefixed — see libraryPersistence.ts), which is
  // also where the three bundled preset libraries get folded in. A no-op
  // (its own effect body bails out immediately) while excalidrawAPI is null
  // — i.e. during 'loading'/'error', when <Excalidraw> isn't even mounted —
  // and, as of Round 21, also while the board is only being viewed:
  //
  // Round 21 share-interference investigation: this hook's own mount effect
  // (see the installed package's dist/dev/index.js — useHandleLibrary calls
  // `promiseTry(AdapterTransaction.getLibraryItems, adapter, "load")`
  // *synchronously*, inside the effect body, before wrapping the result in a
  // Promise) runs folioLibraryAdapter.load() — and therefore
  // getPresetLibraryItems()'s one-time normalization of the three bundled
  // .excalidrawlib files — synchronously inside a passive-effect flush
  // triggered by Excalidraw mounting. Measured cost of that normalization
  // itself is negligible (~1ms of JSON parsing for ~48 items/~330 elements
  // total — nowhere near a "suffocator" on its own), but it's still real,
  // avoidable work with a real synchronous entry point into a passive-effect
  // flush, and it served no purpose at all in view mode anyway: view mode
  // hides every Excalidraw toolbar/panel (DEV-PLAN Round 21), including the
  // library sidebar this hydration exists for — there is no UI in view mode
  // that could ever read these items. Gating it to `isEditingNow` means a
  // board opened in the new default "View" (or any non-editable share
  // view) never pays this cost at all; switching to "Edit" flips
  // `excalidrawAPI` from null to the real value, which is exactly the
  // dependency this hook's own effect already keys off (see the comment on
  // the excalidrawApi state above), so hydration then runs right on cue —
  // no new mechanism, just reusing the null/non-null gate this hook already
  // treats as "Excalidraw isn't there yet".
  const isEditingNow = load.status === 'ready' && !resolveViewModeEnabled(boardMode, load.editable);
  /**
   * Whether this tab may write into the shared Y.Doc at all. Before boards
   * joined the room over share links this was implicitly always true (only an
   * editor ever had a session); a read-only share link now has one too, so the
   * two write paths below are gated explicitly. The server drops a viewer's
   * updates regardless (makeReadOnly in server/collab.ts) — this just keeps the
   * client from trying.
   */
  const canWrite = load.status === 'ready' && load.editable;
  useHandleLibrary({ excalidrawAPI: isEditingNow ? excalidrawApi : null, adapter: folioLibraryAdapter });

  // Resets everything that a fresh load needs a clean slate for. Runs first
  // among the load-related effects (declaration order = commit order for
  // effects sharing a render) so the fetch/collab effects below never race a
  // stale 'ready'/'error' from the PREVIOUS pageId into view.
  useEffect(() => {
    apiRef.current = null;
    setExcalidrawApi(null);
    setLoad({ status: 'loading' });
    setShowNewHint(false);
    fitToScreenPendingRef.current = false;
    metaRef.current = { path: '', title: '' };
    setPageSpace(undefined);
    setShareAccess(null);
    setMySessionRole('unknown');
  }, [pageId, shareToken, shareMode, reloadTick]);

  // Fix/share-identity: resolve the visitor's REAL role on this page, the
  // same way the collab socket itself will (session.effectivePageRole —
  // server/routes.ts's GET /api/pages/:id/my-role runs the exact same call
  // server/collab.ts's attachToServer uses for the WS upgrade). Skipped
  // entirely off the share path (editability there is unconditionally true
  // already) and for a confirmed-anonymous visitor (sessionUser === null) —
  // neither has a role to ask for. A 403/404/network failure resolves to
  // `null`: "no session access", exactly the fallback-to-share-link outcome
  // the server itself falls back to.
  useEffect(() => {
    if (!shareToken) {
      setMySessionRole(null);
      return;
    }
    // sessionUser undefined: GET /api/auth/state hasn't settled yet — stay
    // 'unknown' rather than guessing "anonymous" and locking that guess in
    // (the ready-snapshot effect below waits on 'unknown', but only runs
    // ONCE per page load, so a wrong-then-corrected value here would arrive
    // too late to fix load.editable).
    if (sessionUser === undefined) return;
    if (!sessionUser) {
      setMySessionRole(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/pages/${encodeURIComponent(pageId)}/my-role`);
        if (!res.ok) {
          if (!cancelled) setMySessionRole(null);
          return;
        }
        const body = (await res.json()) as { role?: SpaceRole | null };
        if (!cancelled) setMySessionRole(body.role ?? null);
      } catch {
        if (!cancelled) setMySessionRole(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pageId, shareToken, sessionUser, reloadTick]);

  // Share path (unchanged from round 8/21): load the board's current svg and
  // try to restore its embedded scene, exactly as before Round 29.
  useEffect(() => {
    if (!shareToken) return;
    let cancelled = false;

    const { loadUrl } = getBoardEndpoints({ pageId, shareToken });

    (async () => {
      let res: Response;
      try {
        // credentials intentionally left at the fetch default: the share
        // path is guest/public (no session assumed either way).
        res = await fetch(loadUrl);
      } catch {
        if (!cancelled) setLoad({ status: 'error', reason: 'failed' });
        return;
      }

      // Deliberately 404 (not 401/403) from the server for both "no such
      // token" and "token exists but wrong mode" — see server/routes.ts's
      // own comment on this. Either way it's not the app's session that's
      // bad, so never dispatch the app-wide unauthorized event here.
      if (res.status === 401 || res.status === 404) {
        if (!cancelled) setLoad({ status: 'error', reason: 'invalid-link' });
        return;
      }
      if (!res.ok) {
        if (!cancelled) setLoad({ status: 'error', reason: 'failed' });
        return;
      }

      let svg = '';
      let serverMode: ShareLinkMode | undefined;
      let path = '';
      let title = '';
      try {
        const payload = (await res.json()) as Partial<SharedPagePayload>;
        serverMode = payload.mode;
        svg = typeof payload.page?.svg === 'string' ? payload.page.svg : '';
        path = typeof payload.page?.path === 'string' ? payload.page.path : '';
        title = typeof payload.page?.title === 'string' ? payload.page.title : '';
      } catch {
        if (!cancelled) setLoad({ status: 'error', reason: 'failed' });
        return;
      }

      // Editable only if BOTH the caller-supplied shareMode prop AND the
      // server's own resolved mode say 'edit' — a caller passing the wrong
      // prop degrades to read-only, never the other way around. The scene
      // itself is NOT built from `svg` any more: it comes from the collab
      // room below, same as a signed-in board, so it is live from frame one.
      void svg;
      if (!cancelled) setShareAccess({ editable: shareMode === 'edit' && serverMode === 'edit', path, title });
    })();

    return () => {
      cancelled = true;
    };
  }, [pageId, shareToken, shareMode, reloadTick]);

  // Collab path (round 29): fetch just the page's identity — path/title for
  // export filenames, and a 401 check — completely decoupled from the SCENE,
  // which comes from the Y.Doc below. A failure here is best-effort only: it
  // never blocks 'ready' and never puts the board into an 'error' state (the
  // module docblock explains why) — path/title simply stay '' (exportFilename
  // already has a generic fallback for that), and a genuine 401 still bounces
  // the app back to login via reportUnauthorized().
  useEffect(() => {
    if (shareToken) return;
    // A board created offline is not on the server, so there is nothing to
    // fetch — and nothing that could fail: the registry holds everything the
    // response below would have carried (the registry is already read from
    // storage by now, PageContent waits for it before it mounts a page).
    const local = getLocalPage(pageId);
    if (local) {
      metaRef.current = { path: local.path, title: local.title };
      setPageSpace(local.space);
      setLoad((prev) => (prev.status === 'ready' ? { ...prev, path: local.path, title: local.title } : prev));
      return;
    }
    let cancelled = false;
    const { loadUrl } = getBoardEndpoints({ pageId });

    (async () => {
      let res: Response;
      try {
        res = await fetch(loadUrl);
      } catch {
        return;
      }
      if (cancelled) return;
      if (res.status === 401) {
        reportUnauthorized();
        return;
      }
      if (!res.ok) return;
      try {
        const doc = (await res.json()) as Partial<PageDoc>;
        if (cancelled) return;
        const path = typeof doc.path === 'string' ? doc.path : '';
        const title = typeof doc.title === 'string' ? doc.title : '';
        metaRef.current = { path, title };
        if (typeof doc.space === 'string') setPageSpace(doc.space);
        // Metadata can arrive after the scene is already 'ready' (it races
        // the Y.Doc's own sync) — fold it in then too, not just at build time.
        setLoad((prev) => (prev.status === 'ready' ? { ...prev, path, title } : prev));
      } catch {
        /* best-effort — never blocks the board */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pageId, shareToken, reloadTick]);

  // A board created offline reached the server: its session connects by itself
  // (boardCollab.ts). All that changes here is what the registry answered with
  // — the provisional path is replaced by the real one, which names exports.
  useEffect(() => {
    if (shareToken || !pageId) return;
    return onLocalPageSynced(pageId, (meta) => {
      metaRef.current = { path: meta.path, title: meta.title };
      setPageSpace(meta.space);
      setLoad((prev) => (prev.status === 'ready' ? { ...prev, path: meta.path, title: meta.title } : prev));
    });
  }, [pageId, shareToken]);

  // Collab path: build the ONE initial scene snapshot from the Y.Doc, the
  // moment its first sync completes — never before (an unsynced room reads
  // as empty, and writing THAT back out would be exactly the "empty scene
  // overwrites a real file" bug this whole contract exists to prevent; the
  // server has its own guard against it too, but there's no reason to ever
  // feed Excalidraw a scene we know is a lie). Guarded on `load.status ===
  // 'loading'` so later Y.Doc traffic (reconciled through the separate
  // remote-sync effect below, imperatively) never re-triggers this.
  useEffect(() => {
    if (!session || !synced) return;
    if (load.status !== 'loading') return;
    // A share link waits for its own verdict — building a scene before we know
    // the link is valid (or read-only) would render something we may be about
    // to replace with an error, or make editable what isn't. Fix/share-identity:
    // also wait on mySessionRole ('unknown' until GET .../my-role settles, one
    // way or the other) — this effect only ever runs ONCE per page load (see
    // the load.status guard above), so building `editable` from a premature
    // guess here would never get corrected once the real answer arrives.
    if (shareToken && (!shareAccess || mySessionRole === 'unknown')) return;

    const elements = orderedElementsFromMap(session.elements);
    const boardFields = boardFieldsFromMap(session.board);
    const files = filesFromMap(session.files);
    const storedViewport = readStoredViewport(pageId);
    const appState = applyStoredViewport(
      boardFields.viewBackgroundColor !== undefined ? { viewBackgroundColor: boardFields.viewBackgroundColor } : {},
      storedViewport,
    );
    fitToScreenPendingRef.current = !storedViewport && elements.length > 0;
    // Fix/share-identity: a real granted role (mySessionRole is 'viewer'/
    // 'editor'/'admin', not null) means the SESSION has actual access to
    // this page — it governs editability outright, exactly as
    // server/collab.ts's WS gate now does (session wins over the link's own
    // mode whenever it grants at least viewer access). `null` means no
    // session access at all (including a genuinely anonymous visitor): the
    // link's own resolved mode is the only grant there is, same as before.
    const editable = shareToken
      ? mySessionRole && mySessionRole !== 'unknown'
        ? mySessionRole === 'editor' || mySessionRole === 'admin'
        : shareAccess!.editable
      : true;
    setLoad({
      status: 'ready',
      initialData: { elements, appState, files: files as unknown as ExcalidrawInitialDataState['files'] },
      isNew: elements.length === 0,
      editable,
      path: shareToken ? shareAccess!.path : metaRef.current.path,
      title: shareToken ? shareAccess!.title : metaRef.current.title,
    });
  }, [shareToken, shareAccess, mySessionRole, session, synced, load.status, pageId]);

  // Collab path: a Y.Map change that did NOT originate from this tab's own
  // write below (BOARD_LOCAL_ORIGIN) gets reconciled into the live
  // Excalidraw scene, following the SAME contract excalidraw-app's own
  // collaboration client (Collab.tsx) applies a remote update with:
  //  1. `restoreElements` repairs whatever fields a bare wire payload is
  //     missing before reconciliation ever sees it.
  //  2. `reconcileElements` — @excalidraw/excalidraw's own public helper, the
  //     same one excalidraw.com's collaboration mode uses — decides winners
  //     ("bigger version wins, tie-break versionNonce, never yank an element
  //     out from under an active local edit", read off the LIVE appState so
  //     an in-progress local drag is never disrupted).
  //  3. The version barrier (lastSyncedSceneVersionRef) is armed with the
  //     reconciled scene's version BEFORE updateScene runs — see the ref's
  //     own comment for why the ordering matters.
  //  4. `captureUpdate: CaptureUpdateAction.NEVER` — the single most
  //     important line in this whole effect. Without it, Excalidraw treats
  //     an applied remote edit as if the LOCAL user made it: it lands in
  //     local undo history (a peer's edit becomes undoable by Ctrl+Z on a
  //     machine that never made it) and re-enters the Store's own change
  //     pipeline as a "local" commit, which is what actually produced the
  //     "everything jumps, things appear and disappear" symptom this whole fix
  //     exists for — not a rendering bug, a contract violation.
  useEffect(() => {
    if (!useCollab || !session || !excalidrawApi) return;

    const onElementsEvent = (event: Y.YMapEvent<unknown>) => {
      if (event.transaction.origin === BOARD_LOCAL_ORIGIN) return;
      const local = excalidrawApi.getSceneElementsIncludingDeleted();
      const remoteRaw = orderedElementsFromMap(session.elements);
      const remote = restoreElements(
        remoteRaw as unknown as Parameters<typeof restoreElements>[0],
        local,
      );
      const reconciled = reconcileElements(
        local,
        remote as unknown as Parameters<typeof reconcileElements>[1],
        excalidrawApi.getAppState(),
      );
      // Armed BEFORE updateScene: the call below triggers Excalidraw's own
      // onChange synchronously (captureUpdate: NEVER keeps it out of local
      // undo history, but onChange itself still fires), and that onChange's
      // own version-barrier check (below) needs the bar already raised to
      // recognize "this is the update we just received", not something new
      // to broadcast back.
      lastSyncedSceneVersionRef.current = getSceneVersion(reconciled);
      excalidrawApi.updateScene({
        elements: reconciled,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    };
    const onBoardEvent = (event: Y.YMapEvent<unknown>) => {
      if (event.transaction.origin === BOARD_LOCAL_ORIGIN) return;
      const fields = boardFieldsFromMap(session.board);
      if (fields.viewBackgroundColor !== undefined) {
        excalidrawApi.updateScene({
          appState: { viewBackgroundColor: fields.viewBackgroundColor },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
    };
    const onFilesEvent = (event: Y.YMapEvent<unknown>) => {
      if (event.transaction.origin === BOARD_LOCAL_ORIGIN) return;
      const added: BinaryFileData[] = [];
      for (const key of event.keysChanged) {
        const change = event.changes.keys.get(key);
        if (change && change.action !== 'delete') {
          const file = session.files.get(key);
          if (file) added.push(file as BinaryFileData);
        }
      }
      if (added.length > 0) excalidrawApi.addFiles(added);
    };

    session.elements.observe(onElementsEvent);
    session.board.observe(onBoardEvent);
    session.files.observe(onFilesEvent);
    return () => {
      session.elements.unobserve(onElementsEvent);
      session.board.unobserve(onBoardEvent);
      session.files.unobserve(onFilesEvent);
    };
  }, [useCollab, session, excalidrawApi]);

  // Collab path: reflect every OTHER peer's cursor through Excalidraw's own
  // `collaborators` appState (the same mechanism the package's own
  // multiplayer demo uses), so peers show up with the same name/colour
  // people already know from documents and tables.
  useEffect(() => {
    if (!useCollab || !excalidrawApi) return;
    const collaborators = new Map<SocketId, Collaborator>();
    for (const peer of peers) {
      collaborators.set(String(peer.clientId) as SocketId, {
        id: String(peer.clientId),
        username: peer.user.name,
        color: { background: peer.user.color, stroke: peer.user.color },
        // tool + button are what make Excalidraw draw a peer's LASER trail
        // instead of a plain cursor — hardcoding `tool: 'pointer'` here is
        // exactly why the laser never showed up for anyone else (15.09).
        pointer: peer.cursor ? { x: peer.cursor.x, y: peer.cursor.y, tool: peer.cursor.tool } : undefined,
        button: peer.cursor?.button,
      });
    }
    excalidrawApi.updateScene({ collaborators });
  }, [useCollab, excalidrawApi, peers]);

  // Collab path: one throttled cursor publisher per live session (see
  // throttledPointerPublisher's own docblock for why a raw publish-per-
  // pointermove was part of the "everything jumps" symptom) — torn down and
  // rebuilt whenever the session itself changes, and cancelled on unmount so
  // no trailing call fires against a destroyed session.
  useEffect(() => {
    if (!useCollab || !session) {
      pointerPublisherRef.current = null;
      return;
    }
    const publisher = throttledPointerPublisher(session);
    pointerPublisherRef.current = publisher;
    return () => {
      publisher.cancel();
      pointerPublisherRef.current = null;
    };
  }, [useCollab, session]);

  // Collab path: one throttled elements writer per live session — see
  // createThrottledElementsWriter's own docblock for the reliability gap
  // this closes. Flushed (not just cancelled) on teardown: a still-pending
  // write at that point is a real edit the user just made, not stale noise,
  // so it commits to this tab's own Y.Doc immediately rather than being
  // dropped — the periodic full-scene resync effect below would eventually
  // repair a lost one anyway, but there is no reason to ever rely on that
  // for an edit already known to be at hand.
  useEffect(() => {
    if (!useCollab || !session) {
      elementsWriterRef.current = null;
      return;
    }
    const writer = createThrottledElementsWriter(session.doc, session.elements, ELEMENTS_WRITE_THROTTLE_MS);
    elementsWriterRef.current = writer;
    return () => {
      writer.flush();
      elementsWriterRef.current = null;
    };
  }, [useCollab, session]);

  // Collab path: periodic full-scene resync (SYNC_FULL_SCENE_INTERVAL_MS),
  // same self-heal the official multiplayer client runs — pushes this tab's
  // entire current scene through writeElementsToMap again, which is a no-op
  // for anything already in sync and only actually writes what genuinely
  // drifted (a dropped frame, a missed observer callback).
  useEffect(() => {
    if (!useCollab || !session || !excalidrawApi || !canWrite) return;
    const interval = setInterval(() => {
      const api = apiRef.current;
      if (!api) return;
      applyLocalElements(session.doc, session.elements, api.getSceneElementsIncludingDeleted());
    }, SYNC_FULL_SCENE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [useCollab, session, excalidrawApi, canWrite]);

  async function performSave(): Promise<void> {
    const api = apiRef.current;
    if (!api) return;
    // Share path only — the collab path never builds this scheduler (see
    // the effect below), so this function is structurally unreachable there.
    if (load.status !== 'ready' || !load.editable) return;
    // A fresh attempt (manual retry, the next debounced save, or the
    // unattended retry below) supersedes any earlier one still pending.
    if (errorRetryTimerRef.current !== null) {
      clearTimeout(errorRetryTimerRef.current);
      errorRetryTimerRef.current = null;
    }
    const { saveUrl } = getBoardEndpoints({ pageId, shareToken });
    if (mountedRef.current) setSaveState('saving');
    try {
      const elements = api.getSceneElements();
      const appState = api.getAppState();
      const files = api.getFiles();
      const svgElement = await exportToSvg({
        elements,
        appState: { ...appState, exportBackground: true, exportEmbedScene: true },
        files,
      });
      const res = await fetch(saveUrl, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ svg: svgElement.outerHTML }),
      });
      if (shareToken) {
        if (res.status === 401 || res.status === 404) {
          // The link was revoked/expired mid-session (or never was edit-mode
          // — same status either way, see the load effect's comment). Tell
          // the user plainly instead of quietly failing every autosave from
          // here on; there is no app session to bounce them back to.
          if (mountedRef.current) setSaveState('invalid-link');
          return;
        }
      }
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      if (mountedRef.current) {
        setSaveState('saved');
        setLastSavedAt(new Date());
      }
    } catch {
      if (mountedRef.current) {
        setSaveState('error');
        // Don't strand the scene on the manual retry button alone — this was
        // very plausibly a transient 502/503/504 from a PaaS redeploy window
        // (see api.ts's own retry for the same class of error), and if this
        // failed save was the user's last edit there may be no future
        // onChange to trigger the scheduler's own retry-on-next-change path.
        errorRetryTimerRef.current = setTimeout(() => {
          errorRetryTimerRef.current = null;
          void performSave();
        }, AUTOSAVE_ERROR_RETRY_MS);
      }
    }
  }

  // Switching to "View" must never leave an edit stranded unsaved on the
  // share path: flush any debounced autosave immediately (the same call the
  // unmount cleanup below makes) instead of letting the remaining ~1.5s of
  // the normal debounce play out later, invisibly, after the toolbar is
  // already hidden and the user believes they're done. A no-op if nothing
  // changed since the last save, and a no-op outright on the collab path
  // (schedulerRef is never built there — every edit already landed in the
  // Y.Doc synchronously, nothing to flush).
  function selectBoardMode(next: BoardMode): void {
    if (next === 'view') schedulerRef.current?.flush();
    setBoardMode(next);
    // `compact` passed explicitly rather than left to storeBoardMode's own
    // matchMedia default, so the write and the read (initialBoardMode, via
    // this component's `compact` state) can never disagree about which
    // viewport we are on.
    storeBoardMode(next, compact);
  }

  /**
   * Owner report — the explicit half of "fit to screen": Excalidraw's own
   * bottom-left zoom cluster only ever renders zoomOut/resetZoom(100%)/
   * zoomIn (confirmed by reading the installed package's own ZoomActions
   * component); zoom-to-fit exists in the library only as a Shift+1 shortcut
   * with no visible button, easy to never discover. This button — always
   * shown once the board is 'ready', in both view and edit mode, same
   * reasoning as the export menu above (framing the view doesn't need edit
   * permission) — calls the same library API the automatic on-load fit uses.
   * `animate: true` here (unlike the silent on-load fit) because this is a
   * deliberate, visible user action — a smooth pan/zoom reads as "yes, that
   * worked", not as unwanted motion the way it would on first paint.
   */
  function fitBoardToScreen(): void {
    const api = apiRef.current;
    if (!api || load.status !== 'ready') return;
    if (api.getSceneElements().length === 0) return; // nothing to fit — avoid feeding zoomToFit an empty scene
    api.scrollToContent(undefined, { fitToViewport: true, animate: true });
  }

  /**
   * Miro-style sticky notes (owner request). Inserts a single opaque
   * rectangle centred on `scenePoint`, then opens it for text entry
   * immediately — no "draw a rectangle, then double-click it" step.
   *
   * Insertion: `getSceneElementsIncludingDeleted`, not `getSceneElements` —
   * dropping a tombstone here would resurrect an element another peer just
   * deleted (see boardYdoc.ts's own contract for why every write in this file
   * reads/writes the IncludingDeleted set). `onChange` (already wired below)
   * picks the update up and pushes it into the Y.Doc exactly like any other
   * local edit — no separate sync path needed for stickies.
   *
   * Text entry: the imperative API has no "start editing this container's
   * text" method. The package's OWN way of doing it — confirmed by reading
   * the installed 0.18.1's dist source — is `handleCanvasDoubleClick`: on a
   * real dblclick over an opaque-fill container (with the selection tool
   * active and not in view mode) it calls `startTextEditing` at the
   * container's centre, which creates the bound text element and focuses it.
   * That handler is wired as the interactive canvas's own `onDoubleClick`
   * (`canvas.excalidraw__canvas.interactive` — the one that receives pointer
   * events, as opposed to the static/new-element canvases layered under it),
   * so dispatching a genuine `dblclick` MouseEvent at the note's own screen
   * centre reaches the exact same code path a real user double-click would.
   * Two animation frames are given first so the just-inserted rectangle has
   * actually been committed to Excalidraw's own scene AND painted — the
   * hit-test (`getTextBindableContainerAtPosition`) needs the element to
   * really be there, not just have been requested a moment ago.
   */
  function insertStickyNote(colorId: StickyNoteColorId, scenePoint: { x: number; y: number }): void {
    const api = apiRef.current;
    if (!api || !canWrite) return;
    const [sticky] = createStickyNoteElements(colorId, scenePoint);
    if (!sticky) return;
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), sticky] });
    // Selection, not whatever tool happened to be active — handleCanvasDoubleClick
    // only starts text editing when `activeTool.type === 'selection'`.
    api.setActiveTool({ type: 'selection' });
    const { clientX, clientY } = sceneToScreenCoords(scenePoint, api.getAppState());
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const canvas = containerRef.current?.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas.interactive');
        canvas?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX, clientY }));
      });
    });
  }

  /** Plain click on a palette swatch (no drag) — centre of the currently visible viewport, same spot `fitBoardToScreen` frames. */
  function insertStickyNoteAtViewportCenter(colorId: StickyNoteColorId): void {
    const api = apiRef.current;
    if (!api) return;
    const appState = api.getAppState();
    const center = screenToSceneCoords(
      appState.offsetLeft + appState.width / 2,
      appState.offsetTop + appState.height / 2,
      appState,
    );
    insertStickyNote(colorId, center);
  }

  /** Palette swatch dragged over the board — only ever needs preventDefault to become a valid drop target; see handleStickyDrop for the actual insert. */
  function handleStickyDragOver(event: DragEvent<HTMLDivElement>): void {
    if (!canWrite) return;
    if (!event.dataTransfer.types.includes(STICKY_NOTE_DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  /** Palette swatch dropped on the board — insert centred on the drop point (screen -> scene via the appState the drop itself lands under). */
  function handleStickyDrop(event: DragEvent<HTMLDivElement>): void {
    if (!canWrite) return;
    const colorId = event.dataTransfer.getData(STICKY_NOTE_DRAG_MIME) as StickyNoteColorId;
    if (!colorId) return;
    event.preventDefault();
    const api = apiRef.current;
    if (!api) return;
    const point = screenToSceneCoords(event.clientX, event.clientY, api.getAppState());
    insertStickyNote(colorId, point);
  }

  /**
   * The AUTOMATIC half of "fit to screen by default" (QA-3 finding №2).
   *
   * This used to hang off an effect keyed on `excalidrawApi`, on the
   * assumption that "Excalidraw handed us its imperative API" means
   * "Excalidraw has a scene". It does not, and the feature was dead in the
   * browser for that entire time: the package calls `excalidrawAPI(api)`
   * from its App **constructor** (see the installed 0.18.1's dist source),
   * whereas `initialData` is only resolved later and asynchronously in
   * `initializeScene`, from componentDidMount. The effect therefore always
   * ran against an empty scene, hit its own `elements.length === 0` guard —
   * having already cleared the pending flag one line earlier — and, with
   * `[excalidrawApi]` as its only dependency, never got a second chance.
   * Measured on a cold load (viewport storage cleared, 4-element board,
   * three runs): zoom stayed at 100% while the manual button on the same
   * scene gave 280%.
   *
   * So the trigger now waits for the scene ITSELF rather than for the API
   * object: onChange is Excalidraw's own "the scene or appState changed"
   * signal, and it carries both the elements and the appState whose
   * width/height are exactly what `scrollToContent({ fitToViewport })`
   * measures against — a zero there (Excalidraw's pre-layout default) would
   * produce a garbage zoom, so it gates the call too. Deferred one frame
   * because onChange fires from inside Excalidraw's own componentDidUpdate;
   * scrolling the scene from there would re-enter its state update during
   * its own commit.
   *
   * A stored viewport still wins outright — the load effects only ever arm
   * fitToScreenPendingRef when there is none (see applyStoredViewport).
   */
  function autoFitOnFirstScene(elements: readonly unknown[], appState: { width: number; height: number }): void {
    if (!fitToScreenPendingRef.current) return;
    if (elements.length === 0) return; // scene hasn't landed yet (or is genuinely empty) — keep waiting
    if (appState.width <= 0 || appState.height <= 0) return; // canvas not measured yet — zoomToFit would divide by nothing
    fitToScreenPendingRef.current = false;
    requestAnimationFrame(() => {
      // `animate: false` (unlike the button): this is first paint, not a
      // deliberate user action — the board should simply already be framed.
      apiRef.current?.scrollToContent(undefined, { fitToViewport: true, animate: false });
    });
  }

  /**
   * Shared appState override for all three export actions below: white
   * background always — including in Folio's own dark theme, agreed with
   * the owner — and never Excalidraw's dark-mode color-inversion filter,
   * which exists purely for *viewing* the canvas comfortably and has
   * nothing to do with what an exported picture should look like.
   */
  function exportAppState(current: ReturnType<ExcalidrawImperativeAPI['getAppState']>) {
    return { ...current, exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false };
  }

  /**
   * Round 21 follow-up — BoardExportMenu's PNG action. Replaces Excalidraw's
   * built-in "Export image" dialog: that dialog saves through
   * browser-fs-access -> the File System Access API, which the owner
   * reproduced failing silently (`createWritable` rejected by the
   * browser/platform) even though `showSaveFilePicker` itself is present.
   * exportToBlob + our own downloadBlob (Blob + <a download>) never touches
   * that API at all. 2x scale per DEV-PLAN; see UIOptions below for why the
   * built-in dialog is hidden instead of living on alongside this one.
   */
  async function exportBoardPng(): Promise<void> {
    const api = apiRef.current;
    if (!api || load.status !== 'ready') throw new Error('board not ready to export');
    const blob = await exportToBlob({
      elements: api.getSceneElements(),
      appState: { ...exportAppState(api.getAppState()), exportScale: 2 },
      files: api.getFiles(),
      mimeType: MIME_TYPES.png,
    });
    downloadBlob(blob, exportFilename({ path: load.path, title: load.title }, 'png'));
  }

  /**
   * BoardExportMenu's SVG action — same rationale as exportBoardPng.
   * exportEmbedScene: true so the downloaded file embeds the real scene
   * (same mechanism performSave already relies on above), meaning it can be
   * dragged back into Excalidraw *or* re-opened as a Folio board later —
   * not just a static picture.
   */
  async function exportBoardSvg(): Promise<void> {
    const api = apiRef.current;
    if (!api || load.status !== 'ready') throw new Error('board not ready to export');
    const svgElement = await exportToSvg({
      elements: api.getSceneElements(),
      appState: { ...exportAppState(api.getAppState()), exportEmbedScene: true },
      files: api.getFiles(),
    });
    const blob = new Blob([svgElement.outerHTML], { type: 'image/svg+xml' });
    downloadBlob(blob, exportFilename({ path: load.path, title: load.title }, 'svg'));
  }

  /**
   * BoardExportMenu's "copy to clipboard" action — kept alongside our own
   * PNG/SVG download so hiding Excalidraw's built-in image-export dialog
   * (UIOptions below) doesn't take away the one part of it that reliably
   * worked (clipboard writes don't go through the File System Access API
   * this whole fix exists because of). PNG, matching what the built-in
   * dialog's own clipboard button copies.
   */
  async function copyBoardToClipboard(): Promise<void> {
    const api = apiRef.current;
    if (!api || load.status !== 'ready') throw new Error('board not ready to export');
    await exportToClipboard({
      elements: api.getSceneElements(),
      appState: exportAppState(api.getAppState()),
      files: api.getFiles(),
      type: 'png',
    });
  }

  // (Re)build the autosave scheduler once the initial scene is known, seeded
  // with its version so Excalidraw's initial onChange "echo" isn't saved.
  // Round 29: only the SHARE path (`!useCollab`) ever builds this scheduler
  // at all — the collab path writes straight to the Y.Doc from onChange
  // below and has nothing to debounce a PUT for. This effect only ever runs
  // off a 'ready' state, so a failed share-path load can't arm it; the
  // scheduler's own version gate then further ensures a remount with zero
  // real edits never calls save() at all. A view-mode (or mode-mismatched)
  // share load is 'ready' but not editable — no scheduler at all in that
  // case, same "never build the thing that could PUT" idea applied one level
  // up.
  useEffect(() => {
    if (load.status !== 'ready') return;
    const initialVersion = getSceneVersion(load.initialData.elements ?? []);
    initialVersionRef.current = initialVersion;
    // Collab path: deliberately NOT seeding lastSyncedSceneVersionRef from
    // `initialVersion` here — that number is computed from the RAW Y-Map
    // snapshot (load.initialData.elements), before Excalidraw's own internal
    // restore/normalize pass has had a chance to run on it. When that pass
    // drops anything (e.g. an "invisibly small" width:0/height:0 element —
    // a real Excalidraw contract, not a bug), the LOCAL scene's own version
    // sum permanently undershoots this seed, and the barrier — which only
    // ever compares against the LOCAL scene's own reported version — can
    // never clear it again: every future edit, however real, reads as "not
    // past the bar" and silently never reaches the Y.Doc. Leaving the ref at
    // its 0 default is safe: the first onChange after mount (reporting the
    // as-actually-restored local scene) always clears 0, and re-writing an
    // unchanged scene once is a harmless no-op (writeElementsToMap's own
    // per-element version dedupe skips it) — see boardYdoc.ts.
    setShowNewHint(load.isNew && load.editable);
    if (!load.editable || useCollab) {
      schedulerRef.current = null;
      return;
    }
    schedulerRef.current = createAutosaveScheduler({
      delayMs: AUTOSAVE_DELAY_MS,
      getVersion: () => {
        const api = apiRef.current;
        return api ? getSceneVersion(api.getSceneElements()) : initialVersion;
      },
      save: () => void performSave(),
      initialVersion,
    });
    return () => {
      schedulerRef.current = null;
    };
    // performSave only closes over refs + the (stable for this instance's
    // lifetime) pageId prop, so it's intentionally left out of deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, useCollab]);

  // Best-effort flush of any pending save (and pending viewport write) on unmount.
  useEffect(() => {
    return () => {
      schedulerRef.current?.flush();
      viewportPersisterRef.current?.flush();
      if (errorRetryTimerRef.current !== null) {
        clearTimeout(errorRetryTimerRef.current);
        errorRetryTimerRef.current = null;
      }
    };
  }, []);

  // Round 25b-1 §1: keep `compact` in step with the viewport. Guarded for
  // environments without matchMedia at all (jsdom), where isCompactViewport()
  // already answered "desktop" and there is nothing to subscribe to.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(COMPACT_VIEWPORT_QUERY);
    const handleChange = () => setCompact(query.matches);
    handleChange();
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, []);

  /**
   * QA-3 finding №1 — measure, don't guess, where our own chrome may sit.
   *
   * Excalidraw's islands move with the container's width (the tool island is
   * centred), with the viewport (it has its own mobile layout), and with
   * nothing at all (the library trigger owns the top-right corner outright),
   * while OUR row's width moves with the interface language. The old
   * `top-3 max-md:top-16` guess was wrong on every laptop width for the tool
   * island and wrong at EVERY width for the library trigger. So: read the
   * real rects, push our chrome clear of them, and re-read whenever anything
   * that could move either side changes.
   *
   * useLayoutEffect, not useEffect, so the corrected offset is committed in
   * the same paint — a visible jump on every mode switch would be a worse
   * bug than the one being fixed. Excalidraw is a child, so its own DOM for
   * this render is already in place by the time this runs — but only for
   * whatever Excalidraw already decided to render synchronously. Switching
   * View↔Edit changes `viewModeEnabled`, and Excalidraw's own reaction to
   * that (showing/hiding `.App-toolbar-container`, `.mobile-misc-tools-
   * container`, …) can land in a LATER commit or a LATER frame than this
   * one — QA-3 finding №2's second half: the very first measurement after a
   * mode switch can read the PREVIOUS mode's obstacles (or none at all).
   * A MutationObserver on the container catches that: it fires whenever
   * Excalidraw's own subtree actually changes, however late, so the row
   * gets re-measured against what is truly on screen rather than what was
   * there one commit ago. It ignores mutations inside our OWN chrome (the
   * `style.top`/`style.right`/`style.bottom` this very effect writes) —
   * otherwise it would be reacting to its own output, which is exactly the
   * feedback loop the geometry in boardChromeLayout.ts is built to avoid.
   *
   * The re-measure itself is scheduled through requestAnimationFrame, paired
   * with a short setTimeout fallback: a HIDDEN tab (backgrounded, or — the
   * case actually observed — a dev-tool preview pane reporting
   * `document.visibilityState === 'hidden'`) never runs a queued rAF
   * callback at all, so a mode switch or a resize that lands while the tab
   * is hidden would otherwise sit unmeasured until something else happens to
   * trigger a fresh rAF later. Whichever of the two fires first runs the
   * actual measurement and cancels the other, so a normal (visible) tab
   * still gets exactly one recompute per schedule() call — the fallback
   * timer's only job is to be there for when rAF alone would never fire.
   */
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let frame = 0;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const measure = () => {
      const containerBox = container.getBoundingClientRect();
      const row = chromeRowRef.current;
      const chip = saveChipRef.current;
      const rowBox = row?.getBoundingClientRect();
      const { top, right } = rowBox
        ? topOffsetClearing(rowBox, collectObstacleRects(container, EXCALIDRAW_TOP_OBSTACLES), containerBox)
        : { top: CHROME_EDGE_GAP, right: CHROME_EDGE_GAP };
      const bottom = chip
        ? bottomOffsetClearing(
            chip.getBoundingClientRect(),
            collectObstacleRects(container, EXCALIDRAW_BOTTOM_OBSTACLES),
            containerBox,
          )
        : CHROME_EDGE_GAP;
      const hintTop = top + (rowBox?.height || CHROME_ROW_FALLBACK_HEIGHT) + CHROME_ISLAND_GAP;
      setChromeOffsets((prev) =>
        prev.top === top && prev.right === right && prev.bottom === bottom && prev.hintTop === hintTop
          ? prev
          : { top, right, bottom, hintTop },
      );
    };

    /** Runs `measure()` exactly once for this schedule() call, however it got triggered, and cancels whichever of the two pending triggers didn't fire. */
    const runScheduled = () => {
      frame = 0;
      if (fallbackTimer !== null) clearTimeout(fallbackTimer);
      fallbackTimer = null;
      measure();
    };

    // Re-measuring can only ever move our chrome along its own two axes, and
    // overlap is decided from its (horizontal, vertical) span at the
    // anchor's CURRENT position (boardChromeLayout.ts), so a measurement can
    // never invalidate itself — no observer feedback loop from the geometry
    // side. The DOM observers below guard the other possible loop: reacting
    // to the DOM writes THIS effect itself makes (see `isOwnChrome` below).
    // The `frame !== 0 || fallbackTimer !== null` guard coalesces a burst of
    // back-to-back triggers (several mutations in one tick, e.g.) into a
    // single pending recompute rather than queuing one per trigger.
    const schedule = () => {
      if (frame !== 0 || fallbackTimer !== null) return;
      if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(runScheduled);
      fallbackTimer = setTimeout(runScheduled, CHROME_MEASURE_FALLBACK_MS);
    };
    measure();
    schedule(); // second pass once Excalidraw's own islands have settled (fonts, async layout)

    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    // The container: catches the app sidebar opening/closing, which resizes
    // the canvas without ever firing a window resize. The row: catches its
    // own width changing with the interface language.
    observer?.observe(container);
    if (chromeRowRef.current) observer?.observe(chromeRowRef.current);
    window.addEventListener('resize', schedule);

    /** True for a mutation inside our OWN chrome (the row/chip this effect positions) — never a reason to re-measure. */
    const isOwnChrome = (node: Node): boolean => {
      const row = chromeRowRef.current;
      const chip = saveChipRef.current;
      return Boolean((row && (node === row || row.contains(node))) || (chip && (node === chip || chip.contains(node))));
    };
    const mutationObserver =
      typeof MutationObserver === 'function'
        ? new MutationObserver((mutations) => {
            if (mutations.some((mutation) => !isOwnChrome(mutation.target))) schedule();
          })
        : null;
    // subtree: Excalidraw mounts/unmounts and shows/hides its own islands
    // deep under `container`, not as direct children of it; attributes
    // covers the (more common) case of it toggling a class or inline style
    // on an island that already exists rather than adding/removing a node.
    mutationObserver?.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });

    return () => {
      observer?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener('resize', schedule);
      if (frame !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      if (fallbackTimer !== null) clearTimeout(fallbackTimer);
    };
    // `saveState`/`connectionStatus` are in here because the chip they
    // control is the bottom anchor: there is nothing to measure until it
    // actually renders.
  }, [load.status, boardMode, compact, langCode, excalidrawApi, saveState, connectionStatus]);

  if (load.status === 'loading') {
    // Offline a board that is not on this device is not «loading» — it
    // cannot load, and saying so is the honest answer (the owner,
    // 29.09.2026). It picks itself up when the connection returns.
    return (
      <div className="flex h-full w-full items-center justify-center p-6 text-center text-sm opacity-60">
        {t(connectivity === 'offline' ? 'board.unavailableOffline' : 'board.loading')}
      </div>
    );
  }

  if (load.status === 'error') {
    const reasonKey =
      load.reason === 'unauthorized'
        ? 'board.sessionExpired'
        : load.reason === 'invalid-link'
          ? 'board.invalidLink'
          : 'board.loadFailed';
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center text-sm">
        <p className="max-w-sm text-neutral-600 dark:text-neutral-400">{t(reasonKey)}</p>
        <button
          type="button"
          onClick={() => setReloadTick((tick) => tick + 1)}
          className="rounded border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          {t('board.reload')}
        </button>
      </div>
    );
  }

  // The chip this render actually shows: the collab path's connection state
  // once ready, the share path's REST save-cycle state otherwise. Computed
  // here (not stored) — it's a pure function of two already-tracked states,
  // and keeping it derived means there's no way for the two to disagree.
  const chipState: SaveState = useCollab
    ? connectionStatus === 'connected'
      ? 'connected'
      : connectionStatus === 'offline'
        ? 'offline'
        : 'connecting'
    : saveState;

  // Top-right, above the board (DEV-PLAN Round 21): the one spot Excalidraw's
  // own default UI leaves free (menu top-left, zoom bottom-left, help
  // bottom-right — see the save chip's own comment below on that last one).
  // One row below, both controls sharing it:
  //   - export menu: always shown once the board is 'ready', whether or not
  //     it's editable. Exporting a picture is read-only and doesn't need
  //     edit permission — restricting it to edit-only would be a regression
  //     from before Round 21, when the (only) export entry point was
  //     reachable any time the toolbar showed, i.e. always. A view-only
  //     share guest gets it too, same reasoning: they can already see the
  //     whole rendered board on screen, a clean export isn't a materially
  //     different boundary.
  //   - mode toggle: unchanged from Round 21 — only for a load that is
  //     actually editable. A view-only share guest has nothing to switch
  //     *to* (resolveViewModeEnabled already pins `editable: false` to view
  //     mode regardless of this toggle), so there is no toggle for them,
  //     consistent with the editor role never reaching this component at
  //     all (PageContent.tsx renders StaticBoardView for it instead).
  //   - fit-to-screen button: owner report follow-up, same "read-only,
  //     always shown" reasoning as the export menu — framing the view isn't
  //     an edit-permission concern, and a view-only guest benefits from it
  //     just as much (arguably more, since they have no toolbar of their own
  //     to work around a bad initial zoom with).
  return (
    <div ref={containerRef} className="relative h-full w-full" onDragOver={handleStickyDragOver} onDrop={handleStickyDrop}>
      <Excalidraw
        excalidrawAPI={(api) => {
          apiRef.current = api;
          setExcalidrawApi(api);
        }}
        initialData={load.initialData}
        theme={scheme === 'dark' ? THEME.DARK : THEME.LIGHT}
        viewModeEnabled={resolveViewModeEnabled(boardMode, load.editable)}
        UIOptions={excalidrawUIOptions}
        langCode={langCode}
        isCollaborating={useCollab}
        onPointerUpdate={
          useCollab && session
            ? (payload) =>
                pointerPublisherRef.current?.publish({
                  x: payload.pointer.x,
                  y: payload.pointer.y,
                  tool: payload.pointer.tool,
                  button: payload.button,
                })
            : undefined
        }
        onChange={(elements, appState, files) => {
          if (showNewHint && initialVersionRef.current !== null && getSceneVersion(elements) !== initialVersionRef.current) {
            setShowNewHint(false);
          }
          // The real scene has landed (or hasn't yet) — see the docblock on
          // autoFitOnFirstScene for why THIS, and not the arrival of the
          // imperative API, is the moment an automatic fit can happen.
          autoFitOnFirstScene(elements, appState);
          if (useCollab && session && canWrite) {
            // Tombstones matter (DEV-PLAN): read via the imperative API
            // rather than trusting onChange's own `elements` argument, so a
            // deleted element's isDeleted:true is never silently dropped
            // regardless of what this Excalidraw build happens to pass here.
            const api = apiRef.current;
            const sceneElements = api ? api.getSceneElementsIncludingDeleted() : elements;
            // Version barrier (see lastSyncedSceneVersionRef's own comment):
            // only write this tab's scene into the Y.Doc when it has
            // genuinely grown past the last version this tab either
            // broadcast or just received. Without this, applying a remote
            // update (even with captureUpdate: NEVER) still fires this same
            // onChange, and echoing that straight back into the Y.Map is
            // exactly the write-back loop that made edits fight each other.
            const sceneVersion = getSceneVersion(sceneElements);
            if (sceneVersion > lastSyncedSceneVersionRef.current) {
              lastSyncedSceneVersionRef.current = sceneVersion;
              // Throttled (ELEMENTS_WRITE_THROTTLE_MS), not a direct
              // applyLocalElements call — see createThrottledElementsWriter's
              // own docblock for why a burst of back-to-back writes from this
              // SAME client (exactly what a drag/resize's own onChange stream
              // produces) needs coalescing into one Y.Doc transaction.
              elementsWriterRef.current?.write(sceneElements);
              trackBoardEdit(pageId);
            }
            applyLocalBoardFields(session.doc, session.board, { viewBackgroundColor: appState.viewBackgroundColor });
            applyLocalFiles(session.doc, session.files, files as unknown as Record<string, BinaryFileData>);
          } else {
            schedulerRef.current?.notifyChange();
            trackBoardEdit(pageId);
          }
          // Viewport memory: fires on every scene OR appState change,
          // including plain pan/zoom with zero element edits — exactly what
          // we want here (unlike the collab write above or the share
          // scheduler, there is no scene-version gate to skip these; see
          // boardViewport.ts). Applies — and is harmless to call — in both
          // view and edit mode, on both paths.
          viewportPersisterRef.current?.notifyChange({
            scrollX: appState.scrollX,
            scrollY: appState.scrollY,
            zoom: appState.zoom.value,
          });
        }}
      />
      {/* Reactions are written into the room's own Y.Map over the same socket, so they need the
          edit permission AND the Edit mode: in View (and for read-only viewers) the chips are
          shown but inert, and there is no add button. */}
      <BoardReactions
        api={excalidrawApi}
        containerRef={containerRef}
        doc={session?.doc ?? null}
        reactions={session?.reactions ?? null}
        canReact={canWrite && isEditingNow}
        userId={reactionUserId}
        names={reactionNames}
      />
      {/* `top` AND `right` are measured, not a breakpoint (boardChromeLayout.ts):
          our row shares this corner with Excalidraw's library trigger, sits in
          the column its centred tool island grows into, and — mobile, QA-3
          finding №3 — has to step sideways around a tall strip of buttons
          pinned to this same right edge. None of that is something CSS can
          know, so `right-3` is no longer a class here either (it would fight
          the inline value the moment the row has to dodge sideways). */}
      <div
        ref={chromeRowRef}
        style={{ top: chromeOffsets.top, right: chromeOffsets.right }}
        className="absolute z-20 flex items-center gap-2"
      >
        {compact ? (
          // Round 25b-1 §1 — on a phone the whole row IS this one menu.
          <BoardExportMenu
            compact
            onExportPng={exportBoardPng}
            onExportSvg={exportBoardSvg}
            onCopyToClipboard={copyBoardToClipboard}
            onFitToScreen={fitBoardToScreen}
            mode={boardMode}
            onSelectMode={load.editable ? selectBoardMode : undefined}
          />
        ) : (
          <>
            {/* Sticky-note palette (owner request, Miro-style) — desktop/tablet
                only: it relies on HTML5 drag, which doesn't work with touch on
                a phone (`compact`, handled in the branch above, never renders
                this at all), and on `isEditingNow` — the same permission +
                preference gate Excalidraw's own toolbar is hidden behind, so a
                view-only board (by permission OR by the "View" toggle)
                never offers a way to insert one. Placed first in the row (the
                whole row's own top/right offset is measured live off its
                rendered width — see boardChromeLayout.ts — so this doesn't
                need its own separate obstacle-avoidance). */}
            {isEditingNow && <StickyNotePalette onPick={insertStickyNoteAtViewportCenter} />}
            <button
              type="button"
              onClick={fitBoardToScreen}
              aria-label={t('board.fitToScreen')}
              title={t('board.fitToScreen')}
              className="inline-flex items-center rounded-full border border-neutral-300 bg-white/90 p-1.5 text-neutral-600 shadow-sm backdrop-blur transition-colors hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500 dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-300 dark:hover:text-neutral-100"
            >
              <Maximize size={12} />
            </button>
            <BoardExportMenu
              onExportPng={exportBoardPng}
              onExportSvg={exportBoardSvg}
              onCopyToClipboard={copyBoardToClipboard}
            />
            {load.editable && <BoardModeToggle mode={boardMode} onSelect={selectBoardMode} />}
          </>
        )}
      </div>
      {showNewHint && (
        // Parked directly under the chrome row above it, wherever that row
        // ended up — both axes now, not just `top`: the row is no longer at
        // a fixed `top-3 right-3`, so a fixed `right-3` here would drift
        // away from the row the moment the row has to dodge sideways
        // (QA-3 finding №3). Reuses the row's own `right` rather than
        // measuring one of its own — this hint is always meant to sit flush
        // under whichever corner the row ended up in, never its own separate offset.
        <div
          style={{ top: chromeOffsets.hintTop, right: chromeOffsets.right }}
          className="pointer-events-none absolute z-10 rounded-full border border-neutral-300 bg-white/80 px-2.5 py-1 text-xs text-neutral-500 shadow-sm backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-400"
        >
          {t('board.newBoardHint')}
        </div>
      )}
      {load.editable && (
        <SaveStateChip
          state={chipState}
          lastSavedAt={lastSavedAt}
          onRetry={() => void performSave()}
          bottom={chromeOffsets.bottom}
          innerRef={saveChipRef}
        />
      )}
    </div>
  );
}

function SaveStateChip({
  state,
  lastSavedAt,
  onRetry,
  bottom,
  innerRef,
}: {
  state: SaveState;
  lastSavedAt: Date | null;
  onRetry: () => void;
  /** Measured clearance above Excalidraw's own bottom island — see BoardCanvas's layout effect and boardChromeLayout.ts. */
  bottom: number;
  /** So the measurement can read this chip's real rect; null while the chip is in its 'idle' (unrendered) state. */
  innerRef: Ref<HTMLDivElement>;
}) {
  const { t } = useTranslation('diagrams');
  if (state === 'idle') return null;

  const time = lastSavedAt?.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) ?? null;
  const isProblem = state === 'error' || state === 'unauthorized' || state === 'invalid-link' || state === 'offline';

  return (
    // `bottom` is measured, not the old hard-coded `bottom-14` (Round 25b-1
    // §3): 3.5rem was tuned for Excalidraw's desktop bottom-right "help"
    // island, but in its mobile layout Excalidraw draws a full-width tool
    // island along the bottom instead, and the chip landed 6px inside it.
    // BoardCanvas measures whichever of the two is actually there.
    // pointer-events-none on both this wrapper and the pill below: this chip
    // is a passive status readout, not a control, so it must never be able
    // to intercept a click meant for Excalidraw's own UI beneath/around it
    // (the help button in particular, given how close the two now sit) —
    // the one genuinely interactive bit, the retry button in the 'error'
    // state, opts itself back in below.
    <div ref={innerRef} style={{ bottom }} className="pointer-events-none absolute right-3 z-10">
      <div
        className={
          'pointer-events-none flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs shadow-sm backdrop-blur ' +
          (isProblem
            ? 'border-red-300 bg-red-50/90 text-red-800 dark:border-red-900/60 dark:bg-red-950/70 dark:text-red-200'
            : 'border-neutral-300 bg-white/90 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-300')
        }
      >
        {state === 'saving' && (
          <>
            <RotateCw size={12} className="animate-spin" />
            <span>{t('board.save.saving')}</span>
          </>
        )}
        {state === 'saved' && <span>{time ? t('board.save.savedAt', { time }) : t('board.save.saved')}</span>}
        {state === 'error' && (
          <>
            <AlertCircle size={12} />
            <span>{t('board.save.failed')}</span>
            <button
              type="button"
              onClick={onRetry}
              className="pointer-events-auto ml-1 underline decoration-dotted underline-offset-2 hover:opacity-80"
            >
              {t('board.save.retry')}
            </button>
          </>
        )}
        {state === 'unauthorized' && (
          <>
            <AlertCircle size={12} />
            <span>{t('board.sessionExpired')}</span>
          </>
        )}
        {state === 'invalid-link' && (
          <>
            <AlertCircle size={12} />
            <span>{t('board.invalidLink')}</span>
          </>
        )}
        {state === 'connecting' && (
          <>
            <RotateCw size={12} className="animate-spin" />
            <span>{t('board.save.connecting')}</span>
          </>
        )}
        {state === 'connected' && <span>{t('board.save.connected')}</span>}
        {state === 'offline' && (
          <>
            <AlertCircle size={12} />
            <span>{t('board.save.offline')}</span>
          </>
        )}
      </div>
    </div>
  );
}
