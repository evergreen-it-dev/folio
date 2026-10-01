import {
  AlignLeft,
  AtSign,
  CalendarDays,
  CheckSquare,
  Circle,
  Hash,
  Link2,
  List,
  Type,
} from 'lucide-react';
import type { TableColumn } from '@shared/contracts';

/**
 * Round 26 (DATA TABLES) — the column-type icon shown in every header
 * (spec §17.2: "everything is visible in the header — the type icon, ⓘ with the description").
 *
 * lucide-react is already the app's icon set (see BoardExportMenu, ui/Modal),
 * so no new dependency. Icons are picked to read the same way they do in
 * Notion/Confluence, since that's what the audience recognises:
 * text = "T", longtext = paragraph lines, number = #, date = calendar,
 * checkbox = ticked box, select = list, status = filled dot, user = @,
 * link = chain.
 */

const ICONS: Record<TableColumn['type'], typeof Type> = {
  text: Type,
  longtext: AlignLeft,
  number: Hash,
  date: CalendarDays,
  checkbox: CheckSquare,
  select: List,
  status: Circle,
  user: AtSign,
  link: Link2,
};

export function ColumnTypeIcon({ type, size = 13 }: { type: TableColumn['type']; size?: number }) {
  const Icon = ICONS[type] ?? Type;
  // aria-hidden: the type is already announced through the header's own
  // accessible text/tooltip; a second announcement per column is noise.
  return <Icon size={size} aria-hidden className="shrink-0 text-neutral-400 dark:text-neutral-500" />;
}

/** i18n key for a column type's human name — `tables:type.<type>`. */
export function typeLabelKey(type: TableColumn['type']): string {
  return `type.${type}`;
}

export const COLUMN_TYPES: TableColumn['type'][] = [
  'text', 'longtext', 'number', 'date', 'checkbox', 'select', 'status', 'user', 'link',
];

/** Types whose values come from a managed option list (spec §2.3). */
export function hasOptions(type: TableColumn['type']): boolean {
  return type === 'select' || type === 'status';
}

/** Types where the `multiple` flag is meaningful (spec §3). */
export function supportsMultiple(type: TableColumn['type']): boolean {
  return type === 'select' || type === 'user';
}
