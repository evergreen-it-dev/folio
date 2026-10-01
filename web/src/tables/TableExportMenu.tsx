import { useEffect, useRef, useState } from 'react';
import { Check, Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Checkbox } from './ui/Checkbox';
import type { ExportFormat } from './export';

/**
 * Round 26 (DATA TABLES) — export menu.
 *
 * Deliberately modelled on diagrams/BoardExportMenu.tsx, including its
 * central rule, which DEV-PLAN R26 points at by name: **export must never
 * fail silently.** That component exists because Excalidraw's built-in
 * export died with no visible error in a real browser (the File System
 * Access API being present but refusing `createWritable()`), and the owner
 * simply got nothing. So: every action is awaited, every rejection is
 * caught, logged AND surfaced as a visible `role="alert"` line — the catch
 * block is never allowed to just swallow.
 *
 * Two spec §10 controls ride along in the panel because they change what
 * the file contains and are easy to get wrong afterwards: scope (current
 * view vs the whole dataset) and whether the `id` column is included.
 */

const FEEDBACK_MS = 2500;

const FORMATS: ExportFormat[] = ['csv', 'tsv', 'md', 'yaml', 'json'];

export interface TableExportMenuProps {
  /** Resolves on success, rejects on failure — the menu surfaces either. */
  onExport: (format: ExportFormat, options: { scope: 'view' | 'all'; includeIds: boolean }) => Promise<void>;
  /** Row counts for the two scopes, shown so the choice is informed. */
  viewCount: number;
  totalCount: number;
}

export function TableExportMenu({ onExport, viewCount, totalCount }: TableExportMenuProps) {
  const { t } = useTranslation('tables');
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<ExportFormat | null>(null);
  const [failed, setFailed] = useState<ExportFormat | null>(null);
  const [done, setDone] = useState<ExportFormat | null>(null);
  const [scope, setScope] = useState<'view' | 'all'>('view');
  const [includeIds, setIncludeIds] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function run(format: ExportFormat) {
    setPending(format);
    setFailed(null);
    setDone(null);
    try {
      await onExport(format, { scope, includeIds });
      setDone(format);
    } catch (error) {
      // The entire point of this component. Never a bare `catch {}`.
      console.error(`table export (${format}) failed`, error);
      setFailed(format);
    } finally {
      setPending(null);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setDone(null);
        setFailed(null);
      }, FEEDBACK_MS);
    }
  }

  const busy = pending !== null;

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 max-md:min-h-10 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
      >
        <Download size={12} />
        {t('export.button')}
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t('export.aria')}
          className="absolute right-0 top-full z-30 mt-1 flex w-56 flex-col rounded-lg border border-neutral-300 bg-white py-1 text-xs shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
        >
          <div className="flex flex-col gap-1.5 border-b border-neutral-200 px-3 py-2 dark:border-neutral-700">
            <label className="flex items-center gap-1.5 text-neutral-600 dark:text-neutral-300">
              <input
                type="radio"
                name="table-export-scope"
                checked={scope === 'view'}
                onChange={() => setScope('view')}
                className="accent-blue-600"
              />
              {t('export.scopeView', { n: viewCount })}
            </label>
            <label className="flex items-center gap-1.5 text-neutral-600 dark:text-neutral-300">
              <input
                type="radio"
                name="table-export-scope"
                checked={scope === 'all'}
                onChange={() => setScope('all')}
                className="accent-blue-600"
              />
              {t('export.scopeAll', { n: totalCount })}
            </label>
            <Checkbox checked={includeIds} onChange={setIncludeIds} label={t('export.includeIds')} />
          </div>

          {FORMATS.map((format) => (
            <button
              key={format}
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => void run(format)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-left text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              {done === format && <Check size={12} className="text-green-600 dark:text-green-400" />}
              {t(`export.format.${format}`)}
            </button>
          ))}

          {failed && (
            <p role="alert" className="px-3 pt-1 pb-1.5 text-red-600 dark:text-red-400">
              {t('export.failed')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
