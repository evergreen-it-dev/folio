import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TableColumn } from '@shared/contracts';
import { Modal } from '../app/ui/Modal';
import { Button } from './ui/Button';
import { Select } from './ui/Select';
import { Checkbox } from './ui/Checkbox';
import { COLUMN_TYPES, ColumnTypeIcon, typeLabelKey } from './cells/typeMeta';
import { inferColumns } from './core';

/**
 * Round 26 (DATA TABLES) — paste-from-clipboard preview with type inference
 * (spec §10/§10.1, acceptance criterion §17.3: "I paste 200 rows from a
 * Google sheet with Ctrl+V → the types are proposed correctly, after
 * confirmation the rows are in the file, one commit").
 *
 * The spec's rule for this screen is one sentence and it drives everything:
 * "Nothing is 'guessed' silently" — the user sees every proposed type and
 * can change it BEFORE anything is written. So this is a confirmation
 * dialog, not a toast after the fact.
 *
 * The inference itself is ../core.ts's `inferColumns` — a wave-1 stand-in
 * for TABLES-CORE's `shared/tables/csv.ts` version (see core.ts's header).
 * Swapping it changes nothing here: same signature, same shape.
 */

export interface PastePreviewProps {
  /** Clipboard grid, first row included — TSV split by the caller. */
  rows: string[][];
  /** Existing columns; empty means pasting into a fresh table (columns get created). */
  existingColumns: TableColumn[];
  onCancel: () => void;
  onConfirm: (result: { columns: TableColumn[] | null; rows: string[][]; mode: 'append' | 'replace' }) => void;
}

const PREVIEW_ROWS = 5;

export function PastePreview({ rows, existingColumns, onCancel, onConfirm }: PastePreviewProps) {
  const { t } = useTranslation('tables');
  // A table with no columns yet can only be filled by creating them, so the
  // header toggle is forced on and the paste defines the schema.
  const creatingSchema = existingColumns.length === 0;
  const [hasHeader, setHasHeader] = useState(true);
  const [mode, setMode] = useState<'append' | 'replace'>('append');

  const inferred = useMemo(() => {
    // inferColumns treats row 0 as the header. When the user says there
    // isn't one, feed it a synthetic header so the first data row is still
    // sampled rather than consumed as column names.
    const input = hasHeader ? rows : [rows[0]?.map((_, index) => `Column ${index + 1}`) ?? [], ...rows];
    return inferColumns(input);
  }, [rows, hasHeader]);

  const [types, setTypes] = useState<Record<string, TableColumn['type']>>({});

  const columns = useMemo(
    () => inferred.map((column) => ({ ...column, type: types[column.id] ?? column.type })),
    [inferred, types],
  );

  const bodyRows = hasHeader ? rows.slice(1) : rows;
  const preview = bodyRows.slice(0, PREVIEW_ROWS);

  return (
    <Modal
      size="lg"
      title={t('paste.title')}
      onClose={onCancel}
      footer={
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {t('paste.summary', { rows: bodyRows.length, columns: columns.length })}
          </p>
          <div className="flex gap-2">
            <Button onClick={onCancel}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={bodyRows.length === 0}
              onClick={() =>
                onConfirm({ columns: creatingSchema ? columns : null, rows: bodyRows, mode })
              }
            >
              {t('paste.confirm')}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Checkbox checked={hasHeader} onChange={setHasHeader} label={t('paste.hasHeader')} />
          {!creatingSchema && (
            <Select
              label={t('paste.mode')}
              value={mode}
              onChange={(next) => setMode(next as 'append' | 'replace')}
              options={[
                { value: 'append', label: t('paste.modeAppend') },
                { value: 'replace', label: t('paste.modeReplace') },
              ]}
            />
          )}
        </div>

        {creatingSchema ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('paste.willCreate')}</p>
        ) : (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {t('paste.willMap', { n: existingColumns.length })}
          </p>
        )}

        <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-700">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800">
                {columns.map((column, index) => (
                  <th key={column.id} className="p-2 align-top font-medium">
                    <span className="flex items-center gap-1">
                      <ColumnTypeIcon type={column.type} />
                      <span className="truncate">
                        {creatingSchema ? column.name : (existingColumns[index]?.name ?? column.name)}
                      </span>
                    </span>
                    {creatingSchema && (
                      // Only meaningful when the paste is defining the
                      // schema; pasting into existing columns cannot change
                      // their types from here (that is the column editor's
                      // job, and it has the loss report).
                      <Select
                        hideLabel
                        className="mt-1"
                        label={t('paste.type', { name: column.name })}
                        value={column.type}
                        onChange={(type) =>
                          setTypes((previous) => ({ ...previous, [column.id]: type as TableColumn['type'] }))
                        }
                        options={COLUMN_TYPES.map((type) => ({ value: type, label: t(typeLabelKey(type)) }))}
                      />
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-neutral-100 last:border-0 dark:border-neutral-800">
                  {columns.map((column, columnIndex) => (
                    <td key={column.id} className="max-w-[12rem] truncate p-2 text-neutral-600 dark:text-neutral-300">
                      {row[columnIndex] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {bodyRows.length > PREVIEW_ROWS && (
          <p className="text-xs text-neutral-400">{t('paste.more', { n: bodyRows.length - PREVIEW_ROWS })}</p>
        )}
      </div>
    </Modal>
  );
}

/**
 * Clipboard text → grid. Handles the quoting Google Sheets and Excel emit
 * when a cell itself contains a tab or a newline: such a cell arrives
 * wrapped in double quotes with embedded quotes doubled, so a naive
 * `split('\n').map(split('\t'))` tears one cell into several rows. This is
 * a small RFC 4180-style state machine over the TSV the clipboard gives us.
 */
export function parseClipboardGrid(text: string, delimiter = '\t'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // A trailing newline yields one empty row; drop it rather than importing
  // a blank record.
  return rows.filter((line) => line.some((cell) => cell !== ''));
}
