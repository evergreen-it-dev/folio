// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import type { TableColumn } from '@shared/contracts';
import { ColumnHeader } from './ColumnHeader';
import { STATUS_OPTIONS } from '../fixtures';
import '../i18n/register';

/**
 * Round 26 (DATA TABLES) — acceptance criterion §17.2 in test form:
 * "everything is visible in the header (the type icon, ⓘ with the description)".
 *
 * The ⓘ has to be a real popover rather than a native `title` (spec §2.3
 * wants a multi-line description AND the option list with colours and
 * per-option descriptions), so these assert that hovering actually renders
 * that content into the document — which a `title` attribute never would.
 */

// The app is pinned to Russian in tests (see markdown/PageTree.test.tsx),
// so assertions read against the ru bundle.
beforeEach(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const statusColumn: TableColumn = {
  id: 'status',
  name: 'Status',
  type: 'status',
  description: 'Progress state\nthe second line',
  options: STATUS_OPTIONS,
};

describe('ColumnHeader', () => {
  it('shows the column name', () => {
    render(<ColumnHeader column={statusColumn} />);
    expect(screen.getByText('Status')).toBeTruthy();
  });

  it('renders no ⓘ when there is nothing to say', () => {
    // An icon that opens an empty tooltip trains people to stop clicking it.
    render(<ColumnHeader column={{ id: 'task', name: 'Task', type: 'text' }} />);
    expect(screen.queryByLabelText(/Hint for column/)).toBeNull();
  });

  it('opens a real popover on hover with the multi-line description', async () => {
    render(<ColumnHeader column={statusColumn} />);
    const hint = screen.getByLabelText('Hint for column “Status”');
    fireEvent.mouseEnter(hint.parentElement as HTMLElement);
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeTruthy());
    expect(screen.getByText(/Progress state/)).toBeTruthy();
  });

  it('lists every option in the tooltip, with its description', async () => {
    render(<ColumnHeader column={statusColumn} />);
    fireEvent.mouseEnter(
      (screen.getByLabelText('Hint for column “Status”').parentElement as HTMLElement),
    );
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeTruthy());
    expect(screen.getByText('IN PROG')).toBeTruthy();
    expect(screen.getByText('DONE')).toBeTruthy();
    expect(screen.getByText(/in progress/)).toBeTruthy();
  });

  it('opens on keyboard focus too, not only on hover', async () => {
    render(<ColumnHeader column={statusColumn} />);
    fireEvent.focus(
      (screen.getByLabelText('Hint for column “Status”').parentElement as HTMLElement),
    );
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeTruthy());
  });

  it('closes the tooltip on mouse leave', async () => {
    render(<ColumnHeader column={statusColumn} />);
    const trigger = screen.getByLabelText('Hint for column “Status”').parentElement as HTMLElement;
    fireEvent.mouseEnter(trigger);
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeTruthy());
    fireEvent.mouseLeave(trigger);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('reports the multi-value flag in the tooltip', async () => {
    render(
      <ColumnHeader
        column={{ id: 'owner', name: 'Owner', type: 'user', multiple: true, description: 'The responsible person' }}
      />,
    );
    fireEvent.mouseEnter(
      (screen.getByLabelText('Hint for column “Owner”').parentElement as HTMLElement),
    );
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeTruthy());
    expect(screen.getByText(/multiple values/)).toBeTruthy();
  });

  it('hides the column menu for a viewer', () => {
    const actions = {
      onEdit: vi.fn(),
      onDuplicate: vi.fn(),
      onHide: vi.fn(),
      onDelete: vi.fn(),
      onSort: vi.fn(),
      onInsertAfter: vi.fn(),
    };
    const { rerender } = render(<ColumnHeader column={statusColumn} actions={actions} />);
    expect(screen.getByLabelText('Column menu for “Status”')).toBeTruthy();
    rerender(<ColumnHeader column={statusColumn} actions={actions} readOnly />);
    expect(screen.queryByLabelText('Column menu for “Status”')).toBeNull();
  });

  it('offers the destructive column actions through the menu', () => {
    const actions = {
      onEdit: vi.fn(),
      onDuplicate: vi.fn(),
      onHide: vi.fn(),
      onDelete: vi.fn(),
      onSort: vi.fn(),
      onInsertAfter: vi.fn(),
    };
    render(<ColumnHeader column={statusColumn} actions={actions} />);
    fireEvent.click(screen.getByLabelText('Column menu for “Status”'));
    fireEvent.click(screen.getByText('Delete column'));
    expect(actions.onDelete).toHaveBeenCalledWith(statusColumn);
  });

  it('leaves right-click to the grid context menu and opens settings on double-click', () => {
    const actions = {
      onEdit: vi.fn(),
      onDuplicate: vi.fn(),
      onHide: vi.fn(),
      onDelete: vi.fn(),
      onSort: vi.fn(),
      onInsertAfter: vi.fn(),
    };
    render(<ColumnHeader column={statusColumn} actions={actions} />);
    fireEvent.contextMenu(screen.getByText('Status'));
    expect(actions.onEdit).not.toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByText('Status'));
    expect(actions.onEdit).toHaveBeenCalledWith(statusColumn);
  });

  it('shows the sort direction marker when the column drives the sort', () => {
    const { container } = render(<ColumnHeader column={statusColumn} sortDir="desc" />);
    expect(container.textContent).toContain('↓');
  });
});

