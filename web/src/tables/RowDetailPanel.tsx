import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Link as LinkIcon, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TableCellValue, TableColumn, TableRow } from '@shared/contracts';
import { Button } from './ui/Button';
import { Checkbox } from './ui/Checkbox';
import { OptionPicker } from './cells/OptionPicker';
import { ValueChips } from './cells/Chip';
import { ColumnTypeIcon } from './cells/typeMeta';
import { cellToText } from './core';
import { parseLink, serializeLink } from './cells/CellComponents';
import { useIsMobile } from './useMobile';

/**
 * Round 26 (DATA TABLES) — row detail panel (spec §4).
 *
 * Three jobs the grid can't do:
 *  1. it shows EVERY column, including ones hidden by the current view —
 *     otherwise a hidden column is unreachable without changing the view;
 *  2. it is the only editor for `longtext` (spec §12a constraint 3 — the
 *     grid has no multi-line cell input);
 *  3. on a phone it is the editing surface for every type (spec §14:
 *     "editing a cell goes through the row panel, not an inline input").
 *
 * ↑/↓ navigate between rows without closing, per §4. The panel is a
 * side sheet on desktop and full-screen on mobile.
 */

export interface RowDetailPanelProps {
  row: TableRow;
  columns: TableColumn[];
  /** Position within the currently visible (filtered+sorted) rows, for ↑/↓ and the counter. */
  index: number;
  total: number;
  readOnly?: boolean;
  mentionable?: string[];
  onChange: (columnId: string, value: TableCellValue) => void;
  onNavigate: (delta: number) => void;
  onClose: () => void;
  onCreateOption?: (columnId: string, value: string) => void;
  /** Copies the `?row=<id>` deep link (spec §4). */
  onCopyLink?: (rowId: string) => void;
}

export function RowDetailPanel({
  row,
  columns,
  index,
  total,
  readOnly,
  mentionable,
  onChange,
  onNavigate,
  onClose,
  onCreateOption,
  onCopyLink,
}: RowDetailPanelProps) {
  const { t } = useTranslation('tables');
  const mobile = useIsMobile();

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside
      role="dialog"
      aria-label={t('row.panel')}
      className={
        mobile
          ? 'fixed inset-0 z-[60] flex flex-col bg-white dark:bg-neutral-900'
          : 'flex w-80 shrink-0 flex-col border-l border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900'
      }
    >
      <header className="flex items-center gap-1 border-b border-neutral-200 px-3 py-2 dark:border-neutral-700">
        <p className="min-w-0 flex-1 truncate text-xs text-neutral-500 dark:text-neutral-400">
          {t('row.counter', { index: index + 1, total })}
        </p>
        <Button
          iconOnly
          variant="ghost"
          disabled={index <= 0}
          icon={<ChevronUp size={14} />}
          onClick={() => onNavigate(-1)}
        >
          {t('row.previous')}
        </Button>
        <Button
          iconOnly
          variant="ghost"
          disabled={index >= total - 1}
          icon={<ChevronDown size={14} />}
          onClick={() => onNavigate(1)}
        >
          {t('row.next')}
        </Button>
        {onCopyLink && (
          <Button iconOnly variant="ghost" icon={<LinkIcon size={14} />} onClick={() => onCopyLink(row.id)}>
            {t('row.copyLink')}
          </Button>
        )}
        <Button iconOnly variant="ghost" icon={<X size={14} />} onClick={onClose}>
          {t('common.close')}
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto p-3">
        <div className="flex flex-col gap-3">
          {columns.map((column) => (
            <RowField
              key={column.id}
              column={column}
              value={(row.values[column.id] ?? null) as TableCellValue}
              readOnly={readOnly}
              mentionable={mentionable}
              onChange={(value) => onChange(column.id, value)}
              onCreateOption={onCreateOption}
            />
          ))}
        </div>
      </div>

      <footer className="border-t border-neutral-200 px-3 py-1.5 text-[11px] text-neutral-400 dark:border-neutral-700">
        id: <code>{row.id}</code>
      </footer>
    </aside>
  );
}

