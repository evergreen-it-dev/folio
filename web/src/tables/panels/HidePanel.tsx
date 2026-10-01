import { EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TableColumn, TableView } from '@shared/contracts';
import { ToolbarPanel } from './ToolbarPanel';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { ColumnTypeIcon } from '../cells/typeMeta';

/**
 * Round 26 (DATA TABLES) — column visibility panel (spec §5, «Hide 18»).
 *
 * Pattern adapted from tablecn (MIT, Copyright (c) sadmann7) —
 * `data-table-view-options.tsx`'s column-visibility list. Rebuilt on Folio's
 * kit; the model is our view's `columns.hidden`, not TanStack's
 * visibility state.
 *
 * The count is HIDDEN columns, matching the spec's own «Hide 18» wording —
 * i.e. it counts what you can't see, which is the number that answers
 * "why isn't my column there".
 *
 * The last visible column can't be hidden: a table with zero columns has no
 * usable UI to get back out of, and the grid has nothing to render.
 */

export interface HidePanelProps {
  columns: TableColumn[];
  hidden: string[];
  onChange: (hidden: string[]) => void;
}

export function HidePanel({ columns, hidden, onChange }: HidePanelProps) {
  const { t } = useTranslation('tables');
  const hiddenSet = new Set(hidden);
  const visibleCount = columns.length - hiddenSet.size;

  return (
    <ToolbarPanel icon={<EyeOff size={12} />} label={t('toolbar.hide')} count={hiddenSet.size}>
      {() => (
        <div className="flex flex-col gap-1">
          {columns.map((column) => {
            const visible = !hiddenSet.has(column.id);
            return (
              <div key={column.id} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-neutral-50 dark:hover:bg-neutral-800">
                <Checkbox
                  checked={visible}
                  disabled={visible && visibleCount <= 1}
                  label={column.name}
                  onChange={(next) =>
                    onChange(next ? hidden.filter((id) => id !== column.id) : [...hidden, column.id])
                  }
                  className="min-w-0 flex-1"
                />
                <ColumnTypeIcon type={column.type} />
              </div>
            );
          })}
          <div className="flex items-center justify-between gap-2 border-t border-neutral-200 pt-2 dark:border-neutral-700">
            <Button size="sm" variant="ghost" onClick={() => onChange([])}>
              {t('hide.showAll')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                // Everything but the first column — the first stays visible
                // for the same reason the last one can't be hidden.
                onChange(columns.slice(1).map((column) => column.id))
              }
            >
              {t('hide.hideAll')}
            </Button>
          </div>
        </div>
      )}
    </ToolbarPanel>
  );
}
