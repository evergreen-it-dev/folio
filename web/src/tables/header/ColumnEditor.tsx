import { useMemo, useState } from 'react';
import { Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TableColumn, TableRow } from '@shared/contracts';
import { Modal } from '../../app/ui/Modal';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { Checkbox } from '../ui/Checkbox';
import { ColorPicker } from '../cells/ColorPicker';
import type { TableColor } from '../colors';
import { COLUMN_TYPES, hasOptions, supportsMultiple, typeLabelKey } from '../cells/typeMeta';
import { STATUS_OPTIONS } from '../fixtures';

/**
 * Round 26 (DATA TABLES) — the column editor (rename, type, hint, options,
 * multiple), reached from the header's "…" → "Configure".
 *
 * Two spec rules drive the shape of this dialog, and both are about NOT
 * losing data quietly:
 *
 *  - §3, `multiple: true → false`: "requires confirmation: in cells with
 *    several values the first one stays (the dialog shows how many rows
 *    will be affected)". Hence `affectedByMultiple` and the warning strip.
 *  - §8 / §6.1, changing the type: the operation returns a loss report
 *    ({converted, cleared}). The real conversion lives in CORE's values.ts
 *    (wave 3); what this dialog owns is showing the count BEFORE the user
 *    commits, computed here from the rows it was handed.
 *
 * Column `id` is deliberately not editable — spec §2.3 makes it immutable
 * precisely so that renaming a column doesn't orphan its cells.
 */

export interface ColumnEditorProps {
  column: TableColumn;
  /** Needed only to count what a destructive change would cost. */
  rows: TableRow[];
  onSave: (patch: Partial<TableColumn>) => void;
  onClose: () => void;
}

