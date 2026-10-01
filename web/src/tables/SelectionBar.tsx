import { useRef, useState } from 'react';
import { Download, Pencil, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TableCellValue, TableColumn } from '@shared/contracts';
import { Button } from './ui/Button';
import { Select } from './ui/Select';
import { AnchoredPanel } from './ui/AnchoredPanel';
import { OptionPicker } from './cells/OptionPicker';

/**
 * Round 26 (DATA TABLES) — bulk-selection action bar (spec §4).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Pattern adapted from tablecn — https://github.com/sadmann7/tablecn — MIT
 * License, Copyright (c) sadmann7 (`components/ui/action-bar.tsx` and
 * `tasks-table-action-bar.tsx`): a floating bar that appears over the
 * content once rows are selected, showing the count, a set of bulk actions,
 * and a dismiss that clears the selection. Reimplemented on Folio's kit.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The three actions are exactly the ones spec §4 names: delete, set a
 * column's value across the selection, export the selection.
 *
 * Floating over the grid rather than docked into the toolbar so it doesn't
 * shift the grid's layout when it appears — a bar that pushes content down
 * makes the row you were aiming at move.
 */

export interface SelectionBarProps {
  count: number;
  columns: TableColumn[];
  readOnly?: boolean;
  onClear: () => void;
  onDelete: () => void;
  onSetValue: (columnId: string, value: TableCellValue) => void;
  onExport: () => void;
  mentionable?: string[];
}

export function SelectionBar({
  count,
  columns,
  readOnly,
  onClear,
  onDelete,
  onSetValue,
  onExport,
  mentionable,
}: SelectionBarProps) {
  const { t } = useTranslation('tables');
  const setterRef = useRef<HTMLButtonElement>(null);
  const [setting, setSetting] = useState(false);

  if (count === 0) return null;

  return (
    <div
      // status, not alert: it announces a state the user just created by
      // selecting rows — it shouldn't interrupt them.
      role="status"
      className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4"
    >
      <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-full border border-neutral-300 bg-white/95 px-3 py-1.5 shadow-lg backdrop-blur dark:border-neutral-600 dark:bg-neutral-800/95">
        <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200">
          {t('selection.count', { n: count })}
        </span>

        {!readOnly && (
          <>
            <Button ref={setterRef} size="sm" variant="ghost" icon={<Pencil size={12} />} onClick={() => setSetting(true)}>
              {t('selection.setValue')}
            </Button>
            <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={onDelete}>
              {t('selection.delete')}
            </Button>
          </>
        )}

        <Button size="sm" variant="ghost" icon={<Download size={12} />} onClick={onExport}>
          {t('selection.export')}
        </Button>

        <Button iconOnly size="sm" variant="ghost" icon={<X size={12} />} onClick={onClear}>
          {t('selection.clear')}
        </Button>
      </div>

      {setting && (
        <BulkValueSetter
          anchorRef={setterRef}
          columns={columns}
          mentionable={mentionable}
          onClose={() => setSetting(false)}
          onApply={(columnId, value) => {
            onSetValue(columnId, value);
            setSetting(false);
          }}
        />
      )}
    </div>
  );
}

/** "Set the value of a column" for every selected row at once. */
function BulkValueSetter({
  anchorRef,
  columns,
  mentionable,
  onClose,
  onApply,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  columns: TableColumn[];
  mentionable?: string[];
  onClose: () => void;
  onApply: (columnId: string, value: TableCellValue) => void;
}) {
  const { t } = useTranslation('tables');
  const [columnId, setColumnId] = useState(columns[0]?.id ?? '');
  const [value, setValue] = useState<TableCellValue>(null);
  const pickerAnchor = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);
  const column = columns.find((c) => c.id === columnId);

  return (
    <AnchoredPanel anchorRef={anchorRef} onClose={onClose} label={t('selection.setValue')} className="w-72 p-3">
      <div className="flex flex-col gap-2">
        <Select
          label={t('selection.column')}
          value={columnId}
          onChange={(next) => {
            setColumnId(next);
            // Reset on column change — a value of the previous column's
            // type would be written into a column that can't hold it.
            setValue(null);
          }}
          options={columns.map((c) => ({ value: c.id, label: c.name }))}
          className="flex-col !items-start gap-1"
        />

        {column && (column.type === 'select' || column.type === 'status' || column.type === 'user') ? (
          <>
            <button
              ref={pickerAnchor}
              type="button"
              onClick={() => setPicking(true)}
              className="rounded-md border border-neutral-300 px-2 py-1.5 text-left text-xs dark:border-neutral-600"
            >
              {value === null || value === '' ? t('row.pick') : String(Array.isArray(value) ? value.join(', ') : value)}
            </button>
            {picking && (
              <OptionPicker
                anchorRef={pickerAnchor}
                column={column}
                value={Array.isArray(value) ? value : value ? [String(value)] : []}
                candidates={mentionable}
                onChange={(next) => setValue(column.multiple ? next : (next[0] ?? null))}
                onClose={() => setPicking(false)}
              />
            )}
          </>
        ) : column?.type === 'checkbox' ? (
          <Select
            label={t('selection.value')}
            value={value === true ? 'true' : 'false'}
            onChange={(next) => setValue(next === 'true')}
            options={[
              { value: 'true', label: t('cell.checked') },
              { value: 'false', label: t('cell.unchecked') },
            ]}
            className="flex-col !items-start gap-1"
          />
        ) : (
          <input
            value={value === null ? '' : String(value)}
            onChange={(event) => setValue(event.target.value === '' ? null : event.target.value)}
            placeholder={t('selection.value')}
            aria-label={t('selection.value')}
            className="rounded-md border border-neutral-300 px-2 py-1.5 text-xs dark:border-neutral-600"
          />
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" disabled={!columnId} onClick={() => onApply(columnId, value)}>
            {t('common.apply')}
          </Button>
        </div>
      </div>
    </AnchoredPanel>
  );
}
