import {
  acceptInviteBodySchema,
  accessBulkBodySchema,
  createApiTokenBodySchema,
  createInviteBodySchema,
  createShareLinkBodySchema,
  connectSpaceGitBodySchema,
  createUserBodySchema,
  listBranchesBodySchema,
  saveGitCredentialBodySchema,
  setupBodySchema,
  updateMyPreferencesBodySchema,
  updateSpaceVisibilityBodySchema,
  updateUserBodySchema,
} from '@shared/contracts';
import type { z } from 'zod';
import { visitorHeaders } from '../analytics';
import { getConnectivity, reportRequest } from './offline/connectivity';
import { sortTreeSiblings } from './sidebar/reorderPages';
import type {
  AccessBulkResult,
  AccessLogEntry,
  AccessMatrixResponse,
  AccessRequestSummary,
  ApiTokenInfo,
  OAuthConnectionInfo,
  ActiveAssistantRunResponse,
  AdminAssistantAccess,
  AdminAssistantConversationDetail,
  AdminAssistantConversationViews,
  AdminAssistantConversationsResponse,
  AdminAssistantUnansweredResponse,
  AssistantFeedbackRating,
  AssistantFeedbackResponse,
  AssistantSurveyBody,
  AssistantConnectionCheck,
  AssistantConversation,
  AssistantConversationsResponse,
  AssistantModelsResponse,
  AssistantSettings,
  AuthState,
  ConfluenceCredentialInfo,
  ConfluenceImportRequest,
  CopyPageBody,
  DuplicatePageBody,
  CreatedApiToken,
  CreatePageBody,
  CreateSpaceGitBody,
  DecideAccessRequestBody,
  GitCredentialInfo,
  GitProviderRepos,
  GitRepoTreeResponse,
  ImportJob,
  InviteInfo,
  InvitePublicInfo,
  MentionableUser,
  MovePageBody,
  NotificationListResponse,
  PageDoc,
  PageAccessInfo,
  PageHistoryEntry,
  PageChangeInfo,
  PageMeta,
  RenamePageBody,
  RepoBranches,
  ResetToRemoteResponse,
  SearchHit,
  SendAssistantMessageBody,
  ShareLinkInfo,
  SharedPagePayload,
  SpaceInfo,
  SpaceGitInfo,
  SpaceMemberInfo,
  SpaceRole,
  SpaceVisibility,
  Stars,
  StartAssistantRunResponse,
  SubmitFormBody,
  SubmitFormResponse,
  TableColumn,
  TableRow,
  TableView,
  TrashListResponse,
  TrashRestoreResponse,
  TreeNode,
  UiLanguage,
  UpdatePageBody,
  UpdatePageAccessBody,
  UndoPageChangeResponse,
  User,
  UserAccessResponse,
  ValidateRecentPagesBody,
} from '@shared/contracts';

// contracts.ts exports these body shapes as zod schemas only (no `z.infer`
// type alias, unlike e.g. CreatePageBody) — deriving the types here keeps
// them in lockstep with the schema SERVER actually validates against,
// rather than hand-duplicating the shape.
type SetupBody = z.infer<typeof setupBodySchema>;
type CreateUserBody = z.infer<typeof createUserBodySchema>;
type UpdateUserBody = z.infer<typeof updateUserBodySchema>;
type UpdateMyPreferencesBody = z.infer<typeof updateMyPreferencesBodySchema>;
type ListBranchesBody = z.infer<typeof listBranchesBodySchema>;
type ConnectSpaceGitBody = z.infer<typeof connectSpaceGitBodySchema>;
type CreateApiTokenBody = z.infer<typeof createApiTokenBodySchema>;
type CreateShareLinkBody = z.infer<typeof createShareLinkBodySchema>;
type CreateInviteBody = z.infer<typeof createInviteBodySchema>;
type AcceptInviteBody = z.infer<typeof acceptInviteBodySchema>;
type SaveGitCredentialBody = z.infer<typeof saveGitCredentialBodySchema>;
type AccessBulkBody = z.infer<typeof accessBulkBodySchema>;
type UpdateSpaceVisibilityBody = z.infer<typeof updateSpaceVisibilityBodySchema>;

export class ApiError extends Error {
  status: number;
  /**
   * The full parsed JSON error body, when there was one — added for forms'
   * submit (`{ error, fields }`, per-column validation messages); every
   * existing catch site only ever read `.message`/`.status`, so this is a
   * purely additive, optional field.
   */
  body?: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Fired on window whenever any request comes back 401 (no/invalid session —
 * distinct from 403, insufficient role, which is just a normal error). This
 * is a plain DOM event rather than an imported callback specifically so
 * markdown/'s own standalone fetch (see index.tsx's click handler) can raise
 * it too without creating an app/ <-> markdown/ import edge — see that
 * file's comment for why that edge would be a real circular-import risk.
 */
export const UNAUTHORIZED_EVENT = 'folio:unauthorized';
/** Tells the sidebar that a successful structural mutation may have changed the personal undo stack. */
export const PAGE_CHANGES_EVENT = 'folio:page-changes';

function notifyPageChanges(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PAGE_CHANGES_EVENT));
}

/**
 * Statuses worth retrying: the PaaS proxy's own transient failures while a
 * container restarts mid-deploy (~30–60s window), not anything the app
 * server itself returned deliberately. Exported for the retry unit test.
 */
