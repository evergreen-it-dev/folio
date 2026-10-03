import { z } from 'zod';

/** Server port. Vite dev server (4871) proxies /api, /files and /collab here. */
export const SERVER_PORT = 4870;

/**
 * Round OFFICE: 'office' covers .docx/.xlsx/.pptx alike — the concrete
 * format comes from the file extension (officeFormat below), not from a
 * separate enum member per format, so every exhaustive switch on PageKind
 * only ever grows by ONE arm, same as 'pdf' before it.
 */
// Round FORMS: 'form' is a page kind backed by `<slug>.form.md` — a small
// "fill this table in" UI paired 1:1 with a data table (spec: fields[]
// mirror the table's own columns). See shared/forms/codec.ts for the file
// format and server/forms/** for the submit path.
export const pageKindSchema = z.enum(['doc', 'board', 'folder', 'table', 'pdf', 'office', 'form']);
export type PageKind = z.infer<typeof pageKindSchema>;

/** The three formats a kind:'office' page can be — never a fourth. */
export const officeFormatSchema = z.enum(['docx', 'xlsx', 'pptx']);
export type OfficeFormat = z.infer<typeof officeFormatSchema>;

/**
 * `notes/report.docx` -> 'docx', `notes/Book1.XLSX` -> 'xlsx' (case-insensitive,
 * same rule every other extension check in this codebase follows), anything
 * else -> undefined. The one source of truth for "which office format is
 * this path" — server/storage.ts's indexer and the web viewer both call this
 * rather than re-deriving it from the extension themselves.
 */
export function officeFormat(relPath: string): OfficeFormat | undefined {
  const lower = relPath.toLowerCase();
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.xlsx')) return 'xlsx';
  if (lower.endsWith('.pptx')) return 'pptx';
  return undefined;
}

export const pageStatusSchema = z.enum(['draft', 'published', 'archived']);
export type PageStatus = z.infer<typeof pageStatusSchema>;

// ---------- page-level access ----------

export const pageAccessVisibilitySchema = z.enum(['space', 'restricted']);
export type PageAccessVisibility = z.infer<typeof pageAccessVisibilitySchema>;
export const pageAccessGrantRoleSchema = z.enum(['viewer', 'editor']);
export type PageAccessGrantRole = z.infer<typeof pageAccessGrantRoleSchema>;

export const updatePageAccessBodySchema = z.object({
  visibility: pageAccessVisibilitySchema,
  grants: z.array(z.object({ userId: z.string().uuid(), role: pageAccessGrantRoleSchema })).default([]),
});
export type UpdatePageAccessBody = z.infer<typeof updatePageAccessBodySchema>;

export interface PageAccessMember {
  userId: string;
  name: string;
  email: string;
  spaceRole: SpaceRole;
  grant?: PageAccessGrantRole;
  owner: boolean;
}

export interface PageAccessInfo {
  visibility: PageAccessVisibility;
  ownerId?: string;
  canManage: boolean;
  members: PageAccessMember[];
}

/**
 * A page is a file on disk under data/spaces/<space>/.
 * - kind "doc": a *.md file; title = first H1 of the body (NOT frontmatter).
 * - kind "board": a *.excalidraw.svg file; title = filename without extension.
 * `path` is relative to the space root, e.g. "architecture/data-flow.md".
 * A directory page is its "index.md"; its children are siblings in that directory.
 */
export const pageMetaSchema = z.object({
  id: z.string(),
  space: z.string(),
  path: z.string(),
  kind: pageKindSchema,
  title: z.string(),
  order: z.number(),
  status: pageStatusSchema,
  updatedAt: z.string(), // ISO timestamp
  /** The page's emoji icon from the frontmatter `icon:` (round 5). */
  icon: z.string().optional(),
  /** The URL of the cover from the frontmatter `cover:` (round 5). */
  cover: z.string().optional(),
});
export type PageMeta = z.infer<typeof pageMetaSchema>;

export interface TreeNode extends PageMeta {
  children: TreeNode[];
}

/** Full page payload: markdown body (frontmatter stripped) for docs, svg source for boards. */
export const pageDocSchema = pageMetaSchema.extend({
  markdown: z.string().optional(),
  svg: z.string().optional(),
});
export type PageDoc = z.infer<typeof pageDocSchema>;

