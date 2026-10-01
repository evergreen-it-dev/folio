// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { PastePreview, parseClipboardGrid } from './PastePreview';
import './i18n/register';

/**
 * Round 26 (DATA TABLES) — the Google Sheets migration path
 * (spec §10.1, acceptance criterion §17.3).
 *
 * The clipboard parser gets the most attention because its failure mode is
 * silent corruption: a cell that itself contains a tab or a newline arrives
 * quoted, and a naive split tears one cell into several rows — the user then
 * imports 200 rows and gets 260, with data in the wrong columns.
 */

beforeEach(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('parseClipboardGrid', () => {
  it('splits a plain TSV block', () => {
    expect(parseClipboardGrid('a\tb\nc\td')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('keeps a quoted cell containing a newline as ONE cell', () => {
    expect(parseClipboardGrid('a\t"one\ntwo"\nc\td')).toEqual([
      ['a', 'one\ntwo'],
      ['c', 'd'],
    ]);
  });

  it('keeps a quoted cell containing the delimiter as one cell', () => {
    expect(parseClipboardGrid('"x\ty"\tb')).toEqual([['x\ty', 'b']]);
  });

  it('unescapes a doubled quote', () => {
    expect(parseClipboardGrid('"say ""hi"""\tb')).toEqual([['say "hi"', 'b']]);
  });

  it('tolerates CRLF line endings', () => {
    expect(parseClipboardGrid('a\tb\r\nc\td')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('drops the empty trailing row a final newline produces', () => {
    expect(parseClipboardGrid('a\tb\n')).toEqual([['a', 'b']]);
  });

  it('handles a CSV paste when told the delimiter', () => {
    expect(parseClipboardGrid('a,b\nc,d', ',')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});

describe('PastePreview', () => {
  const rows = [
    ['Week', 'Owner', 'Estimate'],
    ['W8', '@sk', '3'],
    ['W9', '@va', '5'],
  ];

  it('shows the inferred types before anything is written (spec: nothing is guessed silently)', () => {
    render(<PastePreview rows={rows} existingColumns={[]} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    // Inference: @handles → user, numerals → number.
    expect(screen.getByLabelText('Type of column “Owner”')).toHaveProperty('value', 'user');
    expect(screen.getByLabelText('Type of column “Estimate”')).toHaveProperty('value', 'number');
  });

  it('summarises what will be imported', () => {
    render(<PastePreview rows={rows} existingColumns={[]} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText('Rows: 2, columns: 3')).toBeTruthy();
  });

  it('lets the user override a proposed type before confirming', () => {
    const onConfirm = vi.fn();
    render(<PastePreview rows={rows} existingColumns={[]} onCancel={vi.fn()} onConfirm={onConfirm} />);
    fireEvent.change(screen.getByLabelText('Type of column “Estimate”'), { target: { value: 'text' } });
    fireEvent.click(screen.getByText('Paste'));

    const result = onConfirm.mock.calls[0]?.[0];
    expect(result.columns.find((column: { name: string }) => column.name === 'Estimate').type).toBe('text');
    expect(result.rows).toHaveLength(2);
  });

  it('treats the first row as data when the header toggle is off', () => {
    const onConfirm = vi.fn();
    render(<PastePreview rows={rows} existingColumns={[]} onCancel={vi.fn()} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByLabelText('First row is the header'));
    fireEvent.click(screen.getByText('Paste'));
    // All three rows become data rather than two.
    expect(onConfirm.mock.calls[0]?.[0].rows).toHaveLength(3);
  });

  it('offers append/replace only when pasting into an existing schema', () => {
    const { rerender } = render(
      <PastePreview rows={rows} existingColumns={[]} onCancel={vi.fn()} onConfirm={vi.fn()} />,
    );
    expect(screen.queryByLabelText('Mode')).toBeNull();

    rerender(
      <PastePreview
        rows={rows}
        existingColumns={[{ id: 'week', name: 'Week', type: 'text' }]}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText('Mode')).toBeTruthy();
  });

  it('does not send a new schema when pasting into existing columns', () => {
    const onConfirm = vi.fn();
    render(
      <PastePreview
        rows={rows}
        existingColumns={[{ id: 'week', name: 'Week', type: 'text' }]}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByText('Paste'));
    expect(onConfirm.mock.calls[0]?.[0].columns).toBeNull();
  });

  it('cancels without confirming', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<PastePreview rows={rows} existingColumns={[]} onCancel={onCancel} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
