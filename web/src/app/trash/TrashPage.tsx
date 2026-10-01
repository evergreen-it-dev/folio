import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronLeft, ChevronRight, RotateCcw, Trash2 } from 'lucide-react';
import type { TrashItemInfo } from '@shared/contracts';
import { api } from '../api';
import { formatDateTime } from '../formatDate';
import { useApiErrorText } from '../errorText';
import { useAuth } from '../auth/AuthProvider';
import { useDocumentTitle } from '../hooks';
import { useToast } from '../ui/Toast';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import '../i18n/register';

/**
 * `/trash` (trash round) — the trash list with "what / type / where it was /
 * who deleted it / when" columns, space/kind/date filters, "Restore" and
 * "Delete permanently" (the latter behind the hard ConfirmDialog whose text
 * carries "irreversibly"), plus "empty the trash" and the instance-admin
 * retention setting.
 *
 * Reached from the user menu's "Administration" section (instance admin)
 * and from the space menu (that link pre-fills `?space=`). NOT client-gated
 * by role beyond having a session: the server already scopes the list to
 * what the caller administers, so a viewer simply sees an empty trash —
 * same server-is-the-authority stance every admin surface here takes.
 *
 * Server-side pagination (03.09.2026): every filter (space/kind/from/to)
 * and the current `offset` are part of the query, ride the query key, and
 * go straight to `GET /api/trash`. `spaces` for the space-filter <select>
 * comes from the response's own `spaces` field (everything the caller can
 * see, independent of the current page), not from the page's own items —
 * otherwise the option list would shrink to whatever happens to be on the
 * current page.
 */
const PAGE_SIZE = 100;

