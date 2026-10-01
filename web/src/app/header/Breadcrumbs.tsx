import { useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { House, Pencil } from 'lucide-react';
import type { TreeNode } from '@shared/contracts';
import { api, ApiError } from '../api';
import { useApiErrorText } from '../errorText';
import { useToast } from '../ui/Toast';
import { PageIconPicker } from '../page-meta/PageIconPicker';
import { childDirOf } from '../sidebar/treeUtils';
import '../i18n/register';

export interface BreadcrumbsProps {
  space: string;
  /** Path of the current page, relative to the space root. */
  pagePath: string;
  title: string;
  /** Round 5: frontmatter `icon:` (emoji), shown before the title. */
  icon?: string;
  /** Undefined for a synthetic page (e.g. a folder listing) — no real page id, no rename possible. */
  pageId?: string;
  /** editor+ in this space (round 8: click-to-rename the last crumb — docs AND boards, same POST /api/pages/:id/rename either way). */
  canRename: boolean;
}

export function humanize(segment: string): string {
  return segment.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * What committing the rename input should submit, if anything: null means
 * "no-op" — nothing typed (blank/whitespace-only), or it trims back to
 * exactly the current title (e.g. focus-then-blur with no real edit).
 * Extracted as a pure function so the trim/no-op-if-unchanged decision is
 * testable without mounting the component — same shape as
 * decideFavoriteWrites in emoji/favorites.ts.
 */
export function resolveRenameCommit(draft: string, current: string): string | null {
  const trimmed = draft.trim();
  if (!trimmed || trimmed === current) return null;
  return trimmed;
}

/**
 * Human title of the real page that owns an ancestor directory. A page
 * `X.md` paired with `X/` must contribute its current H1/title to breadcrumbs,
 * not the humanized storage slug `X`. Synthetic folders keep their own title.
 */
export function breadcrumbAncestorTitle(nodes: TreeNode[], dirPath: string): string | undefined {
  for (const node of nodes) {
    if ((node.kind === 'folder' || node.children.length > 0) && childDirOf(node) === dirPath) return node.title;
    const nested = breadcrumbAncestorTitle(node.children, dirPath);
    if (nested) return nested;
  }
  return undefined;
}

/** Breadcrumbs built from the page's file path: space home -> each ancestor directory -> current title. */
export function Breadcrumbs({ space, pagePath, title, icon, pageId, canRename }: BreadcrumbsProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const navigate = useNavigate();
  const showToast = useToast();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces });
  const { data: treeData } = useQuery({ queryKey: ['tree', space], queryFn: () => api.getTree(space) });
  const spaceName = data?.spaces.find((s) => s.slug === space)?.name ?? space;

  const dirSegments = pagePath.includes('/') ? pagePath.split('/').slice(0, -1) : [];

  /**
   * QA-3 P2 #3: clicking an ancestor crumb for a directory that has no page
   * of its own used to dead-end on a toast ("There is no page for …") with the
   * URL unchanged — even though `/s/:space/d/<dir>` renders that directory
   * perfectly well and is exactly where the sidebar's own folder row goes.
   *
   * Two changes: resolve the DIRECTORY rather than the literal
   * `<dir>/index.md`, so the server's own fallback chain (path ->
   * path/index.md -> path/README.md) also finds a directory whose index is a
   * README; and on a genuine 404 fall through to the synthetic folder
   * listing instead of refusing to navigate. A toast is left for real
   * failures only (offline, 403, 5xx).
   */
  async function goToAncestor(index: number) {
    const dirPath = dirSegments.slice(0, index + 1).join('/');
    try {
      const meta = await api.resolve(space, dirPath);
      navigate(`/s/${space}/p/${meta.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        navigate(`/s/${space}/d/${dirPath}`);
        return;
      }
      showToast(errorText(err, 'header.breadcrumbs.navigateFailed'));
    }
  }

  // Round 8: click the last crumb (current page title) to rename inline.
  // A board's title (this round: stored in a header comment, not its
  // filename — server/storage.ts's setBoardTitle) goes through the exact
  // same POST rename TreeRow's own rename action uses, so the submitted
  // title round-trips verbatim; `optimisticTitle` shows what was typed
  // immediately, then a successful refetch (invalidating ['page', pageId] +
  // ['tree', space], which the header/breadcrumbs/tree all read title from)
  // quietly replaces it with server truth once it lands.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [optimisticTitle, setOptimisticTitle] = useState<string | null>(null);

  // Once fresh server data actually arrives (the `title` prop itself
  // changes — driven by the invalidations above, or by navigating to a
  // different page entirely), let it take back over from the optimistic
  // value rather than leaving the optimistic guess displayed forever,
  // whether or not it exactly matches what the server settled on.
  useEffect(() => {
    setOptimisticTitle(null);
  }, [title]);

  const rename = useMutation({
    mutationFn: (nextTitle: string) => api.renamePage(pageId!, { title: nextTitle }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['page', pageId] });
      queryClient.invalidateQueries({ queryKey: ['tree', space] });
    },
    onError: (err) => {
      setOptimisticTitle(null);
      showToast(errorText(err, 'header.breadcrumbs.renameFailed'));
    },
  });

  function startEditing() {
    if (!canRename || !pageId) return;
    setDraft(optimisticTitle ?? title);
    setEditing(true);
  }

  function commit() {
    setEditing(false);
    const next = resolveRenameCommit(draft, optimisticTitle ?? title);
    if (next === null) return;
    setOptimisticTitle(next);
    rename.mutate(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setEditing(false);
      setDraft(optimisticTitle ?? title);
    }
  }

  const displayTitle = optimisticTitle ?? title;

  return (
    <nav
      aria-label={t('header.breadcrumbs.label')}
      // Round 19 QA fix (F1, md..lg): flex-1 + overflow-hidden alongside the
      // existing min-w-0 — Header.tsx's wrapper div around this <nav> is
      // itself min-w-0 flex-1 relative to <header>, so this box's WIDTH was
      // already correctly squeezed at md..lg (button cluster becoming
      // visible + SearchBox's md:w-full both landing right at the md
      // breakpoint). The overflow wasn't this box being too wide — it was
      // this box's own CHILDREN (below) not respecting that squeeze and
      // painting past it, on top of the search box. overflow-hidden is the
      // hard backstop: whatever the children below still don't manage to
      // shrink into, this clips instead of visually bleeding rightward.
      className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-sm text-neutral-500 dark:text-neutral-400"
    >
      {/* Round 14: space-home + ancestor-directory crumbs hidden below md —
          the current page's own (still-truncating) title is what needs the
          room at 375px, not a trail most of which is invisible anyway once
          truncated to 12-16ch each. */}
      {/* QA-3 P1 (900–1440px, the round-19 fix's remaining half): the trail
          was min-w-0 with default shrink:1 while the title below was `flex-1`
          — i.e. `flex: 1 1 0%`, flex-BASIS 0. Flexbox distributes NEGATIVE
          free space in proportion to each item's `shrink × basis`, so a
          basis-0 item's share of the squeeze is 1×0 = 0: the title could
          never shrink, but it could never claim any width either. Measured at
          1024px: nav 171px, trail 159px, title button 8px (its px-1 padding
          alone) with 0px of visible text — the current page's own name gone
          at every width from 900 through 1280. `shrink-[999]` here inverts
          the priority outright: this ancestor trail absorbs essentially the
          whole squeeze (clipped by its own overflow-hidden so its
          shrink-resistant children can't paint over the title again) before
          the title — now `flex-auto`, basis auto, shrink 1 — gives up a
          single pixel. Ancestors degrade to their own per-segment ellipses
          and then vanish; the page you are actually on always survives.
          md:min-w-[3.5rem] is the floor that stops the collapse just short of
          nothing, so the House space-home crumb stays clickable — losing the
          way BACK would only have traded one navigation bug for another. */}
      <span className="hidden min-w-0 shrink-[999] items-center gap-1 overflow-hidden md:flex md:min-w-[3.5rem]">
        <button
          type="button"
          onClick={() => navigate(`/s/${space}`)}
          // title/aria-label on the BUTTON, not just the label span: once the
          // trail collapses, the span it used to live on can be ellipsized
          // down to nothing, and this crumb is then a bare House glyph that
          // still has to say where it goes.
          title={spaceName}
          aria-label={spaceName}
          className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          <House size={13} className="shrink-0" aria-hidden="true" />
          <span className="max-w-[12ch] truncate">{spaceName}</span>
        </button>
        {/* The same shrink-priority ladder one level down, so a collapsing
            trail doesn't leave every crumb as an unreadable 4px sliver:
            intermediate directories (and their separators) give way first and
            disappear cleanly, leaving the space-home crumb — shrink:1, and
            with its own truncate — to ellipsize as "🏠 QA3…" rather than
            being hard-cut mid-word by the wrapper's overflow-hidden. */}
        {dirSegments.map((seg, i) => {
          const dirPath = dirSegments.slice(0, i + 1).join('/');
          const ancestorTitle = breadcrumbAncestorTitle(treeData?.tree ?? [], dirPath) ?? humanize(seg);
          return (
          <span key={i} className="flex min-w-0 shrink-[999] items-center gap-1 overflow-hidden">
            <span className="shrink-0" aria-hidden="true">
              /
            </span>
            <button
              type="button"
              onClick={() => goToAncestor(i)}
              title={ancestorTitle}
              className="max-w-[16ch] truncate rounded px-1 py-0.5 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            >
              {ancestorTitle}
            </button>
          </span>
          );
        })}
        <span className="shrink-[999] overflow-hidden" aria-hidden="true">
          /
        </span>
      </span>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commit}
          onClick={(e) => e.stopPropagation()}
          className="min-w-0 flex-auto truncate rounded border border-neutral-400 bg-white px-1 py-0.5 font-medium text-neutral-900 outline-none dark:border-neutral-500 dark:bg-neutral-900 dark:text-neutral-100"
        />
      ) : canRename && pageId ? (
        <div className="flex min-w-0 flex-auto items-center gap-0.5">
          <PageIconPicker pageId={pageId} space={space} icon={icon} />
          <button
            type="button"
            onClick={startEditing}
            title={t('header.breadcrumbs.rename')}
          // flex-auto, NOT flex-1 (QA-3 P1): both grow into slack the same
          // way, but flex-1's basis of 0 made this button worth 0 in the
          // negative-free-space split above — it stayed at 8px of padding
          // from 900px all the way to 1280px. basis:auto means the title's
          // own content width is what it asks for, and the trail's
          // shrink-[999] means it is served first. Keep these two in sync
          // with the `editing` input and the read-only span.
            className="group/crumb flex min-w-0 flex-auto items-center gap-1 rounded px-1 py-0.5 font-medium text-neutral-900 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800"
          >
            <span className="min-w-0 truncate">{displayTitle}</span>
            <Pencil
              size={12}
              aria-hidden="true"
              className="shrink-0 opacity-0 group-hover/crumb:opacity-60 group-focus-visible/crumb:opacity-60"
            />
          </button>
        </div>
      ) : (
        <span className="min-w-0 flex-auto truncate font-medium text-neutral-900 dark:text-neutral-100" title={displayTitle}>
          {icon && (
            <span className="mr-1" aria-hidden="true">
              {icon}
            </span>
          )}
          {displayTitle}
        </span>
      )}
    </nav>
  );
}
