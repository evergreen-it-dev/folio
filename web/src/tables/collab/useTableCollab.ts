/**
 * Round 26 (DATA TABLES) — the React binding for a table's collab room.
 *
 * Shape mirrors web/src/editor/collab.ts (one Y.Doc per page, one
 * WebsocketProvider, one UndoManager, the same stored anonymous identity), so
 * the two live-editing surfaces behave identically from the user's side. What
 * differs is everything below the provider: a document's CRDT is one Y.Text,
 * a table's is the six-root structure in ./ydoc.
 *
 * Hooks here deliberately take PRIMITIVES (a Y.Doc, an Awareness) rather than
 * the session object, so each one is testable against a bare Y.Doc with no
 * server, no socket and no mocking. `useTableCollab` is the thin composition
 * on top.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import type { TableDoc } from '@shared/contracts';
import { anonUser, PALETTE, type AnonUser } from '../../editor/collab';
import { useAuthOptional } from '../../app/auth/AuthProvider';
import { resolveAuthedIdentity } from '../../app/collabIdentity';
import type { TablePatch, TablePatchSink } from '../types';
import { TABLE_LOCAL_ORIGIN, applyTablePatches, isTableYDocSeeded, tableDocFromYDoc, tableRoots, undoScope } from './ydoc';

export interface TableCollabSession {
  pageId: string;
  doc: Y.Doc;
  provider: WebsocketProvider;
  /**
   * Scoped to THIS client's origin (spec §6 rule 7). Cmd+Z rolls back your own
   * last change and never a collaborator's — and never the server's
   * seed/reconcile pass either, which uses its own origin (see
   * server/collab.ts's TABLE_SEED_ORIGIN).
   */
  undoManager: Y.UndoManager;
  user: AnonUser;
}

/** How long a run of keystrokes is folded into ONE undo step (matches the prose editor's 400ms). */
const UNDO_CAPTURE_MS = 400;

