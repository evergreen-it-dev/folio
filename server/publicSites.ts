/**
 * Public sites (13.10.2026): a space with `visibility = 'public'` is served to
 * anonymous visitors as a read-only site. This module is the ONE place that
 * knows the policy, so every anonymous door (the /api/public/** routes, the
 * file route, the collab socket, the HTML shell) agrees:
 *
 *  - WHICH spaces are public (`getPublicSpace`, `resolvePublicSiteByHost`);
 *  - WHICH pages of a public space a stranger may read: everything except
 *    pages with a `page_access` row (private / specific people), `.agent/**`
 *    and `_templates/` — `publicReadablePageIds` / `isPublicPage`. These sets
 *    never depend on a user: the anonymous reader has no identity;
 *  - the publish settings (subdomain, custom domain, download, assistant,
 *    indexing, primary host) and the URLs the site answers at, the canonical
 *    one included (canonicalSiteBase).
 *
 * Nothing here reads a session. See shared/contracts.ts ("Public sites") for
 * the routes and the three ways a site is reached.
 */
import {
  PUBLIC_SITE_PATH_PREFIX,
  type PublicPrimaryHost,
  type PublicSiteInfo,
  type SpacePublicSettings,
  type SpaceVisibility,
} from '../shared/contracts.js';
import { restrictionChainSql } from './access/roleSql.js';
import { isAgentPath } from './agentPath.js';
import { query, queryOne } from './db/pool.js';
import { isDemoMode } from './demo.js';
import { badRequest, conflict, notFound } from './errors.js';
import * as pageAccess from './pageAccess.js';
import { publicUrlOrOrigin } from './publicUrl.js';
import { readSiteCss, readSiteSettings, siteAssetUrl, statSiteAsset } from './spaceAppearance.js';
import * as storage from './storage.js';

export interface PublicSpace {
  slug: string;
  name: string;
  allowDownload: boolean;
  allowAssistant: boolean;
  subdomain: string | null;
  domain: string | null;
  /** Migration 040: may search engines index the site (default true). */
  indexing: boolean;
  /** Migration 040: which address is canonical. */
  primaryHost: PublicPrimaryHost;
}

interface PublicSpaceRow {
  slug: string;
  name: string;
  public_subdomain: string | null;
  public_domain: string | null;
  public_allow_download: boolean;
  public_allow_assistant: boolean;
  public_indexing: boolean;
  public_primary_host: string;
}

const PUBLIC_SPACE_COLUMNS =
  'slug, name, public_subdomain, public_domain, public_allow_download, public_allow_assistant, public_indexing, public_primary_host';

function validPrimaryHost(v: unknown): PublicPrimaryHost {
  return v === 'path' || v === 'subdomain' || v === 'domain' ? v : 'auto';
}

function toPublicSpace(row: PublicSpaceRow): PublicSpace {
  return {
    slug: row.slug,
    name: row.name,
    allowDownload: row.public_allow_download,
    allowAssistant: row.public_allow_assistant,
    subdomain: row.public_subdomain,
    domain: row.public_domain,
    indexing: row.public_indexing !== false,
    primaryHost: validPrimaryHost(row.public_primary_host),
  };
}

/**
 * Whether search engines may index the site: the stored `indexing` setting,
 * except in the public demo (FOLIO_DEMO_MODE), where every published space is
 * editable by any visitor under the shared login and therefore never indexed
 * (noindex on every page, `Disallow` in robots.txt, no sitemap).
 */
export function siteIndexable(record: Pick<PublicSpace, 'indexing'>): boolean {
  return record.indexing && !isDemoMode();
}

/** Every published space (robots.txt / sitemap index of the main host). */
export async function listPublicSpaces(): Promise<PublicSpace[]> {
  const rows = await query<PublicSpaceRow>(`SELECT ${PUBLIC_SPACE_COLUMNS} FROM spaces WHERE visibility = 'public' ORDER BY slug`);
  return rows.map(toPublicSpace);
}

