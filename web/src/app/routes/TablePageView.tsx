import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { SpaceRole } from '@shared/contracts';
import { TablePage } from '../../tables';
import type { TableRole } from '../../tables';
import { useTableCollab, useTableDoc, useTablePatchSink } from '../../tables/collab';
import { api } from '../api';
import { canEditContent } from '../auth/roles';
import { usePagePresence, usePublishPagePresence } from '../presence';
import '../i18n/register';

/**
 * Space role → the table zone's own role. Kept here rather than in
 * auth/roles.ts so the single app/ ⇄ tables/ type edge stays in this file.
 * `undefined` (not a member) lands on viewer, matching roles.ts's rule that
 * "no membership" is always the least-privileged case.
 */
export function tableRole(role: SpaceRole | undefined): TableRole {
  if (role === 'admin') return 'admin';
  return canEditContent(role) ? 'editor' : 'viewer';
}

/** R23 tail: what the export menu's view picker needs — see PageContent/Shell's HeaderInfo.table. */
export interface TableViewState {
  activeViewId: string;
  views: { id: string; name: string }[];
}

export interface TablePageViewProps {
  pageId: string;
  /** Already resolved by the caller: a space role for a signed-in user, the share link's own mode for a guest. */
  role: TableRole;
  /**
   * Space slug, for the `user` column's candidate handles. Omitted for a
   * share guest — `/mentionable` is a session endpoint and would 401.
   */
  space?: string;
  /** `{ share: <token> }` for a share-link guest; omitted for a cookie session. */
  collabParams?: Record<string, string>;
  /**
   * R23 tail (export view picker): called with the grid's current view +
   * the saved views whenever either changes, and with `null` when the table
   * has no doc yet / on unmount. PageContent folds this into HeaderInfo so
   * the header's ExportMenu can offer a view selector. Optional — the share
   * view mounts this component without it.
   */
  onViewState?: (state: TableViewState | null) => void;
}

/**
 * Round 26 (DATA TABLES) — the live table surface, as mounted by the shell.
 *
 * This is where the three halves of the round meet: TABLES-UI's `TablePage`
 * (the whole grid/toolbar/panels surface), COLLAB-TABLES' Y.Doc binding, and
 * the router.
 *
 * ─── Why the CRDT and not `GET /api/tables/:id` ──────────────────────────
 * `TablePage` is deliberately dual-mode (see its own header): given `onPatch`
 * it stops owning the document and becomes fully controlled — patches out,
 * document in. That is the arrangement used here, and it is not merely a
 * data-source preference:
 *
 *  - the local reducer in tables/patch.ts and the CRDT deliberately DISAGREE
 *    on `columns:delete` (the reducer drops orphaned cell values immediately;
 *    the CRDT keeps them until serialization, which is what lets an undo put
 *    the column back WITH its data). Not passing `onPatch` here would quietly
 *    select the wrong one of those two;
 *  - a patch applied to the Y.Doc is one transaction: one undo step, one
 *    debounced write-back, one commit — which is what makes spec §17.7's
 *    "one edited cell = a one-line git diff" true;
 *  - it is the same socket every other client is on, so §17.6's live
 *    collaboration is a property of the wiring rather than a feature to add.
 *
 * `seeded` is false until the server's own awaited seed lands. A skeleton is
 * shown then, NEVER an empty table: "no rows yet" and "your data is gone"
 * look identical on screen, and this is exactly the moment when it is the
 * former.
 *
 * ─── No OutlinePanel ─────────────────────────────────────────────────────
 * The doc branch in PageContent puts an OutlinePanel beside the editor. A
 * data table has no heading structure to outline — its `head`/`tail` prose is
 * a title and a note, and the content proper is rows — so an outline here
 * would be a permanently empty rail stealing horizontal room from a surface
 * that is starved of exactly that (spec §14 already asks the grid to scroll
 * horizontally). It is not rendered.
 */
