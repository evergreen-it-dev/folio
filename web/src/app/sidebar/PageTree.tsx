import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useLocalStorage } from '../hooks';
import { useLocalPages } from '../offline/localPages';
import { mergeLocalPages } from '../offline/treeMerge';
import { TreeRow } from './TreeRow';
import { ancestorIds, clearTreeReveal, useTreeRevealRequest } from './treeReveal';
import type { DraggedNode } from './TreeRow';
import { collectDirectories, excludeAgentFolder, excludeTemplatesFolder, getTopLevelNodes } from './treeUtils';
import '../i18n/register';

export interface PageTreeProps {
  space: string;
  /** id of the page currently open in the main area, for active-row highlighting. */
  activeId: string | undefined;
  /** Path of the folder currently open at /s/:space/d/*, if any. */
  activeFolderPath: string | undefined;
  /** My role in this space is editor+ — gates every row's create/rename/move/delete affordances. */
  canEdit: boolean;
}

/** Fetches and renders the recursive page tree for a space, with per-space persisted expand/collapse state. */
export function PageTree({ space, activeId, activeFolderPath, canEdit }: PageTreeProps) {
  const { t } = useTranslation('app');
  // Shares the ['spaces'] cache with ConflictBanner/Sidebar/SpaceSwitcher —
  // just to read SpaceGitInfo.conflicts (only ever populated while
  // status === 'conflict', see server/gitSync.ts's getSpaceConflicts) so
  // TreeRow can mark the affected pages, same idea as SyncStatusChip reading
  // the same cache for the space-level indicator.
  const { data: spacesData } = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces });
  const conflictedIds = useMemo(() => {
    const conflicts = spacesData?.spaces?.find((s) => s.slug === space)?.git?.conflicts ?? [];
    return new Set(conflicts.map((c) => c.pageId).filter((id): id is string => Boolean(id)));
  }, [spacesData, space]);
  const { data: serverTree, isLoading, refetch } = useQuery({
    queryKey: ['tree', space],
    queryFn: () => api.getTree(space),
    // Owner ask (10.09.2026): structural changes made in another tab/user/AI
    // agent (create/delete/restore/rename/move) weren't visible without F5 —
    // refetchOnWindowFocus:false at the QueryClient level (App.tsx) killed
    // the one thing that would have caught them. Point fix here rather than
    // globally: the tree is cheap and this is exactly the query that needs
    // to notice a restore-from-trash or a move done elsewhere.
    //
    // The real signal (02.10.2026) is the `{ type: 'tree', space }` frame on
    // the /events socket (notifications/NotificationsHost.tsx →
    // sidebar/treeLive.ts): a change made by another user, an API/MCP client,
    // the assistant, an import or a git sync refetches this query within a
    // second or two while the tab stays focused. What is left here is the
    // FALLBACK for when that socket is silent or down (a sleeping laptop, a
    // proxy that cut it, a server without the listener): the refetch on focus
    // and the 30 s poll. Do not remove them.
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  // Pages created offline are laid into the tree here (offline/treeMerge.ts)
  // — the server's tree cannot contain a page it has not heard of yet.
  const localPages = useLocalPages();
  const data = useMemo(
    () => (serverTree ? mergeLocalPages(serverTree, localPages, space) : serverTree),
    [serverTree, localPages, space],
  );

  const [expandedArray, setExpandedArray] = useLocalStorage<string[]>(`folio:expanded:${space}`, []);
  const expanded = useMemo(() => new Set(expandedArray), [expandedArray]);
  const setExpanded = (updater: (prev: Set<string>) => Set<string>) => {
    setExpandedArray((prevArray) => Array.from(updater(new Set(prevArray))));
  };

  // A page created outside the tree (the new-base dialog, the quick switcher…)
  // asks to be shown: once the fresh tree holds it, expand its ancestors, then
  // scroll its row into view (the row is rendered by the next commit).
  const revealRequest = useTreeRevealRequest(space);
  const [scrollTo, setScrollTo] = useState<{ id: string; block: ScrollLogicalPosition } | null>(null);
  useEffect(() => {
    if (!revealRequest || !data) return;
    const ancestors = ancestorIds(data.tree, revealRequest.pageId);
    if (!ancestors) return; // not in the tree yet: the invalidated query is still on its way
    if (ancestors.length > 0) setExpanded((prev) => new Set([...prev, ...ancestors]));
    setScrollTo({ id: revealRequest.pageId, block: 'center' });
    clearTreeReveal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealRequest, data]);

  // The page open in the main area is shown in the tree too (owner, 10.11.2026:
  // "I followed a link, but the tree has a different page expanded"). Opening a
  // page from a link, a breadcrumb, search or a fresh tab expands its ancestors
  // once per page — branches opened earlier stay open, and collapsing an
  // ancestor afterwards is not undone by the next tree refetch. The row is
  // scrolled only as far as needed ('nearest'), so a click inside the tree
  // does not move it.
  const revealedActiveId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!activeId || !data || revealedActiveId.current === activeId) return;
    const ancestors = ancestorIds(data.tree, activeId);
    if (!ancestors) return; // not in this tree (yet): a new page whose tree refetch is on its way
    revealedActiveId.current = activeId;
    if (ancestors.some((id) => !expanded.has(id))) setExpanded((prev) => new Set([...prev, ...ancestors]));
    setScrollTo((current) => current ?? { id: activeId, block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, data]);

  useEffect(() => {
    if (!scrollTo) return;
    const frame = requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-tree-page-id="${scrollTo.id.replace(/["\\]/g, '\\$&')}"]`);
      row?.scrollIntoView?.({ block: scrollTo.block, behavior: 'smooth' });
      setScrollTo(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollTo, expandedArray]);

  // Which row is being dragged right now, lifted to the whole tree because
  // every OTHER row needs it to decide whether it is a legal drop target.
  // Set once on dragstart and cleared on dragend — the per-row drop
  // indicator is local state in TreeRow, so a dragover does not re-render
  // the tree.
  const [dragged, setDragged] = useState<DraggedNode | null>(null);

  if (isLoading) {
    return <div className="px-3 py-2 text-sm text-neutral-400">{t('sidebar.tree.loading')}</div>;
  }

  // `isError` alone is not a reason to take the tree away: react-query keeps
  // the last good `data` across a failed refetch, and a failed refetch is
  // exactly what going offline looks like. The error screen is for having
  // nothing to show.
  if (!data) {
    return (
      <div className="px-3 py-2 text-sm text-red-600 dark:text-red-400">
        {t('sidebar.tree.loadFailed')}{' '}
        <button type="button" onClick={() => refetch()} className="underline underline-offset-2">
          {t('auth.retry')}
        </button>
      </div>
    );
  }

  const nodes = excludeAgentFolder(excludeTemplatesFolder(getTopLevelNodes(data)));
  const directories = collectDirectories(data.tree);

  if (nodes.length === 0) {
    return <div className="px-3 py-2 text-sm text-neutral-400">{t('sidebar.tree.empty')}</div>;
  }

  return (
    <div className="flex flex-col gap-px">
      {nodes.map((node) => (
        <TreeRow
          key={node.id}
          node={node}
          space={space}
          depth={0}
          activeId={activeId}
          activeFolderPath={activeFolderPath}
          expanded={expanded}
          setExpanded={setExpanded}
          directories={directories}
          siblings={nodes}
          parentPath=""
          dragged={dragged}
          setDragged={setDragged}
          canEdit={canEdit}
          conflictedIds={conflictedIds}
        />
      ))}
    </div>
  );
}
