// @vitest-environment jsdom
/**
 * Round (page presence) — pure reducer tests, same spirit as
 * tables/collab/awareness.dom.test.tsx's peersByCell coverage: no React, no
 * websocket, just raw awareness state in, a render-ready list out.
 */
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { reducePagePresence, usePagePresence, type PresenceIdentityInput } from './presence';

const ME: PresenceIdentityInput = { id: 'u-me', name: 'Zoe Me', color: '#1971c2' };
const ALICE = { id: 'u-alice', name: 'Alice Anderson', username: 'alice', color: '#2f9e44' };
const BOB = { id: 'u-bob', name: 'Bob Baker', color: '#c2255c' };

describe('reducePagePresence', () => {
  it('collapses two tabs of the SAME signed-in person into one entry', () => {
    const states = new Map<number, unknown>([
      [1, { user: ALICE }], // Alice, tab 1
      [2, { user: ALICE }], // Alice, tab 2 — same id, different clientId
    ]);
    const people = reducePagePresence(states, 99, ME);
    const alices = people.filter((p) => p.name === 'Alice Anderson');
    expect(alices).toHaveLength(1);
    expect(alices[0].username).toBe('alice');
  });

  it('does NOT merge two different anonymous guests (neither has an id)', () => {
    const anonA = { name: 'Amber Otter', color: '#d9480f' }; // no id: anon
    const anonB = { name: 'Brisk Lynx', color: '#7048e8' }; // no id: anon
    const states = new Map<number, unknown>([
      [1, { user: anonA }],
      [2, { user: anonB }],
    ]);
    const people = reducePagePresence(states, 99, ME);
    const names = people.filter((p) => !p.isSelf).map((p) => p.name);
    expect(names.sort()).toEqual(['Amber Otter', 'Brisk Lynx']);
  });

  it('includes the LOCAL client, marked isSelf, even with no remote peers', () => {
    const people = reducePagePresence(new Map(), 42, ME);
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ name: 'Zoe Me', isSelf: true });
  });

  it('a local anonymous identity dedupes by its own clientId, not by name/color', () => {
    const localAnon: PresenceIdentityInput = { name: 'Gentle Falcon', color: '#0c8599' };
    const people = reducePagePresence(new Map(), 7, localAnon);
    expect(people).toEqual([{ key: 'anon:7', name: 'Gentle Falcon', username: undefined, color: '#0c8599', isSelf: true }]);
  });

  it('never counts the local clientId as a remote peer', () => {
    const states = new Map<number, unknown>([[9, { user: BOB }]]);
    const people = reducePagePresence(states, 9, ME); // local clientId === 9, same as the "peer" entry
    expect(people).toHaveLength(1);
    expect(people[0].isSelf).toBe(true);
  });

  it('skips malformed or partial peer records instead of throwing', () => {
    const states = new Map<number, unknown>([
      [1, null],
      [2, 'not an object'],
      [3, {}],
      [4, { user: null }],
      [5, { user: { name: 'No color' } }], // missing color
      [6, { user: BOB }], // valid
    ]);
    expect(() => reducePagePresence(states, 0, ME)).not.toThrow();
    const people = reducePagePresence(states, 0, ME);
    expect(people.map((p) => p.name).sort()).toEqual(['Bob Baker', 'Zoe Me']);
  });

  it('orders the local person first, then everyone else alphabetically by name', () => {
    const states = new Map<number, unknown>([
      [1, { user: BOB }], // "Bob"
      [2, { user: ALICE }], // "Alice"
    ]);
    const people = reducePagePresence(states, 99, ME); // "Zoe"
    expect(people.map((p) => p.name)).toEqual(['Zoe Me', 'Alice Anderson', 'Bob Baker']);
  });

  it('is stable across a re-render that reshuffles the underlying Map order', () => {
    const statesA = new Map<number, unknown>([
      [1, { user: BOB }],
      [2, { user: ALICE }],
    ]);
    const statesB = new Map<number, unknown>([
      [2, { user: ALICE }],
      [1, { user: BOB }],
    ]);
    expect(reducePagePresence(statesA, 99, ME).map((p) => p.key)).toEqual(reducePagePresence(statesB, 99, ME).map((p) => p.key));
  });
});

/**
 * A regression (caught with live tabs): the list was computed once, when
 * awareness had just appeared, and then recomputed ONLY on a 'change' event.
 * Neighbors get into getStates() at once, as soon as the socket has opened
 * (the server sends the whole presence snapshot right away), that is, often
 * BEFORE React manages to subscribe — and the next keep-alive from a
 * neighbor is sent by y-protocols once in ~15 s. Measured: a second tab sat
 * without the indicator for 22 seconds. So the subscription has to push a
 * recomputation immediately.
 */
describe('usePagePresence — the subscription must not miss neighbors that are already there', () => {
  it('recomputes right after subscribing, when the presence snapshot arrived between the render and the effect', () => {
    const handlers = new Set<() => void>();
    const filled = new Map<number, unknown>([[2, { user: { id: 'bob', name: 'Bob', color: '#000000' } }]]);
    const empty = new Map<number, unknown>();
    // The first call (during the render) — the room is still empty; after
    // that the snapshot from the server is already applied. This is exactly
    // how it looks live: the socket opens and hands over the whole snapshot
    // faster than React manages to commit the effect.
    let calls = 0;
    const awareness = {
      clientID: 1,
      getStates: () => (calls++ === 0 ? empty : filled),
      on: (_event: string, fn: () => void) => handlers.add(fn),
      off: (_event: string, fn: () => void) => handlers.delete(fn),
    };

    const me = { id: 'me', name: 'Me', color: '#111111' };
    const { result } = renderHook(() => usePagePresence(awareness as never, me));

    // Nobody sent any 'change' event — and Bob is in the list all the same.
    expect(handlers.size).toBe(1);
    expect(result.current.map((p) => p.name).sort()).toEqual(['Bob', 'Me']);
  });
});
