import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { PageHistoryEntry } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { useToast } from '../ui/Toast';
import { Modal } from '../ui/Modal';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { formatRelativeDate, shortSha } from '../history';
import { Markdown } from '../../markdown';
import '../i18n/register';

export interface HistoryPanelProps {
  pageId: string;
  space: string;
  pagePath: string;
  canRestore: boolean;
  onClose: () => void;
}

/** `git log --follow` for this page (list) + a read-only render of any selected version, with restore for editor+. */
export function HistoryPanel({ pageId, space, pagePath, canRestore, onClose }: HistoryPanelProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const [selected, setSelected] = useState<PageHistoryEntry | null>(null);

  const { data: entries, isLoading, isError, refetch } = useQuery({
    queryKey: ['history', pageId],
    queryFn: () => api.getPageHistory(pageId),
  });
  useEffect(() => {
    if (!selected && entries?.[0]) setSelected(entries[0]);
  }, [entries, selected]);
  const selectedIndex = selected && entries ? entries.findIndex((item) => item.sha === selected.sha) : -1;
  const comparisonEntry = selectedIndex >= 0 ? entries?.[selectedIndex + 1] : undefined;

  return (
    <Modal title={t('history.panel.title')} onClose={onClose} size="xl">
      {/* Round 14 QA fix: h-[60vh] alone could exceed what's actually left
          once Modal's own chrome (title bar, padding, the backdrop's margin)
          is subtracted on a short/mobile viewport — min() caps it against
          that instead. <md stacks list-over-preview (list height-bounded,
          own scroll) rather than the md+ side-by-side columns. */}
      <div className="flex h-[min(72vh,calc(100dvh-9rem))] flex-col gap-4 md:flex-row">
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto md:h-full md:pr-3">
          {selected ? (
            <HistoryVersionPreview
              pageId={pageId}
              space={space}
              pagePath={pagePath}
              entry={selected}
              comparisonEntry={comparisonEntry}
              canRestore={canRestore}
              onRestored={onClose}
            />
          ) : (
            <p className="p-4 text-sm text-neutral-400">{t('history.panel.selectVersionRight')}</p>
          )}
        </div>

        <div className="max-h-40 w-full shrink-0 overflow-y-auto border-t border-neutral-200 pt-3 dark:border-neutral-800 md:h-full md:max-h-none md:w-72 md:border-l md:border-t-0 md:pl-3 md:pt-0">
          {isLoading && <p className="p-1 text-sm text-neutral-400">{t('ui.loading')}</p>}
          {isError && (
            <p className="p-1 text-sm text-red-600 dark:text-red-400">
              {t('history.panel.loadFailed')}{' '}
              <button type="button" onClick={() => refetch()} className="underline underline-offset-2">
                {t('auth.retry')}
              </button>
            </p>
          )}
          {entries && entries.length === 0 && <p className="p-1 text-sm text-neutral-400">{t('history.panel.empty')}</p>}
          <ul className="flex flex-col gap-0.5">
            {entries?.map((entry) => (
              <li key={entry.sha}>
                <button
                  type="button"
                  onClick={() => setSelected(entry)}
                  className={`block w-full rounded-md px-2 py-1.5 text-left ${
                    selected?.sha === entry.sha
                      ? 'bg-neutral-100 dark:bg-neutral-800'
                      : 'hover:bg-neutral-50 dark:hover:bg-neutral-900'
                  }`}
                >
                  <div className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                    {entry.author}
                  </div>
                  <div className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                    {formatRelativeDate(entry.date)} · {shortSha(entry.sha)}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-neutral-400 dark:text-neutral-500">
                    {entry.message}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>

      </div>
    </Modal>
  );
}

interface HistoryVersionPreviewProps {
  pageId: string;
  space: string;
  pagePath: string;
  entry: PageHistoryEntry;
  comparisonEntry?: PageHistoryEntry;
  canRestore: boolean;
  onRestored: () => void;
}

function HistoryVersionPreview({ pageId, space, pagePath, entry, comparisonEntry, canRestore, onRestored }: HistoryVersionPreviewProps) {
  const { t, i18n } = useTranslation('app');
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [showDiff, setShowDiff] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['history', pageId, entry.sha],
    queryFn: () => api.getPageHistoryVersion(pageId, entry.sha),
  });
  const { data: comparison, isLoading: isDiffLoading } = useQuery({
    queryKey: ['history', pageId, comparisonEntry?.sha],
    queryFn: () => api.getPageHistoryVersion(pageId, comparisonEntry!.sha),
    enabled: showDiff && Boolean(comparisonEntry),
  });

  const restore = useMutation({
    mutationFn: () => api.restoreVersion(pageId, entry.sha),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['page', pageId] });
      showToast(t('history.panel.restored'), 'info');
      onRestored();
    },
    onError: (err) => showToast(errorText(err, 'history.panel.restoreFailed')),
  });

  return (
    <div>
      <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 bg-white pb-3 dark:border-neutral-800 dark:bg-neutral-900">
        <span className="text-sm text-neutral-500 dark:text-neutral-400">
          {t('history.panel.versionFrom', { date: new Date(entry.date).toLocaleString(i18n.language) })}
        </span>
        <div className="flex items-center gap-2">
          {data?.markdown !== undefined && comparisonEntry && (
            <button
              type="button"
              onClick={() => setShowDiff((value) => !value)}
              className="shrink-0 rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              {t(showDiff ? 'history.panel.hideDiff' : 'history.panel.showDiff')}
            </button>
          )}
        {canRestore && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="shrink-0 rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900"
          >
            {t('history.panel.restoreThisVersion')}
          </button>
        )}
        </div>
      </div>

      {isLoading && <p className="text-sm text-neutral-400">{t('history.panel.loadingVersion')}</p>}
      {isError && <p className="text-sm text-red-600 dark:text-red-400">{t('history.panel.contentLoadFailed')}</p>}
      {data?.svg !== undefined && <HistorySvgPreview svg={data.svg} />}
      {data?.markdown !== undefined && showDiff && isDiffLoading && (
        <p className="text-sm text-neutral-400">{t('history.panel.loadingDiff')}</p>
      )}
      {data?.markdown !== undefined && showDiff && comparison?.markdown !== undefined ? (
        <HistoryDiff before={comparison.markdown} after={data.markdown} />
      ) : data?.markdown !== undefined ? (
        <div className="text-[13px] [&_.folio-markdown]:max-w-none">
          <Markdown markdown={data.markdown} space={space} pagePath={pagePath} />
        </div>
      ) : null}
      {data && data.svg === undefined && data.markdown === undefined && (
        <p className="text-sm text-neutral-400">{t('history.panel.versionEmpty')}</p>
      )}

      {confirming && (
        <ConfirmDialog
          title={t('history.panel.restoreConfirmTitle')}
          confirmLabel={t('history.panel.restoreConfirmAction')}
          busy={restore.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => restore.mutate()}
        >
          {t('history.panel.restoreConfirmBody', { date: formatRelativeDate(entry.date) })}
        </ConfirmDialog>
      )}
    </div>
  );
}

