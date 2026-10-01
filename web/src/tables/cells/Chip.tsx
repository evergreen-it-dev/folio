import { X } from 'lucide-react';
import type { TableColumn } from '@shared/contracts';
import { chipClass, colorForValue, isOutOfList, swatchClass } from '../colors';
import type { TableColor } from '../colors';

/**
 * Round 26 (DATA TABLES) — one coloured value chip (select / status / user).
 *
 * The "outside the list" treatment is the interesting part. Spec §2.4: a
 * select/status value that isn't in the column's option list (because the
 * file was hand-edited, or an option was renamed) must NOT be dropped and
 * must NOT be silently coloured as if it were fine — it renders as-is, with
 * a visible marker, and one click adds it to the list. So an unknown value
 * gets the dashed outline below rather than the palette colour it doesn't
 * have.
 */

export interface ChipProps {
  value: string;
  color?: TableColor;
  outOfList?: boolean;
  onRemove?: () => void;
  removeLabel?: string;
  className?: string;
}

export function Chip({ value, color, outOfList, onRemove, removeLabel, className }: ChipProps) {
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-xs leading-4 ${
        outOfList
          ? 'border border-dashed border-amber-500 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
          : chipClass(color)
      } ${className ?? ''}`}
      // Marks the value as out-of-list for assistive tech too, not just
      // visually — otherwise the dashed border says nothing to a screen reader.
      data-out-of-list={outOfList ? 'true' : undefined}
    >
      <span className="truncate">{value}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          className="shrink-0 opacity-60 hover:opacity-100"
        >
          <X size={10} />
        </button>
      )}
    </span>
  );
}

/** Chips for a whole cell value, resolving colours and out-of-list state from the column. */
export function ValueChips({
  column,
  value,
  onRemove,
  removeLabel,
}: {
  column: TableColumn;
  value: string[];
  onRemove?: (item: string) => void;
  removeLabel?: string;
}) {
  return (
    <>
      {value.map((item) => (
        <Chip
          key={item}
          value={item}
          color={colorForValue(column, item)}
          outOfList={isOutOfList(column, item)}
          onRemove={onRemove ? () => onRemove(item) : undefined}
          removeLabel={removeLabel}
        />
      ))}
    </>
  );
}

/** Colour square used in dropdowns and the header's ⓘ option list (spec §2.3). */
export function Swatch({ color }: { color?: TableColor }) {
  return <span aria-hidden className={`inline-block h-2.5 w-2.5 shrink-0 rounded-sm ${swatchClass(color)}`} />;
}
