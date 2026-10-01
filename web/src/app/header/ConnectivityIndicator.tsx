import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CloudOff, RefreshCw, WifiLow } from 'lucide-react';
import { Link } from 'react-router';
import { useOutsideClick } from '../hooks';
import { useConnectivity } from '../offline/connectivity';
import { useDirtyDocs } from '../offline/dirtyDocs';
import { useLocalPages } from '../offline/localPages';
import { requestSync, retryLocalPage, usePendingCount, useSyncStatus } from '../offline/syncEngine';
import '../i18n/register';

/**
 * The connection's state, where it can always be seen (the owner, 29.09.2026:
 * "an indicator of a bad connection and of offline mode in the interface").
 *
 * Silent while everything is fine — a permanent green dot teaches people to
 * stop looking at it. It appears for exactly three reasons: the server
 * cannot be reached, the connection is slow or lossy, or something made on
 * this device has not reached the server yet. Shape and text carry the
 * state, colour only reinforces it (same rule as the editor's own badge).
 *
 * The panel behind it answers the one question an author has at that
 * moment: "what of mine is not saved on the server, and is it going to be?"
 */
export function ConnectivityIndicator() {
  const { t } = useTranslation('app');
  const connectivity = useConnectivity();
  const pending = usePendingCount();
  const sync = useSyncStatus();
  const locals = useLocalPages();
  const dirty = useDirtyDocs();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useOutsideClick([rootRef], () => setOpen(false));

  if (connectivity === 'online' && pending === 0 && !sync.running) return null;

  const mode: 'offline' | 'degraded' | 'syncing' | 'pending' =
    connectivity === 'offline' ? 'offline' : sync.running ? 'syncing' : connectivity === 'degraded' ? 'degraded' : 'pending';

  const label =
    mode === 'pending' ? t('offline.status.pending', { count: pending }) : t(`offline.status.${mode}`);
  const hint = mode === 'offline' || mode === 'degraded' ? t(`offline.title.${mode}`) : label;

  const tone =
    mode === 'offline'
      ? 'border-neutral-300 bg-neutral-100 text-neutral-700 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200'
      : mode === 'degraded'
        ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200'
        : 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200';

  const Icon = mode === 'offline' ? CloudOff : mode === 'degraded' ? WifiLow : RefreshCw;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        data-connectivity={mode}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={hint}
        onClick={() => setOpen((value) => !value)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium max-md:min-h-10 ${tone}`}
      >
        <Icon size={13} aria-hidden="true" className={mode === 'syncing' ? 'animate-spin' : undefined} />
        <span className="max-sm:sr-only">{label}</span>
        {pending > 0 && mode !== 'pending' && (
          <span className="rounded-full bg-black/10 px-1.5 text-[11px] leading-4 dark:bg-white/15" aria-label={t('offline.status.pending', { count: pending })}>
            {pending}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('offline.panel.heading')}
          className="absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-neutral-200 bg-white p-3 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
        >
          {(mode === 'offline' || mode === 'degraded') && (
            <p className="mb-2 text-xs text-neutral-600 dark:text-neutral-300">{t(`offline.title.${mode}`)}</p>
          )}

          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">{t('offline.panel.heading')}</div>
          {pending === 0 ? (
            <p className="text-neutral-500 dark:text-neutral-400">{t('offline.panel.empty')}</p>
          ) : (
            <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
              {locals.map((page) => (
                <li key={page.id} className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/s/${page.space}/p/${page.id}`}
                      onClick={() => setOpen(false)}
                      className="block truncate text-neutral-800 underline-offset-2 hover:underline dark:text-neutral-100"
                    >
                      {page.title}
                    </Link>
                    <span className={`text-xs ${page.state === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-neutral-400'}`}>
                      {t(`offline.panel.state.${page.state}`)}
                      {page.state === 'failed' && page.error ? `: ${page.error}` : ''}
                    </span>
                  </div>
                  {page.state === 'failed' && (
                    <button
                      type="button"
                      onClick={() => void retryLocalPage(page.id)}
                      className="shrink-0 rounded-md border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
                    >
                      {t('offline.panel.retry')}
                    </button>
                  )}
                </li>
              ))}
              {dirty.length > 0 && (
                <li className="text-neutral-600 dark:text-neutral-300">{t('offline.panel.unsyncedEdits', { count: dirty.length })}</li>
              )}
            </ul>
          )}

          {pending > 0 && (
            <button
              type="button"
              disabled={connectivity === 'offline' || sync.running}
              onClick={() => void requestSync()}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <RefreshCw size={12} aria-hidden="true" className={sync.running ? 'animate-spin' : undefined} />
              {t(sync.running ? 'offline.status.syncing' : 'offline.panel.syncNow')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