export const searchHitSchema = z.object({
  id: z.string(),
  space: z.string(),
  path: z.string(),
  title: z.string(),
  snippet: z.string(),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

export interface SpaceInfo {
  slug: string;
  name: string;
  pageCount: number;
  /** Present when the request is authenticated. */
  myRole?: SpaceRole;
  git?: SpaceGitInfo;
  assetMode?: 'store' | 'repo';
  /** Round 27: private (default) = explicit members only; instance = plus any active user as an implicit viewer. */
  visibility?: SpaceVisibility;
  /**
   * `.agent/**` assistant rules for this space (owner spec, 21.09.2026;
   * widened 22.09.2026 — see the round's own note below).
   *
   * `used`/`pages` are sent to EVERY member of the space: a viewer must be
   * able to tell that space rules are being applied to their assistant runs
   * and roughly how much there is, even though they can never open or read
   * `.agent/**` itself (isAgentPath/effectivePageRole/search still hide the
   * pages from them everywhere else — only the COUNT leaks, deliberately).
   *
   * `path` (AGENT_FOLDER, '.agent') is set ONLY for a caller who can
   * administer the space (space or instance admin) — that's what lets the
   * client turn the indicator into a link vs. plain text, without the
   * client having to re-derive admin-ness itself.
   */
  agentRules?: { used: boolean; pages: number; path?: string };
}

// ---------- access & permissions (round 27) ----------

export const spaceVisibilitySchema = z.enum(['private', 'instance']);
export type SpaceVisibility = z.infer<typeof spaceVisibilitySchema>;

export const updateSpaceVisibilityBodySchema = z.object({ visibility: spaceVisibilitySchema });

/** GET /api/access/matrix — users × spaces grid backing the Access page, §6.2. */
export interface AccessMatrixUser {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
  disabled: boolean;
}
export interface AccessMatrixSpace {
  slug: string;
  name: string;
  visibility: SpaceVisibility;
}
export interface AccessMatrixResponse {
  users: AccessMatrixUser[];
  spaces: AccessMatrixSpace[];
  /** roles[userId][spaceSlug] — undefined = no access; a role from an `instance`-visibility space's implicit viewer grant is NOT included here (UI derives it from spaces[].visibility instead, so it can render the grey "viewer (all)" cell distinctly from an explicit membership). */
  roles: Record<string, Record<string, SpaceRole>>;
}

/** POST /api/access/bulk request/body schemas defined further below, after `spaceRoleSchema` (avoids a TDZ reference — see there). */
export interface AccessBulkResult {
  applied: { userId: string; space: string; role: SpaceRole | null }[];
  errors: { userId: string; space: string; error: string }[];
}

/** GET /api/spaces/:space/access-log and GET /api/users/:id/access share this shape's event rows (round 27 §2.4/§7). */
export interface AccessLogEntry {
  id: string;
  action: 'access.grant' | 'access.revoke' | 'access.self_grant' | 'space.visibility';
  actorId: string | null;
  actorName: string;
  target: string;
  meta: Record<string, unknown>;
  at: string;
}

/** GET /api/users/:id/access (round 27 §6.1's expandable per-user panel) — memberships is EXPLICIT space_members only, same "implicit access isn't editable per-user" reasoning as AccessMatrixResponse.roles above. */
export interface UserAccessResponse {
  memberships: Record<string, SpaceRole>;
  log: AccessLogEntry[];
}

export const createPageBodySchema = z.object({
  space: z.string(),
  /** Parent directory path relative to space root; "" for space root. */
  parentPath: z.string(),
  title: z.string().min(1),
  kind: pageKindSchema.default('doc'),
  /**
   * Round 26 (DATA TABLES), spec §8: "Creating a table is the existing
   * POST /api/pages with kind: 'table' (+ optionally columns for a template)".
   * Ignored for kind !== 'table'. `z.lazy` (not a direct `tableColumnSchema`
   * reference) because `tableColumnSchema` itself is declared further down
   * this file (see "data tables (round 26)" section) — a plain reference
   * here would run into the TDZ at module-eval time, since this schema is
   * built before that `const` initializes; `z.lazy`'s getter only runs at
   * parse time, by which point the whole module has finished loading.
   */
  columns: z.array(z.lazy(() => tableColumnSchema)).optional(),
  /**
   * OFFLINE CREATION (29.09.2026). A page or board made while the client had
   * no network already has an identity and content by the time it reaches
   * the server: the client mints the ULID itself (so the URL it has been
   * sitting on, and every link already pointing at it, stay valid) and
   * sends the Yjs state its local editor has been writing into.
   *
   * - `id`: the client-minted ULID. A replay of the same create (the first
   *   response got lost on a bad connection) finds the page already there
   *   and answers with its meta instead of failing — the call is idempotent
   *   per id. An id owned by a page of another space or kind is a 409.
   * - `ydocState`: base64 of `Y.encodeStateAsUpdate(doc)`. The server stores
   *   it as the room's snapshot (`ydoc_state`) and writes the file from it,
   *   so the room resumes from the CLIENT's CRDT history — a freshly seeded
   *   room would merge with the client's copy as two unrelated documents
   *   (the doubling server/collab.ts guards against everywhere else).
   *   `kind: 'doc'` reads `Y.Text('content')`, `kind: 'board'` the board
   *   roots; ignored for every other kind. Requires `id`.
   */
  id: z
    .string()
    .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'id must be a ULID')
    .optional(),
  ydocState: z
    .string()
    .max(8_000_000)
    .optional(),
});
export type CreatePageBody = z.infer<typeof createPageBodySchema>;

export const updatePageBodySchema = z.object({
  markdown: z.string().optional(),
  svg: z.string().optional(),
  /** Round 22: the position among siblings (frontmatter `order`) — a body with
   *  only this field is allowed: moving a page up or down does not touch the content. */
  order: z.number().optional(),
  /** Explicit control of the icon/cover: a string sets it, null removes it,
   *  an absent field leaves it alone (an ordinary text edit erases nothing). */
  icon: z.string().nullable().optional(),
  cover: z.string().nullable().optional(),
});
export type UpdatePageBody = z.infer<typeof updatePageBodySchema>;

export const movePageBodySchema = z.object({
  /** New parent directory path relative to space root; "" for space root. */
  toParentPath: z.string(),
});
export type MovePageBody = z.infer<typeof movePageBodySchema>;

export const copyPageBodySchema = z.object({
  /** Destination space and parent directory. The copied page always gets a fresh id. */
  toSpace: z.string(),
  toParentPath: z.string(),
  /**
   * 03.09.2026: copy together with the children (YES by default). For a
   * directory page (`index.md` + neighbors) and for a page `X.md` with a
   * directory `X/` the whole subtree is copied; every copied file gets a
   * fresh id. `false` — the page alone (the previous behavior).
   */
  includeChildren: z.boolean().default(true),
});
export type CopyPageBody = z.infer<typeof copyPageBodySchema>;

export const duplicatePageBodySchema = z.object({
  /**
   * Title for the copy's root page ("X (copy)", worded by the client in the
   * reader's language). Omitted: the copy keeps the original's title.
   */
  title: z.string().trim().min(1).max(300).optional(),
});
export type DuplicatePageBody = z.infer<typeof duplicatePageBodySchema>;

export const renamePageBodySchema = z.object({ title: z.string().min(1) });
export type RenamePageBody = z.infer<typeof renamePageBodySchema>;

// ---------- personal history of page changes ----------

/** The structural operations Folio can verify and undo safely. */
export type PageChangeAction = 'page.create' | 'page.copy' | 'page.rename' | 'page.move' | 'page.slug' | 'page.delete';

/** The minimal state of a page for a clear description and an optimistic-safety check before undoing. */
export interface PageChangeState {
  title: string;
  path: string;
  parentPath: string;
  slug: string;
  updatedAt: string;
  /** For `page.delete` only: the id of the matching record in `trash_items`, needed to restore on undo. */
  trashItemId?: string;
}

/** One element of GET /api/spaces/:space/changes — the current user's actions only. */
export interface PageChangeInfo {
  id: string;
  action: PageChangeAction;
  pageId: string;
  space: string;
  before?: PageChangeState;
  after: PageChangeState;
  at: string;
}

export interface UndoPageChangeResponse {
  undone: PageChangeInfo;
  /** The page after the rollback; absent when its creation or copy was undone. */
  page?: PageMeta;
}

export const createSpaceBodySchema = z.object({ name: z.string().min(1) });
export type CreateSpaceBody = z.infer<typeof createSpaceBodySchema>;

/** Shape of every non-2xx JSON response from the server. */
export interface ErrorResponse {
  error: string;
}

// ---------- i18n (round 10) ----------
// Moved here, ahead of userSchema below (which references uiLanguageSchema in
// its own `lang` field) — a top-level `const` runs at module-evaluation time,
// so this declaration must come first, or every import of this file throws
// "Cannot access 'uiLanguageSchema' before initialization" (TDZ). That was
// breaking the whole build (server AND web, every test file that touches
// this module) before this move — the block used to sit at the bottom of
// the file, after userSchema.

export const uiLanguageSchema = z.enum(['uk', 'en', 'ru']);
export type UiLanguage = z.infer<typeof uiLanguageSchema>;
export const DEFAULT_UI_LANGUAGE: UiLanguage = 'uk';

// ---------- @mentions (round 15) ----------

/**
 * A handle for mentions: 2–32 characters, [a-z0-9._-], starts with a letter
 * or a digit, stored in lower case. In markdown a mention is the plain text
 * `@username` (files stay readable); highlighting happens only when the
 * handle exists and is visible in the space.
 */
/**
 * Normalization before validation (08.09.2026, owner's request: "people
 * sometimes write @username — the at sign must be ignored and removed"): trim
 * spaces, strip ALL leading `@` and lower-case. After that the same format
 * applies, so `@Ivan.K `, `Ivan.K` and `ivan.k` give one and the same stored
 * handle, `ivan.k`.
 */
export function normalizeUsername(input: string): string {
  return input.trim().replace(/^@+/, '').toLowerCase();
}

export const usernameSchema = z
  .string()
  .transform(normalizeUsername)
  .pipe(z.string().min(2).max(32).regex(/^[a-z0-9][a-z0-9._-]*$/));

/** GET /api/spaces/:space/mentionable — the members of the space (+ instance admins) that have a username. */
export interface MentionableUser {
  username: string;
  name: string;
}

// ---------- saved Confluence credentials (round 22b) ----------

/** 'pat' — an on-prem Personal Access Token; 'cloud' — email + API token (HTTP Basic). */
export type ConfluenceCredentialKind = 'pat' | 'cloud';

/** The response of list/save: the token is never given out. */
export interface ConfluenceCredentialInfo {
  id: string;
  /** Normalized: no scheme, no trailing slash, lower case. */
  host: string;
  kind: ConfluenceCredentialKind;
  label: string;
  /** For kind === 'cloud' only. */
  email?: string;
  createdAt: string;
}

export const saveConfluenceCredentialBodySchema = z
  .object({
    host: z.string().min(1),
    kind: z.enum(['pat', 'cloud']),
    token: z.string().min(1),
    email: z.string().optional(),
    label: z.string().optional(),
  })
  .refine((v) => v.kind !== 'cloud' || Boolean(v.email?.trim()), {
    message: 'email is required for a cloud (email + API token) Confluence credential',
    path: ['email'],
  });
export type SaveConfluenceCredentialBody = z.infer<typeof saveConfluenceCredentialBodySchema>;

/**
 * The body of POST /api/import/confluence. Exactly one of credentialId/auth.
 * `auth.kind` stays in the vocabulary of round 12 ('pat' | 'basic'), where
 * 'basic' is the same as 'cloud' in saved credentials; the mapping lives in
 * one place on the server (confluenceImport.ts).
 */
export const confluenceImportRequestSchema = z
  .object({
    pageUrl: z.string().min(1),
    credentialId: z.string().optional(),
    auth: z
      .object({ kind: z.enum(['pat', 'basic']), token: z.string().min(1), email: z.string().optional() })
      .optional(),
    /** Save the entered credentials for this host (works only together with auth). */
    save: z.boolean().optional(),
    targetSpace: z.string().optional(),
    targetPath: z.string().default(''),
    includeChildren: z.boolean().default(true),
  })
  .refine((v) => Boolean(v.credentialId) !== Boolean(v.auth), {
    message: 'provide exactly one of credentialId or auth',
    path: ['auth'],
  });
export type ConfluenceImportRequest = z.infer<typeof confluenceImportRequestSchema>;

// ---------- admin: all spaces + members (round 22) ----------

export interface AdminSpaceMember {
  userId: string;
  name: string;
  email: string;
  username?: string;
  role: SpaceRole;
}

/** GET /api/admin/spaces (instance-admin) — a bare array, one element per space. */
export interface AdminSpaceInfo {
  slug: string;
  name: string;
  /** 'remote' — the space has git.repoUrl set; 'local' — the repository is on disk only. */
  kind: 'local' | 'remote';
  pageCount: number;
  members: AdminSpaceMember[];
  /** Round 27: metadata an instance-admin needs to manage access, NOT content — see docs/spec-access.md §1. */
  visibility: SpaceVisibility;
  /** Round 27: count of members.filter(m => m.role === 'admin').length, surfaced directly so the UI can warn "only one admin" without recomputing it. */
  adminCount: number;
  /** Git metadata is present for every space; repoUrl distinguishes a linked repository. */
  git: SpaceGitInfo;
}

// ---------- changing a page's slug (round 22) ----------

/** POST /api/pages/:id/slug — a url/git-friendly handle; the response is PageMeta (as for move). */
export const changePageSlugBodySchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
});
export type ChangePageSlugBody = z.infer<typeof changePageSlugBodySchema>;

