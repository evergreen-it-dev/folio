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
// Obsidian canvas (16.10.2026): 'canvas' is a `*.canvas` file (JSON Canvas 1.0),
// shown read-only and never written by Folio — see shared/canvas/** and
// CanvasPayload below; "Convert to Folio board" makes a separate board from it.
// Obsidian Bases (16.10.2026): 'base' is a `*.base` file — a view over the pages of the space (shared/bases/**).
// Artifacts (21.10.2026): 'artifact' is a `<slug>.artifact/` DIRECTORY (a bundle: artifact.yaml + an HTML entry +
// assets) — a Claude artifact, a Cursor canvas or any self-contained HTML page; see docs/spec-artifacts.md.
export const pageKindSchema = z.enum(['doc', 'board', 'folder', 'table', 'pdf', 'office', 'form', 'canvas', 'base', 'artifact']);
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

/** One grant of a restricted page: to a person (`userId`) or, since 053, to a group (`groupId`) — exactly one of the two. */
export const pageAccessGrantSchema = z.union([
  z.object({ userId: z.string().uuid(), role: pageAccessGrantRoleSchema }).strict(),
  z.object({ groupId: z.string().uuid(), role: pageAccessGrantRoleSchema }).strict(),
]);
export type PageAccessGrant = z.infer<typeof pageAccessGrantSchema>;

export const updatePageAccessBodySchema = z.object({
  visibility: pageAccessVisibilitySchema,
  grants: z.array(pageAccessGrantSchema).default([]),
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

/** A group that can be (or is) granted a restricted page: it is in the page's space — holds a role there, or the space is open to the instance. */
export interface PageAccessGroup {
  groupId: string;
  slug: string;
  name: string;
  /** Active (not disabled) people in the group. */
  memberCount: number;
  /** The group's own role in the space; absent when it is in the space only through visibility `instance` / `public`. */
  spaceRole?: SpaceRole;
  grant?: PageAccessGrantRole;
}

export interface PageAccessInfo {
  visibility: PageAccessVisibility;
  ownerId?: string;
  canManage: boolean;
  members: PageAccessMember[];
  /** Groups (053): every candidate for someone who can manage the page, otherwise only the granted ones. */
  groups: PageAccessGroup[];
  /**
   * Stage 7: the restricted ANCESTORS this page inherits restrictions from,
   * root-most first (its own rule is `visibility`). The page is readable only
   * by who passes all of them and its own rule. Empty when none.
   */
  inheritedFrom: Array<{ pageId: string; title: string }>;
  /**
   * Who can open the page now, with their effective page role — present when
   * the page is restricted (own rule or inherited) and the caller can manage
   * it; `audienceCount` alone otherwise.
   */
  audience?: Array<{ userId: string; name: string; role: SpaceRole }>;
  /** Number of people who can open the page; present when the page is restricted (own rule or inherited). */
  audienceCount?: number;
}

/**
 * A page is a file on disk under data/spaces/<space>/.
 * - kind "doc": a *.md file; title = first H1 of the body, else the front
 *   matter `title:` (Hugo, Jest/Docusaurus, Jekyll), else the file name.
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
  /**
   * GET /api/spaces/:space/tree only (stage 7): `restricted` = the page has a
   * page-access rule of its own, `inherited` = it is restricted through a
   * restricted ancestor. Absent = open to the whole space.
   */
  access?: 'restricted' | 'inherited';
}

/** Full page payload: markdown body (frontmatter stripped) for docs, svg source for boards. */
export const pageDocSchema = pageMetaSchema.extend({
  markdown: z.string().optional(),
  svg: z.string().optional(),
  /**
   * A doc of a light-footprint space (a repository sub-folder with rootPath
   * set, or an Obsidian vault / a space flagged light — server/storage.ts
   * isLightFootprintSpace): its file belongs to the repository, so the editor
   * neither inserts nor guards an H1 there. Absent otherwise.
   */
  lightFootprint: z.literal(true).optional(),
  /**
   * A canvas page (kind 'canvas'): the parsed `.canvas` file with its file
   * cards resolved for THIS reader (server/canvasView.ts). Absent for every
   * other kind. Typed by CanvasPayload; kept loose here so the schema does not
   * have to mirror the whole JSON Canvas model.
   */
  canvas: z.custom<CanvasPayload>().optional(),
  /**
   * A form page (kind 'form'): what each field needs to be rendered as the
   * right control, by columnId — the select/status choices, `multiple`, the
   * members a `user` field can pick — read live from the paired table and
   * resolved for THIS reader (server/forms/service.ts buildFormChoices).
   * Absent for every other kind.
   */
  formChoices: z.custom<Record<string, FormFieldChoices>>().optional(),
  /**
   * An artifact page (kind 'artifact'): its manifest and a signed `src` for the
   * sandboxed iframe, minted for THIS reader (session, share link or public
   * site). Absent for every other kind.
   */
  artifact: z.custom<ArtifactPayload>().optional(),
});
export type PageDoc = z.infer<typeof pageDocSchema>;

export const searchHitSchema = z.object({
  id: z.string(),
  space: z.string(),
  path: z.string(),
  title: z.string(),
  snippet: z.string(),
  /** Wave 3 (search v2), additive: the page kind and its normalized tags. Older servers omit them. */
  kind: pageKindSchema.optional(),
  tags: z.array(z.string()).optional(),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

export interface SpaceInfo {
  slug: string;
  name: string;
  pageCount: number;
  /** Present when the request is authenticated. */
  myRole?: SpaceRole;
  git?: SpaceGitInfo;
  assetMode?: SpaceAssetMode;
  /** Round 27: private (default) = explicit members only; instance = plus any active user as an implicit viewer. */
  visibility?: SpaceVisibility;
  /**
   * The space is "light footprint" (an Obsidian vault, or a sub-folder of a
   * product repository): Folio never adds an `id` to its files. Effective value
   * — a non-empty rootPath implies it. Absent when false.
   */
  lightFootprint?: boolean;
  /**
   * The space's own extra scan-ignore entries (top-level names / `prefix*`
   * patterns, see normalizeScanIgnoreEntry), WITHOUT DEFAULT_SCAN_IGNORE, which
   * always applies. Sent to space admins only (GET /api/spaces); an empty array
   * means "just the defaults".
   */
  scanIgnore?: string[];
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
  agentRules?: { used: boolean; pages: number; path?: string; writingRules?: boolean };
}

// ---------- scan settings (Obsidian vault compatibility, wave 1a) ----------

/**
 * Top-level entries every scan skips, whatever the space's own list says. They
 * are dotfolders — which the scan has never indexed — written out so the rule is
 * visible (and shown in the UI) instead of being buried in a `startsWith('.')`.
 */
export const DEFAULT_SCAN_IGNORE = ['.obsidian/', '.trash/', '.git/'] as const;
export const MAX_SCAN_IGNORE_ENTRIES = 50;

/**
 * Normalizes one scan-ignore entry, or returns null when it is not acceptable.
 * An entry names a TOP-LEVEL file or folder of the content root: one path
 * segment, `*` as the only wildcard (any run of characters, never a `/`), an
 * optional trailing `/` meaning "folders only". A leading `./` or `/` is
 * dropped; `..`, inner slashes, backslashes, control characters, an empty name
 * and a pattern that is nothing but `*` (it would hide the whole space) are
 * refused. Matching is case-insensitive (server/scanIgnore.ts).
 */
export function normalizeScanIgnoreEntry(raw: string): string | null {
  let value = raw.trim();
  while (value.startsWith('./')) value = value.slice(2);
  value = value.replace(/^\/+/, '');
  const dirOnly = value.endsWith('/');
  const name = dirOnly ? value.slice(0, -1) : value;
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  if (/^\*+$/.test(name)) return null;
  return dirOnly ? `${name}/` : name;
}

export const scanIgnoreEntrySchema = z
  .string()
  .max(200)
  .refine((v) => normalizeScanIgnoreEntry(v) !== null, { message: 'a top-level file or folder name, `*` allowed, no ".." or inner slashes' })
  .transform((v) => normalizeScanIgnoreEntry(v) as string);

/**
 * PATCH /api/spaces/:space/scan-settings (space admin). Either field may be
 * sent; at least one must be. Changing `scanIgnore` rescans the space (pages
 * under a newly ignored entry leave the index, pages under a released one
 * enter it); `lightFootprint` only affects what Folio writes from then on.
 */
export const updateScanSettingsBodySchema = z
  .object({
    scanIgnore: z
      .array(scanIgnoreEntrySchema)
      .max(MAX_SCAN_IGNORE_ENTRIES)
      .transform((list) => [...new Set(list)])
      .optional(),
    lightFootprint: z.boolean().optional(),
  })
  .refine((body) => body.scanIgnore !== undefined || body.lightFootprint !== undefined, { message: 'nothing to change' });
export type UpdateScanSettingsBody = z.infer<typeof updateScanSettingsBodySchema>;

// ---------- access & permissions (round 27) ----------

/**
 * `private` — explicit members only; `instance` — plus every active user as an
 * implicit viewer; `public` (13.10.2026, published space) — everything `instance`
 * gives PLUS anonymous visitors read it as a public site (see "Public sites"
 * below). An implicit viewer never writes; restricted pages (page_access) and
 * `.agent/**` stay hidden from implicit viewers and from the public alike.
 */
export const spaceVisibilitySchema = z.enum(['private', 'instance', 'public']);
export type SpaceVisibility = z.infer<typeof spaceVisibilitySchema>;
/** True for the visibilities that grant every active user an implicit viewer role (`instance` and `public`). Use this instead of `=== 'instance'`. */
export function spaceOpenToInstance(visibility: SpaceVisibility | string | null | undefined): boolean {
  return visibility === 'instance' || visibility === 'public';
}

// ---------- Public sites (published spaces), 13.10.2026 — the orchestrator's contract ----------
// A space with visibility 'public' is served to anonymous visitors (no session) as
// a read-only site. Three ways to reach it, all served by the same app process:
//   path:      <PUBLIC_URL>/public/<slug>[/p/<id>]          — always, once public
//   subdomain: https://<subdomain>.<PUBLIC_SITES_DOMAIN>/[p/<id>]  — when the operator set PUBLIC_SITES_DOMAIN and the admin chose a label
//   domain:    https://<custom domain>/[p/<id>]              — when the admin set a custom domain (DNS CNAME -> instance host, proxy routes the host to the app)
// The server resolves subdomain/domain by the Host header; on a match the SPA's
// index.html carries <meta name="folio-public-site" content="<slug>"> and the SPA
// mounts the public site at '/'. Visitors see what an implicit viewer sees: the
// page tree, pages read-only, search limited to this space. Download (md/pdf/docx)
// and the AI assistant ("Ask" over this space, using the space/instance shared key)
// are opt-in per space. Notifications, presence, comments, editing: never.
// Anonymous read routes live under /api/public/** (registered OUTSIDE the session
// scope) and never touch request.authUser; files come from /files/<space>/<path>
// (allowed for a public space's non-restricted pages) and /a/<sha>/<name>.

export const PUBLIC_SITE_PATH_PREFIX = '/public';

/** DNS label: lowercase letters, digits, hyphen, 1–63 chars, not starting/ending with a hyphen. */
export const publicSubdomainSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'invalid subdomain');
/** Bare hostname, lowercase, no scheme/port/path, at least two labels. */
export const publicDomainSchema = z.string().trim().toLowerCase().regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/, 'invalid domain');

/** PUT /api/spaces/:space/public-settings — space admin or instance admin, cookie-only. Visibility itself is changed via PATCH /api/spaces/:space. */
export const publicPrimaryHostSchema = z.enum(['auto', 'path', 'subdomain', 'domain']);
export type PublicPrimaryHost = z.infer<typeof publicPrimaryHostSchema>;
export const updateSpacePublicSettingsBodySchema = z.object({
  subdomain: publicSubdomainSchema.nullable(),
  domain: publicDomainSchema.nullable(),
  allowDownload: z.boolean(),
  allowAssistant: z.boolean(),
  /** 14.10.2026: may search engines index the site? false → `noindex` on every page and `Disallow: /` in robots.txt. Default true. */
  indexing: z.boolean().default(true),
  /** 14.10.2026: which address is canonical. 'auto' = domain if set, else subdomain if set, else path. */
  primaryHost: publicPrimaryHostSchema.default('auto'),
});
export type SpacePublicSettings = z.infer<typeof updateSpacePublicSettingsBodySchema>;

/** GET/PUT /api/spaces/:space/public-settings. */
export interface SpacePublicSettingsResponse {
  visibility: SpaceVisibility;
  settings: SpacePublicSettings;
  /** Absolute URLs where the site answers. `path` always (live once visibility is public); `subdomain`/`domain` only when configured (and, for subdomain, when the instance has PUBLIC_SITES_DOMAIN). */
  urls: { path: string; subdomain: string | null; domain: string | null };
  /** PUBLIC_SITES_DOMAIN of this instance; null = subdomain publishing is not available here. */
  sitesDomain: string | null;
  /** Host of PUBLIC_URL — what a custom domain's CNAME should point to. */
  mainHost: string;
}

/**
 * GET /api/public/site (resolved by the Host header; 404 when the host is not a
 * published site) and GET /api/public/spaces/:slug (404 unless visibility is public).
 */
export interface PublicSiteInfo {
  space: string;
  name: string;
  allowDownload: boolean;
  allowAssistant: boolean;
  /** How the site is being reached: 'path' = main host under /public/<slug>; 'host' = subdomain or custom domain, routes at '/'. */
  mode: 'path' | 'host';
  /** The space's root page (index) to open at the site root; null when the space has none (the SPA then shows the tree). */
  homePageId: string | null;
  /** Absolute PUBLIC_URL of the instance — the "Sign in" link. */
  instanceUrl: string;
  /** 14.10.2026, from .folio/site.json (see "Space appearance" below); null when not set. */
  title: string | null;
  tagline: string | null;
  lang: string | null;
  /** Absolute/relative URLs served by GET /api/public/spaces/:slug/site-assets/:name; null when the file is not configured. */
  logoUrl: string | null;
  faviconUrl: string | null;
  /** URL of the sanitized site stylesheet (GET /api/public/spaces/:slug/site.css?v=<hash>), null when the space has no site.css. */
  cssUrl: string | null;
  /** The canonical absolute URL of the site root (according to primaryHost). */
  canonicalBase: string;
  indexing: boolean;
}

/**
 * Anonymous read routes (all GET, no session, 404 unless the space is public):
 *   GET /api/public/spaces/:slug/tree               → { tree: TreeNode[] }  (restricted, .agent, _templates excluded)
 *   GET /api/public/spaces/:slug/pages/:id          → PublicPagePayload       (same PageDoc as GET /api/pages/:id; 404 for restricted/.agent/other space)
 *   GET /api/public/spaces/:slug/resolve?path=      → { id: string }         (relative .md links)
 *   GET /api/public/spaces/:slug/search?q=          → { hits: SearchHit[] }  (this space only)
 *   GET /api/public/spaces/:slug/pages/:id/export.(md|pdf|docx)?children=0|1 → file; 404 unless allowDownload
 * Files: GET /files/:space/<path> for a public space's non-restricted page files and the files they reference.
 * Collab: WS /collab/<pageId> admits an anonymous viewer (read-only) for a public space's non-restricted page (tables render live).
 */
export interface PublicPagePayload {
  page: PageDoc;
  spaceName: string;
}

// ---------- Space appearance: the `.folio/` folder in the repository, 14.10.2026 — the orchestrator's contract ----------
// Owner's decision (14.10.2026, after the proposal): HYBRID storage. "Who sees the
// site and where" stays in PostgreSQL (visibility, subdomain/domain, download and
// assistant toggles, indexing, primary host — the publish dialog stays where it is).
// "What we show and how it looks" lives in the repository, in `.folio/` at the
// CONTENT ROOT (next to `<slug>.folio` / `.<slug>.folio`; for a rootPath space that
// is `<rootPath>/.folio/`):
//   .folio/site.json        — title, tagline, description, lang, ogImage, favicon, logo (names in assets/)
//   .folio/site.css         — stylesheet of the public site only (sanitized, never inside the app)
//   .folio/export.css       — print stylesheet for PDF (replaces <slug>.export.css)
//   .folio/pdf-header.html  — PDF header (placeholders {{page}} {{pages}} {{title}} {{space}} {{date}}; <img src="logo.png"> from assets/)
//   .folio/pdf-footer.html  — PDF footer
//   .folio/assets/          — og.png, favicon.svg, logo.png, *.woff2 … (public while the space is public)
// One settings page edits all of it: /s/<space>/settings (space admins; the
// instance admin sees the publish block only), three tabs: Site, Site appearance
// (CSS), PDF. Every file shows its repo path + "Open in repository"; each save is
// one commit `settings: update .folio/<files>`; git is an equal editor: etag per
// file, a mismatch is 409. Legacy `<slug>.folio` `export` section and
// `<slug>.export.css` are still read and are migrated into `.folio/` on the first
// save of the PDF tab (one commit). The "Powered by Folio" footer of public sites
// is NOT configurable (owner's decision).
// Security: site.css is sanitized (no @import, no comments, url() only data:image/*
// or an assets/ name rewritten to the site-assets route, size cap), served with
// text/css + nosniff + ETag only while the space is public; no JavaScript, no
// third-party snippets. Assets: allowed extensions only, per-file and per-folder caps.

export const APPEARANCE_DIR = '.folio';
export const SITE_ASSET_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}\.(png|jpe?g|webp|gif|svg|ico|woff2?)$/i;
export const SITE_ASSET_MAX_BYTES = 1024 * 1024;
export const SITE_ASSETS_MAX_TOTAL_BYTES = 5 * 1024 * 1024;
export const SITE_CSS_MAX_BYTES = 256 * 1024;
export const PDF_CHROME_MAX_BYTES = 64 * 1024;

