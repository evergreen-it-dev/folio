// @vitest-environment jsdom
/**
 * Round 23 (EXPORT), SHELL half — the "Export" page menu.
 *
 * The bar this menu is held to comes from diagrams/BoardExportMenu.tsx, which
 * exists because an export that fails silently already cost this product once:
 * every outcome must be visible in the UI. So the cases below are deliberately
 * the ones where "looks like it worked" is the wrong answer — a 200 whose body
 * the server truncated, and a PDF the host cannot render at all.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { ExportMenu } from './ExportMenu';

// jsdom implements neither URL.createObjectURL nor a real download, and the
// save-to-disk step is diagrams/download.ts's already-tested job — mocked here
// so these tests can assert WHAT would be saved, and under which name.
vi.mock('../../diagrams/download', () => ({ downloadBlob: vi.fn() }));
const { downloadBlob } = await import('../../diagrams/download');

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(downloadBlob).mockClear();
});

interface StubOptions {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
}

function exportResponse({ status = 200, headers = {}, json }: StubOptions = {}) {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    blob: () => Promise.resolve(new Blob(['# exported'])),
    json: () => (json === undefined ? Promise.reject(new Error('not json')) : Promise.resolve(json)),
  };
}

function stubFetch(options?: StubOptions) {
  const fetchMock = vi.fn().mockResolvedValue(exportResponse(options));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const CLEAN = { headers: { 'X-Folio-Export-Truncated': 'false', 'X-Folio-Export-Pages': '1' } };

function open(props: { pageId?: string; pagePath?: string; title?: string; table?: import('./ExportMenu').ExportMenuTableInfo } = {}) {
  render(<ExportMenu pageId={props.pageId ?? 'p1'} pagePath={props.pagePath} title={props.title} table={props.table} />);
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
}

/** The menu panel is portaled to document.body, so `screen` (not the render container) is what sees it. */
function item(label: string) {
  return screen.getByRole('menuitem', { name: label });
}

