// @vitest-environment jsdom
/**
 * Round 23 (EXPORT), client half — the pure network/naming layer behind the
 * "Export" menu. The component test next to this one drives the UI;
 * this one pins the parts that are easy to get quietly wrong: which URL each
 * format asks for, how the truncation headers are read, what the download is
 * named, and how a failed PDF is classified.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, UNAUTHORIZED_EVENT } from '../api';
import {
  exportUrl,
  fallbackExportFilename,
  fetchPageExport,
  filenameFromDisposition,
  isChromiumUnavailable,
} from './pageExport';

interface StubOptions {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  json?: unknown;
}

/** Minimal Response stand-in: case-insensitive headers (like a real `Headers`), a blob, and an optional JSON error body. */
function exportResponse({ status = 200, headers = {}, body = '# hi', json }: StubOptions = {}) {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    blob: () => Promise.resolve(new Blob([body])),
    json: () => (json === undefined ? Promise.reject(new Error('not json')) : Promise.resolve(json)),
  };
}

function stubFetch(options?: StubOptions) {
  const fetchMock = vi.fn().mockResolvedValue(exportResponse(options));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('exportUrl', () => {
  it('builds the per-format endpoint and only adds ?children=1 when opted in', () => {
    expect(exportUrl('p1', 'md')).toBe('/api/pages/p1/export.md');
    expect(exportUrl('p1', 'pdf')).toBe('/api/pages/p1/export.pdf');
    expect(exportUrl('p1', 'docx')).toBe('/api/pages/p1/export.docx');

    expect(exportUrl('p1', 'md', { children: true })).toBe('/api/pages/p1/export.md?children=1');
    // Not opting in must leave the parameter off entirely rather than send
    // children=0 — the server already defaults it to false.
    expect(exportUrl('p1', 'md', { children: false })).toBe('/api/pages/p1/export.md');
  });

  it('encodes a page id that would otherwise break the path', () => {
    expect(exportUrl('a/b?c', 'md')).toBe('/api/pages/a%2Fb%3Fc/export.md');
  });

  // R23 tail: `?view=<id>` — the table view picker's half of the URL.
  it('adds ?view= only when a table view was picked, combines it with children, and encodes it', () => {
    expect(exportUrl('p1', 'md', { view: 'view-all' })).toBe('/api/pages/p1/export.md?view=view-all');
    expect(exportUrl('p1', 'pdf', { children: true, view: 'view-all' })).toBe('/api/pages/p1/export.pdf?children=1&view=view-all');
    expect(exportUrl('p1', 'md', { view: 'my view+1' })).toBe('/api/pages/p1/export.md?view=my+view%2B1');
    // No view picked (non-table page) — the parameter stays off entirely.
    expect(exportUrl('p1', 'md', { children: true })).toBe('/api/pages/p1/export.md?children=1');
  });
});

describe('filenameFromDisposition', () => {
  it('prefers the RFC 5987 filename* over the ASCII fallback (uk/ru titles survive only there)', () => {
    // Exactly the header shape server/export/routes.ts emits.
    const header = `attachment; filename="_____.md"; filename*=UTF-8''${encodeURIComponent('résumé.md')}`;
    expect(filenameFromDisposition(header)).toBe('résumé.md');
  });

  it('falls back to the quoted plain filename when there is no filename*', () => {
    expect(filenameFromDisposition('attachment; filename="plan.md"')).toBe('plan.md');
  });

  it('falls back to the plain filename when filename* is malformed rather than throwing', () => {
    expect(filenameFromDisposition(`attachment; filename="plan.md"; filename*=UTF-8''%E0%A4%A`)).toBe('plan.md');
  });

  it('returns null for an absent or unusable header', () => {
    expect(filenameFromDisposition(null)).toBeNull();
    expect(filenameFromDisposition('')).toBeNull();
    expect(filenameFromDisposition('attachment')).toBeNull();
  });
});

describe('fallbackExportFilename', () => {
  it("strips each page kind's own suffix, mirroring the server's slugOf", () => {
    expect(fallbackExportFilename({ path: 'notes/plan.md' }, 'md')).toBe('plan.md');
    expect(fallbackExportFilename({ path: 'notes/board.excalidraw.svg' }, 'pdf')).toBe('board.pdf');
    expect(fallbackExportFilename({ path: 'notes/budget.table.md' }, 'docx')).toBe('budget.docx');
  });

  it('falls back to a sanitized title, then to a fixed name', () => {
    expect(fallbackExportFilename({ title: 'My plan: a draft' }, 'md')).toBe('My plan- a draft.md');
    expect(fallbackExportFilename({}, 'md')).toBe('export.md');
  });
});

describe('isChromiumUnavailable', () => {
  it("matches the 400 the route actually raises today, by the server's own message", () => {
    // server/export/routes.ts raises this through badRequest(...) -> HTTP 400.
    const real = new ApiError(400, 'PDF export is unavailable: no chromium executable found (set CHROMIUM_PATH)');
    expect(isChromiumUnavailable(real)).toBe(true);
  });

  it('also matches a 503, so moving the route to that status will not silently break the copy', () => {
    expect(isChromiumUnavailable(new ApiError(503, 'Service Unavailable'))).toBe(true);
  });

  it('does not swallow unrelated failures', () => {
    expect(isChromiumUnavailable(new ApiError(403, 'insufficient role'))).toBe(false);
    expect(isChromiumUnavailable(new ApiError(500, 'boom'))).toBe(false);
    expect(isChromiumUnavailable(new Error('chromium'))).toBe(false);
  });
});

describe('fetchPageExport', () => {
  it('reports a clean export when X-Folio-Export-Truncated is false', async () => {
    stubFetch({
      headers: {
        'X-Folio-Export-Truncated': 'false',
        'X-Folio-Export-Pages': '3',
        'Content-Disposition': 'attachment; filename="plan.md"',
      },
    });

    const result = await fetchPageExport('p1', 'md');
    expect(result.truncation).toBeNull();
    expect(result.pageCount).toBe(3);
    expect(result.filename).toBe('plan.md');
  });

  it('surfaces a truncated 200 — the whole reason this goes through fetch and not <a download>', async () => {
    stubFetch({
      headers: {
        'X-Folio-Export-Truncated': 'pages',
        'X-Folio-Export-Truncation-Detail': 'stopped after 200 pages',
        'X-Folio-Export-Pages': '200',
      },
    });

    const result = await fetchPageExport('p1', 'md', { children: true });
    expect(result.truncation).toEqual({ reason: 'pages', detail: 'stopped after 200 pages' });
    expect(result.pageCount).toBe(200);
  });

  it('treats an unknown truncation reason as a truncation, not as clean', async () => {
    stubFetch({ headers: { 'X-Folio-Export-Truncated': 'something-new' } });
    const result = await fetchPageExport('p1', 'md');
    expect(result.truncation?.reason).toBe('something-new');
  });

  it('names the download from Content-Disposition, falling back to the page path when a proxy strips it', async () => {
    stubFetch({ headers: {} });
    const result = await fetchPageExport('p1', 'docx', {}, { path: 'notes/plan.md', title: 'Plan' });
    expect(result.filename).toBe('plan.docx');
  });

  it("throws an ApiError carrying the server's own error message on a non-2xx", async () => {
    stubFetch({ status: 400, json: { error: 'PDF export is unavailable: no chromium executable found (set CHROMIUM_PATH)' } });

    await expect(fetchPageExport('p1', 'pdf')).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      message: 'PDF export is unavailable: no chromium executable found (set CHROMIUM_PATH)',
    });
  });

  it('re-dispatches UNAUTHORIZED_EVENT on a 401, same contract as api.ts request()', async () => {
    stubFetch({ status: 401, json: { error: 'authentication required' } });
    const onUnauthorized = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);

    await expect(fetchPageExport('p1', 'md')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);

    window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  });

  it('survives a non-JSON error body instead of throwing over the parse', async () => {
    stubFetch({ status: 502 });
    await expect(fetchPageExport('p1', 'md')).rejects.toMatchObject({ status: 502, message: 'HTTP 502' });
  });
});

describe('fetchPageExport — requested URL per format', () => {
  let fetchMock: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    fetchMock = stubFetch({ headers: { 'X-Folio-Export-Truncated': 'false' } });
  });

  it('asks for each format at its own endpoint', async () => {
    await fetchPageExport('p1', 'md');
    await fetchPageExport('p1', 'pdf');
    await fetchPageExport('p1', 'docx');

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/pages/p1/export.md',
      '/api/pages/p1/export.pdf',
      '/api/pages/p1/export.docx',
    ]);
  });

  it('passes children=1 through to the request when asked', async () => {
    await fetchPageExport('p1', 'pdf', { children: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/pages/p1/export.pdf?children=1');
  });
});
