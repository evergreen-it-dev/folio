// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import i18next from 'i18next';
import { BoardExportMenu } from './BoardExportMenu';
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

function mount(overrides: Partial<Parameters<typeof BoardExportMenu>[0]> = {}) {
  const onExportPng = overrides.onExportPng ?? vi.fn(async () => {});
  const onExportSvg = overrides.onExportSvg ?? vi.fn(async () => {});
  const onCopyToClipboard = overrides.onCopyToClipboard ?? vi.fn(async () => {});

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  activeRoots.push({ root, container });
  act(() => {
    root.render(
      <BoardExportMenu
        {...overrides}
        onExportPng={onExportPng}
        onExportSvg={onExportSvg}
        onCopyToClipboard={onCopyToClipboard}
      />,
    );
  });
  return { container, onExportPng, onExportSvg, onCopyToClipboard };
}

function triggerButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement;
}

function menuPanel(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[role="menu"]');
}

function menuItem(container: HTMLElement, label: string): HTMLButtonElement {
  const items = Array.from(container.querySelectorAll('[role="menuitem"]')) as HTMLButtonElement[];
  const found = items.find((el) => el.textContent?.includes(label));
  if (!found) throw new Error(`menu item "${label}" not found`);
  return found;
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('BoardExportMenu', () => {
  it('renders the trigger closed, labeled "Export", with no menu visible', () => {
    const { container } = mount();
    expect(triggerButton(container).textContent).toContain('Export');
    expect(menuPanel(container)).toBeNull();
  });

  it('opens the menu with PNG, SVG, and copy-to-clipboard options on click', () => {
    const { container } = mount();
    act(() => triggerButton(container).click());
    const panel = menuPanel(container);
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('PNG');
    expect(panel?.textContent).toContain('SVG');
    expect(panel?.textContent).toContain('Copy to clipboard');
  });

  it('clicking PNG calls onExportPng and closes the menu once it resolves', async () => {
    const { container, onExportPng } = mount();
    act(() => triggerButton(container).click());
    await act(async () => {
      menuItem(container, 'PNG').click();
      await flush();
    });
    expect(onExportPng).toHaveBeenCalledTimes(1);
    expect(menuPanel(container)).toBeNull();
  });

  it('clicking SVG calls onExportSvg and closes the menu once it resolves', async () => {
    const { container, onExportSvg } = mount();
    act(() => triggerButton(container).click());
    await act(async () => {
      menuItem(container, 'SVG').click();
      await flush();
    });
    expect(onExportSvg).toHaveBeenCalledTimes(1);
    expect(menuPanel(container)).toBeNull();
  });

  it('clicking "copy to clipboard" calls onCopyToClipboard and keeps the menu open, showing "Copied"', async () => {
    const { container, onCopyToClipboard } = mount();
    act(() => triggerButton(container).click());
    await act(async () => {
      menuItem(container, 'Copy to clipboard').click();
      await flush();
    });
    expect(onCopyToClipboard).toHaveBeenCalledTimes(1);
    expect(menuPanel(container)).not.toBeNull();
    expect(menuPanel(container)?.textContent).toContain('Copied');
  });

  it('surfaces a visible failure instead of swallowing it silently when an export rejects', async () => {
    const onExportPng = vi.fn(async () => {
      throw new Error('createWritable rejected');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = mount({ onExportPng });

    act(() => triggerButton(container).click());
    await act(async () => {
      menuItem(container, 'PNG').click();
      await flush();
    });

    expect(menuPanel(container)?.textContent).toContain('Export failed');
    vi.restoreAllMocks();
  });

  it('disables the menu items while an export is pending', async () => {
    let resolveExport: () => void = () => {};
    const onExportPng = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveExport = resolve;
        }),
    );
    const { container } = mount({ onExportPng });
    act(() => triggerButton(container).click());

    act(() => {
      menuItem(container, 'PNG').click();
    });
    expect(menuItem(container, 'SVG').disabled).toBe(true);

    await act(async () => {
      resolveExport();
      await flush();
    });
  });

  it('closes the menu when Escape is pressed', () => {
    const { container } = mount();
    act(() => triggerButton(container).click());
    expect(menuPanel(container)).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(menuPanel(container)).toBeNull();
  });

  it('closes the menu when clicking outside it', () => {
    const { container } = mount();
    act(() => triggerButton(container).click());
    expect(menuPanel(container)).not.toBeNull();

    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(menuPanel(container)).toBeNull();
  });
});