/** `.folio/site.json`. Unknown keys are kept (passthrough) so hand edits survive a save from the UI. */
export const siteSettingsSchema = z
  .object({
    v: z.literal(1).default(1),
    /** Site name; defaults to the space name when absent. */
    title: z.string().trim().max(80).optional(),
    tagline: z.string().trim().max(160).optional(),
    /** Default meta description of the site (a page's own front matter `description` wins). */
    description: z.string().trim().max(300).optional(),
    /** BCP-47, e.g. "en", "uk", "en-GB". Defaults to the instance default. */
    lang: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/).optional(),
    /** File names inside .folio/assets/. */
    ogImage: z.string().regex(SITE_ASSET_NAME_RE).optional(),
    favicon: z.string().regex(SITE_ASSET_NAME_RE).optional(),
    logo: z.string().regex(SITE_ASSET_NAME_RE).optional(),
    /** Agent-readable files of the site (llms.txt, llms-full.txt, `<page>.md`, the <link rel="alternate"> in the head). On unless this is `false`. */
    llms: z.boolean().optional(),
  })
  .passthrough();
export type SiteSettings = z.infer<typeof siteSettingsSchema>;

export const appearanceFileSchema = z.enum(['site.json', 'site.css', 'export.css', 'pdf-header.html', 'pdf-footer.html']);
export type AppearanceFile = z.infer<typeof appearanceFileSchema>;

/**
 * PUT /api/spaces/:space/appearance — space admin, cookie-only. All changes land in
 * ONE commit. `etag` is the etag the client last saw for that file (null = it did
 * not exist); a mismatch → 409 `appearance file changed in the repository` with
 * the current state in the body. An empty `content` deletes the file.
 */
export const putAppearanceBodySchema = z.object({
  changes: z
    .array(
      z.object({
        file: appearanceFileSchema,
        content: z.string().max(1024 * 1024),
        etag: z.string().nullable(),
      }),
    )
    .min(1)
    .max(5),
});
export type PutAppearanceBody = z.infer<typeof putAppearanceBodySchema>;

export interface AppearanceFileState {
  file: AppearanceFile;
  /** Repo-relative path, e.g. "docs/.folio/site.css". */
  path: string;
  exists: boolean;
  /** sha1 of the content as stored (null when the file does not exist). */
  etag: string | null;
  content: string;
  /** 'folio' = read from .folio/; 'legacy' = read from the <slug>.folio export section or <slug>.export.css (moves into .folio/ on the first save of the PDF tab); 'none' = no content anywhere. */
  source: 'folio' | 'legacy' | 'none';
  /** Sanitizer / validation warnings for the stored content (same rules the server applies when serving). */
  warnings: string[];
}
export interface SiteAssetInfo {
  name: string;
  size: number;
  /** URL the asset is served from on the public site (null while the space is not public). */
  url: string | null;
}
/** GET /api/spaces/:space/appearance (space admin). */
export interface SpaceAppearanceResponse {
  files: AppearanceFileState[];
  assets: SiteAssetInfo[];
  /** Content root relative to the repo root ("" or the space rootPath). */
  contentRoot: string;
  /** Base URL of a file in the hosting UI (GitHub/GitLab "blob" on the space's branch), null when unknown; the client appends the repo-relative path. */
  repoFileBaseUrl: string | null;
  /** True when legacy PDF settings exist and the next save of the PDF tab will migrate them (the UI shows a banner). */
  legacyPending: boolean;
  /** True when the space is public (the CSS preview iframe can load /public/<slug>). */
  isPublic: boolean;
}
/**
 * POST /api/spaces/:space/appearance/assets?name=<file> — raw body (Content-Type of the file) or multipart `file`; name must match
 * SITE_ASSET_NAME_RE; 413 over the caps; 409 when the name exists unless `?replace=1`. Returns SiteAssetInfo. Committed as
 * `settings: add .folio/assets/<name>`. DELETE /api/spaces/:space/appearance/assets/:name → 204, commit `settings: remove …`.
 *
 * Anonymous (404 unless the space is public):
 *   GET /api/public/spaces/:slug/site.css?v=<etag>     → text/css, sanitized, nosniff, ETag, Cache-Control public max-age=300
 *   GET /api/public/spaces/:slug/site-assets/:name      → the file (SVG with the sandbox CSP), immutable caching keyed by ?v=
 *   GET /robots.txt, GET /sitemap.xml                   → host-dependent (site host: that site; main host: Disallow /s/ /share/ /api/ + sitemaps of path-mode sites)
 *   GET /public/:slug/sitemap.xml                       → the sitemap of a path-mode site (lastmod = page updatedAt; restricted/.agent/_templates excluded)
 * Server-rendered <head> for every public page (SEO): <title> = page title (front matter `title` → H1 → file name) + " · " + site title,
 * meta description = front matter `description` → site description → excerpt, og:* (site_name = site title, image = front matter
 * `image`/`cover` → site ogImage), canonical = canonicalBase + page path, <html lang>, favicon, and `noindex` when indexing is off or the
 * page is `unlisted: true`. A page that does not exist on the site answers 404 (HTML shell with the status), not 200.
 */
export type AppearanceRoutes = never;

// ---------- Index v2 (Obsidian brief, wave 1b), 14.10.2026 — the orchestrator's contract ----------
// One mdast parse per page (remark-parse + remark-gfm, positions on) at scan and
// save time feeds derived tables: headings, ^block ids, tags (body `#tag` and
// front matter `tags:`/`labels:`), the whole front matter as jsonb, and typed
// links (md | wikilink | embed | image | html | reference) with fragment and
// position. Links are resolved in a SECOND, set-based phase per space
// (index(page) writes raw rows; resolveSpaceLinks(space) joins pages_index), so
// a target that appears later resolves the old links and a deleted target turns
// its links into `unresolved` instead of deleting the rows (FK ON DELETE SET
// NULL). `pages_index.meta_version` marks rows parsed with an older parser;
// the scan re-parses them. Every read goes through the same SQL ACL fragment as
// search (space membership/visibility, page_access, `.agent` hidden,
// `_templates/` hidden). Table names are fixed in docs/spec.md §"Index v2".
// Wikilink resolution (donor §2.7): explicit extension as written, else `.md`;
// path from the source folder → path from the space root → unique basename
// (nearest folder wins) → unresolved; `#heading` by heading slug, `#^id` by block.

/** 'canvas': a file card of a `.canvas` page — its `file` path, always from the space root, matched exactly (no name lookup). */
export type LinkSyntax = 'md' | 'wikilink' | 'embed' | 'image' | 'html' | 'reference' | 'canvas';
export type LinkKind = 'page' | 'asset' | 'external' | 'unresolved';
export type LinkFragmentKind = 'heading' | 'block';