/**
 * Round 26 follow-up — column resizing (owner: widths were not adjustable).
 *
 * react-datasheet-grid has no interactive resize at all, only declarative
 * basis/grow/shrink, so the drag handle is ours. It works on pointer-delta
 * arithmetic from a width that gridColumns.tsx always supplies from the
 * MODEL (basisFor) — which is also why the arithmetic tests below can drive
 * raw pointer events in jsdom at all, every box here being 0×0. `width` is
 * still an optional prop for any OTHER caller (measured-fallback tests
 * further down cover that case explicitly).
 *
 * Round 26 follow-up #2 (owner, on production, after a previous round
 * claimed this fixed on jsdom evidence alone): dragging did nothing usable.
 * jsdom cannot exercise a real pointer, real layout, or real stacking —
 * nothing here can PROVE the drag works with a mouse in a browser. What
 * changed and IS covered below: (a) the `width ?? MIN_COLUMN_WIDTH` fallback
 * — dead in the app's actual wiring, since basisFor never returns undefined,
 * but a real landmine for any other caller — now measures the rendered box
 * instead of snapping to 60px; (b) `onMove` used to close over the FIRST
 * render's `onResize`/`width` for the rest of the gesture, which matters
 * because `onResize` (`TablePage.resizeColumn`) is re-created on every view
 * -draft write — including ones this same drag just made — so a long drag
 * was computing every write after the first against increasingly stale view
 * state. It now reads a ref that a `useEffect` keeps current.
 */