/**
 * Round 25b-1 §1 (owner, from a real iPhone): "Our row 'Export | View | Edit'
 * takes the whole width… NEEDED: below md collapse the WHOLE row into ONE
 * icon button in the corner that opens a menu (Export PNG/SVG/clipboard +
 * the mode switch). No text in the button."
 */
describe('BoardExportMenu — compact (<md) shape', () => {
  it('has no text in the trigger at all, only an accessible name', () => {
    const { container } = mount({ compact: true });
    const trigger = triggerButton(container);
    expect(trigger.textContent).toBe('');
    expect(trigger.getAttribute('aria-label')).toBe('Board menu');
    expect(trigger.querySelector('svg')).not.toBeNull();
  });

  it('keeps the labelled "Export" trigger on desktop', () => {
    const { container } = mount();
    expect(triggerButton(container).textContent).toContain('Export');
    expect(triggerButton(container).getAttribute('aria-label')).toBeNull();
  });

  it('folds fit-to-screen into the menu and closes after invoking it', () => {
    const onFitToScreen = vi.fn();
    const { container } = mount({ compact: true, onFitToScreen });
    act(() => triggerButton(container).click());

    act(() => menuItem(container, 'Fit to screen').click());

    expect(onFitToScreen).toHaveBeenCalledTimes(1);
    expect(menuPanel(container)).toBeNull();
  });

  it('still offers all three export actions alongside it', () => {
    const { container } = mount({ compact: true, onFitToScreen: vi.fn() });
    act(() => triggerButton(container).click());
    expect(menuItem(container, 'PNG')).not.toBeNull();
    expect(menuItem(container, 'SVG')).not.toBeNull();
    expect(menuItem(container, 'Copy to clipboard')).not.toBeNull();
  });

  it('folds the View/Edit switch into the menu, marking the active one', () => {
    const onSelectMode = vi.fn();
    const { container } = mount({ compact: true, mode: 'view', onSelectMode });
    act(() => triggerButton(container).click());

    const options = Array.from(container.querySelectorAll('[role="menuitemradio"]')) as HTMLButtonElement[];
    expect(options.map((el) => el.textContent)).toEqual(['View', 'Edit']);
    expect(options.map((el) => el.getAttribute('aria-checked'))).toEqual(['true', 'false']);

    act(() => options[1].click());
    expect(onSelectMode).toHaveBeenCalledWith('edit');
    expect(menuPanel(container)).toBeNull();
  });

  it('shows no mode switch for a non-editable load (no onSelectMode) — same rule as the desktop toggle', () => {
    const { container } = mount({ compact: true, mode: 'view', onFitToScreen: vi.fn() });
    act(() => triggerButton(container).click());
    expect(container.querySelectorAll('[role="menuitemradio"]')).toHaveLength(0);
    // the export actions are still there — exporting never needed edit rights
    expect(menuItem(container, 'PNG')).not.toBeNull();
  });

  it('ignores the compact-only extras on desktop, where those controls are separate buttons', () => {
    const onFitToScreen = vi.fn();
    const onSelectMode = vi.fn();
    const { container } = mount({ onFitToScreen, mode: 'view', onSelectMode });
    act(() => triggerButton(container).click());
    expect(container.querySelectorAll('[role="menuitemradio"]')).toHaveLength(0);
    expect(() => menuItem(container, 'Fit to screen')).toThrow();
  });
});
