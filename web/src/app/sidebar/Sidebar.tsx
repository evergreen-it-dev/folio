import { useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  ClipboardList,
  ExternalLink,
  FileText,
  FolderTree,
  GitBranch,
  Globe,
  KeyRound,
  Image as ImageIcon,
  LayoutDashboard,
  LayoutTemplate,
  Loader2,
  Plus,
  Palette,
  RefreshCw,
  RotateCcw,
  Settings,
  Sparkles,
  House,
  Table2,
  Trash2,
  Upload,
  Users,
  Database,
  AppWindow,
  Search,
  GitPullRequest,
} from 'lucide-react';
import type { PageKind, PageMeta } from '@shared/contracts';
import { emptySearchQuery, formatSearchQuery } from '@shared/searchQuery';
import { api, type TreeResponse } from '../api';
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
import { TemplatePickerDialog } from '../templates/TemplatePickerDialog';
import { TemplatesSection } from '../templates/TemplatesSection';
import { useConnectivity } from '../offline/connectivity';
import { StarButton } from '../header/StarButton';
import { SpaceSwitcher } from './SpaceSwitcher';
import { PageTree } from './PageTree';
import { StarredSection } from './StarredSection';
import { AgentSection } from './AgentSection';
import { TagsSection } from './TagsSection';
import { GraphLink } from './GraphLink';
import { RowIconBox, kindIconProps } from './PageGlyph';
import { SectionLabel } from './SectionLabel';
import { MembersDialog } from './MembersDialog';
import { ConnectGitDialog } from './ConnectGitDialog';
import { ImageStorageDialog } from './ImageStorageDialog';
import { ScanSettingsDialog } from './ScanSettingsDialog';
import { AgentSettingsDialog } from './AgentSettingsDialog';
import { ReviewQueueButton } from '../review/ReviewQueueButton';
import { ResetToRemoteDialog } from '../git/ResetToRemoteDialog';
import { normalizeRepoUrlForDisplay } from './gitRepos';
import { SpaceAssistantKeyDialog } from './SpaceAssistantKeyDialog';
import { PublishSpaceDialog } from './PublishSpaceDialog';
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
      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] leading-5 text-neutral-700 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-white/[0.06]"
    >
      <Sparkles size={14} className="text-violet-600 dark:text-violet-400" aria-hidden="true" />
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
  /**
   * Opens the Cmd+K quick switcher, optionally with a query already typed (the Tags section opens it with `tag:<tag>`).
   * Owned by Shell, which holds the switcher; optional so a host without one simply gets no tag shortcut.
   */
  onOpenSwitcher?: (query?: string) => void;
}

// Obsidian Bases: the "New base" dialog (name, location, starting point) — lazy, its YAML writer stays out of the main chunk.
import { NewBaseDialog, preloadNewBaseDialog } from '../../bases/lazyNewBase';
// Artifacts: the import dialog (link / file / pasted HTML).
import { ArtifactImportDialog } from '../../artifact/ArtifactImportDialog';

