import { MessageSquare, MessageSquarePlus } from 'lucide-react';
import type { CellComponent, CellProps } from 'react-datasheet-grid';
import type { TableRow } from '@shared/contracts';
import type { CellContext } from './CellComponents';

type Props = CellProps<TableRow, CellContext>;

/**
 * Draws the comment affordances over a cell: a marker with the number of open
 * threads at its top-right corner, the add button that appears while the row is
 * hovered (grid.css), and the ring on the cell being talked about. A fragment,
 * so the wrapped editor keeps its own layout; the cell (.dsg-cell) is the
 * positioned ancestor. Nothing is drawn for a table without comments.
 */
function withComments(Inner: CellComponent<TableRow, CellContext>): CellComponent<TableRow, CellContext> {
  function CommentableCell(props: Props) {
    const comments = props.columnData.comments;
    if (!comments) return <Inner {...props} />;
    const rowId = props.rowData.id;
    const columnId = props.columnData.column.id;
    const ids = comments.cells.get(rowId)?.get(columnId);
    const highlighted = comments.highlight?.rowId === rowId && comments.highlight.columnId === columnId;
    return (
      <>
        <Inner {...props} />
        {highlighted && <span aria-hidden="true" data-table-comment-highlight className="pointer-events-none absolute inset-0 z-[1] border-2 border-amber-500 bg-amber-300/10" />}
        {ids && ids.length > 0 ? (
          <button
            type="button"
            data-table-comment-marker={`${rowId}:${columnId}`}
            aria-label={comments.markerLabel(ids.length)}
            title={comments.markerLabel(ids.length)}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              comments.onOpenThread(ids[0]);
            }}
            className="absolute right-0.5 top-0.5 z-[2] flex h-4 min-w-4 items-center justify-center gap-0.5 rounded-full rounded-tr-none border border-amber-500 bg-amber-400 px-0.5 text-[10px] font-medium leading-none text-neutral-900 shadow-sm hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
          >
            <MessageSquare size={9} aria-hidden="true" />
            <span className="tabular-nums">{ids.length}</span>
          </button>
        ) : (
          comments.canComment && (
            <button
              type="button"
              data-table-comment-add={`${rowId}:${columnId}`}
              aria-label={comments.addLabel}
              title={comments.addLabel}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                comments.onStart(rowId, columnId);
              }}
              className="folio-cell-comment-add absolute right-0.5 top-0.5 z-[2] flex h-4 w-4 items-center justify-center rounded border border-neutral-300 bg-white text-neutral-500 opacity-0 shadow-sm hover:text-neutral-900 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-300"
            >
              <MessageSquarePlus size={10} aria-hidden="true" />
            </button>
          )
        )}
      </>
    );
  }
  return CommentableCell;
}

// One wrapper per editor, made once: the grid keys its cells by component type, so a fresh wrapper per render would remount every cell.
const wrapped = new WeakMap<CellComponent<TableRow, CellContext>, CellComponent<TableRow, CellContext>>();

export function commentable(Inner: CellComponent<TableRow, CellContext>): CellComponent<TableRow, CellContext> {
  let component = wrapped.get(Inner);
  if (!component) {
    component = withComments(Inner);
    wrapped.set(Inner, component);
  }
  return component;
}