export interface PageHeading {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  /** Same slug the web outline uses (web/src/markdown/headingIds.ts rules) — the target of `#heading` links. */
  slug: string;
  line: number;
}
export interface PageBlockRef {
  /** The id after `^`, as written (no `^`). */
  blockId: string;
  line: number;
}
export interface PageTagRef {
  /** Normalized: lowercase, no leading `#`, hierarchy kept (`a/b`). */
  tag: string;
  source: 'body' | 'frontmatter';
  line: number | null;
}
export interface PageLinkRef {
  /** The target as written in the page (no `#fragment`, no `|alias`), e.g. `Note`, `folder/img.png` — what the reading view looks a wikilink up by. */
  linkPath: string;
  targetPath: string;
  targetPageId: string | null;
  syntax: LinkSyntax;
  kind: LinkKind;
  fragment: string | null;
  fragmentKind: LinkFragmentKind | null;
  /** null when there is no fragment or the target is not a page. */
  fragmentResolved: boolean | null;
  displayText: string | null;
  line: number;
  /** The source line, trimmed, ≤ 300 chars — the "context" of a backlink. */
  context: string;
}
/** GET /api/pages/:id/meta — viewer+ on the page; `.agent` pages admins only (requirePageRole). */
export interface PageMetadata {
  id: string;
  space: string;
  path: string;
  title: string;
  headings: PageHeading[];
  blocks: PageBlockRef[];
  tags: PageTagRef[];
  /** The page's whole front matter (Folio keys included, foreign keys kept). `{}` when none. */
  properties: Record<string, unknown>;
  links: PageLinkRef[];
  /** Inbound page links the caller may see. */
  backlinkCount: number;
  metaVersion: number;
}
/**
 * GET /api/pages/:id/backlinks — ADDITIVE: every entry keeps today's fields and gains
 * `syntax`, `fragment`, `line`, `context` (one entry per link, so a page linking twice appears twice;
 * clients that want one row per page dedupe by `id`).
 */
export interface BacklinkContext {
  syntax: LinkSyntax;
  fragment: string | null;
  line: number;
  context: string;
}
export interface SpaceTag {
  tag: string;
  /** Distinct pages the caller may see that carry the tag. */
  pages: number;
}
/** GET /api/spaces/:space/tags — viewer+ on the space. */
export interface SpaceTagsResponse {
  tags: SpaceTag[];
}
export interface UnresolvedLink {
  sourceId: string;
  sourcePath: string;
  sourceTitle: string;
  targetPath: string;
  syntax: LinkSyntax;
  fragment: string | null;
  line: number;
  context: string;
}
/** GET /api/spaces/:space/unresolved-links?limit=&offset= — viewer+; only sources the caller may see; sorted by targetPath, then source path. */
export interface UnresolvedLinksResponse {
  links: UnresolvedLink[];
  total: number;
}
export interface OrphanPage {
  id: string;
  path: string;
  title: string;
  updatedAt: string;
}
/** GET /api/spaces/:space/orphans — viewer+; pages with no inbound page link from a visible page, excluding the space index page, `_templates/` and `.agent/`. */
export interface OrphansResponse {
  pages: OrphanPage[];
}
// ---------- Graph view (16.10.2026) ----------
// GET /api/spaces/:space/graph and GET /api/pages/:id/graph (server/graph.ts), MCP get_graph. Built from the
// page index with the same SQL ACL as search (accessSql.ts): a node is a page the caller may open; a link to a
// page they may not open is left out altogether — no node, no ghost, no edge, not counted in any degree.
// `_templates/` and folder rows are never nodes.

/** A page kind, or a node that is not a page: a tag, a space file (attachment), an unresolved link target. */
export type GraphNodeKind = PageKind | 'tag' | 'file' | 'unresolved';

export interface GraphNode {
  /** A page id; `tag:<tag>`, `file:<path>`, `ghost:<path>` for the others. */
  id: string;
  title: string;
  kind: GraphNodeKind;
  /** Space-relative path (pages, files, unresolved targets); absent for tags. */
  path?: string;
  /** A page's tags (normalized, as the index stores them). */
  tags?: string[];
  status?: PageStatus;
  /** Number of distinct neighbours in THIS answer (edges both ways, after the ACL and the options). */
  degree: number;
  /** Pages only, ISO timestamp. */
  updatedAt?: string;
  /**
   * Set only on a page of ANOTHER space than the graph's (16.10.2026): a page an app link
   * (`/s/<space>/p/<id>`) reaches across spaces, which the caller may open. Its path is in that space.
   */
  space?: string;
  /** That space's name, with `space`. */
  spaceName?: string;
}

/**
 * A link between two nodes, directed source → target; `count` links of the source to it, any syntax. Tag edges: page → tag.
 * `kind: 'tree'` (option `tree`): parent page → child page in the page tree, `count` 1 — not a link.
 */
export interface GraphEdge {
  source: string;
  target: string;
  count: number;
  kind?: 'tree';
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Readable pages in scope before the cap (the space, or the local neighbourhood). */
  totalPages: number;
  /** True when more readable pages exist than `limit`: the most recently changed `limit` are kept. */
  truncated: boolean;
  limit: number;
  /** Local graph: the page in the centre. */
  center?: string;
}

/** Query options of both graph routes (`?tags=1&files=1&unresolved=1&orphans=0`), and of MCP get_graph. */
export interface GraphOptions {
  /** Tags as nodes (page → tag edges). Default false. */
  tags: boolean;
  /** Space files (attachments) linked from pages as nodes. Default false. */
  files: boolean;
  /** Link targets that do not exist as ghost nodes. Default false. */
  unresolved: boolean;
  /** Keep nodes without any edge. Default true. */
  orphans: boolean;
  /**
   * Parent → child edges of the page tree (`kind: 'tree'`), so a hierarchical space is not a cloud of dots; in the
   * local graph the parent, the children (and, a hop further, the siblings) are neighbours too. Default false in the
   * API and MCP; the web app turns it on unless the reader switched it off.
   */
  tree: boolean;
}

export type GraphDirection = 'both' | 'in' | 'out';

/** Readable pages one graph answer holds at most. */
export const GRAPH_PAGE_LIMIT = 10_000;

/**
 * MCP (read-only, annotated like the other read tools, NOT in MCP_WRITE_TOOL_NAMES):
 *   get_page_metadata { id } → PageMetadata
 *   list_unresolved_links { space, limit? } → UnresolvedLinksResponse
 *   list_orphans { space } → OrphansResponse
 *   get_backlinks gains the BacklinkContext fields per entry.
 * Same ACL as the REST routes; a space or page the caller cannot see → "space not found" / "page not found".
 */
// ---------- Reading Obsidian markdown (wave 2), 14.10.2026 ----------
// The reading view renders `[[wikilinks]]`, `![[embeds]]`, callouts, `%%comments%%`, `^block-id`s, `#tags` and
// `$math$` from the file as it is (shared/ofm, web/src/markdown); nothing is ever written back. It resolves the
// wikilinks of the page it shows through ONE request, GET /api/pages/:id/meta (PageMetadata.links, matched by
// `linkPath` + `fragment`), and loads an embedded note through:
//
//   GET /api/pages/:id/embed?fragment=<heading slug | ^block-id>&depth=<1..3>      → EmbedPayload
//        viewer+ on the embedded page, exactly like reading it (requirePageRole: 403 for a page the reader may not see,
//        404 for one that does not exist or is `.agent` and the reader is no admin).
//        `fragment` absent: the whole page body; a heading (its slug, or the text as written in `[[Note#Heading]]`):
//        that heading and everything under it up to the next heading of the same or a higher level; `^id`: the block
//        that carries the id (a paragraph, a list item with its children, or the block above an id standing alone).
//        A fragment the page does not have: 404 `fragment not found`. Only documents embed (400 otherwise).
//        `depth` is the nesting level of this embed — the client sends 1 for an embed in the page it shows and adds one
//        for an embed inside an embedded note; above EMBED_MAX_DEPTH (3) the server refuses (400). The client also keeps
//        the chain of page ids it descended through and shows a note instead of embedding a page into itself.
//   GET /api/public/spaces/:slug/pages/:id/embed?fragment=&depth=                  → EmbedPayload (anonymous)
//        the same, for a page of the public set (isPublicPage); anything else: 404 `page not found`.
//   GET /api/public/spaces/:slug/pages/:id/links                                    → { links: PageLinkRef[] }
//        the typed links of a public page, for wikilinks on a public site; a target outside the public set reads as
//        unresolved (no id, no fragment check).
//
// POST /api/pages gains an optional `fileStem`: the exact file name (without `.md`) of a new doc — what "Create page
// “Note”" on an unresolved wikilink sends, so `[[Note]]` resolves to the file it just made. The server refuses stems
// with path separators or characters a link cannot carry, and still makes the name unique.
export const EMBED_MAX_DEPTH = 3;
export interface EmbedPayload {
  id: string;
  space: string;
  /** Path of the embedded page — relative links and images inside `markdown` resolve against its folder. */
  path: string;
  title: string;
  markdown: string;
}
export interface PublicPageLinks {
  links: PageLinkRef[];
}

// ---------- Obsidian canvas (`.canvas`, JSON Canvas 1.0), 16.10.2026 ----------
// Owner's decision (16.10.2026): a canvas is shown as it is (read-only, the
// file is never written while viewing or indexing) and can be converted into a
// separate Folio board. The document model below is JSON Canvas 1.0
// (jsoncanvas.org/spec/1.0) after shared/canvas/parse.ts: unknown keys dropped,
// bad nodes/edges skipped with a warning, defaults filled in (fromEnd 'none',
// toEnd 'arrow').
//
//   GET  /api/pages/:id                  → PageDoc with `canvas: CanvasPayload` (viewer+)
//   GET  /api/pages/:id/canvas           → CanvasPayload (viewer+; the same object)
//   POST /api/pages/:id/canvas/convert   → CanvasConvertResult (editor+ on the space; body CanvasConvertBody)
//   GET  /api/pages/:id/canvas/convert   → CanvasConversionReport (viewer+: what the conversion would lose)
// Share links and public sites carry `canvas` in their PageDoc too, resolved for that reader.
export type CanvasSide = 'top' | 'right' | 'bottom' | 'left';
export type CanvasEnd = 'none' | 'arrow';
export type CanvasBackgroundStyle = 'cover' | 'ratio' | 'repeat';
interface CanvasNodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** A preset "1".."6" (red, orange, yellow, green, cyan, purple) or a hex colour; absent = default. */
  color?: string;
}
export interface CanvasTextNode extends CanvasNodeBase {
  type: 'text';
  /** Markdown. */
  text: string;
}
export interface CanvasFileNode extends CanvasNodeBase {
  type: 'file';
  /** Path from the space root, as written in the file — '' in a payload when the reader may not open the target (CanvasFileTarget 'noAccess'). */
  file: string;
  /** `#Heading` or `#^block`, as written. */
  subpath?: string;
}
export interface CanvasLinkNode extends CanvasNodeBase {
  type: 'link';
  url: string;
}
export interface CanvasGroupNode extends CanvasNodeBase {
  type: 'group';
  label?: string;
  /** Path of a background image from the space root. */
  background?: string;
  backgroundStyle?: CanvasBackgroundStyle;
}
export type CanvasNode = CanvasTextNode | CanvasFileNode | CanvasLinkNode | CanvasGroupNode;
export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: CanvasSide;
  fromEnd: CanvasEnd;
  toNode: string;
  toSide?: CanvasSide;
  toEnd: CanvasEnd;
  color?: string;
  label?: string;
}
/** Nodes in file order = z-order (first is drawn lowest). */
export interface CanvasDocument {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}
/** What a file card (or a group background) points at, resolved BY PATH when the canvas is read, for this reader. */
export type CanvasFileTarget =
  | {
      status: 'page';
      pageId: string;
      kind: PageKind;
      title: string;
      path: string;
      icon?: string;
      /** A document: the start of the note, or the `subpath` section/block, as Markdown (cut at CANVAS_EXCERPT_MAX_CHARS). */
      excerpt?: string;
      /** The excerpt was cut. */
      excerptTruncated?: boolean;
      /** The `subpath` names a heading or block the note does not have (the card then shows the note's start). */
      subpathMissing?: boolean;
    }
  | {
      /** A file of the space that is not a page (an image, audio, video, any attachment). */
      status: 'file';
      path: string;
      media: 'image' | 'audio' | 'video' | 'other';
    }
  /** Nothing at that path now (deleted, or moved outside Folio — a canvas is not rewritten in a light-footprint space). */
  | { status: 'missing'; path: string }
  /** A page this reader may not open: no title, no path. */
  | { status: 'noAccess' };
export interface CanvasPayload {
  /** null when the file is not a readable JSON Canvas — `error` says why, in English. */
  document: CanvasDocument | null;
  error?: string;
  /** Things skipped or cut while reading (bad nodes, unknown types, the size cap) — shown in a collapsible note. */
  warnings: string[];
  /** File cards by node id. */
  files: Record<string, CanvasFileTarget>;
  /** Group background images by group node id. */
  backgrounds: Record<string, CanvasFileTarget>;
}
export const CANVAS_EXCERPT_MAX_CHARS = 2000;

