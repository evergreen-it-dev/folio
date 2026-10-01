// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import type { TableView } from '@shared/contracts';
import { FilterPanel } from './FilterPanel';
import { MOCK_COLUMNS } from '../fixtures';
import '../i18n/register';

/**
 * Round 26 follow-up — the nested-popover dismissal bug (owner-reported).
 *
 * The Filter panel is an AnchoredPanel; the "Pick values" option picker
 * inside one of its rules is ANOTHER AnchoredPanel. Both portal to
 * document.body, so the outer panel's `contains(target)` check used to read a
 * click in the picker as "outside me" and closed the whole Filter panel the
 * instant a value was picked. See AnchoredPanel's nesting docblock.
 */

beforeEach(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const EMPTY: TableView['filter'] = { op: 'and', rules: [] };

/** FilterPanel is controlled, so the test owns the filter state. */
function Harness({ onChange }: { onChange?: (filter: TableView['filter']) => void }) {
  const [filter, setFilter] = useState<TableView['filter']>(EMPTY);
  return (
    <div>
      <button type="button">outside</button>
      <FilterPanel
        columns={MOCK_COLUMNS}
        filter={filter}
        onChange={(next) => {
          setFilter(next);
          onChange?.(next);
        }}
      />
    </div>
  );
}

/** Open the panel and add one rule. MOCK_COLUMNS[0] is a `select`, so the
 *  rule starts on an option operator and shows the picker button. */
function openWithRule(onChange?: (filter: TableView['filter']) => void) {
  render(<Harness onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
  fireEvent.click(screen.getByText('Add filter'));
  return screen.getByText('Pick values');
}

const panelOpen = () => screen.queryByText('Add filter') !== null;
const pickerOpen = () => screen.queryByRole('listbox') !== null;

describe('FilterPanel — nested option picker', () => {
  it('picking a value keeps the Filter panel open', () => {
    const onChange = vi.fn();
    fireEvent.click(openWithRule(onChange));
    expect(pickerOpen()).toBe(true);

    // The click that used to kill the whole panel.
    fireEvent.mouseDown(screen.getByText('W9 24-28.08'));
    fireEvent.click(screen.getByText('W9 24-28.08'));

    expect(panelOpen()).toBe(true);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        rules: [expect.objectContaining({ value: ['W9 24-28.08'] })],
      }),
    );
    // Forced-multiple in the filter: the picker stays open for a second pick.
    expect(pickerOpen()).toBe(true);
  });

  it('picks several values in a row without reopening the picker', () => {
    fireEvent.click(openWithRule());
    for (const value of ['W8 17-21.08', 'W9 24-28.08', 'W10 31.08-04.09']) {
      fireEvent.mouseDown(screen.getByText(value));
      fireEvent.click(screen.getByText(value));
      expect(panelOpen()).toBe(true);
      expect(pickerOpen()).toBe(true);
    }
  });

  it('clicking the Filter panel body closes only the picker', () => {
    fireEvent.click(openWithRule());
    expect(pickerOpen()).toBe(true);

    fireEvent.mouseDown(screen.getByText('Add filter'));
    expect(pickerOpen()).toBe(false);
    expect(panelOpen()).toBe(true);
  });

  it('clicking outside everything closes both layers', () => {
    fireEvent.click(openWithRule());
    fireEvent.mouseDown(screen.getByText('outside'));
    expect(pickerOpen()).toBe(false);
    expect(panelOpen()).toBe(false);
  });

  it('Escape closes the innermost layer first, one per press', () => {
    fireEvent.click(openWithRule());
    expect(pickerOpen()).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(pickerOpen()).toBe(false);
    expect(panelOpen()).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(panelOpen()).toBe(false);
  });
});

describe('FilterPanel — the grid keyboard must not reach panel inputs', () => {
  /**
   * react-datasheet-grid listens for keydown on `document` and, with an
   * active cell, treats Backspace as "clear the selection" — preventDefault
   * included, so a typo in a panel input could not be erased. Ctrl+A grabs
   * select-all too. See AnchoredPanel's isolate() docblock.
   */
  function gridListener() {
    const seen = vi.fn();
    document.addEventListener('keydown', seen);
    return { seen, off: () => document.removeEventListener('keydown', seen) };
  }

  it('swallows keydown from inside the panel before it reaches document', () => {
    const { seen, off } = gridListener();
    const insidePanel = openWithRule();
    fireEvent.keyDown(insidePanel, { key: 'Backspace' });
    fireEvent.keyDown(insidePanel, { key: 'a', ctrlKey: true });
    expect(seen).not.toHaveBeenCalled();
    off();
  });

  it('swallows it from a NESTED picker too', () => {
    const { seen, off } = gridListener();
    fireEvent.click(openWithRule());
    fireEvent.keyDown(screen.getByLabelText('Search'), { key: 'Backspace' });
    expect(seen).not.toHaveBeenCalled();
    off();
  });

  it('still lets the picker act on its own Enter', () => {
    const onChange = vi.fn();
    fireEvent.click(openWithRule(onChange));
    const search = screen.getByLabelText('Search');
    fireEvent.change(search, { target: { value: 'W9' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ rules: [expect.objectContaining({ value: ['W9 24-28.08'] })] }),
    );
  });

  it('leaves keys typed OUTSIDE any panel alone', () => {
    const { seen, off } = gridListener();
    openWithRule();
    fireEvent.keyDown(screen.getByText('outside'), { key: 'Backspace' });
    expect(seen).toHaveBeenCalled();
    off();
  });
});
