import { Download, ExternalLink, MoreHorizontal, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useSpaceRole } from '../auth/AuthProvider';
import { canEditContent } from '../auth/roles';
import { Menu } from '../ui/Menu';
import { Breadcrumbs } from './Breadcrumbs';
import { SearchBox } from './SearchBox';
import { StarButton } from './StarButton';
import { HistoryButton } from './HistoryButton';
import { ShareButton } from '../share/ShareButton';
import { ExportMenu } from '../export/ExportMenu';
import { CreateFormButton } from './CreateFormButton';
import { PageAccessButton } from './PageAccessButton';
import { ReplaceFileButton } from '../files/ReplaceFileButton';
import { PagePresenceIndicator } from './PagePresence';
import { NotificationsBell } from './NotificationsBell';
import { ConnectivityIndicator } from './ConnectivityIndicator';
import { useIsLocalPage } from '../offline/localPages';
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
}

/**
 * Top bar: sidebar collapse toggle, breadcrumbs (round 8: last crumb is
 * click-to-rename for editor+), history/share/star toggles for the current
 * page, search.
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
export function Header({ space, pageId, pagePath, title, icon, table, fileActions, presence, collapsed, onToggleCollapse, onOpenSwitcher }: HeaderProps) {
  const { t } = useTranslation('app');
  const role = useSpaceRole(space);
  const canEdit = canEditContent(role);
  // Offline mode: a page that exists only on this device. History, sharing,
  // export, access, the star, the icon and the rename are all server
  // operations on a page the server does not have yet — every one of them
  // could only fail. They appear by themselves the moment the page syncs.
  const isLocal = useIsLocalPage(pageId);
  const serverPageId = isLocal ? undefined : pageId;

  return (
    // `relative z-30`: the header's own popovers (connection panel,
    // notifications, «⋯») open DOWNWARD, over the page — and `backdrop-blur`
    // makes the header a stacking context of its own, so their z-50 only
    // counts inside it. Without a z-index on the header itself the editor's
    // sticky toolbar (z-20, later in the document) painted over them (the
    // owner, 29.09.2026: "the toolbar covers the offline notice"). Dialogs stay above at z-50+.
    <header className="relative z-30 flex h-14 shrink-0 items-center gap-2 border-b border-neutral-200 bg-white/80 px-3 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/80">
      <button
        type="button"
        onClick={onToggleCollapse}
        aria-label={collapsed ? t('header.showSidebar') : t('header.hideSidebar')}
        // Shortcut hint (Shell.tsx handles Cmd/Ctrl+B) — same ⌘-vs-Ctrl rule as SearchBox's ⌘K.
        title={`${collapsed ? t('header.showSidebar') : t('header.hideSidebar')} (${SIDEBAR_SHORTCUT})`}
        // max-md:min-h/w-10: touch-target floor (round 14), no-op at md+.
        className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 max-md:min-h-10 max-md:min-w-10 dark:hover:bg-neutral-800"
      >
        {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
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
          // renamed through the slug dialog instead.
          <Breadcrumbs space={space} pagePath={pagePath} title={title} icon={icon} pageId={serverPageId} canRename={canEdit && !fileActions} />
        ) : (
          <span className="text-sm text-neutral-400">{space}</span>
        )}
      </div>

      {/* Round (page presence): rendered for all three page kinds (doc/board/
          table) since this row is their one shared header — left of the
          action-icon cluster(s) below, and OUTSIDE the `md:flex`-gated div so
          it stays visible at the phone breakpoint too, unlike those icons. */}
      {/* Offline mode (29.09.2026): first in the cluster and outside the
          `md:flex` block — a lost connection matters most on a phone. Renders
          nothing while the connection is fine and nothing is waiting. */}
      <ConnectivityIndicator />

      <PagePresenceIndicator people={presence} />

      {/* Round 31 (notifications): next to the presence indicator and to the
          LEFT of the group of page icons — and likewise outside the `md:flex`
          block, because an access request does not depend on whether a page is
          open right now, and on a phone it is needed no less. */}
      <NotificationsBell />

      {/* md+: history/share/star stay as their own always-visible icon
          buttons, exactly as before. <md collapses the same three into one
          "⋯" popover instead (below) — three more icons plus a still-usable
          breadcrumb doesn't fit next to the collapse toggle and search at
          375px. Both clusters render unconditionally (CSS `hidden`/`md:hidden`
          decides which one is visible); Shell.headerButtons.test.tsx counts
          these by aria-label with no viewport of its own, which is exactly
          why a display-only split — not a mount/unmount one — is what keeps
          that regression test meaningful at every width. */}
      <div className="hidden shrink-0 items-center gap-1 md:flex">
        {serverPageId && pagePath !== undefined && (
          // key={`history-${serverPageId}`} (P1 fix): forces a remount (closing any
          // open panel) when the underlying page changes — Header itself
          // doesn't unmount across a same-space navigation, so without this a
          // link followed from *inside* an open history preview would leave
          // the panel open, silently re-pointed at whatever page you
          // navigated to. MUST be prefixed, not bare `serverPageId`: this and
          // ShareButton below are SIBLINGS in this div's children array
          // (JSX's multiple direct children ARE one reconciled list,
          // regardless of being different component types), and a bare
          // key={serverPageId} on both gave them the exact same key — React's
          // reconciler doesn't disambiguate colliding keys by element type,
          // so under specific transition sequences (confirmed via a real
          // render test, not just reasoning: Shell.headerButtons.test.tsx)
          // it lost track of which fiber was which, producing extra, undead
          // <button> nodes that accumulated one per page ever visited
          // instead of unmounting. This was the real cause of the P1 "clock
          // icons multiply" prod bug.
          <HistoryButton
            key={`history-${serverPageId}`}
            pageId={serverPageId}
            space={space}
            pagePath={pagePath}
            canRestore={canEditContent(role)}
          />
        )}

        {serverPageId && canEdit && <ShareButton key={`share-${serverPageId}`} pageId={serverPageId} />}

        {/* Round 23: export is a VIEWER-level capability server-side
            (requirePageRole(..., 'viewer')), so unlike ShareButton it is not
            gated on canEdit — a reader who can open the page can take a copy
            of it. Same key-prefixing precaution as its siblings above. */}
        {serverPageId && fileActions && <PageFileActions key={`file-${serverPageId}`} pageId={serverPageId} space={space} canReplace={canEdit} />}
        {serverPageId && !fileActions && <ExportMenu key={`export-${serverPageId}`} pageId={serverPageId} pagePath={pagePath} title={title} table={table} />}

        {/* Round FORMS: "Create a form" — only on a table page (the `table`
            prop is only ever set by PageContent for kind:'table', see its
            own doc comment) and only for an editor, same gate ShareButton
            uses. */}
        {serverPageId && canEdit && table && <CreateFormButton key={`create-form-${serverPageId}`} pageId={serverPageId} space={space} />}

        {serverPageId && <PageAccessButton key={`access-${serverPageId}`} pageId={serverPageId} />}

        {serverPageId && <StarButton kind="page" id={serverPageId} />}
      </div>

      {serverPageId && (
        <Menu
          key={`page-actions-${serverPageId}`}
          triggerLabel={t('header.moreActions')}
          align="right"
          className="shrink-0 md:hidden"
          trigger={<MoreHorizontal size={16} aria-hidden="true" />}
        >
          {() => (
            <div className="flex items-center gap-1 p-1">
              {/* Same key-prefixing precaution as the md+ cluster above, applied
                  defensively here too — these three are conditional siblings
                  of different types in one array, exactly the shape that bit
                  us before. */}
              {pagePath !== undefined && (
                <HistoryButton
                  key={`history-m-${serverPageId}`}
                  pageId={serverPageId}
                  space={space}
                  pagePath={pagePath}
                  canRestore={canEditContent(role)}
                />
              )}
              {canEdit && <ShareButton key={`share-m-${serverPageId}`} pageId={serverPageId} />}
              {fileActions ? (
                <PageFileActions key={`file-m-${serverPageId}`} pageId={serverPageId} space={space} canReplace={canEdit} />
              ) : (
                <ExportMenu key={`export-m-${serverPageId}`} pageId={serverPageId} pagePath={pagePath} title={title} table={table} />
              )}
              {canEdit && table && <CreateFormButton key={`create-form-m-${serverPageId}`} pageId={serverPageId} space={space} />}
              <PageAccessButton key={`access-m-${serverPageId}`} pageId={serverPageId} />
              <StarButton kind="page" id={serverPageId} />
            </div>
          )}
        </Menu>
      )}

      <SearchBox onOpen={onOpenSwitcher} />
    </header>
  );
}

const HEADER_ICON_LINK =
  'inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 max-md:min-h-10 max-md:min-w-10 dark:hover:bg-neutral-800 dark:hover:text-neutral-200';

/** A pdf/office page's two file actions, as header icons like their history/share siblings (owner, 15.09: no separate toolbar row above the file). */
function PageFileActions({ pageId, space, canReplace }: { pageId: string; space: string; canReplace: boolean }) {
  const { t } = useTranslation('app');
  return (
    <>
      {canReplace && <ReplaceFileButton space={space} pageId={pageId} className={HEADER_ICON_LINK} />}
      <a
        href={api.pageFileUrl(pageId)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t('routes.pdf.openInNewTab')}
        title={t('routes.pdf.openInNewTab')}
        className={HEADER_ICON_LINK}
      >
        <ExternalLink size={15} aria-hidden="true" />
      </a>
      <a href={api.pageFileUrl(pageId, true)} aria-label={t('routes.pdf.download')} title={t('routes.pdf.download')} className={HEADER_ICON_LINK}>
        <Download size={15} aria-hidden="true" />
      </a>
    </>
  );
}
