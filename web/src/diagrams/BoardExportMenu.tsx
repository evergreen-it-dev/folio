import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Download, Maximize, MoreHorizontal } from 'lucide-react';
import type { BoardMode } from './boardMode';

export type ExportKind = 'png' | 'svg' | 'clipboard';

const MODES: readonly BoardMode[] = ['view', 'edit'];

export interface BoardExportMenuProps {
  onExportPng: () => Promise<void>;
  onExportSvg: () => Promise<void>;
  onCopyToClipboard: () => Promise<void>;
  /**
   * Round 25b-1 §1 (owner, from a real iPhone): below Tailwind's `md` the
   * ENTIRE board chrome row — fit-to-screen, this menu and the
   * View/Edit toggle — collapses into this one icon-only button,
   * because at 375px the expanded row was 342px wide, i.e. the whole screen,
   * and ate a line of vertical space right under Excalidraw's tool island.
   * The controls that stand next to this menu on a desktop move INSIDE it
   * (below), which is why this component takes them as props rather than a
   * caller stacking them beside it: there is only one popover on a phone.
   *
   * Everything else — the click-outside/Escape handling, the pending and
   * "Copied"/failure feedback — is shared verbatim between the two
   * shapes; only the trigger and the extra menu rows differ.
   */
  compact?: boolean;
  /** Compact only: the fit-to-screen action that is its own button on desktop. Ignored otherwise. */
  onFitToScreen?: () => void;
  /** Compact only: current board mode, for the view/edit rows folded into the menu. */
  mode?: BoardMode;
  /** Compact only: omit for a non-editable load — a view-only guest has no mode to switch to, so no rows are rendered (same rule BoardCanvas applies to BoardModeToggle on desktop). */
  onSelectMode?: (mode: BoardMode) => void;
}

/** How long the transient "Copied" / error line stays up after an action settles. */
const FEEDBACK_MS = 2500;

/**
 * Round 21 follow-up (DIAGRAMS) — our own reliable "Export" button, next to
 * the mode toggle. Replaces Excalidraw's built-in "Export image" dialog for
 * PNG/SVG (see BoardCanvas.tsx's exportBoardPng/exportBoardSvg for why: the
 * built-in path silently fails in at least one real browser). Purely
 * presentational + local open/pending/feedback UI state — the actual
 * export work (touching Excalidraw's imperative API, calling
 * exportToBlob/exportToSvg/exportToClipboard, triggering the download) lives
 * in the three injected callbacks, which either resolve or throw.
 */
export function BoardExportMenu({
  onExportPng,
  onExportSvg,
  onCopyToClipboard,
  compact = false,
  onFitToScreen,
  mode,
  onSelectMode,
}: BoardExportMenuProps) {
  const { t } = useTranslation('diagrams');
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<ExportKind | null>(null);
  const [feedback, setFeedback] = useState<{ kind: ExportKind; ok: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Click-outside and Escape both close the menu — only wired up while it's
  // actually open, so this never adds a permanent document-level listener.
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    return () => {
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    };
  }, []);

  async function run(kind: ExportKind, action: () => Promise<void>) {
    setPending(kind);
    setFeedback(null);
    try {
      await action();
      setFeedback({ kind, ok: true });
      // PNG/SVG close the menu — the download itself (browser chrome/OS
      // notification) is the user's confirmation. Clipboard stays open
      // briefly to show its own "Copied", same idiom as MermaidBlock's
      // copy button, since a clipboard write has no other visible feedback.
      if (kind !== 'clipboard') setOpen(false);
    } catch (error) {
      // The whole point of this menu existing is that export must never
      // fail silently again (that's the bug it replaces) — always surface
      // something, never just swallow it.
      console.error(`board export (${kind}) failed`, error);
      setFeedback({ kind, ok: false });
    } finally {
      setPending(null);
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
      feedbackTimer.current = setTimeout(() => setFeedback(null), FEEDBACK_MS);
    }
  }

  const busy = pending !== null;
  const itemClass =
    'px-3 py-1.5 text-left text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-200 dark:hover:bg-neutral-800';

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={compact ? t('board.menu.aria') : undefined}
        title={compact ? t('board.menu.aria') : undefined}
        className={
          compact
            ? 'inline-flex items-center rounded-full border border-neutral-300 bg-white/90 p-1.5 text-neutral-600 shadow-sm backdrop-blur transition-colors hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500 dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-300 dark:hover:text-neutral-100'
            : 'inline-flex items-center gap-1.5 rounded-full border border-neutral-300 bg-white/90 px-2.5 py-1 text-xs text-neutral-600 shadow-sm backdrop-blur transition-colors hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500 dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-300 dark:hover:text-neutral-100'
        }
      >
        {compact ? (
          <MoreHorizontal size={14} />
        ) : (
          <>
            <Download size={12} />
            {t('board.export.button')}
          </>
        )}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={compact ? t('board.menu.aria') : t('board.export.aria')}
          className="absolute right-0 top-full z-10 mt-1 flex min-w-[9rem] flex-col overflow-hidden rounded-lg border border-neutral-300 bg-white/95 py-1 text-xs shadow-md backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/95"
        >
          {compact && onFitToScreen && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onFitToScreen();
                setOpen(false);
              }}
              className={`flex items-center gap-1.5 ${itemClass}`}
            >
              <Maximize size={12} />
              {t('board.fitToScreen')}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => void run('png', onExportPng)}
            className={itemClass}
          >
            {t('board.export.png')}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => void run('svg', onExportSvg)}
            className={itemClass}
          >
            {t('board.export.svg')}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => void run('clipboard', onCopyToClipboard)}
            className={`flex items-center gap-1 ${itemClass}`}
          >
            {feedback?.kind === 'clipboard' && feedback.ok ? (
              <>
                <Check size={12} />
                {t('board.export.copied')}
              </>
            ) : (
              t('board.export.copyToClipboard')
            )}
          </button>
          {feedback && !feedback.ok && (
            <p role="alert" className="px-3 pt-1 text-red-600 dark:text-red-400">
              {t('board.export.failed')}
            </p>
          )}
          {compact && onSelectMode && mode && (
            <div
              role="group"
              aria-label={t('board.mode.aria')}
              className="mt-1 flex flex-col border-t border-neutral-200 pt-1 dark:border-neutral-700"
            >
              {MODES.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="menuitemradio"
                  aria-checked={mode === option}
                  onClick={() => {
                    onSelectMode(option);
                    setOpen(false);
                  }}
                  className={
                    itemClass +
                    (mode === option ? ' bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100' : '')
                  }
                >
                  {t(`board.mode.${option}`)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