// ---------- git repo browsing for create-space (round 19) ----------

/**
 * GET /api/git/tree?credentialId=&repoUrl=&branch=&path= — the directories of
 * a remote repository for choosing rootPath visually BEFORE the space is
 * created. Directories only, one level per request (a lazy tree).
 */
export interface GitRepoTreeResponse {
  /** The names of the subdirectories inside path (without path itself), sorted. */
  dirs: string[];
}

export const updateMyPreferencesBodySchema = z.object({
  lang: uiLanguageSchema.optional(),
  /** Round 15: null removes the handle; a uniqueness conflict -> 409. */
  username: usernameSchema.nullable().optional(),
  /**
   * Round 28 (personal settings): one's own display name — the same
   * users.name column the instance admin already edited through
   * updateUserBodySchema, now editable by the user. `.trim()` comes BEFORE
   * min(1), so "   " is rejected by validation rather than saved as an empty
   * string into a NOT NULL column. The name cannot be removed (unlike
   * username): neither null nor an empty string is accepted. 80 is the same
   * ceiling as for createApiTokenBodySchema.name.
   */
  name: z.string().trim().min(1).max(80).optional(),
});

// ---------- auth, roles, stars (round 2) ----------

export const spaceRoleSchema = z.enum(['admin', 'editor', 'viewer']);
export type SpaceRole = z.infer<typeof spaceRoleSchema>;

/** POST /api/access/bulk (round 27) — placed here, not next to the rest of the access-matrix types above, so `spaceRoleSchema` is already initialized when this module-level const evaluates. */
export const accessBulkChangeSchema = z.object({
  userId: z.string(),
  space: z.string(),
  /** null = revoke */
  role: spaceRoleSchema.nullable(),
});
export const accessBulkBodySchema = z.object({
  changes: z.array(accessBulkChangeSchema).min(1),
  /** Round 27 §2.5: optional reason for a self-grant, shown in the access-log feed if provided. */
  reason: z.string().optional(),
});
export type AccessBulkBody = z.infer<typeof accessBulkBodySchema>;

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  isAdmin: z.boolean(),
  disabled: z.boolean().optional(),
  createdAt: z.string(),
  /** The user's interface language (round 10); absent = DEFAULT_UI_LANGUAGE. */
  lang: uiLanguageSchema.optional(),
  /** Round 15: the handle for @mentions; absent/null = not set. */
  username: usernameSchema.nullable().optional(),
});
export type User = z.infer<typeof userSchema>;

/** GET /api/auth/state — public; drives the client auth gate. */
export interface AuthState {
  needsSetup: boolean;
  user: User | null;
  /** space slug -> my role: explicit space_members rows, plus (round 27) an implicit 'viewer' for every `visibility: 'instance'` space. Instance-admin grants NOTHING extra here — see docs/spec-access.md §1/§2. */
  memberships: Record<string, SpaceRole>;
  /** "Sign in with Google" (server/auth/google.ts) is configured (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET both set) — drives whether the login screen shows the button at all. */
  google: boolean;
}

export const setupBodySchema = z.object({
  email: z.email(),
  name: z.string().min(1),
  password: z.string().min(8),
});
export const loginBodySchema = z.object({ email: z.email(), password: z.string().min(1) });
/** Round 27 §6.4: the "Add a person" dialog saves the user AND its space memberships in one atomic call — `memberships` is optional (omitted/empty = a user with zero space access yet, same as before this round). */
export const createUserBodySchema = setupBodySchema.extend({
  isAdmin: z.boolean().default(false),
  memberships: z.array(z.object({ space: z.string(), role: spaceRoleSchema })).optional(),
});
export const updateUserBodySchema = z.object({
  name: z.string().min(1).optional(),
  username: usernameSchema.nullable().optional(),
  isAdmin: z.boolean().optional(),
  password: z.string().min(8).optional(),
  disabled: z.boolean().optional(),
});
export const setMemberBodySchema = z.object({ role: spaceRoleSchema });

export const starsSchema = z.object({
  spaces: z.array(z.string()),
  pages: z.array(z.string()),
  /** The personal set of favorite emoji (round 6). The order is kept. */
  emojis: z.array(z.string()).optional(),
});

/** The default set of favorites — everyone sees it until they start their own. */
export const DEFAULT_EMOJI_FAVORITES = ['➕', '➖', '✅', '⛔', '❗', '🚫', '❤️', '🔜', '🛠️', '⚠️', '🆕', '⭐'];
export type Stars = z.infer<typeof starsSchema>;
export const setStarBodySchema = z.object({ starred: z.boolean() });

export interface SpaceMemberInfo {
  user: User;
  role: SpaceRole;
}

// ---------- git-native spaces (round 3) ----------

export const spaceGitStatusSchema = z.enum(['local', 'clean', 'syncing', 'ahead', 'behind', 'conflict', 'error']);
export type SpaceGitStatus = z.infer<typeof spaceGitStatusSchema>;

