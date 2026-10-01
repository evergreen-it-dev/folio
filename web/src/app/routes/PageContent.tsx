import { useEffect, useState, useRef } from 'react';
import { useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { officeFormat, type PageDoc } from '@shared/contracts';
import { PageEditor } from '../../editor';
import { BoardEditor } from '../../diagrams';
import { api, ApiError } from '../api';
import { useApiErrorText } from '../errorText';
import { getLocalPage, localPageDoc, localPagesReady, onLocalPageSynced, useIsLocalPage } from '../offline';
import { useConnectivity } from '../offline/connectivity';
import { useDocumentTitle } from '../hooks';
import { useSetHeaderInfo } from '../Shell';
import { useRecordRecentVisit } from '../recents';
import { useSpaceRole } from '../auth/AuthProvider';
import { canEditContent } from '../auth/roles';
import { OutlinePanel } from '../outline/OutlinePanel';
import { PageChrome } from '../page-meta/PageChrome';
import { PageConflictBanner } from '../git/PageConflictBanner';
import { StaticBoardView } from './StaticBoardView';
import { PdfView } from './PdfView';
import { OfficeView } from './OfficeView';
import { TablePageView, tableRole, type TableViewState } from './TablePageView';
import { FormPageView } from './FormPageView';
import { NotFound } from './NotFound';
import '../i18n/register';

export interface PageContentProps {
  id: string;
}

/**
 * Round 26 (DATA TABLES) — WORKAROUND, remove once SERVER catches up.
 *
 * `GET /api/pages/:id` still branches only two ways: `kind === 'doc'` reads
 * markdown, and EVERYTHING else falls through to `storage.readBoardSvg(id)`,
 * which rejects a non-board with a 400 (`page is not a board`). The canonical
 * page fetch therefore cannot describe a table at all — without this, the
 * shell can't even learn that the page IS one.
 *
 * `GET /api/tables/:id` answers with the page's own PageMeta (plus the table
 * body, which this path ignores — the live surface reads the document from
 * the CRDT), so it can stand in for identity. server/** belongs to another
 * agent this round; the real fix there is one `if (entry.kind === 'table')`
 * arm returning `{ ...toPageMeta(entry), markdown: <raw file> }`, and this
 * fallback simply stops firing the moment it lands.
 *
 * Exported for its test only.
 */
export async function fetchPage(id: string): Promise<PageDoc> {
  // A page created while there was no network has no file on the server yet —
  // asking for it would 404 (or fail outright) and the page the user just made
  // would open as an error. The registry answers instead; the body itself is in
  // the page's Y.Doc, as for any live page. Wait for the registry first: on a
  // fresh load of a local page's URL nothing has read it from storage yet.
  await localPagesReady();
  const local = getLocalPage(id);
  if (local) return localPageDoc(local);
  try {
    return await api.getPage(id);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 400) throw err;
    try {
      const snapshot = await api.getTable(id);
      return snapshot.meta;
    } catch {
      // Not a table either — surface the ORIGINAL failure, not this one.
      throw err;
    }
  }
}

/**
 * Fetches a page by id and dispatches to the right editor by kind and role.
 * Shared by the space-home route (id from /api/resolve) and the /p/:id
 * route (id from the URL) so the fetch/dispatch logic exists in exactly one
 * place.
 */