export function shouldRetry(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

/**
 * Pause before each retry attempt (index 0 = before the 2nd attempt, etc.),
 * chosen to span a typical redeploy restart window: 400ms + 1s + 2.5s ≈
 * 3.9s of retrying on top of the original attempt, 4 attempts total.
 * Exported for the retry unit test.
 */
export const retryDelays = [400, 1000, 2500];

const IDEMPOTENT_METHODS = new Set(['GET', 'PUT', 'DELETE']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A network-level failure (offline, DNS, connection reset) — fetch rejects with this rather than resolving with a bad status. */
function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

/** Filters shared by the admin assistant-analytics lists; empty values are left out of the query string. */
export interface AdminAssistantFilters {
  space?: string;
  userId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

function queryString(filters?: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters ?? {})) if (value !== undefined && value !== '') params.set(key, String(value));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  // FormData (asset upload) must NOT get a hand-set content-type — fetch
  // sets its own `multipart/form-data; boundary=...` from the FormData body,
  // and overriding it to application/json would break the upload server-side.
  const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData;
  const headers = init?.body && !isFormData ? { 'content-type': 'application/json', ...init.headers } : init?.headers;
  // Retry only idempotent methods (a retried POST could create a duplicate)
  // with a replayable body (a FormData body may have already been consumed
  // by the failed attempt's upload stream).
  const retryEligible = IDEMPOTENT_METHODS.has((init?.method ?? 'GET').toUpperCase()) && !isFormData;

  let res: Response;
  let attempt = 0;
  for (;;) {
    try {
      res = await fetch(input, { ...init, headers });
      // Any answer at all — a 403 included — proves the server is reachable;
      // only a 5xx from the proxy says otherwise (offline/connectivity.ts).
      reportRequest(res.status < 500);
    } catch (error) {
      if (isNetworkError(error)) reportRequest(false);
      // Retrying is for a hiccup. With the connection known to be down it is
      // four seconds of «Loading…» in front of an answer that is already
      // known (the owner, 29.09.2026: "if a page is not available offline,
      // say so, not 'loading'").
      if (retryEligible && isNetworkError(error) && attempt < retryDelays.length && getConnectivity() !== 'offline') {
        await sleep(retryDelays[attempt]);
        attempt++;
        continue;
      }
      throw error;
    }
    if (!res.ok && retryEligible && shouldRetry(res.status) && attempt < retryDelays.length) {
      await sleep(retryDelays[attempt]);
      attempt++;
      continue;
    }
    break;
  }
  if (!res.ok) {
    let message = res.statusText || `HTTP ${res.status}`;
    let parsedBody: unknown;
    try {
      parsedBody = (await res.json()) as { error?: string };
      const errorField = (parsedBody as { error?: string } | undefined)?.error;
      if (errorField) message = errorField;
    } catch {
      // Response wasn't JSON (or was empty) — keep the statusText fallback.
    }
    if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(res.status, message, parsedBody);
  }
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    // 2xx with an empty/non-JSON body (e.g. a bare "OK" from login/logout) —
    // callers that need data re-fetch the canonical GET afterward anyway.
    return undefined as T;
  }
}

/**
 * Tree response, loosely typed: the DEV-PLAN leaves it up to the server
 * whether the space-root index page is exposed as `tree[0]` or as a
 * separate `home` field, so the sidebar handles both shapes defensively.
 */
export interface TreeResponse {
  tree: TreeNode[];
  home?: TreeNode;
}

/**
 * GET /api/admin/spaces row shape (round 22, SERVER item 3 — not yet in
 * shared/contracts.ts). `username` mirrors User's own optional @handle field.
 */
export interface AdminSpaceMember {
  userId: string;
  name: string;
  email: string;
  username?: string;
  role: SpaceRole;
}

export interface AdminSpaceInfo {
  slug: string;
  name: string;
  kind: 'local' | 'remote';
  pageCount: number;
  members: AdminSpaceMember[];
  /** Round 27 (access and rights): mirrors server/routes.ts's AdminSpaceInfo — see docs/spec-access.md §8. */
  visibility: SpaceVisibility;
  /** Round 27: members.filter(m => m.role === 'admin').length, precomputed server-side. */
  adminCount: number;
  git: SpaceGitInfo;
}

/**
 * Round 26 (DATA TABLES) — `GET /api/tables/:pageId`'s response, mirroring
 * server/tables/service.ts's own `TableSnapshot`. Not in shared/contracts.ts:
 * the round's brief keeps the table REST envelopes in server/tables/routes.ts
 * (only the table DOMAIN types — TableDoc/TableColumn/TableView/TableRow —
 * are contract-level), so this follows AdminSpaceInfo's precedent above.
 *
 * Note `meta` is the PAGE's meta (id/space/path/title/icon/kind), NOT
 * TableDoc['meta']; the table's own head/tail prose isn't in this envelope,
 * which is why the live surface reads the document from the CRDT and uses
 * this only for page identity — see routes/PageContent.tsx.
 */
export interface TableSnapshot {
  meta: PageMeta;
  columns: TableColumn[];
  views: TableView[];
  rows: TableRow[];
}

