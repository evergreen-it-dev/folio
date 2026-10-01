import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ClipboardPaste, Copy, CopyPlus, EyeOff, Pencil, Plus, Scissors, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ContextMenuComponentProps, ContextMenuItem } from 'react-datasheet-grid';
import type { TableColumn } from '@shared/contracts';

/**
 * Round 26 follow-up — the grid's right-click menu, in Ukrainian.
 *
 * It used to be react-datasheet-grid's own component, whose items are
 * hard-coded English JSX ("Copy" / "Insert row below" / …) and whose CSS is
 * hard-coded white-on-black with no dark mode. The library's
 * `createContextMenuComponent(renderItem)` would fix the words but only the
 * words: it renders exactly the items the library built and gives no way to
 * ADD one, and the owner also wants "Hide column" in there. So this is a
 * full `contextMenuComponent` instead.
 *
 * ─── What is in the menu, and what deliberately is not ───────────────────
 * The library's row/clipboard items, translated, plus ONE column action:
 * hide. Hiding is the thing you want while pointing at a column and it is
 * otherwise three clicks away (Columns → find it → untick). Sort and
 * "Configure" are NOT here even though they are column actions: they are
 * already one click away in the «…» menu of the very column you are pointing
 * at, so repeating them saves no step and buries the row operations that are
 * this menu's actual job.
 *
 * Hiding writes to the current view's `columns.hidden` through the same
 * `actions.onHide` the Columns panel uses, so it becomes part of the view
 * DRAFT and shows up under "Save changes" like any other view change,
 * rather than silently persisting (spec §5).
 *
 * Positioning follows ui/Menu.tsx: fixed, measured in a layout effect, then
 * clamped into the viewport — so a right-click near the bottom-right corner
 * doesn't open a menu half off screen.
 */

const MARGIN = 8;

export interface GridContextMenuDeps {
  /** The visible columns, in grid order — `cursorIndex.col` indexes this. */
  columns: TableColumn[];
  /** Same callback the Columns panel uses; absent for a viewer. */
  onHideColumn?: (columnId: string) => void;
  onEditColumn?: (column: TableColumn) => void;
}

function labelFor(item: ContextMenuItem, t: (key: string, vars?: Record<string, unknown>) => string) {
  switch (item.type) {
    case 'COPY':
      return { icon: <Copy size={13} />, text: t('contextMenu.copy') };
    case 'CUT':
      return { icon: <Scissors size={13} />, text: t('contextMenu.cut') };
    case 'PASTE':
      return { icon: <ClipboardPaste size={13} />, text: t('contextMenu.paste') };
    case 'INSERT_ROW_BELLOW':
      return { icon: <Plus size={13} />, text: t('contextMenu.insertRowBelow') };
    case 'DUPLICATE_ROW':
      return { icon: <CopyPlus size={13} />, text: t('contextMenu.duplicateRow') };
    case 'DUPLICATE_ROWS':
      return {
        icon: <CopyPlus size={13} />,
        text: t('contextMenu.duplicateRows', { from: item.fromRow, to: item.toRow }),
      };
    case 'DELETE_ROW':
      return { icon: <Trash2 size={13} />, text: t('contextMenu.deleteRow'), destructive: true };
    case 'DELETE_ROWS':
      return {
        icon: <Trash2 size={13} />,
        text: t('contextMenu.deleteRows', { from: item.fromRow, to: item.toRow }),
        destructive: true,
      };
    default:
      // The union is closed today; if the library grows an item we don't know,
      // showing its raw type beats silently dropping the action.
      return { icon: null, text: String((item as { type: string }).type) };
  }
}

const ITEM_CLASS =
  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800';

export function makeGridContextMenu(deps: GridContextMenuDeps) {
  return function GridContextMenu({ clientX, clientY, items, cursorIndex, close }: ContextMenuComponentProps) {
    const { t } = useTranslation('tables');
    const panelRef = useRef<HTMLDivElement>(null);
    const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

    useLayoutEffect(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const box = panel.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      setCoords({
        left: Math.max(MARGIN, Math.min(clientX, vw - box.width - MARGIN)),
        top: Math.max(MARGIN, Math.min(clientY, vh - box.height - MARGIN)),
      });
    }, [clientX, clientY]);

    useEffect(() => {
      function onPointerDown(event: MouseEvent) {
        if (panelRef.current?.contains(event.target as Node)) return;
        close();
      }
      function onKey(event: KeyboardEvent) {
        if (event.key === 'Escape') close();
      }
      document.addEventListener('mousedown', onPointerDown);
      document.addEventListener('keydown', onKey);
      return () => {
        document.removeEventListener('mousedown', onPointerDown);
        document.removeEventListener('keydown', onKey);
      };
    }, [close]);

    // `cursorIndex.col` is 0-based over the DATA columns (the gutter is the
    // library's own column −1), and `row === -1` means the header row — so a
    // right-click on a header offers the column action too. The trailing
    // add-column slot is past the end of this array, hence the undefined.
    const column = deps.columns[cursorIndex?.col ?? -1];
    const canHide = Boolean(column && deps.onHideColumn);
    const canEdit = Boolean(cursorIndex?.row === -1 && column && deps.onEditColumn);

    const rows: ReactNode[] = items.map((item) => {
      const { icon, text, destructive } = labelFor(item, t) as {
        icon: ReactNode;
        text: string;
        destructive?: boolean;
      };
      return (
        <button
          key={item.type}
          type="button"
          role="menuitem"
          onClick={item.action}
          className={`${ITEM_CLASS} ${destructive ? 'text-red-600 dark:text-red-400' : 'text-neutral-700 dark:text-neutral-200'}`}
        >
          {icon}
          <span className="truncate">{text}</span>
        </button>
      );
    });

    return createPortal(
      <div
        ref={panelRef}
        role="menu"
        aria-label={t('contextMenu.aria')}
        style={{
          position: 'fixed',
          top: coords?.top ?? clientY,
          left: coords?.left ?? clientX,
          visibility: coords ? 'visible' : 'hidden',
        }}
        className="z-[10000] min-w-[200px] rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
      >
        {rows}
        {(canEdit || canHide) && column && (
          <>
            {rows.length > 0 && <div className="my-1 border-t border-neutral-200 dark:border-neutral-700" />}
            {canEdit && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  deps.onEditColumn?.(column);
                  close();
                }}
                className={`${ITEM_CLASS} text-neutral-700 dark:text-neutral-200`}
              >
                <Pencil size={13} />
                <span className="truncate">{t('column.edit')}</span>
              </button>
            )}
            {canHide && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                deps.onHideColumn?.(column.id);
                close();
              }}
              className={`${ITEM_CLASS} text-neutral-700 dark:text-neutral-200`}
            >
              <EyeOff size={13} />
              <span className="truncate">{t('contextMenu.hideColumn', { name: column.name })}</span>
            </button>
            )}
          </>
        )}
      </div>,
      document.body,
    );
  };
}