export const canvasConvertBodySchema = z.object({
  /** The new board's title; default "<canvas title> (board)". */
  title: z.string().trim().min(1).max(200).optional(),
  /** Folder for the board, from the space root; default the canvas's own folder. */
  parentPath: z.string().optional(),
});
export type CanvasConvertBody = z.infer<typeof canvasConvertBodySchema>;
/** One kind of loss the conversion has, with how many cards/edges it touches. `code` is stable (the UI translates it). */
export interface CanvasConversionLoss {
  code:
    | 'markdownFlattened'
    | 'textCut'
    | 'noteContentNotEmbedded'
    | 'imageAsCard'
    | 'mediaAsCard'
    | 'linkPreview'
    | 'groupBackground'
    | 'nestedGroups'
    | 'edgeRouting'
    | 'noAccessCards'
    | 'missingCards'
    | 'skippedInvalid';
  count: number;
}
export interface CanvasConversionReport {
  losses: CanvasConversionLoss[];
  nodes: number;
  edges: number;
}
export interface CanvasConvertResult {
  board: PageMeta;
  report: CanvasConversionReport;
}

/**
 * 3 (16.10.2026): Folio's own app URLs (`/s/<space>/p/<id>`, the space home, absolute on PUBLIC_URL's host, bare
 * pasted ones) are page links, across spaces too — every document is parsed again once.
 */
export const INDEX_META_VERSION = 3;

// ---------- Obsidian brief, wave 3 (14.10.2026) — the orchestrator's contract ----------
// Owner's decisions (14.10.2026): (1) files of a space (assets/, attachments, any
// non-page file under the content root) are indexed AS FILES — a separate table,
// never a page kind, never in the tree or the search — so links and embeds to
// them resolve through the index and missing attachments show up as unresolved;
// (2) property TYPES live in the repository, `.folio/properties.json`, with
// `.obsidian/types.json` read as the default when Folio's own file is absent;
// (3) `labels:` stays a read-only synonym of `tags:` — the UI always writes
// `tags:` and the docs recommend only `tags:`; (4) a Folio key with a value Folio
// would not write (e.g. `status: deprecated`) is kept as is and shown in the
// properties panel as a "foreign value", never rewritten. The properties panel
// is collapsed by default. Front matter is edited OUTSIDE the collaborative
// body: PUT /api/pages/:id/properties rewrites the front matter block only
// (byte-preserving everything else, like mergeFrontmatter) and commits like a save.

// --- files of a space ---
export interface SpaceFileInfo {
  /** Path relative to the content root, e.g. "assets/diagram.png". */
  path: string;
  size: number;
  updatedAt: string;
  /** Pages (visible to the caller) that link to or embed the file. */
  referencedBy: number;
}
/** GET /api/spaces/:space/files?prefix=&q=&limit=&offset= — viewer+; lists indexed files (dotfiles, .git, .folio/, pages never). */
export interface SpaceFilesResponse {
  files: SpaceFileInfo[];
  total: number;
}

// --- properties (front matter) and their types ---
export const propertyTypeSchema = z.enum(['text', 'number', 'checkbox', 'date', 'datetime', 'list', 'tags', 'aliases']);
export type PropertyType = z.infer<typeof propertyTypeSchema>;
/** `.folio/properties.json` */
export const propertyTypesFileSchema = z.object({
  v: z.literal(1).default(1),
  types: z.record(z.string().min(1).max(100), propertyTypeSchema).default({}),
}).passthrough();
export type PropertyTypesFile = z.infer<typeof propertyTypesFileSchema>;
/** GET /api/spaces/:space/property-types (viewer+) — merged view; PUT (space admin) writes `.folio/properties.json` (one commit). */
export interface SpacePropertyTypesResponse {
  types: Record<string, PropertyType>;
  /** Where the types came from: Folio's own file, Obsidian's `.obsidian/types.json`, or nothing. */
  source: 'folio' | 'obsidian' | 'none';
  /** Keys seen in the space's front matter with their inferred type and page count (for the picker). */
  known: { key: string; inferred: PropertyType; pages: number }[];
}
export const updatePropertyTypesBodySchema = z.object({ types: z.record(z.string().min(1).max(100), propertyTypeSchema) });
export type UpdatePropertyTypesBody = z.infer<typeof updatePropertyTypesBodySchema>;

/** GET /api/pages/:id/properties — viewer+ (requirePageRole). */
export interface PagePropertiesResponse {
  /** The whole front matter as parsed (Folio keys included, foreign keys kept). */
  properties: Record<string, unknown>;
  /** Effective types (space types + inference for keys without a type). */
  types: Record<string, PropertyType>;
  /** Folio-owned keys (id, order, status, icon, cover) whose current value Folio would not write itself — shown read-only as "foreign value". */
  foreign: string[];
  /** Keys the editor must not offer for editing (id). */
  readOnly: string[];
  canEdit: boolean;
  /**
   * Optimistic lock token — send it back as the PUT's `etag`. A document: sha1 of its front matter block as it is on
   * disk (delimiters included), null without one. A table / form: sha1 of its own properties (the reserved keys
   * left out, so a schema edit does not invalidate it). A board / PDF / Office page: sha1 of the sidecar file,
   * null without one. Added by the A1 server (14.10.2026).
   */
  etag: string | null;
  /**
   * Boards, PDFs and Office pages (15.10.2026): the sidecar their properties live in, relative to the space's
   * content root (`.folio/docs/report.pdf.props.yaml`) — present even before the file exists. Absent for documents,
   * tables and forms (their properties are the page file's own front matter).
   */
  sidecar?: string;
  /**
   * Which of Folio's own keys (`id`, `order`, `status`, `icon`, `cover`) Folio validates on THIS page — the rest of
   * them are ordinary properties here (16.10.2026). A document in a native space: all five. A document in a
   * light-footprint space (an Obsidian vault, a repository with files of its own): all but `status`, which is an
   * ordinary property there (any value, typed like other keys; Folio's own page status reads `draft` / `published` /
   * `archived` from it and takes anything else as `published`). A table, form, board or file page: none.
   * Absent from an older server: the client then treats `status` as Folio's key, as before.
   */
  folioKeys?: string[];
}
/**
 * PUT /api/pages/:id/properties — editor+ on the page, cookie or write-scope PAT.
 * Replaces the editable properties with `properties` (a key missing from
 * `properties` is removed; `id` can never be changed; Folio keys keep their
 * validation; an existing `labels:` is never removed or migrated by omission);
 * byte-preserves the body and unknown formatting (same guarantees as
 * mergeFrontmatter). Documents: the file's front matter, the debounced commit
 * like a page save. Tables / forms: their own keys of the block — a reserved
 * key (`columns`, `fields`, …) sent is a 400. Boards / PDFs / Office pages: the
 * sidecar `.folio/<path>.props.yaml`, created by the first property, deleted
 * with the last, ONE commit of that file (`settings: update|remove …`).
 */
export const updatePagePropertiesBodySchema = z.object({
  properties: z.record(z.string().min(1).max(100), z.unknown()),
  /** Optimistic lock: the file's current etag (sha1 of the front matter block) from GET; mismatch → 409. */
  etag: z.string().nullable().optional(),
});
export type UpdatePagePropertiesBody = z.infer<typeof updatePagePropertiesBodySchema>;

// --- tags ---
/** GET /api/spaces/:space/tags/:tag/pages?limit=&offset= — viewer+; `tag` is the normalized tag (URL-encoded, `/` allowed). */
export interface TagPagesResponse {
  tag: string;
  pages: { id: string; path: string; title: string; updatedAt: string; sources: ('body' | 'frontmatter')[] }[];
  total: number;
}
/**
 * POST /api/spaces/:space/tags/rename — editor+ on the space; rewrites `#from` (and `#from/…` children) in
 * bodies and `from` in `tags:`/`labels:` front matter of every page the caller may edit, ONE commit
 * `docs: rename tag #from -> #to`; pages the caller can open but not edit are skipped and counted; pages they cannot open are neither changed nor counted.
 */
export const renameTagBodySchema = z.object({
  from: z.string().trim().min(1).max(200),
  to: z.string().trim().min(1).max(200).regex(/^[\p{L}\p{N}_\-/]+$/u, 'invalid tag'),
});
export type RenameTagBody = z.infer<typeof renameTagBodySchema>;
export interface RenameTagResult {
  pagesChanged: number;
  pagesSkipped: number;
}

// --- search v2 ---
/**
 * GET /api/search?q=&space=&limit=&offset= — the same route; `q` is parsed by `parseSearchQuery` (shared/searchQuery.ts):
 *   words             → websearch_to_tsquery('simple', unaccent(words)) OR title trigram
 *   "exact phrase"    → phrase search
 *   -word             → exclusion
 *   tag:a/b           → page_tags (hierarchy: tag:a also matches a/b)
 *   kind:doc|table|board|form|pdf|office
 *   status:draft|published|archived (Folio's page status; any other value → the front matter `status`, e.g. status:todo)
 *   in:folder/        → path prefix
 *   prop:key=value    → front matter equality (string/number/boolean), prop:key (key exists)
 * Operators AND together; the ACL is the same SQL fragment (accessSql). `SearchHit` gains optional `tags` and `kind`.
 */
export interface SearchQueryAst {
  words: string[];
  phrases: string[];
  excluded: string[];
  tags: string[];
  kinds: PageKind[];
  statuses: PageStatus[];
  /**
   * `status:` values other than Folio's three (`status:todo`, 16.10.2026): matched against the front matter `status`
   * key as text, case-insensitively — what a vault's own status values need. OR-ed with `statuses` (one operator, one
   * list). Optional: an AST built by hand without it has none.
   */
  statusValues?: string[];
  pathPrefixes: string[];
  props: { key: string; value?: string }[];
}
export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  /** Space slug the search is pinned to, or null for all spaces. */
  space: string | null;
  createdAt: string;
}
/** GET /api/me/saved-searches → { searches }; POST { name, query, space } → SavedSearch (max 50 per user); DELETE /api/me/saved-searches/:id → 204. Cookie or PAT (read for GET). */
export const createSavedSearchBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  query: z.string().trim().min(1).max(500),
  space: z.string().trim().max(200).nullable().default(null),
});
export type CreateSavedSearchBody = z.infer<typeof createSavedSearchBodySchema>;
export interface SavedSearchesResponse {
  searches: SavedSearch[];
}

/**
 * "Ask Folio AI" on a public site (13.10.2026) — anonymous visitors ask questions
 * about THIS space only. Registered outside the session scope; every route 404s
 * `space not found` unless the space is public AND `allowAssistant` is on, and
 * is refused (403) in the public demo. Runs are Ask-only and act as the built-in
 * "Public visitor" system user, confined to the public page set of this one space
 * (no restricted page, no `.agent/**` content, no `_templates/`, no other space,
 * no page history). Key: the space's shared key → the instance key → CURSOR_API_KEY
 * (a personal key never applies) — 409 `Folio AI is not configured for this site`
 * when there is none.
 *
 *   POST /api/public/spaces/:slug/assistant/runs                       body PublicAssistantRunBody → 202 PublicAssistantRunStarted
 *        Limits per process, sliding hour, checked before any work → 429 + Retry-After:
 *        PUBLIC_ASSISTANT_RUNS_PER_HOUR per IP (default 20), PUBLIC_ASSISTANT_SPACE_RUNS_PER_HOUR per space (default 200).
 *        Without `conversationId` a new conversation and a new `guestToken` are created; with it, `guestToken`
 *        must be the one that conversation was created with (404 otherwise). A `pageId` outside the public set is ignored.
 *   GET  /api/public/spaces/:slug/assistant/runs/:runId/events?since=&guestToken=   → NDJSON AssistantRunEvent (same stream as the signed-in route)
 *   POST /api/public/spaces/:slug/assistant/runs/:runId/stop            body { guestToken } → 202 { stopped: true }
 *   GET  /api/public/spaces/:slug/assistant/conversations/:id?guestToken=           → PublicAssistantConversation
 * A wrong/missing guest token, a run or conversation of another space, and an unknown id are all the same 404.
 * The guest token is a bearer secret of that one conversation: keep it client-side (e.g. sessionStorage), never in a URL the visitor shares.
 */
export const publicAssistantRunBodySchema = z.object({
  message: z.string().trim().min(1).max(4000),
  conversationId: z.string().uuid().optional(),
  guestToken: z.string().max(128).optional(),
  /** The page the visitor is reading — navigation context for the answer; ignored unless it is a public page of this space. */
  pageId: z.string().trim().max(100).optional(),
});
export type PublicAssistantRunBody = z.infer<typeof publicAssistantRunBodySchema>;

