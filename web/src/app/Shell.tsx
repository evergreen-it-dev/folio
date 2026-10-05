import { createContext, useContext, useEffect, useState } from 'react';
import { Outlet, useLocation, useParams } from 'react-router';
import { Sidebar } from './sidebar/Sidebar';
import { Header } from './header/Header';
import { ConflictBanner } from './git/ConflictBanner';
import { DemoBanner } from './DemoBanner';
import { QuickSwitcher } from './switcher/QuickSwitcher';
import { useLocalStorage } from './hooks';
import { SetPagePresenceContext, type PagePresencePerson } from './presence';
import { rememberLastSpace } from './lastSpace';
import { OfflineRuntime } from './offline/OfflineRuntime';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { PageCrashed } from './routes/PageCrashed';

/** Stable empty array for Header's `presence` prop before any content has published — a fresh `[]` every render would defeat any memoization downstream. */
const EMPTY_PRESENCE: PagePresencePerson[] = [];

interface HeaderInfo {
  /** Absent for synthetic pages (e.g. a folder listing) — no real page id, no star/history for it. */
  pageId?: string;
  pagePath: string;
  title: string;
  /** Round 5: frontmatter `icon:` (emoji), threaded to the breadcrumbs. */
  icon?: string;
  /**
   * R23 tail (table view picker in the export menu): present ONLY while a
   * TABLE page is routed — the grid's current view id plus the saved views,
   * published the same way the breadcrumbs data is (the leaf knows, the
   * header needs it). Consumed by Header -> ExportMenu.
   */
  table?: {
    activeViewId: string;
    views: { id: string; name: string }[];
  };
  /** A pdf/office page is routed: the header swaps the export menu for «open in a new tab» / «download» of the file itself. */
  fileActions?: boolean;
}

// The header (breadcrumbs) is owned by this layout route, but the data it
// needs (current page's path/title) is only known deep inside the routed
// page content (PageContent, reached via <Outlet/>). Rather than duplicate
// that fetch or thread it back up through props, the leaf publishes it into
// this context and the header reads it back out.
const SetHeaderInfoContext = createContext<(info: HeaderInfo | null) => void>(() => {});

/** Call from a routed page to populate the shell's breadcrumbs; pass null while loading/absent. */
export function useSetHeaderInfo(info: HeaderInfo | null) {
  const setInfo = useContext(SetHeaderInfoContext);
  // The deps must stay SCALAR: callers rebuild `info` (and info.table) every
  // render, so depending on the objects themselves would re-run this effect
  // each render and loop through Shell's setState. The table half is folded
  // into one string for exactly that reason.
  const tableKey = info?.table ? `${info.table.activeViewId}\u0000${info.table.views.map((v) => `${v.id}:${v.name}`).join('\u0000')}` : undefined;
  useEffect(() => {
    setInfo(info);
    return () => setInfo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.pageId, info?.pagePath, info?.title, info?.icon, info?.fileActions, tableKey, setInfo]);
}

