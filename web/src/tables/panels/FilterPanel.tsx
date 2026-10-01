import { useRef, useState } from 'react';
import { Filter, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TableColumn, TableView } from '@shared/contracts';
import { ToolbarPanel } from './ToolbarPanel';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { OptionPicker } from '../cells/OptionPicker';
import { ValueChips } from '../cells/Chip';
import {
  blankValueFor,
  defaultOperatorForColumn,
  inputForOperator,
  operatorsForColumn,
} from '../operators';
import type { TableFilterOperator } from '../operators';
import { isRuleComplete } from '../core';

/**
 * Round 26 (DATA TABLES) — the filter builder (spec §5).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Interaction pattern adapted from tablecn — https://github.com/sadmann7/tablecn
 * — MIT License, Copyright (c) sadmann7 (`data-table-filter-list.tsx`): a
 * flat list of [column][operator][value] rows, one and/or joiner that
 * applies to the whole list, per-row remove, and an "add filter" footer.
 * Reimplemented against Folio's contract and UI kit — no shadcn/Radix/nuqs.
 * The operator list per column comes from ../operators.ts (also adapted;
 * see its header).
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Flat by design: spec §5 pins the model to "a flat list of rules, without
 * nesting in v1", and `tableViewSchema.filter` has no nesting to store —
 * a nested builder would produce filters the file format cannot represent.
 *
 * The counter shows COMPLETE rules only. A rule whose value is still blank
 * is not applied by the engine (core.ts's isRuleComplete), so counting it
 * would claim the table is filtered when it isn't.
 */

export interface FilterPanelProps {
  columns: TableColumn[];
  filter: TableView['filter'];
  onChange: (filter: TableView['filter']) => void;
  mentionable?: string[];
}

export function FilterPanel({ columns, filter, onChange, mentionable }: FilterPanelProps) {
  const { t } = useTranslation('tables');
  const activeCount = filter.rules.filter(isRuleComplete).length;

  function setRule(index: number, patch: Partial<TableView['filter']['rules'][number]>) {
    const rules = filter.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule));
    onChange({ ...filter, rules });
  }

  function addRule() {
    const column = columns[0];
    if (!column) return;
    onChange({
      ...filter,
      rules: [
        ...filter.rules,
        {
          column: column.id,
          operator: defaultOperatorForColumn(column),
          value: blankValueFor(defaultOperatorForColumn(column), column),
        },
      ],
    });
  }

  return (
    <ToolbarPanel wide icon={<Filter size={12} />} label={t('toolbar.filter')} count={activeCount}>
      {() => (
        <div className="flex flex-col gap-2">
          {filter.rules.length === 0 && (
            <p className="py-2 text-center text-xs text-neutral-400">{t('filter.empty')}</p>
          )}

          {filter.rules.map((rule, index) => {
            const column = columns.find((c) => c.id === rule.column) ?? columns[0];
            if (!column) return null;
            return (
              <div key={index} className="flex flex-wrap items-center gap-1.5">
                <span className="w-10 shrink-0 text-[11px] text-neutral-400">
                  {index === 0 ? (
                    t('filter.where')
                  ) : index === 1 ? (
                    <Select
                      hideLabel
                      label={t('filter.joiner')}
                      value={filter.op}
                      onChange={(op) => onChange({ ...filter, op: op as 'and' | 'or' })}
                      options={[
                        { value: 'and', label: t('filter.and') },
                        { value: 'or', label: t('filter.or') },
                      ]}
                    />
                  ) : (
                    // Only the second row carries the joiner control: the
                    // op applies to the whole flat list, so repeating an
                    // editable dropdown on every row would imply per-row
                    // precedence that the model doesn't have.
                    t(`filter.${filter.op}`)
                  )}
                </span>

                <Select
                  hideLabel
                  label={t('filter.column')}
                  value={rule.column}
                  onChange={(columnId) => {
                    const next = columns.find((c) => c.id === columnId);
                    if (!next) return;
                    const operator = defaultOperatorForColumn(next);
                    // Changing the column resets operator AND value: an
                    // operator from the old type ("is checked" on a text
                    // column) would be unrepresentable, and a stale value
                    // of the wrong shape would filter everything out.
                    setRule(index, { column: columnId, operator, value: blankValueFor(operator, next) });
                  }}
                  options={columns.map((c) => ({ value: c.id, label: c.name }))}
                />

                <Select
                  hideLabel
                  label={t('filter.operator')}
                  value={rule.operator}
                  onChange={(operator) =>
                    setRule(index, {
                      operator: operator as TableFilterOperator,
                      value: blankValueFor(operator as TableFilterOperator, column),
                    })
                  }
                  options={operatorsForColumn(column).map((operator) => ({
                    value: operator,
                    label: t(`operator.${operator}`),
                  }))}
                />

                <RuleValue
                  column={column}
                  operator={rule.operator as TableFilterOperator}
                  value={rule.value}
                  onChange={(value) => setRule(index, { value })}
                  mentionable={mentionable}
                />

                <Button
                  iconOnly
                  variant="ghost"
                  icon={<Trash2 size={12} />}
                  onClick={() => onChange({ ...filter, rules: filter.rules.filter((_, i) => i !== index) })}
                >
                  {t('filter.remove')}
                </Button>
              </div>
            );
          })}

          <div className="flex items-center justify-between pt-1">
            <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={addRule}>
              {t('filter.add')}
            </Button>
            {filter.rules.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onChange({ ...filter, rules: [] })}
              >
                {t('filter.clear')}
              </Button>
            )}
          </div>
        </div>
      )}
    </ToolbarPanel>
  );
}

