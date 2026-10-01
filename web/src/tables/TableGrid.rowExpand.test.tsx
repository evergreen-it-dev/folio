// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CellProps } from 'react-datasheet-grid';
import type { TableRow } from '@shared/contracts';
import { RowExpandCell } from './TableGrid';

afterEach(cleanup);

describe('RowExpandCell', () => {
  it('opens the row panel for every row, independently of column types', () => {
    const onOpenRow = vi.fn();
    const props = {
      rowData: { id: 'row-42', values: {} },
      columnData: { onOpenRow, label: 'Expand in the row panel' },
    } as unknown as CellProps<TableRow, { onOpenRow: (rowId: string) => void; label: string }>;

    render(<RowExpandCell {...props} />);
    const button = screen.getByRole('button', { name: 'Expand in the row panel' });
    expect(button.className).toContain('folio-row-expand');
    fireEvent.click(button);
    expect(onOpenRow).toHaveBeenCalledWith('row-42');
  });
});
