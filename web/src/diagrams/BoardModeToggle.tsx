import { useTranslation } from 'react-i18next';
import type { BoardMode } from './boardMode';

const MODES: readonly BoardMode[] = ['view', 'edit'];

export interface BoardModeToggleProps {
  mode: BoardMode;
  onSelect: (mode: BoardMode) => void;
}

/**
 * Round 21 (DIAGRAMS) — board's own "View | Edit" switch,
 * rendered top-right, above the board (see BoardCanvas.tsx).
 *
 * Visually mirrors the page editor's ModeToggle (web/src/editor/index.tsx —
 * a bordered pill of segmented buttons, `aria-pressed` marking the active
 * one, `role="group"` + `aria-label` on the wrapper) but is its own markup:
 * the editor zone's `.folio-editor__modes`/`__mode` classes are driven by
 * `--folio-ed-*` custom properties scoped under `.folio-editor` and aren't
 * reachable from here, and this whole zone styles everything with Tailwind
 * utilities instead (see the rest of BoardCanvas.tsx — the save chip and the
 * new-board hint use the same neutral-300/700 border + white/90 vs.
 * neutral-900/80 surface pairing this reuses).
 */
export function BoardModeToggle({ mode, onSelect }: BoardModeToggleProps) {
  const { t } = useTranslation('diagrams');
  return (
    <div
      role="group"
      aria-label={t('board.mode.aria')}
      className="pointer-events-auto inline-flex items-center gap-0.5 rounded-full border border-neutral-300 bg-white/90 p-0.5 text-xs shadow-sm backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/80"
    >
      {MODES.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={mode === option}
          onClick={() => onSelect(option)}
          className={
            'rounded-full px-2.5 py-1 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500 ' +
            (mode === option
              ? 'bg-neutral-200 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100'
              : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100')
          }
        >
          {t(`board.mode.${option}`)}
        </button>
      ))}
    </div>
  );
}
