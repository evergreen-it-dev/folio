/** Optional analytics: inert unless FOLIO_POSTHOG_KEY is set; never sends content; best effort. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAnalyticsForTests, analyticsConfig, captureServerEvent, cleanVisitorId, clientNameProp, rememberVisitor, visitorFor } from './analytics.js';

function setEnv(key?: string, host?: string) {
  const set = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  set('FOLIO_POSTHOG_KEY', key);
  set('FOLIO_POSTHOG_HOST', host);
}

describe('server analytics', () => {
  beforeEach(() => {
    __resetAnalyticsForTests();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  });
  afterEach(() => {
    setEnv();
    vi.unstubAllGlobals();
  });

  it('is off without a key: no config, no visitor memory, no request', () => {
    setEnv();
    expect(analyticsConfig()).toBeUndefined();
    rememberVisitor('tok', 'visitor-12345678');
    expect(visitorFor('tok')).toBeNull();
    captureServerEvent('oauth_connect_started', 'tok', { client_name: 'x' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads the key and host; the host defaults to the US cloud and a bad host switches it off', () => {
    setEnv('phc_test', 'https://eu.i.posthog.com/');
    expect(analyticsConfig()).toEqual({ key: 'phc_test', host: 'https://eu.i.posthog.com' });
    setEnv('phc_test');
    expect(analyticsConfig()?.host).toBe('https://us.i.posthog.com');
    setEnv('phc_test', 'not a url');
    expect(analyticsConfig()).toBeUndefined();
    setEnv('phc_test', 'ftp://x.example');
    expect(analyticsConfig()).toBeUndefined();
  });

  it('sends an event with the remembered visitor id and no geolocation of the server', () => {
    setEnv('phc_test', 'https://eu.i.posthog.com');
    rememberVisitor('tok', '01a10fdf-134a-7692-9992-0db75ffa855a');
    captureServerEvent('oauth_connect_approved', 'tok', { client_name: 'Claude', write: true });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('https://eu.i.posthog.com/i/v0/e/');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({ api_key: 'phc_test', event: 'oauth_connect_approved', distinct_id: '01a10fdf-134a-7692-9992-0db75ffa855a' });
    expect(body.properties).toMatchObject({ client_name: 'Claude', write: true, $geoip_disable: true });
    expect(body.properties.$process_person_profile).toBe(false);
  });

  it('an unknown visitor goes out under a shared anonymous id', () => {
    setEnv('phc_test');
    captureServerEvent('oauth_connect_started', 'unknown', {});
    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body));
    expect(body.distinct_id).toBe('folio-server');
    expect(body.properties.$process_person_profile).toBe(false);
  });

  it('a failing request never throws', async () => {
    setEnv('phc_test');
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('down'))));
    expect(() => captureServerEvent('x', undefined)).not.toThrow();
    await Promise.resolve();
  });

  it('accepts only plain ids and clips client names', () => {
    expect(cleanVisitorId('short')).toBeNull();
    expect(cleanVisitorId('has space in it 12345')).toBeNull();
    expect(cleanVisitorId(['01a10fdf-134a-7692-9992-0db75ffa855a'])).toBe('01a10fdf-134a-7692-9992-0db75ffa855a');
    expect(cleanVisitorId(undefined)).toBeNull();
    expect(clientNameProp('  A\n\n  very   long '.padEnd(200, 'x'))).toHaveLength(80);
  });
});
