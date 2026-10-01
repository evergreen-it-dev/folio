import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AnchoredPanel } from '../ui/AnchoredPanel';
import { TABLE_COLORS, swatchClass } from '../colors';
import type { TableColor } from '../colors';

/**
 * Round 26 follow-up — pick an option's colour from a grid of swatches.
 *
 * Replaces the wide named `<select>` ("Gray" / "Red" / …) that used to
 * lead every option row in the column editor. Picking a colour by reading its
 * name was the owner's complaint, and with the palette now at 21 entries a
 * word list is worse still.
 *
 * Still a CLOSED, named palette rather than free-form hex, deliberately: the
 * colour token is what `.table.md` stores (spec §2.3), and ../colors.ts has
 * to write its Tailwind classes out literally or the production build purges
 * them ("chips are colourful in dev, grey on prod"). Adding a colour means
 * adding it to `tableColorSchema` AND to colors.ts's two maps — the
 * `Record<TableColor, …>` types make forgetting one a compile error.
 *
 * Accessibility, since no colour NAME is rendered any more: the trigger's
 * accessible name carries the current colour, every swatch is a real button
 * carrying its translated name, and the grid takes arrow keys as well as Tab.
 */

export interface ColorPickerProps {
  value: TableColor | undefined;
  onChange: (color: TableColor) => void;
  /** Names the control, e.g. "Color". */
  label: string;
}

/** Grid width; TABLE_COLORS' 21 entries fall into 3 tidy rows of these. */
const COLUMNS = 7;

export function ColorPicker({ value, onChange, label }: ColorPickerProps) {
  const { t } = useTranslation('tables');
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const current: TableColor = value ?? 'gray';

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    const deltas: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: COLUMNS,
      ArrowUp: -COLUMNS,
    };
    const delta = deltas[event.key];
    if (delta === undefined) return;
    const swatches = [...(gridRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
    const index = swatches.findIndex((node) => node === document.activeElement);
    if (index === -1) return;
    const next = swatches[index + delta];
    if (!next) return;
    event.preventDefault();
    next.focus();
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        // The whole point of dropping the word: the name still has to reach a
        // screen reader, so it lives here instead of on screen.
        aria-label={`${label}: ${t(`color.${current}`)}`}
        title={`${label}: ${t(`color.${current}`)}`}
        onClick={() => setOpen((value_) => !value_)}
        className="inline-flex h-[26px] shrink-0 items-center gap-0.5 rounded border border-neutral-300 px-1 hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500 dark:border-neutral-600 dark:hover:bg-neutral-800"
      >
        <span aria-hidden className={`h-3.5 w-3.5 rounded-sm ${swatchClass(current)}`} />
        <ChevronDown size={10} aria-hidden className="text-neutral-400" />
      </button>

      {open && (
        <AnchoredPanel
          anchorRef={anchorRef}
          onClose={() => setOpen(false)}
          label={label}
          className="p-1.5"
        >
          <div
            ref={gridRef}
            role="listbox"
            aria-label={label}
            onKeyDown={moveFocus}
            className="grid grid-cols-7 gap-1"
          >
            {TABLE_COLORS.map((color) => {
              const selected = color === current;
              return (
                <button
                  key={color}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-label={t(`color.${color}`)}
                  title={t(`color.${color}`)}
                  onClick={() => {
                    onChange(color);
                    setOpen(false);
                    anchorRef.current?.focus();
                  }}
                  className={`flex h-7 w-7 items-center justify-center rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500 ${
                    selected
                      ? 'ring-2 ring-blue-500 dark:ring-blue-400'
                      : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'
                  }`}
                >
                  <span aria-hidden className={`h-4 w-4 rounded-sm ${swatchClass(color)}`} />
                </button>
              );
            })}
          </div>
        </AnchoredPanel>
      )}
    </>
  );
}
