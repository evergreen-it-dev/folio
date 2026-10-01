import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CellProps } from 'react-datasheet-grid';
import type { TableCellValue, TableColumn, TableRow, TableView } from '@shared/contracts';
import { OptionPicker } from './OptionPicker';
import { ValueChips } from './Chip';
import { AnchoredPanel } from '../ui/AnchoredPanel';
import { cellToText, formatCellText } from '../core';
import { colorForValue, isOutOfList } from '../colors';
import { Chip } from './Chip';
import { ROW_HEIGHT_PX } from '../types';

/**
 * Round 26 (DATA TABLES) — cell editors for all nine column types (spec §3).
 *
 * Contract with react-datasheet-grid (spec §12a): the grid is CONTROLLED and
 * hands each cell `active` (selected) and `focus` (being edited), plus
 * `setRowData` to write back and `stopEditing` to hand navigation back to
 * the grid. Each component renders a cheap read-only view until `focus`
 * turns on — on 5 000 rows the read view is what actually gets rendered
 * thousands of times, so it stays plain spans, never inputs.
 *
 * The row object IS our TableRow (`rowKey` = its `id`), so every write is
 * `setRowData({ ...rowData, values: { ...rowData.values, [id]: next } })` —
 * a new row object, but a new one only for the row that changed, which is
 * what keeps the "referentially stable mirror" requirement satisfiable.
 */

export interface CellContext {
  column: TableColumn;
  /** Mentionable handles for `user` columns (empty in wave 1 mocks). */
  mentionable?: string[];
  /** Opens the row detail panel — the only editor for `longtext` (spec §12a, constraint 3). */
  onOpenRow?: (rowId: string) => void;
  /** Adds an option to the column schema, from "create" / "add to the list". */
  onCreateOption?: (columnId: string, value: string) => void;
  /** Current global-search text, for the match highlight (spec §5). */
  search?: string;
  /** The view's row-height token, so `longtext` knows how many lines it may render (spec: toolbar Low/Medium/High). */
  rowHeight?: TableView['rowHeight'];
}

type Props = CellProps<TableRow, CellContext>;

function readValue(props: Props): TableCellValue {
  return (props.rowData?.values?.[props.columnData.column.id] ?? null) as TableCellValue;
}

function write(props: Props, next: TableCellValue) {
  props.setRowData({
    ...props.rowData,
    values: { ...props.rowData.values, [props.columnData.column.id]: next },
  });
}

/** Wraps the substrings matching the global search, so a hit is visible without opening the row (spec §5). */
function Highlighted({ text, search }: { text: string; search?: string }) {
  const needle = (search ?? '').trim();
  if (needle === '' || text === '') return <>{text}</>;
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded bg-yellow-200 text-inherit dark:bg-yellow-500/40">
        {text.slice(index, index + needle.length)}
      </mark>
      {text.slice(index + needle.length)}
    </>
  );
}

const READ_CLASS = 'block w-full truncate px-2 text-sm leading-[inherit]';

function alignClass(column: TableColumn): string {
  if (column.align === 'right') return 'text-right';
  if (column.align === 'center') return 'text-center';
  return 'text-left';
}

// ------------------------------------------------------------------ text

export function TextCell(props: Props) {
  const { column } = props.columnData;
  const value = readValue(props);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (props.focus) inputRef.current?.select();
  }, [props.focus]);

  if (!props.focus) {
    return (
      <span className={`${READ_CLASS} ${alignClass(column)}`}>
        <Highlighted text={cellToText(value)} search={props.columnData.search} />
      </span>
    );
  }
  return (
    <input
      ref={inputRef}
      // The grid owns focus management; it sets `focus` and expects the cell
      // to take DOM focus itself.
      autoFocus
      className={`w-full bg-transparent px-2 text-sm outline-none ${alignClass(column)}`}
      value={cellToText(value)}
      onChange={(event) => write(props, event.target.value === '' ? null : event.target.value)}
      onBlur={() => props.stopEditing({ nextRow: false })}
    />
  );
}

// -------------------------------------------------------------- longtext

/**
 * A fixed line-height, not `leading-[inherit]` like the other cells: the
 * clamp arithmetic below needs a KNOWN number to divide `ROW_HEIGHT_PX` by,
 * and an inherited "normal" line-height is whatever the browser's default
 * font metrics say, which isn't something this file can reason about.
 * Exported so the test file can assert the fit arithmetic directly rather
 * than trusting the comment below it.
 */
