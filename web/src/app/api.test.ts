/**
 * Transient-503 fix — a PaaS redeploy briefly 502/503/504s every request
 * while the container restarts (~30-60s window). GET/PUT/DELETE (idempotent)
 * should ride that out via retry inside request(); POST must not (a retried
 * POST could create a duplicate), so it surfaces the ApiError immediately.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, shouldRetry } from './api';
import { resetConnectivityForTests } from './offline/connectivity';

function jsonResponse(status: number, body: unknown, statusText = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  } as Response;
}

describe('shouldRetry', () => {
  it('flags only the transient-proxy statuses', () => {
    expect(shouldRetry(502)).toBe(true);
    expect(shouldRetry(503)).toBe(true);
    expect(shouldRetry(504)).toBe(true);
    expect(shouldRetry(500)).toBe(false);
    expect(shouldRetry(404)).toBe(false);
  });
});

describe('request retry (transient 502/503/504 during a redeploy)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries a GET after a 503 and returns the data once it succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, {}, 'Service Unavailable'))
      .mockResolvedValueOnce(jsonResponse(200, { defaultRepoUrl: 'https://example.com' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.getConfig();

    expect(result).toEqual({ defaultRepoUrl: 'https://example.com' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry into a connection that is known to be down — the answer is already known', async () => {
    resetConnectivityForTests({ state: 'offline' });
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getConfig()).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resetConnectivityForTests();
  });

  it('does not retry a POST on 503 — throws ApiError immediately', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503, { error: 'temporarily unavailable' }, 'Service Unavailable'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.login('a@example.com', 'pw')).rejects.toThrow(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