/** 202 of POST /api/public/spaces/:slug/assistant/runs. `guestToken` is the conversation's token (new or the one sent). */
export interface PublicAssistantRunStarted {
  runId: string;
  conversationId: string;
  guestToken: string;
}

/** POST /api/public/spaces/:slug/assistant/runs/:runId/stop. */
export const publicAssistantStopBodySchema = z.object({ guestToken: z.string().max(128) });

/** GET /api/public/spaces/:slug/assistant/conversations/:id?guestToken= — the chat to restore after a reload. */
export interface PublicAssistantConversation {
  messages: Array<Pick<AssistantMessage, 'id' | 'role' | 'content' | 'createdAt'>>;
  /** The run still in progress in this conversation (subscribe to its events), or null. */
  activeRunId: string | null;
}

export const updateSpaceVisibilityBodySchema = z.object({ visibility: spaceVisibilitySchema });

/**
 * Where pasted/uploaded images of a space go: 'store' = Folio's content-addressed
 * object storage (default), 'repo' = `assets/` inside the space's content root,
 * i.e. in the repository next to the docs.
 */
export const spaceAssetModeSchema = z.enum(['store', 'repo']);
export type SpaceAssetMode = z.infer<typeof spaceAssetModeSchema>;

/** PUT /api/spaces/:space/asset-mode (space admin). */
export const updateSpaceAssetModeBodySchema = z.object({ assetMode: spaceAssetModeSchema });
export type UpdateSpaceAssetModeBody = z.infer<typeof updateSpaceAssetModeBodySchema>;

/**
 * POST /api/spaces/:space/assets response. `url` is always a ready-to-use URL on
 * this origin. `path` is present ONLY for a repo-mode upload: the file's path
 * relative to the space's content root (e.g. `assets/diagram.png`), which the
 * editor turns into a page-relative Markdown link so the image also renders on
 * GitHub.
 */
export interface UploadAssetResponse {
  url: string;
  path?: string;
}

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
/** A group row of the matrix (053). */
export interface AccessMatrixGroup {
  id: string;
  slug: string;
  name: string;
  memberCount: number;
  archived: boolean;
}
export interface AccessMatrixResponse {
  users: AccessMatrixUser[];
  spaces: AccessMatrixSpace[];
  /** roles[userId][spaceSlug] — undefined = no access; a role from an `instance`-visibility space's implicit viewer grant is NOT included here (UI derives it from spaces[].visibility instead, so it can render the grey "viewer (all)" cell distinctly from an explicit membership). Direct memberships only: a role a user has through a group is in `groupRoles` + the group's members, not here. */
  roles: Record<string, Record<string, SpaceRole>>;
  /** Groups (053): every group, archived ones included (they grant nothing while archived). */
  groups: AccessMatrixGroup[];
  /** groupRoles[groupId][spaceSlug] — the group's own role in that space. */
  groupRoles: Record<string, Record<string, SpaceRole>>;
}

/** POST /api/access/bulk request/body schemas defined further below, after `spaceRoleSchema` (avoids a TDZ reference — see there). */
export interface AccessBulkResult {
  applied: { userId: string; space: string; role: SpaceRole | null }[];
  errors: { userId: string; space: string; error: string }[];
}

/** GET /api/spaces/:space/access-log and GET /api/users/:id/access share this shape's event rows (round 27 §2.4/§7). */
export interface AccessLogEntry {
  id: string;
  action:
    | 'access.grant'
    | 'access.revoke'
    | 'access.self_grant'
    | 'access.group_grant'
    | 'access.group_revoke'
    | 'space.visibility'
    | 'space.public_settings'
    | 'group.create'
    | 'group.update'
    | 'group.archive'
    | 'group.restore'
    | 'group.delete'
    | 'group.member_add'
    | 'group.member_remove'
    | 'group.manager_set';
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
  /** Groups (053) the user belongs to. */
  groups: Array<{ id: string; slug: string; name: string; isManager: boolean; archived: boolean }>;
}

export const createPageBodySchema = z.object({
  space: z.string(),
  /** Parent directory path relative to space root; "" for space root. */
  parentPath: z.string(),
  title: z.string().min(1),
  kind: pageKindSchema.default('doc'),
  /**
   * Wave 2 (Obsidian): the exact file name of a new DOC, without `.md` — "Create page “Note”" on an unresolved
   * `[[Note]]` sends `Note` so the link finds the file. Ignored for other kinds. No `/`, `\\`, `#`, `|`, `^`, `:`,
   * `[`, `]`, `%`, no leading dot; made unique like any name.
   */
  fileStem: z.string().min(1).max(200).optional(),
  /** Obsidian Bases: the `.base` YAML of a new kind:'base' page (from "Save as base" or the editor); the starter view when absent. Ignored for other kinds. */
  base: z.string().max(256 * 1024).optional(),
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

/**
 * POST /api/pages/from-template (the owner, 19.10.2026): a template from the
 * space's `_templates/` folder copied under `parentPath` — any kind, its
 * subpages along — with {{date}}/{{author}}/{{title}} filled in its documents.
 */
export const createFromTemplateBodySchema = z.object({
  templateId: z.string().min(1),
  space: z.string().min(1),
  /** Parent directory relative to the space root; "" for the root — as CreatePageBody.parentPath. */
  parentPath: z.string(),
  /** Title of the new root page. Omitted: the template's own title. */
  title: z.string().trim().min(1).max(300).optional(),
});
export type CreateFromTemplateBody = z.infer<typeof createFromTemplateBodySchema>;

/** POST /api/pages/:id/make-template: the page copied into the space's `_templates/` folder. */
export const makeTemplateBodySchema = z.object({
  /** Bring the page's subpages along (default true). */
  includeChildren: z.boolean().default(true),
  /** The template's name (the root copy is retitled). Omitted: the page's own title. */
  title: z.string().trim().min(1).max(300).optional(),
  /** The template's description, kept in its `template-description` property. Omitted or empty: none. */
  description: z.string().trim().max(1000).optional(),
});
export type MakeTemplateBody = z.infer<typeof makeTemplateBodySchema>;

/** POST /api/spaces/:space/templates: a blank document template — the "New template" dialog (name + description) in one round trip. */
export const createBlankTemplateBodySchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(1000).optional(),
});
export type CreateBlankTemplateBody = z.infer<typeof createBlankTemplateBodySchema>;

/** The property that holds a template's description (on the template's root page only; a page made from the template does not carry it). */
export const TEMPLATE_DESCRIPTION_KEY = 'template-description';

/** One row of GET /api/spaces/:space/templates: the template's page plus its description, when it has one. */
export type TemplateListItem = PageMeta & { description?: string };

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

export const uiLanguageSchema = z.enum(['uk', 'en']);
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
  /** true — `path` itself holds an `.obsidian/` folder: the repository (or the chosen sub-folder) is an Obsidian vault. */
  vault?: boolean;
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
  /**
   * Server-side only: `true` for a built-in system account (13.10.2026: the
   * "Public visitor" user that anonymous public-site assistant runs act as —
   * db/migrations/039_public_assistant.sql). Absent for every real person, so
   * no response about a signed-in user carries it. A system account never
   * signs in and never appears in a people listing.
   */
  isSystem: z.boolean().optional(),
});
export type User = z.infer<typeof userSchema>;

/** GET /api/auth/state — public; drives the client auth gate. */
export interface AuthState {
  needsSetup: boolean;
  user: User | null;
  /** space slug -> my role: explicit space_members rows, plus (round 27) an implicit 'viewer' for every `visibility: 'instance'` space. Instance-admin grants NOTHING extra here — see docs/spec-access.md §1/§2. */
  memberships: Record<string, SpaceRole>;
  /** "Sign in with Google" is configured and enabled (the `google` single sign-on provider, server/auth/providers.ts). Kept for older clients; the login screen reads `ssoProviders`. */
  google: boolean;
  /** Enabled single sign-on providers (server/auth/oidc.ts) — one "Continue with …" button each. Absent when there are none. */
  ssoProviders?: SsoProviderPublic[];
  /**
   * Public-demo mode (server/demo.ts, FOLIO_DEMO_MODE=1): present ONLY then — absent on every ordinary instance. On the login screen it lists the demo accounts to sign in as; for an authenticated session `accounts` is empty (the header banner needs only the reset interval).
   */
  demo?: DemoInfo;
  /**
   * Optional product analytics (server/analytics.ts): present ONLY when the operator set FOLIO_POSTHOG_KEY. Absent on every ordinary instance, which then never loads or contacts anything.
   */
  analytics?: AnalyticsConfig;
  /**
   * Optional error reporting and the "Report a problem" dialog (server/sentry.ts): present ONLY when the operator set SENTRY_DSN.
   * Absent on every ordinary instance, which then never loads or contacts anything.
   */
  sentry?: SentryWebConfig;
}

/** The public part of the Sentry setup, handed to the web app by GET /api/auth/state. The DSN is a public key by design. */
export interface SentryWebConfig {
  dsn: string;
  environment: string;
  /** The build (short git sha) when the image was built with FOLIO_RELEASE; the same value the server reports. */
  release?: string;
  /** 0..1, from SENTRY_TRACES_SAMPLE_RATE. */
  tracesSampleRate: number;
  /**
   * Session Replay (text, inputs and media masked; see web/src/sentry). Absent = off. Recording is a rolling in-memory
   * buffer that leaves the browser only when an error happens, when a sampled session is recorded, or when the person
   * attaches it to a "Report a problem".
   */
  replay?: SentryReplayConfig;
}

export interface SentryReplayConfig {
  /** SENTRY_REPLAY (default on when SENTRY_DSN is set; 0/false/off turns it off). */
  enabled: boolean;
  /** 0..1, SENTRY_REPLAY_SESSION_RATE: the share of sessions recorded from the start and sent in full (default 0). */
  sessionSampleRate: number;
  /** 0..1, SENTRY_REPLAY_ON_ERROR: the share of sessions with an error whose last minute is sent (default 1). */
  onErrorSampleRate: number;
}

/** PostHog project token (a public "phc_" key) and ingestion host, handed to the web app by GET /api/auth/state. */
export interface AnalyticsConfig {
  key: string;
  host: string;
}

/** One public demo account, shown as a card on the login screen. The password is public by design — it is only ever served while demo mode is on. */
export interface DemoAccount {
  email: string;
  password: string;
  name: string;
  /** Short free-text label, e.g. "Editor". */
  role: string;
  /** One line about what this account can do, e.g. "Editor in Engineering and Product". */
  description: string;
}

export interface DemoInfo {
  accounts: DemoAccount[];
  /** FOLIO_DEMO_RESET_HOURS — how often the operator resets the data; null = not stated. */
  resetHours: number | null;
}

export const setupBodySchema = z.object({
  email: z.email(),
  name: z.string().min(1),
  password: z.string().min(8),
});
/** `local`: sent from /login?local — an instance admin's audited password sign-in for a domain that must use single sign-on (break-glass). */
export const loginBodySchema = z.object({ email: z.email(), password: z.string().min(1), local: z.boolean().optional() });
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

// ---------- groups (053, docs/spec-access.md §15) ----------
// A named set of people that holds roles in spaces and grants on restricted
// pages. No nesting. Created / renamed / archived / deleted by instance admins;
// members flagged `isManager` may edit the membership; a space admin grants or
// revokes a group's role in their own space only. All routes are cookie-only.

export const groupSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase letters, digits and dashes');
export const groupSourceSchema = z.enum(['local', 'oidc', 'saml', 'scim']);
export type GroupSource = z.infer<typeof groupSourceSchema>;

/** GET /api/groups row. */
export interface GroupInfo {
  id: string;
  slug: string;
  name: string;
  description: string;
  source: GroupSource;
  archivedAt: string | null;
  createdAt: string;
  /** Active (not disabled) members. */
  memberCount: number;
  /** The caller may edit the membership (instance admin, or a manager of this group). */
  canManage: boolean;
}

export interface GroupMemberInfo {
  userId: string;
  name: string;
  email: string;
  username?: string;
  disabled: boolean;
  isManager: boolean;
  source: GroupSource;
  addedAt: string;
}

/** A space where the group holds a role. */
export interface GroupSpaceRoleInfo {
  space: string;
  spaceName: string;
  role: SpaceRole;
}

/** GET /api/groups/:id */
export interface GroupDetail extends GroupInfo {
  members: GroupMemberInfo[];
  spaces: GroupSpaceRoleInfo[];
}