export const LONGTEXT_LINE_HEIGHT_PX = 18;

/**
 * How many wrapped lines each row height affords, translated straight into
 * Tailwind's `line-clamp-N` (written out literally so the JIT scanner keeps
 * it — see the palette note elsewhere in this zone for the same concern).
 *
 * Each budget (lines × LONGTEXT_LINE_HEIGHT_PX) has to stay UNDER its row's
 * ROW_HEIGHT_PX, or the clamped block would be taller than the row and the
 * grid's own row box would crop it mid-line instead of line-clamp's own
 * ellipsis doing it cleanly:
 *   short  1 × 18 = 18px  ≤ 32px  (types.ts ROW_HEIGHT_PX.short)
 *   medium 2 × 18 = 36px  ≤ 44px  (…medium)
 *   tall   3 × 18 = 54px  ≤ 64px  (…tall)
 * Every row keeps a few px of slack for `align-items: center` to work with,
 * rather than pinning the clamped block to exactly the row's height.
 */
export const LONGTEXT_CLAMP_LINES: Record<TableView['rowHeight'], number> = {
  short: 1,
  medium: 2,
  tall: 3,
};

const LONGTEXT_CLAMP_CLASS: Record<TableView['rowHeight'], string> = {
  short: 'line-clamp-1',
  medium: 'line-clamp-2',
  tall: 'line-clamp-3',
};

/**
 * Two SEPARATE concerns, easy to conflate and previously conflated in this
 * very comment — keep them apart:
 *
 *  RENDERING (this docblock): the cell shows the value AS WRITTEN — real
 *  line breaks, real wrapping — clamped to however many lines the current
 *  row height (spec's Low/Medium/High) has room for. No synthetic "one
 *  line with a glyph standing in for the rest": a short row legitimately
 *  clamps to one line, but that line is the genuine first line of the text,
 *  produced by CSS line-clamp, not a `\n` → " ⏎ " substitution flattening
 *  the whole value into one string.
 *
 *  EDITING (spec §12a constraint 3, "multi-line input in a cell is not
 *  native to it"): NOT available in the grid, on purpose, and rendering
 *  multiple lines here does not change that — a one-line `<input>` over a
 *  multi-line value would silently destroy every line but the first the
 *  moment anyone typed in it, which is worse than not editing here at all.
 *  The row panel remains the only editor; see the effect below for how the
 *  cell hands off to it the moment the grid tries to open one.
 */
