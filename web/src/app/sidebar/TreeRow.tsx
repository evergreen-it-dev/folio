import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ClipboardList, CloudOff, Copy, CopyPlus, Files, FileText, FileType2, Folder, LayoutDashboard, LayoutTemplate, Link as LinkIcon, MoreHorizontal, Move, Pencil, Plus, Presentation, Sheet, Table2, Trash2, Upload } from 'lucide-react';
import { officeFormat, type PageKind, type PageMeta, type TreeNode } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { Menu, MenuItem } from '../ui/Menu';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/Toast';
import { OfflineUnsupportedError, createPageOfflineAware } from '../offline/createPage';
import { discardLocalPage, useIsLocalPage } from '../offline/localPages';
import { clearPersistedState } from '../offline/ydocPersistence';
import { useTemplates, useCreateFromTemplate } from '../templates/useTemplates';
import { MoveDialog } from './MoveDialog';
import { CopyDialog } from './CopyDialog';
import { ChangeSlugDialog } from './ChangeSlugDialog';
import { newPageTitleKey } from './slugUtils';
import { canContain, canReorder, computeDropPlan, computeReorder, dropZoneFor } from './reorderPages';
import type { DropPlan, DropZone, ReorderDirection } from './reorderPages';
import { childDirOf, dirname, findNodeByPath, treeNodeDisplayTitle } from './treeUtils';
import '../i18n/register';

/** The row currently being dragged, as every other row needs to see it. */
export interface DraggedNode {
  node: TreeNode;
  /** Directory the dragged node's own file lives in — its tree level. */
  parentPath: string;
}

/** How long a collapsed row must be hovered mid-drag before it springs open. */
const SPRING_OPEN_MS = 600;

export interface TreeRowProps {
  node: TreeNode;
  space: string;
  depth: number;
  activeId: string | undefined;
  /** Path of the folder currently open at /s/:space/d/*, if any — folder rows have no real id to match against activeId. */
  activeFolderPath: string | undefined;
  expanded: Set<string>;
  setExpanded: (updater: (prev: Set<string>) => Set<string>) => void;
  /** All in-use directories in the space, for the move dialog's parent picker. */
  directories: string[];
  /**
   * The full sibling array `node` lives in (i.e. the list this row is being
   * mapped from — either the tree's top level, or a parent TreeRow's own
   * `node.children`), for Up/Down reordering (round 22, SHELL-1). See
   * reorderPages.ts for why folders among these siblings are skipped rather
   * than reordered.
   */
  siblings: TreeNode[];
  /**
   * Directory this row's own file lives in — i.e. the tree level it is
   * rendered at. Threaded from the parent rather than derived here because
   * a folder node's `path` IS its directory while a page's is a file in
   * one, and drag-and-drop has to compare the two kinds against each other.
   */
  parentPath: string;
  /** The row being dragged anywhere in this tree, or null. Owned by PageTree. */
  dragged: DraggedNode | null;
  setDragged: (dragged: DraggedNode | null) => void;
  /** My role in this space is editor+ — hides create/rename/move/delete entirely (not just disables) for viewers, per DEV-PLAN Round 2. */
  canEdit: boolean;
  /** Page ids with unresolved git conflict markers in their own file (SpaceGitInfo.conflicts) — draws a small warning dot next to the row's title. Owned by PageTree, threaded down unchanged. */
  conflictedIds: Set<string>;
}

