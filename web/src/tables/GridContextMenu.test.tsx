// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import type { ContextMenuItem } from 'react-datasheet-grid';
import { makeGridContextMenu } from './GridContextMenu';
import { UI_LANGUAGES } from '../i18n/languages';
import { MOCK_COLUMNS } from './fixtures';
import './i18n/register';

/**
 * Round 26 follow-up — the right-click menu used to show react-datasheet-
 * grid's hard-coded English ("Copy" / "Insert row below" / …). It is our own
 * component now, so it can be translated AND can carry "Hide column".
 */

beforeEach(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ROW_ITEMS: ContextMenuItem[] = [
  { type: 'COPY', action: vi.fn() },
  { type: 'CUT', action: vi.fn() },
  { type: 'PASTE', action: vi.fn() },
  { type: 'INSERT_ROW_BELLOW', action: vi.fn() },
  { type: 'DUPLICATE_ROW', action: vi.fn() },
  { type: 'DELETE_ROW', action: vi.fn() },
];

/** `status` is MOCK_COLUMNS[8]; the header row is `row: -1`. */
const STATUS_COL = MOCK_COLUMNS.findIndex((column) => column.id === 'status');

function open(
  over: {
    items?: ContextMenuItem[];
    col?: number;
    row?: number;
    onHideColumn?: (id: string) => void;
  } = {},
) {
  const close = vi.fn();
  // `'onHideColumn' in over` rather than a `=== undefined` check, so a test
  // can pass an explicit `undefined` to model the viewer role.
  const onHideColumn = 'onHideColumn' in over ? over.onHideColumn : vi.fn();
  const Menu = makeGridContextMenu({ columns: MOCK_COLUMNS, onHideColumn });
  render(
    <Menu
      clientX={40}
      clientY={60}
      items={over.items ?? ROW_ITEMS}
      cursorIndex={{ col: over.col ?? STATUS_COL, row: over.row ?? 3 }}
      close={close}
    />,
  );
  return { close, onHideColumn };
}

describe('GridContextMenu', () => {
  it('translates every item the library builds', async () => {
    open();
    for (const label of [
      'Copy',
      'Cut',
      'Paste',
      'Insert row below',
      'Duplicate row',
      'Delete row',
    ]) {
      expect(screen.getByRole('menuitem', { name: label })).toBeTruthy();
    }
    cleanup();

    // …and in any other language nothing of the library's English survives.
    for (const lang of UI_LANGUAGES.filter((code) => code !== 'en')) {
      await i18next.changeLanguage(lang);
      open();
      expect(screen.queryByText(/Copy|Insert row below|Delete row/), lang).toBeNull();
      cleanup();
    }
  });

  it('interpolates the row range on the multi-row items', () => {
    open({
      items: [
        { type: 'DUPLICATE_ROWS', fromRow: 2, toRow: 5, action: vi.fn() },
        { type: 'DELETE_ROWS', fromRow: 2, toRow: 5, action: vi.fn() },
      ],
    });
    expect(screen.getByRole('menuitem', { name: 'Duplicate rows 2–5' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Delete rows 2–5' })).toBeTruthy();
  });

  it('runs the library action on click', () => {
    const action = vi.fn();
    open({ items: [{ type: 'COPY', action }] });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }));
    expect(action).toHaveBeenCalled();
  });

  it('offers "Hide column" for the column under the cursor', () => {
    const { close, onHideColumn } = open();
    const hide = screen.getByRole('menuitem', { name: 'Hide column “Status”' });
    fireEvent.click(hide);
    // Routed through the same callback the Columns panel uses, so the change
    // lands in the view DRAFT rather than persisting silently.
    expect(onHideColumn).toHaveBeenCalledWith('status');
    expect(close).toHaveBeenCalled();
  });

  it('offers it on a right-click in the HEADER too (row −1)', () => {
    const { onHideColumn } = open({ row: -1, col: 3 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide column “Goal/Subgoal/Task”' }));
    expect(onHideColumn).toHaveBeenCalledWith('task');
  });

  it('keeps the menu short — no sort, no "Configure" (they live in the column "…")', () => {
    open();
    expect(screen.queryByText(/Sort/)).toBeNull();
    expect(screen.queryByText('Configure')).toBeNull();
    expect(screen.queryByText('Delete column')).toBeNull();
  });

  it('has no column action for a viewer, nor on the gutter or the add-column slot', () => {
    open({ onHideColumn: undefined });
    expect(screen.queryByText(/Hide column/)).toBeNull();
    cleanup();

    open({ col: -1 });
    expect(screen.queryByText(/Hide column/)).toBeNull();
    cleanup();

    // One past the last data column is the trailing «+» slot.
    open({ col: MOCK_COLUMNS.length });
    expect(screen.queryByText(/Hide column/)).toBeNull();
  });

  it('closes on Escape and on a click outside itself', () => {
    const first = open();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(first.close).toHaveBeenCalled();
    cleanup();

    const second = open();
    fireEvent.mouseDown(document.body);
    expect(second.close).toHaveBeenCalled();
  });
});
