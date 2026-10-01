import { useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TableColumn } from '@shared/contracts';
import { AnchoredPanel } from '../ui/AnchoredPanel';
import { COLUMN_TYPES, ColumnTypeIcon, typeLabelKey } from '../cells/typeMeta';

/**
 * Round 26 follow-up — create a column WITH its type, in one gesture.
 *
 * The old flow made a bare text column called "New column" and left you to
 * find the header's "…" → "Configure" to change the type. The owner's ask
 * was literally "the dropdown with the type has to be there at once".
 *
 * ─── Why this shape ─────────────────────────────────────────────────────
 * A popover with an optional name field on top and the nine types below it:
 * one click on a type both creates the column and sets it, so the common
 * case costs a single click and never opens a modal. The name is editable
 * right there (Enter in the field creates a plain `text` column, the default
 * anyone hitting Enter expects), and everything the picker cannot express —
 * option lists, hints, `multiple` — stays where it already lives, in
 * ColumnEditor behind the column's own «…» menu. That keeps this a picker
 * rather than a third editing surface.
 *
 * ─── Why AnchoredPanel and not app/ui/Menu ──────────────────────────────
 * Menu is the right primitive for ColumnMenu but wrong here on three counts:
 * it owns and styles its own icon-button trigger (sidebar look, wrong inside
 * a grid header cell); its panel is `role="menu"` and focuses ITSELF on
 * open, which fights the autofocused name field; and it dismisses on ANY
 * scroll in any ancestor — this trigger lives inside the grid's own
 * horizontal scroller, so a stray scroll would close the panel mid-typing.
 * AnchoredPanel repositions on scroll instead, and portals just the same, so
 * the grid's `overflow` container cannot clip it.
 */

export interface AddColumnButtonProps {
  /** Creates the column. `name` is already trimmed; blank means "use the default". */
  onCreate: (name: string, type: TableColumn['type']) => void;
  /**
   * `icon` is the bare «+» that sits after the last column header inside the
   * grid; `full` is the labelled "+ Column" button under the grid.
   */
  variant?: 'icon' | 'full';
}

export function AddColumnButton({ onCreate, variant = 'icon' }: AddColumnButtonProps) {
  const { t } = useTranslation('tables');
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  function close() {
    setOpen(false);
    setName('');
  }

  function create(type: TableColumn['type']) {
    onCreate(name.trim(), type);
    close();
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('column.add')}
        title={t('column.add')}
        onClick={() => (open ? close() : setOpen(true))}
        className={
          variant === 'full'
            ? 'inline-flex shrink-0 items-center gap-1 rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500 max-md:min-h-10 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700'
            : 'flex h-full w-full items-center justify-start px-2 text-neutral-400 transition-colors hover:text-neutral-700 focus-visible:outline focus-visible:outline-1 focus-visible:outline-blue-500 dark:hover:text-neutral-200'
        }
      >
        <Plus size={variant === 'full' ? 12 : 14} aria-hidden />
        {variant === 'full' && <span>{t('toolbar.addColumn')}</span>}
      </button>

      {open && (
        <AnchoredPanel
          anchorRef={triggerRef}
          onClose={close}
          label={t('column.add')}
          className="w-60 p-1.5"
          // NOT `autoFocus` on the input: the panel mounts hidden until it has
          // measured itself, and focusing a hidden element is a no-op — see
          // AnchoredPanel's focus effect. Without this the name field never
          // took focus and "Week" typed into the picker was simply lost.
          initialFocusRef={nameRef}
        >
          <label className="flex flex-col gap-1 px-1 pb-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
            {t('column.name')}
            <input
              // Opening this panel IS the request to create a column, so
              // taking focus is expected rather than stolen — and it makes
              // the name editable straight away, without a modal.
              ref={nameRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                // Enter commits the default type. Anyone who wants another
                // one is already reaching for the list below.
                create('text');
              }}
              placeholder={t('column.newName')}
              className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-xs text-neutral-800 outline-none focus-visible:border-blue-500 dark:border-neutral-600 dark:text-neutral-100"
            />
          </label>

          <p className="px-1 pb-1 text-[11px] text-neutral-400">{t('column.type')}</p>
          <div role="listbox" aria-label={t('column.type')} className="max-h-64 overflow-y-auto">
            {COLUMN_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => create(type)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                <ColumnTypeIcon type={type} />
                <span className="truncate">{t(typeLabelKey(type))}</span>
              </button>
            ))}
          </div>
        </AnchoredPanel>
      )}
    </>
  );
}