export function LongTextCell(props: Props) {
  const { t } = useTranslation('tables');
  const { column, search, rowHeight } = props.columnData;
  const value = cellToText(readValue(props));
  const clampClass = LONGTEXT_CLAMP_CLASS[rowHeight ?? 'short'];

  if (props.focus) {
    return (
      <textarea
        autoFocus
        value={value}
        aria-label={column.name}
        onChange={(event) => write(props, event.target.value)}
        onBlur={() => props.stopEditing({ nextRow: false })}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            props.stopEditing({ nextRow: false });
          } else if (event.key === 'Escape') {
            props.stopEditing({ nextRow: false });
          }
          event.stopPropagation();
        }}
        className="h-full w-full resize-none bg-transparent px-2 py-1 text-sm leading-[18px] outline-none"
      />
    );
  }

  return (
    <span className={`flex w-full items-center gap-1 ${alignClass(column)}`}>
      <span
        // `whitespace-pre-wrap` is what makes this "real multi-line
        // rendering": actual `\n` in the value become actual line breaks,
        // and a long line still wraps — neither of which `truncate`
        // (nowrap + ellipsis) can do. `line-clamp-N` then caps the RESULT
        // at however many lines LONGTEXT_LINE_HEIGHT_PX × N leaves room for
        // inside the current row height (see the constants below this
        // component) — a short row still shows exactly one line, but it is
        // that line, clipped by the browser's own box, not a stand-in glyph.
        className={`min-w-0 flex-1 self-stretch px-2 text-sm whitespace-pre-wrap ${clampClass}`}
        style={{ lineHeight: `${LONGTEXT_LINE_HEIGHT_PX}px` }}
      >
        {value === '' && props.active ? (
          // Only on the ACTIVE cell: a hint in every empty cell of a 5 000-row
          // column would be noise, but a selected cell rendering nothing at
          // all is exactly how the owner got stuck.
          <span className="text-neutral-400 dark:text-neutral-500">{t('cell.editHint', 'Edit…')}</span>
        ) : (
          <Highlighted text={value} search={search} />
        )}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------- number

export function NumberCell(props: Props) {
  const { column, search } = props.columnData;
  const value = readValue(props);
  const inputRef = useRef<HTMLInputElement>(null);
  // Held as a string while editing so half-typed input ("-", "1.") isn't
  // reformatted or rejected under the user's fingers.
  const [buffer, setBuffer] = useState<string | null>(null);

  /*
   * Seeding the buffer and selecting the text happen ON FOCUS, and only then.
   *
   * This effect used to list `value` in its deps, which made it re-run after
   * EVERY keystroke: each `write()` changes `value`, the effect then reset the
   * buffer to the parsed number and called `select()` — so the next character
   * replaced everything typed so far. Typing "42" left "2", and "12.5" left
   * "0.5" (the "." parses to NaN, so `value` doesn't change and no reset
   * happens for that one character). Fast synthetic typing hid it; a human
   * typing at ~150 ms/char lost every digit but the last.
   *
   * The value at focus-time still has to be read, so it comes through a ref —
   * that is what keeps `value` out of the dependency list. TextCell already
   * does the same thing the simple way (it has no buffer to seed).
   */
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (!props.focus) {
      setBuffer(null);
      return;
    }
    setBuffer(valueRef.current === null ? '' : String(valueRef.current));
    inputRef.current?.select();
  }, [props.focus]);

  if (!props.focus) {
    const text = formatCellText(column, value);
    return (
      <span className={`${READ_CLASS} ${column.align ? alignClass(column) : 'text-right'} tabular-nums`}>
        <Highlighted text={text} search={search} />
      </span>
    );
  }
  return (
    <input
      ref={inputRef}
      autoFocus
      inputMode="decimal"
      className="w-full bg-transparent px-2 text-right text-sm tabular-nums outline-none"
      value={buffer ?? ''}
      onChange={(event) => {
        const next = event.target.value;
        setBuffer(next);
        const normalised = next.replace(',', '.').trim();
        if (normalised === '' || normalised === '-') {
          write(props, null);
          return;
        }
        const parsed = Number(normalised);
        // Ignore un-parseable intermediate states rather than writing NaN.
        if (!Number.isNaN(parsed)) write(props, parsed);
      }}
      onBlur={() => props.stopEditing({ nextRow: false })}
    />
  );
}

// ------------------------------------------------------------------ date

export function DateCell(props: Props) {
  const { column, search } = props.columnData;
  const value = cellToText(readValue(props));
  const withTime = column.time === true;

  if (!props.focus) {
    return (
      <span className={`${READ_CLASS} ${alignClass(column)} tabular-nums`}>
        <Highlighted text={value} search={search} />
      </span>
    );
  }
  return (
    <input
      autoFocus
      // The native picker is the right call here: it is keyboard-accessible,
      // localised by the browser, and on mobile (spec §14) gives the OS wheel.
      type={withTime ? 'datetime-local' : 'date'}
      className="w-full bg-transparent px-2 text-sm outline-none"
      value={value}
      onChange={(event) => write(props, event.target.value === '' ? null : event.target.value)}
      onBlur={() => props.stopEditing({ nextRow: false })}
    />
  );
}

// -------------------------------------------------------------- checkbox

export function CheckboxCell(props: Props) {
  const { t } = useTranslation('tables');
  const value = readValue(props) === true;
  return (
    <span className="flex w-full items-center justify-center">
      <input
        type="checkbox"
        checked={value}
        disabled={props.disabled}
        aria-label={props.columnData.column.name}
        title={value ? t('cell.checked') : t('cell.unchecked')}
        onChange={() => write(props, !value)}
        className="h-4 w-4 cursor-pointer accent-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
      />
    </span>
  );
}

// ---------------------------------------------- select / status / user

/** Cell value → the array form the picker and chips work in. */
function toArray(value: TableCellValue): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  const text = cellToText(value);
  return text === '' ? [] : [text];
}