/** The space when it exists AND is published; undefined otherwise (private, instance and unknown look the same). */
export async function getPublicSpace(slug: string): Promise<PublicSpace | undefined> {
  if (!slug || slug.includes('/') || slug.includes('\\')) return undefined;
  const row = await queryOne<PublicSpaceRow>(`SELECT ${PUBLIC_SPACE_COLUMNS} FROM spaces WHERE slug = $1 AND visibility = 'public'`, [slug]);
  return row ? toPublicSpace(row) : undefined;
}

// ---------------------------------------------------------------------------
// Which pages a stranger may read
// ---------------------------------------------------------------------------

/**
 * Ids of the pages of `slug` an anonymous visitor may read: every page except
 * restricted ones (a `page_access` row), `.agent/**` (both from
 * pageAccess.restrictedPageIds) and `_templates/`. Does NOT check that the
 * space is public — callers do (getPublicSpace). Like the signed-in tree, a
 * restriction is inherited: the children of a restricted page are not public
 * either (docs/spec-access.md §13).
 */
export async function publicReadablePageIds(slug: string): Promise<Set<string>> {
  const [rows, restricted] = await Promise.all([
    query<{ id: string; path: string }>('SELECT id, path FROM pages_index WHERE space_slug = $1', [slug]),
    pageAccess.restrictedPageIds(slug),
  ]);
  return new Set(rows.filter((row) => !restricted.has(row.id) && !storage.isUnderTemplates(row.path)).map((row) => row.id));
}

/**
 * Single-page form of `publicReadablePageIds` for the hot paths (the collab
 * socket, the page route, a site's home page): true only when the page's space
 * is published AND the page is neither restricted (by its own rule or an
 * ancestor's), `.agent/**` nor in
 * `_templates/`. One query, no space-wide scan.
 */
export async function isPublicPage(page: { id: string; space: string; relPath: string }): Promise<boolean> {
  if (isAgentPath(page.relPath) || storage.isUnderTemplates(page.relPath)) return false;
  const row = await queryOne<{ is_public: boolean; restricted: boolean }>(
    `SELECT (sp.visibility = 'public') AS is_public,
            EXISTS (SELECT 1 FROM (${restrictionChainSql('$1')}) r) AS restricted
       FROM spaces sp
      WHERE sp.slug = $2`,
    [page.id, page.space],
  );
  return Boolean(row?.is_public) && !row?.restricted;
}

/** The public page of `site` an unknown id used to mean (storage.findMovedPage: an id derived from its path), or undefined. */
export async function findPublicMovedPage(site: { slug: string }, id: string): Promise<storage.PageIndexEntry | undefined> {
  if (!id || id.startsWith('dir:')) return undefined;
  const moved = await storage.findMovedPage(site.slug, id);
  return moved && moved.space === site.slug && (await isPublicPage(moved)) ? moved : undefined;
}

// ---------------------------------------------------------------------------
// Hosts and URLs
// ---------------------------------------------------------------------------

/** Lowercase hostname without scheme, port, path or a trailing dot; '' for anything unusable. */
function normalizeHost(raw: string | undefined | null): string {
  if (!raw) return '';
  let host = raw.trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  host = host.split('/')[0];
  host = host.replace(/:\d+$/, '');
  return host.replace(/\.$/, '');
}

/** PUBLIC_SITES_DOMAIN of this instance (normalized), or null when subdomain publishing is not set up. */
export function sitesDomain(): string | null {
  return normalizeHost(process.env.PUBLIC_SITES_DOMAIN) || null;
}

