import { describe, expect, it } from 'vitest';
import type { CommentThread } from '@shared/comments';
import type { TableColumn, TableRow } from '@shared/contracts';
import { cellPreview, deletedCellThreads, threadCell, threadsByCell } from './tableCommentsModel';

function thread(id: string, cell?: { rowId: string; columnId: string }): CommentThread {
  return {
    id,
    pageId: 'p',
    anchorFrom: null,
    anchorTo: null,
    quotedText: null,
    target: cell ? { kind: 'table_cell', ...cell, label: 'x' } : null,
    status: 'open',
    createdBy: null,
    createdAt: '',
    resolvedBy: null,
    resolvedAt: null,
    comments: [],
  };
}
const columns: TableColumn[] = [
  { id: 'owner', name: 'Owner', type: 'text' },
  { id: 'note', name: 'Note', type: 'text' },
];
const rows: TableRow[] = [
  { id: 'r1', values: { owner: 'alice', note: null } },
  { id: 'r2', values: { owner: 'bob', note: 'hi' } },
];

describe('table cell comment targets', () => {
  it('reads the cell of a table thread only', () => {
    expect(threadCell(thread('t', { rowId: 'r1', columnId: 'owner' }))).toEqual({ rowId: 'r1', columnId: 'owner' });
    expect(threadCell(thread('t'))).toBeUndefined();
  });

  it('groups threads by row then column', () => {
    const map = threadsByCell([thread('a', { rowId: 'r1', columnId: 'owner' }), thread('b', { rowId: 'r1', columnId: 'owner' }), thread('c', { rowId: 'r2', columnId: 'note' }), thread('d')]);
    expect(map.get('r1')?.get('owner')).toEqual(['a', 'b']);
    expect(map.get('r2')?.get('note')).toEqual(['c']);
    expect(map.size).toBe(2);
  });

  it('marks the threads whose row or column is gone', () => {
    const threads = [thread('a', { rowId: 'r1', columnId: 'owner' }), thread('b', { rowId: 'r9', columnId: 'owner' }), thread('c', { rowId: 'r1', columnId: 'gone' })];
    expect([...deletedCellThreads(threads, new Set(['r1', 'r2']), new Set(['owner', 'note']))].sort()).toEqual(['b', 'c']);
  });

  it('previews the cell text, else the column name', () => {
    expect(cellPreview(rows, columns, { rowId: 'r1', columnId: 'owner' })).toBe('alice');
    expect(cellPreview(rows, columns, { rowId: 'r1', columnId: 'note' })).toBe('Note');
  });
});