export function ColumnEditor({ column, rows, onSave, onClose }: ColumnEditorProps) {
  const { t } = useTranslation('tables');
  const [draft, setDraft] = useState<TableColumn>({ ...column, options: column.options?.map((o) => ({ ...o })) });

  const typeChanged = draft.type !== column.type;
  const losingMultiple = column.multiple === true && draft.multiple !== true;

  /** How many rows hold more than one value and would be truncated to the first. */
  const affectedByMultiple = useMemo(() => {
    if (!losingMultiple) return 0;
    return rows.filter((row) => {
      const value = row.values[column.id];
      return Array.isArray(value) && value.length > 1;
    }).length;
  }, [losingMultiple, rows, column.id]);

  /**
   * Rows whose value would not survive the new type. Approximated the same
   * way CORE's converter will decide: anything non-empty that the target
   * type can't read is "cleared". Shown as a count, never applied silently.
   */
  const clearedByType = useMemo(() => {
    if (!typeChanged) return 0;
    return rows.filter((row) => {
      const value = row.values[column.id];
      if (value === null || value === undefined || value === '') return false;
      const text = Array.isArray(value) ? value.join(', ') : String(value);
      if (draft.type === 'number') return Number.isNaN(Number(text.replace(',', '.')));
      if (draft.type === 'date') return !/^\d{4}-\d{2}-\d{2}/.test(text);
      if (draft.type === 'checkbox') return !['true', 'false', '[x]', '[ ]'].includes(text.toLowerCase());
      return false;
    }).length;
  }, [typeChanged, rows, column.id, draft.type]);

  function patchDraft(patch: Partial<TableColumn>) {
    setDraft((previous) => ({ ...previous, ...patch }));
  }

  function changeType(type: TableColumn['type']) {
    patchDraft({
      type,
      // Switching to `status` seeds the normative preset from spec §3 rather
      // than leaving an empty list the user has to type out by hand. It is a
      // starting point, not a fixed enum — every option stays editable.
      options: hasOptions(type)
        ? (draft.options ?? (type === 'status' ? STATUS_OPTIONS.map((o) => ({ ...o })) : []))
        : undefined,
      multiple: supportsMultiple(type) ? draft.multiple : undefined,
    });
  }

  function updateOption(index: number, patch: Partial<{ value: string; color: TableColor; description: string }>) {
    setDraft((previous) => {
      const options = [...(previous.options ?? [])];
      const current = options[index];
      if (!current) return previous;
      options[index] = { ...current, ...patch };
      return { ...previous, options };
    });
  }

  const canSave = draft.name.trim() !== '';

  return (
    <Modal
      title={t('column.editTitle', { name: column.name })}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={!canSave}
            onClick={() => {
              onSave({
                name: draft.name.trim(),
                type: draft.type,
                description: draft.description?.trim() || undefined,
                align: draft.align,
                multiple: supportsMultiple(draft.type) ? draft.multiple : undefined,
                allowCreate: draft.type === 'select' ? draft.allowCreate : undefined,
                precision: draft.type === 'number' ? draft.precision : undefined,
                time: draft.type === 'date' ? draft.time : undefined,
                options: hasOptions(draft.type) ? draft.options : undefined,
              });
              onClose();
            }}
          >
            {t('common.save')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
          {t('column.name')}
          <input
            autoFocus
            value={draft.name}
            onChange={(event) => patchDraft({ name: event.target.value })}
            className="rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm text-neutral-800 outline-none focus-visible:border-blue-500 dark:border-neutral-600 dark:text-neutral-100"
          />
        </label>

        <Select
          label={t('column.type')}
          value={draft.type}
          onChange={(value) => changeType(value as TableColumn['type'])}
          options={COLUMN_TYPES.map((type) => ({ value: type, label: t(typeLabelKey(type)) }))}
        />

        <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
          {t('column.description')}
          <textarea
            rows={2}
            value={draft.description ?? ''}
            onChange={(event) => patchDraft({ description: event.target.value })}
            placeholder={t('column.descriptionHint')}
            className="resize-y rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm text-neutral-800 outline-none focus-visible:border-blue-500 dark:border-neutral-600 dark:text-neutral-100"
          />
        </label>

        {supportsMultiple(draft.type) && (
          <Checkbox
            checked={draft.multiple === true}
            onChange={(checked) => patchDraft({ multiple: checked })}
            label={t('column.allowMultiple')}
          />
        )}
        {draft.type === 'select' && (
          <Checkbox
            checked={draft.allowCreate === true}
            onChange={(checked) => patchDraft({ allowCreate: checked })}
            label={t('column.allowCreate')}
          />
        )}
        {draft.type === 'date' && (
          <Checkbox
            checked={draft.time === true}
            onChange={(checked) => patchDraft({ time: checked })}
            label={t('column.withTime')}
          />
        )}

        {hasOptions(draft.type) && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('column.options')}</p>
            {(draft.options ?? []).map((option, index) => (
              // ── KEY BY INDEX ONLY. DO NOT PUT `option.value` BACK IN. ──
              // The value is the string being typed in the input below. A key
              // derived from it changes on every keystroke, so React unmounts
              // the row and mounts a fresh one — focus and caret go with it,
              // and typing "In" lands one character per row. (Owner-reported,
              // round 26 follow-up.) `tableOptionSchema` has no id and must
              // not grow one: the option's VALUE is what the file stores
              // (spec §2), so there is no stable identity to key by. Index is
              // correct here anyway — this is a fixed-order editable array
              // whose rows are only added at the end and removed at a known
              // position, never reordered.
              <div key={index} className="flex flex-wrap items-center gap-1.5">
                {/* The value leads and is the widest field: it is the content,
                    and the thing persisted to the file. */}
                <input
                  value={option.value}
                  onChange={(event) => updateOption(index, { value: event.target.value })}
                  aria-label={t('column.optionValue')}
                  placeholder={t('column.optionValue')}
                  className="min-w-[7rem] flex-[2] rounded border border-neutral-300 bg-transparent px-2 py-1 text-xs text-neutral-800 outline-none focus-visible:border-blue-500 dark:border-neutral-600 dark:text-neutral-100"
                />
                {/* Secondary: dimmer, narrower, and clearly not the value. */}
                <input
                  value={option.description ?? ''}
                  onChange={(event) => updateOption(index, { description: event.target.value })}
                  aria-label={t('column.optionDescription')}
                  placeholder={t('column.optionDescription')}
                  className="min-w-[6rem] flex-1 rounded border border-neutral-200 bg-transparent px-2 py-1 text-xs text-neutral-500 outline-none focus-visible:border-blue-500 dark:border-neutral-700 dark:text-neutral-400"
                />
                {/* Colour: a compact swatch grid, not a wide list of colour
                    NAMES. The name still reaches assistive tech through the
                    control's accessible name — see ColorPicker. */}
                <ColorPicker
                  label={t('column.optionColor')}
                  value={option.color}
                  onChange={(color) => updateOption(index, { color })}
                />
                <Button
                  iconOnly
                  variant="ghost"
                  icon={<Trash2 size={12} />}
                  onClick={() =>
                    setDraft((previous) => ({
                      ...previous,
                      options: (previous.options ?? []).filter((_, i) => i !== index),
                    }))
                  }
                >
                  {t('column.optionRemove')}
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus size={12} />}
              onClick={() =>
                setDraft((previous) => ({
                  ...previous,
                  options: [...(previous.options ?? []), { value: '', color: 'gray' as TableColor }],
                }))
              }
            >
              {t('column.optionAdd')}
            </Button>
          </div>
        )}

        {(affectedByMultiple > 0 || clearedByType > 0) && (
          <p
            // role=alert: this appears *after* the user has already changed
            // the control, so it must announce itself rather than wait to be
            // found. It is the whole safety net for both operations.
            role="alert"
            className="flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <TriangleAlert size={13} className="mt-0.5 shrink-0" />
            <span>
              {affectedByMultiple > 0 && t('column.multipleLoss', { n: affectedByMultiple })}
              {affectedByMultiple > 0 && clearedByType > 0 ? ' ' : ''}
              {clearedByType > 0 && t('column.typeLoss', { n: clearedByType })}
            </span>
          </p>
        )}
      </div>
    </Modal>
  );
}
