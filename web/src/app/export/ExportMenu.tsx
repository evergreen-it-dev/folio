import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Braces, Download, FileCode, FileText, FileType } from 'lucide-react';
import type { ExportFormat } from '@shared/contracts';
import { useApiErrorText } from '../errorText';
import { Menu } from '../ui/Menu';
import { downloadBlob } from '../../diagrams/download';
import { fetchPageExport, isChromiumUnavailable } from './pageExport';
import '../i18n/register';

/** R23 tail: what the menu needs to know about the CURRENT table page's views. Absent for non-table pages. */
export interface ExportMenuTableInfo {
  /** The view active in the grid right now — the selector's default. */
  activeViewId: string;
  views: { id: string; name: string }[];
}

export interface ExportMenuProps {
  pageId: string;
  /** PageMeta's `path`/`title` — only ever used to name the file if the response's Content-Disposition is missing. */
  pagePath?: string;
  title?: string;
  /**
   * R23 tail (table view picker): present only on table pages, threaded up
   * from the grid via useSetHeaderInfo (Shell.tsx). When present, every
   * export carries `?view=<id>`; a selector appears only when there is an
   * actual choice (>1 saved views).
   */
  table?: ExportMenuTableInfo;
}

const FORMATS: readonly ExportFormat[] = ['md', 'pdf', 'docx', 'yaml'];

const FORMAT_ICONS: Record<ExportFormat, ReactNode> = {
  md: <FileCode size={14} aria-hidden="true" />,
  pdf: <FileText size={14} aria-hidden="true" />,
  docx: <FileType size={14} aria-hidden="true" />,
  yaml: <Braces size={14} aria-hidden="true" />,
};

/** A settled export's outcome, shown inside the panel. `warning` is a 200 that came back truncated. */
type Feedback = { tone: 'warning' | 'error'; text: string; detail?: string };

/**
 * Resets the panel's transient state every time it opens. Same idiom (and
 * the same reason) as ShareButton's SharePanel: `Menu` only calls its
 * children render-prop while open, but ExportMenu itself stays mounted, so
 * without this a warning from a previous export would still be sitting there
 * the next time the panel is opened.
 */
function ExportPanel({ onOpen, children }: { onOpen: () => void; children: ReactNode }) {
  useEffect(() => {
    onOpen();
  }, [onOpen]);
  return <div className="w-64 p-1">{children}</div>;
}

/**
 * Round 23 (EXPORT) — "Export" in the page menu: Markdown / PDF / DOCX,
 * with an opt-in for collating the page's subtree into one document.
 *
 * Modeled on diagrams/BoardExportMenu.tsx, which exists precisely because an
 * export that fails silently is the bug this codebase already paid for once.
 * The three rules carried over from it:
 *   - every outcome is surfaced (`role="alert"`), nothing is swallowed;
 *   - the failure is also console.error'd, so a support screenshot of the
 *     console has the real cause and not just the localized copy;
 *   - a busy menu disables all of its items rather than queueing exports.
 *
 * The one behavior this adds on top: a TRUNCATED export is a 200 with a valid
 * file attached, so it downloads AND holds the panel open with a warning.
 * Treating it as a plain success (closing the menu, letting the browser's
 * download chrome be the only feedback) would be exactly the silent-failure
 * mode BoardExportMenu was written to end.
 */
