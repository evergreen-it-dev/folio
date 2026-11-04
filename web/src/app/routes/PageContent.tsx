import { useEffect, useState, useRef } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AGENT_FOLDER, officeFormat, type PageDoc } from '@shared/contracts';
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
import { canEditContent, canManageMembers } from '../auth/roles';
import { OutlinePanel } from '../outline/OutlinePanel';
import { PageChrome } from '../page-meta/PageChrome';
import { PagePropertiesPopover, PropertiesBody, PropertiesToggle, usePropertiesOpen } from '../properties/PropertiesPanel';
import { PageConflictBanner } from '../git/PageConflictBanner';
import { AgentDemoNote } from '../AgentDemoNote';
import { trackPageOpen, type PageKind } from '../../analytics';
import { StaticBoardView } from './StaticBoardView';
import { PdfView } from './PdfView';
import { OfficeView } from './OfficeView';
import { CanvasPageView } from './CanvasPageView';
import { ArtifactPageView } from './ArtifactPageView';
import { ReplaceFileDropZone } from '../files/ReplaceFileDropZone';
import { TablePageView, tableRole, type TableViewState } from './TablePageView';
import { FormPageView } from './FormPageView';
import { BasePageView } from '../../bases/BasePageView';
import { PageGone } from './PageGone';
import { NoAccess } from './NoAccess';
import { EmbeddedNotice } from './EmbeddedNotice';
import '../i18n/register';

/** How often an open page asks whether it still exists (see the `page-alive` query in PageContent). */
const PAGE_ALIVE_POLL_MS = 45_000;

