import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { yUndoManagerKeymap } from 'y-codemirror.next';
import { trackEdit } from '../analytics';
import { api } from '../app/api';
import { useConnectivity } from '../app/offline/connectivity';
import { usePagePresence, usePublishPagePresence } from '../app/presence';
import { Markdown } from '../markdown';
import {
  useCollabSession,
  useConnectionStatus,
  useDocumentText,
  usePeerCount,
  useSynced,
  type CollabSession,
  type ConnectionStatus,
} from './collab';
import { folioCollab } from './collab-sync';
import { useEmojiFavorites } from '../emoji';
import { editorServicesFacet, type EditorServices } from './editor-services';
import { emojiFavouritesFacet } from './emoji-complete';
import { NS } from './i18n';
import { i18nReload } from './i18n-reload';
import { livePreview, livePreviewConfig } from './live-preview';
import { markdownEditorExtensions } from './markdown-setup';
import { mentions } from './mentions';
import { MermaidModal, useMermaidModal } from './mermaid-modal';
import { linkPreview } from './link-preview';
import {
  subscribeToolbarPinned,
  toggleToolbarPinned,
  toolbarHotkeyLabel,
  toolbarPinnedNow,
} from './pin-toolbar';
import { openMenu, type MenuHandle } from './popup-menu';
import { copyMarkdown } from './copy-markdown';
import { markdownPasteChooser } from './paste-chooser';
import { childPageDir } from './paths';
import { clearMountedEditorView, setMountedEditorView } from './scroll-to-heading';
import { assetUploads } from './uploads';
import { attachRemotePresenceExpiry } from './remote-presence';
import { ensureProtectedPageTitle, protectPageTitle, selectTitleOnDoubleClick } from './protected-title';
import './editor.css';
import '../markdown/status.css';
import { clearLiveDocText, publishLiveDocText } from '../app/liveDocText';
import { debounce } from './debounce';

/**
 * Round 19: the outline panel (app/outline/OutlinePanel.tsx) scrolls the editor
 * in source/live mode through these. `scrollToHeading(view, slug)` is the plain
 * form; `scrollActiveEditorToHeading(slug)` finds the mounted view itself, which
 * is what a component outside this zone actually has to work with.
 *
 * `scrollToOffset`/`scrollActiveEditorToOffset` are the same pair keyed by a
 * raw markdown offset instead of a heading slug — what the outline panel's
 * "Notes" section (markdown/notes.ts's NoteEntry.pos) needs, since a note
 * entry has no slug of its own.
 */
export {
  scrollToHeading,
  scrollActiveEditorToHeading,
  scrollToOffset,
  scrollActiveEditorToOffset,
  mountedEditorView,
} from './scroll-to-heading';

export interface PageEditorProps {
  pageId: string;
  space: string;
  /** Page path relative to the space root, e.g. "architecture/data-flow.md". */
  pagePath: string;
  /** Display title used to repair a legacy page whose structural H1 was erased. */
  title?: string;
  /** Absolute ws URL base for collab, e.g. ws://localhost:4871/collab */
  collabUrl: string;
  /** Extra query parameters for the collab socket (share links: { share: token }). */
  collabParams?: Record<string, string>;
  /**
   * Share-link token when the reader/editor is an anonymous guest (round 8).
   *
   * collabParams already carried it for the WEBSOCKET, but everything else
   * this component renders needs it too: reading mode hands it to <Markdown>
   * (which appends ?share= to /files URLs and skips the session-only
   * mentionable fetch), and live mode passes it into the live-preview context
   * so inline images resolve through the same guest-visible route. Without it
   * an edit share link showed a broken image in reading and an empty one in
   * live, plus a 401 in the console.
   */
  shareToken?: string;
  readOnly?: boolean;
  /**
   * Starting mode for the very first visit, before a choice is stored.
   *
   * Round 21 made that 'reading': a page is read far more often than it is
   * written, and landing in an editor made every visit look like an edit
   * session. Since 17.09 it applies to EVERY page open, not just the first
   * visit: the mode a reader picks is no longer remembered across pages (see
   * the reset effect below), so a shared link always lands in reading.
   */
  defaultMode?: EditorMode;
  /**
   * Optional left-aligned content for the chrome row (page icon / add-cover
   * controls when the page has no cover — see PageContent.tsx). Keeps the
   * meta strip and the mode toggle on one compact line.
   */
  chromeStart?: ReactNode;
}

