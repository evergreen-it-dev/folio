import { useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  ClipboardList,
  ExternalLink,
  FileText,
  GitBranch,
  LayoutDashboard,
  LayoutTemplate,
  Loader2,
  Plus,
  Printer,
  RefreshCw,
  RotateCcw,
  Settings,
  Sparkles,
  House,
  Table2,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import type { PageKind, PageMeta } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { useActiveFolderPath, useActivePageId, useLocalStorage } from '../hooks';
import { useSpaceRole } from '../auth/AuthProvider';
import { canEditContent, canManageMembers } from '../auth/roles';
import { UserMenu } from '../auth/UserMenu';
import { useToast } from '../ui/Toast';
import { OfflineUnsupportedError, createPageOfflineAware, treeOfflineAware } from '../offline/createPage';
import { listLocalPages } from '../offline/localPages';
import { mergeLocalPages } from '../offline/treeMerge';
import { Menu, MenuItem } from '../ui/Menu';
import { useTemplates, useCreateFromTemplate } from '../templates/useTemplates';
import { StarButton } from '../header/StarButton';
import { SpaceSwitcher } from './SpaceSwitcher';
import { PageTree } from './PageTree';
import { StarredSection } from './StarredSection';
import { AgentSection } from './AgentSection';
import { MembersDialog } from './MembersDialog';
import { ConnectGitDialog } from './ConnectGitDialog';
import { ResetToRemoteDialog } from '../git/ResetToRemoteDialog';
import { normalizeRepoUrlForDisplay } from './gitRepos';
import { ExportSettingsDialog } from '../export/ExportSettingsDialog';
import { SidebarResizeHandle } from './SidebarResizeHandle';
import { newPageTitleKey } from './slugUtils';
import { resolvePlusTargetDir, siblingsAtDir } from './treeUtils';
import { computeMoveToIndex } from './reorderPages';
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_WIDTH_KEY, clampSidebarWidth } from './sidebarWidth';
import { RecentChangesButton } from './RecentChangesButton';
import { useAssistantRun } from '../assistant/runState';
import { useAssistantUi } from '../assistant/AssistantHost';
import '../i18n/register';

/**
 * "Ask AI" sidebar entry point — split out from Sidebar itself only so
 * it can read useAssistantRun()'s `isRunning`: that hook needs an
 * AssistantRunProvider ancestor, and Sidebar is the one that renders that
 * provider (see below), so it can't call the hook in its own body.
 */
function AssistantButton() {
  const { t } = useTranslation('app');
  const { isRunning } = useAssistantRun();
  const { open, toggle } = useAssistantUi();
  const onToggle = toggle;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={t('assistant.chat.shortTitle')}
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-neutral-600 hover:bg-neutral-200/70 dark:text-neutral-300 dark:hover:bg-neutral-800"
    >
      <Sparkles size={15} aria-hidden="true" />
      <span>{t('assistant.chat.shortTitle')}</span>
      {/* Visible even while the panel itself is closed — a run keeps going server-side regardless. */}
      {isRunning && <Loader2 size={13} className="ml-auto shrink-0 animate-spin text-neutral-400" aria-hidden="true" />}
    </button>
  );
}

export interface SidebarProps {
  space: string;
  /**
   * Round 14: is the user's *desktop* (md+) collapse preference on? Shell
   * used to unmount Sidebar entirely for this; it's a CSS-only `md:hidden`
   * now (below) so the component stays mounted for the <md drawer to still
   * open from — otherwise a desktop "collapsed" choice, e.g. carried over in
   * localStorage from a resized browser window, would leave mobile with no
   * way to ever show the sidebar at all.
   */
  desktopCollapsed: boolean;
  /**
   * <md off-canvas drawer state, owned by Shell (plain useState, deliberately
   * NOT the `folio:sidebar-collapsed` flag above — see Shell.tsx's own
   * comment on why these two stay separate). Irrelevant at md+, where the
   * drawer positioning classes below don't apply at all.
   */
  mobileOpen: boolean;
  onMobileClose: () => void;
}