export function ExportMenu({ pageId, pagePath, title, table }: ExportMenuProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const [pending, setPending] = useState<ExportFormat | null>(null);
  const [includeChildren, setIncludeChildren] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // R23 tail: the table view the export will ask for. Re-defaulted to the
  // grid's CURRENT view every time the panel opens (below) — switching views
  // in the grid between two exports must not leave a stale pick here.
  const [viewId, setViewId] = useState<string | undefined>(table?.activeViewId);

  const activeViewId = table?.activeViewId;
  const resetPanel = useCallback(() => {
    setFeedback(null);
    setViewId(activeViewId);
  }, [activeViewId]);

  function describeFailure(error: unknown, format: ExportFormat): string {
    // The only export failure with a different remedy for the user ("ask an
    // admin to install chromium"), so it must not read as a generic error.
    if (format === 'pdf' && isChromiumUnavailable(error)) return t('export.pdfUnavailable');
    return errorText(error, 'export.failed');
  }

  function describeTruncation(reason: string, pageCount: number | null): string {
    // `pages`/`bytes`/`rows` get their own copy; anything else the server
    // starts reporting still lands on the generic line rather than vanishing.
    const key = ['pages', 'bytes', 'rows'].includes(reason) ? `export.truncated.${reason}` : 'export.truncated.generic';
    // Interpolated as `pages`, NOT `count`: i18next treats `count` as the
    // plural selector and would resolve `…truncated.pages_one`/`_other`
    // instead of the key we actually wrote.
    return t(key, { pages: pageCount ?? '?' });
  }

  async function run(format: ExportFormat, close: () => void) {
    setPending(format);
    setFeedback(null);
    try {
      // `view` rides on every table-page export (even with a single view):
      // the grid's current view is what the user is looking at, and the
      // server's no-param default (the first view) can differ from it.
      const result = await fetchPageExport(
        pageId,
        format,
        { children: includeChildren, ...(table ? { view: viewId ?? table.activeViewId } : {}) },
        { path: pagePath, title },
      );
      downloadBlob(result.blob, result.filename);
      if (result.truncation) {
        setFeedback({
          tone: 'warning',
          text: describeTruncation(result.truncation.reason, result.pageCount),
          detail: result.truncation.detail,
        });
      } else {
        // Clean export — the browser's own download chrome is the confirmation,
        // exactly as in BoardExportMenu.
        close();
      }
    } catch (error) {
      console.error(`page export (${format}) failed`, error);
      setFeedback({ tone: 'error', text: describeFailure(error, format) });
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null;

  return (
    <Menu triggerLabel={t('export.button')} align="right" trigger={<Download size={15} aria-hidden="true" />}>
      {(close) => (
        <ExportPanel onOpen={resetPanel}>
          <div className="px-1.5 pb-1 pt-1.5 text-xs font-medium text-neutral-400 dark:text-neutral-500">
            {t('export.button')}
          </div>

          {FORMATS.map((format) => (
            <button
              key={format}
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => void run(format, close)}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              {FORMAT_ICONS[format]}
              <span className="truncate">
                {pending === format ? t('export.exporting') : t(`export.format.${format}`)}
              </span>
            </button>
          ))}

          {/* R23 tail: which saved VIEW of a table page to export (filters/
              sort/hidden columns are the view's). Only rendered when there is
              a real choice; with a single view the export still sends it. */}
          {table && table.views.length > 1 && (
            <label className="mt-1 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-neutral-600 dark:text-neutral-400">
              <span className="shrink-0">{t('export.tableView')}</span>
              <select
                value={viewId ?? table.activeViewId}
                disabled={busy}
                onChange={(e) => setViewId(e.target.value)}
                className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-1.5 py-1 text-xs dark:border-neutral-600 dark:bg-neutral-900"
              >
                {table.views.map((view) => (
                  <option key={view.id} value={view.id}>
                    {view.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {/* The same one-flag-two-meanings option as the share popover's, in
              the wording that applies HERE (collation) — see the i18n hint. */}
          <label className="mt-1 flex cursor-pointer items-start gap-2 rounded-md px-2.5 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={includeChildren}
              disabled={busy}
              onChange={(e) => setIncludeChildren(e.target.checked)}
            />
            <span>
              {t('export.includeChildren')}
              <span className="mt-0.5 block text-[11px] leading-snug text-neutral-400 dark:text-neutral-500">
                {t('export.includeChildrenHint')}
              </span>
            </span>
          </label>

          {feedback && (
            <p
              role="alert"
              title={feedback.detail}
              className={`flex items-start gap-1.5 px-2.5 pb-1 pt-1.5 text-xs leading-snug ${
                feedback.tone === 'warning' ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'
              }`}
            >
              <AlertTriangle size={13} aria-hidden="true" className="mt-px shrink-0" />
              <span>{feedback.text}</span>
            </p>
          )}
        </ExportPanel>
      )}
    </Menu>
  );
}
