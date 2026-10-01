import {
  ArrowDownAZ,
  ArrowUpAZ,
  Copy,
  EyeOff,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TableColumn } from '@shared/contracts';
import { Menu, MenuItem } from '../../app/ui/Menu';

/**
 * Round 26 (DATA TABLES) — per-column «…» menu.
 *
 * Reuses app/ui/Menu wholesale rather than growing a third popover in this
 * zone: DEV-PLAN R26 lists Menu and Modal as the two kit pieces that already
 * do what this round needs (portaled to document.body, clamped to the
 * viewport, Escape/outside-click/scroll dismissal, focus returned to the
 * trigger). Note the header lives inside the grid's own scroll container,
 * which is exactly the `overflow` ancestor that would clip a naive
 * absolutely-positioned panel — Menu's portal is what makes this work at all.
 */

export interface ColumnMenuActions {
  onEdit: (column: TableColumn) => void;
  onDuplicate: (column: TableColumn) => void;
  onHide: (columnId: string) => void;
  onDelete: (column: TableColumn) => void;
  onSort: (columnId: string, dir: 'asc' | 'desc') => void;
  onInsertAfter: (column: TableColumn) => void;
}

export function ColumnMenu({ column, actions }: { column: TableColumn; actions: ColumnMenuActions }) {
  const { t } = useTranslation('tables');

  return (
    <Menu
      align="right"
      className="shrink-0"
      triggerLabel={t('column.menu', { name: column.name })}
      trigger={<MoreHorizontal size={13} />}
    >
      {(close) => (
        <>
          <MenuItem
            icon={<Pencil size={13} />}
            onSelect={() => {
              close();
              actions.onEdit(column);
            }}
          >
            {t('column.edit')}
          </MenuItem>
          <MenuItem
            icon={<ArrowUpAZ size={13} />}
            onSelect={() => {
              close();
              actions.onSort(column.id, 'asc');
            }}
          >
            {t('column.sortAsc')}
          </MenuItem>
          <MenuItem
            icon={<ArrowDownAZ size={13} />}
            onSelect={() => {
              close();
              actions.onSort(column.id, 'desc');
            }}
          >
            {t('column.sortDesc')}
          </MenuItem>
          <MenuItem
            icon={<Copy size={13} />}
            onSelect={() => {
              close();
              actions.onInsertAfter(column);
            }}
          >
            {t('column.insertAfter')}
          </MenuItem>
          <MenuItem
            icon={<Copy size={13} />}
            onSelect={() => {
              close();
              actions.onDuplicate(column);
            }}
          >
            {t('column.duplicate')}
          </MenuItem>
          <MenuItem
            icon={<EyeOff size={13} />}
            onSelect={() => {
              close();
              actions.onHide(column.id);
            }}
          >
            {t('column.hide')}
          </MenuItem>
          <MenuItem
            destructive
            icon={<Trash2 size={13} />}
            onSelect={() => {
              close();
              actions.onDelete(column);
            }}
          >
            {t('column.delete')}
          </MenuItem>
        </>
      )}
    </Menu>
  );
}
