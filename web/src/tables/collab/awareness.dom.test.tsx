// @vitest-environment jsdom
/**
 * Round 26 (DATA TABLES) — cell presence (spec §6 rule 8).
 *
 * `peersByCell` is tested directly (pure reducer, no React), then the hooks
 * are driven against a REAL `Awareness` instance — y-protocols' Awareness
 * works standalone on a bare Y.Doc, so this exercises the actual awareness
 * protocol without a websocket, a server or a mock.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { cellKey, peersByCell, useCellPresence, useLocalCell, usePresentPeers } from './awareness';

afterEach(cleanup);

const ALICE = { name: 'Amber Otter', color: '#1971c2', colorLight: '#1971c233' };
const BOB = { name: 'Brisk Lynx', color: '#2f9e44', colorLight: '#2f9e4433' };

describe('peersByCell', () => {
  it('groups remote peers by the cell they are in, and excludes the local client', () => {
    const states = new Map<number, unknown>([
      [1, { user: ALICE, cell: { rowId: 'r1', columnId: 'owner' } }],
      [2, { user: BOB, cell: { rowId: 'r1', columnId: 'owner' } }],
      [3, { user: ALICE, cell: { rowId: 'r2', columnId: 'goal' } }],
      [9, { user: BOB, cell: { rowId: 'r9', columnId: 'week' } }], // this is us
    ]);

    const map = peersByCell(states, 9);
    expect([...map.keys()].sort()).toEqual([cellKey('r1', 'owner'), cellKey('r2', 'goal')].sort());
    expect(map.get(cellKey('r1', 'owner'))!.map((p) => p.user.name)).toEqual(['Amber Otter', 'Brisk Lynx']);
    expect(map.get(cellKey('r9', 'week'))).toBeUndefined(); // never yourself
  });

  it('is deterministic when two people sit in the same cell', () => {
    const states = new Map<number, unknown>([
      [7, { user: BOB, cell: { rowId: 'r1', columnId: 'owner' } }],
      [2, { user: ALICE, cell: { rowId: 'r1', columnId: 'owner' } }],
    ]);
    expect(peersByCell(states, 0).get(cellKey('r1', 'owner'))!.map((p) => p.clientId)).toEqual([2, 7]);
  });

  it('survives malformed peer state instead of throwing inside a render', () => {
    const states = new Map<number, unknown>([
      [1, null],
      [2, 'not an object'],
      [3, {}],
      [4, { cell: null }],
      [5, { cell: { rowId: 'r1' } }], // half-written during a reconnect
      [6, { cell: { rowId: '', columnId: '' } }],
      [7, { cell: { rowId: 'r1', columnId: 'owner' } }], // valid, but no `user` yet
    ]);
    const map = peersByCell(states, 0);
    expect(map.size).toBe(1);
    expect(map.get(cellKey('r1', 'owner'))![0].user.name).toBe('Someone'); // defaulted, not crashed
  });
});

describe('useCellPresence / useLocalCell against a real Awareness', () => {
  function makeAwareness(): { local: Awareness; remote: Awareness; relay: () => void } {
    // Two Awareness instances over two docs, wired by hand — this is what the
    // websocket relay does for real, minus the socket.
    const local = new Awareness(new Y.Doc());
    const remote = new Awareness(new Y.Doc());
    const relay = () => {
      const states = remote.getStates();
      for (const [clientId, state] of states) {
        local.states.set(clientId, state as Record<string, unknown>);
      }
      local.emit('change', [{ added: [], updated: [...states.keys()], removed: [] }, 'test']);
    };
    return { local, remote, relay };
  }

  it('reflects a remote peer entering, moving between and leaving cells', () => {
    const { local, remote, relay } = makeAwareness();
    const { result } = renderHook(() => useCellPresence(local));

    expect(result.current.size).toBe(0);

    act(() => {
      remote.setLocalStateField('user', ALICE);
      remote.setLocalStateField('cell', { rowId: 'r1', columnId: 'owner' });
      relay();
    });
    expect(result.current.get(cellKey('r1', 'owner'))!.map((p) => p.user.name)).toEqual(['Amber Otter']);

    act(() => {
      remote.setLocalStateField('cell', { rowId: 'r2', columnId: 'goal' });
      relay();
    });
    expect(result.current.get(cellKey('r1', 'owner'))).toBeUndefined();
    expect(result.current.get(cellKey('r2', 'goal'))!).toHaveLength(1);

    act(() => {
      remote.setLocalStateField('cell', null);
      relay();
    });
    expect(result.current.size).toBe(0);
  });

  it('useLocalCell publishes the cell and clears it on unmount, leaving no ghost cursor', () => {
    const local = new Awareness(new Y.Doc());
    const { result, unmount } = renderHook(() => useLocalCell(local));

    act(() => result.current({ rowId: 'r1', columnId: 'owner' }));
    expect(local.getLocalState()!.cell).toEqual({ rowId: 'r1', columnId: 'owner' });

    act(() => result.current(null));
    expect(local.getLocalState()!.cell).toBeNull();

    act(() => result.current({ rowId: 'r3', columnId: 'week' }));
    unmount();
    expect(local.getLocalState()!.cell).toBeNull(); // cleaned up, not left behind
  });

  it('usePresentPeers lists everyone else in the room', () => {
    const { local, remote, relay } = makeAwareness();
    local.setLocalStateField('user', BOB);
    const { result } = renderHook(() => usePresentPeers(local));

    expect(result.current).toEqual([]);
    act(() => {
      remote.setLocalStateField('user', ALICE);
      relay();
    });
    expect(result.current.map((u) => u.name)).toEqual(['Amber Otter']); // not BOB — that's us
  });

  it('all hooks no-op safely before the provider exists (session is null on first render)', () => {
    const presence = renderHook(() => useCellPresence(null));
    expect(presence.result.current.size).toBe(0);
    const peers = renderHook(() => usePresentPeers(null));
    expect(peers.result.current).toEqual([]);
    const setCell = renderHook(() => useLocalCell(null));
    expect(() => setCell.result.current({ rowId: 'r1', columnId: 'owner' })).not.toThrow();
  });
});
