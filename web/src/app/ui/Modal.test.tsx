// @vitest-environment jsdom
/**
 * Round 14 QA fix regression guard: the reported "history window broken" bug
 * root-caused to Modal rendering its `fixed inset-0` overlay INLINE at
 * whatever DOM position the caller happens to occupy — HistoryButton/
 * ShareButton render their panel from *inside* <header>, which has
 * `backdrop-blur` (a `backdrop-filter` other than `none`), and per the CSS
 * spec that makes <header> a containing block for its own `position: fixed`
 * descendants. The overlay was resolving `inset: 0` against the ~55px-tall
 * header box instead of the viewport. createPortal(..., document.body) is
 * the fix (Modal.tsx); this test pins the portal itself, not just the
 * height/scroll behavior added alongside it (jsdom doesn't lay out real
 * boxes, so a containing-block regression wouldn't show up as a visible
 * failure — only as the dialog no longer being a body-level node).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { Modal } from './Modal';
import '../i18n/register';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
});

describe('Modal', () => {
  it('portals its dialog to document.body instead of rendering inline at the call site', () => {
    const { container } = render(
      // Stands in for a real caller nested under <header>'s backdrop-blur
      // (HistoryButton/ShareButton) — the exact ancestor shape doesn't
      // matter here since createPortal bypasses ANY ancestor unconditionally;
      // this is just "some wrapper the dialog must escape".
      <div data-testid="caller-subtree">
        <Modal title="Heading" onClose={vi.fn()}>
          <p>Content</p>
        </Modal>
      </div>,
    );

    expect(container.querySelector('[role="dialog"]')).toBeNull();

    const dialog = screen.getByRole('dialog');
    // Portal target is document.body directly; the dialog itself is one
    // level deeper, inside Modal's own backdrop div.
    expect(dialog.parentElement?.parentElement).toBe(document.body);
  });

  it('still closes on Escape and on a backdrop click once portaled', () => {
    const onClose = vi.fn();
    render(
      <Modal title="Heading" onClose={onClose}>
        <p>Content</p>
      </Modal>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    const dialog = screen.getByRole('dialog');
    // The backdrop is the dialog's own parent (see the portal-depth check above).
    fireEvent.click(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