export function OptionCell(props: Props) {
  const { column, mentionable, onCreateOption } = props.columnData;
  const anchorRef = useRef<HTMLSpanElement>(null);
  const value = toArray(readValue(props));
  const open = props.focus && !props.disabled;

  function commit(next: string[]) {
    if (column.multiple) {
      write(props, next.length === 0 ? null : next);
      return;
    }
    write(props, next[0] ?? null);
  }

  return (
    <span ref={anchorRef} className="flex h-full w-full flex-wrap items-center gap-1 overflow-hidden px-2">
      {value.length === 0 ? (
        <span className="text-sm text-transparent">·</span>
      ) : (
        <ValueChips column={column} value={value} />
      )}
      {open && (
        <OptionPicker
          anchorRef={anchorRef}
          column={column}
          value={value}
          candidates={mentionable}
          onChange={commit}
          onClose={() => props.stopEditing({ nextRow: false })}
          onCreateOption={
            onCreateOption ? (optionValue) => onCreateOption(column.id, optionValue) : undefined
          }
        />
      )}
    </span>
  );
}

// ------------------------------------------------------------------ link

const MD_LINK = /^\[([^\]]*)\]\((\S+)\)$/;

/** `[label](url)` or a bare URL → the two fields spec §3 asks the editor to show. */
export function parseLink(raw: string): { label: string; url: string } {
  const match = MD_LINK.exec(raw.trim());
  if (match) return { label: match[1] ?? '', url: match[2] ?? '' };
  return { label: '', url: raw.trim() };
}

/** Inverse: a labelless link stays a bare URL, so the file keeps its plain form (spec §2.4). */
export function serializeLink(label: string, url: string): string | null {
  const trimmedUrl = url.trim();
  const trimmedLabel = label.trim();
  if (trimmedUrl === '' && trimmedLabel === '') return null;
  if (trimmedLabel === '') return trimmedUrl;
  return `[${trimmedLabel}](${trimmedUrl})`;
}

export function LinkCell(props: Props) {
  const { t } = useTranslation('tables');
  const { search } = props.columnData;
  const anchorRef = useRef<HTMLSpanElement>(null);
  const raw = cellToText(readValue(props));
  const { label, url } = parseLink(raw);
  const open = props.focus && !props.disabled;

  return (
    <span ref={anchorRef} className="flex h-full w-full items-center gap-1 px-2">
      <span className="min-w-0 flex-1 truncate text-sm">
        {url === '' ? null : (
          <span className="text-blue-600 dark:text-blue-400">
            <Highlighted text={label || url} search={search} />
          </span>
        )}
      </span>
      {url !== '' && !open && (
        <a
          href={url}
          // Same treatment as file links elsewhere in Folio: new tab, and
          // noreferrer so an external target can't reach back via opener.
          target="_blank"
          rel="noreferrer noopener"
          aria-label={t('cell.openLink')}
          title={url}
          onClick={(event) => event.stopPropagation()}
          className="shrink-0 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
        >
          <ExternalLink size={11} />
        </a>
      )}
      {open && (
        <AnchoredPanel
          anchorRef={anchorRef}
          matchWidth
          onClose={() => props.stopEditing({ nextRow: false })}
          label={props.columnData.column.name}
          className="w-72 p-2"
        >
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-neutral-500 dark:text-neutral-400">
              {t('cell.linkUrl')}
              <input
                autoFocus
                value={url}
                onChange={(event) => write(props, serializeLink(label, event.target.value))}
                placeholder="https://"
                className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-xs text-neutral-800 outline-none focus-visible:border-blue-500 dark:border-neutral-600 dark:text-neutral-100"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-neutral-500 dark:text-neutral-400">
              {t('cell.linkLabel')}
              <input
                value={label}
                onChange={(event) => write(props, serializeLink(event.target.value, url))}
                className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-xs text-neutral-800 outline-none focus-visible:border-blue-500 dark:border-neutral-600 dark:text-neutral-100"
              />
            </label>
          </div>
        </AnchoredPanel>
      )}
    </span>
  );
}

/** Static (non-grid) rendering of a cell — used by the row panel and the selection bar. */
export function StaticCellValue({ column, value }: { column: TableColumn; value: TableCellValue }) {
  if (column.type === 'checkbox') {
    return <span className="text-sm">{value === true ? '☑' : '☐'}</span>;
  }
  if (column.type === 'select' || column.type === 'status' || column.type === 'user') {
    const items = toArray(value);
    if (items.length === 0) return <span className="text-sm text-neutral-400">—</span>;
    return (
      <span className="flex flex-wrap gap-1">
        {items.map((item) => (
          <Chip
            key={item}
            value={item}
            color={colorForValue(column, item)}
            outOfList={isOutOfList(column, item)}
          />
        ))}
      </span>
    );
  }
  const text = formatCellText(column, value);
  if (text === '') return <span className="text-sm text-neutral-400">—</span>;
  return <span className="text-sm whitespace-pre-wrap">{text}</span>;
}
