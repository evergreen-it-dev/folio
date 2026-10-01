import { describe, expect, it } from 'vitest';
import { getBoardEndpoints } from './boardEndpoints';

describe('getBoardEndpoints', () => {
  it('uses the authenticated per-page routes when there is no share token', () => {
    expect(getBoardEndpoints({ pageId: 'abc123' })).toEqual({
      loadUrl: '/api/pages/abc123',
      saveUrl: '/api/pages/abc123',
    });
  });

  it('uses the public per-token share routes when a share token is given', () => {
    expect(getBoardEndpoints({ pageId: 'abc123', shareToken: 'tok_xyz' })).toEqual({
      loadUrl: '/api/share/tok_xyz',
      saveUrl: '/api/share/tok_xyz/board',
    });
  });

  it('prefers the share token over pageId even when both are present', () => {
    const { loadUrl, saveUrl } = getBoardEndpoints({ pageId: 'abc123', shareToken: 'tok_xyz' });
    expect(loadUrl).not.toContain('abc123');
    expect(saveUrl).not.toContain('abc123');
  });

  it('falls back to the per-page routes for an empty-string share token', () => {
    // A caller that doesn't have a token yet (e.g. mid-resolve) should get
    // the normal path, not a request to /api/share/ with nothing after it.
    expect(getBoardEndpoints({ pageId: 'abc123', shareToken: '' })).toEqual({
      loadUrl: '/api/pages/abc123',
      saveUrl: '/api/pages/abc123',
    });
  });

  it('the share save URL is a distinct path from the load URL, unlike the normal pair', () => {
    const normal = getBoardEndpoints({ pageId: 'abc123' });
    expect(normal.loadUrl).toBe(normal.saveUrl);

    const shared = getBoardEndpoints({ pageId: 'abc123', shareToken: 'tok_xyz' });
    expect(shared.loadUrl).not.toBe(shared.saveUrl);
  });

  it('URL-encodes tokens and ids that need it', () => {
    expect(getBoardEndpoints({ pageId: 'a/b c' })).toEqual({
      loadUrl: '/api/pages/a%2Fb%20c',
      saveUrl: '/api/pages/a%2Fb%20c',
    });
    expect(getBoardEndpoints({ pageId: 'x', shareToken: 'tok/with spaces' })).toEqual({
      loadUrl: '/api/share/tok%2Fwith%20spaces',
      saveUrl: '/api/share/tok%2Fwith%20spaces/board',
    });
  });
});