/** POST /api/groups (instance admin). */
export const createGroupBodySchema = z.object({
  slug: groupSlugSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(''),
});
export type CreateGroupBody = z.infer<typeof createGroupBodySchema>;

/** PATCH /api/groups/:id (instance admin). `archived: true` archives (the group then grants nothing), `false` brings it back. */
export const updateGroupBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1000).optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined || v.archived !== undefined, { message: 'nothing to change' });
export type UpdateGroupBody = z.infer<typeof updateGroupBodySchema>;

/** POST /api/groups/:id/members (instance admin or a manager of the group). Already-present members keep their manager flag unless `isManager` is given. */
export const addGroupMembersBodySchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(500),
  isManager: z.boolean().optional(),
});
export type AddGroupMembersBody = z.infer<typeof addGroupMembersBodySchema>;

/** PUT /api/groups/:id/members/:userId (instance admin or a manager of the group). */
export const setGroupManagerBodySchema = z.object({ isManager: z.boolean() });

/** PUT /api/spaces/:space/groups/:groupId (space admin or instance admin). */
export const setSpaceGroupRoleBodySchema = z.object({ role: spaceRoleSchema });

/** A group's row in a space's members list. */
export interface SpaceGroupMemberInfo {
  group: { id: string; slug: string; name: string; archived: boolean };
  role: SpaceRole;
  memberCount: number;
}

/** GET /api/spaces/:space/members */
export interface SpaceMembersResponse {
  members: SpaceMemberInfo[];
  /** Groups (053) holding a role in the space. */
  groups: SpaceGroupMemberInfo[];
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
  /** text: markers in the file; deleted: one side deleted what the other edited; binary: both sides changed the same non-text file. Absent from older servers = text. */
  kind?: 'text' | 'deleted' | 'binary';
  /** kind 'deleted' only: which side removed the file ('folio' = this instance, 'git' = the remote). */
  deletedBy?: 'folio' | 'git';
}

/** POST /api/spaces/:space/git/resolve-conflict — the explicit choice for one deletion or binary conflict. */
export const gitConflictChoice = z.enum(['keep-page', 'delete-page', 'keep-mine', 'take-git']);
export type GitConflictChoice = z.infer<typeof gitConflictChoice>;
export const resolveGitConflictBody = z.object({ path: z.string().min(1), choice: gitConflictChoice });
export interface ResolveGitConflictResponse {
  git: SpaceGitInfo;
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
  /** Light footprint (no ids in files). Omitted = on for a repository that brings its own files (an Obsidian vault, a notes repo, a wiki), off for an empty repository and for one that already is a Folio space (a `<slug>.folio` at its root); a non-empty rootPath is light regardless. */
  lightFootprint: z.boolean().optional(),
});
export type CreateSpaceGitBody = z.infer<typeof createSpaceGit>;

/** POST /api/spaces and POST /api/spaces/:space/connect-git: the space, plus whether the repository turned out to be an Obsidian vault (an `.obsidian/` folder at the content root or the repository root). */
export type SpaceWithVaultNote = SpaceInfo & { vaultDetected?: boolean };

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

/** GET /api/pages/:id/history/:sha response. Doc -> markdown (frontmatter stripped, like a normal GET); board -> svg (the raw file at that sha); pdf/office -> file (metadata only). Exactly one is present, keyed by the page's own `kind`. */
export interface PageAtShaResponse {
  markdown?: string;
  svg?: string;
  /** pdf/office page: the file's bytes are not inlined here (GET /api/pages/:id/history/:sha/file serves them); this describes the file as it was then. */
  file?: { path: string; ext: string; size: number };
}

/** POST /api/pages/:id/file — the page after its file was replaced, plus the commit that holds the version just replaced (restore it to undo); null when the new file was byte-identical. */
export interface ReplaceFilePageResponse extends PageMeta {
  previousSha: string | null;
}

/** Instance-wide config a client needs before it's in any particular space. */
export interface FolioConfig {
  defaultRepoUrl: string | null;
  /** true when "Connect with GitHub" (OAuth App, github.com only) is configured on this instance — see server/auth/githubConnect.ts. */
  githubOAuth: boolean;
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

/** One OAuth connection ("Connected apps"): an app a user approved for MCP access. */
export interface OAuthConnectionInfo {
  id: string;
  clientName: string;
  /** Host of the client's callback, so a user can tell apps with the same name apart. */
  redirectHost: string;
  scopes: ApiTokenScope[];
  createdAt: string;
  lastUsedAt: string | null;
}

// ---------- chat link previews: Slack, Microsoft Teams (16.10.2026) ----------
// A chat user linked to a Folio user through Folio's own OAuth (server/integrations/chat).
// GET/DELETE /api/me/chat-links(/:id) — the person's own, cookie session only.
// GET /api/admin/integrations/chat, GET/DELETE /api/admin/integrations/chat/links(/:id) — instance admin, cookie only.

export type ChatPlatform = 'slack' | 'teams';

export interface ChatLinkInfo {
  id: string;
  platform: ChatPlatform;
  /** The chat user's display name as the platform reported it at connection time; null when unknown. */
  platformUserName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AdminChatLinkInfo extends ChatLinkInfo {
  userId: string;
  userName: string;
  userEmail: string;
}

export interface ChatPlatformStatus {
  /** Every required variable is present (and FOLIO_SECRET, which encrypts the tokens). */
  configured: boolean;
  /** Variable name → present. Never a value. */
  env: Record<string, boolean>;
  /** URLs to paste into the platform's app settings. */
  endpoints: Record<string, string>;
  /** Hosts link previews are registered for (unfurl domains / Teams messageHandlers domains). */
  domains: string[];
  linkedUsers: number;
}

export interface ChatIntegrationsAdminInfo {
  slack: ChatPlatformStatus;
  teams: ChatPlatformStatus;
}

// ---------- login sessions and the instance audit log (stage 4 of groups + SSO) ----------

/** One signed-in browser session — GET /api/me/sessions (own) and GET /api/users/:id/sessions (instance admin). The cookie token and its hash never leave the server. */
export interface SessionInfo {
  /** Opaque handle for revoking this session. */
  id: string;
  createdAt: string;
  /** Throttled (about every 5 minutes); null for a session never seen since it was opened. */
  lastSeenAt: string | null;
  expiresAt: string;
  /** Truncated User-Agent header of the request that opened the session. */
  userAgent: string | null;
  /** Client address (the real one only with TRUST_PROXY set). */
  ip: string | null;
  /** True for the session of the request itself ("this device"). Always false in the admin's view of another user. */
  current: boolean;
}

/** One row of the instance audit log (/admin/audit). */
export interface AuditLogEvent {
  id: string;
  at: string;
  actorId: string | null;
  /** Current name of the actor; null for a guest / system action or a user deleted since. */
  actorName: string | null;
  actorEmail: string | null;
  action: string;
  target: string | null;
  /** Readable name of the target (user name and email, group, provider, token, page title, space name); null when it cannot be resolved (the screen shows `target`). */
  targetName: string | null;
  meta: Record<string, unknown> | null;
}

/** GET /api/admin/audit — newest first; `nextCursor` is passed back as `cursor` for the next page (null on the last one). */
export interface AuditLogPage {
  events: AuditLogEvent[];
  nextCursor: string | null;
}

/** Filters of GET /api/admin/audit and GET /api/admin/audit/export.csv (query string). */
export const auditLogQuerySchema = z.object({
  /** Exact actor user id. */
  actor: z.string().uuid().optional(),
  /** Action prefix, e.g. `access.` or `user.disable`; matches actions that start with it. */
  action: z.string().trim().min(1).max(80).optional(),
  /** Exact target (a space slug, page id, user id, token id, ...). */
  target: z.string().trim().min(1).max(200).optional(),
  /** Inclusive day range, yyyy-mm-dd (UTC). */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  cursor: z.string().regex(/^\d{1,18}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

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
  /**
   * Present only when the request carried a valid session whose user can open this very page by their own
   * rights: the in-app location (`/s/<space>/p/<pageId>`) the client switches to. Never set for a guest or
   * for a signed-in user without access of their own.
   */
  ownAccess?: { space: string; pageId: string };
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
  /** Groups (053) the invited person joins: an instance admin may pick any active group, a group manager only their own groups. */
  groupIds: z.array(z.string().uuid()).max(50).optional(),
});

export interface InviteInfo {
  id: string;
  url: string; // <PUBLIC_URL>/invite/<token>
  memberships: { space: string; role: SpaceRole }[];
  /** Groups (053) the invited person joins; a group deleted since is left out. */
  groups: { id: string; name: string }[];
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
  /**
   * The invite is pinned to an email whose domain a single sign-on provider serves: accept through that provider
   * (/api/auth/oidc/<slug>/start?invite=<token>). `enforced`: the domain must use single sign-on, so a password
   * account cannot be created from this invite at all.
   */
  sso?: SsoProviderPublic & { enforced: boolean };
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
  /** 'pat' — a pasted access token; 'oauth' — obtained via "Connect with GitHub" (GET /api/auth/github-connect/start). */
  source: 'pat' | 'oauth';
  /** The provider account an OAuth token belongs to (e.g. a GitHub login, without "@"); absent for a pasted token. */
  accountLogin?: string;
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
export type TrashKind = 'doc' | 'board' | 'table' | 'pdf' | 'office' | 'form' | 'canvas' | 'base' | 'artifact' | 'folder' | 'space';

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

/**
 * Where the key a run will use comes from. Resolution order (server/assistant/routes.ts
 * `resolveApiKey(userId, space)`): `personal` (skipped when the instance policy
 * `personalKeysAllowed` is false) → `space` (the current space's shared key) →
 * `instance` (instance-wide shared key) → `environment` (CURSOR_API_KEY) → `none`.
 * Shared keys (space / instance) — see "Shared assistant keys" below.
 */
export type AssistantKeySource = 'personal' | 'space' | 'instance' | 'environment' | 'none';
export type AssistantRunMode = 'ask' | 'agent';

/**
 * GET /api/assistant/settings?space=<slug> — `space` is optional: the slug of the space
 * the chat is opened in, so `apiKeySource` can report that space's shared key.
 * Without it the space level is skipped.
 */
export interface AssistantSettings {
  provider: 'CURSOR';
  /** 'auto' or the id of a Cursor model. */
  model: string;
  apiKeyConfigured: boolean;
  apiKeySource: AssistantKeySource;
  /** The name of the key that Cursor returned during the check (personal, space or instance key; null for environment/none). */
  apiKeyName: string | null;
  /**
   * Instance policy: may members use their own personal key? `false` = the
   * admin's shared key is used for everyone, the personal-key UI is hidden and
   * a stored personal key is ignored. Default true.
   */
  personalKeysAllowed: boolean;
  /** FOLIO_SECRET is configured — the key can be saved encrypted. */
  encryptionAvailable: boolean;
  /** Node >= 22.13 — the Cursor SDK can be loaded. */
  runtimeAvailable: boolean;
}

/** PUT /api/assistant/settings/key — checks the key with Cursor and saves it encrypted. */
export const saveAssistantKeyBodySchema = z.object({ apiKey: z.string().trim().min(1).max(5000) });
export type SaveAssistantKeyBody = z.infer<typeof saveAssistantKeyBodySchema>;

// ---------- Shared assistant keys (space / instance), 13.10.2026 — the orchestrator's contract ----------
// One Cursor key for everyone: an instance admin stores an instance-wide key
// (/api/admin/assistant/key), a space admin stores a key for one space
// (/api/spaces/:space/assistant-key). Stored encrypted like the personal key
// (FOLIO_SECRET), never sent to the browser — only the Cursor key name and who
// set it when. All routes cookie-only; PUT routes refuse in the public demo.
// Instance key: requireInstanceAdmin. Space key: canAdministerSpace (space admin
// or instance admin) — it is operational data in PostgreSQL, not git content.

export type SharedAssistantKeyScope = 'instance' | 'space';

/** GET /api/admin/assistant/key (instance) and GET /api/spaces/:space/assistant-key (space). */
export interface SharedAssistantKeyInfo {
  scope: SharedAssistantKeyScope;
  /** Space slug for `space`, null for `instance`. */
  space: string | null;
  configured: boolean;
  /** The key name Cursor returned during the check; null when not configured. */
  apiKeyName: string | null;
  /** Cursor account email returned by the check; may be null. */
  email: string | null;
  updatedAt: string | null;
  updatedBy: { id: string; name: string } | null;
  /** Instance scope only (null for space): may members still use their own personal key? Default true. */
  personalKeysAllowed: boolean | null;
  /** FOLIO_SECRET is configured — the key can be saved encrypted. */
  encryptionAvailable: boolean;
  /** Node >= 22.13 — the Cursor SDK can be loaded. */
  runtimeAvailable: boolean;
}

/** PUT /api/admin/assistant/key and PUT /api/spaces/:space/assistant-key — checks the key with Cursor and saves it encrypted; DELETE removes it (204). */
export const saveSharedAssistantKeyBodySchema = saveAssistantKeyBodySchema;
/** PUT /api/admin/assistant/key-policy (instance admin). */
export const updateAssistantKeyPolicyBodySchema = z.object({ personalKeysAllowed: z.boolean() });
export type UpdateAssistantKeyPolicyBody = z.infer<typeof updateAssistantKeyPolicyBodySchema>;

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
  /**
   * What the chat shows (and stores, and titles the conversation with) as this user message when `message` is an
   * internal instruction prompt built by the app ("Check against writing rules"). The model still gets `message`.
   */
  displayMessage: z.string().trim().min(1).max(500).optional(),
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
  | { type: 'status'; status: 'starting' | 'thinking' | 'tool' | 'writing'; label?: string; tokens?: number; generating?: boolean }
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
/**
 * `tokens` / `generating` are set while the model is producing output that is not reply text yet:
 * `tokens` = approximate tokens so far; `generating` (with status 'tool', `label` = the tool when known) =
 * the arguments of that tool call are being written (a page for create_page), as opposed to the tool running.
 * Only counters — never the thinking text or the arguments themselves.
 */
export type AssistantRunStep = { status: 'starting' | 'thinking' | 'tool' | 'writing'; label?: string; tokens?: number; generating?: boolean };

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
 *
 * `page-properties` (16.10.2026, server/propertiesSignal.ts) is "the properties
 * (front matter / sidecar) of this page changed — read them again": `pageId`
 * and the new `etag` (the GET's `etag`; a tab that already holds it — the
 * writer's own — skips the refetch). Sent only to the sessions that may read
 * THAT page. Without `pageId` it is "many pages of this space changed" (a git
 * sync, a tag rename across the space, a reconnect of the server's listener):
 * the space's readers re-read whatever properties they have open there.
 */
export type NotificationSocketEvent =
  | { type: 'notification'; item: NotificationItem }
  | { type: 'refresh' }
  | { type: 'tree'; space: string; v: number }
  | { type: 'page-properties'; space: string; pageId?: string; etag?: string | null }
  | { type: 'timer'; key: string; timer: PageTimerState | null; rev: number; serverNow: number }
  | { type: 'ping' };

// ---------- the shared page timer (16.10.2026) ----------
// A countdown that belongs to a PAGE (or to a folder listing of a space): everybody who has
// that page open sees the same one. Server-authoritative, in memory, never in
// the page file / git / Yjs / audit (server/pageTimer.ts explains the whole
// mechanism). The wire speaks in SERVER epoch milliseconds so that every
// client can correct for its own clock (`serverNow` rides on each response and
// frame) and all of them reach 00:00 together.

/** The longest a timer may run or be topped up to — 3 hours. */
export const PAGE_TIMER_MAX_MS = 180 * 60_000;
/** The shortest custom timer. */
export const PAGE_TIMER_MIN_MS = 1000;
/** How long a timer that has run out stays visible before it clears itself (server prunes it, clients stop showing it). */
export const PAGE_TIMER_FINISHED_LINGER_MS = 5 * 60_000;

/** `key` of a timer: the page id, or `space:<slug>` for the timer of a folder listing of a space. */
export const SPACE_TIMER_KEY_PREFIX = 'space:';

export interface PageTimerState {
  /** The length the timer was started with (grows with «+1 min») — for a progress display. */
  durationMs: number;
  /** Server epoch ms the countdown reaches zero; null while paused. */
  endsAt: number | null;
  /** The time left, frozen, while paused; null while running. */
  pausedRemainingMs: number | null;
  /** Display name of the person who started it (never an id or an e-mail). */
  startedByName: string;
  /** Server epoch ms of the last change. */
  updatedAt: number;
}

/**
 * GET/POST /api/pages/:id/timer and /api/spaces/:space/timer. `rev` is a
 * per-process counter that only grows: a response or frame older than what a
 * client already holds is dropped (two quick clicks can fan out out of order).
 */
export interface PageTimerResponse {
  timer: PageTimerState | null;
  rev: number;
  serverNow: number;
  /** The caller may start/pause/reset (editor+ on the page, and not a read-only token). */
  canControl: boolean;
}

export const pageTimerActionBodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), durationMs: z.number().int().min(PAGE_TIMER_MIN_MS).max(PAGE_TIMER_MAX_MS) }),
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('add'), ms: z.number().int().min(PAGE_TIMER_MIN_MS).max(PAGE_TIMER_MAX_MS) }),
  z.object({ action: z.literal('reset') }),
]);
export type PageTimerActionBody = z.infer<typeof pageTimerActionBodySchema>;

