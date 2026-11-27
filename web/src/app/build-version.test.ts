// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { entryNameOf, fetchLatestBundleId, isStaleBuild, loadedBundleId } from './build-version';

afterEach(() => vi.restoreAllMocks());

describe('entryNameOf', () => {
  it('reads the entry name from a script address or a manifest path', () => {
    expect(entryNameOf('/assets/index-5T0Qpva8.js')).toBe('index-5T0Qpva8.js');
    expect(entryNameOf('assets/index-5T0Qpva8.js')).toBe('index-5T0Qpva8.js');
    expect(entryNameOf('https://x.example/assets/index-C25_wABs.js?v=1')).toBe('index-C25_wABs.js');
  });
  it('ignores chunks, the dev entry and other files', () => {
    expect(entryNameOf('/assets/TableGrid-abc12345.js')).toBeNull();
    expect(entryNameOf('/src/main.tsx')).toBeNull();
    expect(entryNameOf('/assets/index-abc.css')).toBeNull();
  });
});

describe('loadedBundleId', () => {
  it('finds the entry module script in the document', () => {
    const doc = new DOMParser().parseFromString(
      '<html><head><script type="module" crossorigin src="/assets/index-AAAA1111.js"></script></head><body></body></html>',
      'text/html',
    );
    expect(loadedBundleId(doc)).toBe('index-AAAA1111.js');
  });
  it('is null without a built entry (development)', () => {
    const doc = new DOMParser().parseFromString('<script type="module" src="/src/main.tsx"></script>', 'text/html');
    expect(loadedBundleId(doc)).toBeNull();
  });
});

describe('fetchLatestBundleId', () => {
  const respond = (body: unknown, init: { ok?: boolean; type?: string } = {}) =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: init.ok ?? true,
      headers: new Headers({ 'content-type': init.type ?? 'application/json' }),
      json: async () => body,
    } as Response);

  it('returns the entry the manifest names', async () => {
    respond({ 'offline.html': { file: 'assets/offline-ABCD1234.js', isEntry: true }, 'index.html': { file: 'assets/index-BBBB2222.js', isEntry: true }, 'x.ts': { file: 'assets/x-abc12345.js' } });
    expect(await fetchLatestBundleId()).toBe('index-BBBB2222.js');
  });
  it('is null for html (the SPA answering), an error status or a failed request', async () => {
    respond('<html>', { type: 'text/html' });
    expect(await fetchLatestBundleId()).toBeNull();
    respond({}, { ok: false });
    expect(await fetchLatestBundleId()).toBeNull();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
    expect(await fetchLatestBundleId()).toBeNull();
  });
});

describe('isStaleBuild', () => {
  it('needs both known and different', () => {
    expect(isStaleBuild('index-a.js', 'index-b.js')).toBe(true);
    expect(isStaleBuild('index-a.js', 'index-a.js')).toBe(false);
    expect(isStaleBuild(null, 'index-b.js')).toBe(false);
    expect(isStaleBuild('index-a.js', null)).toBe(false);
  });
});