describe('ExportMenu — requesting the right export', () => {
  it('asks each format for its own endpoint', async () => {
    const fetchMock = stubFetch(CLEAN);
    open();

    fireEvent.click(item('Markdown (.md)'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/pages/p1/export.md'));

    // A clean export closes the panel (the browser's download is the
    // confirmation) — reopen for the next format.
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(item('PDF (.pdf)'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/pages/p1/export.pdf'));

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(item('Word (.docx)'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/pages/p1/export.docx'));

    // Owner follow-up: YAML alongside MD/PDF/DOCX, with its own endpoint.
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(item('YAML (.yaml)'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/pages/p1/export.yaml'));
  });

  it('passes children=1 only once "Include child pages" is ticked', async () => {
    const fetchMock = stubFetch(CLEAN);
    open();

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(item('Markdown (.md)'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/pages/p1/export.md?children=1'));
  });

  // R23 tail: the table view picker.
  it('on a table page, sends the CURRENT view as ?view= even when no selector is shown (single view)', async () => {
    const fetchMock = stubFetch(CLEAN);
    open({ table: { activeViewId: 'view-main', views: [{ id: 'view-main', name: 'All' }] } });

    // One view — nothing to choose, so no selector in the panel...
    expect(screen.queryByRole('combobox')).toBeNull();

    fireEvent.click(item('Markdown (.md)'));
    // ...but the URL still names the view: the server's own no-param default
    // (its first view) is not necessarily what the user is looking at.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/pages/p1/export.md?view=view-main'));
  });

  it('with several views, shows a selector defaulting to the active view, and exports the chosen one', async () => {
    const fetchMock = stubFetch(CLEAN);
    const table = {
      activeViewId: 'view-b',
      views: [
        { id: 'view-a', name: 'All' },
        { id: 'view-b', name: 'Only mine' },
      ],
    };
    open({ table });

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('view-b'); // defaults to what the grid shows

    fireEvent.click(item('Markdown (.md)'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/pages/p1/export.md?view=view-b'));

    // Reopen (clean export closed the panel), pick the other view, combine with children.
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'view-a' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(item('Word (.docx)'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/pages/p1/export.docx?children=1&view=view-a'));
  });

  it('never sends ?view= for a non-table page', async () => {
    const fetchMock = stubFetch(CLEAN);
    open();
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(item('Markdown (.md)'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/pages/p1/export.md'));
  });

  it('saves the blob under the name the response asked for', async () => {
    stubFetch({ headers: { ...CLEAN.headers, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('résumé.md')}` } });
    open();

    fireEvent.click(item('Markdown (.md)'));

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(downloadBlob).mock.calls[0][1]).toBe('résumé.md');
  });

  it('falls back to the page path for the filename when the response carries no Content-Disposition', async () => {
    stubFetch(CLEAN);
    open({ pagePath: 'notes/plan.md', title: 'Plan' });

    fireEvent.click(item('Word (.docx)'));

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(downloadBlob).mock.calls[0][1]).toBe('plan.docx');
  });
});

describe('ExportMenu — outcomes that must never look like a clean success', () => {
  it('warns on a truncated 200, keeps the panel open, and still saves the partial file', async () => {
    stubFetch({
      headers: {
        'X-Folio-Export-Truncated': 'pages',
        'X-Folio-Export-Pages': '200',
        'X-Folio-Export-Truncation-Detail': 'stopped after 200 pages',
      },
    });
    open();

    fireEvent.click(item('Markdown (.md)'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The document was truncated');
    expect(alert.textContent).toContain('the page limit was exceeded');
    // The page count from the header reaches the copy (and is NOT swallowed by
    // i18next's plural handling — it is interpolated as `pages`, not `count`).
    expect(alert.textContent).toContain('200');
    // The server's own English detail stays available without being shown as UI copy.
    expect(alert.getAttribute('title')).toBe('stopped after 200 pages');

    // The file is real and worth keeping — it is truncated, not failed.
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    // Panel stays open, otherwise the warning would flash and vanish.
    expect(screen.queryByRole('menuitem', { name: 'Markdown (.md)' })).not.toBeNull();
  });

  it('shows the chromium-specific message for an unavailable PDF, not a generic failure', async () => {
    // The status server/export/routes.ts actually returns today: badRequest -> 400.
    stubFetch({ status: 400, json: { error: 'PDF export is unavailable: no chromium executable found (set CHROMIUM_PATH)' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    open();

    fireEvent.click(item('PDF (.pdf)'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('PDF export is unavailable');
    expect(alert.textContent).toContain('no chromium');
    // The remedy ("Markdown and DOCX still work") must be part of it.
    expect(alert.textContent).toContain('Markdown and DOCX still work');
    expect(alert.textContent).not.toContain('Could not export the page');
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('also recognises the chromium case if the route is ever moved to a 503', async () => {
    stubFetch({ status: 503, json: { error: 'Service Unavailable' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    open();

    fireEvent.click(item('PDF (.pdf)'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('PDF export is unavailable');
  });

  it('surfaces an unrelated failure rather than swallowing it — localized, not the raw English (QA-3 #9)', async () => {
    stubFetch({ status: 403, json: { error: 'insufficient role' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    open();

    fireEvent.click(item('Markdown (.md)'));

    const alert = await screen.findByRole('alert');
    // errorText.ts turns a 403 with no more specific wording into the generic
    // permission message for the current UI language; the raw server string
    // must not appear on top of a Russian/Ukrainian UI. It still reaches the
    // console — see the next test.
    expect(alert.textContent).toContain("You don't have permission");
    expect(alert.textContent).not.toContain('insufficient role');
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('logs the failure to the console too, so a support screenshot carries the real cause', async () => {
    stubFetch({ status: 500, json: { error: 'boom' } });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    open();

    fireEvent.click(item('Markdown (.md)'));

    await screen.findByRole('alert');
    expect(consoleError).toHaveBeenCalledWith('page export (md) failed', expect.anything());
  });

  it('clears a previous warning when the panel is reopened', async () => {
    stubFetch({ headers: { 'X-Folio-Export-Truncated': 'bytes', 'X-Folio-Export-Pages': '12' } });
    open();

    fireEvent.click(item('Markdown (.md)'));
    await screen.findByRole('alert');

    // Close (Escape) and reopen — a stale warning from a past export must not
    // still be sitting there describing a download that is no longer happening.
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    expect(screen.queryByRole('alert')).toBeNull();
  });
});