/**
 * `.agent/**` — the per-space folder of admin-only pages that tell the AI
 * assistant how to behave in that space (owner spec, 21.09.2026). Shared so
 * server/agentPath.ts's isAgentPath and the web sidebar/assistant panel
 * agree on the one literal — see SpaceInfo.agentRules above and
 * server/agentPath.ts for the actual access-control rule.
 */
export const AGENT_FOLDER = '.agent';

/**
 * The team's writing rules: ONE ordinary page inside the space's `.agent` folder (so the assistant already
 * receives it in every run, see server/assistant/agentContext.ts). "Check against writing rules" (page
 * header + MCP `check_page_writing_rules`) judges a page against exactly this file. Fixed name, no
 * configuration: a space either has `.agent/writing-rules.md` or it does not.
 * `SpaceInfo.agentRules.writingRules` is true when the page exists (sent to every member, like `used`).
 */
export const WRITING_RULES_STEM = 'writing-rules';
export const WRITING_RULES_PATH = `${AGENT_FOLDER}/${WRITING_RULES_STEM}.md`;
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
 * What a form field needs beyond `FormField` to render as the right control,
 * taken live from the bound column of the paired table (so the choices a
 * form shows never go stale against the table). Sent per field, keyed by
 * columnId, in `PageDoc.formChoices` — and only the fields OF THE FORM, so a
 * form's reader learns nothing about the table's other columns.
 */
export interface FormFieldChoices {
  /** select | status: the allowed values, with their colours. */
  options?: NonNullable<TableColumn['options']>;
  /** select | user: the answer is a list. */
  multiple?: boolean;
  /**
   * user: the members the respondent can pick — present ONLY for a signed-in
   * member (the same list as GET /api/spaces/:space/mentionable). Never sent
   * to a share-link guest or the public site.
   */
  users?: MentionableUser[];
  /** The field cannot be answered by this reader (a `user` field for an anonymous respondent): the form leaves it out. */
  hidden?: boolean;
}

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

// ---------- Artifacts (Claude artifacts, Cursor canvas, any HTML page), 21.10.2026 ----------
// Spec: docs/spec-artifacts.md. A page of kind 'artifact' is a `<slug>.artifact/` directory:
// `artifact.yaml` (optional manifest, ArtifactManifest) + an HTML entry (default index.html) +
// any files it references by relative path. Folio never edits the bundle in place — it is
// replaced whole (re-import, PUT below, MCP publish_artifact with an id).
//
//   POST /api/spaces/:space/artifacts      → ArtifactPublishResult (editor+; JSON ArtifactPublishBody,
//                                             or multipart: `file` (.html/.htm/.zip/.svg/.md) + the
//                                             scalar fields of ArtifactPublishBody as form fields)
//   PUT  /api/pages/:id/artifact           → ArtifactPublishResult (editor+; same bodies, parentPath ignored)
//   GET  /api/pages/:id/artifact/download  → application/zip of the bundle (viewer+)
//   GET  /api/pages/:id/artifact/state     → ArtifactState (viewer+, signed-in only)
//   PUT  /api/pages/:id/artifact/state     → ArtifactState (viewer+, signed-in only; body ArtifactStatePut)
//   GET  /art/:token/*                     → a file of the bundle, sandbox CSP (token = ArtifactPayload.src)
//   GET  /art/:token/__folio/bridge.js     → the host bridge script (injected into the entry's <head>)
// MCP: publish_artifact (write; ArtifactPublishBody + `space`), read_page returns the manifest + entry text.
// Errors: 422 { code: ArtifactErrorCode, message } for anything the import refuses.

export const ARTIFACT_DIR_SUFFIX = '.artifact';
export const ARTIFACT_MANIFEST_FILE = 'artifact.yaml';
export const ARTIFACT_DEFAULT_ENTRY = 'index.html';
/** Scripts/styles/fonts an artifact may load (CSP of /art) — the same CDNs Claude artifacts use, plus esm.sh. */
export const ARTIFACT_CDN_ALLOWLIST = [
  'https://cdnjs.cloudflare.com',
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://cdn.tailwindcss.com',
  'https://code.jquery.com',
  'https://esm.sh',
] as const;
/** iframe sandbox tokens — never 'allow-same-origin' (the frame must stay an opaque origin). */
export const ARTIFACT_IFRAME_SANDBOX =
  'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads';
export const ARTIFACT_LIMITS = {
  maxBundleBytes: 50 * 1024 * 1024,
  maxFiles: 500,
  maxUrlDownloadBytes: 20 * 1024 * 1024,
  maxStateKeyChars: 200,
  maxStateValueBytes: 256 * 1024,
  maxStateTotalBytes: 5 * 1024 * 1024,
  tokenTtlSeconds: 12 * 60 * 60,
} as const;

export const artifactTypeSchema = z.enum(['html', 'react', 'svg', 'markdown', 'mermaid', 'canvas-tsx', 'embed']);
export type ArtifactType = z.infer<typeof artifactTypeSchema>;
export const artifactOriginSchema = z.enum(['claude', 'cursor', 'url', 'upload', 'other']);
export type ArtifactOrigin = z.infer<typeof artifactOriginSchema>;
/** What an artifact expects from its host. Folio provides only 'storage'; the rest → "works partially" banner. */
export const artifactCapabilitySchema = z.enum(['storage', 'claude', 'network', 'connectors']);
export type ArtifactCapability = z.infer<typeof artifactCapabilitySchema>;

/** Top-level keys of artifact.yaml that are NOT page properties. */
export const ARTIFACT_RESERVED_KEYS = [
  'folio', 'version', 'title', 'icon', 'type', 'entry', 'source', 'embed', 'capabilities',
] as const;

/** artifact.yaml after parsing (unknown non-reserved keys = page properties, kept verbatim). */
export interface ArtifactManifest {
  folio: 'artifact';
  version: 1;
  title?: string;
  icon?: string;
  type: ArtifactType;
  /** Path inside the bundle; absent for type 'embed'. Default ARTIFACT_DEFAULT_ENTRY. */
  entry?: string;
  source?: {
    origin?: ArtifactOrigin;
    url?: string;
    /** ISO timestamp. */
    importedAt?: string;
    /** The original source kept verbatim inside the bundle (e.g. source.jsx, dashboard.canvas.tsx). */
    file?: string;
  };
  embed?: { url: string; height?: number };
  capabilities?: ArtifactCapability[];
}

/** PageDoc.artifact — what the web needs to show the page, minted per reader. */
export interface ArtifactPayload {
  type: ArtifactType;
  /** Entry path inside the bundle ('' for embed). */
  entry: string;
  /** Signed URL of the entry for the sandboxed iframe (absolute when ARTIFACTS_ORIGIN is set). Absent for embed or when the entry is missing. */
  src?: string;
  /** Third-party iframe URL for type 'embed'. */
  embedUrl?: string;
  embedHeight?: number;
  source?: ArtifactManifest['source'];
  capabilities: ArtifactCapability[];
  /** Signed URL of source.file for "Show source" (same token), when present. */
  sourceSrc?: string;
  /** Files of the bundle (manifest excluded), sorted by path. */
  files: Array<{ path: string; size: number }>;
  /** Problems found while reading the bundle (no entry, bad manifest…), English, shown in a note. */
  warnings: string[];
  /** Whether this reader can persist state server-side (signed in with view access). Otherwise personal state lives in the parent's localStorage and shared state is read-only. */
  stateServer: boolean;
}

export const artifactFileInputSchema = z.object({
  /** Relative path inside the bundle; no `..`, no leading `/`, not artifact.yaml, not under __folio/. */
  path: z.string().min(1).max(512),
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
});
export type ArtifactFileInput = z.infer<typeof artifactFileInputSchema>;