type DiffLine = { kind: 'same' | 'add' | 'remove'; text: string };

/** Small line-level LCS diff: enough context to see exactly what one history entry changed. */
export function diffLines(before: string, after: string): DiffLine[] {
  const left = before.split('\n');
  const right = after.split('\n');
  if (left.length * right.length > 1_000_000) {
    return [
      ...left.map((text) => ({ kind: 'remove' as const, text })),
      ...right.map((text) => ({ kind: 'add' as const, text })),
    ];
  }
  const lcs = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      lcs[i][j] = left[i] === right[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      result.push({ kind: 'same', text: left[i++] });
      j++;
    } else if (j < right.length && (i === left.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      result.push({ kind: 'add', text: right[j++] });
    } else {
      result.push({ kind: 'remove', text: left[i++] });
    }
  }
  return result;
}

function HistoryDiff({ before, after }: { before: string; after: string }) {
  const lines = diffLines(before, after);
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-50 font-mono text-xs leading-5 dark:border-neutral-800 dark:bg-neutral-950">
      {lines.map((line, index) => (
        <div
          key={`${index}-${line.kind}`}
          className={`grid grid-cols-[2rem_minmax(0,1fr)] px-2 ${
            line.kind === 'add'
              ? 'bg-emerald-100 text-emerald-950 dark:bg-emerald-950/50 dark:text-emerald-100'
              : line.kind === 'remove'
                ? 'bg-red-100 text-red-950 dark:bg-red-950/50 dark:text-red-100'
                : 'text-neutral-500 dark:text-neutral-400'
          }`}
        >
          <span className="select-none opacity-60">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span>
          <span className="whitespace-pre-wrap break-words">{line.text || ' '}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Round 5 follow-up: board version preview. Same safe `data:image/svg+xml`
 * `<img>` approach as StaticBoardView.tsx (not dangerouslySetInnerHTML) —
 * an image context never executes embedded scripts/handlers, which matters
 * since this string is a historical git blob, not something re-sanitized
 * on the way here.
 */
function HistorySvgPreview({ svg }: { svg: string }) {
  const { t } = useTranslation('app');
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return <img src={src} alt={t('history.panel.boardVersionAlt')} className="mx-auto max-w-full" />;
}
