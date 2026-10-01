// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import type { TableColumn } from '@shared/contracts';
import { ColumnEditor } from './ColumnEditor';
import '../i18n/register';

/**
 * Round 26 follow-up — the "List values" editor.
 *
 * THE REGRESSION THIS FILE EXISTS FOR: the option rows used to be keyed
 * `${option.value}-${index}`. The value is the very string being typed, so
 * every keystroke produced a new key, React unmounted the <input> and mounted
 * a fresh one, and focus + caret went with it — typing "In" left "I" in one
 * row and "n" in the next. The tests below type SEVERAL characters and assert
 * `document.activeElement`, because a single-character test passes against
 * the broken key (the damage only shows from the second keystroke on).
 *
 * `tableOptionSchema` has no id and must not grow one — the option's value is
 * what the file persists (spec §2) — so index is the only key available, and
 * it is the right one for a fixed-order editable array.
 */

beforeEach(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const selectColumn: TableColumn = {
  id: 'stage',
  name: 'Stage',
  type: 'select',
  options: [
    { value: 'A', color: 'red' },
    { value: 'B', color: 'blue' },
  ],
};

function open(column: TableColumn = selectColumn) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  render(<ColumnEditor column={column} rows={[]} onSave={onSave} onClose={onClose} />);
  return { onSave, onClose };
}

/** The option-value inputs, in row order. */
function valueInputs(): HTMLInputElement[] {
  return screen.getAllByLabelText('Value') as HTMLInputElement[];
}

describe('ColumnEditor — option rows keep focus while typing', () => {
  it('keeps focus on the same input across MULTIPLE keystrokes', () => {
    open();
    const input = valueInputs()[0] as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);

    // The owner's exact failure: two characters, one after the other.
    for (const text of ['I', 'In', 'Input']) {
      fireEvent.change(input, { target: { value: text } });
      // Same DOM node, still focused — with the old key this is a detached
      // node and activeElement has fallen back to <body>.
      expect(document.activeElement).toBe(input);
      expect(valueInputs()[0]).toBe(input);
    }

    expect(valueInputs()[0]?.value).toBe('Input');
    // …and the neighbouring row was never touched.
    expect(valueInputs()[1]?.value).toBe('B');
  });

  it('preserves the caret POSITION for mid-string edits, not only focus', () => {
    open();
    const input = valueInputs()[0] as HTMLInputElement;
    input.focus();

    fireEvent.change(input, { target: { value: 'AC' } });
    // Put the caret between A and C and insert a character there, the way a
    // human editing an existing value does.
    input.setSelectionRange(1, 1);
    input.value = 'ABC';
    input.setSelectionRange(2, 2);
    fireEvent.change(input);

    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('ABC');
    // A remount would put the caret at the end (3) on a fresh node.
    expect(input.selectionStart).toBe(2);
  });

  it('types into the description without disturbing the value input', () => {
    open();
    const description = screen.getAllByLabelText('Description')[0] as HTMLInputElement;
    description.focus();
    fireEvent.change(description, { target: { value: 'ex' } });
    fireEvent.change(description, { target: { value: 'explanation' } });
    expect(document.activeElement).toBe(description);
    expect(description.value).toBe('explanation');
    expect(valueInputs()[0]?.value).toBe('A');
  });

  it('adding and removing rows still lines values up with their colours', () => {
    const { onSave } = open();
    fireEvent.click(screen.getByText('Add value'));
    const inputs = valueInputs();
    expect(inputs).toHaveLength(3);
    const fresh = inputs[2] as HTMLInputElement;
    fresh.focus();
    fireEvent.change(fresh, { target: { value: 'CD' } });
    expect(document.activeElement).toBe(fresh);

    // Drop the middle row; the remaining two keep their own values.
    fireEvent.click(screen.getAllByLabelText('Remove value')[1] as HTMLElement);
    expect(valueInputs().map((node) => node.value)).toEqual(['A', 'CD']);

    fireEvent.click(screen.getByText('Save'));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [
          { value: 'A', color: 'red' },
          { value: 'CD', color: 'gray' },
        ],
      }),
    );
  });

  it('picks a colour from a swatch grid, with no colour NAME rendered', () => {
    const { onSave } = open();
    // The trigger renders no word — the name lives in its accessible name.
    const trigger = screen.getByLabelText('Colour: Red');
    expect(trigger.textContent).toBe('');

    fireEvent.click(trigger);
    const grid = screen.getByRole('listbox', { name: 'Colour' });
    // The widened palette: 21 swatches, every one carrying its own name.
    expect(grid.querySelectorAll('[role="option"]')).toHaveLength(21);
    expect(screen.getByRole('option', { name: 'Red' }).getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getByRole('option', { name: 'Emerald' }));
    expect(screen.getByLabelText('Colour: Emerald')).toBeTruthy();

    fireEvent.click(screen.getByText('Save'));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [
          { value: 'A', color: 'emerald' },
          { value: 'B', color: 'blue' },
        ],
      }),
    );
  });

  it('walks the swatch grid with arrow keys', () => {
    open();
    fireEvent.click(screen.getByLabelText('Colour: Red'));
    const first = screen.getByRole('option', { name: 'Gray' });
    first.focus();
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Colour' }), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Slate' }));
    // Down moves a whole row (7 wide): slate (index 1) → violet (index 8).
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Colour' }), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Violet' }));
  });

  it('puts the value first, then the description, then the colour', () => {
    open();
    // The value is the content and the thing stored in the file, so it leads
    // the row — the wide colour <select> used to.
    const row = (valueInputs()[0] as HTMLInputElement).parentElement as HTMLElement;
    const fields = [...row.querySelectorAll('input, button')].map(
      (node) => node.getAttribute('aria-label'),
    );
    expect(fields.slice(0, 3)).toEqual(['Value', 'Description', 'Colour: Red']);
  });
});
