// @vitest-environment jsdom
/**
 * Menu's controlled mode (the header owns which of its surfaces is open).
 * The trap it must avoid: a CLOSED controlled menu answering every click on
 * the page with onOpenChange(false) — that would close whichever other header
 * surface shares the same open-state.
 */
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Menu } from './Menu';

afterEach(cleanup);

describe('Menu (controlled)', () => {
  it('a closed controlled menu stays silent on outside clicks; an open one reports the close once', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <Menu triggerLabel="Export" trigger="E" open={false} onOpenChange={onOpenChange}>
        {() => <p>formats</p>}
      </Menu>,
    );
    fireEvent.pointerDown(document.body);
    expect(onOpenChange).not.toHaveBeenCalled();

    rerender(
      <Menu triggerLabel="Export" trigger="E" open onOpenChange={onOpenChange}>
        {() => <p>formats</p>}
      </Menu>,
    );
    expect(screen.getByText('formats')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('without a trigger it renders no button and opens from `open` alone', () => {
    const anchorRef = createRef<HTMLDivElement>();
    const { rerender } = render(
      <>
        <div ref={anchorRef} />
        <Menu triggerLabel="Export" anchorRef={anchorRef} open={false} onOpenChange={() => {}}>
          {() => <p>formats</p>}
        </Menu>
      </>,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('formats')).toBeNull();
    rerender(
      <>
        <div ref={anchorRef} />
        <Menu triggerLabel="Export" anchorRef={anchorRef} open onOpenChange={() => {}}>
          {() => <p>formats</p>}
        </Menu>
      </>,
    );
    expect(screen.getByRole('menu').textContent).toBe('formats');
  });
});