export function TablePageView({ pageId, role, space, collabParams, onViewState }: TablePageViewProps) {
  const { t } = useTranslation('app');
  const location = useLocation();
  const [searchParams] = useSearchParams();
  // R23 tail: the grid's active view, reported by TablePage (tables zone).
  const [activeViewId, setActiveViewId] = useState<string | undefined>(undefined);

  // Deep link, spec §11 / §17.5: `?row=<id>` comes from the ROUTER, not from
  // window.location — so it re-reads on an in-app navigation (Cmd+K jumping
  // between two rows of the same table never remounts this component) and so
  // it works under a basename or a memory router in tests.
  const highlightRowId = searchParams.get('row') ?? undefined;

  // window.location, not the router's — `location` above is a router Location
  // (pathname/search/hash only) and has no protocol/host.
  const collabUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/collab`;
  const session = useTableCollab(pageId, collabUrl, collabParams);
  const { doc, error, seeded } = useTableDoc(session?.doc ?? null);
  const onPatch = useTablePatchSink(session?.doc ?? null);
  // Round (page presence): published up to Header via Shell's channel — a
  // share-link guest (collabParams carrying `share`) gets a session here too,
  // same as an authed viewer/editor, so they're counted like everyone else.
  const presencePeople = usePagePresence(session?.provider.awareness ?? null, session?.user ?? null);
  usePublishPagePresence(presencePeople);

  // `user` column candidates. Same endpoint the editor's @-picker uses; a
  // failure degrades to "no suggestions", never to a broken table.
  const { data: mentionableData } = useQuery({
    queryKey: ['mentionable', space],
    queryFn: () => api.listMentionable(space!),
    enabled: Boolean(space),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const mentionable = useMemo(
    () => (mentionableData?.users ?? []).map((user) => user.username),
    [mentionableData],
  );

  // R23 tail: publish {activeViewId, views} upward (and null while there is
  // no doc / after unmount). Scalar-keyed deps to match useSetHeaderInfo's
  // own guard against object-identity re-fires; the doc's views change only
  // on real view edits, so this stays quiet during ordinary cell editing.
  const viewsKey = doc?.views.map((view) => `${view.id}:${view.name}`).join('|');
  useEffect(() => {
    if (!onViewState) return;
    if (!doc || doc.views.length === 0) {
      onViewState(null);
      return;
    }
    const fallback = doc.views[0].id;
    const active = activeViewId && doc.views.some((view) => view.id === activeViewId) ? activeViewId : fallback;
    onViewState({ activeViewId: active, views: doc.views.map((view) => ({ id: view.id, name: view.name })) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewsKey, activeViewId, doc === null, onViewState]);
  useEffect(() => () => onViewState?.(null), [onViewState]);

  /**
   * The row-detail panel's "copy link" button. Built from the
   * router's own location and made ABSOLUTE — a bare `/s/x/p/y?row=z` pasted
   * into a chat is not a link, which is the whole point of the button.
   */
  const rowLinkFor = useCallback(
    (rowId: string) => `${window.location.origin}${location.pathname}?row=${encodeURIComponent(rowId)}`,
    [location.pathname],
  );

  if (error) {
    return (
      <div className="p-8 text-sm text-red-600 dark:text-red-400">{t('routes.table.invalid', { message: error })}</div>
    );
  }

  if (!seeded || !doc) {
    return <div className="p-8 text-sm text-neutral-400">{t('routes.table.connecting')}</div>;
  }

  // A `?row=` that names nothing in this table (a renamed/deleted row, or a
  // link copied from a different table) would otherwise do nothing at all and
  // read as a broken feature.
  const rowMissing = highlightRowId !== undefined && !doc.rows.some((row) => row.id === highlightRowId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {rowMissing && (
        <p className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {t('routes.table.rowMissing')}
        </p>
      )}
      <div className="min-h-0 flex-1">
        <TablePage
          pageId={pageId}
          doc={doc}
          role={role}
          highlightRowId={rowMissing ? undefined : highlightRowId}
          onPatch={onPatch}
          mentionable={mentionable}
          rowLinkFor={rowLinkFor}
          onActiveViewChange={setActiveViewId}
        />
      </div>
    </div>
  );
}
