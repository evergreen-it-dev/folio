import { useRef, useState } from 'react';
import { History, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSpaceRole } from '../auth/AuthProvider';
import { canEditContent } from '../auth/roles';
import { Breadcrumbs } from './Breadcrumbs';
import { SearchBox } from './SearchBox';
import { StarButton } from './StarButton';
import { HistoryPanel } from './HistoryPanel';
import { ShareButton } from '../share/ShareButton';
import { ExportMenu } from '../export/ExportMenu';
import { PageAccessDialog } from './PageAccessButton';
import { PagePresenceIndicator } from './PagePresence';
import { NotificationsBell } from './NotificationsBell';
import { PageTimer } from './PageTimer';
import { ConnectivityIndicator } from './ConnectivityIndicator';
import { PageActionsMenu, HEADER_ICON_BUTTON, type HeaderSurface } from './PageActionsMenu';
import { useIsLocalPage } from '../offline/localPages';
import { usePageTimer } from '../timer/pageTimerStore';
import { isGone } from '../timer/timerMath';
import type { ExportMenuTableInfo } from '../export/ExportMenu';
import type { PagePresencePerson } from '../presence';
import '../i18n/register';

/** The sidebar toggle's shortcut as shown in its tooltip (Shell.tsx handles the keys). */
const SIDEBAR_SHORTCUT = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent) ? '⌘B · ⌥T' : 'Ctrl+B · Alt+T';