export function PageContent({ id }: PageContentProps) {
  const { t } = useTranslation('app');
  // The space comes from the URL, not from `data`: when a page did not open
  // (403/404), the page itself is exactly what is missing — and that is when
  // the "ask for access" button is needed.
  const { space: routeSpace } = useParams<{ space: string }>();
  const errorText = useApiErrorText();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['page', id],
    queryFn: () => fetchPage(id),
    // Offline mode: `fetchPage` answers for a page created on this device
    // without touching the network, so the query must not sit paused waiting
    // for one (React Query's default while the browser reports offline).
    networkMode: 'always',
    // Owner ask (10.09.2026): pick up structural changes (rename/move/kind)
    // made elsewhere without an F5 — see PageTree's ['tree', space] comment.
    // Focus-only here, deliberately NO refetchInterval: the live document
    // BODY comes from the collab socket (PageEditor's collabUrl), not from
    // this REST fetch — `data` only feeds title/icon/cover/kind chrome and
    // OutlinePanel's heading list — so a poll wouldn't even help the thing
    // people actually watch while editing. Worse, react-query keeps `data`
    // across a failed background refetch but still flips `isError`, and the
    // `isError || !data` guard below unmounts the whole editor in favor of
    // the error screen — a single dropped poll while someone is mid-edit
    // would yank the editor out from under them. A focus refetch runs once,
    // when the tab becomes active again (not mid-typing in practice), so
    // that risk is acceptable there but not on a standing 30s timer.
    refetchOnWindowFocus: true,
  });
  const isLocalPage = useIsLocalPage(id);
  // A page that could not be loaded because there was no network comes back
  // by itself when there is one again: with networkMode 'always' React Query
  // no longer treats a reconnect as a reason to refetch.
  //
  // Keyed on the TRANSITION out of `offline`, not on `isError`: a query whose
  // retry is still waiting (React Query pauses retries in a tab that is not
  // focused) is neither loading nor failed, and would never be asked again;
  // and a page that fails for a real reason (404) must not be re-asked on
  // every render.
  const connectivity = useConnectivity();
  const wasOffline = useRef(connectivity === 'offline');
  useEffect(() => {
    const was = wasOffline.current;
    wasOffline.current = connectivity === 'offline';
    if (was && connectivity !== 'offline' && !data) void refetch();
  }, [connectivity, data, refetch]);
  const role = useSpaceRole(data?.space);
  const editable = canEditContent(role);
  // The icon and the cover are written through the REST API — not available
  // to a page the server does not have yet (offline mode).
  const chromeEditable = editable && !isLocalPage;

  // A local page's metadata above came from the registry: a provisional path,
  // a placeholder order. Once the server has created the page, fetch the real
  // ones (the editor keeps its session — only its `pagePath` prop, which relative
  // links resolve against, changes).
  const queryClient = useQueryClient();
  useEffect(
    () => onLocalPageSynced(id, () => void queryClient.invalidateQueries({ queryKey: ['page', id] })),
    [id, queryClient],
  );

  // R23 tail (export view picker): the routed table's current view + saved
  // views, reported by TablePageView below and folded into HeaderInfo so the
  // header's ExportMenu can offer a view selector. Guarded by kind so a
  // stale value from a just-left table page can never ride on a doc page.
  const [tableViewState, setTableViewState] = useState<TableViewState | null>(null);

  useDocumentTitle(data?.title);
  useSetHeaderInfo(
    data
      ? {
          pageId: data.id,
          pagePath: data.path,
          title: data.title,
          icon: data.icon,
          table: data.kind === 'table' && tableViewState ? tableViewState : undefined,
          fileActions: data.kind === 'pdf' || data.kind === 'office',
        }
      : null,
  );
  useRecordRecentVisit(data ? { space: data.space, id: data.id, title: data.title, icon: data.icon } : undefined);

  if (isLoading) {
    // Offline there is nothing to wait for: either the page is on this
    // device (and `data` is already here) or it is not.
    if (connectivity === 'offline') {
      return <div className="p-8 text-sm text-neutral-500 dark:text-neutral-400">{t('offline.pageUnavailable')}</div>;
    }
    return <div className="p-8 text-sm text-neutral-400">{t('routes.page.loading')}</div>;
  }

  if (isError || !data) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
      // Both read as «404» to the user; the hint covers the private-space case.
      return <NotFound message={t('routes.page.notFound')} hint={t('routes.notFound.maybeNoAccess')} space={routeSpace} />;
    }
    // No network and nothing of this page on this device: not a failure to
    // apologise for in red, just something that has to wait.
    if (connectivity === 'offline') {
      return <div className="p-8 text-sm text-neutral-500 dark:text-neutral-400">{t('offline.pageUnavailable')}</div>;
    }
    return (
      <div className="p-8 text-sm text-red-600 dark:text-red-400">
        {t('routes.page.loadFailed')}{error ? `: ${errorText(error)}` : ''}.
      </div>
    );
  }

  if (data.kind === 'table') {
    // Round 26 (DATA TABLES). Before the doc fall-through, and deliberately
    // WITHOUT the OutlinePanel that fall-through renders: a data table has no
    // headings to outline (see TablePageView's own note). No PageChrome
    // cover/icon row either — the view tabs are this surface's own chrome,
    // and the table's title already lives in the breadcrumbs and in the
    // file's H1.
    return (
      <div className="flex h-full flex-col">
        <PageConflictBanner space={data.space} pageId={data.id} />
        <div className="min-h-0 flex-1">
          <TablePageView pageId={data.id} role={tableRole(role)} space={data.space} onViewState={setTableViewState} />
        </div>
      </div>
    );
  }

  if (data.kind === 'form') {
    // Round FORMS: no OutlinePanel (nothing to outline), no PageChrome
    // icon/cover row — same "the surface's own chrome is enough" call the
    // table branch above makes; FormPageView renders its own small
    // "view table"/"edit form" row above the fields.
    return (
      <div className="flex h-full flex-col overflow-y-auto">
        <PageConflictBanner space={data.space} pageId={data.id} />
        <FormPageView pageId={data.id} space={data.space} markdown={data.markdown ?? ''} canEdit={editable} />
      </div>
    );
  }

  if (data.kind === 'board') {
    // This round: boards get the same icon chrome a doc's PageChrome renders
    // (no cover — a board has none, see PageChrome's allowCover prop). The
    // board's TITLE is no longer its filename either (server/storage.ts's
    // folio-title header comment) but is still edited via the rename
    // affordances (Breadcrumbs.tsx / TreeRow.tsx), not here.
    return (
      <div className="flex h-full flex-col">
        <PageConflictBanner space={data.space} pageId={data.id} />
        <PageChrome pageId={data.id} space={data.space} icon={data.icon} canEdit={chromeEditable} allowCover={false} compact />
        <div className="min-h-0 flex-1">
          {/* Viewers never mount BoardEditor — DEV-PLAN Round 2: "boards render
              the fetched svg statically instead of BoardEditor" for that role. */}
          {editable ? <BoardEditor pageId={data.id} /> : <StaticBoardView svg={data.svg} title={data.title} />}
        </div>
      </div>
    );
  }

  if (data.kind === 'pdf') {
    // Read-only, no collab room (server/collab.ts refuses one for a pdf id),
    // no OutlinePanel (nothing to outline) — same PageChrome icon row a
    // board gets (compact, no cover), then the file itself.
    return (
      <div className="flex h-full flex-col">
        <PageConflictBanner space={data.space} pageId={data.id} />
        <PageChrome pageId={data.id} space={data.space} icon={data.icon} canEdit={editable} allowCover={false} compact />
        <div className="min-h-0 flex-1">
          <PdfView pageId={data.id} title={data.title} />
        </div>
      </div>
    );
  }

  if (data.kind === 'office') {
    // Round OFFICE: same shell as the pdf branch above — read-only, no
    // collab room, no OutlinePanel. officeFormat(data.path) tells docx/xlsx/
    // pptx apart; it's always defined for a real kind:'office' page (the
    // server only ever indexes one of those three extensions under this
    // kind), 'docx' is just a harmless fallback for the type checker.
    return (
      <div className="flex h-full flex-col">
        <PageConflictBanner space={data.space} pageId={data.id} />
        <PageChrome pageId={data.id} space={data.space} icon={data.icon} canEdit={editable} allowCover={false} compact />
        <div className="min-h-0 flex-1">
          <OfficeView pageId={data.id} title={data.title} format={officeFormat(data.path) ?? 'docx'} />
        </div>
      </div>
    );
  }

  const collabUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`;
  return (
    <div className="flex h-full flex-col">
      <PageConflictBanner space={data.space} pageId={data.id} />
      {/* Round 5: the outline panel is a flex sibling of the editor, not
          something bolted onto editor/'s own layout (out of this agent's area)
          — min-w-0 on the editor's wrapper keeps it from pushing the outline
          off-screen the way an unconstrained flex child can. */}
      <div className="flex min-h-0 flex-1">
        {/* flex-col (not a plain block): PageEditor's own root (.folio-editor,
            editor.css, not this agent's area) hardcodes height:100% — nested
            in a flex column, that resolves as its flex-basis and the browser's
            default flex-shrink:1 lets it correctly cede space to PageChrome
            above it instead of overflowing by PageChrome's height. Flagged for
            a live visual check in the report regardless (can't confirm without
            a running collab backend, which needs SERVER). */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* With a cover the banner needs the full width above the editor; without
              one the icon/add-cover controls ride in the editor's chrome row so a
              plain page costs one compact line instead of two. */}
          {data.cover && (
            <PageChrome pageId={data.id} space={data.space} icon={data.icon} cover={data.cover} canEdit={chromeEditable} />
          )}
          <div className="min-h-0 flex-1">
            <PageEditor
              pageId={data.id}
              space={data.space}
              pagePath={data.path}
              title={data.title}
              collabUrl={collabUrl}
              readOnly={!editable}
              chromeStart={
                data.cover ? undefined : (
                  <PageChrome pageId={data.id} space={data.space} icon={data.icon} cover={data.cover} canEdit={chromeEditable} compact />
                )
              }
            />
          </div>
        </div>
        <OutlinePanel markdown={data.markdown ?? ''} pageId={data.id} />
      </div>
    </div>
  );
}
