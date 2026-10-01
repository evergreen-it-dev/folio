import { ArrowUpDown, ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TableColumn, TableView } from '@shared/contracts';
import { ToolbarPanel } from './ToolbarPanel';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';

/**
 * Round 26 (DATA TABLES) — the sort panel (spec §5).
 *
 * Pattern adapted from tablecn (MIT, Copyright (c) sadmann7) —
 * `data-table-sort-list.tsx`: an ordered list of [column][direction] rows
 * where list position IS sort precedence, plus add/remove/reorder. Rebuilt
 * on Folio's kit and contract.
 *
 * Sorting is a property of the VIEW, not of the file: spec §2.2 rule 5 says
 * the file's row order is the default order and a view's sort never
 * reorders the file. Nothing here writes rows.
 *
 * A column already used by another level is disabled rather than hidden, so
 * the list doesn't reshuffle under the cursor while it's open.
 */

export interface SortPanelProps {
  columns: TableColumn[];
  sort: TableView['sort'];
  onChange: (sort: TableView['sort']) => void;
}

export function SortPanel({ columns, sort, onChange }: SortPanelProps) {
  const { t } = useTranslation('tables');
  const used = new Set(sort.map((level) => level.column));
  const available = columns.filter((column) => !used.has(column.id));

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= sort.length) return;
    const next = [...sort];
    const [level] = next.splice(index, 1);
    if (level) next.splice(target, 0, level);
    onChange(next);
  }

  return (
    <ToolbarPanel icon={<ArrowUpDown size={12} />} label={t('toolbar.sort')} count={sort.length}>
      {() => (
        <div className="flex flex-col gap-2">
          {sort.length === 0 && <p className="py-2 text-center text-xs text-neutral-400">{t('sort.empty')}</p>}

          {sort.map((level, index) => (
            // Index only. A key built from `level.column` changes the moment
            // the user picks another column in this row's own <select>, which
            // remounts the row and drops focus — the same mistake that made
            // ColumnEditor's option inputs lose a keystroke each; see the long
            // note there.
            <div key={index} className="flex items-center gap-1.5">
              <span className="w-4 shrink-0 text-[11px] text-neutral-400">{index + 1}</span>
              <Select
                hideLabel
                label={t('sort.column')}
                value={level.column}
                onChange={(column) =>
                  onChange(sort.map((item, i) => (i === index ? { ...item, column } : item)))
                }
                options={columns.map((column) => ({
                  value: column.id,
                  label: column.name,
                  // Disabled, not removed — see the docblock.
                  disabled: used.has(column.id) && column.id !== level.column,
                }))}
              />
              <Select
                hideLabel
                label={t('sort.direction')}
                value={level.dir}
                onChange={(dir) =>
                  onChange(sort.map((item, i) => (i === index ? { ...item, dir: dir as 'asc' | 'desc' } : item)))
                }
                options={[
                  { value: 'asc', label: t('sort.asc') },
                  { value: 'desc', label: t('sort.desc') },
                ]}
              />
              <Button
                iconOnly
                variant="ghost"
                disabled={index === 0}
                icon={<ChevronUp size={12} />}
                onClick={() => move(index, -1)}
              >
                {t('sort.moveUp')}
              </Button>
              <Button
                iconOnly
                variant="ghost"
                disabled={index === sort.length - 1}
                icon={<ChevronDown size={12} />}
                onClick={() => move(index, 1)}
              >
                {t('sort.moveDown')}
              </Button>
              <Button
                iconOnly
                variant="ghost"
                icon={<Trash2 size={12} />}
                onClick={() => onChange(sort.filter((_, i) => i !== index))}
              >
                {t('sort.remove')}
              </Button>
            </div>
          ))}

          {available.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus size={12} />}
              onClick={() => {
                const column = available[0];
                if (column) onChange([...sort, { column: column.id, dir: 'asc' }]);
              }}
            >
              {t('sort.add')}
            </Button>
          )}
        </div>
      )}
    </ToolbarPanel>
  );
}
