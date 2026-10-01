import { describe, expect, it } from 'vitest';
import { INITIAL_CONNECTIVITY, SLOW_PROBE_MS, reduceConnectivity, type ConnectivityEvent } from './connectivity';

const after = (...events: ConnectivityEvent[]) => events.reduce(reduceConnectivity, INITIAL_CONNECTIVITY);

describe('reduceConnectivity', () => {
  it('one failed request is a hiccup, two in a row is offline', () => {
    expect(after({ type: 'failure' }).state).toBe('degraded');
    expect(after({ type: 'failure' }, { type: 'failure' }).state).toBe('offline');
  });

  it('believes the browser going offline at once, but not coming back', () => {
    const down = after({ type: 'browser', online: false });
    expect(down.state).toBe('offline');
    // The interface is up again; whether the SERVER is reachable is for the next request to say.
    expect(reduceConnectivity(down, { type: 'browser', online: true }).state).toBe('offline');
    expect(reduceConnectivity(down, { type: 'success', latencyMs: 80 }).state).toBe('online');
  });

  it('any answer from the server ends an outage', () => {
    expect(after({ type: 'failure' }, { type: 'failure' }, { type: 'success' }).state).toBe('online');
  });

  it('two slow probes in a row are a poor connection; a fast one clears it', () => {
    const slow: ConnectivityEvent = { type: 'success', latencyMs: SLOW_PROBE_MS + 1 };
    expect(after(slow).state).toBe('online');
    expect(after(slow, slow).state).toBe('degraded');
    expect(after(slow, slow, { type: 'success', latencyMs: 90 }).state).toBe('online');
  });

  it('a real request says nothing about speed — an export may simply be long', () => {
    const slow: ConnectivityEvent = { type: 'success', latencyMs: SLOW_PROBE_MS + 1 };
    // Unmeasured successes neither add to the slow streak nor reset it.
    expect(after(slow, { type: 'success' }, slow).state).toBe('degraded');
    expect(after({ type: 'success' }, { type: 'success' }, { type: 'success' }).state).toBe('online');
  });
});