/** A moment, so that the outline is not rebuilt on every letter but does not lag noticeably either. */
const OUTLINE_SYNC_DEBOUNCE_MS = 400;

export type EditorMode = 'source' | 'live' | 'reading';

/**
 * Toggle order, round 22: reading first, then the two editing surfaces in
 * order of how much markup they show.
 */
const MODES: readonly EditorMode[] = ['reading', 'live', 'source'];


/**
 * The page editor: a CodeMirror 6 view over a Yjs `Y.Text` named "content".
 *
 * All persistence happens through the collab connection — this component never
 * PUTs the markdown to the REST API.
 */
export function PageEditor({
  pageId,
  space,
  pagePath,
  title,
  collabUrl,
  collabParams,
  shareToken,
  readOnly,
  defaultMode = 'reading',
  chromeStart,
}: PageEditorProps) {
  const { t } = useTranslation(NS);
  const [chosenMode, setChosenMode] = useState<EditorMode>(defaultMode);
  const mode: EditorMode = readOnly ? 'reading' : chosenMode;
  // Every page opens in reading mode — even when the author sat in the editor
  // on the previous one (the owner, 17.09: "when a link is copy-pasted, even
  // one to editing, it must be Reading"). The choice of mode now lives exactly
  // as long as the work on THIS page lasts, and is no longer carried over to
  // the next one through localStorage.
  useEffect(() => {
    setChosenMode(defaultMode);
  }, [pageId, defaultMode]);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<ViewportSnapshot | null>(null);

  // `space` is only what an edit made while the socket is down is filed under
  // in the unsynced-pages list (offline mode) — it never rebuilds the session.
  const session = useCollabSession(pageId, collabUrl, collabParams, space);
  const status = useConnectionStatus(session);
  const synced = useSynced(session);
  const peers = usePeerCount(session);
  // A server page with nothing of it on this device, and no connection to
  // fetch it over: there is no document to show (offline mode, 29.09.2026).
  // A page created offline, or one with a local copy, has text and is not
  // this case; neither is a page that simply has not synced YET while online.
  const connectivity = useConnectivity();
  const unavailableOffline = connectivity === 'offline' && !synced && (!session || session.ytext.length === 0);
  // Round (page presence): reading mode still opens a collab session (see
  // useCollabSession above), so a reader is counted here too, not just an
  // editor — published up to Header via Shell's channel (app/presence.ts).
  const presencePeople = usePagePresence(session?.provider.awareness ?? null, session?.user ?? null);
  usePublishPagePresence(presencePeople);

  // Panels that SUMMARISE the page (the outline and its Notes list) read the
  // live document through app/liveDocText.ts instead of the server's last
  // snapshot — otherwise a heading typed in Live edit doesn't show up there
  // until a refetch (owner, 11.09). Published from an effect on a debounce,
  // never through this component's own state: a re-render per keystroke would
  // drag the whole CodeMirror host with it, and there is nothing here that
  // needs to re-render at all.
  useEffect(() => {
    if (!session) return;
    const push = debounce(() => publishLiveDocText(pageId, session.ytext.toString()), OUTLINE_SYNC_DEBOUNCE_MS);
    push();
    session.ytext.observe(push);
    return () => {
      session.ytext.unobserve(push);
      push.cancel();
      clearLiveDocText(pageId);
    };
  }, [session, pageId]);
  // Optional analytics: that this page was edited (once per page), never what was typed.
  useEffect(() => {
    if (!session || readOnly) return;
    const onEdit = (_event: unknown, tr: { local: boolean; origin: unknown }) => {
      if (tr.local && tr.origin !== 'folio-title-repair') trackEdit('doc', pageId, space);
    };
    session.ytext.observe(onEdit);
    return () => session.ytext.unobserve(onEdit);
  }, [session, pageId, space, readOnly]);
  const markdown = useDocumentText(session, mode === 'reading');
  const mermaid = useMermaidModal();
  const queryClient = useQueryClient();
  // A stable memo, so the view is never rebuilt for this. `createChildPage`
  // backs paste-chooser.ts's "insert as a link" branch — it never touches
  // app/api.ts, only the existing createPage/updatePage it already exports.
  const services = useMemo<EditorServices>(
    () => ({
      ...mermaid.services,
      createChildPage: async ({ markdown: childMarkdown, title }) => {
        try {
          const meta = await api.createPage({ space, parentPath: childPageDir(pagePath), title, kind: 'doc' });
          await api.updatePage(meta.id, { markdown: childMarkdown });
          queryClient.invalidateQueries({ queryKey: ['tree', space] });
          return { id: meta.id, path: meta.path, title: meta.title };
        } catch {
          return null;
        }
      },
    }),
    [mermaid.services, space, pagePath, queryClient],
  );
  // The shared favourites hook is React-bound; the editor's plain-DOM emoji
  // surfaces read them from a facet instead.
  // A share-link guest has no session, so GET /api/me/stars just 401s (twice,
  // via react-query's retry). Emoji favourites are per-user by definition —
  // there is nothing for an anonymous editor to load.
  const { favorites } = useEmojiFavorites(undefined, { enabled: !shareToken });

  const selectMode = (next: EditorMode) => {
    viewportRef.current = captureViewport(rootRef.current);
    setChosenMode(next);
  };

  useLayoutEffect(() => {
    const snapshot = viewportRef.current;
    viewportRef.current = null;
    if (!snapshot) return;
    const restore = () => restoreViewport(snapshot);
    restore();
    let second = 0;
    const first = requestAnimationFrame(() => {
      restore();
      second = requestAnimationFrame(restore);
    });
    return () => {
      cancelAnimationFrame(first);
      if (second) cancelAnimationFrame(second);
    };
  }, [mode]);

  return (
    <div className="folio-editor" data-mode={mode} ref={rootRef}>
      <div className="folio-editor__chrome">
        {/* Round 22: the chrome-start slot is the page icon and the "add a
            cover" button — authoring controls. Reading mode drops them
            entirely rather than showing them disabled: there is nothing to
            author there, and with the default mode now 'reading' this is the
            row most visits see. */}
        {mode !== 'reading' && chromeStart != null && (
          <div className="folio-editor__chrome-start">{chromeStart}</div>
        )}
        <ConnectionBadge status={status} peers={peers} />
        {readOnly ? (
          <span className="folio-editor__readonly">{t('readonly')}</span>
        ) : (
          <>
            {/* Round 27: only where there is a panel to show. Reading mode
                mounts no CodeMirror view at all, so a toggle for the command
                strip there would point at nothing — and the row's tightest
                layout (a phone) gets the width back instead. */}
            {mode !== 'reading' && <PanelToggle />}
            <ModeToggle mode={mode} onSelect={selectMode} />
          </>
        )}
      </div>

      {mode === 'reading' ? (
        <div className="folio-editor__reading">
          <div className="folio-editor__prose">
            {synced || markdown ? (
              <Markdown markdown={markdown} space={space} pagePath={pagePath} pageId={pageId} shareToken={shareToken} />
            ) : (
              <p className="folio-editor__hint">{t(unavailableOffline ? 'unavailableOffline' : 'loadingPage')}</p>
            )}
          </div>
        </div>
      ) : unavailableOffline ? (
        // Not an empty editor: an empty page one can type into would read as
        // «the page is empty», and what is typed there would land on top of
        // the real text when the connection returns.
        <p className="folio-editor__hint">{t('unavailableOffline')}</p>
      ) : session ? (
        <CodeMirrorHost
          key={pageId}
          session={session}
          live={mode === 'live'}
          space={space}
          pagePath={pagePath}
          pageId={pageId}
          title={title}
          canRepairTitle={synced}
          shareToken={shareToken}
          services={services}
          emojiFavourites={favorites}
        />
      ) : (
        <p className="folio-editor__hint">{t('connecting')}</p>
      )}

      {mermaid.request ? <MermaidModal request={mermaid.request} onClose={mermaid.close} /> : null}
    </div>
  );
}