export function useTableCollab(pageId: string, collabUrl: string, collabParams?: Record<string, string>): TableCollabSession | null {
  const [session, setSession] = useState<TableCollabSession | null>(null);
  // null both when genuinely signed out (a share-link guest) and when this
  // renders outside <AuthProvider> altogether — useAuthOptional() covers both.
  const authUser = useAuthOptional()?.user ?? null;

  useEffect(() => {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(collabUrl, pageId, doc, collabParams ? { params: collabParams } : undefined);
    const user = authUser ? resolveAuthedIdentity(authUser, PALETTE) : anonUser();
    provider.awareness.setLocalStateField('user', user);

    // Scope: the five mutable roots, NOT the whole doc — see undoScope.
    // trackedOrigins: only ours, so remote updates (which arrive with the
    // provider as their origin) and the server's reconcile pass are invisible
    // to this stack.
    const undoManager = new Y.UndoManager(undoScope(doc), {
      trackedOrigins: new Set([TABLE_LOCAL_ORIGIN]),
      captureTimeout: UNDO_CAPTURE_MS,
    });

    setSession({ pageId, doc, provider, undoManager, user });

    return () => {
      setSession(null);
      undoManager.destroy();
      provider.destroy();
      doc.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- params are serialized into the key
  }, [pageId, collabUrl, JSON.stringify(collabParams ?? null)]);

  return session;
}

export interface TableDocState {
  /** The table, or null while the server hasn't seeded the room yet. */
  doc: TableDoc | null;
  /** Set when the CRDT holds something that isn't a structurally valid table (spec §1's "raw file" case). */
  error: string | null;
  /** False until the server's awaited seed has landed — render a skeleton, NEVER an empty table. */
  seeded: boolean;
}

/**
 * The live table as a plain `TableDoc`, recomputed only when the CRDT
 * actually changes.
 *
 * The cached snapshot is not an optimization detail — `useSyncExternalStore`
 * requires getSnapshot() to return a REFERENTIALLY STABLE value between
 * changes, and tableDocFromYDoc builds a fresh object every call. Returning
 * that directly is an infinite render loop.
 *
 * A structurally invalid doc is reported, not thrown: the table page shows a
 * warning instead of a blank screen, which is the client-side counterpart of
 * the server refusing to persist such a doc.
 */
export function useTableDoc(doc: Y.Doc | null): TableDocState {
  const cache = useRef<TableDocState>({ doc: null, error: null, seeded: false });
  const cachedFor = useRef<Y.Doc | null>(null);
  const dirty = useRef(true);

  if (cachedFor.current !== doc) {
    cachedFor.current = doc;
    dirty.current = true;
  }

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!doc) return () => {};
      const handler = () => {
        dirty.current = true;
        onChange();
      };
      // `update` fires for local, remote and server-reconcile changes alike,
      // which is exactly the set that can alter what the grid should show.
      doc.on('update', handler);
      return () => doc.off('update', handler);
    },
    [doc],
  );

  const getSnapshot = useCallback((): TableDocState => {
    if (!doc) return EMPTY_STATE;
    if (!dirty.current) return cache.current;
    dirty.current = false;
    if (!isTableYDocSeeded(doc)) {
      cache.current = { doc: null, error: null, seeded: false };
      return cache.current;
    }
    try {
      cache.current = { doc: tableDocFromYDoc(doc), error: null, seeded: true };
    } catch (err) {
      cache.current = { doc: null, error: err instanceof Error ? err.message : String(err), seeded: true };
    }
    return cache.current;
  }, [doc]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const EMPTY_STATE: TableDocState = { doc: null, error: null, seeded: false };

/**
 * The sink TABLES-UI's grid calls. Every patch is applied to the CRDT under
 * the LOCAL origin, which is what makes it undoable by this client and only
 * this client. A batch becomes one transaction: one undo step, one debounced
 * write-back, one git commit.
 */
export function useTablePatchSink(doc: Y.Doc | null): TablePatchSink & { batch: (patches: readonly TablePatch[]) => void } {
  const sink = useCallback(
    (patch: TablePatch) => {
      if (doc) applyTablePatches(doc, [patch]);
    },
    [doc],
  );
  const batch = useCallback(
    (patches: readonly TablePatch[]) => {
      if (doc) applyTablePatches(doc, patches);
    },
    [doc],
  );
  return useMemo(() => Object.assign(sink, { batch }), [sink, batch]);
}

export interface TableUndoControls {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

/** Cmd+Z / Cmd+Shift+Z state for the toolbar, driven by the UndoManager's own events. */
export function useTableUndo(undoManager: Y.UndoManager | null): TableUndoControls {
  const [state, setState] = useState({ canUndo: false, canRedo: false });

  useEffect(() => {
    if (!undoManager) {
      setState({ canUndo: false, canRedo: false });
      return;
    }
    const update = () => setState({ canUndo: undoManager.canUndo(), canRedo: undoManager.canRedo() });
    update();
    undoManager.on('stack-item-added', update);
    undoManager.on('stack-item-popped', update);
    undoManager.on('stack-cleared', update);
    return () => {
      undoManager.off('stack-item-added', update);
      undoManager.off('stack-item-popped', update);
      undoManager.off('stack-cleared', update);
    };
  }, [undoManager]);

  const undo = useCallback(() => undoManager?.undo(), [undoManager]);
  const redo = useCallback(() => undoManager?.redo(), [undoManager]);

  return { undo, redo, canUndo: state.canUndo, canRedo: state.canRedo };
}

export type TableConnectionStatus = 'connecting' | 'connected' | 'offline';

/** Connection indicator, same three states and same provider events as the prose editor's. */
export function useTableConnectionStatus(provider: WebsocketProvider | null): TableConnectionStatus {
  const [status, setStatus] = useState<TableConnectionStatus>('connecting');

  useEffect(() => {
    if (!provider) {
      setStatus('connecting');
      return;
    }
    const apply = (value: 'connected' | 'disconnected' | 'connecting') => setStatus(value === 'disconnected' ? 'offline' : value);
    apply(provider.wsconnected ? 'connected' : provider.wsconnecting ? 'connecting' : 'disconnected');
    const onStatus = ({ status: next }: { status: 'connected' | 'disconnected' | 'connecting' }) => apply(next);
    provider.on('status', onStatus);
    return () => provider.off('status', onStatus);
  }, [provider]);

  return status;
}

/** Direct access to the raw roots, for a caller that needs a Y.Text (a longtext cell editor) rather than a snapshot. */
export function tableCellText(doc: Y.Doc, rowId: string, columnId: string): Y.Text | null {
  const rows = tableRoots(doc).rows;
  for (let i = 0; i < rows.length; i++) {
    const m = rows.get(i);
    if (String(m.get('id') ?? '') !== rowId) continue;
    const cell = m.get(columnId);
    return cell instanceof Y.Text ? cell : null;
  }
  return null;
}