export const artifactPublishBodySchema = z.object({
  /** Folder from the space root for a NEW artifact ('' = root). Ignored on replace. */
  parentPath: z.string().default(''),
  /** Required for a new artifact unless it can be derived (html <title>, file name, URL). */
  title: z.string().trim().min(1).max(200).optional(),
  icon: z.string().max(16).optional(),
  type: artifactTypeSchema.optional(),
  /** The entry page as one HTML string (shortcut for files:[{path:'index.html', content: html}]). */
  html: z.string().optional(),
  /** Raw svg / markdown / mermaid text for those types — the server wraps it into index.html. */
  text: z.string().optional(),
  files: z.array(artifactFileInputSchema).max(500).optional(),
  entry: z.string().max(512).optional(),
  /** Original JSX/TSX (or any source) kept verbatim as `sourceFileName` (default source.jsx / source.canvas.tsx by type). */
  sourceCode: z.string().optional(),
  sourceFileName: z.string().max(200).optional(),
  /** Import by link: a direct https URL (downloaded, SSRF-guarded) or a Claude embed URL / embed code (→ type 'embed'). */
  url: z.string().max(4096).optional(),
  /** Pasted `<iframe …>` embed code (Claude "Get embed code"). */
  embedCode: z.string().max(8192).optional(),
  origin: artifactOriginSchema.optional(),
  /** Link to the original (e.g. the claude.ai share URL) — stored in source.url, never fetched. */
  sourceUrl: z.string().max(4096).optional(),
  capabilities: z.array(artifactCapabilitySchema).optional(),
  /** Page properties written into artifact.yaml (non-reserved keys only). */
  properties: z.record(z.string(), z.unknown()).optional(),
});
export type ArtifactPublishBody = z.infer<typeof artifactPublishBodySchema>;

export interface ArtifactPublishResult {
  page: PageMeta;
  /** Non-fatal notes (e.g. "capabilities claude not available in Folio"). */
  warnings: string[];
}

export type ArtifactErrorCode =
  | 'useMcp'          // a claude.ai / Cursor share link: Folio does not scrape it — publish via MCP or paste embed code
  | 'badUrl'          // not http(s), private address, too many redirects, timeout, HTTP error
  | 'tooLarge'
  | 'tooManyFiles'
  | 'badZip'          // unreadable, unsafe path, no index.html / artifact.yaml
  | 'badPath'
  | 'noEntry'         // nothing to render
  | 'unsupportedType';

export interface ArtifactState {
  personal: Record<string, string>;
  shared: Record<string, string>;
}
export const artifactStatePutSchema = z.object({
  shared: z.boolean().default(false),
  key: z.string().min(1).max(200),
  /** null deletes the key. */
  value: z.string().nullable(),
});
export type ArtifactStatePut = z.infer<typeof artifactStatePutSchema>;

/**
 * postMessage protocol between the bridge inside the iframe and the Folio page.
 * Every request carries a numeric `id`; the parent answers with the same id.
 * The parent accepts messages only from its own iframe's contentWindow.
 */
export type ArtifactBridgeRequest =
  | { folio: 'artifact'; id: number; op: 'init' }
  | { folio: 'artifact'; id: number; op: 'get'; key: string; shared: boolean }
  | { folio: 'artifact'; id: number; op: 'set'; key: string; value: string; shared: boolean }
  | { folio: 'artifact'; id: number; op: 'delete'; key: string; shared: boolean }
  | { folio: 'artifact'; id: number; op: 'list'; prefix: string; shared: boolean };
export type ArtifactBridgeResponse =
  | { folio: 'artifact'; id: number; ok: true; state?: ArtifactState; value?: string | null; keys?: string[] }
  | { folio: 'artifact'; id: number; ok: false; error: string };

// ---------- single sign-on (OpenID Connect, SAML 2.0), docs/AUTH.md ----------

export type SsoProviderKind = 'oidc' | 'saml';

/** A provider as the login screen sees it: no configuration, just the button. */
export interface SsoProviderPublic {
  slug: string;
  name: string;
  /** Which start URL the button leads to: /api/auth/oidc/<slug>/start or /api/auth/saml/<slug>/start. Absent (older servers) = 'oidc'. */
  kind?: SsoProviderKind;
}

/** POST /api/auth/sso/discover {email} — which provider the login screen should route this email to, if any. */
export interface SsoDiscoverResult {
  provider: SsoProviderPublic | null;
  /** The email's domain must sign in through `provider`: the password form is hidden (break-glass: /login?local). */
  enforced: boolean;
}
export const ssoDiscoverBodySchema = z.object({ email: z.string().min(1).max(320) });

export const ssoClaimMappingSchema = z.object({
  email: z.string().trim().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  groups: z.string().trim().min(1).max(200).optional(),
});
export type SsoClaimMapping = z.infer<typeof ssoClaimMappingSchema>;

/**
 * Group sync (migration 057, server/auth/groupSync.ts): at each sign-in the groups the provider asserts (the claim
 * named by `claimMapping.groups`) become Folio group memberships. `mode` 'name' matches an IdP value to a Folio
 * group by slug or name; 'mapping' only looks at `mapping` (IdP value -> Folio group slug). `allow` filters the IdP
 * values first: empty = all, `a, b` = values starting with `a` or `b`, `/regex/` = a regular expression.
 */
export const ssoGroupSyncSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(['name', 'mapping']).default('name'),
  mapping: z.record(z.string().trim().min(1).max(300), z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase letters, digits and dashes')).default({}),
  createMissing: z.boolean().default(false),
  allow: z
    .string()
    .trim()
    .max(300)
    .default('')
    .refine((v) => {
      const m = /^\/(.+)\/$/.exec(v);
      if (!m) return true;
      try {
        new RegExp(m[1]);
        return true;
      } catch {
        return false;
      }
    }, 'not a valid regular expression'),
});
export type SsoGroupSync = z.infer<typeof ssoGroupSyncSchema>;

/** How a SAML provider asks for and reads the person's NameID. */
export const samlNameIdFormatSchema = z.enum(['email', 'persistent', 'unspecified']);
export type SamlNameIdFormat = z.infer<typeof samlNameIdFormatSchema>;

const optionalUrl = z.union([z.url().max(1000), z.literal('')]).optional();

/**
 * A SAML provider's settings (server/auth/saml.ts). The IdP is described by its metadata (a URL, re-read hourly, or
 * the pasted XML) and/or the explicit fields, which win over the metadata. Nothing here is secret.
 * In a PATCH, a field set to '' is cleared; an omitted one is kept.
 */
export const samlConfigSchema = z.object({
  metadataUrl: optionalUrl,
  metadataXml: z.string().max(500_000).optional(),
  /** The IdP's entity ID: the Issuer every assertion must carry, and half of the identity key. */
  idpEntityId: z.string().trim().max(500).optional(),
  /** The IdP's single sign-on URL (HTTP-Redirect binding). */
  ssoUrl: optionalUrl,
  /** The IdP's signing certificate(s), PEM (several blocks for a rollover) or bare base64. */
  idpCert: z.string().max(100_000).optional(),
  /** Folio's (the SP's) entity ID; '' = the default, <PUBLIC_URL>/api/auth/saml/<slug>/metadata. */
  spEntityId: z.string().trim().max(500).optional(),
  nameIdFormat: samlNameIdFormatSchema.optional(),
  /** The IdP is authoritative for the emails of the allowed domains: such an email counts as verified (SAML carries no email_verified), so an existing account with it can be linked. */
  emailAuthoritative: z.boolean().optional(),
  /** Accept IdP-initiated (unsolicited) responses — no InResponseTo to check, so off by default. */
  allowIdpInitiated: z.boolean().optional(),
});
export type SamlConfigInput = z.infer<typeof samlConfigSchema>;

/** A SAML provider's stored settings, as the admin screen shows them. */
export interface SamlProviderConfig {
  metadataUrl: string;
  metadataXml: string;
  idpEntityId: string;
  ssoUrl: string;
  idpCert: string;
  spEntityId: string;
  nameIdFormat: SamlNameIdFormat;
  emailAuthoritative: boolean;
  allowIdpInitiated: boolean;
}

/** GET /api/admin/auth/providers — one configured provider. The client secret never leaves the server: only whether one is set. */
export interface AuthProviderInfo {
  id: string;
  slug: string;
  kind: SsoProviderKind;
  /** 'env': defined by environment variables — read-only here. */
  source: 'db' | 'env';
  displayName: string;
  issuer: string;
  clientId: string;
  hasClientSecret: boolean;
  scopes: string;
  claimMapping: SsoClaimMapping;
  groupSync: SsoGroupSync;
  allowedDomains: string[];
  jitEnabled: boolean;
  jitDefaultSpaces: Record<string, SpaceRole>;
  enforceSso: boolean;
  enabled: boolean;
  /** The redirect (callback) URL to register at the identity provider — for SAML, the ACS URL. */
  redirectUri: string;
  /** SAML only: the provider's settings and what to register at the IdP. */
  saml?: SamlProviderConfig;
  samlSp?: { entityId: string; acsUrl: string; metadataUrl: string };
  /** How many accounts are linked to this provider. */
  identities: number;
  /** SCIM provisioning is on (the provider has an active SCIM token): JIT account creation at sign-in is then off. */
  scimEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/admin/auth/providers/:id/scim — the provider's "SCIM provisioning" panel (server/scim/routes.ts). */
export interface ScimStatusInfo {
  /** An active SCIM token exists. */
  enabled: boolean;
  /** What to paste at the identity provider as the SCIM base URL / tenant URL: <public URL>/scim/v2. */
  baseUrl: string;
  /** The active token (never its value: that is shown once, at generation). */
  token: { prefix: string; createdAt: string; lastUsedAt: string | null } | null;
  /** The last authenticated SCIM request from this provider (any of its tokens). */
  lastSyncAt: string | null;
  /** Accounts the provider manages over SCIM (deleted ones excluded). */
  users: number;
  /** Active groups the provider created over SCIM. */
  groups: number;
  /** An environment-defined provider has JIT on: while SCIM is on, sign-in ignores it. */
  jitIgnored: boolean;
}

/** POST /api/admin/auth/providers/:id/scim/token — the raw token, shown once. */
export interface ScimTokenCreated {
  token: string;
  /** JIT account creation was on for this (admin-defined) provider and has been turned off. */
  jitDisabled: boolean;
  status: ScimStatusInfo;
}

const ssoDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'not a domain name');

/**
 * POST /api/admin/auth/providers. `clientSecret`: omitted = none (create) / keep (patch), '' = clear.
 * `kind` (default 'oidc') is fixed at creation. OIDC needs `issuer` and `clientId` (checked by the server);
 * SAML needs `saml` (metadata, or SSO URL + certificate + IdP entity ID) and ignores issuer/clientId/secret/scopes.
 */
export const authProviderBodySchema = z.object({
  kind: z.enum(['oidc', 'saml']).optional(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lower-case letters, digits and dashes'),
  displayName: z.string().trim().min(1).max(80),
  issuer: z.url().max(500).optional(),
  clientId: z.string().trim().min(1).max(500).optional(),
  clientSecret: z.string().max(2000).optional(),
  scopes: z.string().trim().min(1).max(500).optional(),
  claimMapping: ssoClaimMappingSchema.optional(),
  groupSync: ssoGroupSyncSchema.optional(),
  allowedDomains: z.array(ssoDomainSchema).max(100).optional(),
  jitEnabled: z.boolean().optional(),
  jitDefaultSpaces: z.record(z.string().min(1), spaceRoleSchema).optional(),
  enforceSso: z.boolean().optional(),
  enabled: z.boolean().optional(),
  saml: samlConfigSchema.optional(),
});
export type AuthProviderBody = z.infer<typeof authProviderBodySchema>;
/** PATCH /api/admin/auth/providers/:id — every field optional. */
export const authProviderPatchSchema = authProviderBodySchema.partial();
export type AuthProviderPatch = z.infer<typeof authProviderPatchSchema>;

/** What "Test connection" got back from the provider — shown to the admin; nothing is created or linked. */
export interface SsoTestResult {
  ok: boolean;
  /** OIDC: the validated ID token claims (merged with userinfo, when the provider has that endpoint). SAML: the assertion's attributes plus nameID / nameIDFormat / issuer. */
  claims?: Record<string, unknown>;
  /** The values Folio would use, after the claim mapping. */
  mapped?: { subject: string; email: string | null; emailVerified: boolean; name: string | null; groups: unknown };
  error?: string;
}