/**
 * The phone breakpoint, kept in step with editor.css's `@media (max-width:
 * 767.98px)`. Below it the three-way mode switch collapses to one button — at
 * 375px the segmented control alone is wider than the chrome row, and it was
 * pushing the connection badge and the «add a cover» button off the line.
 */
const COMPACT_QUERY = '(max-width: 767.98px)';

function matchesCompact(): boolean {
  // No matchMedia (jsdom, SSR) means desktop: the segmented control is the
  // richer control, and it is the one every non-phone visit should get.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(COMPACT_QUERY).matches;
}

/** Live, so rotating a phone swaps the control without a reload. */
function useCompactChrome(): boolean {
  const [compact, setCompact] = useState(matchesCompact);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(COMPACT_QUERY);
    const sync = () => setCompact(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return compact;
}

function ModeToggle({ mode, onSelect }: { mode: EditorMode; onSelect: (mode: EditorMode) => void }) {
  const { t } = useTranslation(NS);
  const compact = useCompactChrome();

  if (compact) return <ModeMenu mode={mode} onSelect={onSelect} />;

  return (
    <div className="folio-editor__modes" role="group" aria-label={t('mode.aria')}>
      {MODES.map((option) => (
        <button
          key={option}
          type="button"
          className="folio-editor__mode"
          aria-pressed={mode === option}
          title={t(`mode.${option}Title`)}
          onClick={() => onSelect(option)}
        >
          {t(`mode.${option}`)}
        </button>
      ))}
    </div>
  );
}

/**
 * The phone form of the switch: one button naming the current mode, opening the
 * three as a menu. The menu itself is the editor's existing plain-DOM dropdown
 * (popup-menu.ts) — it already renders into `<body>` as `position: fixed`, so a
 * chrome row that clips its own overflow cannot clip it, and it already carries
 * the `selected` marker this needs for the current mode.
 */
function ModeMenu({ mode, onSelect }: { mode: EditorMode; onSelect: (mode: EditorMode) => void }) {
  const { t } = useTranslation(NS);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<MenuHandle | null>(null);
  const liveRef = useRef(true);
  /** Set when the press that just dismissed the menu landed on this button. */
  const dismissedRef = useRef(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      menuRef.current?.close();
    };
  }, []);

  /**
   * Watches every press for one question: is this one landing on the button
   * while the menu is open? Capture phase on `window`, so it runs before
   * popup-menu's own document-level dismissal and can still see the menu as
   * open — by the time the resulting `click` reaches `toggle`, the menu is
   * already gone and nothing else could tell the two cases apart.
   *
   * Registered for the life of the component rather than per-menu so it also
   * *clears* the flag: a press that never became a click (the pointer dragged
   * off the button) must not swallow the next tap.
   */
  useEffect(() => {
    const onPress = (event: MouseEvent) => {
      dismissedRef.current =
        menuRef.current !== null && buttonRef.current?.contains(event.target as Node) === true;
    };
    window.addEventListener('mousedown', onPress, true);
    return () => window.removeEventListener('mousedown', onPress, true);
  }, []);

  const toggle = () => {
    // The press that got here already dismissed the menu. Closed is where it
    // should stay: without this it would blink shut and straight back open, and
    // there would be no way to dismiss it from the button at all.
    if (dismissedRef.current) {
      dismissedRef.current = false;
      return;
    }
    // Keyboard activation (Enter/Space) sends no mousedown, so the menu is
    // still open here and this is what closes it.
    if (menuRef.current) {
      menuRef.current.close();
      return;
    }
    const anchor = buttonRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();

    setOpen(true);
    menuRef.current = openMenu({
      x: rect.left,
      y: rect.bottom + 4,
      ariaLabel: t('mode.aria'),
      items: MODES.map((option) => ({
        label: t(`mode.${option}`),
        selected: option === mode,
        onSelect: () => onSelect(option),
      })),
      onClose: () => {
        menuRef.current = null;
        // Unmount closes the menu too; don't set state on the way out.
        if (liveRef.current) setOpen(false);
      },
    });
  };

  return (
    <button
      ref={buttonRef}
      type="button"
      className="folio-editor__mode-menu"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={t('mode.pick', { mode: t(`mode.${mode}`) })}
      title={t(`mode.${mode}Title`)}
      onClick={toggle}
    >
      <span className="folio-editor__mode-current">{t(`mode.${mode}`)}</span>
      <svg
        className="folio-editor__mode-caret"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
  );
}