/** Resizable (round 8 follow-up), collapsible (by the parent Shell) left sidebar: space switcher + page tree. */
export function Sidebar({ space, desktopCollapsed, mobileOpen, onMobileClose, onOpenSwitcher }: SidebarProps) {
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
  const [editingAssistantKey, setEditingAssistantKey] = useState(false);
  const [publishing, setPublishing] = useState(false);
  // "New base" dialog: the directory it opens on (the current context, like every other «+» item), or null when closed.
  const [newBaseDir, setNewBaseDir] = useState<string | null>(null);
  // "New artifact" dialog: same idea — the current-context directory, or null when closed.
  const [newArtifactDir, setNewArtifactDir] = useState<string | null>(null);
  // Space setting: where pasted/uploaded images go (Folio storage vs. assets/ in the repository).
  const [editingImageStorage, setEditingImageStorage] = useState(false);
  const [editingScanSettings, setEditingScanSettings] = useState(false);
  // Space setting: do agents write straight into pages or hand their edits over for review (migration 062).
  const [editingAgentSettings, setEditingAgentSettings] = useState(false);
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

  /** The same target from the tree already in the cache (null when there is none): for a dialog that must open at once. */
  function cachedPlusTargetDir(): string | null {
    const cached = queryClient.getQueryData<TreeResponse>(['tree', space]);
    return cached ? resolvePlusTargetDir(mergeLocalPages(cached, listLocalPages(), space).tree, id, folderPath) : null;
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

  // "From template…": the picker dialog (templates/TemplatePickerDialog.tsx) and the directory it creates in, or null when closed.
  // Creating from a template is a server operation, so it waits for a connection.
  const [templatePickerDir, setTemplatePickerDir] = useState<string | null>(null);
  const offline = useConnectivity() === 'offline';

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
        className={`flex h-full flex-col border-r border-neutral-200 bg-neutral-100/70 dark:border-neutral-800 dark:bg-neutral-900/50 ${
          desktopCollapsed ? 'md:hidden' : 'md:flex'
        } max-md:fixed max-md:inset-y-0 max-md:z-50 max-md:w-[85vw] max-md:max-w-80 max-md:bg-white max-md:shadow-xl max-md:transition-[left] max-md:duration-200 max-md:ease-out dark:max-md:bg-neutral-950 ${
          mobileOpen ? 'max-md:left-0' : 'max-md:-left-full'
        } md:relative md:w-[var(--sidebar-w)] md:shrink-0`}
      >
        <div className="flex h-12 shrink-0 items-center gap-0.5 px-2">
          <SpaceSwitcher current={space} />
          {/* Round 8: moved here from the header — see Header.tsx's docblock for why. */}
          <StarButton kind="space" id={space} />
          {/* 16.10.2026: editors get the menu too, for "Sync now" and the repository link; every other item stays space-admin. */}
          {canEditContent(role) && (
            <Menu triggerLabel={t('sidebar.spaceMenu.label')} className="shrink-0" trigger={<Settings size={15} />}>
              {(close) => (
                <>
                  {canManageMembers(role) && (
                    <MenuItem
                      icon={<Users size={14} />}
                      onSelect={() => {
                        close();
                        setManagingMembers(true);
                      }}
                    >
                      {t('members.menuLabel')}
                    </MenuItem>
                  )}
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
                  {canManageMembers(role) && (
                    <>
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
                  {/* 14.10.2026: "Site & PDF settings" — one page (/s/:space/settings) for the space's SEO,
                      the public site's CSS and the PDF header/footer (it replaced the PDF-only dialog).
                      Space-level and admin-gated like its menu neighbors; the server enforces the same
                      gate on /api/spaces/:space/appearance. */}
                  <MenuItem
                    icon={<Palette size={14} />}
                    onSelect={() => {
                      close();
                      navigate(`/s/${encodeURIComponent(space)}/settings`);
                    }}
                  >
                    {t('sidebar.spaceMenu.siteSettings')}
                  </MenuItem>
                  {/* The space's own Folio AI (Cursor) key: members without a personal
                      key chat with the assistant on it. Space-admin gate like its
                      neighbors; the server checks canAdministerSpace on
                      /api/spaces/:space/assistant-key. */}
                  <MenuItem
                    icon={<KeyRound size={14} />}
                    onSelect={() => {
                      close();
                      setEditingAssistantKey(true);
                    }}
                  >
                    {t('sidebar.spaceMenu.assistantKey')}
                  </MenuItem>
                  {/* Publish the space as a public website: visibility (private / instance /
                      public), the site's subdomain / custom domain and its visitor opt-ins.
                      Space-admin gate like its neighbors; the server checks canAdministerSpace
                      on /api/spaces/:space/public-settings. */}
                  <MenuItem
                    icon={<Globe size={14} />}
                    onSelect={() => {
                      close();
                      setPublishing(true);
                    }}
                  >
                    {t('sidebar.spaceMenu.publish')}
                  </MenuItem>
                  <MenuItem
                    icon={<ImageIcon size={14} />}
                    onSelect={() => {
                      close();
                      setEditingImageStorage(true);
                    }}
                  >
                    {t('sidebar.spaceMenu.imageStorage')}
                  </MenuItem>
                  {/* Which top-level files and folders the scan skips, and the light-footprint flag (Obsidian vaults). Space admins, like its neighbors; the API checks the role too. */}
                  <MenuItem
                    icon={<FolderTree size={14} />}
                    onSelect={() => {
                      close();
                      setEditingScanSettings(true);
                    }}
                  >
                    {t('sidebar.spaceMenu.scanSettings')}
                  </MenuItem>
                  {/* Agent write mode: direct, or review (an editor accepts what agents write). Space admins; the API checks the role too. */}
                  <MenuItem
                    icon={<GitPullRequest size={14} />}
                    onSelect={() => {
                      close();
                      setEditingAgentSettings(true);
                    }}
                  >
                    {t('sidebar.spaceMenu.agentSettings')}
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
                  {/* Obsidian Bases — a view over pages (`.base`), opened in its editor-less starter view. */}
                  <MenuItem
                    icon={<Database size={14} />}
                    onPreload={() => void preloadNewBaseDialog()}
                    onSelect={() => {
                      close();
                      // Same current-context target as the other items, shown in the dialog (and changeable there).
                      // The dialog opens at once: from the cached tree when there is one, else after the fetch.
                      const cached = cachedPlusTargetDir();
                      if (cached !== null) setNewBaseDir(cached);
                      else void currentPlusTargetDir().then(setNewBaseDir, () => setNewBaseDir(''));
                    }}
                  >
                    {t('sidebar.newBase')}
                  </MenuItem>
                  {/* Artifacts — a Claude artifact, Cursor canvas or any HTML page, imported from a link, a file or pasted HTML. */}
                  <MenuItem
                    icon={<AppWindow size={14} />}
                    onSelect={() => {
                      close();
                      const cached = cachedPlusTargetDir();
                      if (cached !== null) setNewArtifactDir(cached);
                      else void currentPlusTargetDir().then(setNewArtifactDir, () => setNewArtifactDir(''));
                    }}
                  >
                    {t('sidebar.newArtifact')}
                  </MenuItem>
                  {/* Any kind of template from the space's _templates/ folder, picked in a dialog; same current-context target as the other items. */}
                  <MenuItem
                    icon={<LayoutTemplate size={14} />}
                    disabled={offline}
                    title={offline ? t('sidebar.templates.offlineHint') : undefined}
                    onSelect={() => {
                      close();
                      const cached = cachedPlusTargetDir();
                      if (cached !== null) setTemplatePickerDir(cached);
                      else void currentPlusTargetDir().then(setTemplatePickerDir, () => setTemplatePickerDir(''));
                    }}
                  >
                    {t('sidebar.fromTemplate')}
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
                </>
              )}
            </Menu>
          )}
        </div>

        {/* Desktop search entry (the header search is hidden at md+): opens the quick switcher. */}
        <button
          type="button"
          data-tour="search"
          onClick={() => {
            onMobileClose();
            onOpenSwitcher?.();
          }}
          className="mx-2 mt-1 flex items-center gap-2 rounded-md py-2 pl-1 pr-2 text-left text-[13px] leading-5 text-neutral-800 hover:bg-neutral-200/60 md:py-[3px] dark:text-neutral-200 dark:hover:bg-white/[0.06]"
        >
          <RowIconBox>
            <Search {...kindIconProps} />
          </RowIconBox>
          <span className="min-w-0 flex-1 truncate">{t('sidebar.search')}</span>
          <kbd className="shrink-0 font-sans text-[11px] text-neutral-400 max-md:hidden">
            {/Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent) ? '⌘K' : 'Ctrl+K'}
          </kbd>
        </button>

        <button
          type="button"
          onClick={() => navigate(`/s/${space}`)}
          // py-2 md:py-[3px]: the touch-target floor on <md (round 14/25), the dense 26px row at md+.
          className={`mx-2 mt-px flex items-center gap-2 rounded-md py-2 pl-1 pr-2 text-left text-[13px] leading-5 md:py-[3px] ${
            !id
              ? 'bg-white font-medium text-neutral-950 shadow-[0_1px_2px_rgb(0_0_0/0.06)] ring-1 ring-neutral-200/90 dark:bg-white/[0.08] dark:text-white dark:shadow-none dark:ring-white/10'
              : 'text-neutral-800 hover:bg-neutral-200/60 dark:text-neutral-200 dark:hover:bg-white/[0.06]'
          }`}
        >
          <RowIconBox>
            <House {...kindIconProps} />
          </RowIconBox>
          <span className="min-w-0 flex-1 truncate">{t('sidebar.spaceHome')}</span>
        </button>

        <StarredSection space={space} />

        <nav className="mt-4 flex-1 overflow-y-auto px-2 pb-3" aria-label={t('sidebar.tree.label')}>
          <SectionLabel>{t('sidebar.tree.title')}</SectionLabel>
          <PageTree space={space} activeId={id} activeFolderPath={folderPath} canEdit={canEditContent(role)} />
          {/* .agent — admin-only rules pages for the AI assistant (owner spec,
              21.09.2026). Own section, own icon, never mixed into the normal
              tree above (PageTree excludes it) — and never rendered at all for
              anyone below space admin, matching what the server already hides. */}
          <div className="mt-4 flex flex-col gap-px">
          {/* Custom page templates (the `_templates/` folder), editors only; collapsed until opened. */}
          {canEditContent(role) && <TemplatesSection space={space} activeId={id} activeFolderPath={folderPath} />}
          {canManageMembers(role) && <AgentSection space={space} activeId={id} activeFolderPath={folderPath} />}
          {/* Obsidian wave 3: the space's tags as a tree; a click searches the tag in the quick switcher. */}
          <TagsSection
            space={space}
            canEdit={canEditContent(role)}
            onOpenTag={(tag) => {
              onMobileClose();
              onOpenSwitcher?.(formatSearchQuery({ ...emptySearchQuery(), tags: [tag] }));
            }}
          />
          <GraphLink space={space} onNavigate={onMobileClose} />
          </div>
        </nav>


        {/* One provider for both the button's spinner and the panel below — a run is a
            server-side task now (05.09.2026), tracked independently of whether the panel
            is open, so the button must be able to show it's running even while closed. */}
        {/* The panel and its run tracking live in AssistantHost (App level), so page
            and space navigation never remounts or closes them; this is just the toggle. */}
        <div className="flex shrink-0 flex-col gap-px border-t border-neutral-200 px-2 py-1.5 dark:border-neutral-800">
          <ReviewQueueButton space={space} onNavigate={onMobileClose} />
          {canEditContent(role) && <RecentChangesButton space={space} />}
          <AssistantButton />
        </div>

        <UserMenu space={space} />

        {managingMembers && <MembersDialog space={space} onClose={() => setManagingMembers(false)} />}


        {editingAssistantKey && <SpaceAssistantKeyDialog space={space} onClose={() => setEditingAssistantKey(false)} />}

        {publishing && <PublishSpaceDialog space={space} onClose={() => setPublishing(false)} />}
        {newBaseDir !== null && <NewBaseDialog space={space} initialParentPath={newBaseDir} onClose={() => setNewBaseDir(null)} />}
        {newArtifactDir !== null && <ArtifactImportDialog space={space} initialParentPath={newArtifactDir} onClose={() => setNewArtifactDir(null)} />}
        {templatePickerDir !== null && (
          <TemplatePickerDialog
            space={space}
            parentPath={templatePickerDir}
            onClose={() => setTemplatePickerDir(null)}
            onCreated={(page) => navigate(`/s/${space}/p/${page.id}`)}
          />
        )}
        {editingImageStorage && <ImageStorageDialog space={space} onClose={() => setEditingImageStorage(false)} />}
        {editingScanSettings && <ScanSettingsDialog space={space} onClose={() => setEditingScanSettings(false)} />}
        {editingAgentSettings && <AgentSettingsDialog space={space} onClose={() => setEditingAgentSettings(false)} />}

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
