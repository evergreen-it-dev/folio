import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CircleHelp, ClipboardList, Clock, FileText, LayoutDashboard, RefreshCw, Search, SunMoon, Table2 } from 'lucide-react';
import type { PageKind, SearchHit } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { newPageTitleKey } from '../sidebar/slugUtils';
import { useDebouncedValue } from '../hooks';
import { useSpaceRole } from '../auth/AuthProvider';
import { canEditContent, canManageMembers } from '../auth/roles';
import { cycleThemeMode, useSettings } from '../settings';
import { useToast } from '../ui/Toast';
import { OfflineUnsupportedError, createPageOfflineAware } from '../offline/createPage';
import { useRecents } from '../recents';
import type { RecentPage } from '../recents';
import { HelpModal } from '../help/HelpModal';
import { fuzzyFilter } from './fuzzy';
import '../i18n/register';

export interface QuickSwitcherProps {
  /** Current space — scopes new-page/new-board/sync actions and the search API call (search, unlike recents, isn't cross-space; see api.search). */
  space: string;
  onClose: () => void;
}

interface SwitcherAction {
  id: string;
  label: string;
  icon: ReactNode;
  run: () => void;
}

type Entry =
  | { kind: 'recent'; key: string; label: string; icon?: string; go: () => void }
  | { kind: 'hit'; key: string; label: string; snippet: string; go: () => void }
  | { kind: 'action'; key: string; label: string; icon: ReactNode; run: () => void };

/**
 * Cmd+K quick switcher: one modal combining recent pages (cross-space,
 * localStorage), a debounced search against the current space, and a short
 * list of role-gated actions — all three fuzzy-filtered by the same query
 * (recents/actions client-side via fuzzy.ts, search results server-side).
 * Replaces the old always-open header search dropdown; SearchBox.tsx is now
 * just this modal's entry point (see DEV-PLAN Round 5).
 *
 * Not portaled to document.body, matching ui/Modal.tsx's own convention —
 * Shell's root only has `overflow-hidden` (no transform/filter/contain), so
 * a `position: fixed` overlay isn't clipped by it regardless of DOM depth.
 */
