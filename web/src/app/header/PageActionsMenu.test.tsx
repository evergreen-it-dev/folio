// @vitest-environment jsdom
/**
 * The header's «⋯» menu (07.11.2026): rows per page kind, and the two things
 * that must outlive the menu closing — the surface a row opens (owned by the
 * caller) and the hidden file input of «Replace with new version…».
 */
import { createRef } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { hasOfflineDocument, removeOfflineDocument } from '../offline/savedDocuments';
import { saveDocumentForOfflineReading } from '../offline/readerAccess';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import { ToastProvider } from '../ui/Toast';
import { PageActionsMenu, type PageActionsMenuProps } from './PageActionsMenu';
import '../i18n/register';

vi.mock('../offline/savedDocuments', () => ({
  hasOfflineDocument: vi.fn(), removeOfflineDocument: vi.fn(), subscribeOfflineDocuments: () => () => {},
}));
vi.mock('../offline/readerAccess', () => ({ saveDocumentForOfflineReading: vi.fn() }));

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function renderMenu(overrides: Partial<PageActionsMenuProps> = {}, account?: string) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ spaces: [], pages: [] }) }) as unknown as Response));
  const onOpen = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (account) queryClient.setQueryData(['auth', 'state'], { user: { id: account } });
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

  it('saves only after confirming an offline copy on the device and lets the user remove it', async () => {
    vi.stubEnv('PROD', true);
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('indexedDB', {});
    vi.stubGlobal('navigator', { serviceWorker: {}, userAgent: navigator.userAgent });
    vi.mocked(hasOfflineDocument).mockResolvedValue(false);
    renderMenu({ canSaveOffline: true }, 'alice');
    const save = screen.getByRole('menuitem', { name: 'Save for offline reading…' });
    await waitFor(() => expect(save.getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(save);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(saveDocumentForOfflineReading).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog').textContent).toContain('trusted device');
    fireEvent.click(screen.getByRole('button', { name: 'Save on this device' }));
    await screen.findByText('Saved for offline reading.');
    expect(saveDocumentForOfflineReading).toHaveBeenCalledWith('alice', 'p1', 'team');

    vi.mocked(hasOfflineDocument).mockResolvedValue(true);
    vi.mocked(removeOfflineDocument).mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove offline copy' }));
    await screen.findByText('Offline copy removed.');
    expect(removeOfflineDocument).toHaveBeenCalledWith('alice', 'p1');
  });

  it.each([
    { production: false, secure: true, worker: true },
    { production: true, secure: false, worker: true },
    { production: true, secure: true, worker: false },
  ])('only offers removal when registration is unavailable (production=$production, secure=$secure, worker=$worker)', async ({ production, secure, worker }) => {
    vi.stubEnv('PROD', production);
    vi.stubGlobal('isSecureContext', secure);
    vi.stubGlobal('indexedDB', {});
    vi.stubGlobal('navigator', worker ? { serviceWorker: {}, userAgent: navigator.userAgent } : { userAgent: navigator.userAgent });
    vi.mocked(hasOfflineDocument).mockResolvedValue(false);
    renderMenu({ canSaveOffline: true }, 'alice');
    expect(screen.queryByRole('menuitem', { name: 'Save for offline reading…' })).toBeNull();
    cleanup();
    vi.mocked(hasOfflineDocument).mockResolvedValue(true);
    renderMenu({ canSaveOffline: true }, 'alice');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove offline copy' }));
    await screen.findByText('Offline copy removed.');
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