export interface SpaceGitInfo {
  repoUrl: string | null;
  branch: string;
  rootPath: string;
  status: SpaceGitStatus;
  ahead: number;
  behind: number;
  lastSyncAt: string | null;
  /** Identity whose action or edit caused the latest completed sync. */
  lastSyncByName: string | null;
  lastSyncByEmail: string | null;
  lastError: string | null;
  /**
   * Every tracked file that currently has unresolved git conflict markers,
   * across the WHOLE working tree (not just this space's own rootPath — a
   * shared repo can have a conflict outside it). `pageId`/`title` are set
   * when the path resolves to one of this space's own pages; a path outside
   * rootPath, or one rootPath doesn't map to an indexed page, carries only
   * `path`. Only ever populated while `status === 'conflict'` — see
   * server/gitSync.ts's getSpaceConflicts for why it's kept conditional.
   */
  conflicts?: SpaceGitConflict[];
}

export interface SpaceGitConflict {
  path: string;
  pageId?: string;
  title?: string;
}

/**
 * POST /api/spaces/:space/git/reset-to-remote — "Take the version from Git": owner
 * ask, nobody is ever going to resolve a git-native space's conflicts by
 * hand, so this throws away everything local and makes the space match
 * `origin/<branch>` exactly. See server/git.ts's resetToRemote and
 * server/gitSync.ts's resetSpaceToRemote.
 */
export interface ResetToRemoteResponse {
  git: SpaceGitInfo;
  /** Local branch `folio-backup/<YYYYMMDD-HHMMSS>` the discarded state was saved under before the reset, or null when HEAD already matched the remote (nothing to back up). */
  backupRef: string | null;
  changedCount: number;
}

/** POST /api/spaces, the round 3 extension: an empty space or a space from a repository. */
export const createSpaceGit = z.object({
  name: z.string().min(1),
  repoUrl: z.string().min(1).optional(),
  branch: z.string().min(1).optional(), // default: main
  rootPath: z.string().optional(),      // default: "" (the root of the repository)
  token: z.string().optional(),         // an https token; kept outside git, not logged
  importId: z.string().uuid().optional(), // an id for polling the progress of a long git import
});
export type CreateSpaceGitBody = z.infer<typeof createSpaceGit>;

export type SpaceImportPhase = 'preparing' | 'checking' | 'cloning' | 'scanning' | 'finalizing' | 'done' | 'error';
export interface SpaceImportProgress {
  id: string;
  phase: SpaceImportPhase;
  percent: number;
  processedFiles: number;
  totalFiles: number;
  elapsedMs: number;
  done: boolean;
  error?: string;
}

export interface PageHistoryEntry {
  sha: string;
  author: string;
  date: string;   // ISO
  message: string;
}

/** GET /api/pages/:id/history/:sha response. Doc -> markdown (frontmatter stripped, like a normal GET); board -> svg (the raw file at that sha). Exactly one is present, keyed by the page's own `kind`. */
export interface PageAtShaResponse {
  markdown?: string;
  svg?: string;
}

/** Instance-wide config a client needs before it's in any particular space. */
export interface FolioConfig {
  defaultRepoUrl: string | null;
}

/** POST /api/git/branches — the branches of a remote repository for the create-space dialog. */
export const listBranchesBodySchema = z.object({
  repoUrl: z.string().min(1),
  token: z.string().optional(),
});
export interface RepoBranches {
  branches: string[];
  defaultBranch: string | null;
  /** true — the repository is empty (no branches; main is created on connect). */
  empty: boolean;
}

/**
 * POST /api/spaces/:space/connect-git — "Connect git" on an already existing
 * LOCAL space (no repository yet, `SpaceGitInfo.repoUrl === null`). Only for
 * an EMPTY remote repository: a local space already has its own git history,
 * and silently merging it with somebody else's non-empty one is a conflict of
 * two histories, which the server rejects (409) rather than tries to resolve
 * itself — see server/storage.ts's connectSpaceToRepo.
 */
export const connectSpaceGitBodySchema = z.object({
  repoUrl: z.string().min(1),
  branch: z.string().min(1).optional(), // default: main
  token: z.string().optional(),         // an https token; kept outside git, not logged (as for createSpaceGit)
});
export type ConnectSpaceGitBody = z.infer<typeof connectSpaceGitBodySchema>;

// ---------- API tokens and MCP (round 7) ----------

export const apiTokenScopeSchema = z.enum(['read', 'write']);
export type ApiTokenScope = z.infer<typeof apiTokenScopeSchema>;

export interface ApiTokenInfo {
  id: string;
  name: string;
  scopes: ApiTokenScope[];
  createdAt: string;
  lastUsedAt: string | null;
}

export const createApiTokenBodySchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(apiTokenScopeSchema).min(1),
});

/** The response of creation — the token is shown exactly once. */
export interface CreatedApiToken extends ApiTokenInfo {
  token: string; // folio_pat_<random>; only the sha256 is stored
}

// ---------- share links (round 8) ----------

export const shareLinkModeSchema = z.enum(['view', 'edit']);
export type ShareLinkMode = z.infer<typeof shareLinkModeSchema>;

export interface ShareLinkInfo {
  id: string;
  mode: ShareLinkMode;
  url: string; // <PUBLIC_URL>/share/<token>
  /** Round 23: the Markdown link "for an agent" — the same token, raw markdown. */
  mdUrl: string; // <PUBLIC_URL>/share/<token>.md
  createdAt: string;
  createdBy: string; // a name
  /** Round 23: the subtree is visible/collated together with the page (see spec R23 addendum 2). */
  includeChildren: boolean;
}

/** PATCH /api/shares/:id — includeChildren is editable after creation (see server/shares.ts's doc comment for why it stopped being write-once). */
export const updateShareLinkBodySchema = z.object({ includeChildren: z.boolean() });

export const createShareLinkBodySchema = z.object({
  mode: shareLinkModeSchema,
  /** Round 23: default false — existing behavior does not change without the explicit flag. */
  includeChildren: z.boolean().default(false),
});

// ---------- export (round 23) ----------

// Round 23 tail follow-up (owner): 'yaml' added ADDITIVELY — every existing
// value/consumer of this enum is untouched, so this is a pure widening.
export const exportFormatSchema = z.enum(['md', 'pdf', 'docx', 'yaml']);
export type ExportFormat = z.infer<typeof exportFormatSchema>;

/** The "placeholder -> value" relation in the space-level header and footer editor. */
export const exportHeaderFooterPlaceholderSchema = z.enum([
  '{{page}}', '{{pages}}', '{{title}}', '{{space}}', '{{date}}',
]);

/** Stored in `<slug>.folio` (extends the existing file, see Round 22). */
export const spaceExportSettingsSchema = z.object({
  headerHtml: z.string().optional(),
  footerHtml: z.string().optional(),
}).optional();
export type SpaceExportSettings = z.infer<typeof spaceExportSettingsSchema>;

/** GET /api/share/:token — public (no session). */
export interface SharedPagePayload {
  mode: ShareLinkMode;
  page: PageDoc;      // markdown for a doc, svg for a board
  spaceName: string;
  /**
   * Round 23 tail (navigation over children in a public share): the subtree
   * of the page, IF the token was created with includeChildren — otherwise
   * the field is absent altogether (old clients and single-page shares notice
   * nothing). The nodes are the same SubtreeNode as for ::pagetree (an
   * interface, so the forward reference is legal: the TDZ concerns only
   * runtime zod constants). The root page is NOT in children — it is the
   * page above.
   */
  children?: SubtreeNode[];
  /**
   * Together with children: the path identifier of the root of the share, so
   * that the client can build navigation links /share/<token>/p/<pageId> relative to it.
   */
  rootPageId?: string;
}

// ---------- invitations by link (round 9) ----------

export const inviteMembershipSchema = z.object({ space: z.string(), role: spaceRoleSchema });

export const createInviteBodySchema = z.object({
  /** The memberships the invited person gets (a space admin can invite only into their own spaces). */
  memberships: z.array(inviteMembershipSchema).default([]),
  /** Only an instance admin can issue an invitation with instance administrator rights. */
  isAdmin: z.boolean().default(false),
  /** Lifetime in days (7 by default). */
  expiresInDays: z.number().int().min(1).max(90).default(7),
  /** How many times it can be accepted (1 by default; 0 = no limit). */
  maxUses: z.number().int().min(0).default(1),
  /** Optional: bind to a particular email. */
  email: z.email().optional(),
});