/** App layout: collapsible sidebar + header, with the routed page in the main area. */
export function Shell() {
  const { space = '' } = useParams<{ space: string }>();
  const location = useLocation();
  const [collapsed, setCollapsed] = useLocalStorage('folio:sidebar-collapsed', false);
  // Round 14: <md off-canvas drawer — plain, non-persisted state, deliberately
  // separate from `collapsed` above (a desktop preference saved across
  // sessions). Starts closed on every load/breakpoint, and the two toggle
  // together from the same header button below: each only has a visible
  // effect at its own breakpoint (Sidebar.tsx's responsive classes), so
  // flipping both unconditionally needs no viewport detection here.
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [headerInfo, setHeaderInfo] = useState<HeaderInfo | null>(null);
  const [pagePresence, setPagePresence] = useState<PagePresencePerson[] | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // "Where was I": /admin/access and /trash both link back to `/`, and
  // RootRedirect used to send everyone to the FIRST space regardless of where
  // they came from (owner, 11.09: "I go to settings and come back — and land
  // in another space"). This is the only place that reliably knows the answer.
  useEffect(() => {
    rememberLastSpace(space);
  }, [space]);

  // Global Cmd+K (Mac) / Ctrl+K (other) — opens the quick switcher from
  // anywhere in the shell, including while focus is inside a text input
  // (matches Notion/Linear-style palettes; also pre-empts the browser's own
  // Ctrl+K "focus the address bar" default in Chrome, hence preventDefault).
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSwitcherOpen(true);
        return;
      }
      // Cmd+B / Ctrl+B: toggle the sidebar (owner, 15.09; Alt+T below is the
      // everywhere-alternative). Inside a text
      // field or the editor the same keys already mean something — bold in
      // CodeMirror (format-toolbar.ts `Mod-b`, which preventDefaults) — so
      // those win and the sidebar stays put.
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') {
        if (event.defaultPrevented) return;
        const target = event.target as HTMLElement | null;
        if (target && (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') || target.isContentEditable)) return;
        event.preventDefault();
        setCollapsed((c) => !c);
        setMobileSidebarOpen((o) => !o);
      }
    }
    // Alt+T: the same toggle, but one that works EVERYWHERE, the editor
    // included (owner: Cmd+B is bold there). Capture phase and `code`, not
    // `key`: on a Mac Option+T types «†», and the editor must never see it.
    function handleAltT(event: KeyboardEvent) {
      if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && event.code === 'KeyT') {
        event.preventDefault();
        event.stopPropagation();
        setCollapsed((c) => !c);
        setMobileSidebarOpen((o) => !o);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keydown', handleAltT, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keydown', handleAltT, true);
    };
  }, [setCollapsed]);

  // Closes the <md drawer on every navigation, regardless of which of the
  // many click handlers scattered across Sidebar/PageTree/TreeRow/
  // StarredSection/QuickSwitcher triggered it — picking a destination should
  // get the drawer out of the way. A no-op at md+ (see the state comment above).
  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex h-full overflow-hidden bg-white dark:bg-neutral-950">
      <Sidebar
        space={space}
        desktopCollapsed={collapsed}
        mobileOpen={mobileSidebarOpen}
        onMobileClose={() => setMobileSidebarOpen(false)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <DemoBanner />
        <Header
          space={space}
          pageId={headerInfo?.pageId}
          pagePath={headerInfo?.pagePath}
          title={headerInfo?.title}
          icon={headerInfo?.icon}
          table={headerInfo?.table}
          fileActions={headerInfo?.fileActions}
          presence={pagePresence ?? EMPTY_PRESENCE}
          collapsed={collapsed}
          onToggleCollapse={() => {
            setCollapsed((c) => !c);
            setMobileSidebarOpen((o) => !o);
          }}
          onOpenSwitcher={() => setSwitcherOpen(true)}
        />
        <ConflictBanner space={space} />
        {/* min-h-0 alongside flex-1: without it, a flex item's automatic
            minimum size can refuse to shrink below its content's natural
            height, which is exactly how a nested overflow can bubble up
            into a second, outer scrollbar — see styles.css's html/body
            overflow:hidden docblock for the double-scroll bug this, plus
            that rule, is hardening against. */}
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <SetHeaderInfoContext.Provider value={setHeaderInfo}>
            <SetPagePresenceContext.Provider value={setPagePresence}>
              <ErrorBoundary resetKey={location.pathname} fallback={(_error, reset) => <PageCrashed onRetry={reset} />}>
                <Outlet />
              </ErrorBoundary>
            </SetPagePresenceContext.Provider>
          </SetHeaderInfoContext.Provider>
        </main>
      </div>
      {switcherOpen && <QuickSwitcher space={space} onClose={() => setSwitcherOpen(false)} />}
      <OfflineRuntime />
    </div>
  );
}