export function QuickSwitcher({ space, onClose }: QuickSwitcherProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const navigate = useNavigate();
  const showToast = useToast();
  const queryClient = useQueryClient();
  const role = useSpaceRole(space);
  const { theme, setTheme } = useSettings();

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  // Round 6 addendum: stacks on top of the switcher itself (same z-50 as
  // this dialog's own backdrop, later in DOM order so it paints over it)
  // rather than closing the switcher first — closing help leaves you back
  // in an still-open switcher, ready to keep searching.
  const [helpOpen, setHelpOpen] = useState(false);
  const debounced = useDebouncedValue(query, 200);
  const trimmed = debounced.trim();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const [recents, setRecents] = useRecents();
  const recentValidation = useQuery({
    queryKey: ['recents', 'valid', recents.map((r) => `${r.space}:${r.id}`).join('|')],
    queryFn: () => api.validateRecentPages({ pages: recents.map((r) => ({ space: r.space, id: r.id })) }),
    enabled: recents.length > 0,
    retry: false,
  });
  const validRecentKeys = useMemo(() => new Set(recentValidation.data?.valid ?? []), [recentValidation.data]);

  useEffect(() => {
    if (!recentValidation.data) return;
    setRecents((previous) => {
      const next = previous.filter((r) => validRecentKeys.has(`${r.space}:${r.id}`));
      return next.length === previous.length ? previous : next;
    });
  }, [recentValidation.data, setRecents, validRecentKeys]);

  const { data: searchData, isFetching: searching } = useQuery({
    queryKey: ['search', space, trimmed],
    queryFn: () => api.search(trimmed, space),
    enabled: trimmed.length > 0,
  });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function go(to: string) {
    onClose();
    navigate(to);
  }

  // Round 26 (DATA TABLES): `PageKind` rather than the old hardcoded
  // `'doc' | 'board'` — a third creatable kind now exists, and the union was
  // the only thing keeping it out of Cmd+K.
  const createPage = useMutation({
    // React Query pauses a mutation while the browser says it is offline
    // (networkMode 'online', the default) — which is exactly when this one
    // has to run: it is what creates the page on this device.
    networkMode: 'always',
    mutationFn: (kind: PageKind) =>
      createPageOfflineAware(queryClient, {
        space,
        parentPath: '',
        title: t(newPageTitleKey(kind)),
        kind,
      }),
    onSuccess: ({ page, local }) => {
      if (local) showToast(t('offline.createdLocally'), 'info');
      else queryClient.invalidateQueries({ queryKey: ['tree', space] });
      go(`/s/${space}/p/${page.id}`);
    },
    onError: (err) =>
      showToast(err instanceof OfflineUnsupportedError ? t('offline.unsupportedKind') : errorText(err, 'sidebar.createPageFailed')),
  });

  const sync = useMutation({
    mutationFn: () => api.syncSpace(space),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['spaces'] }),
    onSuccess: (result) => {
      onClose();
      if (result.git.status === 'error' || result.git.status === 'conflict') {
        showToast(result.git.lastError ?? t('sidebar.syncFailed'));
      } else {
        showToast(t('admin.spaces.syncComplete'), 'info');
      }
    },
    onError: (err) => showToast(errorText(err, 'sidebar.syncFailed')),
  });

  // Actions always include theme cycling (a personal preference, no
  // permission concept applies); new page/board need editor+, sync mirrors
  // Sidebar.tsx's own gating (admin — canManageMembers, not just editor).
  const actions = useMemo<SwitcherAction[]>(() => {
    const list: SwitcherAction[] = [];
    if (canEditContent(role)) {
      list.push({
        id: 'new-page',
        label: t('switcher.createPage'),
        icon: <FileText size={15} aria-hidden="true" />,
        run: () => createPage.mutate('doc'),
      });
      list.push({
        id: 'new-board',
        label: t('switcher.createBoard'),
        icon: <LayoutDashboard size={15} aria-hidden="true" />,
        run: () => createPage.mutate('board'),
      });
      list.push({
        id: 'new-table',
        label: t('switcher.createTable'),
        icon: <Table2 size={15} aria-hidden="true" />,
        run: () => createPage.mutate('table'),
      });
      list.push({
        id: 'new-form',
        label: t('switcher.createForm'),
        icon: <ClipboardList size={15} aria-hidden="true" />,
        run: () => createPage.mutate('form'),
      });
    }
    list.push({
      id: 'cycle-theme',
      label: t('switcher.cycleTheme', { theme: t(`settings.theme.${theme}`) }),
      icon: <SunMoon size={15} aria-hidden="true" />,
      run: () => {
        setTheme(cycleThemeMode(theme));
        onClose();
      },
    });
    if (canManageMembers(role)) {
      list.push({
        id: 'sync',
        label: t('switcher.syncSpace'),
        icon: <RefreshCw size={15} aria-hidden="true" className={sync.isPending ? 'animate-spin' : undefined} />,
        run: () => sync.mutate(),
      });
    }
    list.push({
      id: 'help',
      label: t('auth.userMenu.help'),
      icon: <CircleHelp size={15} aria-hidden="true" />,
      run: () => setHelpOpen(true),
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, theme, sync.isPending, t]);

  const recentEntries = useMemo<Entry[]>(() => {
    const liveRecents = recentValidation.data ? recents.filter((r) => validRecentKeys.has(`${r.space}:${r.id}`)) : [];
    const filtered = fuzzyFilter(query, liveRecents, (r) => r.title);
    return filtered.map((page: RecentPage) => ({
      kind: 'recent' as const,
      key: `recent:${page.space}:${page.id}`,
      label: page.title,
      icon: page.icon,
      go: () => go(`/s/${page.space}/p/${page.id}`),
    }));
  }, [query, recents, recentValidation.data, validRecentKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  const hitEntries = useMemo<Entry[]>(() => {
    if (!trimmed) return [];
    return (searchData?.hits ?? []).map((hit: SearchHit) => ({
      kind: 'hit' as const,
      key: `hit:${hit.id}`,
      label: hit.title,
      snippet: hit.snippet,
      go: () => go(`/s/${hit.space}/p/${hit.id}`),
    }));
  }, [trimmed, searchData]); // eslint-disable-line react-hooks/exhaustive-deps

  const actionEntries = useMemo<Entry[]>(() => {
    const filtered = fuzzyFilter(query, actions, (a) => a.label);
    return filtered.map((action) => ({
      kind: 'action' as const,
      key: `action:${action.id}`,
      label: action.label,
      icon: action.icon,
      run: action.run,
    }));
  }, [query, actions]);

  const entries = useMemo(
    () => [...recentEntries, ...hitEntries, ...actionEntries],
    [recentEntries, hitEntries, actionEntries],
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [query, entries.length]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  function activate(entry: Entry | undefined) {
    if (!entry) return;
    if (entry.kind === 'action') entry.run();
    else entry.go();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, entries.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      activate(entries[activeIndex]);
    } else if (event.key === 'Escape') {
      onClose();
    }
  }

  let renderIndex = -1;

  return (
    <div
      // Round 14: less top offset on <md — 12vh is a big enough chunk of a
      // phone's height to meaningfully shrink the results list below it.
      // Width is already effectively calc(100vw-2rem) via this p-4 + the
      // dialog's own w-full below, with nothing extra needed for that part.
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[6vh] md:pt-[12vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('switcher.label')}
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
      >
        <div className="flex items-center gap-2 border-b border-neutral-200 px-3.5 py-2.5 dark:border-neutral-700">
          <Search size={16} className="shrink-0 text-neutral-400" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('switcher.placeholder')}
            className="w-full min-w-0 bg-transparent text-sm text-neutral-900 outline-none placeholder:text-neutral-400 dark:text-neutral-100"
            role="combobox"
            aria-expanded="true"
            aria-controls="folio-switcher-list"
            aria-autocomplete="list"
          />
        </div>

        <div ref={listRef} id="folio-switcher-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {recentEntries.length > 0 && (
            <Section label={t('switcher.recent')}>
              {recentEntries.map((entry) => {
                renderIndex++;
                return (
                  <Row key={entry.key} index={renderIndex} active={renderIndex === activeIndex} onActivate={() => activate(entry)}>
                    {entry.kind === 'recent' && entry.icon ? (
                      <span aria-hidden="true">{entry.icon}</span>
                    ) : (
                      <Clock size={14} className="opacity-60" aria-hidden="true" />
                    )}
                    <span className="truncate">{entry.label}</span>
                  </Row>
                );
              })}
            </Section>
          )}

          {trimmed && (
            <Section label={searching ? t('switcher.searching') : t('switcher.searchResults')}>
              {hitEntries.length === 0 && !searching && (
                <div className="px-2.5 py-2 text-sm text-neutral-400">{t('switcher.noResults', { query: trimmed })}</div>
              )}
              {hitEntries.map((entry) => {
                renderIndex++;
                return (
                  <Row key={entry.key} index={renderIndex} active={renderIndex === activeIndex} onActivate={() => activate(entry)}>
                    <FileText size={14} className="mt-0.5 shrink-0 opacity-60" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{entry.label}</span>
                      {entry.kind === 'hit' && (
                        <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">{entry.snippet}</span>
                      )}
                    </span>
                  </Row>
                );
              })}
            </Section>
          )}

          {actionEntries.length > 0 && (
            <Section label={t('switcher.actions')}>
              {actionEntries.map((entry) => {
                renderIndex++;
                return (
                  <Row key={entry.key} index={renderIndex} active={renderIndex === activeIndex} onActivate={() => activate(entry)}>
                    {entry.kind === 'action' && entry.icon}
                    <span className="truncate">{entry.label}</span>
                  </Row>
                );
              })}
            </Section>
          )}

          {entries.length === 0 && !trimmed && (
            <div className="px-2.5 py-2 text-sm text-neutral-400">{t('switcher.emptyHint')}</div>
          )}
        </div>
      </div>

      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-1 last:mb-0">
      <div className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-neutral-400 dark:text-neutral-500">{label}</div>
      {children}
    </div>
  );
}

function Row({
  index,
  active,
  onActivate,
  children,
}: {
  index: number;
  active: boolean;
  onActivate: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      data-index={index}
      onClick={onActivate}
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-neutral-800 dark:text-neutral-200 ${
        active ? 'bg-neutral-100 dark:bg-neutral-800' : ''
      }`}
    >
      {children}
    </button>
  );
}