export interface InviteInfo {
  id: string;
  url: string; // <PUBLIC_URL>/invite/<token>
  memberships: { space: string; role: SpaceRole }[];
  isAdmin: boolean;
  email: string | null;
  expiresAt: string;
  maxUses: number;
  uses: number;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
}

/** GET /api/invite/:token — public, for the acceptance screen. */
export interface InvitePublicInfo {
  valid: boolean;
  reason?: 'expired' | 'revoked' | 'exhausted' | 'not_found';
  email: string | null;
  spaces: { space: string; name: string; role: SpaceRole }[];
  invitedBy: string;
}

export const acceptInviteBodySchema = z.object({
  name: z.string().min(1),
  email: z.email(),
  password: z.string().min(8),
  username: usernameSchema,
});

export const validateRecentPagesBodySchema = z.object({
  pages: z.array(z.object({ space: z.string().min(1), id: z.string().min(1) })).max(50),
});
export type ValidateRecentPagesBody = z.infer<typeof validateRecentPagesBodySchema>;

// ---------- git browser via saved PAT (round 11) ----------

export interface GitProviderRepo {
  name: string;
  url: string;
  defaultBranch: string | null;
  description?: string;
}
export interface GitProviderRepos {
  provider: 'gitlab' | 'github' | 'unknown';
  host: string;
  repos: GitProviderRepo[];
}
export interface GitCredentialInfo {
  id: string;
  host: string;
  provider: 'gitlab' | 'github';
  label: string;
  createdAt: string;
}
export const saveGitCredentialBodySchema = z.object({
  host: z.string().min(1),
  provider: z.enum(['gitlab', 'github']),
  token: z.string().min(1),
  label: z.string().optional(),
});

// ---------- Confluence import (round 12) ----------

export const confluenceSourceSchema = z.object({
  pageUrl: z.string().min(1),
  auth: z.object({ kind: z.enum(['pat', 'basic']), token: z.string().min(1), email: z.string().optional() }),
  targetSpace: z.string().optional(),
  targetPath: z.string().default(''),
  includeChildren: z.boolean().default(true),
});
export type ConfluenceSource = z.infer<typeof confluenceSourceSchema>;
export interface ImportJob {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  total: number;
  done: number;
  currentTitle: string | null;
  error: string | null;
  targetSpace: string | null;
  /** Round 24: non-blocking remarks (an unknown stampId, a skipped node of a whiteboard). */
  warnings?: string[];
  /** Round 24: how many whiteboards were carried over in this run. */
  boards?: number;
  /**
   * Set only when `error` originates from a failed Confluence REST/download
   * call (server/confluenceImport.ts's confluenceGet/confluenceGetBinary) —
   * lets the client show a human, localized explanation instead of the raw
   * "Confluence API 401 Unauthorized for ..." text, while `error` itself
   * keeps the full technical detail for diagnosis (logs, "show details").
   * Absent for any other failure (bad target space, conversion bug, ...),
   * which keeps rendering `error` as-is exactly like before this field existed.
   */
  errorCode?: 'unauthorized' | 'forbidden' | 'notFound' | 'rateLimited' | 'unavailable';
}

/**
 * Round 25: a node of the response of GET /api/pages/:id/subtree?depth=N —
 * the data source for the `::pagetree` directive. Real pages only: there are
 * no folder nodes here, a directory without a page of its own is transparent
 * (its children rise to its place). The route's response:
 * `{ children: SubtreeNode[] }`, depth 1..5.
 */
export interface SubtreeNode {
  id: string;
  space: string;
  path: string;
  title: string;
  icon?: string;
  children: SubtreeNode[];
}

// ---------- trash — DEV-PLAN "Round 27 — trash", normative ----------

/** 'space' — a whole space was deleted (the root index.md); 'folder' — a directory with its subtree. */
export type TrashKind = 'doc' | 'board' | 'table' | 'pdf' | 'office' | 'form' | 'folder' | 'space';

export interface TrashItemInfo {
  id: string;
  space: string;
  /** The original page id (frontmatter id / a board's folio-id); for kind='space' — the slug. */
  pageId: string;
  kind: TrashKind;
  /** The path relative to the root of the space at the moment of deletion ('' for kind='space'). */
  origPath: string;
  title: string;
  /** null — who deleted it is unknown (the backfill of an old trash). */
  deletedBy: { id: string; name: string } | null;
  deletedAt: string; // ISO
  /** For folder/space: how many pages went along with the target. */
  childrenCount: number;
  /**
   * true — the deleted page is restricted by page access and the caller is neither
   * its owner nor holds a grant (an admin who administers the trash, not the page):
   * `title` and `origPath` are then empty, the item can still be restored or deleted
   * for good. Absent otherwise.
   */
  restricted?: boolean;
}

/**
 * GET /api/trash?space&kind&from&to&limit&offset — pagination (03.09.2026):
 * `limit` 1..500 (100 by default), `offset` >= 0. `items` is the current page
 * after the filters, `total` is how many there are after the filters,
 * `spaces` is all the spaces the caller can see in the trash (for the filter
 * select, whatever the page).
 */
export interface TrashListResponse {
  items: TrashItemInfo[];
  total: number;
  spaces: string[];
}

/** POST /api/trash/:id/restore. The actual path may differ from origPath (a conflict -> the -restored suffix) — the UI must show IT, not the original. */
export interface TrashRestoreResponse {
  restoredPath: string;
  /** The id of the restored page (kept from the frontmatter), or the slug of the space. */
  pageId: string;
  space: string;
  /** true when it had to be restored next to the original because of a path conflict. */
  renamed: boolean;
}

// ---------- data tables (round 26) — see docs/spec-tables.md, normative ----------

export const tableColumnTypeSchema = z.enum([
  'text', 'longtext', 'number', 'date', 'checkbox',
  'select', 'status', 'user', 'link',
]);

/*
 * The palette of options (spec §2.3). It is extended ONLY by adding: every
 * member already sits in the `.table.md` of live tables, so removing or
 * renaming one breaks saved files. The first ten are the original R26 set.
 *
 * The enum is closed on purpose, no arbitrary hex comes in here:
 * web/src/tables/colors.ts has to spell Tailwind classes out LITERALLY (the
 * scanner does not see `bg-${color}-100` and cuts them out of the production
 * build — "chips are colored in dev, grey in production"), and
 * `Record<TableColor, string>` there turns extending the enum without
 * extending the map into a type error.
 */
export const tableColorSchema = z.enum([
  'gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'none',
  // R26 follow-up: the owner extended the palette — choosing a color became a
  // grid of swatches instead of a list of names, and ten colors are few on it.
  'slate', 'stone', 'rose', 'fuchsia', 'violet', 'indigo', 'sky', 'cyan', 'emerald', 'lime', 'amber',
]);

export const tableOptionSchema = z.object({
  value: z.string().min(1),          // the label; it is also what sits in the cell of the file
  color: tableColorSchema.default('gray'),
  description: z.string().optional(),// shown in the dropdown and in the header tooltip
});

export const tableColumnSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]{1,32}$/),
  name: z.string().min(1),
  type: tableColumnTypeSchema,
  description: z.string().optional(),  // ← the hint in the header (hover)
  width: z.number().int().min(60).max(1200).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  multiple: z.boolean().optional(),    // select | user
  allowCreate: z.boolean().optional(), // select: "create from the value"
  precision: z.number().int().min(0).max(6).optional(), // number
  time: z.boolean().optional(),        // date: store the time
  default: z.unknown().optional(),
  options: z.array(tableOptionSchema).optional(), // select | status
});
export type TableColumn = z.infer<typeof tableColumnSchema>;

