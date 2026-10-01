import { useTranslation } from 'react-i18next';
import { STICKY_NOTE_COLORS, type StickyNoteColorId } from './boardStickyNotes';

/**
 * dataTransfer MIME used to carry the picked colour across the HTML5 drag —
 * a custom type (rather than 'text/plain') so BoardCanvas's onDragOver can
 * tell "a sticky swatch is being dragged over the canvas" apart from any
 * other drag (e.g. a file drop) without inspecting the payload.
 */
export const STICKY_NOTE_DRAG_MIME = 'application/x-folio-sticky-color';

export interface StickyNotePaletteProps {
  /** Plain click (no drag): insert the note at the centre of the visible viewport — see BoardCanvas.tsx's insertStickyNoteAtViewportCenter. */
  onPick: (colorId: StickyNoteColorId) => void;
}

/**
 * Miro-style palette of colour swatches (owner request) — rendered inside
 * BoardCanvas's own top-right chrome row (chromeRowRef), so it's covered by
 * that row's own measured top/right offset (boardChromeLayout.ts) without any
 * changes to that geometry: it only ever changes the row's rendered width,
 * which the existing measurement already reads live off the DOM rather than
 * assuming.
 *
 * Each swatch is BOTH a native HTML5 drag source (onDragStart) and a plain
 * button (onClick) — a completed drag suppresses the browser's own following
 * click event, so exactly one of the two ever fires per gesture; no manual
 * bookkeeping needed to tell them apart.
 */
export function StickyNotePalette({ onPick }: StickyNotePaletteProps) {
  const { t } = useTranslation('diagrams');
  return (
    <div
      // `toolbar`, not `group` (BoardModeToggle's own role): these buttons
      // each perform an action (insert/drag a note), they don't represent a
      // set of mutually exclusive states the way the mode toggle's segmented
      // buttons do — and BoardCanvas.test.tsx's own `modeButtons()` helper
      // greps `[role="group"] button` indiscriminately, so sharing that role
      // would silently fold this palette's swatches into every existing
      // mode-toggle assertion in edit mode.
      role="toolbar"
      aria-label={t('board.stickyNotes.aria')}
      className="pointer-events-auto inline-flex items-center gap-1 rounded-full border border-neutral-300 bg-white/90 p-1 shadow-sm backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/80"
    >
      {STICKY_NOTE_COLORS.map(({ id, value }) => (
        <button
          key={id}
          type="button"
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(STICKY_NOTE_DRAG_MIME, id);
            event.dataTransfer.effectAllowed = 'copy';
          }}
          onClick={() => onPick(id)}
          aria-label={t(`board.stickyNotes.colors.${id}`)}
          title={t(`board.stickyNotes.colors.${id}`)}
          style={{ backgroundColor: value }}
          className="h-5 w-5 shrink-0 rounded-[4px] border border-black/10 shadow-sm transition-transform hover:scale-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500 dark:border-white/10"
        />
      ))}
    </div>
  );
}
