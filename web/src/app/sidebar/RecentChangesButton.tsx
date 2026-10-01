import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { CopyPlus, FilePlus2, Link as LinkIcon, Move, Pencil, Trash2, Undo2 } from 'lucide-react';
import type { PageChangeInfo } from '@shared/contracts';
import { api, PAGE_CHANGES_EVENT } from '../api';
import { useApiErrorText } from '../errorText';
import { useOutsideClick, useActivePageId } from '../hooks';
import { useToast } from '../ui/Toast';
import { useTranslation } from 'react-i18next';
import '../i18n/register';

interface Coords {
  top: number;
  left: number;
}

const VIEWPORT_MARGIN = 8;
const HOVER_CLOSE_MS = 180;

function changeIcon(action: PageChangeInfo['action']) {
  if (action === 'page.rename') return <Pencil size={15} aria-hidden="true" />;
  if (action === 'page.move') return <Move size={15} aria-hidden="true" />;
  if (action === 'page.slug') return <LinkIcon size={15} aria-hidden="true" />;
  if (action === 'page.copy') return <CopyPlus size={15} aria-hidden="true" />;
  if (action === 'page.delete') return <Trash2 size={15} aria-hidden="true" />;
  return <FilePlus2 size={15} aria-hidden="true" />;
}

/**
 * The undo button in the stable lower part of the sidebar. On hover/focus it
 * opens an explanatory list, but a click on the button itself undoes #1 at
 * once — no extra second click is needed after a mistake.
 */
export function RecentChangesButton({ space }: { space: string }) {
  const { t, i18n } = useTranslation('app');
  const errorText = useApiErrorText();
  const showToast = useToast();
  const navigate = useNavigate();
  const activePageId = useActivePageId();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);

  const changesQuery = useQuery({
    queryKey: ['pageChanges', space],
    queryFn: () => api.listPageChanges(space),
    // Owner ask (10.09.2026): a change made elsewhere should be undo-able
    // from this list on refocus without an F5 — see PageTree's comment.
    // No poll: this is a short-lived "undo my last few edits" list, not
    // something worth a standing timer.
    refetchOnWindowFocus: true,
  });
  const changes = changesQuery.data?.changes ?? [];
  const latest = changes[0];

  function cancelClose() {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }

  function scheduleClose() {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_MS);
  }

  useEffect(() => () => cancelClose(), []);
  useOutsideClick([triggerRef, panelRef], () => setOpen(false));

  useEffect(() => {
    const refresh = () => queryClient.invalidateQueries({ queryKey: ['pageChanges'] });
    window.addEventListener(PAGE_CHANGES_EVENT, refresh);
    return () => window.removeEventListener(PAGE_CHANGES_EVENT, refresh);
  }, [queryClient]);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const triggerRect = trigger.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    let left = triggerRect.right + 8;
    if (left + panelRect.width > viewportWidth - VIEWPORT_MARGIN) {
      left = Math.max(VIEWPORT_MARGIN, triggerRect.left - panelRect.width - 8);
    }
    const top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(triggerRect.bottom - panelRect.height, viewportHeight - panelRect.height - VIEWPORT_MARGIN),
    );
    setCoords({ top, left });
  }, [open, changes.length, changesQuery.isPending]);

  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, { capture: true });
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, { capture: true });
    };
  }, [open]);

  const undo = useMutation({
    mutationFn: (change: PageChangeInfo) => api.undoPageChange(space, change.id),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['pageChanges', space] });
      queryClient.invalidateQueries({ queryKey: ['tree', space] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      queryClient.invalidateQueries({ queryKey: ['page'] });
      if (!result.page && activePageId === result.undone.pageId) navigate(`/s/${space}`);
      showToast(t('sidebar.changes.undone'), 'info');
    },
    onError: (error) => {
      queryClient.invalidateQueries({ queryKey: ['pageChanges', space] });
      showToast(errorText(error, 'sidebar.changes.undoFailed'));
    },
  });

  function describe(change: PageChangeInfo): string {
    if (change.action === 'page.rename') {
      return t('sidebar.changes.rename', { before: change.before?.title ?? '', after: change.after.title });
    }
    if (change.action === 'page.move') {
      const before = change.before?.parentPath || t('sidebar.move.spaceRoot');
      const after = change.after.parentPath || t('sidebar.move.spaceRoot');
      return t('sidebar.changes.move', { before, after });
    }
    if (change.action === 'page.slug') {
      return t('sidebar.changes.slug', { before: change.before?.slug ?? '', after: change.after.slug });
    }
    if (change.action === 'page.delete') {
      return t('sidebar.changes.delete', { title: change.after.title });
    }
    return t(change.action === 'page.copy' ? 'sidebar.changes.copy' : 'sidebar.changes.create');
  }

  const timeFormat = new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' });

  return (
    <>
      <div className="shrink-0 border-t border-neutral-200 px-2 py-1.5 dark:border-neutral-800">
        <button
          ref={triggerRef}
          type="button"
          aria-disabled={!latest || undo.isPending}
          aria-label={t('sidebar.changes.undoLatest')}
          aria-haspopup="dialog"
          aria-expanded={open}
          onMouseEnter={() => {
            cancelClose();
            setOpen(true);
          }}
          onMouseLeave={scheduleClose}
          onFocus={() => setOpen(true)}
          onClick={() => latest && !undo.isPending && undo.mutate(latest)}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-neutral-600 hover:bg-neutral-200/70 dark:text-neutral-300 dark:hover:bg-neutral-800 ${
            !latest || undo.isPending ? 'cursor-default opacity-45' : ''
          }`}
        >
          <Undo2 size={15} aria-hidden="true" />
          <span>{undo.isPending ? t('sidebar.changes.undoing') : t('sidebar.changes.undoLatest')}</span>
          {changes.length > 0 && <span className="ml-auto text-xs tabular-nums text-neutral-400">{changes.length}</span>}
        </button>
      </div>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={t('sidebar.changes.title')}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            style={{
              position: 'fixed',
              top: coords?.top ?? 0,
              left: coords?.left ?? 0,
              visibility: coords ? 'visible' : 'hidden',
            }}
            className="z-[60] w-[min(380px,calc(100vw-16px))] rounded-xl border border-neutral-200 bg-white p-3 shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
          >
            <h2 className="mb-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t('sidebar.changes.title')}</h2>
            {changesQuery.isPending ? (
              <p className="py-3 text-sm text-neutral-500">{t('sidebar.changes.loading')}</p>
            ) : changes.length === 0 ? (
              <p className="py-3 text-sm text-neutral-500">{t('sidebar.changes.empty')}</p>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                {changes.map((change, index) => {
                  return (
                    <button
                      key={change.id}
                      type="button"
                      disabled={undo.isPending}
                      title={t('sidebar.changes.undoThis')}
                      onClick={() => undo.mutate(change)}
                      className="flex w-full gap-2 border-t border-neutral-100 px-1 py-2.5 text-left first:border-t-0 enabled:hover:bg-neutral-50 disabled:cursor-default dark:border-neutral-800 dark:enabled:hover:bg-neutral-800/60"
                    >
                      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-300">
                        {changeIcon(change.action)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">{change.after.title}</span>
                        <span className="mt-0.5 block truncate text-xs text-neutral-500">{describe(change)}</span>
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-neutral-400">
                        {timeFormat.format(new Date(change.at))} · #{index + 1}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
