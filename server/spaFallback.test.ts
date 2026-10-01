import { describe, expect, it } from 'vitest';
import { shouldServeSpaFallback, isContentHashedAsset, spaCacheControl } from './spaFallback.js';

/**
 * A stale browser tab requesting a hashed chunk that no longer exists after
 * a deploy must get a real 404 (so web/src/app/stale-chunk.ts can detect it
 * and recover), not index.html with a 200 — see spaFallback.ts's doc
 * comment for the full story.
 */
describe('shouldServeSpaFallback', () => {
  it('falls back for an ordinary client-side route', () => {
    expect(shouldServeSpaFallback('GET', '/s/sk-space/p/01M8Z9')).toBe(true);
    expect(shouldServeSpaFallback('GET', '/')).toBe(true);
  });

  it('does NOT fall back for a missing hashed asset — the prod bug', () => {
    expect(shouldServeSpaFallback('GET', '/assets/sequenceDiagram-WJ2MYXX4-oldhash.js')).toBe(false);
    expect(shouldServeSpaFallback('GET', '/assets/nope.js')).toBe(false);
  });

  it('does not fall back for the existing server-route prefixes', () => {
    expect(shouldServeSpaFallback('GET', '/api/health')).toBe(false);
    expect(shouldServeSpaFallback('GET', '/files/some-space/x.png')).toBe(false);
    expect(shouldServeSpaFallback('GET', '/a/deadbeef/file.pdf')).toBe(false);
    expect(shouldServeSpaFallback('GET', '/collab')).toBe(false);
  });

  it('never falls back for a non-GET method, even on an SPA-looking path', () => {
    expect(shouldServeSpaFallback('POST', '/s/sk-space/p/01M8Z9')).toBe(false);
  });
});

describe('spaCacheControl', () => {
  it('caches content-hashed chunks and assets for good', () => {
    for (const file of ['/app/web/dist/assets/index-C25_wABs.js', '/app/web/dist/assets/BoardCanvas-DtRVLazd.css', '/app/web/dist/assets/Assistant-Bold-gm-uSS1B.woff2', 'assets/docx_parser_bg-C1Wf3n7F.wasm']) {
      expect(isContentHashedAsset(file), file).toBe(true);
      expect(spaCacheControl(file)).toBe('public, max-age=31536000, immutable');
    }
  });

  it('revalidates what keeps its name across deploys', () => {
    for (const file of ['/app/web/dist/index.html', '/app/web/dist/assets/manifest.json', '/app/web/dist/favicon.svg']) {
      expect(isContentHashedAsset(file), file).toBe(false);
      expect(spaCacheControl(file)).toBe('no-cache');
    }
  });
});