describe('ColumnHeader — resize handle', () => {
  const textColumn: TableColumn = { id: 'task', name: 'Task', type: 'text' };

  function renderHandle(width = 200) {
    const onResize = vi.fn();
    render(<ColumnHeader column={textColumn} width={width} onResize={onResize} />);
    return { onResize, handle: screen.getByLabelText('Resize column “Task”') };
  }

  /** jsdom has no PointerEvent constructor and no pointer capture. */
  function drag(handle: HTMLElement, from: number, to: number) {
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: from });
    fireEvent(window, new MouseEvent('pointermove', { clientX: to, bubbles: true }));
    fireEvent(window, new MouseEvent('pointerup', { bubbles: true }));
  }

  it('is absent unless a resize callback is supplied', () => {
    render(<ColumnHeader column={textColumn} width={200} />);
    expect(screen.queryByLabelText(/Resize column/)).toBeNull();
  });

  it('writes the dragged width, counted from the current one', () => {
    const { onResize, handle } = renderHandle(200);
    drag(handle, 500, 560);
    expect(onResize).toHaveBeenLastCalledWith('task', 260);
  });

  it('shrinks when dragged left', () => {
    const { onResize, handle } = renderHandle(200);
    drag(handle, 500, 430);
    expect(onResize).toHaveBeenLastCalledWith('task', 130);
  });

  it('clamps to the 60..1200 bounds the contract allows', () => {
    const narrow = renderHandle(100);
    drag(narrow.handle, 500, 100);
    expect(narrow.onResize).toHaveBeenLastCalledWith('task', 60);
    cleanup();

    const wide = renderHandle(1100);
    drag(wide.handle, 500, 3000);
    expect(wide.onResize).toHaveBeenLastCalledWith('task', 1200);
  });

  it('emits nothing while the clamped width has not actually changed', () => {
    // Every emission becomes a view-draft write; a pointermove stream must not
    // re-serialise the draft once the column is already pinned at the bound.
    const { onResize, handle } = renderHandle(60);
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 500 });
    fireEvent(window, new MouseEvent('pointermove', { clientX: 480, bubbles: true }));
    fireEvent(window, new MouseEvent('pointermove', { clientX: 460, bubbles: true }));
    expect(onResize).not.toHaveBeenCalled();
  });

  it('stops listening once the pointer is released', () => {
    const { onResize, handle } = renderHandle(200);
    drag(handle, 500, 560);
    onResize.mockClear();
    fireEvent(window, new MouseEvent('pointermove', { clientX: 900, bubbles: true }));
    expect(onResize).not.toHaveBeenCalled();
  });

  it('resizes from the keyboard, so it works without a pointer', () => {
    const { onResize, handle } = renderHandle(200);
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onResize).toHaveBeenLastCalledWith('task', 216);
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith('task', 184);
    onResize.mockClear();
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(onResize).not.toHaveBeenCalled();
  });

  describe('starting width when the model has none to offer', () => {
    /** A caller that renders the handle with no `width` prop at all. */
    function renderWithoutWidth() {
      const onResize = vi.fn();
      render(<ColumnHeader column={textColumn} onResize={onResize} />);
      return { onResize, handle: screen.getByLabelText('Resize column “Task”') };
    }

    it('measures the rendered box (the handle\'s PARENT, not the 6px handle itself)', () => {
      const { onResize, handle } = renderWithoutWidth();
      // The parent is this component's own root `<div>`, spanning the full
      // header cell — stubbing the HANDLE's own box instead would prove
      // nothing, since a wrong implementation reading it would still see a
      // plausible-looking number.
      Object.defineProperty(handle.parentElement as HTMLElement, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ width: 300, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} }),
      });
      drag(handle, 500, 560);
      expect(onResize).toHaveBeenLastCalledWith('task', 360); // 300 + 60
    });

    it('falls back to MIN_COLUMN_WIDTH only when the measured box is ALSO zero', () => {
      // Untouched jsdom boxes are exactly this — 0×0 — which is why the
      // model-first width was preferred in the first place; this is the
      // last-resort floor, not the everyday path.
      const { onResize, handle } = renderWithoutWidth();
      drag(handle, 500, 560);
      expect(onResize).toHaveBeenLastCalledWith('task', 120); // 60 + 60
    });
  });

  it('keeps writing through the LATEST onResize during one drag, not the one from before a re-render', () => {
    // What a real drag actually does: the first onResize call lands in the
    // view draft, TablePage re-renders, and `resizeColumn` — this prop — is
    // a NEW function bound to the new draft. A stale closure captured once
    // at pointerdown would keep calling the ORIGINAL (now-stale) one for
    // the rest of the gesture.
    const onResizeAtPointerdown = vi.fn();
    const onResizeAfterRerender = vi.fn();
    const { rerender } = render(
      <ColumnHeader column={textColumn} width={200} onResize={onResizeAtPointerdown} />,
    );
    const handle = screen.getByLabelText('Resize column “Task”');
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 500 });

    rerender(<ColumnHeader column={textColumn} width={200} onResize={onResizeAfterRerender} />);
    fireEvent(window, new MouseEvent('pointermove', { clientX: 560, bubbles: true }));

    expect(onResizeAtPointerdown).not.toHaveBeenCalled();
    expect(onResizeAfterRerender).toHaveBeenLastCalledWith('task', 260);
  });
});
