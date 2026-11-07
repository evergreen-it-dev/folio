import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { TreeNode } from '@shared/contracts';
import { api, ApiError } from '../api';
import { useStars, useToggleStar } from '../stars';
import { PageGlyph } from './PageGlyph';
import { SectionLabel } from './SectionLabel';
import '../i18n/register';

export interface StarredSectionProps {
  space: string;
}

/**
 * "Starred": starred PAGES of the current space, shown above the tree.
 *
 * Starred spaces deliberately live elsewhere (08.09.2026, owner: "spaces were
 * not supposed to be here — pages live there"): since the space switcher pins
 * starred spaces to the top of its own list, repeating them here only pushed
 * the page tree down.
 * Renders nothing when no page is starred.
 */
export function StarredSection({ space }: StarredSectionProps) {
  const { t } = useTranslation('app');
  const { data: stars } = useStars();
  // Shares the cache with PageTree's own fetch of the same key — this
  // doesn't cost an extra request when the tree is already loaded.
  const { data: treeData } = useQuery({ queryKey: ['tree', space], queryFn: () => api.getTree(space) });

  // Cheap title lookup for starred pages that happen to live in the space
  // currently open: no extra request needed, just an index over data we
  // already have. Pages starred from a *different* space fall through to
  // StarredPageLink's own lazy per-id fetch below.
  const treeIndex = useMemo(() => {
    const map = new Map<string, TreeNode>();
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        map.set(node.id, node);
        walk(node.children);
      }
    };
    if (treeData) walk(treeData.tree);
    return map;
  }, [treeData]);

  const starredPages = stars?.pages ?? [];
  if (starredPages.length === 0) return null;

  return (
    <div className="mt-4 px-2">
      <SectionLabel>{t('sidebar.starred.title')}</SectionLabel>
      <div className="flex flex-col gap-px">
        {starredPages.map((id) => (
          <StarredPageLink key={`page:${id}`} id={id} node={treeIndex.get(id)} />
        ))}
      </div>
    </div>
  );
}

function StarredPageLink({ id, node }: { id: string; node: TreeNode | undefined }) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const toggleStar = useToggleStar();
  const { data: fetched, isError, error } = useQuery({
    queryKey: ['page', id],
    queryFn: () => api.getPage(id),
    enabled: !node,
  });

  const pageSpace = node?.space ?? fetched?.space;
  const title = node?.title ?? fetched?.title;

  if (isError) {
    /**
     * There used to be a single word "Unavailable" here for any error — and,
     * worse, a dead end: a dead star could be neither understood nor removed.
     * And there are exactly two reasons, and they differ (server/auth/session.ts
     * requirePageRole): 404 — the page is gone (deleted; with the arrival of
     * the trash it can be brought back), 403 — the page exists, but you have
     * no access to its space (after R27 an instance admin no longer reads
     * everything, so this became a normal outcome, not an anomaly).
     */
    const status = error instanceof ApiError ? error.status : 0;
    const deleted = status === 404;
    return (
      <div className="group flex items-center gap-2 rounded-md py-2 pl-1 pr-2 text-[13px] leading-5 text-neutral-400 md:py-[3px]">
        <PageGlyph />
        <span className="min-w-0 flex-1 truncate italic" title={t(deleted ? 'sidebar.starred.deletedHint' : 'sidebar.starred.noAccessHint')}>
          {t(deleted ? 'sidebar.starred.deleted' : 'sidebar.starred.noAccess')}
        </span>
        <button
          type="button"
          title={t('sidebar.starred.remove')}
          aria-label={t('sidebar.starred.remove')}
          onClick={() => toggleStar.mutate({ kind: 'page', id, starred: false })}
          className="shrink-0 rounded p-0.5 opacity-0 hover:bg-neutral-200 hover:text-neutral-700 focus-visible:opacity-100 group-hover:opacity-100 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  if (!pageSpace || !title) {
    return (
      <div className="flex items-center gap-2 rounded-md py-2 pl-1 pr-2 text-[13px] leading-5 text-neutral-400 md:py-[3px]">
        <PageGlyph />
        <span className="truncate">{t('ui.loading')}</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => navigate(`/s/${pageSpace}/p/${id}`)}
      // py-2 md:py-1: touch-target floor (round 14), pared back in round 25
      // to match TreeRow's own de-bloated rows — see its comment for the
      // 36px-vs-28px reasoning.
      className="flex items-center gap-2 rounded-md py-2 pl-1 pr-2 text-left text-[13px] leading-5 md:py-[3px] text-neutral-800 hover:bg-neutral-200/60 dark:text-neutral-200 dark:hover:bg-white/[0.06]"
    >
      <PageGlyph kind={node?.kind} icon={node?.icon} path={node?.path} />
      <span className="min-w-0 flex-1 truncate">{title}</span>
    </button>
  );
}
