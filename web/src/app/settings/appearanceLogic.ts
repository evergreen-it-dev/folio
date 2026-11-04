/**
 * Pure logic of the "Site & PDF" settings page (`/s/:space/settings`): which files each tab owns,
 * the per-file draft/etag bookkeeping, the `site.json` editing helpers, asset-name rules and the
 * addresses the Site tab shows. No React in here, so it is cheap to test.
 */
import {
  APPEARANCE_DIR,
  SITE_ASSET_MAX_BYTES,
  SITE_ASSET_NAME_RE,
  siteSettingsSchema,
  type AppearanceFile,
  type AppearanceFileState,
  type PublicPrimaryHost,
  type PutAppearanceBody,
  type SpacePublicSettingsResponse,
} from '@shared/contracts';

// ---------- tabs ----------

export const TAB_KEYS = ['site', 'appearance', 'pdf'] as const;
export type SettingsTab = (typeof TAB_KEYS)[number];

/** The files a tab saves: one Save per tab sends only these, and only the changed ones. */
export const TAB_FILES: Record<SettingsTab, readonly AppearanceFile[]> = {
  site: ['site.json'],
  appearance: ['site.css'],
  pdf: ['pdf-header.html', 'pdf-footer.html', 'export.css'],
};

export function parseTab(raw: string | null): SettingsTab {
  return (TAB_KEYS as readonly string[]).includes(raw ?? '') ? (raw as SettingsTab) : 'site';
}

/** The placeholders server/export/css.ts substitutes in the PDF header and footer. */
export const PDF_PLACEHOLDERS = ['{{page}}', '{{pages}}', '{{title}}', '{{space}}', '{{date}}'] as const;

/** The stable hooks the public site exposes to `site.css`. */
export const SITE_CSS_HOOKS = [
  '.folio-site',
  '[data-folio-site-part="header"]',
  '[data-folio-site-part="sidebar"]',
  '[data-folio-site-part="main"]',
  '[data-folio-site-part="footer"]',
  '[data-folio-site-part="page"]',
] as const;

// ---------- drafts and etags ----------

/** What the server last told us about a file (`etag` is what a save must quote back). */
export interface FileBase {
  content: string;
  etag: string | null;
}
/** `draft` is null while the editor shows the stored text. */
export interface FileEntry {
  base: FileBase;
  draft: string | null;
}
export type FilesState = Partial<Record<AppearanceFile, FileEntry>>;

export function isDraftDirty(entry: FileEntry | undefined): boolean {
  return entry?.draft != null && entry.draft !== entry.base.content;
}

/** A server snapshot as the base of an entry that has no draft. */
function freshEntry(file: AppearanceFileState): FileEntry {
  return { base: { content: file.content, etag: file.etag }, draft: null };
}

/**
 * A (re)load from the server. A file with unsaved edits keeps its old base: the etag must stay the one
 * the editor was started from, or a save would silently overwrite what changed in between.
 */
export function mergeServerFiles(state: FilesState, files: readonly AppearanceFileState[]): FilesState {
  const next: FilesState = { ...state };
  for (const file of files) {
    const current = state[file.file];
    if (isDraftDirty(current)) continue;
    next[file.file] = freshEntry(file);
  }
  return next;
}

/** An edit; going back to the stored text is "no draft". */
export function setDraft(state: FilesState, file: AppearanceFile, content: string, fallback: FileBase): FilesState {
  const base = state[file]?.base ?? fallback;
  return { ...state, [file]: { base, draft: content === base.content ? null : content } };
}

/** After a successful save: the saved files take the server's state, unless the editor moved on while the request was in flight. */
export function applySaved(
  state: FilesState,
  sent: PutAppearanceBody['changes'],
  files: readonly AppearanceFileState[],
): FilesState {
  const next: FilesState = { ...state };
  for (const change of sent) {
    const current = next[change.file];
    if (current && current.draft != null && current.draft !== change.content) continue; // typed more since — keep that draft
    next[change.file] = { base: current?.base ?? { content: '', etag: null }, draft: null };
  }
  return mergeServerFiles(next, files);
}

/** After a conflict: take the repository's version of every file; `keep` lists the files whose draft survives on top of it. */
export function adoptServerFiles(state: FilesState, files: readonly AppearanceFileState[], keep: readonly AppearanceFile[]): FilesState {
  const next: FilesState = { ...state };
  for (const file of files) {
    const current = state[file.file];
    next[file.file] = { base: { content: file.content, etag: file.etag }, draft: keep.includes(file.file) && current ? current.draft : null };
  }
  return next;
}

/** The changed files of a tab, each with the etag the editor started from (null = the file did not exist then). */
export function changesFor(state: FilesState, files: readonly AppearanceFile[]): PutAppearanceBody['changes'] {
  const out: PutAppearanceBody['changes'] = [];
  for (const file of files) {
    const entry = state[file];
    if (!entry || !isDraftDirty(entry)) continue;
    out.push({ file, content: entry.draft ?? '', etag: entry.base.etag });
  }
  return out;
}

/** The current files out of a 409 body (`{ error, files, … }`, or the same under `current`); empty when the body has none. */
export function filesFromConflictBody(body: unknown): AppearanceFileState[] {
  if (!body || typeof body !== 'object') return [];
  const record = body as { files?: unknown; current?: { files?: unknown } };
  const list = Array.isArray(record.files) ? record.files : Array.isArray(record.current?.files) ? record.current.files : [];
  return list.filter((f): f is AppearanceFileState => Boolean(f) && typeof f === 'object' && typeof (f as AppearanceFileState).file === 'string');
}