export const tableFilterOperatorSchema = z.enum([
  'is', 'is_not', 'contains', 'not_contains', 'starts_with',
  'is_empty', 'is_not_empty', 'gt', 'lt', 'gte', 'lte', 'between',
  'is_any_of', 'is_none_of', 'has_all', 'has_any',
  'is_checked', 'is_unchecked', 'is_me',
  'today', 'this_week', 'last_n_days',
]);

export const tableFilterRuleSchema = z.object({
  column: z.string(),
  operator: tableFilterOperatorSchema,
  value: z.unknown().optional(),
});

export const tableViewSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  icon: z.string().optional(),
  columns: z.object({
    hidden: z.array(z.string()).default([]),
    order: z.array(z.string()).default([]),
    width: z.record(z.string(), z.number()).default({}),
  }).default({ hidden: [], order: [], width: {} }),
  sort: z.array(z.object({ column: z.string(), dir: z.enum(['asc', 'desc']) })).default([]),
  filter: z.object({
    op: z.enum(['and', 'or']).default('and'),
    rules: z.array(tableFilterRuleSchema).default([]),
  }).default({ op: 'and', rules: [] }),
  frozen: z.number().int().min(0).max(4).default(0),
  rowHeight: z.enum(['short', 'medium', 'tall']).default('short'),
});
export type TableView = z.infer<typeof tableViewSchema>;

/** The value of a cell in the API — typed JSON, not the string from the file. */
export type TableCellValue = string | number | boolean | string[] | null;

export interface TableRow { id: string; values: Record<string, TableCellValue> }

export interface TableDoc {
  meta: { id: string; version: 1; rowIds: 'column' | 'none' };
  head: string;                 // the prose above the table (including the H1 heading)
  tail: string;                 // the prose below the table
  columns: TableColumn[];
  views: TableView[];
  rows: TableRow[];
}

// ---------- AI assistant (Cursor SDK), 04.09.2026 — the orchestrator's contract ----------
// Folio's built-in AI assistant: the Cursor key in the personal settings, the
// "Ask AI" chat at the bottom of the sidebar, the Ask/Agent modes.
// All /api/assistant/* routes are browser session (cookie) ONLY, a PAT does not go there.

export type AssistantKeySource = 'personal' | 'environment' | 'none';
export type AssistantRunMode = 'ask' | 'agent';

/** GET /api/assistant/settings */
export interface AssistantSettings {
  provider: 'CURSOR';
  /** 'auto' or the id of a Cursor model. */
  model: string;
  apiKeyConfigured: boolean;
  apiKeySource: AssistantKeySource;
  /** The name of the key that Cursor returned during the check (for personal only). */
  apiKeyName: string | null;
  /** FOLIO_SECRET is configured — the key can be saved encrypted. */
  encryptionAvailable: boolean;
  /** Node >= 22.13 — the Cursor SDK can be loaded. */
  runtimeAvailable: boolean;
}

/** PUT /api/assistant/settings/key — checks the key with Cursor and saves it encrypted. */
export const saveAssistantKeyBodySchema = z.object({ apiKey: z.string().trim().min(1).max(5000) });
export type SaveAssistantKeyBody = z.infer<typeof saveAssistantKeyBodySchema>;

/** POST /api/assistant/settings/check (body `{apiKey?}`; without it the saved key is checked). */
export interface AssistantConnectionCheck {
  ok: boolean;
  apiKeyName: string | null;
}

export interface AssistantModelOption {
  id: string;
  label: string;
  description: string | null;
}
/** GET /api/assistant/models — always has `auto` first. */
export interface AssistantModelsResponse {
  items: AssistantModelOption[];
  /** The error text of the Cursor catalog when the list could not be obtained (then `auto` only). */
  error?: string | null;
}
/** PUT /api/assistant/settings/model */
export const updateAssistantModelBodySchema = z.object({ model: z.string().trim().min(1).max(100) });

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  /** The owner's 👍/👎 on an assistant message (GET /api/assistant/chat only); absent/null — not rated. */
  feedback?: AssistantFeedbackRating | null;
}

/** GET /api/assistant/chat?conversationId= (without an id — the user's latest conversation). */
export interface AssistantConversation {
  conversationId: string | null;
  title: string | null;
  model: string | null;
  messages: AssistantMessage[];
  /** Set when the "did it solve your question?" survey should be shown after `afterMessageId`. */
  surveyDue?: AssistantSurveyDue | null;
  /** The run in progress in this conversation (05.09.2026) — the UI subscribes to it instead of starting a new one. */
  activeRun?: AssistantRunInfo | null;
}

export interface AssistantConversationSummary {
  conversationId: string;
  title: string | null;
  model: string;
  createdAt: string;
  updatedAt: string;
  /** The id of the active run in this conversation, if any (05.09.2026). */
  activeRunId?: string | null;
}
/** GET /api/assistant/conversations — the latest 50, newest first. */
export interface AssistantConversationsResponse {
  items: AssistantConversationSummary[];
}

/**
 * POST /api/assistant/chat/stream — a JSON body, the response is
 * `application/x-ndjson`: one AssistantStreamEvent per line.
 * `space`/`pageId`/`currentPath` is the navigation context (where the user is
 * now); the agent gets it in the workspace.
 */
export const sendAssistantMessageBodySchema = z.object({
  message: z.string().trim().min(1).max(12_000),
  conversationId: z.string().uuid().nullable().optional(),
  startNew: z.boolean().optional(),
  runMode: z.enum(['ask', 'agent']).default('ask'),
  currentPath: z.string().trim().max(1000).nullable().optional(),
  space: z.string().trim().max(200).nullable().optional(),
  pageId: z.string().trim().max(100).nullable().optional(),
});
export type SendAssistantMessageBody = z.infer<typeof sendAssistantMessageBodySchema>;

export type AssistantStreamEvent =
  | { type: 'conversation'; conversationId: string }
  | { type: 'status'; status: 'starting' | 'thinking' | 'tool' | 'writing'; label?: string }
  | { type: 'delta'; text: string }
  | { type: 'complete'; conversationId: string; message: AssistantMessage }
  | { type: 'stopped'; conversationId: string }
  | { type: 'error'; code: 'ASSISTANT_KEY_REQUIRED' | 'ASSISTANT_RUNTIME_UNAVAILABLE' | 'ASSISTANT_BUSY' | 'ASSISTANT_PROVIDER_FAILED' | 'VALIDATION' };

/** POST /api/assistant/chat/:conversationId/stop → 202 `{stopped: true}`. */

// ---------- AI assistant: continuous runs, 05.09.2026 — the orchestrator's contract ----------
// The principle: an agent run is a server job, not an HTTP request. The event
// stream is only a subscription to the job: a dropped connection, a reload or
// navigation do NOT cancel the agent; only an explicit stop does. The client
// can reconnect from any place of the buffer (`since`), so after F5 the UI
// shows the same run.

export type AssistantRunStatus = 'running' | 'done' | 'error' | 'cancelled';
export type AssistantRunStep = { status: 'starting' | 'thinking' | 'tool' | 'writing'; label?: string };