export const api = {
  /**
   * Instance-wide config (round 5 follow-up: create-space prefill). Not yet
   * in shared/contracts.ts (SERVER adding it) — caller must degrade
   * silently on a 404/error (no toast, just leave the prefill fields
   * empty, same as before this endpoint existed).
   */
  getConfig: () => request<{ defaultRepoUrl?: string }>('/api/config'),

  listSpaces: () => request<{ spaces: SpaceInfo[] }>('/api/spaces'),

  /** Round 3: empty space (name only) or git-backed (repoUrl/branch/rootPath/token) — same endpoint, richer body. */
  createSpace: (body: CreateSpaceGitBody) =>
    request<SpaceInfo>('/api/spaces', { method: 'POST', body: JSON.stringify(body) }),

  getSpaceImportProgress: (id: string) =>
    request<import('@shared/contracts').SpaceImportProgress>(`/api/spaces/import-progress/${encodeURIComponent(id)}`),

  /**
   * Round 5 follow-up: branch autocomplete for the create-space git tab.
   * Caller must degrade to free-text silently on a 404/error — this
   * endpoint is new (SERVER adding it alongside the contract).
   */
  listBranches: (body: ListBranchesBody) =>
    request<RepoBranches>('/api/git/branches', { method: 'POST', body: JSON.stringify(body) }),

  /**
   * The page tree, re-sorted per level by sidebar/reorderPages' own
   * `sortTreeSiblings` — see its doc comment for why the server's `(order,
   * title)` sort is not the final word (a directory with no index.md has
   * nowhere to persist an order, so it must not be flushed to the end of its
   * level the moment a sibling page gets one). Done HERE, at the single
   * fetch point every caller shares, rather than per-consumer: the sidebar,
   * the folder listing and the reorder/drag math must all index into the
   * same sibling arrays or "one slot down" means different things to each.
   */
  getTree: async (space: string): Promise<TreeResponse> => {
    const data = await request<TreeResponse>(`/api/spaces/${encodeURIComponent(space)}/tree`);
    return { ...data, tree: sortTreeSiblings(data.tree) };
  },

  validateRecentPages: (body: ValidateRecentPagesBody) =>
    request<{ valid: string[] }>('/api/pages/validate-recents', { method: 'POST', body: JSON.stringify(body) }),

  /** Manual sync (commit+pull+push); 409 while a conflict is unresolved. Body isn't relied on — callers re-fetch ['spaces'] after. */
  syncSpace: (space: string) => request<{ git: SpaceGitInfo }>(`/api/spaces/${encodeURIComponent(space)}/sync`, { method: 'POST' }),

  /**
   * "Take the version from Git" — throws away everything local for the space and
   * matches origin/<branch> exactly, keeping a backup branch server-side.
   * Space-admin-gated (see server/routes.ts's own guard comment). Callers
   * re-fetch ['spaces'] and ['tree', space] after, same as syncSpace/
   * connectGitSpace.
   */
  resetSpaceToRemote: (space: string) =>
    request<ResetToRemoteResponse>(`/api/spaces/${encodeURIComponent(space)}/git/reset-to-remote`, { method: 'POST' }),

  /**
   * "Connect git" on an already-existing LOCAL space (ConnectGitDialog).
   * 409 when the target repository isn't empty — the space's own local
   * content/history is never touched in that case (see server/storage.ts's
   * connectSpaceToRepo doc comment). Returns the updated SpaceInfo on
   * success — callers re-fetch ['spaces'] regardless, same as syncSpace.
   */
  connectGitSpace: (space: string, body: ConnectSpaceGitBody) =>
    request<SpaceInfo>(`/api/spaces/${encodeURIComponent(space)}/connect-git`, { method: 'POST', body: JSON.stringify(body) }),

  createPage: async (body: CreatePageBody) => {
    const page = await request<PageMeta>('/api/pages', { method: 'POST', body: JSON.stringify(body) });
    notifyPageChanges();
    return page;
  },

  getPage: (id: string) => request<PageDoc>(`/api/pages/${encodeURIComponent(id)}`),

  /**
   * The only way a pdf/office page is created from the UI (createPage above
   * rejects kind:'pdf'/'office' server-side — see server/storage.ts's
   * createPage doc comment). Same multipart shape as uploadAsset, plus an
   * optional "parentPath" text field the server reads off the file part's
   * own `.fields` (see POST /api/spaces/:space/file's doc comment).
   */
  uploadFile: async (space: string, parentPath: string, file: File) => {
    const body = new FormData();
    if (parentPath) body.append('parentPath', parentPath);
    body.append('file', file, file.name);
    const page = await request<PageMeta>(`/api/spaces/${encodeURIComponent(space)}/file`, { method: 'POST', body });
    notifyPageChanges();
    return page;
  },

  /** GET /api/pages/:id/file — inline by default; `?download=1` for the toolbar's "Download" button. Serves both pdf and office (docx/xlsx/pptx) pages. */
  pageFileUrl: (id: string, download?: boolean) => `/api/pages/${encodeURIComponent(id)}/file${download ? '?download=1' : ''}`,

  getPageAccess: (id: string) => request<PageAccessInfo>(`/api/pages/${encodeURIComponent(id)}/access`),

  /**
   * Fix/share-identity: the caller's own effective role on `id`, straight
   * from the session cookie — `null` if that session grants no access at
   * all (the correct answer for "this page isn't mine", not an error). Lets
   * a share-link board/doc view (which has a real pageId but no other way to
   * ask "does MY session — not the link's own mode — actually let me edit
   * this") match exactly what the collab socket will grant, instead of
   * guessing from the share link's static mode alone.
   */
  getMyPageRole: (id: string) => request<{ role: SpaceRole | null }>(`/api/pages/${encodeURIComponent(id)}/my-role`),

  updatePageAccess: (id: string, body: UpdatePageAccessBody) =>
    request<PageAccessInfo>(`/api/pages/${encodeURIComponent(id)}/access`, { method: 'PUT', body: JSON.stringify(body) }),

  updatePage: (id: string, body: UpdatePageBody) =>
    request<PageMeta>(`/api/pages/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),

  /**
   * Round 22 (SHELL-1, tree-order): sets one page's explicit sibling order —
   * used by the tree row "…" menu's Up/Down and by dropping a dragged row
   * (see sidebar/reorderPages.ts for the algorithm that decides which id(s)
   * to call this for). Reuses the plain page PUT rather than a new route,
   * same as icon/cover already do for a partial update.
   *
   * Live for all three page kinds now that boards and tables have somewhere
   * to persist an order: a doc's frontmatter `order`, a board's
   * `<!-- folio-order: N -->` svg comment, a table's own frontmatter `order`
   * key (server/storage.ts's setDocOrder / setBoardOrder / setTableOrder).
   */
  reorderPage: (id: string, order: number) =>
    request<PageMeta>(`/api/pages/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ order }) }),

  movePage: async (id: string, body: MovePageBody) => {
    const page = await request<PageMeta>(`/api/pages/${encodeURIComponent(id)}/move`, { method: 'POST', body: JSON.stringify(body) });
    notifyPageChanges();
    return page;
  },

  copyPage: async (id: string, body: CopyPageBody) => {
    const page = await request<PageMeta>(`/api/pages/${encodeURIComponent(id)}/copy`, { method: 'POST', body: JSON.stringify(body) });
    notifyPageChanges();
    return page;
  },

  /** The page copied next to itself, whole subtree included — see server/storage.ts's duplicatePage. */
  duplicatePage: async (id: string, body: DuplicatePageBody) => {
    const page = await request<PageMeta>(`/api/pages/${encodeURIComponent(id)}/duplicate`, { method: 'POST', body: JSON.stringify(body) });
    notifyPageChanges();
    return page;
  },

  renamePage: async (id: string, body: RenamePageBody) => {
    const page = await request<PageMeta>(`/api/pages/${encodeURIComponent(id)}/rename`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    notifyPageChanges();
    return page;
  },

  /**
   * Round 22 (SHELL-4/SERVER slug-api): renames the page's own file/directory
   * segment (the URL-facing "slug"), distinct from `renamePage`'s H1/display
   * title. `id` never changes. SERVER is building this in parallel — see
   * sidebar/ChangeSlugDialog.tsx for the 409 (slug taken) / 404 (endpoint not
   * live yet) handling this caller does around the call.
   */
  changePageSlug: async (id: string, slug: string) => {
    const page = await request<PageMeta>(`/api/pages/${encodeURIComponent(id)}/slug`, { method: 'POST', body: JSON.stringify({ slug }) });
    notifyPageChanges();
    return page;
  },

  /** The personal stack of structural changes in the current space, newest first. */
  listPageChanges: (space: string) =>
    request<{ changes: PageChangeInfo[] }>(`/api/spaces/${encodeURIComponent(space)}/changes?limit=10`),

  /** Undoes the chosen change of one's own, if its target state has not become incompatible since. */
  undoPageChange: (space: string, id: string) =>
    request<UndoPageChangeResponse>(`/api/spaces/${encodeURIComponent(space)}/changes/${encodeURIComponent(id)}/undo`, { method: 'POST' }),

  deletePage: (id: string) => request<{ ok: true }>(`/api/pages/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  search: (q: string, space: string) =>
    request<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}&space=${encodeURIComponent(space)}`),

  resolve: (space: string, path: string) =>
    request<PageMeta>(`/api/resolve?space=${encodeURIComponent(space)}&path=${encodeURIComponent(path)}`),

  // ---------- data tables (round 26) ----------

  /**
   * Whole table in one response, up to the hard row limit (spec §8/§13).
   * The live surface edits through the CRDT, not through this — see
   * routes/PageContent.tsx — so this is used for page identity and as the
   * non-collab read path.
   */
  getTable: (pageId: string) => request<TableSnapshot>(`/api/tables/${encodeURIComponent(pageId)}`),

  /**
   * Round FORMS follow-up ("+ Add field"): creates a column on a table from
   * a DIFFERENT page (the paired form's own definition editor), which has no
   * live collab room of its own to piggyback a Y.Doc edit through — the
   * plain REST path (server/tables/service.ts#addColumn) is the right one
   * here, and it's the SAME function the table's own live AddColumnButton
   * reaches when no collab room is open (server/tables/service.ts#applyPatch
   * routes through the live doc automatically when one *is* open elsewhere),
   * so this is still the one writer, never a second one.
   */
  addTableColumn: (tableId: string, name: string, type: TableColumn['type'], options?: TableColumn['options']) =>
    request<TableColumn>(`/api/tables/${encodeURIComponent(tableId)}/columns`, {
      method: 'POST',
      body: JSON.stringify({ name, type, options }),
    }),

  // ---------- forms ----------

  /** "Create a form" on an existing table page — writes a paired `<slug>.form.md` with fields derived from its columns (server/storage.ts#createFormFromTable). */
  createFormFromTable: async (tableId: string) => {
    const page = await request<PageMeta>(`/api/pages/${encodeURIComponent(tableId)}/create-form`, { method: 'POST' });
    notifyPageChanges();
    return page;
  },

  /**
   * The paired table's page id, resolved SERVER-side (server/forms/
   * service.ts#resolvePairedTableId) rather than via a client-side
   * `resolve(space, form.table)` path lookup — that path can go stale (a
   * move/slug rename on either side of the pair, or an ancestor directory of
   * either) and nothing rewrote it; this resolves by the pair's actual tree
   * position when the stored path no longer matches, and self-heals it for
   * next time. A genuine 404 here means the table really is gone.
   */
  resolveFormTable: (formId: string) => request<{ id: string }>(`/api/forms/${encodeURIComponent(formId)}/table`),

  /**
   * POST /api/forms/:id/submit — OUTSIDE the session-required scope on the
   * server (server/forms/routes.ts): a signed-in member's cookie still rides
   * along automatically (credentials: 'include', same as every other call
   * through `request` below), and an anonymous share guest sends
   * `shareToken` instead. A 400 carries `fields` (per-column validation
   * errors) — thrown as `ApiError` like any other failure; callers read
   * `(err as ApiError).body?.fields` for the inline per-field messages.
   */
  submitForm: (formId: string, body: SubmitFormBody) =>
    request<SubmitFormResponse>(`/api/forms/${encodeURIComponent(formId)}/submit`, { method: 'POST', body: JSON.stringify(body) }),

  /**
   * Who can be named in a `user` column (round 26) — the same round-15
   * endpoint the editor's `@` picker reads through its own in-memory cache
   * (editor/mention-index.ts). Fetched here through react-query instead of
   * that cache so app/ doesn't take an import edge on editor/'s internals.
   */
  listMentionable: (space: string) =>
    request<{ users: MentionableUser[] }>(`/api/spaces/${encodeURIComponent(space)}/mentionable`),

  // ---------- auth (round 2) ----------

  /** Public. Drives the client auth gate: needsSetup | logged out | logged in. */
  getAuthState: () => request<AuthState>('/api/auth/state', { headers: visitorHeaders() }),

  /** First-run only (409 once a user exists). The response body isn't relied on — callers re-fetch auth state after. */
  setupInstance: (body: SetupBody) =>
    request<unknown>('/api/auth/setup', { method: 'POST', body: JSON.stringify(body) }),

  login: (email: string, password: string) =>
    request<unknown>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }), headers: visitorHeaders() }),

  logout: () => request<unknown>('/api/auth/logout', { method: 'POST' }),

  // ---------- users admin (instance admin only) ----------

  listUsers: () => request<{ users: User[] }>('/api/users'),

  createUser: (body: CreateUserBody) =>
    request<User>('/api/users', { method: 'POST', body: JSON.stringify(body) }),

  updateUser: (id: string, body: UpdateUserBody) =>
    request<User>(`/api/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),

  // ---------- admin: all spaces (round 22, instance admin only) ----------

  /**
   * A bare array, per the documented response shape (unlike listSpaces/
   * listUsers/listMembers's own `{ spaces }`/`{ users }`/`{ members }`
   * wrapper convention). Round 27: now includes `visibility`/`adminCount`
   * per space (see AdminSpaceInfo above); caller is admin/access/SpacesTab.tsx.
   */
  listAdminSpaces: () => request<AdminSpaceInfo[]>('/api/admin/spaces'),

  renameSpace: (slug: string, name: string) =>
    request<SpaceInfo>(`/api/admin/spaces/${encodeURIComponent(slug)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  deleteSpace: (slug: string) =>
    request<{ ok: true }>(`/api/admin/spaces/${encodeURIComponent(slug)}`, { method: 'DELETE' }),

  // ---------- space members (space admin+) ----------

  listMembers: (space: string) =>
    request<{ members: SpaceMemberInfo[] }>(`/api/spaces/${encodeURIComponent(space)}/members`),

  /** `identifier` is a userId when picked from the instance-admin user list, or a raw email when a plain-email add (server resolves either). */
  setMember: (space: string, identifier: string, role: SpaceRole) =>
    request<unknown>(`/api/spaces/${encodeURIComponent(space)}/members/${encodeURIComponent(identifier)}`, {
      method: 'PUT',
      body: JSON.stringify({ role }),
    }),

  removeMember: (space: string, userId: string) =>
    request<{ ok: true }>(`/api/spaces/${encodeURIComponent(space)}/members/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    }),

  // ---------- stars ----------

  getStars: () => request<Stars>('/api/me/stars'),

  setSpaceStar: (slug: string, starred: boolean) =>
    request<unknown>(`/api/me/stars/space/${encodeURIComponent(slug)}`, {
      method: 'PUT',
      body: JSON.stringify({ starred }),
    }),

  setPageStar: (id: string, starred: boolean) =>
    request<unknown>(`/api/me/stars/page/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ starred }),
    }),

  /**
   * Round 6: emoji favorites, same `kind`-scoped stars shape as space/page
   * (queued behind a P0 on SERVER's side) — 404 until it lands, degraded
   * gracefully by callers (web/src/emoji/useEmojiFavorites.ts), not here.
   */
  setEmojiStar: (emoji: string, starred: boolean) =>
    request<unknown>(`/api/me/stars/emoji/${encodeURIComponent(emoji)}`, {
      method: 'PUT',
      body: JSON.stringify({ starred }),
    }),

  // ---------- page history (round 3, git-native) ----------

  getPageHistory: (id: string) =>
    request<{ history: PageHistoryEntry[] }>(`/api/pages/${encodeURIComponent(id)}/history`).then((d) => d.history),

  /**
   * `{ markdown }` for a doc sha, `{ svg }` for a board sha (coordinator,
   * round-5 follow-up: "history for boards") — same PageDoc-style field
   * naming as the live page fetch, just optional since only one of the two
   * is ever populated depending on the page's kind. Callers branch on
   * whichever is present — see HistoryPanel.tsx's HistoryVersionPreview.
   */
  getPageHistoryVersion: (id: string, sha: string) =>
    request<{ markdown?: string; svg?: string }>(`/api/pages/${encodeURIComponent(id)}/history/${encodeURIComponent(sha)}`),

  restoreVersion: (id: string, sha: string) =>
    request<PageMeta>(`/api/pages/${encodeURIComponent(id)}/restore/${encodeURIComponent(sha)}`, { method: 'POST' }),

  // ---------- assets (round 3b, store) ----------

  /**
   * Multipart upload (editor+) -> content-addressed URL, per DEV-PLAN's
   * asset store section. Field name must stay "file" — matches EDITOR's own
   * uploadAsset in editor/uploads.ts (not imported from here: app/ and
   * editor/ are separate ownership areas, kept independent deliberately).
   */
  uploadAsset: (space: string, file: File) => {
    const body = new FormData();
    body.append('file', file, file.name);
    return request<{ url: string }>(`/api/spaces/${encodeURIComponent(space)}/assets`, { method: 'POST', body });
  },

  // ---------- templates (round 5, create-from-template) ----------

  /**
   * Not yet in shared/contracts.ts (SERVER round-5 item) but confirmed live
   * (2026-08-20 browser check): `{ templates: [] }`, matching every other
   * list endpoint's wrapper-object convention in this API (listSpaces ->
   * {spaces}, listMembers -> {members}, listUsers -> {users}, search ->
   * {hits}) — NOT a bare array, which was this function's first (wrong)
   * guess before that check caught it. Callers still degrade gracefully on
   * a 404/error by falling back to a client-side tree scan for a
   * `_templates` node's children — see app/templates/useTemplates.ts.
   */
  getTemplates: (space: string) => request<{ templates: PageMeta[] }>(`/api/spaces/${encodeURIComponent(space)}/templates`),

  // ---------- API tokens + MCP (round 7) ----------

  /** Callers must degrade on a 404 (endpoint landing in parallel on SERVER's side) by hiding the whole section — see app/tokens/ApiTokensModal.tsx. */
  listApiTokens: () => request<{ tokens: ApiTokenInfo[] }>('/api/me/tokens'),

  /** Response includes the plaintext token exactly once — never returned again by any other call. */
  createApiToken: (body: CreateApiTokenBody) =>
    request<CreatedApiToken>('/api/me/tokens', { method: 'POST', body: JSON.stringify(body) }),

  /** Soft revoke. */
  revokeApiToken: (id: string) => request<{ ok: true }>(`/api/me/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** OAuth connections (claude.ai, ChatGPT, …) the user approved — "Connected apps". */
  listOAuthConnections: () => request<{ connections: OAuthConnectionInfo[] }>('/api/me/oauth-connections'),
  revokeOAuthConnection: (id: string) => request<{ ok: true }>(`/api/me/oauth-connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ---------- share links (round 8) ----------

  /** Callers must degrade on a 404 (SERVER building this in parallel) by hiding the "Share" button entirely — see app/share/ShareButton.tsx. */
  getPageShares: (pageId: string) => request<{ shares: ShareLinkInfo[] }>(`/api/pages/${encodeURIComponent(pageId)}/shares`),

  createShareLink: (pageId: string, body: CreateShareLinkBody) =>
    request<ShareLinkInfo>(`/api/pages/${encodeURIComponent(pageId)}/shares`, { method: 'POST', body: JSON.stringify(body) }),

  /** PATCH /api/shares/:id — flips includeChildren on a LIVE link; returns the refreshed list. */
  updateShareLink: (id: string, body: { includeChildren: boolean }) =>
    request<{ shares: ShareLinkInfo[] }>(`/api/shares/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  revokeShareLink: (id: string) => request<{ ok: true }>(`/api/shares/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /**
   * Public, session-free — request() still works fine here since it only
   * conditionally attaches a content-type header and inspects the status
   * code, neither of which needs a session. A 401 from this specifically
   * would be a genuine server bug (this route shouldn't require one), but
   * request()'s UNAUTHORIZED_EVENT dispatch on 401 is harmless even then —
   * nothing on the public /share/:token route listens for it (no
   * AuthProvider mounted there to react to it).
   */
  getSharedPage: (token: string) => request<SharedPagePayload>(`/api/share/${encodeURIComponent(token)}`),

  // ---------- git browser via saved PAT (round 11) ----------

  /** Callers must degrade on a 404/error (SERVER building this in parallel) to the plain free-text repo form — see sidebar/CreateSpaceDialog.tsx. Token itself is never returned, only credential metadata. */
  getGitCredentials: () => request<{ credentials: GitCredentialInfo[] }>('/api/me/git-credentials'),

  saveGitCredential: (body: SaveGitCredentialBody) =>
    request<GitCredentialInfo>('/api/me/git-credentials', { method: 'POST', body: JSON.stringify(body) }),

  deleteGitCredential: (id: string) => request<{ ok: true }>(`/api/me/git-credentials/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** Repos reachable with a saved credential for `host`, via that provider's own API (GitLab/GitHub). */
  getGitProviderRepos: (host: string) => request<GitProviderRepos>(`/api/git/repos?host=${encodeURIComponent(host)}`),

  /**
   * Round 19 (#6-ux): one level of a remote repo's directory tree, for the
   * create-space dialog's lazy rootPath picker (sidebar/GitRepoTreePicker.tsx).
   * `credentialId` is optional — SERVER falls back to the same host-based
   * auto-token match POST /api/spaces and POST /api/git/branches already use
   * when it's omitted, so this still works for a public repo with no
   * credential explicitly selected. Callers must degrade to the plain
   * manual rootPath input on ANY failure (400/404/network) — this is a
   * nice-to-have picker, never a blocking requirement.
   */
  getGitTree: (params: { repoUrl: string; branch: string; path: string; credentialId?: string }) =>
    request<GitRepoTreeResponse>(
      `/api/git/tree?credentialId=${encodeURIComponent(params.credentialId ?? '')}&repoUrl=${encodeURIComponent(params.repoUrl)}&branch=${encodeURIComponent(params.branch)}&path=${encodeURIComponent(params.path)}`,
    ),

  // ---------- preferences (round 10, i18n; round 15 adds username; round 28 adds name) ----------

  /**
   * Returns the updated user (server echoes it back — see
   * server/auth/routes.ts's PATCH handler); `username: null` unsets the
   * @mention handle, while `name` (round 28, the personal-settings dialog)
   * has no "unset" form at all — users.name is NOT NULL, and a blank or
   * whitespace-only value is rejected by the contract schema.
   */
  updateMyPreferences: (body: UpdateMyPreferencesBody) =>
    request<User>('/api/me/preferences', { method: 'PATCH', body: JSON.stringify(body) }),

  // ---------- invites by link (round 9) ----------

  listInvites: () => request<{ invites: InviteInfo[] }>('/api/invites'),

  createInvite: (body: CreateInviteBody) => request<InviteInfo>('/api/invites', { method: 'POST', body: JSON.stringify(body) }),

  revokeInvite: (id: string) => request<{ ok: true }>(`/api/invites/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** Public, session-free — see getSharedPage's own comment on why request() is still fine here. */
  getInvite: (token: string) => request<InvitePublicInfo>(`/api/invite/${encodeURIComponent(token)}`),

  acceptInvite: (token: string, body: AcceptInviteBody) =>
    request<AuthState>(`/api/invite/${encodeURIComponent(token)}/accept`, { method: 'POST', body: JSON.stringify(body) }),

  acceptInviteAsCurrentUser: (token: string) =>
    request<AuthState>(`/api/invite/${encodeURIComponent(token)}/accept-existing`, { method: 'POST' }),

  // ---------- saved Confluence credentials (round 22b) ----------

  /**
   * Callers must degrade on a 404/error (mirrors getGitCredentials above) —
   * see import/ConfluenceImportDialog.tsx, which matches these by host
   * against the typed page URL, and git/ConfluenceCredentialsSection.tsx's
   * list/delete UI inside the "Git access" dialog. Token itself is never
   * returned, only credential metadata.
   */
  getConfluenceCredentials: () => request<{ credentials: ConfluenceCredentialInfo[] }>('/api/me/confluence-credentials'),

  deleteConfluenceCredential: (id: string) =>
    request<{ ok: true }>(`/api/me/confluence-credentials/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ---------- Confluence import (round 12; round 22b adds credentialId/save) ----------

  startConfluenceImport: (body: ConfluenceImportRequest) =>
    request<ImportJob>('/api/import/confluence', { method: 'POST', body: JSON.stringify(body) }),

  getImportJob: (id: string) => request<ImportJob>(`/api/import/jobs/${encodeURIComponent(id)}`),

  // ---------- access & permissions (round 27, instance admin / space admin — see docs/spec-access.md §7) ----------

  /** GET /api/access/matrix — instance-admin only; the full users x spaces grid backing the Access page's Matrix tab (and reused by the People/Spaces tabs for chips/visibility-loss previews). */
  getAccessMatrix: () => request<AccessMatrixResponse>('/api/access/matrix'),

  /** POST /api/access/bulk — one request, per-row errors (not a whole-batch rejection) — see AccessBulkResult and server/access/routes.test.ts's documented behavior. */
  applyAccessBulk: (body: AccessBulkBody) => request<AccessBulkResult>('/api/access/bulk', { method: 'POST', body: JSON.stringify(body) }),

  /** PATCH /api/spaces/:space — visibility only, per updateSpaceVisibilityBodySchema. */
  setSpaceVisibility: (space: string, body: UpdateSpaceVisibilityBody) =>
    request<{ slug: string; visibility: SpaceVisibility }>(`/api/spaces/${encodeURIComponent(space)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  /** GET /api/spaces/:space/access-log — `{ entries: [...] }`, per server/access/routes.ts's route handler (NOT a bare array, unlike listAdminSpaces above). */
  getSpaceAccessLog: (space: string) => request<{ entries: AccessLogEntry[] }>(`/api/spaces/${encodeURIComponent(space)}/access-log`),

  /** GET /api/users/:id/access — instance-admin only; one user's explicit memberships + their own access-change log, for the People tab's expandable row. */
  getUserAccess: (id: string) => request<UserAccessResponse>(`/api/users/${encodeURIComponent(id)}/access`),

  // ---------- trash (space admin sees their space, instance admin everything; see server/trash/service.ts) ----------

  /** GET /api/trash — items the caller may administer, newest first, paginated (`limit` default 100, `offset` default 0); every filter is optional (from/to are yyyy-mm-dd, inclusive). */
  listTrash: (filters?: { space?: string; kind?: string; from?: string; to?: string; limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters ?? {})) if (value !== undefined && value !== '') params.set(key, String(value));
    const qs = params.toString();
    return request<TrashListResponse>(`/api/trash${qs ? `?${qs}` : ''}`);
  },

  /** POST /api/trash/:id/restore — the response's restoredPath is the ACTUAL path (a conflict restores alongside with a -restored suffix); UI must show it, not origPath. */
  restoreTrashItem: (id: string) => request<TrashRestoreResponse>(`/api/trash/${encodeURIComponent(id)}/restore`, { method: 'POST' }),

  /** DELETE /api/trash/:id — permanent; callers gate it behind the hard ConfirmDialog. */
  purgeTrashItem: (id: string) => request<{ ok: true }>(`/api/trash/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** DELETE /api/trash — "empty the trash": everything the caller can see, optionally one space. */
  emptyTrash: (space?: string) =>
    request<{ removed: number }>(`/api/trash${space ? `?space=${encodeURIComponent(space)}` : ''}`, { method: 'DELETE' }),

  /** Retention setting (null = no auto-purge, the default). GET is open to any session; PUT is instance-admin only server-side. */
  getTrashSettings: () => request<{ retentionDays: number | null }>('/api/trash/settings'),

  setTrashRetention: (retentionDays: number | null) =>
    request<{ retentionDays: number | null }>('/api/trash/settings', { method: 'PUT', body: JSON.stringify({ retentionDays }) }),

  // ---------- AI assistant (Cursor SDK) — contract at the end of shared/contracts.ts ----------
  // Browser-session only (cookie); PAT auth never reaches these routes. The
  // run-events stream (`GET /api/assistant/runs/:runId/events`, NDJSON) isn't
  // here — it doesn't fit request()'s single-JSON-response shape, see
  // assistant/stream.ts's subscribeAssistantRun.

  getAssistantSettings: () => request<AssistantSettings>('/api/assistant/settings'),

  getAssistantModels: () => request<AssistantModelsResponse>('/api/assistant/models'),

  setAssistantModel: (model: string) =>
    request<AssistantSettings>('/api/assistant/settings/model', { method: 'PUT', body: JSON.stringify({ model }) }),

  /** Checks the key against Cursor and stores it encrypted; 400 when Cursor didn't accept it. */
  saveAssistantKey: (apiKey: string) =>
    request<AssistantConnectionCheck>('/api/assistant/settings/key', { method: 'PUT', body: JSON.stringify({ apiKey }) }),

  deleteAssistantKey: () => request<void>('/api/assistant/settings/key', { method: 'DELETE' }),

  /** Without `apiKey`, re-checks the already-saved key. */
  checkAssistantKey: (apiKey?: string) =>
    request<AssistantConnectionCheck>('/api/assistant/settings/check', {
      method: 'POST',
      body: JSON.stringify(apiKey ? { apiKey } : {}),
    }),

  /** Without `conversationId`, returns the caller's most recent conversation. */
  getAssistantConversation: (conversationId?: string | null) =>
    request<AssistantConversation>(
      `/api/assistant/chat${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ''}`,
    ),

  listAssistantConversations: () => request<AssistantConversationsResponse>('/api/assistant/conversations'),

  /** POST /api/assistant/runs — starts a run (a server-side task) and returns immediately; see assistant/runState.tsx. */
  startAssistantRun: (body: SendAssistantMessageBody) =>
    request<StartAssistantRunResponse>('/api/assistant/runs', { method: 'POST', body: JSON.stringify(body) }),

  /** GET /api/assistant/runs/active — the caller's one in-flight run, if any (drives reconnection after F5/navigation). */
  getActiveAssistantRun: () => request<ActiveAssistantRunResponse>('/api/assistant/runs/active'),

  /** POST /api/assistant/runs/:runId/stop — the only way to cancel a run; disconnecting the events stream does not. */
  stopAssistantRun: (runId: string) =>
    request<{ stopped: boolean }>(`/api/assistant/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' }),

  /** PUT /api/assistant/messages/:messageId/feedback — one rating per message; `null` removes it. */
  setAssistantFeedback: (messageId: string, rating: AssistantFeedbackRating | null) =>
    request<AssistantFeedbackResponse>(`/api/assistant/messages/${encodeURIComponent(messageId)}/feedback`, {
      method: 'PUT',
      body: JSON.stringify({ rating }),
    }),

  /** POST /api/assistant/conversations/:id/survey — upserts on (conversation, afterMessageId), so a later POST adds the comment. */
  submitAssistantSurvey: (conversationId: string, body: AssistantSurveyBody) =>
    request<{ ok: true }>(`/api/assistant/conversations/${encodeURIComponent(conversationId)}/survey`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ---------- AI assistant analytics (instance admin, or space admin for their own spaces) ----------

  /** GET /api/admin/assistant/access — the caller's analytics scope; 403 when they are neither an instance admin nor a space admin. */
  getAdminAssistantAccess: () => request<AdminAssistantAccess>('/api/admin/assistant/access'),

  /** GET /api/admin/assistant/conversations — newest activity first; `from`/`to` are yyyy-mm-dd (inclusive). */
  listAdminAssistantConversations: (filters?: AdminAssistantFilters) =>
    request<AdminAssistantConversationsResponse>(`/api/admin/assistant/conversations${queryString(filters)}`),

  /** GET /api/admin/assistant/conversations/:id — the whole dialog, read-only. */
  getAdminAssistantConversation: (conversationId: string) =>
    request<AdminAssistantConversationDetail>(`/api/admin/assistant/conversations/${encodeURIComponent(conversationId)}`),

  /** GET /api/admin/assistant/conversations/:id/views — who opened the dialog in the analytics (audit), newest first. */
  getAdminAssistantConversationViews: (conversationId: string) =>
    request<AdminAssistantConversationViews>(`/api/admin/assistant/conversations/${encodeURIComponent(conversationId)}/views`),

  /** GET /api/admin/assistant/unanswered — questions the assistant could not answer, newest first. */
  listAdminAssistantUnanswered: (filters?: AdminAssistantFilters & { reason?: string }) =>
    request<AdminAssistantUnansweredResponse>(`/api/admin/assistant/unanswered${queryString(filters)}`),

  // ---------- notifications and access requests (round 31) ----------
  // Cookie-only, like the `/events` socket — a PAT does not come here (see the
  // comment above registerNotificationRoutes in server/notifications/routes.ts).
  // The socket itself does not live here: it does not fit a request()-like
  // "one JSON response"; see notifications/socket.ts (the same split as for
  // the assistant's stream).

  /** GET /api/notifications — up to 50 rows, newest first; `unread` is counted over ALL rows, not only the returned page. */
  listNotifications: () => request<NotificationListResponse>('/api/notifications'),

  /** POST /api/notifications/read — without `ids` it means "all of mine"; returns the new unread counter. */
  markNotificationsRead: (ids?: string[]) =>
    request<{ unread: number }>('/api/notifications/read', {
      method: 'POST',
      body: JSON.stringify(ids && ids.length > 0 ? { ids } : {}),
    }),

  /**
   * POST /api/access-requests — "let me into this space". 409 when access is
   * already there; a repeated click is idempotent — the server returns THE
   * SAME live request, so the button needs no double-click guard of its own.
   */
  createAccessRequest: (space: string) =>
    request<{ request: AccessRequestSummary }>('/api/access-requests', { method: 'POST', body: JSON.stringify({ space }) }),

  /** POST /api/access-requests/:id/decision — `role` is mandatory for `approve`; 403 for a non-admin, 409 for an already decided one. */
  decideAccessRequest: (id: string, body: DecideAccessRequestBody) =>
    request<{ request: AccessRequestSummary }>(`/api/access-requests/${encodeURIComponent(id)}/decision`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};