/**
 * Whether the editor's command panel is currently shown.
 *
 * The value lives in pin-toolbar.ts — the panel is a CodeMirror field inside a
 * view this component does not own, and in reading mode there is no view at
 * all. `useSyncExternalStore` rather than a `useState`/`useEffect` pair so the
 * button cannot render one frame of a stale state after a hotkey press.
 */
function useToolbarPinned(): boolean {
  return useSyncExternalStore(subscribeToolbarPinned, toolbarPinnedNow, () => true);
}

/**
 * Round 27: the command panel's show/hide control, as the owner asked for it —
 * "with a button next to the editing mode".
 *
 * It used to be a full-width chevron strip docked across the top of the editor,
 * which spent a band of the document on a single chevron. Same toggle, same
 * ⌥⇧P shortcut (pin-toolbar.ts owns both, and the shortcut still works from
 * inside the editor whether or not this button was ever clicked) — only the
 * shape changed.
 */
function PanelToggle() {
  const { t } = useTranslation(NS);
  const shown = useToolbarPinned();
  // One name for both states on purpose: `aria-pressed` is what says which way
  // it currently sits, and a button whose name changes under the user is one
  // they cannot refer back to ("click Show the command panel" stays true).
  const label = t('toolbar.show', { key: toolbarHotkeyLabel() });

  return (
    <button
      type="button"
      className="folio-editor__panel-toggle"
      aria-pressed={shown}
      aria-label={label}
      title={label}
      onClick={() => toggleToolbarPinned()}
    >
      {/* A panel docked to the top of a frame — the strip this shows and hides. */}
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3 5h18v14H3z" />
        <path d="M3 10h18" />
      </svg>
    </button>
  );
}

