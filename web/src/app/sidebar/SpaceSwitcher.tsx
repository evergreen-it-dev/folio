import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronsUpDown, Plus, Search, Star } from 'lucide-react';
import { api } from '../api';
import { isStarred, useStars, useToggleStar } from '../stars';
import { Menu, MenuItem } from '../ui/Menu';
import { SyncStatusChip } from '../git/SyncStatusChip';
import { CreateSpaceDialog } from './CreateSpaceDialog';
import '../i18n/register';

export interface SpaceSwitcherProps {
  current: string;
}

/** Dropdown: switch spaces (each with its own sync status chip), or open the create-space dialog. */
export function SpaceSwitcher({ current }: SpaceSwitcherProps) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');

  // Same reasoning as PageTree's ['tree', space] query (see its comment):
  // a space created/renamed/deleted elsewhere should show up here without
  // an F5. Point config, not global — see App.tsx's QueryClient defaults.
  const { data, isLoading } = useQuery({
    queryKey: ['spaces'],
    queryFn: api.listSpaces,
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const spaces = data?.spaces ?? [];
  const currentSpace = spaces.find((s) => s.slug === current);
  // Owner (08.09.2026): starred ("pinned") spaces first, the rest below —
  // the list scrolled past 8 rows with no visible cue and looked like spaces
  // were missing. The star per row toggles pinning without closing the menu.
  const { data: stars } = useStars();
  const toggleStar = useToggleStar();
  const { pinned, others } = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    const visible = needle
      ? spaces.filter((space) =>
          `${space.name} ${space.slug}`.toLocaleLowerCase().includes(needle),
        )
      : spaces;
    const pinnedList = visible.filter((space) => isStarred(stars, 'space', space.slug));
    const rest = visible.filter((space) => !isStarred(stars, 'space', space.slug));
    return { pinned: pinnedList, others: rest };
  }, [search, spaces, stars]);

  // A row is TWO controls: the MenuItem button (navigate) and the star
  // (pin/unpin). They must be SIBLINGS — a <button> inside a <button> is
  // invalid HTML and React warns about it — so the star sits next to the
  // MenuItem in a flex row, overlaying its right edge.
  // `close` is the Menu render-prop's callback, NOT the global window.close.
  const renderRow = (space: (typeof spaces)[number], starred: boolean, close: () => void) => (
    <div key={space.slug} className="group/space relative flex items-center">
      <div className="min-w-0 flex-1">
        <MenuItem
          onSelect={() => {
            close();
            navigate(`/s/${space.slug}`);
          }}
        >
          <span className="flex w-full items-center justify-between gap-2 pr-6">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate">{space.name}</span>
              <SyncStatusChip git={space.git} />
            </span>
            <span className="shrink-0 text-xs opacity-50">{space.pageCount}</span>
          </span>
        </MenuItem>
      </div>
      <button
        type="button"
        aria-label={t(starred ? 'star.remove' : 'star.add', { noun: t('star.noun.space') })}
        aria-pressed={starred}
        onClick={(event) => {
          // Pin/unpin in place — no navigation, menu stays open.
          event.preventDefault();
          event.stopPropagation();
          toggleStar.mutate({ kind: 'space', id: space.slug, starred: !starred });
        }}
        className={`absolute right-1 rounded p-1 ${
          starred ? 'text-amber-500' : 'text-neutral-300 opacity-0 group-hover/space:opacity-100 hover:text-amber-500 dark:text-neutral-600'
        }`}
      >
        <Star size={13} className={starred ? 'fill-current' : undefined} aria-hidden="true" />
      </button>
    </div>
  );

  return (
    <>
      <Menu
        triggerLabel={t('sidebar.spaceSwitcher.label')}
        // min-w-0 alongside flex-1 (not just w-full): a flex item's minimum
        // width defaults to its CONTENT's natural size unless min-w-0 says
        // otherwise, at every level of the chain below — w-full alone only
        // sets the width basis, it doesn't grant permission to shrink past
        // that. Without this, a long space name forced the whole trigger
        // wider than the sidebar toolbar row, pushing the star/settings/new
        // page buttons out instead of eliding with "…".
        className="min-w-0 flex-1"
        trigger={
          <span className="flex min-w-0 w-full items-center justify-between gap-2 px-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className="min-w-0 truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100"
                title={isLoading ? undefined : (currentSpace?.name ?? current)}
              >
                {isLoading ? t('ui.loading') : (currentSpace?.name ?? current)}
              </span>
              <SyncStatusChip git={currentSpace?.git} />
            </span>
            <ChevronsUpDown size={14} className="shrink-0 opacity-60" />
          </span>
        }
      >
        {(close) => (
          <div className="flex max-h-[70vh] w-72 flex-col">
            <label className="relative mb-1 block shrink-0">
              <Search
                size={14}
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400"
              />
              <input
                type="search"
                autoFocus
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-label={t('sidebar.spaceSwitcher.searchLabel')}
                placeholder={t('sidebar.spaceSwitcher.searchPlaceholder')}
                className="w-full rounded-md border border-neutral-200 bg-transparent py-1.5 pl-8 pr-2 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-400 dark:border-neutral-700 dark:focus:border-neutral-500"
              />
            </label>
            <div data-testid="space-switcher-list" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {spaces.length === 0 && <div className="px-2.5 py-1.5 text-sm opacity-60">{t('sidebar.spaceSwitcher.noSpaces')}</div>}
              {spaces.length > 0 && pinned.length === 0 && others.length === 0 && (
                <div className="px-2.5 py-1.5 text-sm opacity-60">{t('sidebar.spaceSwitcher.noMatches')}</div>
              )}
              {pinned.map((space) => renderRow(space, true, close))}
              {pinned.length > 0 && others.length > 0 && <div className="my-1 border-t border-neutral-200 dark:border-neutral-700" />}
              {others.map((space) => renderRow(space, false, close))}
            </div>
            <div className="mt-1 border-t border-neutral-200 pt-1 dark:border-neutral-700">
              <MenuItem
                icon={<Plus size={14} />}
                onSelect={() => {
                  close();
                  setCreating(true);
                }}
              >
                {t('sidebar.spaceSwitcher.newSpace')}
              </MenuItem>
            </div>
          </div>
        )}
      </Menu>

      {creating && <CreateSpaceDialog onClose={() => setCreating(false)} />}
    </>
  );
}
