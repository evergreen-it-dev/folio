// @vitest-environment jsdom
/**
 * Optional analytics: inert without a server-provided key; with one, anonymous (no profiles, no cookies),
 * continuing the visit the marketing site handed over in the address.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAnalyticsForTests, captureHandoff, initAnalytics, posthogOptions, track, trackEdit, trackPageOpen, visitorHeaders } from './index';

const DID = '01a10fdf-134a-7692-9992-0db75ffa855a';
const SID = '01a10fdf-134a-7692-9992-0db8a042b399';

beforeEach(() => {
  __resetAnalyticsForTests();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  vi.doUnmock('posthog-js');
  vi.resetModules();
});

describe('captureHandoff', () => {
  it('reads the ids and removes only them from the address', () => {
    window.history.replaceState(null, '', `/s/acme?x=1&ph_did=${DID}&ph_sid=${SID}#h`);
    expect(captureHandoff()).toEqual({ did: DID, sid: SID });
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/s/acme?x=1#h');
  });

  it('removes junk from the address and ignores it', () => {
    window.history.replaceState(null, '', '/?ph_did=not-a-uuid&ph_sid=zzz');
    expect(captureHandoff()).toBeNull();
    expect(window.location.search).toBe('');
  });

  it('does nothing when there is nothing to read', () => {
    window.history.replaceState(null, '', '/?a=b');
    expect(captureHandoff()).toBeNull();
    expect(window.location.search).toBe('?a=b');
  });
});

describe('posthogOptions', () => {
  it('is anonymous: no profiles, no cookies, no autocapture, inputs masked, Do Not Track respected', () => {
    const o = posthogOptions({ key: 'phc_x', host: 'https://eu.i.posthog.com' }, null);
    expect(o).toMatchObject({
      api_host: 'https://eu.i.posthog.com',
      ui_host: 'https://eu.posthog.com',
      persistence: 'sessionStorage',
      person_profiles: 'identified_only',
      autocapture: false,
      respect_dnt: true,
      session_recording: { maskAllInputs: true },
    });
    expect(o).not.toHaveProperty('bootstrap');
  });

  it('boots from the visit the site handed over', () => {
    expect(posthogOptions({ key: 'k', host: 'https://eu.i.posthog.com' }, { did: DID, sid: SID })).toMatchObject({ bootstrap: { distinctID: DID, sessionID: SID } });
    expect(posthogOptions({ key: 'k', host: 'https://eu.i.posthog.com' }, { did: DID, sid: null }).bootstrap).toEqual({ distinctID: DID });
  });
});

describe('off without a key', () => {
  it('loads nothing and every call is a no-op', async () => {
    const init = vi.fn();
    vi.doMock('posthog-js', () => ({ default: { init } }));
    initAnalytics(undefined);
    track('x');
    trackPageOpen('doc', 'acme');
    trackEdit('doc', 'p1');
    await new Promise((r) => setTimeout(r, 10));
    expect(init).not.toHaveBeenCalled();
    expect(visitorHeaders()).toEqual({});
  });
});

describe('with a key', () => {
  it('initialises once, flushes what was queued and offers the visitor header', async () => {
    const capture = vi.fn();
    const init = vi.fn((_k: string, c: { loaded: (p: unknown) => void }) =>
      c.loaded({ capture, debug: () => {}, get_distinct_id: () => DID, get_session_id: () => SID }),
    );
    vi.doMock('posthog-js', () => ({ default: { init } }));
    const m = await import('./index');
    m.initAnalytics({ key: 'phc_x', host: 'https://eu.i.posthog.com' });
    m.initAnalytics({ key: 'phc_x', host: 'https://eu.i.posthog.com' });
    m.trackPageOpen('table', 'acme-handbook');
    await vi.waitFor(() => expect(init).toHaveBeenCalledTimes(1));
    expect(capture).toHaveBeenCalledWith('page_open', { kind: 'table', space_slug: 'acme-handbook' });
    m.trackEdit('doc', 'p1', 'acme');
    m.trackEdit('doc', 'p1', 'acme');
    expect(capture.mock.calls.filter((c) => c[0] === 'page_edit')).toHaveLength(1);
    expect(m.visitorHeaders()).toEqual({ 'x-folio-visitor': DID });
  });
});
