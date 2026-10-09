// @vitest-environment jsdom
/** History of a pdf/office page: a version shows the file as it was (name, size, download, pdf preview) and can be restored. */
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import { ToastProvider } from '../ui/Toast';
import { HistoryPanel, formatFileSize } from './HistoryPanel';
import '../i18n/register';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

const HISTORY = [
  { sha: 'bbbbbbb1', author: 'Ann', date: new Date().toISOString(), message: 'files: replace deck.pdf' },
  { sha: 'aaaaaaa1', author: 'Bob', date: new Date().toISOString(), message: 'folio:update' },
];

function stub(): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      const ok = (json: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(json) });
      if (url.endsWith('/history')) return ok({ history: HISTORY });
      if (url.endsWith('/history/bbbbbbb1')) return ok({ file: { path: 'deck.pdf', ext: '.pdf', size: 2048 } });
      if (url.endsWith('/history/aaaaaaa1')) return ok({ file: { path: 'folder/deck.pptx', ext: '.pptx', size: 3 * 1024 * 1024 } });
      return ok({ id: 'deck1' });
    }),
  );
  return calls;
}

describe('HistoryPanel for a file page', () => {
  it('describes the version, links the exact file, previews a pdf, and restores an older one', async () => {
    const calls = stub();
    const { container } = render(
      <Wrapper>
        <HistoryPanel pageId="deck1" space="sp" pagePath="deck.pdf" canRestore onClose={() => {}} />
      </Wrapper>,
    );

    // Newest version is selected first: a pdf, previewed in a frame.
    await screen.findByText('File name at that time: deck.pdf');
    expect(screen.getByText('File size: 2 KB')).toBeTruthy();
    expect(container.ownerDocument.querySelector('iframe')?.getAttribute('src')).toBe('/api/pages/deck1/history/bbbbbbb1/file');
    expect(screen.getByText('Download this version').getAttribute('href')).toBe('/api/pages/deck1/history/bbbbbbb1/file?download=1');

    // The older one was a .pptx: no frame, the name at that time, restorable.
    fireEvent.click(screen.getByText('Bob'));
    await screen.findByText('File name at that time: deck.pptx');
    expect(screen.getByText('File size: 3.0 MB')).toBeTruthy();
    expect(container.ownerDocument.querySelector('iframe')).toBeNull();

    fireEvent.click(screen.getByText('Restore this version'));
    fireEvent.click(await screen.findByText('Restore'));
    await waitFor(() => expect(calls).toContain('POST /api/pages/deck1/restore/aaaaaaa1'));
  });

  it('hides Restore from a viewer', async () => {
    stub();
    render(
      <Wrapper>
        <HistoryPanel pageId="deck1" space="sp" pagePath="deck.pdf" canRestore={false} onClose={() => {}} />
      </Wrapper>,
    );
    await screen.findByText('File name at that time: deck.pdf');
    expect(screen.queryByText('Restore this version')).toBeNull();
  });

  it('formats sizes for people', () => {
    expect(formatFileSize(10)).toBe('10 B');
    expect(formatFileSize(1536)).toBe('2 KB');
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