export interface PageContentProps {
  id: string;
  /**
   * A column of the compare view (app/compare/): the same page body, but not THE page of the window — it publishes
   * nothing to the shell (header, tab title, recents, analytics), drops the outline panel (a narrow column has no room
   * for it) and answers a missing / forbidden page with a compact notice instead of a full-screen one.
   */
  embedded?: boolean;
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
export function PageContent({ id, embedded = false }: PageContentProps) {
  const { t } = useTranslation('app');
  // The space comes from the URL, not from `data`: when a page did not open
  // (403/404), the page itself is exactly what is missing — and the 403
  // screen (NoAccess) needs the space to decide whether to offer access.
  const { space: routeSpace } = useParams<{ space: string }>();
  // The welcome wizard opens the first document ready to type in. It says so
  // through router state, never the URL: every link to a page — pasted,
  // bookmarked, reloaded — still opens for reading.
  //
  // "Reloaded" takes care: router state is kept in the browser's history
  // entry and comes back after F5, so the request is taken ONCE — remembered
  // for this page while it stays on screen, and wiped from the history entry.
  const route = useLocation();
  const navigate = useNavigate();
  const requested = (route.state as { startEditing?: boolean } | null)?.startEditing === true;
  const editRequest = useRef<string | null>(null);
  if (requested) editRequest.current = id;
  else if (editRequest.current !== id) editRequest.current = null;
  const startEditing = editRequest.current === id;
  useEffect(() => {
    if (requested) navigate(route.pathname + route.search + route.hash, { replace: true, state: null });
  }, [requested, navigate, route.pathname, route.search, route.hash]);
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
  // One open state for the toggle (chrome row) and the body (under it).
  const [propsOpen, setPropsOpen] = usePropertiesOpen(data?.space ?? '');
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
  const spaceRole = useSpaceRole(data?.space);
  // The space role is not the whole answer: page access (restricted pages,
  // per-person grants) can make a space editor a viewer of THIS page, and the
  // collab socket then drops their edits (server/collab.ts makeReadOnly). An
  // editor that accepted typing the server throws away is how text gets lost,
  // so the page's own role — the same session.effectivePageRole the socket
  // uses — caps it once known. Until then (or offline) the space role stands.
  const pageRoleQuery = useQuery({
    queryKey: ['my-page-role', id],
    queryFn: () => api.getMyPageRole(id),
    enabled: Boolean(data) && !isLocalPage && canEditContent(spaceRole),
    staleTime: 30_000,
  });
  const pageRole = pageRoleQuery.data ? pageRoleQuery.data.role : undefined;
  const role = pageRole === undefined || canEditContent(pageRole ?? undefined) ? spaceRole : (pageRole ?? undefined);
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
  // The board's own View | Edit switch lives inside the canvas; the board's properties follow it (reading is reading).
  const [boardEditing, setBoardEditing] = useState(false);

  useDocumentTitle(data?.title, !embedded);
  useSetHeaderInfo(
    data && !embedded
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
  // Optional analytics (off unless the server enables it): which kind of page was opened, never what is on it.
  const openedId = data?.id;
  const openedKind: PageKind | null = !data
    ? null
    : data.path === AGENT_FOLDER || data.path.startsWith(`${AGENT_FOLDER}/`)
      ? 'agent'
      : data.kind === 'folder'
        ? null
        : data.kind;
  useEffect(() => {
    if (!embedded && openedId && openedKind) trackPageOpen(openedKind, routeSpace ?? data?.space ?? '');
    // Keyed on the page: a background refetch of the same page is not another visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openedId, openedKind]);
  useRecordRecentVisit(data && !embedded ? { space: data.space, id: data.id, title: data.title, icon: data.icon } : undefined);

  // A page that is open when its id disappears (the instance was reset, the page was deleted from another tab):
  // the collab socket just fails to reconnect and the editor would sit there, so ask the server now and then
  // whether the page is still there. A 404 re-reads the page, which turns into the "moved or removed" screen.
  // Only a definitive 404 counts; a dropped connection or a 5xx leaves the open page alone.
  const aliveQuery = useQuery({
    queryKey: ['page-alive', id],
    queryFn: () => api.getMyPageRole(id),
    enabled: Boolean(data) && !isLocalPage && !embedded,
    refetchInterval: PAGE_ALIVE_POLL_MS,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const vanished = aliveQuery.error instanceof ApiError && aliveQuery.error.status === 404;
  useEffect(() => {
    if (vanished) void queryClient.invalidateQueries({ queryKey: ['page', id] });
  }, [vanished, id, queryClient]);

  // The id is gone but meant a page that exists (an id derived from its path, server/storage.ts findMovedPage):
  // follow it instead of showing a dead end.
  const pageGone = (isError || !data) && error instanceof ApiError && error.status === 404;
  const movedQuery = useQuery({
    queryKey: ['moved-page', routeSpace ?? '', id],
    queryFn: () => api.getMovedPage(routeSpace ?? '', id),
    enabled: pageGone && !embedded && Boolean(routeSpace),
    retry: false,
  });
  const movedTo = movedQuery.data?.id;
  useEffect(() => {
    if (movedTo && routeSpace) navigate(`/s/${encodeURIComponent(routeSpace)}/p/${encodeURIComponent(movedTo)}${route.search}${route.hash}`, { replace: true });
  }, [movedTo, routeSpace, navigate, route.search, route.hash]);

  if (isLoading) {
    // Offline there is nothing to wait for: either the page is on this
    // device (and `data` is already here) or it is not.
    if (connectivity === 'offline') {
      return <div className="p-8 text-sm text-neutral-500 dark:text-neutral-400">{t('offline.pageUnavailable')}</div>;
    }
    return <div className="p-8 text-sm text-neutral-400">{t('routes.page.loading')}</div>;
  }

  // A page already on screen stays on screen through a failed background refetch (a dropped connection, a 5xx):
  // only a definitive 404 / 403 takes it away. Before, any error unmounted the editor.
  const definitive = error instanceof ApiError && (error.status === 404 || error.status === 403);
  if (!data || (isError && definitive)) {
    // 404: the page really is not there. 403: it exists, the caller has no
    // right to it (a private space without membership, or a restricted page).
    if (error instanceof ApiError && error.status === 404) {
      if (embedded) return <EmbeddedNotice kind="notFound" />;
      // A moment of "loading" while the server says whether an old id meant another page: no flash of the dead end before the redirect.
      if (movedQuery.isLoading || movedTo) return <div className="p-8 text-sm text-neutral-400">{t('routes.page.loading')}</div>;
      return <PageGone space={routeSpace} />;
    }
    if (error instanceof ApiError && error.status === 403) {
      return embedded ? <EmbeddedNotice kind="noAccess" /> : <NoAccess space={routeSpace} page />;
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
        {!isLocalPage && <PagePropertiesPopover pageId={data.id} space={data.space} canEdit={editable} canManageTypes={canManageMembers(spaceRole)} />}
        <div className="ph-mask min-h-0 flex-1">
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
      <div className="ph-mask flex h-full flex-col overflow-y-auto">
        <PageConflictBanner space={data.space} pageId={data.id} />
        {/* The toggle rides in the header (portal), the editors in a popover under it. */}
        <PagePropertiesPopover pageId={data.id} space={data.space} canEdit={editable} canManageTypes={canManageMembers(spaceRole)} />
        <FormPageView pageId={data.id} space={data.space} markdown={data.markdown ?? ''} choices={data.formChoices} canEdit={editable} />
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
        {!isLocalPage && (
          <PagePropertiesPopover pageId={data.id} space={data.space} canEdit={editable && boardEditing} canManageTypes={canManageMembers(spaceRole)} />
        )}
        <div className="ph-no-capture min-h-0 flex-1">
          {/* Viewers never mount BoardEditor — DEV-PLAN Round 2: "boards render
              the fetched svg statically instead of BoardEditor" for that role. */}
          {editable ? <BoardEditor pageId={data.id} onEditingChange={setBoardEditing} /> : <StaticBoardView svg={data.svg} title={data.title} />}
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
        <PagePropertiesPopover pageId={data.id} space={data.space} canEdit={chromeEditable} canManageTypes={canManageMembers(spaceRole)} />
        <ReplaceFileDropZone space={data.space} pageId={data.id} pagePath={data.path} canEdit={chromeEditable} className="ph-no-capture min-h-0 flex-1">
          <PdfView pageId={data.id} title={data.title} version={data.updatedAt} />
        </ReplaceFileDropZone>
      </div>
    );
  }

  if (data.kind === 'canvas') {
    // Obsidian canvas: read-only, no collab room, no OutlinePanel — the icon row
    // a file page gets (the icon lives in the index, never in the file), then the
    // canvas itself; editors get "Convert to Folio board" in its toolbar.
    return (
      <div className="flex h-full flex-col">
        <PageConflictBanner space={data.space} pageId={data.id} />
        <PageChrome pageId={data.id} space={data.space} icon={data.icon} canEdit={chromeEditable} allowCover={false} compact />
        <PagePropertiesPopover pageId={data.id} space={data.space} canEdit={chromeEditable} canManageTypes={canManageMembers(spaceRole)} />
        <div className="ph-no-capture min-h-0 flex-1">
          <CanvasPageView page={data} canConvert={canEditContent(spaceRole) && !isLocalPage} />
        </div>
      </div>
    );
  }

  if (data.kind === 'artifact') {
    // Artifact: an agent-made HTML page, read-only and never in a collab room — the icon row a file page gets, then the
    // sandboxed frame. The bundle is replaced whole ("Replace…" in its toolbar), so Properties are the manifest's own.
    return (
      <div className="flex h-full flex-col">
        <PageConflictBanner space={data.space} pageId={data.id} />
        <PageChrome pageId={data.id} space={data.space} icon={data.icon} canEdit={chromeEditable} allowCover={false} compact />
        <PagePropertiesPopover pageId={data.id} space={data.space} canEdit={chromeEditable} canManageTypes={canManageMembers(spaceRole)} />
        <div className="ph-no-capture min-h-0 flex-1 overflow-y-auto">
          <ArtifactPageView page={data} canReplace={chromeEditable} />
        </div>
      </div>
    );
  }

  if (data.kind === 'base') {
    // Obsidian Bases: a view over the space's pages. No collab room, no OutlinePanel; the icon lives in the
    // index row (like a pdf's). Cells edit THOSE pages' properties, each with its own rights (BasePageView).
    return (
      <div className="flex h-full flex-col">
        <PageConflictBanner space={data.space} pageId={data.id} />
        <PageChrome pageId={data.id} space={data.space} icon={data.icon} canEdit={chromeEditable} allowCover={false} compact />
        <div className="ph-mask min-h-0 flex-1">
          <BasePageView pageId={data.id} space={data.space} canEditBase={editable && !isLocalPage} />
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
        <PagePropertiesPopover pageId={data.id} space={data.space} canEdit={chromeEditable} canManageTypes={canManageMembers(spaceRole)} />
        <ReplaceFileDropZone space={data.space} pageId={data.id} pagePath={data.path} canEdit={chromeEditable} className="ph-no-capture min-h-0 flex-1">
          <OfficeView pageId={data.id} title={data.title} format={officeFormat(data.path) ?? 'docx'} version={data.updatedAt} />
        </ReplaceFileDropZone>
      </div>
    );
  }

  const collabUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`;
  const inAgentFolder = data.path === AGENT_FOLDER || data.path.startsWith(`${AGENT_FOLDER}/`);
  return (
    <div className="flex h-full flex-col">
      <PageConflictBanner space={data.space} pageId={data.id} />
      {inAgentFolder && <AgentDemoNote className="shrink-0 bg-amber-50 px-4 py-1.5 dark:bg-amber-950/40" />}
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
          <div className="ph-mask min-h-0 flex-1">
            <PageEditor
              pageId={data.id}
              space={data.space}
              pagePath={data.path}
              title={data.title}
              lightFootprint={data.lightFootprint === true}
              collabUrl={collabUrl}
              readOnly={!editable}
              comments={!embedded}
              defaultMode={startEditing ? 'live' : 'reading'}
              // Reading is reading (owner, 15.10.2026): in reading mode the properties are shown, never added,
              // edited or removed — even by an editor; Live and Source edit them.
              chromeLead={
                isLocalPage
                  ? undefined
                  : (mode) => (
                      <PropertiesToggle pageId={data.id} space={data.space} canEdit={editable && mode !== 'reading'} open={propsOpen} onToggle={() => setPropsOpen((v) => !v)} />
                    )
              }
              belowChrome={
                isLocalPage
                  ? undefined
                  : (mode) => (
                      <PropertiesBody
                        pageId={data.id}
                        space={data.space}
                        canEdit={editable && mode !== 'reading'}
                        canManageTypes={canManageMembers(spaceRole)}
                        open={propsOpen}
                      />
                    )
              }
              chromeStart={
                data.cover ? undefined : (
                  <PageChrome pageId={data.id} space={data.space} icon={data.icon} cover={data.cover} canEdit={chromeEditable} compact />
                )
              }
            />
          </div>
        </div>
        {!embedded && <OutlinePanel markdown={data.markdown ?? ''} pageId={data.id} />}
      </div>
    </div>
  );
}
