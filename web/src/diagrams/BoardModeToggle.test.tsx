// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import i18next from 'i18next';
import { BoardModeToggle } from './BoardModeToggle';
import type { BoardMode } from './boardMode';
import './i18n/register';

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await i18next.changeLanguage('en');
});

const activeRoots: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of activeRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function mount(mode: BoardMode, onSelect: (mode: BoardMode) => void) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  activeRoots.push({ root, container });
  act(() => {
    root.render(<BoardModeToggle mode={mode} onSelect={onSelect} />);
  });
  return container;
}

function buttons(container: HTMLElement) {
  return Array.from(container.querySelectorAll('button'));
}

describe('BoardModeToggle', () => {
  it('renders both options labeled ("View" / "Edit"), view first', () => {
    const container = mount('view', () => {});
    const labels = buttons(container).map((b) => b.textContent);
    expect(labels).toEqual(['View', 'Edit']);
  });

  it('marks only the active mode as aria-pressed=true', () => {
    const container = mount('view', () => {});
    const [viewBtn, editBtn] = buttons(container);
    expect(viewBtn.getAttribute('aria-pressed')).toBe('true');
    expect(editBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('flips aria-pressed when mounted in "edit" mode instead', () => {
    const container = mount('edit', () => {});
    const [viewBtn, editBtn] = buttons(container);
    expect(viewBtn.getAttribute('aria-pressed')).toBe('false');
    expect(editBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('calls onSelect with "edit" when the edit button is clicked', () => {
    const onSelect = vi.fn();
    const container = mount('view', onSelect);
    const [, editBtn] = buttons(container);
    act(() => editBtn.click());
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('edit');
  });

  it('calls onSelect with "view" when the view button is clicked from edit mode', () => {
    const onSelect = vi.fn();
    const container = mount('edit', onSelect);
    const [viewBtn] = buttons(container);
    act(() => viewBtn.click());
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('view');
  });

  it('exposes a group role with an aria-label for the pair', () => {
    const container = mount('view', () => {});
    const group = container.querySelector('[role="group"]');
    expect(group).not.toBeNull();
    expect(group?.getAttribute('aria-label')).toBe('Board mode');
  });
});
