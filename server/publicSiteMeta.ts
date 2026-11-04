/**
 * Server-rendered <head> of a public site's pages (14.10.2026, SEO) — the
 * per-page counterpart of shareMeta.ts. Crawlers and link-preview bots read
 * the raw HTML and never run the SPA, so for
 *
 *   /public/<slug>, /public/<slug>/p/<id>        (path mode, main host)
 *   /, /p/<id>                                   (the site's own host)
 *
 * this module resolves what pageMeta.renderIndexHtml writes: <title> (page
 * title · site title), meta description, og:* (site_name, url, image),
 * <link rel=canonical> (canonicalBase by primaryHost), <html lang>, the favicon,
 * `noindex` (indexing off, the public demo, or `unlisted: true` in the page's
 * front matter) — and the HTTP status: a page that is not on the site (unknown
 * id, restricted, another space, a private space's /public path) answers 404
 * with the same HTML shell, so crawlers see a 404 while the SPA still renders
 * its own not-found view.
 *
 * Per-page SEO fields come from the page's own front matter, read at render
 * time (pages_index has no description) and cached by mtime: `title`,
 * `description`, `image` / `cover`, `unlisted`. Never throws: any failure
 * leaves the caller with the plain shell.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as yamlModule from 'js-yaml';
import { PUBLIC_SITE_PATH_PREFIX } from '../shared/contracts.js';
import type { PublicPageSeo, PublicSiteMeta } from './pageMeta.js';
import {
  canonicalPageUrl,
  canonicalSiteBase,
  findPublicMovedPage,
  getPublicSpace,
  isPublicPage,
  publicHomePageId,
  resolvePublicSiteByHost,
  siteIndexable,
  type PublicSpace,
} from './publicSites.js';
import { llmsEnabled, llmsTxtUrl, markdownPageUrl, MARKDOWN_KINDS } from './publicLlmsLinks.js';
import { excerptFromMarkdown } from './shareMeta.js';
import { readSiteSettings, siteAssetUrl, statSiteAsset } from './spaceAppearance.js';
import * as storage from './storage.js';
import type { PageIndexEntry } from './storage.js';

// js-yaml is CJS; take `.default` when present (see export/boardText.ts for why).
const yaml = (yamlModule as unknown as { default?: typeof yamlModule }).default ?? yamlModule;

// ---------------------------------------------------------------------------
// front matter SEO fields
// ---------------------------------------------------------------------------

export interface PageSeoFields {
  title?: string;
  description?: string;
  /** `image`, else `cover`, as written. */
  image?: string;
  unlisted: boolean;
}

const fmCache = new Map<string, { mtimeMs: number; size: number; value: PageSeoFields }>();
const FM_CACHE_MAX = 5000;
const FRONT_MATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

function text(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : undefined;
}