/**
 * The collab indicator. Round 27 shrank it to the dot: the "connected" wording
 * moved into the tooltip and into the accessible name, which is also what pays
 * for the panel button next to it on a 375px row.
 *
 * Two things had to survive losing the text.
 *
 * The name: there is no longer any text node to read, so the dot is declared a
 * graphic (`role="img"`) with the same sentence as its `aria-label`. A screen
 * reader announces "connected" / "no connection" exactly as it did before.
 *
 * The state, without colour: green-against-red is precisely the pair a
 * red-green colour-blind reader cannot separate, and this dot is the only thing
 * on the row telling them whether what they type is reaching anyone. So the
 * *shape* carries the state — a filled disc connected, an open ring
 * connecting, a struck-through ring offline — and colour is reinforcement
 * rather than the signal. A hover tooltip cannot be the answer on its own: it
 * is unreachable on a touch screen, which is the layout that pushed for this
 * change in the first place.
 */
function ConnectionBadge({ status, peers }: { status: ConnectionStatus; peers: number }) {
  const { t } = useTranslation(NS);
  const state = t(`status.${status}`);
  const title = t('status.title', { state });
  // The peer count used to be its own faint span on the row; with the row down
  // to a dot it rides along in the tooltip instead of disappearing.
  const label =
    status === 'connected' && peers > 0
      ? `${title} ${t('status.peers', { count: peers })}`
      : status === 'unsaved'
        ? `${title}. ${t('status.unsavedHint')}`
        : title;

  return (
    <span className="folio-editor__status" data-status={status} role="img" aria-label={label} title={label}>
      <svg className="folio-editor__dot" viewBox="0 0 12 12" aria-hidden="true">
        {status === 'connected' ? (
          <circle cx="6" cy="6" r="4" fill="currentColor" />
        ) : (
          <circle cx="6" cy="6" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
        )}
        {status === 'offline' ? (
          <path d="M3.2 8.8 8.8 3.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        ) : null}
        {status === 'unsaved' ? <path d="M6 3.4v3.2M6 8.4v.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /> : null}
      </svg>
      {/* Not saved is the one state a dot must not carry alone: the person is
          typing text that is not reaching the server right now. */}
      {status === 'unsaved' ? (
        <span className="folio-editor__status-text" aria-hidden="true">
          {t('status.unsavedShort')}
        </span>
      ) : null}
    </span>
  );
}

interface HostProps {
  session: CollabSession;
  live: boolean;
  space: string;
  pagePath: string;
  pageId: string;
  title?: string;
  canRepairTitle: boolean;
  shareToken?: string;
  services: EditorServices;
  emojiFavourites: readonly string[];
}

/**
 * Owns the CodeMirror view. The view is created once per collab session; mode
 * and page-context changes are applied by reconfiguring a compartment so the
 * caret and scroll position survive a source/live switch.
 */
function CodeMirrorHost({ session, live, space, pagePath, pageId, title, canRepairTitle, shareToken, services, emojiFavourites }: HostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const modeCompartment = useMemo(() => new Compartment(), []);
  const emojiCompartment = useMemo(() => new Compartment(), []);

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) return;

    const view = new EditorView({
      state: EditorState.create({
        // The Yjs binding takes over from here; seed with what the doc holds now.
        doc: session.ytext.toString(),
        extensions: [
          markdownEditorExtensions(),
          livePreview,
          // Must run before assetUploads(): domEventHandlers tries `paste`
          // handlers in this order and stops at the first `true`.
          markdownPasteChooser(),
          assetUploads(),
          // Live edit copy/cut: markdown (with the folded markers) + rendered HTML.
          copyMarkdown,
          i18nReload,
          linkPreview(),
          mentions(),
          protectPageTitle(),
          selectTitleOnDoubleClick(),
          editorServicesFacet.of(services),
          // Reconfigured below whenever mode or page context changes.
          modeCompartment.of(livePreviewConfig(false, { space: '', pagePath: '', pageId: '' })),
          emojiCompartment.of(emojiFavouritesFacet.of(emojiFavourites)),
          keymap.of(yUndoManagerKeymap),
          // Not y-codemirror's own yCollab: its sync plugin is switched off for
          // good by the first exception, and the editor then keeps taking text
          // that never reaches the document (collab-sync.ts).
          folioCollab(session.ytext, session.provider.awareness, { undoManager: session.undoManager }),
        ],
      }),
      parent,
    });
    viewRef.current = view;
    setMountedEditorView(view);
    const detachRemotePresence = attachRemotePresenceExpiry(view.dom, session.provider.awareness);
    // Take focus only when the user isn't typing somewhere else (e.g. the search box).
    if (!document.activeElement || document.activeElement === document.body) view.focus();

    return () => {
      detachRemotePresence();
      viewRef.current = null;
      clearMountedEditorView(view);
      view.destroy();
    };
  }, [session, services, modeCompartment, emojiCompartment]);

  const queryClient = useQueryClient();
  // The H1 IS the title: after the user edits it, the server re-indexes the
  // page (and may auto-rename its slug) on the ~800ms collab flush. Nothing
  // else tells the sidebar tree, breadcrumbs or document.title about it, so
  // nudge the react-query caches a little after the flush — twice, in case
  // the first refetch lands before the flush + rescan finished.
  useEffect(() => {
    if (!pageId) return;
    let lastH1 = session.ytext.toString().split('\n', 1)[0];
    const timers: ReturnType<typeof setTimeout>[] = [];
    const refresh = () => {
      queryClient.invalidateQueries({ queryKey: ['page', pageId] });
      queryClient.invalidateQueries({ queryKey: ['tree', space] });
    };
    const onChange = () => {
      const h1 = session.ytext.toString().split('\n', 1)[0];
      if (h1 === lastH1) return;
      lastH1 = h1;
      for (const t of timers.splice(0)) clearTimeout(t);
      timers.push(setTimeout(refresh, 2000), setTimeout(refresh, 6000));
    };
    session.ytext.observe(onChange);
    return () => {
      session.ytext.unobserve(onChange);
      for (const t of timers.splice(0)) clearTimeout(t);
    };
  }, [session, pageId, space, queryClient]);

  useEffect(() => {
    if (!canRepairTitle || !title) return;
    const current = session.ytext.toString();
    const repaired = ensureProtectedPageTitle(current, title);
    if (repaired === current) return;
    session.doc.transact(() => {
      session.ytext.delete(0, session.ytext.length);
      session.ytext.insert(0, repaired);
    }, 'folio-title-repair');
  }, [session, title, canRepairTitle]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: emojiCompartment.reconfigure(emojiFavouritesFacet.of(emojiFavourites)),
    });
  }, [emojiFavourites, emojiCompartment]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: modeCompartment.reconfigure(livePreviewConfig(live, { space, pagePath, pageId, shareToken })),
    });
    // `session` is a dependency because a fresh view starts in source mode.
  }, [session, live, space, pagePath, pageId, shareToken, modeCompartment]);

  return <div className="folio-editor__surface" ref={hostRef} />;
}