export interface HeaderProps {
  space: string;
  /** Undefined while the current page hasn't loaded yet, or there is none — e.g. a folder listing (no real page) or a 404. Gates the page star, history, share, and rename. */
  pageId?: string;
  pagePath?: string;
  title?: string;
  /** Round 5: page's frontmatter icon (emoji), shown next to the title in breadcrumbs. Undefined until SERVER parses it into PageMeta. */
  icon?: string;
  /** R23 tail: the current TABLE page's views (HeaderInfo.table) — threaded to ExportMenu's view picker; undefined on non-table pages. */
  table?: ExportMenuTableInfo;
  /**
   * The routed page is a pdf or office (docx/xlsx/pptx) file: «open in a new
   * tab» and «download» of the file replace the export menu (an md/html
   * export of a binary file means nothing). Round OFFICE: generalized from
   * the old `pdf` prop — same two actions, one more page kind.
   */
  fileActions?: boolean;
  /** Round (page presence): everyone with this page open right now, published by the routed content (PageEditor/BoardCanvas/TablePageView) via Shell's usePublishPagePresence. Empty outside a collab session. */
  presence: PagePresencePerson[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** Opens the Cmd+K quick switcher (round 5) — also triggered by the global Cmd+K/Ctrl+K listener in Shell.tsx. */
  onOpenSwitcher: () => void;
  /** Receives the empty slot after the breadcrumbs where a board / table / form / file page mounts its Properties toggle (propertiesSlot.ts). */
  propertiesSlotRef?: (element: HTMLElement | null) => void;
}

/**
 * Top bar (07.11.2026, decluttered — the owner: «the header is still
 * overloaded»): sidebar toggle · breadcrumbs (+ properties slot) ·
 * connectivity · presence · the running timer's pill · bell · «Share» ·
 * page star · «⋯». Everything else a page offers (history, export, access,
 * compare, writing rules, a new timer, create-a-form, the file actions) is a
 * labelled row of the «⋯» menu (PageActionsMenu.tsx). Search left the header
 * at md+ for the sidebar's own Search row (⌘K still works everywhere, Shell);
 * below md its icon stays here.
 *
 * Round 8 header polish: the SPACE star moved to the sidebar, next to the
 * space name (SpaceSwitcher) — only the PAGE star remains here. Two
 * identically-styled stars side by side (space + page) were confirmed
 * confusing on real usage even though each had a distinct aria-label; a
 * tooltip alone wasn't enough since the two controls looked pixel-identical
 * at a glance. Splitting them by *where* each thing they act on already
 * lives (space identity -> sidebar, current page -> header) reads cleaner
 * than keeping both in one place and leaning entirely on copy to
 * disambiguate. Both this page star and the sidebar's space star still get
 * a real `title` tooltip regardless (StarButton.tsx) — not just aria-label.
 */
/** A document the writing rules can judge: a plain markdown page, not a table, form, board, base or file. */
function isProsePage(pagePath: string | undefined, table: unknown, fileActions: boolean | undefined): boolean {
  return pagePath !== undefined && !table && !fileActions && /\.md$/i.test(pagePath) && !/\.(table|form)\.md$/i.test(pagePath);
}

export function Header({ space, pageId, pagePath, title, icon, table, fileActions, presence, collapsed, onToggleCollapse, onOpenSwitcher, propertiesSlotRef }: HeaderProps) {
  const { t } = useTranslation('app');
  const role = useSpaceRole(space);
  const canEdit = canEditContent(role);
  // Offline mode: a page that exists only on this device. History, sharing,
  // export, access, the star, the icon and the rename are all server
  // operations on a page the server does not have yet — every one of them
  // could only fail. They appear by themselves the moment the page syncs.
  const isLocal = useIsLocalPage(pageId);
  const serverPageId = isLocal ? undefined : pageId;

  // Which of the header's surfaces is open — one at a time, and only for the
  // page it was opened on. Header owns this (not the «⋯» rows, which unmount
  // with their menu; see PageActionsMenu.tsx). Tagging it with the page makes
  // a navigation close it with no effect: a link followed from inside an open
  // history preview must not leave the panel open, silently re-pointed at the
  // next page (the P1 the old key={`history-${pageId}`} remount fixed).
  const moreRef = useRef<HTMLDivElement>(null);
  const [surfaceState, setSurfaceState] = useState<{ kind: HeaderSurface; pageId: string | undefined } | null>(null);
  const surface = surfaceState && surfaceState.pageId === serverPageId ? surfaceState.kind : null;
  const openSurface = (kind: HeaderSurface) => setSurfaceState({ kind, pageId: serverPageId });
  const closeSurface = () => setSurfaceState(null);
  const surfaceProps = (kind: HeaderSurface) => ({
    open: surface === kind,
    onOpenChange: (open: boolean) => (open ? openSurface(kind) : setSurfaceState((s) => (s?.kind === kind ? null : s))),
    anchorRef: moreRef,
  });

  // «Start a timer…» is a row of «⋯» while none runs; a running one is its pill (PageTimer).
  const timerData = usePageTimer(isLocal ? null : { space, pageId: serverPageId }).data;
  const canStartTimer = Boolean(timerData?.canControl && !(timerData.timer && !isGone(timerData.timer, Date.now(), timerData.offsetMs)));

  return (
    // `relative z-30`: the header's own popovers (connection panel,
    // notifications, «⋯») open DOWNWARD, over the page — and `backdrop-blur`
    // makes the header a stacking context of its own, so their z-50 only
    // counts inside it. Without a z-index on the header itself the editor's
    // sticky toolbar (z-20, later in the document) painted over them (the
    // owner, 29.09.2026: "the toolbar covers the offline notice"). Dialogs stay above at z-50+.
    <header className="relative z-30 flex h-12 shrink-0 items-center gap-1 border-b border-neutral-200 bg-white/90 px-2 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/90">
      <button
        type="button"
        onClick={onToggleCollapse}
        aria-label={collapsed ? t('header.showSidebar') : t('header.hideSidebar')}
        // Shortcut hint (Shell.tsx handles Cmd/Ctrl+B) — same ⌘-vs-Ctrl rule as SearchBox's ⌘K.
        title={`${collapsed ? t('header.showSidebar') : t('header.hideSidebar')} (${SIDEBAR_SHORTCUT})`}
        className={HEADER_ICON_BUTTON}
      >
        {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
      </button>

      {/* Round 19 QA fix (F1): explicit `flex` here (was a plain block box)
          makes this div's min-w-0/flex-1 actually govern Breadcrumbs's own
          <nav> (its child, also min-w-0 flex-1) as a real flex relationship
          rather than incidentally matching it via block auto-width — see
          Breadcrumbs.tsx's own comment for the actual overflow mechanism
          this was one link in (nav's children, not this box, were the
          direct cause). */}
      <div className="flex min-w-0 flex-1">
        {pagePath !== undefined && title !== undefined ? (
          // `!fileActions`: a pdf/office page's title is its filename (extension included) and the
          // server refuses a title rename for those kinds — see TreeRow's own note. The file is
          // renamed through the slug dialog instead. A canvas (`.canvas`) likewise: its title is its file name.
          <Breadcrumbs space={space} pagePath={pagePath} title={title} icon={icon} pageId={serverPageId} canRename={canEdit && !fileActions && !/\.canvas$/i.test(pagePath)} />
        ) : (
          <span className="text-sm text-neutral-400">{space}</span>
        )}
        {/* The page's Properties toggle (boards, tables, forms, files) mounts here, right after the title; empty otherwise. */}
        <div ref={propertiesSlotRef} className="flex shrink-0 items-center" data-header-properties-slot="" />
      </div>

      {/* Offline mode (29.09.2026): first in the cluster — a lost connection
          matters most on a phone. Renders nothing while the connection is
          fine and nothing is waiting. Presence: everyone with this page open
          (doc/board/table share this one header); nothing when alone. */}
      <ConnectivityIndicator />
      <PagePresenceIndicator people={presence} />

      {/* 16.10.2026: the shared timer — here only its countdown pill while one
          runs (a meeting is as likely run from a phone, so at every width).
          Idle, it is «⋯» → «Start a timer…», whose popover opens under «⋯».
          A page that exists only on this device has no server state to share.
          On a folder listing (no page id) it is the space's own timer. */}
      {!isLocal && <PageTimer key={`timer-${serverPageId ?? space}`} space={space} pageId={serverPageId} idleClassName="max-md:hidden" {...surfaceProps('timer')} />}

      {/* History: an icon at md+ (below md it is a «⋯» row); opens the surface Header owns. */}
      {serverPageId && pagePath !== undefined && (
        <button
          key={`history-btn-${serverPageId}`}
          type="button"
          aria-label={t('header.history')}
          title={t('header.history')}
          aria-haspopup="dialog"
          aria-expanded={surface === 'history'}
          onClick={() => (surface === 'history' ? closeSurface() : openSurface('history'))}
          className={`${HEADER_ICON_BUTTON} max-md:hidden`}
        >
          <History size={16} aria-hidden="true" />
        </button>
      )}

      {/* Round 31: access requests do not depend on the open page; on a phone it is needed no less. */}
      <NotificationsBell />

      {/* KEYS — every keyed element below is a SIBLING in this header's one
          children array, and each key is PREFIXED by its kind. A bare
          key={serverPageId} on two siblings (HistoryButton + ShareButton, once)
          gave them the same key; React does not tell colliding keys apart by
          element type, and under some transition sequences it lost track of
          which fiber was which, leaving undead buttons that accumulated one
          per page visited (the P1 "clock icons multiply" prod bug, reproduced
          by Shell.headerButtons.test.tsx). The page-scoped key also remounts
          each one on navigation, dropping a previous page's state. */}

      {/* «Share»: a labelled button at md+; below md it is a «⋯» row and its
          popover opens under «⋯» (the trigger stays mounted, display:none —
          the Menu falls back to the anchor). Editor+ only, as before. */}
      {serverPageId && <span aria-hidden="true" className="mx-1 hidden h-[18px] w-px shrink-0 bg-neutral-200 md:block dark:bg-neutral-800" />}

      {serverPageId && canEdit && <ShareButton key={`share-${serverPageId}`} pageId={serverPageId} variant="text" className="hidden md:block" {...surfaceProps('share')} />}

      {/* The page star: an icon at md+, a «⋯» row below md. */}
      {serverPageId && (
        <div key={`star-${serverPageId}`} className="hidden shrink-0 md:flex">
          <StarButton kind="page" id={serverPageId} />
        </div>
      )}

      {(serverPageId || canStartTimer) && (
        // A folder listing's «⋯» holds only «Start a timer…», which is the timer icon at md+.
        <div className={`shrink-0 ${serverPageId ? '' : 'md:hidden'}`}>
        <PageActionsMenu
          key={`page-actions-${serverPageId ?? space}`}
          anchorRef={moreRef}
          space={space}
          pageId={serverPageId}
          pagePath={pagePath}
          title={title}
          isTable={Boolean(table)}
          fileActions={Boolean(fileActions)}
          isProse={isProsePage(pagePath, table, fileActions)}
          canEdit={canEdit}
          canStartTimer={canStartTimer}
          onOpen={openSurface}
        />
        </div>
      )}

      {/* Export's formats panel: no button of its own, opened from «⋯» and
          placed under it. Mounted for the page's whole visit so a truncation
          warning or an export in flight survives the menu closing. Export is
          viewer-level (requirePageRole(..., 'viewer')): not gated on canEdit. */}
      {serverPageId && !fileActions && (
        <ExportMenu key={`export-${serverPageId}`} pageId={serverPageId} pagePath={pagePath} title={title} table={table} {...surfaceProps('export')} />
      )}

      {serverPageId && pagePath !== undefined && surface === 'history' && (
        <HistoryPanel key={`history-${serverPageId}`} pageId={serverPageId} space={space} pagePath={pagePath} canRestore={canEdit} onClose={closeSurface} />
      )}

      {serverPageId && surface === 'access' && <PageAccessDialog key={`access-${serverPageId}`} pageId={serverPageId} space={space} onClose={closeSurface} />}

      {/* Search: the sidebar's Search row (⌘K) at md+; this icon below md only. */}
      <div className="flex shrink-0 md:hidden">
        <SearchBox onOpen={onOpenSwitcher} />
      </div>
    </header>
  );
}