/** Resizable (round 8 follow-up), collapsible (by the parent Shell) left sidebar: space switcher + page tree. */
export function Sidebar({ space, desktopCollapsed, mobileOpen, onMobileClose }: SidebarProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  // Not useParams() here — see useActivePageId's docblock for why that
  // silently returns undefined for :id when called from Shell/Sidebar.
  const id = useActivePageId();
  const folderPath = useActiveFolderPath();
  const navigate = useNavigate();
  const showToast = useToast();
  const queryClient = useQueryClient();
  const role = useSpaceRole(space);
  const [managingMembers, setManagingMembers] = useState(false);
  // R23 tail: the space-level PDF header/footer dialog (space menu, admin-gated).
  const [editingExportSettings, setEditingExportSettings] = useState(false);
  // "Connect git" on a local space (owner ask, this round) — same admin gate
  // as the rest of this menu, see ConnectGitDialog's own doc comment.
  const [connectingGit, setConnectingGit] = useState(false);
  // "Take the version from Git" — same admin gate, see ResetToRemoteDialog.
  const [resettingToRemote, setResettingToRemote] = useState(false);
  // Raw stored value, clamped on every read — guards a corrupted/out-of-range
  // persisted width (e.g. from before min/max existed) without needing to
  // eagerly rewrite localStorage just because the sidebar rendered once.
  const [storedWidth, setStoredWidth] = useLocalStorage(SIDEBAR_WIDTH_KEY, SIDEBAR_DEFAULT_WIDTH);
  const width = clampSidebarWidth(storedWidth);

  // Cheap: shares the ['spaces'] cache with SpaceSwitcher/Breadcrumbs — this
  // is just to know whether a sync is already in flight server-side, to
  // disable the button (SpaceInfo.git.status === 'syncing').
  const { data: spacesData } = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces });
  const spaceGit = spacesData?.spaces.find((s) => s.slug === space)?.git;
  const gitStatus = spaceGit?.status;
  // Owner ask #1: "there is no link to the repository" — a normalized https url safe to
  // link to, or null when repoUrl is set but isn't a form this can confidently
  // reshape (see gitRepos.ts's own doc comment) — that case still shows the
  // raw value as inert text below, never a broken/misleading link.
  const repoDisplayUrl = spaceGit?.repoUrl ? normalizeRepoUrlForDisplay(spaceGit.repoUrl) : null;

  /**
   * Owner ask (22.09.2026): the top «+» must create in the CURRENT context —
   * the directory of whatever's open (root, if nothing/space-home is), and
   * INSIDE it when that's itself a container (folder or non-empty index
   * page) — not always at the space root the way this used to hardcode.
   * `resolvePlusTargetDir` (treeUtils.ts) is the single source of truth for
   * "which directory", shared with the pure test covering it; a raw
   * `api.getTree` call (not the `['tree', space]` query cache) so this never
   * acts on a stale tree mid-mutation.
   */
  async function currentPlusTargetDir(): Promise<string> {
    // Offline the cached tree stands in for the fresh one, and pages created
    // on this device are part of it: «+» on an open local page has to land
    // next to (or inside) THAT page.
    const tree = mergeLocalPages(await treeOfflineAware(queryClient, space), listLocalPages(), space);
    return resolvePlusTargetDir(tree.tree, id, folderPath);
  }

  /**
   * Owner ask, same round: "a new page must land after the current last
   * sibling" — a freshly created page has no explicit order yet, so left
   * alone it sorts alphabetically among its equally-unordered siblings
   * (reorderPages.ts's `sortSiblings`), not necessarily last. Re-fetches
   * (fresh siblings including the new page) and reuses `computeMoveToIndex`
   * — the exact same "move to the end" math a drag-to-the-end already does
   * (see reorderPages.ts's `computeDropPlan`'s "into" branch) — rather than
   * inventing a second "append" algorithm.
   */
  async function appendCreatedLast(page: PageMeta, targetDir: string): Promise<void> {
    const fresh = await api.getTree(space);
    const siblings = siblingsAtDir(fresh, targetDir);
    for (const { id: pageId, order } of computeMoveToIndex(siblings, page.id, siblings.length - 1)) {
      await api.reorderPage(pageId, order);
    }
  }

  const createRoot = useMutation({
    // React Query pauses a mutation while the browser says it is offline
    // (networkMode 'online', the default) — which is exactly when this one
    // has to run: it is what creates the page on this device.
    networkMode: 'always',
    mutationFn: async (kind: PageKind) => {
      const targetDir = await currentPlusTargetDir();
      const created = await createPageOfflineAware(queryClient, { space, parentPath: targetDir, title: t(newPageTitleKey(kind)), kind });
      // Ordering is a nicety on top of a page that already exists: a request
      // dropped by a bad connection must not turn a successful create into
      // an error toast. A local page is last by construction.
      if (!created.local) await appendCreatedLast(created.page, targetDir).catch(() => undefined);
      return created;
    },
    onSuccess: ({ page, local }) => {
      if (local) showToast(t('offline.createdLocally'), 'info');
      else queryClient.invalidateQueries({ queryKey: ['tree', space] });
      navigate(`/s/${space}/p/${page.id}`);
    },
    onError: (err) =>
      showToast(err instanceof OfflineUnsupportedError ? t('offline.unsupportedKind') : errorText(err, 'sidebar.createPageFailed')),
  });

  // "Upload a file" at the space root — TreeRow.tsx's own per-folder twin.
  // Same current-context/append-last treatment as createRoot above (owner
  // ask covers every item this menu offers, upload included).
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadFileRoot = useMutation({
    mutationFn: async (file: File) => {
      const targetDir = await currentPlusTargetDir();
      const page = await api.uploadFile(space, targetDir, file);
      await appendCreatedLast(page, targetDir);
      return page;
    },
    onSuccess: (page) => {
      queryClient.invalidateQueries({ queryKey: ['tree', space] });
      navigate(`/s/${space}/p/${page.id}`);
    },
    onError: (err) => showToast(errorText(err, 'sidebar.uploadPdfFailed')),
  });

  const sync = useMutation({
    mutationFn: () => api.syncSpace(space),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['spaces'] }),
    onSuccess: (result) => {
      if (result.git.status === 'error' || result.git.status === 'conflict') {
        showToast(result.git.lastError ?? t('sidebar.syncFailed'));
      } else {
        showToast(t('admin.spaces.syncComplete'), 'info');
      }
    },
    onError: (err) => showToast(errorText(err, 'sidebar.syncFailed')),
  });

  // Round 5: "create from template" — _templates/ folder as the source, see
  // templates/useTemplates.ts. Only fetched/shown for editor+ (same gate as
  // the plain create actions right below).
  const { templates } = useTemplates(space);
  const createFromTemplate = useCreateFromTemplate(
    space,
    (page) => navigate(`/s/${space}/p/${page.id}`),
    (message) => showToast(message),
  );

  // Round 14 off-canvas drawer, <md only: `left` (not `transform`) drives
  // the slide below — a transform on the <aside>, including the identity
  // `translate-x-0` "open" state, would make it a containing block for its
  // own `position: fixed` descendants (MembersDialog/CreateSpaceDialog, via
  // ui/Modal.tsx), pinning THEIR full-screen backdrops to the drawer's own
  // box instead of the viewport. Plain `left` has no such side effect.
  return (
    <>
      {/* Always mounted — see TreeRow.tsx's identical input for why it can't
          live inside the Menu's own conditionally-rendered children. */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.docx,.xlsx,.pptx"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) uploadFileRoot.mutate(file);
        }}
      />
      {mobileOpen && (
        // md:hidden so this can never linger as an invisible full-screen
        // click-blocker at desktop widths even though `mobileOpen` itself
        // isn't viewport-aware (see Shell.tsx: it toggles unconditionally).
        <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={onMobileClose} aria-hidden="true" />
      )}
      <aside
        data-folio-sidebar=""
        style={{ '--sidebar-w': `${width}px` } as CSSProperties}
        // Round 22 (owner prod QA, drawer-see-through fix): bg-neutral-50/60
        // dark:bg-neutral-950/40 below is a translucent TINT, correct only
        // when something opaque already sits directly behind it — true at
        // md+, where this <aside> is `position: relative` in normal flow
        // next to Shell's own solid `bg-white dark:bg-neutral-950` root. The
        // <md drawer instead makes it `position: fixed`, floating this panel
        // directly over the routed page content with nothing solid behind it
        // — through a translucent background, that content visibly showed
        // through the tree. max-md:bg-white/dark:max-md:bg-neutral-950 pin it
        // fully opaque (matching Shell's own root colors exactly) ONLY at
        // that breakpoint, leaving the md+ tint untouched.
        className={`flex h-full flex-col border-r border-neutral-200 bg-neutral-50/60 dark:border-neutral-800 dark:bg-neutral-950/40 ${
          desktopCollapsed ? 'md:hidden' : 'md:flex'
        } max-md:fixed max-md:inset-y-0 max-md:z-50 max-md:w-[85vw] max-md:max-w-80 max-md:bg-white max-md:shadow-xl max-md:transition-[left] max-md:duration-200 max-md:ease-out dark:max-md:bg-neutral-950 ${
          mobileOpen ? 'max-md:left-0' : 'max-md:-left-full'
        } md:relative md:w-[var(--sidebar-w)] md:shrink-0`}
      >
        <div className="flex h-14 shrink-0 items-center gap-1 border-b border-neutral-200 px-3 dark:border-neutral-800">
          <SpaceSwitcher current={space} />
          {/* Round 8: moved here from the header — see Header.tsx's docblock for why. */}
          <StarButton kind="space" id={space} />
          {canManageMembers(role) && (
            <Menu triggerLabel={t('sidebar.spaceMenu.label')} className="shrink-0" trigger={<Settings size={15} />}>
              {(close) => (
                <>
                  <MenuItem
                    icon={<Users size={14} />}
                    onSelect={() => {
                      close();
                      setManagingMembers(true);
                    }}
                  >
                    {t('members.menuLabel')}
                  </MenuItem>
                  <MenuItem
                    icon={<RefreshCw size={14} className={sync.isPending ? 'animate-spin' : undefined} />}
                    disabled={sync.isPending || gitStatus === 'syncing'}
                    onSelect={() => {
                      close();
                      sync.mutate();
                    }}
                  >
                    {sync.isPending || gitStatus === 'syncing' ? t('git.status.syncing') : t('sidebar.spaceMenu.sync')}
                  </MenuItem>
                  {/* Owner ask #1: "there is no link to the repository" — only for a
                      space that HAS one (repoUrl set). A form we can't
                      confidently reshape into a safe https link (gitRepos.ts's
                      normalizeRepoUrlForDisplay) still shows the raw value —
                      as inert, disabled text, never a broken/misleading link. */}
                  {spaceGit?.repoUrl &&
                    (repoDisplayUrl ? (
                      <MenuItem
                        icon={<ExternalLink size={14} />}
                        onSelect={() => {
                          close();
                          window.open(repoDisplayUrl, '_blank', 'noopener,noreferrer');
                        }}
                      >
                        {t('sidebar.spaceMenu.openRepo')}
                      </MenuItem>
                    ) : (
                      <MenuItem icon={<ExternalLink size={14} />} disabled onSelect={() => {}}>
                        {spaceGit.repoUrl}
                      </MenuItem>
                    ))}
                  {/* Owner ask #2: "git cannot be connected to a local space" —
                      only for a space that does NOT have one yet. See
                      ConnectGitDialog's doc comment for why this only ever
                      succeeds against an EMPTY remote. */}
                  {spaceGit && !spaceGit.repoUrl && (
                    <MenuItem
                      icon={<GitBranch size={14} />}
                      onSelect={() => {
                        close();
                        setConnectingGit(true);
                      }}
                    >
                      {t('sidebar.spaceMenu.connectGit')}
                    </MenuItem>
                  )}
                  {/* "Take the version from Git" — owner ask: nobody is ever going to
                      resolve this space's git conflicts by hand, so offer a
                      one-click "throw away local state, match remote" instead.
                      Available whenever a remote exists (not gated on
                      gitStatus === 'conflict'/'error' — see ConflictBanner for
                      the more PROMINENT surfacing of the same action while
                      something's actually broken). Same admin gate as every
                      other item in this menu (canManageMembers above). */}
                  {spaceGit?.repoUrl && (
                    <MenuItem
                      icon={<RotateCcw size={14} />}
                      onSelect={() => {
                        close();
                        setResettingToRemote(true);
                      }}
                    >
                      {t('git.resetToRemote.menuLabel')}
                    </MenuItem>
                  )}
                  {/* R23 tail (headers and footers): space-level PDF header/footer.
                      Lives HERE and not in the per-page export menu because
                      it is a setting of the whole space (one value for every
                      page's PDF) and admin-gated like its menu neighbors —
                      the export menu is per-page, viewer-level and already
                      crowded. Server enforces the same gate (requireSpaceRole
                      'admin' on /api/spaces/:space/export-settings). */}
                  <MenuItem
                    icon={<Printer size={14} />}
                    onSelect={() => {
                      close();
                      setEditingExportSettings(true);
                    }}
                  >
                    {t('sidebar.spaceMenu.exportSettings')}
                  </MenuItem>
                  {/* Trash round: this space's trash — same /trash page the user
                      menu's admin section opens, pre-filtered to this space.
                      Gated by the same canManageMembers (= space admin) check
                      the whole menu already sits behind. */}
                  <MenuItem
                    icon={<Trash2 size={14} />}
                    onSelect={() => {
                      close();
                      navigate(`/trash?space=${encodeURIComponent(space)}`);
                    }}
                  >
                    {t('trash.title')}
                  </MenuItem>
                </>
              )}
            </Menu>
          )}
          {canEditContent(role) && (
            <Menu triggerLabel={t('sidebar.newPageMenu.label')} className="shrink-0" trigger={<Plus size={15} />}>
              {(close) => (
                <>
                  <MenuItem
                    icon={<FileText size={14} />}
                    onSelect={() => {
                      close();
                      createRoot.mutate('doc');
                    }}
                  >
                    {t('sidebar.newPage')}
                  </MenuItem>
                  <MenuItem
                    icon={<LayoutDashboard size={14} />}
                    onSelect={() => {
                      close();
                      createRoot.mutate('board');
                    }}
                  >
                    {t('sidebar.newBoard')}
                  </MenuItem>
                  {/* Round 26 (DATA TABLES) — the root-level twin of TreeRow's
                      own "+ Data table". */}
                  <MenuItem
                    icon={<Table2 size={14} />}
                    onSelect={() => {
                      close();
                      createRoot.mutate('table');
                    }}
                  >
                    {t('sidebar.newTable')}
                  </MenuItem>
                  {/* Round FORMS — the root-level twin of TreeRow's own "+ Form". */}
                  <MenuItem
                    icon={<ClipboardList size={14} />}
                    onSelect={() => {
                      close();
                      createRoot.mutate('form');
                    }}
                  >
                    {t('sidebar.newForm')}
                  </MenuItem>
                  <MenuItem
                    icon={<Upload size={14} />}
                    onSelect={() => {
                      close();
                      fileInputRef.current?.click();
                    }}
                  >
                    {t('sidebar.uploadFile')}
                  </MenuItem>
                  {templates.length > 0 && (
                    <>
                      <div className="my-1 border-t border-neutral-200 dark:border-neutral-700" />
                      {templates.map((template) => (
                        <MenuItem
                          key={template.id}
                          icon={<LayoutTemplate size={14} />}
                          onSelect={() => {
                            close();
                            // Current-context target dir, same as the plain
                            // create actions above — not append-last though:
                            // that's this hook's own onSuccess (shared with
                            // TreeRow's row-level template create, which this
                            // round leaves untouched), not something to
                            // special-case per call site.
                            void currentPlusTargetDir().then((targetDir) => {
                              createFromTemplate.mutate({ template, parentPath: targetDir });
                            });
                          }}
                        >
                          {t('sidebar.fromTemplate', { title: template.title })}
                        </MenuItem>
                      ))}
                    </>
                  )}
                </>
              )}
            </Menu>
          )}
        </div>

        <button
          type="button"
          onClick={() => navigate(`/s/${space}`)}
          // py-2 md:py-1.5: touch-target floor (round 14), pared back in
          // round 25 after owner feedback that R14's ≥40px rows read as
          // "very stretched" — 36px tall on <md (8px padding + text-sm's
          // 20px line-height, both sides) vs. 32px at md+ (py-1.5), still
          // roomier for touch without the full 40px floor. Font-size
          // untouched (text-sm both breakpoints).
          className={`mx-2 mt-2 flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm md:py-1.5 ${
            !id
              ? 'bg-neutral-200/70 font-medium text-neutral-900 dark:bg-neutral-700/60 dark:text-neutral-50'
              : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800/70'
          }`}
        >
          <House size={14} className="opacity-60" aria-hidden="true" />
          {t('sidebar.spaceHome')}
        </button>

        <StarredSection space={space} />

        <nav className="mt-2 flex-1 overflow-y-auto px-2 pb-3" aria-label={t('sidebar.tree.label')}>
          <PageTree space={space} activeId={id} activeFolderPath={folderPath} canEdit={canEditContent(role)} />
          {/* .agent — admin-only rules pages for the AI assistant (owner spec,
              21.09.2026). Own section, own icon, never mixed into the normal
              tree above (PageTree excludes it) — and never rendered at all for
              anyone below space admin, matching what the server already hides. */}
          {canManageMembers(role) && <AgentSection space={space} activeId={id} activeFolderPath={folderPath} />}
        </nav>

        {canEditContent(role) && <RecentChangesButton space={space} />}

        {/* One provider for both the button's spinner and the panel below — a run is a
            server-side task now (05.09.2026), tracked independently of whether the panel
            is open, so the button must be able to show it's running even while closed. */}
        {/* The panel and its run tracking live in AssistantHost (App level), so page
            and space navigation never remounts or closes them; this is just the toggle. */}
        <div className="shrink-0 border-t border-neutral-200 px-2 py-1.5 dark:border-neutral-800">
          <AssistantButton />
        </div>

        <UserMenu space={space} />

        {managingMembers && <MembersDialog space={space} onClose={() => setManagingMembers(false)} />}

        {editingExportSettings && <ExportSettingsDialog space={space} onClose={() => setEditingExportSettings(false)} />}

        {connectingGit && <ConnectGitDialog space={space} onClose={() => setConnectingGit(false)} />}

        {resettingToRemote && <ResetToRemoteDialog space={space} onClose={() => setResettingToRemote(false)} />}

        {/* Round 14: drag-to-resize is a desktop-only affordance — <md has no room for it, and the drawer's own width isn't user-resizable. */}
        <div className="hidden md:block">
          <SidebarResizeHandle width={width} onResize={setStoredWidth} />
        </div>
      </aside>
    </>
  );
}