function RowField({
  column,
  value,
  readOnly,
  mentionable,
  onChange,
  onCreateOption,
}: {
  column: TableColumn;
  value: TableCellValue;
  readOnly?: boolean;
  mentionable?: string[];
  onChange: (value: TableCellValue) => void;
  onCreateOption?: (columnId: string, value: string) => void;
}) {
  const { t } = useTranslation('tables');
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);

  const label = (
    <span className="flex items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400">
      <ColumnTypeIcon type={column.type} />
      <span className="truncate">{column.name}</span>
    </span>
  );

  const inputClass =
    'w-full rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm text-neutral-800 outline-none focus-visible:border-blue-500 disabled:opacity-60 dark:border-neutral-600 dark:text-neutral-100';

  if (column.type === 'checkbox') {
    return (
      <div className="flex flex-col gap-1">
        {label}
        <Checkbox
          checked={value === true}
          disabled={readOnly}
          label={column.name}
          hideLabel
          onChange={(checked) => onChange(checked)}
        />
      </div>
    );
  }

  if (column.type === 'select' || column.type === 'status' || column.type === 'user') {
    const items = Array.isArray(value) ? value : value === null || value === '' ? [] : [cellToText(value)];
    return (
      <div className="flex flex-col gap-1">
        {label}
        <button
          ref={anchorRef}
          type="button"
          disabled={readOnly}
          onClick={() => setPicking(true)}
          className={`${inputClass} flex flex-wrap items-center gap-1 text-left`}
        >
          {items.length === 0 ? (
            <span className="text-neutral-400">{t('row.pick')}</span>
          ) : (
            <ValueChips column={column} value={items} />
          )}
        </button>
        {picking && (
          <OptionPicker
            anchorRef={anchorRef}
            column={column}
            value={items}
            candidates={mentionable}
            onChange={(next) => onChange(column.multiple ? (next.length ? next : null) : (next[0] ?? null))}
            onClose={() => setPicking(false)}
            onCreateOption={onCreateOption ? (v) => onCreateOption(column.id, v) : undefined}
          />
        )}
      </div>
    );
  }

  if (column.type === 'longtext') {
    return (
      <div className="flex flex-col gap-1">
        {label}
        <textarea
          // The whole reason the panel exists: a real multi-line editor for
          // the type the grid cannot edit at all.
          rows={5}
          disabled={readOnly}
          value={cellToText(value)}
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
          className={`${inputClass} resize-y`}
        />
      </div>
    );
  }

  if (column.type === 'link') {
    const { label: linkLabel, url } = parseLink(cellToText(value));
    return (
      <div className="flex flex-col gap-1">
        {label}
        <input
          disabled={readOnly}
          value={url}
          placeholder="https://"
          aria-label={t('cell.linkUrl')}
          onChange={(event) => onChange(serializeLink(linkLabel, event.target.value))}
          className={inputClass}
        />
        <input
          disabled={readOnly}
          value={linkLabel}
          placeholder={t('cell.linkLabel')}
          aria-label={t('cell.linkLabel')}
          onChange={(event) => onChange(serializeLink(event.target.value, url))}
          className={inputClass}
        />
      </div>
    );
  }

  const inputType = column.type === 'number' ? 'number' : column.type === 'date' ? (column.time ? 'datetime-local' : 'date') : 'text';

  return (
    <div className="flex flex-col gap-1">
      {label}
      <input
        type={inputType}
        disabled={readOnly}
        value={cellToText(value)}
        aria-label={column.name}
        onChange={(event) => {
          const next = event.target.value;
          if (next === '') {
            onChange(null);
            return;
          }
          onChange(column.type === 'number' ? Number(next) : next);
        }}
        className={inputClass}
      />
    </div>
  );
}