/** The value editor for one rule — shape dictated by the operator, not the column alone. */
function RuleValue({
  column,
  operator,
  value,
  onChange,
  mentionable,
}: {
  column: TableColumn;
  operator: TableFilterOperator;
  value: unknown;
  onChange: (value: unknown) => void;
  mentionable?: string[];
}) {
  const { t } = useTranslation('tables');
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);
  const kind = inputForOperator(operator, column);

  if (kind === 'none') return null;

  if (kind === 'options' || kind === 'option' || kind === 'user') {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    return (
      <>
        <button
          ref={anchorRef}
          type="button"
          onClick={() => setPicking(true)}
          className="flex min-w-[7rem] flex-1 flex-wrap items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-left text-xs dark:border-neutral-600"
        >
          {selected.length === 0 ? (
            <span className="text-neutral-400">{t('filter.pickValues')}</span>
          ) : (
            <ValueChips column={column} value={selected} />
          )}
        </button>
        {picking && (
          <OptionPicker
            anchorRef={anchorRef}
            // Forced multiple: is_any_of / is_none_of / has_* all take a
            // SET, whatever the column's own `multiple` flag says.
            column={{ ...column, multiple: true, allowCreate: false }}
            value={selected}
            candidates={mentionable}
            onChange={onChange}
            onClose={() => setPicking(false)}
          />
        )}
      </>
    );
  }

  if (kind === 'number-range' || kind === 'date-range') {
    const pair = Array.isArray(value) ? (value as string[]) : ['', ''];
    const type = kind === 'date-range' ? 'date' : 'number';
    return (
      <span className="flex flex-1 items-center gap-1">
        <input
          type={type}
          aria-label={t('filter.from')}
          value={pair[0] ?? ''}
          onChange={(event) => onChange([event.target.value, pair[1] ?? ''])}
          className="w-full min-w-0 rounded-md border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-600"
        />
        <span className="text-[11px] text-neutral-400">—</span>
        <input
          type={type}
          aria-label={t('filter.to')}
          value={pair[1] ?? ''}
          onChange={(event) => onChange([pair[0] ?? '', event.target.value])}
          className="w-full min-w-0 rounded-md border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-600"
        />
      </span>
    );
  }

  return (
    <input
      type={kind === 'number' ? 'number' : kind === 'date' ? 'date' : 'text'}
      aria-label={t('filter.value')}
      placeholder={t('filter.value')}
      value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
      onChange={(event) => onChange(event.target.value)}
      className="min-w-[6rem] flex-1 rounded-md border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-600"
    />
  );
}