// ---------- repository links ----------

/** `<hosting UI blob URL>/<repo-relative path>`; null when the host is unknown. */
export function repoFileUrl(baseUrl: string | null, path: string): string | null {
  if (!baseUrl) return null;
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${baseUrl.replace(/\/+$/, '')}/${encoded}`;
}

/** Repo-relative path of a file when the server has not described it. */
export function fallbackPath(contentRoot: string, file: AppearanceFile): string {
  return [contentRoot.replace(/^\/+|\/+$/g, ''), APPEARANCE_DIR, file].filter(Boolean).join('/');
}

// ---------- site.json ----------

type SiteJson = Record<string, unknown>;
export type ParsedSiteJson = { ok: true; value: SiteJson } | { ok: false };

export function parseSiteJson(content: string): ParsedSiteJson {
  if (!content.trim()) return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(content);
    if (value && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value: value as SiteJson };
  } catch {
    // fall through
  }
  return { ok: false };
}

/** `{v:1, …}` pretty-printed; no settings at all means no file (an empty string deletes it). */
export function serializeSiteJson(value: SiteJson): string {
  const { v: _version, ...rest } = value;
  if (Object.keys(rest).length === 0) return '';
  return `${JSON.stringify({ v: 1, ...rest }, null, 2)}\n`;
}

/** Sets or (for an empty value) removes one key, keeping every other key — the file is hand-edited too. */
export function withSiteField(content: string, key: string, value: string): string {
  const parsed = parseSiteJson(content);
  if (!parsed.ok) return content;
  const next = { ...parsed.value };
  if (value === '') delete next[key];
  else next[key] = value;
  return serializeSiteJson(next);
}

/** A boolean switch of site.json that is ON unless it says `false`: turning it on removes the key, turning it off writes `false`. */
export function withSiteSwitch(content: string, key: string, on: boolean): string {
  const parsed = parseSiteJson(content);
  if (!parsed.ok) return content;
  const next = { ...parsed.value };
  if (on) delete next[key];
  else next[key] = false;
  return serializeSiteJson(next);
}

export function siteSwitchOn(value: SiteJson, key: string): boolean {
  return value[key] !== false;
}

export function siteString(value: SiteJson, key: string): string {
  const raw = value[key];
  return typeof raw === 'string' ? raw : '';
}

/** Field-by-field validation with the contract's own schema. */
export function siteFieldErrors(value: SiteJson): Record<string, string> {
  const result = siteSettingsSchema.safeParse({ v: 1, ...value });
  if (result.success) return {};
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? '');
    if (key && !(key in errors)) errors[key] = issue.message;
  }
  return errors;
}

export const COMMON_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'en', label: 'English (en)' },
  { code: 'uk', label: 'Ukrainian (uk)' },
  { code: 'de', label: 'Deutsch (de)' },
  { code: 'fr', label: 'Français (fr)' },
  { code: 'es', label: 'Español (es)' },
  { code: 'it', label: 'Italiano (it)' },
  { code: 'pl', label: 'Polski (pl)' },
  { code: 'pt', label: 'Português (pt)' },
  { code: 'ja', label: '日本語 (ja)' },
  { code: 'zh', label: '中文 (zh)' },
];

export const DESCRIPTION_SOFT_LIMIT = 160;

// ---------- assets ----------

const ASSET_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

export type AssetCheck = { ok: true; name: string; type: string } | { ok: false; reason: 'name' | 'size' };

/** A file picked by the user → the asset name it would get (lowercase, spaces and odd characters become `-`) and the type to send. */
export function checkAssetFile(file: { name: string; size: number; type: string }): AssetCheck {
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : '';
  const stem = (dot >= 0 ? file.name.slice(0, dot) : file.name)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 63 - ext.length);
  const name = `${stem}.${ext}`;
  if (!stem || !SITE_ASSET_NAME_RE.test(name)) return { ok: false, reason: 'name' };
  if (file.size > SITE_ASSET_MAX_BYTES) return { ok: false, reason: 'size' };
  return { ok: true, name, type: file.type || ASSET_TYPES[ext] || 'application/octet-stream' };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------- addresses ----------

/** The canonical address by the contract's rule ('auto' = domain, else subdomain, else path); a missing explicit choice falls back to the path. */
export function canonicalBaseOf(response: SpacePublicSettingsResponse, primaryHost: PublicPrimaryHost = response.settings.primaryHost): string {
  const { path, subdomain, domain } = response.urls;
  if (primaryHost === 'domain') return domain ?? path;
  if (primaryHost === 'subdomain') return subdomain ?? path;
  if (primaryHost === 'path') return path;
  return domain ?? subdomain ?? path;
}

/** robots.txt is host-wide; the sitemap of a path-mode site lives under the site's own prefix, of a host-mode site at its root. */
export function robotsAndSitemapUrls(response: SpacePublicSettingsResponse): { robots: string; sitemap: string; llms: string } {
  const base = canonicalBaseOf(response);
  const trimmed = base.replace(/\/+$/, '');
  let origin = trimmed;
  try {
    origin = new URL(base).origin;
  } catch {
    // keep the raw base
  }
  return { robots: `${origin}/robots.txt`, sitemap: `${trimmed}/sitemap.xml`, llms: `${trimmed}/llms.txt` };
}

/** First `max` characters with an ellipsis, for the search-result preview. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
