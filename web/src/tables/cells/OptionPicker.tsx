import { useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Check, Plus, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TableColumn } from '@shared/contracts';
import { AnchoredPanel } from '../ui/AnchoredPanel';
import { Swatch } from './Chip';
import { foldText } from '../core';
import { colorForValue } from '../colors';

/**
 * Round 26 (DATA TABLES) — the searchable value dropdown behind select,
 * status and user cells (spec §3), the filter panel's value input, and the
 * bulk "set the value of a column" action.
 *
 * Custom rather than a native <select> because the spec asks for things a
 * native one cannot render: a colour swatch and a per-option description per
 * row (§2.3, "as in Confluence: a colored square + the value + an explanation"),
 * type-to-filter over long lists (§13 allows 100 options soft / 500 hard),
 * multi-select with chips, and "create" from the search text when
 * `allowCreate` is on. app/ui/Select.tsx stays native for the structural
 * dropdowns, where none of that applies.
 *
 * Out-of-list values (§2.4) are surfaced here too: a value present in the
 * cell but absent from the option list is listed first with an "add to the
 * list" affordance rather than being invisible in the picker.
 */

export interface OptionPickerProps {
  anchorRef: RefObject<HTMLElement | null>;
  column: TableColumn;
  value: string[];
  onChange: (value: string[]) => void;
  onClose: () => void;
  /** For `user` columns: the space's mentionable handles (spec §3 — source is the existing `mentionable`). */
  candidates?: string[];
  /** Adds an option to the column schema — "create" / "add to the list". */
  onCreateOption?: (value: string) => void;
}

export function OptionPicker({
  anchorRef,
  column,
  value,
  onChange,
  onClose,
  candidates,
  onCreateOption,
}: OptionPickerProps) {
  const { t } = useTranslation('tables');
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const multiple = column.multiple === true;

  const available = useMemo(() => {
    const base =
      column.type === 'user'
        ? (candidates ?? []).map((handle) => ({ value: handle, color: undefined, description: undefined }))
        : (column.options ?? []).map((option) => ({
            value: option.value,
            color: option.color,
            description: option.description,
          }));
    // Values sitting in the cell but missing from the schema — spec §2.4.
    const orphans = value
      .filter((item) => !base.some((option) => option.value === item))
      .map((item) => ({ value: item, color: undefined, description: undefined, orphan: true as const }));
    return [...orphans, ...base];
  }, [column, candidates, value]);

  const filtered = useMemo(() => {
    const needle = foldText(query.trim());
    if (needle === '') return available;
    return available.filter((option) => foldText(option.value).includes(needle));
  }, [available, query]);

  const exactExists = available.some((option) => foldText(option.value) === foldText(query.trim()));
  const canCreate = column.allowCreate === true && query.trim() !== '' && !exactExists && onCreateOption;

  function toggle(item: string) {
    if (multiple) {
      onChange(value.includes(item) ? value.filter((v) => v !== item) : [...value, item]);
      // Multi-select stays open — picking three tags shouldn't take three
      // round trips through the cell.
      return;
    }
    // Single-select: picking the current value again clears it, which is the
    // only way to empty a cell without reaching for the keyboard.
    onChange(value.includes(item) ? [] : [item]);
    onClose();
  }

  function create() {
    const next = query.trim();
    if (next === '' || !onCreateOption) return;
    onCreateOption(next);
    onChange(multiple ? [...value, next] : [next]);
    setQuery('');
    if (!multiple) onClose();
  }

  return (
    <AnchoredPanel
      anchorRef={anchorRef}
      onClose={onClose}
      matchWidth
      label={column.name}
      className="w-64 p-1"
      // Same reason as AddColumnButton: the panel mounts `visibility: hidden`
      // until it has measured itself, so `autoFocus` on the field below was a
      // no-op and type-to-filter did not work.
      initialFocusRef={inputRef}
    >
      <div className="flex items-center gap-1.5 border-b border-neutral-200 px-2 py-1.5 dark:border-neutral-700">
        <Search size={12} aria-hidden className="shrink-0 text-neutral-400" />
        <input
          ref={inputRef}
          // The picker opens as a direct result of the user asking to edit
          // the cell, so taking focus is expected, not stolen. Delivered via
          // the panel's `initialFocusRef` above, not `autoFocus`.
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (canCreate) create();
              else if (filtered[0]) toggle(filtered[0].value);
            }
          }}
          placeholder={t('picker.search')}
          aria-label={t('picker.search')}
          className="w-full bg-transparent text-xs outline-none placeholder:text-neutral-400"
        />
      </div>

      <div role="listbox" aria-multiselectable={multiple} className="max-h-56 overflow-y-auto py-1">
        {filtered.length === 0 && !canCreate && (
          <p className="px-2 py-3 text-center text-xs text-neutral-400">{t('picker.empty')}</p>
        )}
        {filtered.map((option) => {
          const selected = value.includes(option.value);
          const orphan = 'orphan' in option && option.orphan === true;
          return (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={selected}
              onClick={() => toggle(option.value)}
              className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              <span className="mt-0.5 flex w-3 shrink-0 justify-center">
                {selected ? <Check size={12} className="text-blue-600 dark:text-blue-400" /> : null}
              </span>
              {column.type !== 'user' && <span className="mt-0.5"><Swatch color={option.color ?? colorForValue(column, option.value)} /></span>}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-neutral-800 dark:text-neutral-100">{option.value}</span>
                {option.description && (
                  <span className="block truncate text-[11px] text-neutral-400">{option.description}</span>
                )}
                {orphan && (
                  <span className="block text-[11px] text-amber-600 dark:text-amber-400">{t('cell.outOfList')}</span>
                )}
              </span>
              {orphan && onCreateOption && (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={t('picker.addToList')}
                  title={t('picker.addToList')}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCreateOption(option.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      event.stopPropagation();
                      onCreateOption(option.value);
                    }
                  }}
                  className="mt-0.5 shrink-0 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                >
                  <Plus size={12} />
                </span>
              )}
            </button>
          );
        })}
      </div>

      {canCreate && (
        <button
          type="button"
          onClick={create}
          className="flex w-full items-center gap-1.5 border-t border-neutral-200 px-2 py-1.5 text-left text-xs text-blue-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-blue-400 dark:hover:bg-neutral-800"
        >
          <Plus size={12} />
          {t('picker.create', { value: query.trim() })}
        </button>
      )}
    </AnchoredPanel>
  );
}
