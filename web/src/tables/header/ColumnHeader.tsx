import { Info } from 'lucide-react';
import { useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TableColumn } from '@shared/contracts';
import { Tooltip } from '../ui/Tooltip';
import { ColumnTypeIcon, typeLabelKey } from '../cells/typeMeta';
import { Swatch } from '../cells/Chip';
import { ColumnMenu } from './ColumnMenu';
import type { ColumnMenuActions } from './ColumnMenu';

/**
 * Round 26 (DATA TABLES) — one grid header cell: type icon, name, ⓘ hint,
 * «…» menu.
 *
 * Acceptance criterion §17.2 is precisely this component: "I add 9 columns
 * of all types, set hints and value lists with colors … everything is
 * visible in the header (the type icon, ⓘ with the description)".
 *
 * The ⓘ only renders when there is something to say — a description, an
 * option list, or the `multiple` flag. An always-present icon that sometimes
 * opens an empty tooltip trains people to stop clicking it.
 */

export interface ColumnHeaderProps {
  column: TableColumn;
  actions?: ColumnMenuActions;
  /** Viewer role: the menu disappears entirely rather than showing disabled items. */
  readOnly?: boolean;
  /** Direction this column is currently sorted in, for the header marker. */
  sortDir?: 'asc' | 'desc';
  /** Current rendered width in px — the starting point of a resize drag. */
  width?: number;
  /** Supplied → the header grows a drag handle on its right edge. */
  onResize?: (columnId: string, width: number) => void;
}

/** `tableColumnSchema.width` is `.min(60).max(1200)`; the view's map is unbounded, so clamp here. */
export const MIN_COLUMN_WIDTH = 60;
export const MAX_COLUMN_WIDTH = 1200;
/** One ArrowLeft/ArrowRight press on the handle. */
const KEYBOARD_STEP = 16;

export function clampColumnWidth(width: number): number {
  return Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width)));
}

/**
 * The `width` prop's fallback for a caller that renders `ColumnHeader`
 * without one. Reads the HANDLE's parent element — this component's own
 * root `<div>`, which spans the full header cell — rather than the handle
 * itself, which is a 6px grab strip and would report its own width, not
 * the column's. A single synchronous read at gesture start, never on every
 * `pointermove`, so it cannot reintroduce the layout thrash the model-first
 * design exists to avoid.
 */
function measureRenderedWidth(handle: HTMLElement): number {
  const measured = handle.parentElement?.getBoundingClientRect().width;
  return measured && measured > 0 ? measured : MIN_COLUMN_WIDTH;
}

