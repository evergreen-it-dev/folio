import { describe, expect, it } from 'vitest';
import type { TableColumn, TableRow } from '@shared/contracts';
import { cellPlace } from './commentCells';

const columns: TableColumn[] = [
  { id: 'owner', name: 'Owner', type: 'text' },
  { id: 'note', name: 'Note', type: 'text' },
];
const rows: TableRow[] = [
  { id: 'r1', values: { owner: 'alice', note: null } },
  { id: 'r2', values: { owner: 'bob', note: 'hi' } },
];

describe('cellPlace', () => {
  it('tells where a cell can be shown: grid, row panel (hidden column), after unfiltering, or nowhere', () => {
    const shownRows = [rows[1]];
    const shownColumns = [columns[0]];
    expect(cellPlace({ rowId: 'r2', columnId: 'owner' }, rows, shownRows, columns, shownColumns)).toBe('grid');
    expect(cellPlace({ rowId: 'r2', columnId: 'note' }, rows, shownRows, columns, shownColumns)).toBe('panel');
    expect(cellPlace({ rowId: 'r1', columnId: 'owner' }, rows, shownRows, columns, shownColumns)).toBe('unfilter');
    expect(cellPlace({ rowId: 'r1', columnId: 'zzz' }, rows, shownRows, columns, shownColumns)).toBe('gone');
  });
});