/** Parses the SEO keys of a front matter block (pure). */
export function seoFieldsFromMarkdown(raw: string): PageSeoFields {
  const m = FRONT_MATTER_RE.exec(raw);
  if (!m) return { unlisted: false };
  let data: unknown;
  try {
    data = yaml.load(m[1], { schema: yaml.JSON_SCHEMA });
  } catch {
    return { unlisted: false };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { unlisted: false };
  const d = data as Record<string, unknown>;
  const unlisted = d.unlisted === true || (typeof d.unlisted === 'string' && /^(true|yes)$/i.test(d.unlisted.trim()));
  return {
    title: text(d.title, 200),
    description: text(d.description, 500),
    image: text(d.image, 2000) ?? text(d.cover, 2000),
    unlisted,
  };
}

/** The SEO front matter of a doc page (other kinds have none), cached by the file's mtime and size. */
export async function pageSeoFields(entry: Pick<PageIndexEntry, 'absPath' | 'kind'>): Promise<PageSeoFields> {
  if (entry.kind !== 'doc') return { unlisted: false };
  try {
    const st = await fs.lstat(entry.absPath);
    if (!st.isFile()) return { unlisted: false };
    const hit = fmCache.get(entry.absPath);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
    const value = seoFieldsFromMarkdown(await fs.readFile(entry.absPath, 'utf8'));
    if (fmCache.size >= FM_CACHE_MAX) fmCache.clear();
    fmCache.set(entry.absPath, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  } catch {
    return { unlisted: false };
  }
}

// ---------------------------------------------------------------------------
// the <head> of one request
// ---------------------------------------------------------------------------

export interface PublicSiteHead {
  /** What renderIndexHtml needs; undefined for a `/public/<slug>` of a space that is not published (404, plain shell). */
  site?: PublicSiteMeta;
  status: 200 | 404;
  /** Set when the page id in the URL is gone but meant a page that is on the site: the same address with that page's id (answer 301). */
  redirectTo?: string;
}

/** An absolute URL for a front matter image: absolute http(s) as is, root-relative on the site origin, relative to the page's folder under /files/. */
function absoluteImageUrl(raw: string, origin: string, entry: PageIndexEntry): string | undefined {
  const value = raw.trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) return undefined;
  if (value.startsWith('/')) return `${origin}${value}`;
  const resolved = path.posix.normalize(path.posix.join(entry.dirPath || '', value));
  if (resolved.startsWith('..') || resolved.split('/').some((s) => s.startsWith('.'))) return undefined;
  return `${origin}/files/${encodeURIComponent(entry.space)}/${resolved.split('/').map(encodeURIComponent).join('/')}`;
}

type Route = { kind: 'home' } | { kind: 'page'; id: string } | { kind: 'other' } | { kind: 'missing' };

const PATH_SITE_RE = new RegExp(`^${PUBLIC_SITE_PATH_PREFIX}/([^/]+)(/.*)?$`);

function routeOf(rest: string, hostMode: boolean): Route {
  if (rest === '' || rest === '/') return { kind: 'home' };
  const page = /^\/p\/([^/]+)\/?$/.exec(rest);
  if (page) {
    try {
      return { kind: 'page', id: decodeURIComponent(page[1]) };
    } catch {
      return { kind: 'missing' };
    }
  }
  // On the site's own host every other path is a client-side redirect (to '/' or the app); under /public/<slug>/ it is a not-found view.
  return hostMode ? { kind: 'other' } : { kind: 'missing' };
}

async function publicEntry(record: PublicSpace, id: string): Promise<PageIndexEntry | undefined> {
  if (!id || id.startsWith('dir:')) return undefined;
  const entry = await storage.getEntry(id).catch(() => undefined);
  if (!entry || entry.space !== record.slug) return undefined;
  return (await isPublicPage(entry)) ? entry : undefined;
}

/** The head of a published site page, or undefined when `pathname` on `hostname` is not a public-site page at all. */
export async function resolvePublicSiteHead(hostname: string | undefined, pathname: string, requestOrigin: string): Promise<PublicSiteHead | undefined> {
  try {
    let record: PublicSpace | undefined = await resolvePublicSiteByHost(hostname);
    const hostMode = Boolean(record);
    let rest = pathname;
    if (!record) {
      const m = PATH_SITE_RE.exec(pathname);
      if (!m) return undefined;
      record = await getPublicSpace(m[1]);
      if (!record) return { status: 404 };
      rest = m[2] ?? '';
    }
    const route = routeOf(rest, hostMode);
    const site = await readSiteSettings(record.slug).catch(() => ({}) as Awaited<ReturnType<typeof readSiteSettings>>);
    const siteTitle = site.title?.trim() || record.name;
    const base = canonicalSiteBase(record, requestOrigin);
    const origin = new URL(base).origin;
    const homePageId = await publicHomePageId(record.slug);
    const indexable = siteIndexable(record);

    const assetAbs = async (name: string | undefined): Promise<string | undefined> => {
      if (!name) return undefined;
      const st = await statSiteAsset(record!.slug, name).catch(() => null);
      return st ? siteAssetUrl(record!.slug, name, st.version) : undefined;
    };
    const favicon = await assetAbs(site.favicon);
    const ogImage = await assetAbs(site.ogImage);

    let entry: PageIndexEntry | undefined;
    let status: 200 | 404 = 200;
    if (route.kind === 'home') entry = homePageId ? await publicEntry(record, homePageId) : undefined;
    else if (route.kind === 'page') {
      entry = await publicEntry(record, route.id);
      if (!entry) {
        // A link to an id the page used to have (derived from its path): send it on, permanently, instead of a dead end.
        const moved = await findPublicMovedPage(record, route.id);
        if (moved) return { status: 404, redirectTo: pathname.replace(/\/p\/[^/]+\/?$/, `/p/${encodeURIComponent(moved.id)}`) };
        status = 404;
      }
    } else if (route.kind === 'missing') status = 404;

    const fields = entry ? await pageSeoFields(entry) : { unlisted: false };
    const pageTitle = fields.title || entry?.title?.trim();
    // The site root is titled by the site; a page by its own title, then the site's.
    const title = status === 200 && route.kind === 'page' && pageTitle && pageTitle !== siteTitle ? `${pageTitle} · ${siteTitle}` : siteTitle;
    const description =
      (status === 200 && fields.description) ||
      site.description ||
      (status === 200 && entry ? excerptFromMarkdown(entry.body ?? '') : '') ||
      site.tagline ||
      `${record.name} — published with Folio`;
    const pageImage = status === 200 && entry && fields.image ? absoluteImageUrl(fields.image, origin, entry) : undefined;

    const seo: PublicPageSeo = {
      title,
      description,
      siteName: siteTitle,
      canonical: status === 200 && route.kind !== 'other' ? canonicalPageUrl(base, route.kind === 'page' ? route.id : null, homePageId) : undefined,
      image: pageImage ?? (ogImage ? `${origin}${ogImage}` : undefined),
      lang: site.lang,
      favicon,
      noindex: !indexable || fields.unlisted || status === 404,
      // Agent-readable copies (publicLlms.ts): this page's Markdown and the site's llms.txt, when the site has them on.
      ...(status === 200 && route.kind !== 'other' && llmsEnabled(record, site)
        ? {
            llmsUrl: llmsTxtUrl(base),
            ...(entry && MARKDOWN_KINDS.has(entry.kind) ? { markdownUrl: markdownPageUrl(base, entry.id, homePageId) } : {}),
          }
        : {}),
    };
    return { site: { slug: record.slug, name: record.name, hostMode, seo }, status };
  } catch {
    return undefined;
  }
}
