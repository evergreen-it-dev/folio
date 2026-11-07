// @vitest-environment jsdom
/**
 * The header's «⋯» menu (07.11.2026): rows per page kind, and the two things
 * that must outlive the menu closing — the surface a row opens (owned by the
 * caller) and the hidden file input of «Replace with new version…».
 */
import { createRef } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import { ToastProvider } from '../ui/Toast';
import { PageActionsMenu, type PageActionsMenuProps } from './PageActionsMenu';
import '../i18n/register';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderMenu(overrides: Partial<PageActionsMenuProps> = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response));
  const onOpen = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <PageActionsMenu
            anchorRef={createRef<HTMLDivElement>()}
            space="team"
            pageId="p1"
            pagePath="doc.md"
            title="Doc"
            isTable={false}
            fileActions={false}
            isProse
            canEdit
            canStartTimer
            onOpen={onOpen}
            {...overrides}
          />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  const rows = () => [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((el) => el.textContent);
  return { onOpen, rows };
}

describe('PageActionsMenu', () => {
  it('a document page: labelled rows, and a surface row closes the menu and asks the header to open it', () => {
    const { onOpen, rows } = renderMenu();
    expect(rows()).toEqual(['Share', 'Star this page', 'History', 'Export…', 'Page access…', 'Compare side by side', 'Start a timer…']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export…' }));
    expect(onOpen).toHaveBeenCalledWith('export');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a table page offers «Create a form» to an editor only', () => {
    expect(renderMenu({ isTable: true, isProse: false }).rows()).toContain('Create a form');
    cleanup();
    expect(renderMenu({ isTable: true, isProse: false, canEdit: false }).rows()).not.toContain('Create a form');
  });

  it('a file page: open / download / replace instead of Export, and the file input outlives the menu', () => {
    const { rows } = renderMenu({ fileActions: true, isProse: false });
    expect(rows()).toEqual(['Share', 'Star this page', 'History', 'Page access…', 'Compare side by side', 'Open in a new tab', 'Download', 'Replace with new version…', 'Start a timer…']);
    const input = screen.getByTestId('replace-file-input') as HTMLInputElement;
    const picker = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Replace with new version…' }));
    expect(picker).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByTestId('replace-file-input')).toBe(input);
  });

  it('a folder listing (no page): only the space timer', () => {
    expect(renderMenu({ pageId: undefined, pagePath: undefined, title: undefined }).rows()).toEqual(['Start a timer…']);
  });
});