export function TrashPage() {
  const { t, i18n } = useTranslation('app');
  const errorText = useApiErrorText();
  const { user } = useAuth();
  useDocumentTitle(t('trash.title'));
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const spaceFilter = searchParams.get('space') ?? '';
  const [kindFilter, setKindFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [offset, setOffset] = useState(0);
  const [purging, setPurging] = useState<TrashItemInfo | null>(null);
  const [emptying, setEmptying] = useState(false);
  /** null = not edited yet (render the fetched value). */
  const [retentionInput, setRetentionInput] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['trash', spaceFilter, kindFilter, fromDate, toDate, offset],
    queryFn: () =>
      api.listTrash({
        space: spaceFilter || undefined,
        kind: kindFilter || undefined,
        from: fromDate || undefined,
        to: toDate || undefined,
        limit: PAGE_SIZE,
        offset,
      }),
    // Owner ask (10.09.2026): a delete/restore/purge done elsewhere should
    // show up here on refocus without an F5 — see PageTree's comment. No
    // poll: this is a paginated admin list someone reads occasionally, not
    // a surface anyone stares at expecting live updates.
    refetchOnWindowFocus: true,
  });
  const { data: settings } = useQuery({ queryKey: ['trash', 'settings'], queryFn: api.getTrashSettings, enabled: user.isAdmin });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const spaceOptions = data?.spaces ?? [];

  function setSpaceFilter(space: string) {
    setOffset(0);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (space) next.set('space', space);
      else next.delete('space');
      return next;
    });
  }

  function updateKindFilter(kind: string) {
    setOffset(0);
    setKindFilter(kind);
  }

  function updateFromDate(value: string) {
    setOffset(0);
    setFromDate(value);
  }

  function updateToDate(value: string) {
    setOffset(0);
    setToDate(value);
  }

  const restore = useMutation({
    mutationFn: (item: TrashItemInfo) => api.restoreTrashItem(item.id),
    onSuccess: (res, item) => {
      queryClient.invalidateQueries({ queryKey: ['trash'] });
      queryClient.invalidateQueries({ queryKey: ['tree', res.space] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      // The toast MUST show the ACTUAL path from the response — on a
      // conflict the server restored alongside with a -restored suffix.
      const href = item.kind === 'space' ? `/s/${encodeURIComponent(res.space)}` : `/s/${encodeURIComponent(res.space)}/p/${encodeURIComponent(res.pageId)}`;
      const message =
        item.kind === 'space'
          ? t('trash.restoredSpace', { space: res.pageId })
          : res.renamed
            ? t('trash.restoredConflict', { path: res.restoredPath })
            : t('trash.restored', { path: res.restoredPath });
      showToast(message, 'info', { label: t('trash.open'), href });
    },
    onError: (err) => showToast(errorText(err, 'trash.restoreFailed')),
  });

  const purge = useMutation({
    mutationFn: (item: TrashItemInfo) => api.purgeTrashItem(item.id),
    onSuccess: () => {
      setPurging(null);
      queryClient.invalidateQueries({ queryKey: ['trash'] });
    },
    onError: (err) => {
      setPurging(null);
      showToast(errorText(err, 'trash.deleteFailed'));
    },
  });

  const empty = useMutation({
    mutationFn: () => api.emptyTrash(spaceFilter || undefined),
    onSuccess: (res) => {
      setEmptying(false);
      queryClient.invalidateQueries({ queryKey: ['trash'] });
      showToast(t('trash.emptied', { count: res.removed }), 'info');
    },
    onError: (err) => {
      setEmptying(false);
      showToast(errorText(err, 'trash.deleteFailed'));
    },
  });

  const saveRetention = useMutation({
    mutationFn: (retentionDays: number | null) => api.setTrashRetention(retentionDays),
    onSuccess: (res) => {
      queryClient.setQueryData(['trash', 'settings'], res);
      setRetentionInput(null);
      showToast(t('trash.retention.saved'), 'info');
    },
    onError: (err) => showToast(errorText(err, 'trash.retention.failed')),
  });

  const retentionValue = retentionInput ?? (settings?.retentionDays != null ? String(settings.retentionDays) : '');

  return (
    <div className="min-h-full bg-white dark:bg-neutral-950">
      <header className="flex h-14 items-center gap-2 border-b border-neutral-200 px-3 dark:border-neutral-800 md:gap-3 md:px-4">
        <Link
          to="/"
          aria-label={t('ui.back')}
          className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 max-md:min-h-10 max-md:min-w-10 dark:hover:bg-neutral-800"
        >
          <ArrowLeft size={17} />
        </Link>
        <h1 className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t('trash.title')}</h1>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setEmptying(true)}
            disabled={total === 0}
            className="flex items-center gap-1.5 rounded-md border border-red-300 px-2 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-40 max-md:min-h-10 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950 md:px-3"
          >
            <Trash2 size={14} className="shrink-0" /> <span className="hidden md:inline">{t('trash.emptyTrash')}</span>
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl p-4 md:p-6">
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
            {t('trash.filters.space')}
            <select
              value={spaceFilter}
              onChange={(e) => setSpaceFilter(e.target.value)}
              className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
            >
              <option value="">{t('trash.filters.allSpaces')}</option>
              {spaceOptions.map((slug) => (
                <option key={slug} value={slug}>
                  {slug}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
            {t('trash.filters.kind')}
            <select
              value={kindFilter}
              onChange={(e) => updateKindFilter(e.target.value)}
              className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
            >
              <option value="">{t('trash.filters.allKinds')}</option>
              {(['doc', 'board', 'table', 'pdf', 'office', 'form', 'folder', 'space'] as const).map((kind) => (
                <option key={kind} value={kind}>
                  {t(`trash.kinds.${kind}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
            {t('trash.filters.from')}
            <input
              type="date"
              value={fromDate}
              onChange={(e) => updateFromDate(e.target.value)}
              className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
            {t('trash.filters.to')}
            <input
              type="date"
              value={toDate}
              onChange={(e) => updateToDate(e.target.value)}
              className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
            />
          </label>
        </div>

        {isLoading && <p className="text-sm text-neutral-400">{t('ui.loading')}</p>}
        {isError && <p className="text-sm text-red-600 dark:text-red-400">{t('trash.loadFailed')}</p>}
        {!isLoading && !isError && items.length === 0 && <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('trash.empty')}</p>}

        {items.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
                  <th className="px-3 py-2 font-medium">{t('trash.columns.what')}</th>
                  <th className="px-3 py-2 font-medium">{t('trash.columns.kind')}</th>
                  <th className="px-3 py-2 font-medium">{t('trash.columns.where')}</th>
                  <th className="px-3 py-2 font-medium">{t('trash.columns.who')}</th>
                  <th className="px-3 py-2 font-medium">{t('trash.columns.when')}</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-neutral-100 last:border-b-0 dark:border-neutral-800/60">
                    <td className="px-3 py-2">
                      <span className="font-medium text-neutral-900 dark:text-neutral-100">{item.title}</span>
                      {item.childrenCount > 0 && (
                        <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                          {t('trash.childrenCount', { count: item.childrenCount })}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-300">{t(`trash.kinds.${item.kind}`)}</td>
                    <td className="px-3 py-2">
                      <code className="text-xs text-neutral-500 dark:text-neutral-400">
                        {item.space}
                        {item.origPath ? `/${item.origPath}` : ''}
                      </code>
                    </td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-300">{item.deletedBy?.name ?? t('trash.unknownUser')}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-neutral-600 dark:text-neutral-300">{formatDateTime(item.deletedAt, i18n.language)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          disabled={restore.isPending}
                          onClick={() => restore.mutate(item)}
                          className="flex items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                        >
                          <RotateCcw size={12} /> {t('trash.restore')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setPurging(item)}
                          className="flex items-center gap-1 rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
                        >
                          <Trash2 size={12} /> {t('trash.deleteForever')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > 0 && (
          <div className="mt-3 flex items-center justify-between gap-3 text-xs text-neutral-500 dark:text-neutral-400">
            <span>{t('trash.pagination.range', { from: offset + 1, to: Math.min(offset + PAGE_SIZE, total), total })}</span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={offset === 0}
                onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                className="flex items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                <ChevronLeft size={12} /> {t('trash.pagination.prev')}
              </button>
              <button
                type="button"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
                className="flex items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                {t('trash.pagination.next')} <ChevronRight size={12} />
              </button>
            </div>
          </div>
        )}

        {user.isAdmin && (
          <div className="mt-6 flex flex-wrap items-end gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
            <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              {t('trash.retention.label')}
              <input
                type="number"
                min={1}
                max={3650}
                value={retentionValue}
                onChange={(e) => setRetentionInput(e.target.value)}
                placeholder="∞"
                className="w-28 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
              />
            </label>
            <button
              type="button"
              disabled={saveRetention.isPending || retentionInput === null}
              onClick={() => {
                const parsed = Number.parseInt(retentionValue, 10);
                saveRetention.mutate(Number.isFinite(parsed) && parsed > 0 ? parsed : null);
              }}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
            >
              {t('trash.retention.save')}
            </button>
            <p className="basis-full text-xs text-neutral-400 dark:text-neutral-500">{t('trash.retention.hint')}</p>
          </div>
        )}
      </main>

      {purging && (
        <ConfirmDialog
          title={t('trash.deleteForeverTitle')}
          confirmLabel={t('trash.deleteForever')}
          destructive
          busy={purge.isPending}
          onConfirm={() => purge.mutate(purging)}
          onCancel={() => setPurging(null)}
        >
          <p className="text-sm text-neutral-600 dark:text-neutral-300">{t('trash.deleteForeverText', { title: purging.title })}</p>
        </ConfirmDialog>
      )}
      {emptying && (
        <ConfirmDialog
          title={t('trash.emptyTrashTitle')}
          confirmLabel={t('trash.emptyTrash')}
          destructive
          busy={empty.isPending}
          onConfirm={() => empty.mutate()}
          onCancel={() => setEmptying(false)}
        >
          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            {spaceFilter ? t('trash.emptyTrashTextSpace', { space: spaceFilter }) : t('trash.emptyTrashText')}
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