export interface AssistantRunInfo {
  runId: string;
  conversationId: string;
  runMode: AssistantRunMode;
  status: AssistantRunStatus;
  /** The last known step (for the indicator). */
  step: AssistantRunStep | null;
  /** The text of the answer accumulated so far (partial while running). */
  text: string;
  /** The sequence number of the last event in the buffer — pass it as `since` when reconnecting. */
  seq: number;
  error: string | null;
  /** The id of the saved assistant message after `done`. */
  messageId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * POST /api/assistant/runs — starts a run and AT ONCE returns 202 `{ conversationId, runId }`
 * (the body is the same SendAssistantMessageBody). Then the client subscribes to the events.
 */
export interface StartAssistantRunResponse {
  conversationId: string;
  runId: string;
}

/**
 * GET /api/assistant/runs/:runId/events?since=<seq> — NDJSON: first a replay
 * of the buffer with seq > since, then live until the terminal event
 * (complete/stopped/error). A `ping` every ~15 s keeps the connection alive
 * through proxies; it is not buffered. Every event except ping has a `seq`.
 */
export type AssistantRunEvent =
  | ({ seq: number } & Exclude<AssistantStreamEvent, { type: 'conversation' }>)
  | { type: 'ping' };

/** GET /api/assistant/runs/active → `{ run: AssistantRunInfo | null }` — the user's active run (for the indicator and for reconnecting after F5). */
export interface ActiveAssistantRunResponse {
  run: AssistantRunInfo | null;
}

/** POST /api/assistant/runs/:runId/stop → 202 `{ stopped: true }` — the only way to cancel a run. */

// ---------- AI assistant: feedback, unanswered questions, admin analytics ----------
// Three signals about answer quality, all visible to instance admins only:
// 1. 👍/👎 on any saved assistant answer (one rating per message, changeable).
// 2. A periodic "Did the assistant solve your question?" survey: due after every
//    ASSISTANT_SURVEY_EVERY assistant answers since the previous survey (answered
//    or skipped), so it comes back while the person keeps talking.
// 3. Questions the assistant could not answer or was unsure about, reported by
//    the assistant itself through the built-in `report_unanswered_question` tool
//    (always available, in Ask and Agent mode; instructions in prompts/system.md).
// Every run also records the space and page it was started from, so analytics
// can be filtered by space.
//
// Who sees the admin analytics (cookie session only; PAT → 403):
// - an instance admin — everything;
// - a space admin (explicit membership role `admin`, as in canAdministerSpace) —
//   ONLY what happened in the spaces they administer. A conversation is listed
//   when at least one of its runs was started in such a space; inside it, only
//   the messages of those runs are visible (a user message and the answer of the
//   same run), plus the surveys shown after a visible answer and the unanswered
//   reports of those spaces. Messages of other spaces and older messages without
//   a recorded space are hidden. Counters, `firstQuestion` and `space` of a row
//   are computed over the visible part only. Filter options list only those spaces.
// - anyone else — 403.

/** Assistant answers between two survey prompts. */
export const ASSISTANT_SURVEY_EVERY = 3;

export type AssistantFeedbackRating = 'up' | 'down';

/** PUT /api/assistant/messages/:messageId/feedback → `AssistantFeedbackResponse`. `null` removes the rating. Only the owner of the conversation; only assistant messages. */
export const assistantFeedbackBodySchema = z.object({
  rating: z.enum(['up', 'down']).nullable(),
});
export type AssistantFeedbackBody = z.infer<typeof assistantFeedbackBodySchema>;
export interface AssistantFeedbackResponse {
  messageId: string;
  rating: AssistantFeedbackRating | null;
}

export type AssistantSurveyAnswer = 'solved' | 'partly' | 'not_solved' | 'skipped';

/** POST /api/assistant/conversations/:conversationId/survey → 201 `{ ok: true }`. `afterMessageId` is the assistant message the survey was shown after (from `AssistantConversation.surveyDue`). */
export const assistantSurveyBodySchema = z.object({
  afterMessageId: z.string().uuid(),
  answer: z.enum(['solved', 'partly', 'not_solved', 'skipped']),
  comment: z.string().trim().max(2000).nullable().optional(),
});
export type AssistantSurveyBody = z.infer<typeof assistantSurveyBodySchema>;

/** Set on `AssistantConversation` (GET /api/assistant/chat) when the survey should be shown now. */
export interface AssistantSurveyDue {
  afterMessageId: string;
}

export type AssistantUnansweredReason = 'no_answer' | 'low_confidence';

/** The input of the assistant's built-in tool `report_unanswered_question`. */
export const reportUnansweredQuestionInputSchema = z.object({
  /** The user's question, restated so it reads on its own. */
  question: z.string().trim().min(1).max(2000),
  reason: z.enum(['no_answer', 'low_confidence']),
  /** What is missing or unclear in the documentation, if the assistant can tell. */
  missing: z.string().trim().max(2000).nullable().optional(),
});
export type ReportUnansweredQuestionInput = z.infer<typeof reportUnansweredQuestionInputSchema>;

export interface AdminAssistantUserRef {
  id: string;
  name: string;
  email: string;
}

/**
 * GET /api/admin/assistant/access → who the caller is for the analytics page.
 * 403 when the caller is neither an instance admin nor an admin of any space
 * (the client hides the menu item and shows "no access").
 */
export interface AdminAssistantAccess {
  scope: 'instance' | 'spaces';
  /** For `spaces`: the slugs the caller administers (sorted). Empty for `instance`. */
  spaces: string[];
  /** The same spaces with their current names, in the same (slug) order. Empty for `instance`. Added after `spaces`; older servers omit it. */
  spaceRefs?: Array<{ slug: string; name: string }>;
}

/** A space as the analytics shows it: the name people know, the slug as the key. */
export interface AdminAssistantSpaceRef {
  slug: string;
  /** Null when the space no longer exists (deleted/trashed) — show the slug, marked as deleted. */
  name: string | null;
}

/** A filter option list shared by the admin analytics responses. */
export interface AdminAssistantFilterOptions {
  /** Spaces that occur in the data (runs started outside a space are left out), sorted by name. The filter value is the slug. */
  spaces: AdminAssistantSpaceRef[];
  users: AdminAssistantUserRef[];
}

export interface AdminAssistantConversationRow {
  conversationId: string;
  user: AdminAssistantUserRef;
  /** The space (slug) of the first run of the conversation; null when it was started outside a space. */
  space: string | null;
  /** The name of `space`; null when there is no space or it no longer exists. */
  spaceName: string | null;
  /** The first user message of the conversation, in full. */
  firstQuestion: string;
  createdAt: string;
  updatedAt: string;
  /** Number of user messages. */
  questions: number;
  likes: number;
  dislikes: number;
  surveys: { solved: number; partly: number; notSolved: number };
  unanswered: number;
}

/**
 * GET /api/admin/assistant/conversations?space=&userId=&from=&to=&limit=&offset=
 * Newest activity first. `space` matches a conversation that has ANY run in that
 * space. `from`/`to` are ISO dates (inclusive days) on `updatedAt`. limit ≤ 200, default 50.
 */
export interface AdminAssistantConversationsResponse extends AdminAssistantFilterOptions {
  items: AdminAssistantConversationRow[];
  total: number;
  /** The caller's scope: `spaces` means everything is limited to their spaces. */
  scope: AdminAssistantAccess['scope'];
}

export interface AdminAssistantMessage extends AssistantMessage {
  /** The owner's rating of an assistant message. */
  feedback: AssistantFeedbackRating | null;
  /** The space the run producing/answering this message was started from (user and assistant messages of one run share it). */
  space: string | null;
  /** The name of `space`; null when there is no space or it no longer exists. */
  spaceName: string | null;
}

export interface AdminAssistantSurveyEntry {
  afterMessageId: string;
  answer: AssistantSurveyAnswer;
  comment: string | null;
  createdAt: string;
}

export interface AdminAssistantUnansweredItem {
  id: string;
  conversationId: string;
  user: AdminAssistantUserRef;
  space: string | null;
  /** The name of `space`; null when there is no space or it no longer exists. */
  spaceName: string | null;
  pageId: string | null;
  /** The question as the assistant restated it (the argument of its report tool) — not the user's own words. */
  question: string;
  /** What the person actually wrote: the user message of the run that raised the report. Null when the run or its message is gone (older rows), or is outside a space admin's scope. */
  userQuestion: string | null;
  reason: AssistantUnansweredReason;
  missing: string | null;
  createdAt: string;
}

/**
 * GET /api/admin/assistant/conversations/:conversationId — the dialog, read-only.
 * For a space admin only the visible part (see the scope rules above); 404 when it
 * does not exist or nothing of it is visible to the caller.
 */
export interface AdminAssistantConversationDetail {
  conversationId: string;
  user: AdminAssistantUserRef;
  title: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  messages: AdminAssistantMessage[];
  surveys: AdminAssistantSurveyEntry[];
  unanswered: AdminAssistantUnansweredItem[];
  /** How many messages of this conversation are hidden from the caller (other spaces / no recorded space); 0 for an instance admin. */
  hiddenMessages: number;
}

/** One opening of a conversation by an analytics viewer (audit_log `assistant.conversation_viewed`). */
export interface AdminAssistantViewEntry {
  /** Who opened it; null when that account has since been deleted. */
  user: AdminAssistantUserRef | null;
  at: string;
}

/**
 * GET /api/admin/assistant/conversations/:conversationId/views — who opened this dialog in the analytics,
 * newest first (the latest 50; `total` counts all). Same visibility as the dialog itself (404 when the caller cannot see it).
 */
export interface AdminAssistantConversationViews {
  items: AdminAssistantViewEntry[];
  total: number;
}

/**
 * GET /api/admin/assistant/unanswered?space=&userId=&reason=&from=&to=&limit=&offset=
 * Newest first. limit ≤ 200, default 50.
 */
export interface AdminAssistantUnansweredResponse extends AdminAssistantFilterOptions {
  items: AdminAssistantUnansweredItem[];
  total: number;
  scope: AdminAssistantAccess['scope'];
}

// ---------- Notifications and access requests (round 31) ----------

/**
 * The kind of a notification. For now ONLY the access request lives in the
 * feed (owner's decision of 11.09: "only the access request, but you may lay
 * the foundation"), yet the type is enumerated right away — precisely so that
 * adding an @ mention or a reply in a comment is an extension of the list,
 * not a rework of the table and of the whole client.
 */
export const notificationKindSchema = z.enum(['access_request', 'access_decision']);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

export type AccessRequestStatus = 'pending' | 'approved' | 'denied';

/** Who is asking: exactly as much as is needed to show the row in the feed, no extra personal data. */
export interface AccessRequestPerson {
  id: string;
  name: string;
  username?: string | null;
}

/**
 * A request for access to a SPACE (owner's decision: not to a page — page
 * rights stay a separate story). It lives as an entity of its own, not as a
 * field inside a notification: there are several administrators, each has a
 * feed of their own, and without a shared status two of them would grant
 * access twice.
 */
export interface AccessRequestSummary {
  id: string;
  space: string;
  spaceName: string;
  requester: AccessRequestPerson;
  status: AccessRequestStatus;
  createdAt: string;
  decidedAt?: string | null;
  decidedBy?: AccessRequestPerson | null;
  /** The role granted on approval — the administrator chooses it at the moment of the decision. */
  grantedRole?: SpaceRole | null;
}

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  createdAt: string;
  readAt: string | null;
  /** For both current kinds it is the same request: the administrator sees the request, the requester sees the decision. */
  accessRequest: AccessRequestSummary;
}