export function ColumnHeader({ column, actions, readOnly, sortDir, width, onResize }: ColumnHeaderProps) {
  const { t } = useTranslation('tables');
  const options = column.options ?? [];
  const hasHint = Boolean(column.description) || options.length > 0 || column.multiple === true;

  /**
   * `startResize` reaches into the DOM with raw `addEventListener`, which
   * survives for the whole gesture independently of React re-rendering this
   * component. That is deliberate (see the listeners-on-the-handle comment
   * below) but it means the closure it captures at pointerdown is frozen —
   * and `onResize` is NOT a stable function: it is `TablePage.resizeColumn`,
   * re-created every time the view draft changes, i.e. on every single
   * pixel this same drag already reported. A closure captured once at
   * pointerdown and never refreshed would keep calling the FIRST render's
   * `resizeColumn`, which closes over the PRE-drag `view` — every write
   * after the first would then be computed against stale view state and
   * could clobber a concurrent edit (this page is CRDT-backed; another
   * client's patch can land mid-drag). The ref keeps onMove reading the
   * latest props on every call instead.
   */
  const latest = useRef({ width, onResize });
  // Updated synchronously during render: a pointermove can arrive earlier
  // than the passive effect after the previous pixel of the resize.
  latest.current = { width, onResize };

  /**
   * Column resizing is ours to build: react-datasheet-grid has no interactive
   * resize at all, only declarative basis/grow/shrink/min/max. So this is a
   * grab strip on the header's right edge that writes a pixel width, which
   * gridColumns.basisFor already reads back as the column's `basis`.
   *
   * The starting width is read from the model (`basisFor`) whenever the
   * caller supplies one — gridColumns.tsx always does, so in the running app
   * this is also why the arithmetic can be tested against raw pointer events
   * in jsdom at all: it never depends on a measured box being non-zero.
   * `width` is still typed optional, though, for any OTHER caller of this
   * component (there's a direct one in this very file's test), and for
   * those `width ?? MIN_COLUMN_WIDTH` used to silently snap the drag's
   * starting point down to 60px on the first pixel — measuring the actual
   * rendered box ONCE, at gesture start, is the honest fallback instead.
   */
  function startResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!onResize) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const startX = event.clientX;
    // Read once, here, not from the ref: this only needs the value as of
    // THIS pointerdown (same thing the ref would report at this instant),
    // and reads it from `width` directly for a maximally simple, ordinary
    // closure read at gesture start. The ref exists for `onMove` below,
    // which — unlike this line — keeps firing long after this render.
    const startWidth = width ?? measureRenderedWidth(handle);
    let last = startWidth;

    function onMove(move: PointerEvent) {
      const next = clampColumnWidth(startWidth + (move.clientX - startX));
      // Only on a real change: every call becomes a view-draft write, and a
      // pointermove stream would otherwise re-serialise the draft per pixel.
      if (next === last) return;
      last = next;
      latest.current.onResize?.(column.id, next);
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    }
    // We listen on the window: that survives the pointer leaving the narrow
    // grab handle, the bounds of the table and a re-render of the header itself during the drag.
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function resizeByKey(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!onResize) return;
    const step = event.key === 'ArrowRight' ? KEYBOARD_STEP : event.key === 'ArrowLeft' ? -KEYBOARD_STEP : 0;
    if (step === 0) return;
    event.preventDefault();
    event.stopPropagation();
    onResize(column.id, clampColumnWidth((width ?? measureRenderedWidth(event.currentTarget)) + step));
  }

  return (
    <div
      className="relative flex h-full w-full min-w-0 items-center gap-1 px-2"
      onDoubleClick={(event) => {
        if (readOnly || !actions || (event.target as HTMLElement).closest('button')) return;
        event.preventDefault();
        event.stopPropagation();
        actions.onEdit(column);
      }}
    >
      <ColumnTypeIcon type={column.type} />
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-700 dark:text-neutral-200">
        {column.name}
      </span>
      {sortDir && (
        <span aria-hidden className="shrink-0 text-[10px] text-neutral-400">
          {sortDir === 'asc' ? '↑' : '↓'}
        </span>
      )}
      {hasHint && (
        <Tooltip
          wide={options.length > 0}
          content={
            <div className="flex flex-col gap-1.5">
              <p className="font-medium text-neutral-800 dark:text-neutral-100">{column.name}</p>
              <p className="text-[11px] text-neutral-400">
                {t(typeLabelKey(column.type))}
                {column.multiple ? ` · ${t('column.multiple')}` : ''}
              </p>
              {column.description && (
                // whitespace-pre-line on the tooltip panel is what makes the
                // spec's multi-line `description: >-` render as written.
                <p className="text-neutral-600 dark:text-neutral-300">{column.description}</p>
              )}
              {options.length > 0 && (
                <ul className="mt-0.5 flex flex-col gap-1 border-t border-neutral-200 pt-1.5 dark:border-neutral-700">
                  {options.map((option) => (
                    <li key={option.value} className="flex items-start gap-1.5">
                      <span className="mt-1"><Swatch color={option.color} /></span>
                      <span className="min-w-0">
                        <span className="text-neutral-700 dark:text-neutral-200">{option.value}</span>
                        {option.description && (
                          <span className="text-neutral-400"> — {option.description}</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          }
        >
          <button
            type="button"
            // A real focusable control, not a decorative span: the tooltip
            // opens on focus too, so keyboard and touch users can reach the
            // description at all (a native `title` gives them nothing).
            aria-label={t('column.hint', { name: column.name })}
            className="shrink-0 rounded p-0.5 text-neutral-400 hover:text-neutral-700 focus-visible:outline focus-visible:outline-1 focus-visible:outline-blue-500 dark:hover:text-neutral-200"
          >
            <Info size={11} />
          </button>
        </Tooltip>
      )}
      {!readOnly && actions && <ColumnMenu column={column} actions={actions} />}

      {onResize && (
        <button
          type="button"
          // A real focusable control, not a bare div: arrow keys resize too,
          // so this works without a pointer at all.
          aria-label={t('column.resize', { name: column.name })}
          title={t('column.resize', { name: column.name })}
          onPointerDown={startResize}
          onKeyDown={resizeByKey}
          // Sits ON the column boundary (half over each side) so the grab area
          // is where the eye puts the edge. Invisible until hovered/focused —
          // one of these per column, always painted, would be a picket fence.
          className="group/resize absolute inset-y-0 -right-1 z-30 w-3 cursor-col-resize touch-none bg-transparent focus-visible:outline-none"
        >
          <span className="pointer-events-none absolute inset-y-1 left-1/2 w-px -translate-x-1/2 bg-neutral-300 transition-colors group-hover/resize:w-0.5 group-hover/resize:bg-blue-500 group-focus-visible/resize:w-0.5 group-focus-visible/resize:bg-blue-500 dark:bg-neutral-700" />
        </button>
      )}
    </div>
  );
}