interface ViewportSnapshot {
  root: HTMLElement;
  top: number;
  left: number;
  progress: number;
  anchor?: { text: string; offset: number };
}

function editorScroller(root: HTMLElement | null): HTMLElement | null {
  // Both modes have their OWN inner scroller. The old code searched only among
  // the ancestors of `.folio-editor`, so it remembered the shell, not the place
  // in the document; after a Reading/CodeMirror remount the old node was gone too.
  // In the share view the height of the editor is set by the outer
  // `overflow-auto`: the inner `.folio-editor__reading` / `.cm-scroller` exist
  // there but do not actually scroll (clientHeight === scrollHeight). So the
  // mere presence of the class is not enough — otherwise we remember their
  // eternal scrollTop=0.
  const isScrollable = (node: HTMLElement): boolean => {
    const overflow = getComputedStyle(node).overflowY;
    return /(auto|scroll)/.test(overflow) && node.scrollHeight > node.clientHeight + 1;
  };
  const own = Array.from(root?.querySelectorAll<HTMLElement>('.folio-editor__reading, .cm-scroller') ?? []).find(
    isScrollable,
  );
  if (own) return own;
  for (let node = root?.parentElement ?? null; node; node = node.parentElement) {
    if (isScrollable(node)) return node;
  }
  return null;
}

