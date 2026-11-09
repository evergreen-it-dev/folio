// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CellComponent } from 'react-datasheet-grid';
import type { TableRow } from '@shared/contracts';
import type { TableCommentsProps } from '../types';
import type { CellContext } from './CellComponents';
import { commentable } from './CommentableCell';

afterEach(cleanup);

const Plain: CellComponent<TableRow, CellContext> = ({ rowData }) => <span>{String(rowData.values.owner)}</span>;
const column = { id: 'owner', name: 'Owner', type: 'text' as const };
const row: TableRow = { id: 'r1', values: { owner: 'alice' } };

function mount(comments: TableCommentsProps | undefined) {
  const Cell = commentable(Plain);
  return render(<Cell {...({ rowData: row, columnData: { column, comments } } as unknown as Parameters<typeof Cell>[0])} />);
}
const base = (over: Partial<TableCommentsProps> = {}): TableCommentsProps => ({
  canComment: true,
  cells: new Map(),
  addLabel: 'Comment on this cell',
  markerLabel: (n) => `${n} open`,
  onStart: vi.fn(),
  onOpenThread: vi.fn(),
  ...over,
});

describe('commentable cell', () => {
  it('draws nothing extra for a table without comments, and keeps one wrapper per editor', () => {
    mount(undefined);
    expect(screen.getByText('alice')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(commentable(Plain)).toBe(commentable(Plain));
  });

  it('offers the add button to a commenter, and starts a thread from this cell', () => {
    const comments = base();
    mount(comments);
    fireEvent.click(screen.getByRole('button', { name: 'Comment on this cell' }));
    expect(comments.onStart).toHaveBeenCalledWith('r1', 'owner');
  });

  it('a reader who cannot comment gets no add button', () => {
    mount(base({ canComment: false }));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows a marker with the open count that opens the first thread; the highlight ring marks the talked-about cell', () => {
    const comments = base({ cells: new Map([['r1', new Map([['owner', ['t1', 't2']]])]]), highlight: { rowId: 'r1', columnId: 'owner' } });
    const { container } = mount(comments);
    fireEvent.click(screen.getByRole('button', { name: '2 open' }));
    expect(comments.onOpenThread).toHaveBeenCalledWith('t1');
    expect(container.querySelector('[data-table-comment-highlight]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Comment on this cell' })).toBeNull();
  });
});