/** Host of PUBLIC_URL (or of `originFallback` when PUBLIC_URL is unset); '' when neither parses. */
export function mainHost(originFallback = ''): string {
  try {
    return new URL(publicUrlOrOrigin(originFallback)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

interface HostCacheEntry {
  at: number;
  value: PublicSpace | undefined;
}
const HOST_CACHE_TTL_MS = 10_000;
const HOST_CACHE_MAX = 1000;
const hostCache = new Map<string, HostCacheEntry>();

/** Forget cached host -> space answers; called whenever visibility or the publish settings change. */
export function invalidatePublicSiteCache(): void {
  hostCache.clear();
}

/**
 * The published space served at the `Host` of a request, if any:
 *  - never the main host (PUBLIC_URL's), whatever the data says;
 *  - `<label>.<PUBLIC_SITES_DOMAIN>` (exactly one label) -> the space with that `public_subdomain`;
 *  - otherwise an exact `public_domain` match;
 * and only while the space is `visibility = 'public'`. Cached for 10 s.
 */
export async function resolvePublicSiteByHost(hostHeader: string | undefined | null): Promise<PublicSpace | undefined> {
  const host = normalizeHost(hostHeader);
  if (!host) return undefined;
  if (host === mainHost()) return undefined;

  const cached = hostCache.get(host);
  if (cached && Date.now() - cached.at < HOST_CACHE_TTL_MS) return cached.value;

  let value: PublicSpace | undefined;
  const domain = sitesDomain();
  if (domain && host.endsWith(`.${domain}`)) {
    const label = host.slice(0, -(domain.length + 1));
    if (label && !label.includes('.')) {
      const row = await queryOne<PublicSpaceRow>(
        `SELECT ${PUBLIC_SPACE_COLUMNS} FROM spaces WHERE public_subdomain = $1 AND visibility = 'public'`,
        [label],
      );
      value = row ? toPublicSpace(row) : undefined;
    }
  } else if (host !== domain) {
    const row = await queryOne<PublicSpaceRow>(
      `SELECT ${PUBLIC_SPACE_COLUMNS} FROM spaces WHERE public_domain = $1 AND visibility = 'public'`,
      [host],
    );
    value = row ? toPublicSpace(row) : undefined;
  }

  if (hostCache.size >= HOST_CACHE_MAX) hostCache.clear();
  hostCache.set(host, { at: Date.now(), value });
  return value;
}

/** Scheme (and port, when PUBLIC_URL carries one) of the instance URL — what a sibling host of the instance is reached with. */
function instanceScheme(originFallback: string): { scheme: string; port: string } {
  try {
    const url = new URL(publicUrlOrOrigin(originFallback));
    return { scheme: url.protocol.replace(/:$/, ''), port: url.port };
  } catch {
    return { scheme: 'https', port: '' };
  }
}

export interface PublicSiteUrls {
  path: string;
  subdomain: string | null;
  domain: string | null;
}

/** Where the site of `slug` answers: always the path form, plus the subdomain / custom domain when configured. */
export function publicSiteUrls(slug: string, settings: Pick<SpacePublicSettings, 'subdomain' | 'domain'>, originFallback: string): PublicSiteUrls {
  const { scheme, port } = instanceScheme(originFallback);
  const sites = sitesDomain();
  return {
    path: `${publicUrlOrOrigin(originFallback)}${PUBLIC_SITE_PATH_PREFIX}/${slug}`,
    subdomain: settings.subdomain && sites ? `${scheme}://${settings.subdomain}.${sites}${port ? `:${port}` : ''}` : null,
    domain: settings.domain ? `${scheme}://${settings.domain}` : null,
  };
}

/**
 * The canonical absolute URL of the site root, by `primaryHost` (migration 040):
 * 'auto' = the custom domain if set, else the subdomain if set (and the instance
 * has PUBLIC_SITES_DOMAIN), else the path form. A pinned host that is not
 * configured falls back to 'auto'. No trailing slash.
 */
export function canonicalSiteBase(record: Pick<PublicSpace, 'slug' | 'subdomain' | 'domain' | 'primaryHost'>, originFallback: string): string {
  const urls = publicSiteUrls(record.slug, record, originFallback);
  const auto = urls.domain ?? urls.subdomain ?? urls.path;
  if (record.primaryHost === 'path') return urls.path;
  if (record.primaryHost === 'domain') return urls.domain ?? auto;
  if (record.primaryHost === 'subdomain') return urls.subdomain ?? auto;
  return auto;
}

/** True when the canonical base is the `/public/<slug>` form on the main host. */
export function isPathCanonical(record: Pick<PublicSpace, 'slug' | 'subdomain' | 'domain' | 'primaryHost'>, originFallback: string): boolean {
  return canonicalSiteBase(record, originFallback) === publicSiteUrls(record.slug, record, originFallback).path;
}

/** Canonical URL of a page of the site (`pageId` null/undefined or the home page = the site root). */
export function canonicalPageUrl(base: string, pageId: string | null | undefined, homePageId: string | null): string {
  if (!pageId || pageId === homePageId) return /^[a-z]+:\/\/[^/]+$/i.test(base) ? `${base}/` : base;
  return `${base}/p/${encodeURIComponent(pageId)}`;
}

/** What the HTML shell needs to know about the site a request belongs to. */
export interface PublicSiteShell {
  slug: string;
  name: string;
  /** true when the request came in on the site's own host (subdomain / custom domain): the SPA mounts the site at '/'. false for the `/public/<slug>` path form. */
  hostMode: boolean;
}

const PATH_SITE_RE = new RegExp(`^${PUBLIC_SITE_PATH_PREFIX}/([a-z0-9][a-z0-9-]*)(?:/|$)`);

/**
 * The published site an index.html request belongs to — by `Host` (subdomain /
 * custom domain), else by a `/public/<slug>` path — or undefined. Never throws:
 * on any error the plain shell is served.
 */
export async function publicSiteForShell(hostname: string | undefined, pathname: string): Promise<PublicSiteShell | undefined> {
  try {
    const byHost = await resolvePublicSiteByHost(hostname);
    if (byHost) return { slug: byHost.slug, name: byHost.name, hostMode: true };
    const slug = PATH_SITE_RE.exec(pathname)?.[1];
    const byPath = slug ? await getPublicSpace(slug) : undefined;
    return byPath ? { slug: byPath.slug, name: byPath.name, hostMode: false } : undefined;
  } catch {
    return undefined;
  }
}

/** The space's root page (index.md, then README.md) when it is public; null otherwise. */
export async function publicHomePageId(slug: string): Promise<string | null> {
  try {
    // '' = the space root: index.md, then README.md.
    const home = await storage.resolve(slug, '');
    if (await isPublicPage({ id: home.id, space: slug, relPath: home.path })) return home.id;
  } catch {
    // no root page: the SPA shows the tree
  }
  return null;
}

/** The payload of GET /api/public/site and GET /api/public/spaces/:slug. */
export async function buildPublicSiteInfo(record: PublicSpace, mode: PublicSiteInfo['mode'], originFallback: string): Promise<PublicSiteInfo> {
  const homePageId = await publicHomePageId(record.slug);
  // Appearance lives in the repository (.folio/); a broken file never breaks the site.
  const site = await readSiteSettings(record.slug).catch(() => ({}) as Awaited<ReturnType<typeof readSiteSettings>>);
  const css = await readSiteCss(record.slug).catch(() => null);
  const assetUrl = async (name: string | undefined): Promise<string | null> => {
    if (!name) return null;
    const stat = await statSiteAsset(record.slug, name).catch(() => null);
    return stat ? siteAssetUrl(record.slug, name, stat.version) : null;
  };
  return {
    space: record.slug,
    name: record.name,
    allowDownload: record.allowDownload,
    allowAssistant: record.allowAssistant,
    mode,
    homePageId,
    instanceUrl: publicUrlOrOrigin(originFallback),
    title: site.title ?? null,
    tagline: site.tagline ?? null,
    lang: site.lang ?? null,
    logoUrl: await assetUrl(site.logo),
    faviconUrl: await assetUrl(site.favicon),
    cssUrl: css && css.css.trim() ? `/api/public/spaces/${encodeURIComponent(record.slug)}/site.css?v=${css.etag.slice(0, 12)}` : null,
    canonicalBase: canonicalSiteBase(record, originFallback),
    indexing: siteIndexable(record),
  };
}

// ---------------------------------------------------------------------------
// Publish settings
// ---------------------------------------------------------------------------

export interface SpacePublishState {
  visibility: SpaceVisibility;
  settings: SpacePublicSettings;
}

/** The publish settings of a space in ANY visibility (they are kept while a space is not public). Undefined for an unknown space. */
export async function getSpacePublicSettings(slug: string): Promise<SpacePublishState | undefined> {
  const row = await queryOne<PublicSpaceRow & { visibility: SpaceVisibility }>(
    `SELECT ${PUBLIC_SPACE_COLUMNS}, visibility FROM spaces WHERE slug = $1`,
    [slug],
  );
  if (!row) return undefined;
  const record = toPublicSpace(row);
  return {
    visibility: row.visibility,
    settings: {
      subdomain: record.subdomain,
      domain: record.domain,
      allowDownload: record.allowDownload,
      allowAssistant: record.allowAssistant,
      indexing: record.indexing,
      primaryHost: record.primaryHost,
    },
  };
}

/** The settings as a caller may pass them: `indexing`/`primaryHost` (migration 040) keep their stored value when omitted. */
export type SpacePublicSettingsInput = Omit<SpacePublicSettings, 'indexing' | 'primaryHost'> & Partial<Pick<SpacePublicSettings, 'indexing' | 'primaryHost'>>;

/**
 * Stores the publish settings. 404 for an unknown space; 400 for a domain that
 * is the instance's own host or lives under PUBLIC_SITES_DOMAIN, for a
 * subdomain on an instance without PUBLIC_SITES_DOMAIN (unless unchanged) and
 * for a label that would shadow the main host; 409 when the subdomain or the
 * domain already belongs to another space.
 */
export async function setSpacePublicSettings(slug: string, input: SpacePublicSettingsInput, originFallback = ''): Promise<SpacePublishState> {
  const current = await getSpacePublicSettings(slug);
  if (!current) throw notFound('space');
  const settings: SpacePublicSettings = {
    ...input,
    indexing: input.indexing ?? current.settings.indexing,
    primaryHost: input.primaryHost ?? current.settings.primaryHost,
  };

  const sites = sitesDomain();
  const main = mainHost(originFallback);
  if (settings.domain) {
    if (settings.domain === main) throw badRequest('this domain is the host of the Folio instance itself');
    if (sites && (settings.domain === sites || settings.domain.endsWith(`.${sites}`))) {
      throw badRequest(`use the subdomain setting for hosts under ${sites}`);
    }
  }
  if (settings.subdomain) {
    if (!sites) {
      if (settings.subdomain !== current.settings.subdomain) throw badRequest('subdomain publishing is not enabled on this instance');
    } else if (`${settings.subdomain}.${sites}` === main) {
      throw badRequest('this subdomain is reserved');
    }
  }

  try {
    await query(
      `UPDATE spaces
          SET public_subdomain = $2, public_domain = $3, public_allow_download = $4, public_allow_assistant = $5,
              public_indexing = $6, public_primary_host = $7
        WHERE slug = $1`,
      [slug, settings.subdomain, settings.domain, settings.allowDownload, settings.allowAssistant, settings.indexing, settings.primaryHost],
    );
  } catch (err) {
    const pg = err as { code?: string; constraint?: string };
    if (pg.code === '23505') {
      if (pg.constraint === 'spaces_public_subdomain_key') throw conflict('subdomain is already taken');
      if (pg.constraint === 'spaces_public_domain_key') throw conflict('domain is already in use');
    }
    throw err;
  } finally {
    invalidatePublicSiteCache();
  }
  return { visibility: current.visibility, settings };
}