const VIEWPORT_ANCHORS = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th,.cm-line,.cm-md-cell-line';

function normalizeAnchor(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 96);
}

function captureAnchor(scroller: HTMLElement): ViewportSnapshot['anchor'] {
  const viewport = scroller.getBoundingClientRect();
  const candidates = Array.from(scroller.querySelectorAll<HTMLElement>(VIEWPORT_ANCHORS))
    .map((node) => ({ node, box: node.getBoundingClientRect(), text: normalizeAnchor(node.textContent) }))
    .filter(({ box, text }) => text.length >= 8 && box.bottom > viewport.top + 8 && box.top < viewport.bottom);
  candidates.sort((a, b) => Math.abs(a.box.top - viewport.top - 24) - Math.abs(b.box.top - viewport.top - 24));
  const picked = candidates[0];
  return picked ? { text: picked.text, offset: picked.box.top - viewport.top } : undefined;
}

function captureViewport(root: HTMLElement | null): ViewportSnapshot | null {
  const scroller = editorScroller(root);
  if (!scroller) return null;
  const range = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  return {
    root: root!,
    top: scroller.scrollTop,
    left: scroller.scrollLeft,
    progress: range > 0 ? scroller.scrollTop / range : 0,
    anchor: captureAnchor(scroller),
  };
}

function restoreViewport({ root, top, left, progress, anchor }: ViewportSnapshot): void {
  if (!root.isConnected) return;
  const scroller = editorScroller(root);
  if (!scroller) return;
  const range = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  // The absolute place is saved first — it is more stable than a percentage
  // when Live and Reading have different heights of images/tables.
  scroller.scrollTop = Math.min(range, top);
  scroller.scrollLeft = left;

  if (anchor) {
    const target = Array.from(scroller.querySelectorAll<HTMLElement>(VIEWPORT_ANCHORS))
      .map((node) => ({ node, text: normalizeAnchor(node.textContent) }))
      .filter(({ text }) => text.length >= 8 && (text.includes(anchor.text) || anchor.text.includes(text)))
      .sort((a, b) => Math.abs(a.text.length - anchor.text.length) - Math.abs(b.text.length - anchor.text.length))[0]?.node;
    if (target) {
      const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
      scroller.scrollTop = Math.max(0, Math.min(range, scroller.scrollTop + delta));
      return;
    }
  }
  // If the matching text node does not exist yet (the first layout phase), the
  // absolute top stays; progress is only a fallback for a much shorter document.
  if (top > range && range > 0) scroller.scrollTop = Math.round(progress * range);
}