/** One page-tree row, recursively rendering its children when expanded. */
export function TreeRow({
  node,
  space,
  depth,
  activeId,
  activeFolderPath,
  expanded,
  setExpanded,
  directories,
  siblings,
  parentPath,
  dragged,
  setDragged,
  canEdit,
  conflictedIds,
}: TreeRowProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const showToast = useToast();

  const [editing, setEditing] = useState(false);
  const [renameValue, setRenameValue] = useState(node.title);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [moving, setMoving] = useState(false);
  const [copying, setCopying] = useState(false);
  const [changingSlug, setChangingSlug] = useState(false);
  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  const committedRef = useRef(false);
  const springOpenRef = useRef<number | null>(null);

  const isOpen = expanded.has(node.id);
  const hasChildren = node.children.length > 0;
  // Folder nodes are synthetic (server-computed listings, no real page id —
  // "never call page APIs with those ids"): navigation, active-highlight,
  // and every content-mutating affordance below all branch on this.
  const isFolder = node.kind === 'folder';
  const isActive = isFolder ? activeFolderPath === node.path : activeId === node.id;
  const displayTitle = treeNodeDisplayTitle(node, siblings);
  const href = isFolder ? `/s/${space}/d/${node.path}` : `/s/${space}/p/${node.id}`;
  // Round 5: frontmatter icon (emoji) takes over the row's icon slot when
  // set — display-only here (editing happens from the page header's picker,
  // PageChrome.tsx; this row's own click already means "navigate", and a
  // second, independently-clickable target crammed into the same dense row
  // was a scope call made against that, not a technical limitation).
  //
  // Round 14 (owner QA on a real tree): a plain doc with no frontmatter icon
  // used to fall back to a generic gray FileText glyph on every such row —
  // repeated down a tree that's mostly plain docs, it read as visual noise
  // rather than information, unlike Folder/LayoutDashboard below, which
  // actually distinguish a row's KIND rather than just filling an empty
  // slot. That case renders nothing now, but keeps the identical 14px-wide
  // slot (matching the icon/emoji spans below) so plain-vs-iconed rows
  // still line up — only the glyph disappears, not the tree's horizontal
  // rhythm.
  const iconNode = isFolder ? (
    <Folder size={14} className="shrink-0 opacity-60" aria-hidden="true" />
  ) : node.icon ? (
    <span className="w-[14px] text-center text-[13px] leading-none">{node.icon}</span>
  ) : node.kind === 'board' ? (
    <LayoutDashboard size={14} className="shrink-0 opacity-60" aria-hidden="true" />
  ) : node.kind === 'table' ? (
    // Round 26: like Folder/LayoutDashboard, this glyph distinguishes the
    // row's KIND — which is exactly the test the round-14 note below applies
    // (a plain doc renders nothing precisely because its glyph carried no
    // information; a data table's does).
    <Table2 size={14} className="shrink-0 opacity-60" aria-hidden="true" />
  ) : node.kind === 'pdf' ? (
    // Same reasoning as board/table above — a pdf page is read-only and
    // very visually different once opened, so its row gets its own glyph.
    <FileType2 size={14} className="shrink-0 opacity-60" aria-hidden="true" />
  ) : node.kind === 'office' ? (
    // Round OFFICE: same reasoning as pdf above, one glyph per actual format
    // (officeFormat) so a docx/xlsx/pptx row reads apart at a glance.
    officeFormat(node.path) === 'xlsx' ? (
      <Sheet size={14} className="shrink-0 opacity-60" aria-hidden="true" />
    ) : officeFormat(node.path) === 'pptx' ? (
      <Presentation size={14} className="shrink-0 opacity-60" aria-hidden="true" />
    ) : (
      <FileText size={14} className="shrink-0 opacity-60" aria-hidden="true" />
    )
  ) : node.kind === 'form' ? (
    // Round FORMS: same reasoning as board/table above.
    <ClipboardList size={14} className="shrink-0 opacity-60" aria-hidden="true" />
  ) : (
    <span className="w-[14px] shrink-0" aria-hidden="true" />
  );

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['tree', space] });
    queryClient.invalidateQueries({ queryKey: ['page', node.id] });
  }

  /**
   * QA-3 P2 #6: this used to pass `dirname(node.path)` — the directory the
   * row's own file lives in — for every row. On a directory index that is
   * right (an index page IS its directory, so its children are that
   * directory's entries), but on a LEAF page it made "+ Add a page"
   * create a SIBLING: for a root-level `x.md` the new page landed at the
   * space root, while the mutation's name and its onSuccess (which expanded
   * this row, as if a child had appeared under it) both said otherwise.
   * A leaf page could not be given a child through the UI at all.
   *
   * childDirOf mirrors the server's own model (see treeUtils.ts), so a child
   * of `x.md` is created in `x/` — the `X.md` + `X/` shape the repo format
   * already has and which server/storage.ts's getSubtree, `::pagetree`,
   * exports and the folder listing all read as real nesting.
   *
   * The row to expand afterwards is then whichever node now HOLDS the new
   * page, looked up in the refetched tree rather than assumed to be this
   * one. After the refetch getTree merges `x.md` + `x/` into the original
   * page row; the fallback to node.id therefore opens that row. The folder
   * lookup remains useful for a genuine directory that has no page of its
   * own.
   */
  async function revealAndOpen(page: PageMeta) {
    queryClient.invalidateQueries({ queryKey: ['page', node.id] });
    const fresh = await queryClient.fetchQuery({ queryKey: ['tree', space], queryFn: () => api.getTree(space) });
    const holder = findNodeByPath(fresh.tree, dirname(page.path));
    setExpanded((prev) => new Set(prev).add(holder?.id ?? node.id));
    navigate(`/s/${space}/p/${page.id}`);
  }

  /** The same, for a page that exists only on this device: there is no fresh tree to fetch, and its holder is this very row. */
  function revealAndOpenLocal(page: PageMeta) {
    showToast(t('offline.createdLocally'), 'info');
    setExpanded((prev) => new Set(prev).add(node.id));
    navigate(`/s/${space}/p/${page.id}`);
  }

  const createChild = useMutation({
    // React Query pauses a mutation while the browser says it is offline
    // (networkMode 'online', the default) — which is exactly when this one
    // has to run: it is what creates the page on this device.
    networkMode: 'always',
    mutationFn: (kind: PageKind) =>
      createPageOfflineAware(queryClient, {
        space,
        parentPath: childDirOf(node),
        title: t(newPageTitleKey(kind)),
        kind,
      }),
    onSuccess: ({ page, local }) => (local ? revealAndOpenLocal(page) : revealAndOpen(page)),
    onError: (err) =>
      showToast(err instanceof OfflineUnsupportedError ? t('offline.unsupportedKind') : errorText(err, 'sidebar.createPageFailed')),
  });

  // Offline mode: a page created on this device and not on the server yet.
  // Everything the «⋯» menu offers is a server operation on a page the
  // server does not have, so a local row gets one action of its own instead
  // — throwing the draft away — and is neither draggable nor renamable here
  // (its title is its H1; typing it in the editor renames it).
  const isLocal = useIsLocalPage(node.id);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const discard = useMutation({
    // Local work on local data: never waits for a network.
    networkMode: 'always',
    mutationFn: async () => {
      for (const id of await discardLocalPage(node.id)) await clearPersistedState(id);
    },
    onSuccess: () => {
      setConfirmingDiscard(false);
      queryClient.removeQueries({ queryKey: ['page', node.id] });
      if (activeId === node.id) navigate(`/s/${space}`);
    },
  });

  // "Upload a file" — the only way a pdf/office page is created from the
  // UI (the ordinary create-page flow above rejects kind:'pdf'/'office'
  // server-side). Same target directory as createChild's own parentPath.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadFile = useMutation({
    mutationFn: (file: File) => api.uploadFile(space, childDirOf(node), file),
    onSuccess: revealAndOpen,
    onError: (err) => showToast(errorText(err, 'sidebar.uploadPdfFailed')),
  });

  // Round 5: "create from template", scoped to this row's own directory —
  // see templates/useTemplates.ts and Sidebar.tsx's root-level twin.
  const { templates } = useTemplates(space);
  const createFromTemplate = useCreateFromTemplate(space, revealAndOpen, (message) => showToast(message));

  const rename = useMutation({
    mutationFn: (title: string) => api.renamePage(node.id, { title }),
    onSuccess: () => {
      invalidate();
      setEditing(false);
    },
    onError: (err) => {
      showToast(errorText(err, 'header.breadcrumbs.renameFailed'));
      setEditing(false);
      setRenameValue(node.title);
    },
  });

  const del = useMutation({
    mutationFn: () => api.deletePage(node.id),
    onSuccess: () => {
      invalidate();
      setConfirmingDelete(false);
      if (isActive) navigate(`/s/${space}`);
    },
    onError: (err) => showToast(errorText(err, 'sidebar.tree.deleteFailed')),
  });

  // Round 22 (SHELL-1): Up/Down — see reorderPages.ts for the swap/
  // normalize algorithm. Sequential awaits (not Promise.all): keeps the
  // "minimal number of PUTs" property simple to reason about and avoids
  // any ordering surprise if the normalize path ever has to touch more
  // than the two swapped siblings.
  const reorder = useMutation({
    mutationFn: async (direction: ReorderDirection) => {
      for (const { id, order } of computeReorder(siblings, node.id, direction)) {
        await api.reorderPage(id, order);
      }
    },
    onSuccess: invalidate,
    onError: (err) => showToast(errorText(err, 'sidebar.tree.reorderFailed')),
  });

  // A dropped row: at most one reparent (the SAME endpoint the "Move"
  // dialog uses — a drag is a different affordance for it, not a second
  // server operation), then the {id, order} PUTs reorderPages.ts computed.
  // Sequential, same reasoning as the Up/Down mutation above.
  //
  // Not optimistic: `onSettled: invalidate` refetches the tree whether the
  // drop succeeded or failed, so a partial failure (the move landed, an
  // order PUT did not) can never leave the sidebar showing a position the
  // server doesn't have. The toast is the same one Up/Down already uses.
  const applyDrop = useMutation({
    mutationFn: async (plan: DropPlan) => {
      if (plan.move) await api.movePage(plan.move.id, { toParentPath: plan.move.toParentPath });
      for (const { id, order } of plan.orders) await api.reorderPage(id, order);
    },
    onError: (err) => showToast(errorText(err, 'sidebar.tree.reorderFailed')),
    onSettled: invalidate,
  });

  // "Duplicate" (the owner, 01.10.2026): the page copied next to itself, its
  // whole tree along with it — "Copy to…" with nothing to choose. The copy is
  // named apart ("X (copy)"), which is also what puts it right under the
  // original: a page with no order of its own sits after the sibling that
  // precedes it alphabetically (reorderPages.ts's sortSiblings). Opened once
  // made, like a copy is — the usual next step is to edit it.
  const duplicate = useMutation({
    mutationFn: () => api.duplicatePage(node.id, { title: t('sidebar.tree.duplicateTitle', { title: node.title }) }),
    onSuccess: (copied) => {
      invalidate();
      navigate(`/s/${space}/p/${copied.id}`);
    },
    onError: (err) => showToast(errorText(err, 'sidebar.tree.duplicateFailed')),
  });

  function startEditing() {
    if (isLocal) return;
    committedRef.current = false;
    setRenameValue(node.title);
    setEditing(true);
  }

  /**
   * An absolute link to this page — the owner (17.09) asked for it "to make
   * it easy to insert links into the body and to share". Exactly the URL in
   * the address bar: pasted into text it becomes a link (gfm-table/markup),
   * and sent to a chat it opens as an ordinary Folio link.
   */
  async function copyLink(): Promise<void> {
    const url = `${window.location.origin}/s/${encodeURIComponent(space)}/p/${encodeURIComponent(node.id)}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast(t('sidebar.tree.linkCopied'));
    } catch {
      // The clipboard is unavailable (no permission, an http context) — show
      // the URL itself, so that a person can copy it by hand and is not left with nothing.
      showToast(url);
    }
  }

  function commitRename() {
    if (committedRef.current) return; // guards against a duplicate call from the blur that fires when the input unmounts post-success
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === node.title) {
      setEditing(false);
      setRenameValue(node.title);
      return;
    }
    committedRef.current = true;
    rename.mutate(trimmed);
  }

  function toggleExpanded() {
    if (!hasChildren) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  }

  function expand() {
    setExpanded((prev) => new Set(prev).add(node.id));
  }

  // --- Drag and drop -------------------------------------------------------
  // Native HTML5 drag events, no library (see this round's report): rows are
  // always draggable rather than gated behind a "move mode", and the "…"
  // menu's Up/Down + "Move" stay exactly where they were as the
  // keyboard- and touch-reachable path — HTML5 dnd never fires from a touch,
  // which is also precisely why this cannot interfere with scrolling the
  // <md off-canvas sidebar.

  const isBeingDragged = dragged?.node.id === node.id;
  /** Folder pseudo-nodes have no page id to move or order — they are drop targets only. */
  const isDraggable = canEdit && !isFolder && !editing && !isLocal;

  function cancelSpringOpen() {
    if (springOpenRef.current !== null) {
      clearTimeout(springOpenRef.current);
      springOpenRef.current = null;
    }
  }
  useEffect(() => cancelSpringOpen, []);
  // With nothing being dragged there can be no indicator left behind — the
  // backstop for a drag abandoned with Escape or released outside the tree,
  // where this row may never see its own dragleave.
  useEffect(() => {
    if (!dragged) setDropZone(null);
  }, [dragged]);

  /** The plan for dropping the currently-dragged row here, or null if that drop must be refused. */
  function planFor(zone: DropZone): DropPlan | null {
    if (!dragged || !canEdit) return null;
    return computeDropPlan({
      dragged: dragged.node,
      draggedParentPath: dragged.parentPath,
      target: node,
      targetParentPath: parentPath,
      targetSiblings: siblings,
      zone,
    });
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!dragged) return;
    // A folder pseudo-node has no order of its own to sit before or after
    // (see reorderPages' orderableSiblings), so its whole height means
    // "into" rather than leaving its top and bottom quarters dead.
    const zone = isFolder ? 'into' : dropZoneFor(e.currentTarget.getBoundingClientRect(), e.clientY, canContain(node));
    if (!planFor(zone)) {
      // Not a legal drop here: leave preventDefault uncalled so the cursor
      // reads "no drop" rather than accepting something we'd then refuse.
      cancelSpringOpen();
      if (dropZone !== null) setDropZone(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropZone !== zone) setDropZone(zone);
    // Spring-loaded folders: hovering a collapsed container opens it, so a
    // page can be dragged into a directory whose children aren't showing.
    if (zone === 'into' && hasChildren && !isOpen) {
      if (springOpenRef.current === null) {
        springOpenRef.current = window.setTimeout(() => {
          springOpenRef.current = null;
          expand();
        }, SPRING_OPEN_MS);
      }
    } else {
      cancelSpringOpen();
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    cancelSpringOpen();
    const zone = dropZone;
    setDropZone(null);
    const plan = zone ? planFor(zone) : null;
    setDragged(null);
    if (!plan) return;
    if (zone === 'into') expand(); // so the page is visible where it was just dropped
    applyDrop.mutate(plan);
  }

  return (
    <div>
      {/* Always mounted (not inside the Menu's own conditionally-rendered
          children) so the ref survives the menu closing right after the
          click that opens the native file picker. */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.docx,.xlsx,.pptx"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) uploadFile.mutate(file);
        }}
      />
      <div
        role="button"
        tabIndex={0}
        draggable={isDraggable}
        onDragStart={(e) => {
          if (!isDraggable) return;
          e.stopPropagation();
          // Firefox refuses to start a drag unless SOME data is set.
          e.dataTransfer.setData('text/plain', node.title);
          e.dataTransfer.effectAllowed = 'move';
          setDragged({ node, parentPath });
        }}
        onDragEnd={() => {
          cancelSpringOpen();
          setDropZone(null);
          setDragged(null);
        }}
        onDragOver={handleDragOver}
        onDragLeave={(e) => {
          // dragleave also fires when the pointer crosses into a CHILD of
          // this row (the icon, the "…" trigger) — only a leave that lands
          // outside the row entirely should clear the indicator.
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          cancelSpringOpen();
          setDropZone(null);
        }}
        onDrop={handleDrop}
        // A right click opens the same "…" menu as the button (the owner,
        // 17.09). The menu can only open from its own button, so that is what
        // we press — the panel lands next to the row. A viewer has no such
        // button at all (the menu is for canEdit only), and for them a right
        // click does the only menu action available — copies the link to the page.
        onContextMenu={(e) => {
          if (editing || isFolder) return;
          const holder = e.currentTarget.querySelector<HTMLElement>('.folio-tree__more');
          const button = holder instanceof HTMLButtonElement ? holder : (holder?.querySelector<HTMLButtonElement>('button') ?? null);
          e.preventDefault();
          if (button) button.click();
          else void copyLink();
        }}
        onClick={() => {
          if (!editing) navigate(href);
        }}
        onKeyDown={(e) => {
          if (!editing && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            navigate(href);
          }
        }}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        // py-2 md:py-1: touch-target floor (round 14), pared back in round 25
        // after owner feedback that R14's ≥40px rows read as "very stretched"
        // once a real, deep tree was scrolled on <md. 36px tall on <md (8px
        // padding + text-sm's 20px line-height, both sides) — still clearly
        // roomier than the 28px at md+ for a fat-finger tap, just not the
        // full 40px floor. Font-size is untouched (text-sm both breakpoints,
        // exactly as on desktop) — only the vertical padding moved.
        className={`group relative flex cursor-pointer items-center gap-1 rounded-md py-2 pr-1 text-sm md:py-1 ${
          isActive
            ? 'bg-neutral-200/70 font-medium text-neutral-900 dark:bg-neutral-700/60 dark:text-neutral-50'
            : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800/70'
        }${isBeingDragged ? ' opacity-40' : ''}${
          // "into" reads as the whole row lighting up as a container; the
          // before/after lines below are drawn between rows instead.
          dropZone === 'into' ? ' bg-blue-500/10 ring-1 ring-blue-500 dark:ring-blue-400' : ''
        }`}
      >
        {(dropZone === 'before' || dropZone === 'after') && (
          <span
            aria-hidden="true"
            // pointer-events-none: an indicator that swallowed dragover
            // events would make the row flicker between zones.
            className={`pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-blue-500 dark:bg-blue-400 ${
              dropZone === 'before' ? 'top-0' : 'bottom-0'
            }`}
          />
        )}

        <button
          type="button"
          aria-label={isOpen ? t('sidebar.tree.collapse') : t('sidebar.tree.expand')}
          onClick={(e) => {
            e.stopPropagation();
            toggleExpanded();
          }}
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-neutral-500 ${
            hasChildren ? 'hover:bg-neutral-200 dark:hover:bg-neutral-700' : 'invisible'
          }`}
        >
          {hasChildren && (isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
        </button>

        {iconNode}

        {editing ? (
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') {
                setEditing(false);
                setRenameValue(node.title);
              }
            }}
            className="min-w-0 flex-1 rounded border border-neutral-400 bg-white px-1 py-0 text-sm text-neutral-900 outline-none dark:border-neutral-500 dark:bg-neutral-900 dark:text-neutral-100"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate" title={displayTitle === node.title ? node.title : `${node.title} · ${node.path}`}>
            {displayTitle}
          </span>
        )}

        {/* Round (conflicts must be visible): a subtle marker for a page whose
            own file currently has unresolved git conflict markers
            (SpaceGitInfo.conflicts). No shared "warning" color token exists
            in this codebase yet (grepped) — amber-500 is used here
            deliberately distinct from the red dot SyncStatusChip uses for a
            space's own conflict/error status, so the two read as different
            severities at a glance. */}
        {!editing && !isFolder && conflictedIds.has(node.id) && (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
            title={t('sidebar.tree.conflictMarker')}
            aria-label={t('sidebar.tree.conflictMarker')}
          />
        )}

        {!editing && isLocal && (
          <span
            className="inline-flex shrink-0 text-neutral-400"
            title={t('offline.tree.localMarker')}
            aria-label={t('offline.tree.localMarker')}
            role="img"
          >
            <CloudOff size={12} aria-hidden="true" />
          </span>
        )}

        {!editing && canEdit && !isFolder && (
          <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
            <Menu triggerLabel={t('sidebar.tree.addPage')} trigger={<Plus size={13} />}>
              {(close) => (
                <>
                  <MenuItem
                    icon={<FileText size={14} />}
                    onSelect={() => {
                      close();
                      createChild.mutate('doc');
                    }}
                  >
                    {t('sidebar.newPage')}
                  </MenuItem>
                  <MenuItem
                    icon={<LayoutDashboard size={14} />}
                    onSelect={() => {
                      close();
                      createChild.mutate('board');
                    }}
                  >
                    {t('sidebar.newBoard')}
                  </MenuItem>
                  {/* Round 26 (DATA TABLES): a third page kind, created the
                      same way as the other two — SERVER writes
                      `<slug>.table.md` with a starter schema. */}
                  <MenuItem
                    icon={<Table2 size={14} />}
                    onSelect={() => {
                      close();
                      createChild.mutate('table');
                    }}
                  >
                    {t('sidebar.newTable')}
                  </MenuItem>
                  {/* Round FORMS: creates the form AND a paired data table
                      together (server/storage.ts#createPage's kind:'form'
                      branch) — a fourth "create, server writes the starter
                      file(s)" kind, same shape as table above. */}
                  <MenuItem
                    icon={<ClipboardList size={14} />}
                    onSelect={() => {
                      close();
                      createChild.mutate('form');
                    }}
                  >
                    {t('sidebar.newForm')}
                  </MenuItem>
                  {/* Round PDF/OFFICE: unlike doc/board/table above, a pdf/
                      office page has no server-generated starter file —
                      this opens the native file picker instead of calling
                      createChild. */}
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
                            createFromTemplate.mutate({ template, parentPath: childDirOf(node) });
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
            <Menu className="folio-tree__more" triggerLabel={t('sidebar.tree.moreActions')} align="right" trigger={<MoreHorizontal size={13} />}>
              {(close) =>
                isLocal ? (
                  <MenuItem
                    icon={<Trash2 size={14} />}
                    destructive
                    onSelect={() => {
                      close();
                      setConfirmingDiscard(true);
                    }}
                  >
                    {t('offline.tree.discard')}
                  </MenuItem>
                ) : (
                <>
                  <MenuItem
                    icon={<ArrowUp size={14} />}
                    disabled={reorder.isPending || !canReorder(siblings, node.id, 'up')}
                    onSelect={() => {
                      close();
                      reorder.mutate('up');
                    }}
                  >
                    {t('sidebar.tree.moveUp')}
                  </MenuItem>
                  <MenuItem
                    icon={<ArrowDown size={14} />}
                    disabled={reorder.isPending || !canReorder(siblings, node.id, 'down')}
                    onSelect={() => {
                      close();
                      reorder.mutate('down');
                    }}
                  >
                    {t('sidebar.tree.moveDown')}
                  </MenuItem>
                  <div className="my-1 border-t border-neutral-200 dark:border-neutral-700" />
                  <MenuItem
                    icon={<Copy size={14} />}
                    onSelect={() => {
                      close();
                      void copyLink();
                    }}
                  >
                    {t('sidebar.tree.copyLink')}
                  </MenuItem>
                  {/* A FILE page (pdf/docx/xlsx/pptx) has no separate title to
                      edit — its title IS its filename, extension included
                      (server/storage.ts's titleFallback), and the server
                      refuses a title rename for those kinds outright. Renaming
                      one goes through "change slug" below, which renames the
                      file itself. Offering an action that can only ever toast
                      an error is worse than not offering it. */}
                  {node.kind !== 'pdf' && node.kind !== 'office' && (
                    <MenuItem
                      icon={<Pencil size={14} />}
                      onSelect={() => {
                        close();
                        startEditing();
                      }}
                    >
                      {t('header.breadcrumbs.rename')}
                    </MenuItem>
                  )}
                  <MenuItem
                    icon={<LinkIcon size={14} />}
                    onSelect={() => {
                      close();
                      setChangingSlug(true);
                    }}
                  >
                    {t('sidebar.slug.menuLabel')}
                  </MenuItem>
                  <MenuItem
                    icon={<Move size={14} />}
                    onSelect={() => {
                      close();
                      setMoving(true);
                    }}
                  >
                    {t('sidebar.tree.move')}
                  </MenuItem>
                  <MenuItem
                    icon={<Files size={14} />}
                    disabled={duplicate.isPending}
                    onSelect={() => {
                      close();
                      duplicate.mutate();
                    }}
                  >
                    {t('sidebar.tree.duplicate')}
                  </MenuItem>
                  <MenuItem
                    icon={<CopyPlus size={14} />}
                    onSelect={() => {
                      close();
                      setCopying(true);
                    }}
                  >
                    {t('sidebar.tree.copyTo')}
                  </MenuItem>
                  <MenuItem
                    icon={<Trash2 size={14} />}
                    destructive
                    onSelect={() => {
                      close();
                      setConfirmingDelete(true);
                    }}
                  >
                    {t('ui.delete')}
                  </MenuItem>
                </>
                )
              }
            </Menu>
          </div>
        )}
      </div>

      {hasChildren && isOpen && (
        <div>
          {node.children.map((child) => (
            <TreeRow
              key={child.id}
              node={child}
              space={space}
              depth={depth + 1}
              activeId={activeId}
              activeFolderPath={activeFolderPath}
              expanded={expanded}
              setExpanded={setExpanded}
              directories={directories}
              siblings={node.children}
              // Synthetic folders own their path. A real page may be either
              // a directory index or X.md paired with X/, so childDirOf is
              // the one canonical answer for the level rendered below it.
              parentPath={childDirOf(node)}
              dragged={dragged}
              setDragged={setDragged}
              canEdit={canEdit}
              conflictedIds={conflictedIds}
            />
          ))}
        </div>
      )}

      {confirmingDiscard && (
        <ConfirmDialog
          title={t('offline.tree.discardConfirmTitle')}
          destructive
          confirmLabel={t('offline.tree.discard')}
          busy={discard.isPending}
          onCancel={() => setConfirmingDiscard(false)}
          onConfirm={() => discard.mutate()}
        >
          {t('offline.tree.discardConfirmBody', { title: node.title })}
        </ConfirmDialog>
      )}

      {confirmingDelete && (
        <ConfirmDialog
          title={t('sidebar.tree.deleteConfirmTitle')}
          destructive
          confirmLabel={t('ui.delete')}
          busy={del.isPending}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => del.mutate()}
        >
          {t(hasChildren ? 'sidebar.tree.deleteConfirmBodyWithChildren' : 'sidebar.tree.deleteConfirmBody', { title: node.title })}{' '}
          <code className="rounded bg-neutral-100 px-1 py-0.5 text-xs dark:bg-neutral-800">data/.trash</code>.
        </ConfirmDialog>
      )}

      {moving && (
        <MoveDialog
          page={node}
          directories={directories}
          onClose={() => setMoving(false)}
          onMoved={invalidate}
          onError={showToast}
        />
      )}

      {copying && (
        <CopyDialog
          page={node}
          onClose={() => setCopying(false)}
          onCopied={(copied) => {
            queryClient.invalidateQueries({ queryKey: ['tree', copied.space] });
            queryClient.invalidateQueries({ queryKey: ['spaces'] });
            navigate(`/s/${copied.space}/p/${copied.id}`);
          }}
          onError={showToast}
        />
      )}

      {changingSlug && (
        <ChangeSlugDialog
          page={node}
          onClose={() => setChangingSlug(false)}
          onChanged={invalidate}
          onError={showToast}
        />
      )}
    </div>
  );
}