/** GET /api/notifications */
export interface NotificationListResponse {
  items: NotificationItem[];
  unread: number;
}

/** POST /api/access-requests — the requester asks for access to the space where they hit a 403. */
export const createAccessRequestBodySchema = z.object({ space: z.string().min(1) });
export type CreateAccessRequestBody = z.infer<typeof createAccessRequestBodySchema>;

/**
 * POST /api/access-requests/:id/decision — the administrator's decision.
 * `role` is mandatory for approval: granting access by a silent default is a
 * decision nobody made.
 */
export const decideAccessRequestBodySchema = z
  .object({ decision: z.enum(['approve', 'deny']), role: spaceRoleSchema.optional() })
  .refine((body) => body.decision !== 'approve' || body.role !== undefined, {
    message: 'role is required when approving',
    path: ['role'],
  });
export type DecideAccessRequestBody = z.infer<typeof decideAccessRequestBodySchema>;

/** POST /api/notifications/read — mark as read; an empty list means "all". */
export const markNotificationsReadBodySchema = z.object({ ids: z.array(z.string()).optional() });
export type MarkNotificationsReadBody = z.infer<typeof markNotificationsReadBodySchema>;

/**
 * The frames of the `/events` socket (cookie authorization, as in `/collab`;
 * per user, not per page). `refresh` is "something in your feed has changed,
 * re-read it": when ANOTHER administrator closed the request, sending this
 * one somebody else's row makes no sense, but the list must be updated.
 *
 * `tree` is "the sidebar tree of this space changed — fetch it again through
 * the normal API" (server/treeSignal.ts). It is deliberately a bare signal: the
 * space slug and a per-process counter `v` (informational, only ever grows
 * within one server process) — never a title, a path or a page id, so that a
 * reader of the space learns nothing about a page they are not allowed to see.
 * The refetch goes through GET /api/spaces/:space/tree, which does the page
 * access filtering as it always did.
 */
export type NotificationSocketEvent =
  | { type: 'notification'; item: NotificationItem }
  | { type: 'refresh' }
  | { type: 'tree'; space: string; v: number }
  | { type: 'ping' };

/**
 * `.agent/**` — the per-space folder of admin-only pages that tell the AI
 * assistant how to behave in that space (owner spec, 21.09.2026). Shared so
 * server/agentPath.ts's isAgentPath and the web sidebar/assistant panel
 * agree on the one literal — see SpaceInfo.agentRules above and
 * server/agentPath.ts for the actual access-control rule.
 */
export const AGENT_FOLDER = '.agent';
// ---------- forms (Round FORMS) — "Google Forms in miniature", answers land
// in a paired data table. File format + parse/serialize live in
// shared/forms/codec.ts (mirrors shared/tables/codec.ts); this section is
// only the wire/type contract, same split table's own section keeps.
// ---------------------------------------------------------------------------

/**
 * One field of a form — mirrors ONE column of its paired `.table.md`.
 * `columnId` ties it to `TableColumn.id`; `kind` is copied from that
 * column's `type` when the field is added/regenerated (kept alongside
 * rather than read live off the table, so a form still renders sensibly
 * even the instant after the table's own column type changes elsewhere).
 */
export const formFieldSchema = z.object({
  columnId: z.string().min(1),
  label: z.string().min(1),
  help: z.string().optional(),
  required: z.boolean().default(false),
  kind: tableColumnTypeSchema,
});
export type FormField = z.infer<typeof formFieldSchema>;

/**
 * `<slug>.form.md` — frontmatter (schema) + free prose (`body`, preserved
 * verbatim like a table's head/tail). See shared/forms/codec.ts's
 * parseFormFile/serializeFormFile for the byte-level format.
 */
export interface FormDoc {
  meta: { id: string; version: 1 };
  /** The paired table's page path, POSIX, relative to the SPACE content root — survives a same-space move of either file. */
  table: string;
  title: string;
  description?: string;
  /** Owner's decision: default false. Anonymous submission additionally needs a valid share token for the FORM's own page (server/forms/routes.ts). */
  public: boolean;
  submitButton?: string;
  fields: FormField[];
  body: string;
}

const formCellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]);

/** POST /api/forms/:id/submit body. `shareToken` is only consulted for an anonymous (no session) request against a `public: true` form. */
export const submitFormBodySchema = z.object({
  values: z.record(z.string(), formCellValueSchema),
  shareToken: z.string().optional(),
});
export type SubmitFormBody = z.infer<typeof submitFormBodySchema>;

export interface SubmitFormResponse {
  ok: true;
  rowId: string;
}
