import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Eye, Pencil } from 'lucide-react';
import type { SharedPagePayload, SpaceRole, SubtreeNode } from '@shared/contracts';
import { api, ApiError } from '../api';
import { useDocumentTitle } from '../hooks';
import { useOptionalSessionUser } from '../collabIdentity';
import { Markdown } from '../../markdown';
import { PageEditor } from '../../editor';
import { BoardEditor } from '../../diagrams';
import { StaticBoardView } from '../routes/StaticBoardView';
import { TablePageView } from '../routes/TablePageView';
import { FormPageView } from '../routes/FormPageView';
import '../i18n/register';

/**
 * R23 tail: the `?page=<childId>` variant of GET /api/share/:token. Plain
 * fetch on purpose (same pattern as export/pageExport.ts) — app/api.ts is
 * frozen for this round, and its `getSharedPage` keeps serving the root
 * fetch unchanged; only the query-param variant is built here. Mirrors
 * api.ts's request(): every non-2xx becomes an ApiError carrying the
 * server's own `{ error }` message (there is no 401-relogin concern on a
 * public route).
 */
async function fetchSharedChildPage(token: string, pageId: string): Promise<SharedPagePayload> {
  const res = await fetch(`/api/share/${encodeURIComponent(token)}?page=${encodeURIComponent(pageId)}`);
  if (!res.ok) {
    let message = res.statusText || `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // not JSON — keep the status fallback
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as SharedPagePayload;
}

/**
 * Public `/share/:token` and `/share/:token/p/:pageId` (round 8; child
 * navigation is the R23 tail) — deliberately rendered OUTSIDE <AuthProvider>
 * (see App.tsx's AppRoutes split): no session, no sidebar, no stars/history,
 * nothing that assumes a logged-in user exists. Fetches GET /api/share/:token
 * itself; SettingsProvider/ToastProvider/QueryClient still wrap it (theme +
 * width + toasts are per-browser, not per-account, and this page has no
 * mutations that would need a toast today, but <Markdown>'s broken-link hint
 * uses the same plain-DOM affordance either way).
 *
 * When the token was created with includeChildren the payload carries the
 * subtree, rendered as a COMPACT tree (spec R23 add. 2 SHELL b.2: "a compact
 * tree/list; without the sidebar of the whole space") — an aside at sm+ and a
 * collapsible <details> block on phones. Child pages are read-only by
 * construction (the server forces mode:'view' on them); the root keeps the
 * token's own mode, so an edit link still edits its own page.
 */
export function SharedPageView() {
  const { t } = useTranslation('app');
  const { token, pageId } = useParams<{ token: string; pageId?: string }>();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['shared-page', token, pageId ?? 'root'],
    queryFn: () => (pageId ? fetchSharedChildPage(token!, pageId) : api.getSharedPage(token!)),
    enabled: !!token,
    retry: false,
  });

  useDocumentTitle(data?.page.title);

  // The nav's root row needs the ROOT page's title, which a child payload
  // doesn't carry — read it from the root query's cache when the guest came
  // through the root (the usual path); a direct deep link falls back to a
  // generic label rather than fetching just for a caption.
  const rootData = queryClient.getQueryData<SharedPagePayload>(['shared-page', token, 'root']);
  const rootTitle = data && data.page.id === data.rootPageId ? data.page.title : rootData?.page.title;

  const nav = data?.children && data.rootPageId ? (
    <ShareNavTree
      token={token!}
      rootPageId={data.rootPageId}
      rootTitle={rootTitle ?? t('share.public.navRoot')}
      nodes={data.children}
      currentId={data.page.id}
    />
  ) : null;

  return (
    <div className="flex h-full min-h-screen flex-col bg-white dark:bg-neutral-950">
      <header className="flex shrink-0 items-center gap-3 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <span className="shrink-0 text-sm font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
          Folio
        </span>
        {data && (
          <>
            <span className="shrink-0 text-neutral-300 dark:text-neutral-700" aria-hidden="true">
              /
            </span>
            <span className="min-w-0 truncate text-sm text-neutral-600 dark:text-neutral-400">
              {data.page.icon ? `${data.page.icon} ` : ''}
              {data.page.title}
            </span>
          </>
        )}
        {data && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-neutral-100 px-2.5 py-1 text-xs text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
            {data.mode === 'edit' ? <Pencil size={11} aria-hidden="true" /> : <Eye size={11} aria-hidden="true" />}
            {t('share.public.pill', { mode: t(data.mode === 'edit' ? 'share.public.editMode' : 'share.public.viewMode') })}
          </span>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        {nav && (
          <aside className="hidden w-60 shrink-0 overflow-y-auto border-r border-neutral-200 sm:block dark:border-neutral-800">
            {nav}
          </aside>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {nav && (
            /* Phones: the same tree folded into a native <details> above the
               content — an always-open 15rem aside would eat a 375px screen. */
            <details className="border-b border-neutral-200 sm:hidden dark:border-neutral-800">
              <summary className="cursor-pointer px-4 py-2 text-xs font-medium text-neutral-500 dark:text-neutral-400">
                {t('share.public.navLabel')}
              </summary>
              {nav}
            </details>
          )}
          <div className="min-h-0 flex-1 overflow-auto">
            {isLoading && <div className="p-8 text-sm text-neutral-400">{t('ui.loading')}</div>}
            {isError && (
              <div className="p-8 text-sm text-neutral-500 dark:text-neutral-400">
                {error instanceof ApiError && error.status === 404 ? t('share.public.invalid') : t('share.public.loadFailed')}
              </div>
            )}
            {data && <SharedPageBody payload={data} token={token!} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The compact subtree navigation (NOT the full space sidebar — per spec, a
 * share exposes exactly the token's own subtree). Fully expanded, indented
 * by depth, current page highlighted; every row is a plain client-side
 * <Link> under /share/:token, so navigating stays inside the share and
 * never needs (or leaks) an app session.
 */
function ShareNavTree({ token, rootPageId, rootTitle, nodes, currentId }: {
  token: string;
  rootPageId: string;
  rootTitle: string;
  nodes: SubtreeNode[];
  currentId: string;
}) {
  const { t } = useTranslation('app');

  function row(id: string, title: string, icon: string | undefined, depth: number) {
    const active = id === currentId;
    return (
      <Link
        to={id === rootPageId ? `/share/${token}` : `/share/${token}/p/${id}`}
        aria-current={active ? 'page' : undefined}
        className={`block truncate rounded-md px-2 py-1 text-sm ${
          active
            ? 'bg-neutral-200/70 font-medium text-neutral-900 dark:bg-neutral-700/60 dark:text-neutral-50'
            : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800/70'
        }`}
        style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
      >
        {icon ? `${icon} ` : ''}
        {title}
      </Link>
    );
  }

  function renderNodes(list: SubtreeNode[], depth: number): ReactNode {
    return list.map((node) => (
      <li key={node.id}>
        {row(node.id, node.title, node.icon, depth)}
        {node.children.length > 0 && <ul>{renderNodes(node.children, depth + 1)}</ul>}
      </li>
    ));
  }

  return (
    <nav aria-label={t('share.public.navLabel')} className="p-2">
      <ul>
        <li>{row(rootPageId, rootTitle, undefined, 0)}</li>
        {renderNodes(nodes, 1)}
      </ul>
    </nav>
  );
}

/**
 * Fix/doc-share-role: an 'edit' share link's own `mode` is a STATIC verdict
 * from GET /api/share/:token — it says nothing about a visitor's own
 * session, which server/collab.ts's WS gate honours ahead of any `?share=`
 * token (session wins whenever it grants this page viewer+ access; see that
 * file's attachToServer). Mirrors BoardCanvas.tsx's identical fetch of
 * GET /api/pages/:id/my-role (session.effectivePageRole — the exact call the
 * WS upgrade itself makes) so the doc editor's `readOnly` prop matches what
 * the socket will actually accept, instead of trusting the link's own mode.
 *
 * Returns 'loading' until the verdict is known — never a premature `true`
 * that could let someone start typing into a room about to reject every
 * update. A confirmed-anonymous visitor (`sessionUser === null`) skips the
 * round trip entirely and falls straight to `staticEditable` (the link's own
 * mode) — there is no session role to ask for, same as before this fix.
 *
 * `enabled` gates the my-role fetch to the one branch that needs it (a doc
 * rendered in 'edit' mode) — called unconditionally either way (rules of
 * hooks), but a table/board/form/pdf page, or a doc opened in 'view' mode,
 * never spends the round trip on an answer nothing reads.
 */
function useShareDocRole(pageId: string, staticEditable: boolean, enabled: boolean): boolean | 'loading' {
  const sessionUser = useOptionalSessionUser();
  const [role, setRole] = useState<SpaceRole | null | 'unknown'>('unknown');
  // A three-way marker, not just `sessionUser?.id`: "still loading"
  // (undefined) and "confirmed anonymous" (null) both hash to the same
  // `undefined` id, which would leave the effect below never re-running for
  // the undefined -> null transition — unlike editor/collab.ts's identical-
  // looking dependency, where both states fall to the SAME anonUser()
  // outcome, here they must reach different branches (stay 'unknown' vs.
  // resolve to `null`).
  const sessionKey = sessionUser === undefined ? 'loading' : sessionUser === null ? 'anon' : sessionUser.id;

  useEffect(() => {
    if (!enabled) {
      setRole('unknown');
      return;
    }
    setRole('unknown');
    // Still waiting on GET /api/auth/state — stay 'unknown' rather than
    // guessing; the effect reruns the moment it settles (sessionKey above).
    if (sessionUser === undefined) return;
    if (!sessionUser) {
      setRole(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getMyPageRole(pageId);
        if (!cancelled) setRole(res.role ?? null);
      } catch {
        if (!cancelled) setRole(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionKey stands in for sessionUser (object identity isn't stable across renders)
  }, [pageId, enabled, sessionKey]);

  if (role === 'unknown') return 'loading';
  // `null`: no session access at all (including a genuinely anonymous
  // visitor) — the link's own resolved mode is the only grant there is,
  // exactly as before this fix. A real granted role governs outright,
  // whichever way it points, same as the WS gate itself.
  if (role === null) return staticEditable;
  return role === 'editor' || role === 'admin';
}

function SharedPageBody({ payload, token }: { payload: SharedPagePayload; token: string }) {
  const { t } = useTranslation('app');
  const { mode, page } = payload;
  // R23 tail: a page other than the token's own. The server already forces
  // mode:'view' on these; this flag additionally picks the STATIC board
  // surface below, because BoardEditor's share plumbing (fetch and save via
  // /api/share/:token with no page param) only ever talks about the ROOT board.
  const isChild = payload.rootPageId !== undefined && page.id !== payload.rootPageId;
  // Only the doc 'edit' branch below reads this — every other kind/mode
  // combination gets 'enabled: false' above, so the my-role round trip is
  // never spent on an answer nothing reads.
  const docRole = useShareDocRole(page.id, mode === 'edit', page.kind === 'doc' && mode === 'edit');

  if (page.kind === 'table') {
    // Round 26 (DATA TABLES), spec §12/§17.11. The role is the TOKEN's mode
    // and nothing else: a `view` link must never hand a guest an editable
    // grid, and there is no session here to fall back on. `edit` gets the
    // real live surface — server/collab.ts's WS gate resolves a `?share=`
    // token to viewer/editor exactly like it does for a prose page, so a
    // guest's edits are ordinary CRDT updates the other clients see.
    // R23 tail: CHILD tables ride the same branch — the WS gate grants a
    // subtree token its child rooms as viewer, and `mode` is already 'view'.
    return (
      <div className="h-full w-full">
        <TablePageView pageId={page.id} role={mode === 'edit' ? 'editor' : 'viewer'} collabParams={{ share: token }} />
      </div>
    );
  }

  if (page.kind === 'form') {
    // Round FORMS: the owner's "public" flow — an anonymous visitor with the
    // form's OWN share link fills it in with no session at all. `canEdit`
    // is always false here (no session, no role); `space` is omitted so
    // FormPageView never tries the editor-only "view table" resolve, which
    // would 401 for a guest anyway.
    return (
      <div className="mx-auto w-full max-w-xl">
        <FormPageView pageId={page.id} markdown={page.markdown ?? ''} canEdit={false} shareToken={token} />
      </div>
    );
  }

  if (page.kind === 'pdf' || page.kind === 'office') {
    // Sharing a pdf/office page's FILE isn't implemented yet (server/routes.ts's
    // GET /api/pages/:id/file only accepts a session, not a share token) —
    // this just keeps a share link to one from rendering a broken/blank
    // editor instead of falling through to the doc branch below.
    return (
      <div className="p-8 text-sm text-neutral-500 dark:text-neutral-400">{page.title}</div>
    );
  }

  if (page.kind === 'board') {
    if (isChild) {
      // Static by design (not a BoardEditor in view mode): the board share
      // plumbing saves via PUT /api/share/:token/board, which writes the
      // token's OWN page — mounting it for a child could save over the root.
      return <StaticBoardView svg={page.svg} title={page.title} />;
    }
    // DIAGRAMS added shareToken/shareMode to BoardEditor (round 8 follow-up)
    // specifically so this can be real editing, not a static fallback —
    // BoardEditor/BoardCanvas resolve read-only vs write access from these
    // two props instead of a session, the same way PageEditor resolves it
    // from collabParams below.
    return (
      <div className="h-full w-full">
        <BoardEditor pageId={page.id} shareToken={token} shareMode={mode} />
      </div>
    );
  }

  if (mode === 'edit') {
    // Fix/doc-share-role: wait for the real verdict before mounting anything
    // editable — a premature 'true' here would let someone start typing into
    // a room the socket is about to reject every update from (see
    // useShareDocRole's own docblock above). The wait is brief: for a
    // genuinely anonymous guest it resolves the instant GET /api/auth/state
    // settles to "no session", no extra round trip.
    if (docRole === 'loading') {
      return <div className="p-8 text-sm text-neutral-400">{t('ui.loading')}</div>;
    }
    // Live editing via the link: collabParams carries the share token as a WS
    // query param (?share=<token> lands AFTER the room name — that's how
    // server/collab.ts expects it). Only ever the ROOT page: child payloads
    // arrive as mode:'view' from the server.
    const wsBase = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`;
    return (
      <div className="min-h-0 flex-1">
        <PageEditor
          pageId={page.id}
          space={page.space}
          pagePath={page.path}
          collabUrl={wsBase}
          collabParams={{ share: token }}
          // The socket had the token; everything else the editor renders needs
          // it too — /files answers 401 to a session-free guest without it, so
          // an edit link used to show a broken image in reading and an empty
          // one in live. Same token, same round-8 ?share= contract.
          shareToken={token}
          // Fix/doc-share-role: the resolved verdict, not the link's own
          // static mode — PageEditor itself also clamps mode to 'reading'
          // whenever readOnly is true (see editor/index.tsx), so a viewer
          // never even gets a CodeMirror view to type into.
          readOnly={!docRole}
          // Round 22 made 'reading' the app-wide default; an edit share link
          // exists precisely so a guest can type, so it opens in live instead
          // — moot when readOnly above forces 'reading' regardless.
          defaultMode="live"
        />
      </div>
    );
  }

  return (
    // No pageId: Markdown's own contract is that this is what hides the
    // backlinks section for a session-free reader.
    // shareToken (round 8 follow-up): keeps repo-relative images/files
    // working (SERVER's /files now accepts ?share=<token>) and stops the
    // relative-page-link click handler from ever calling the session-only
    // /api/resolve — see markdown/index.tsx and relativeLinks.ts.
    <Markdown markdown={page.markdown ?? ''} space={page.space} pagePath={page.path} shareToken={token} />
  );
}
