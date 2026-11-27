/**
 * robots.txt and sitemaps of public sites (14.10.2026, SEO). Anonymous routes,
 * registered in the public scope BEFORE the SPA fallback (and `/robots.txt`,
 * `/sitemap.xml` are on spaFallback's never-fallback list, so a miss is a real
 * 404 instead of index.html with 200):
 *
 *   GET /robots.txt               host-dependent:
 *       a site's own host  → indexing on: crawl everything but /api/ (except /api/public/), /s/, /share/; `Sitemap:` of the site.
 *                            indexing off (or the public demo): `Disallow: /`.
 *       the main host      → `Disallow: /s/ /share/ /api/` (with /public/ and /api/public/ allowed), a `Disallow` for every
 *                            /public/<slug> that must not be indexed, `Sitemap:` for every indexable site whose canonical
 *                            address is the path form. In the public demo every /public/ path is disallowed.
 *   GET /sitemap.xml              a site host: that site's sitemap; the main host: a sitemap index of the path-mode sites.
 *   GET /public/:slug/sitemap.xml the sitemap of one published space.
 *
 * A sitemap lists the public pages (publicReadablePageIds: no restricted page,
 * no `.agent/**`, no `_templates/`) minus those whose front matter says
 * `unlisted: true`; `<loc>` = canonicalBase + page path (the home page = the
 * site root), `<lastmod>` = the page's updatedAt. Not indexable → 404.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PUBLIC_SITE_PATH_PREFIX } from '../shared/contracts.js';
import { isAgentPath } from './agentPath.js';
import { query } from './db/pool.js';
import { isDemoMode } from './demo.js';
import { notFound } from './errors.js';
import { pageSeoFields } from './publicSiteMeta.js';
import {
  canonicalPageUrl,
  canonicalSiteBase,
  getPublicSpace,
  isPathCanonical,
  listPublicSpaces,
  publicHomePageId,
  publicReadablePageIds,
  resolvePublicSiteByHost,
  siteIndexable,
  type PublicSpace,
} from './publicSites.js';
import { publicUrlOrOrigin, requestOrigin } from './publicUrl.js';
import * as storage from './storage.js';

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** robots.txt for a request to `hostname` (`requestOrigin` = its scheme://host, the PUBLIC_URL fallback). */
export async function robotsTxt(hostname: string | undefined, requestOrigin: string): Promise<string> {
  const site = await resolvePublicSiteByHost(hostname);
  if (site) {
    if (!siteIndexable(site)) return 'User-agent: *\nDisallow: /\n';
    const base = canonicalSiteBase(site, requestOrigin);
    return [
      'User-agent: *',
      'Allow: /api/public/',
      'Disallow: /api/',
      'Disallow: /s/',
      'Disallow: /share/',
      'Allow: /',
      '',
      `Sitemap: ${base}/sitemap.xml`,
      '',
    ].join('\n');
  }

  const main = publicUrlOrOrigin(requestOrigin);
  const lines = ['User-agent: *'];
  const demo = isDemoMode();
  lines.push(demo ? `Disallow: ${PUBLIC_SITE_PATH_PREFIX}/` : `Allow: ${PUBLIC_SITE_PATH_PREFIX}/`);
  lines.push('Allow: /api/public/', 'Disallow: /s/', 'Disallow: /share/', 'Disallow: /api/');
  const sitemaps: string[] = [];
  if (!demo) {
    for (const space of await listPublicSpaces()) {
      if (!siteIndexable(space)) {
        lines.push(`Disallow: ${PUBLIC_SITE_PATH_PREFIX}/${space.slug}$`, `Disallow: ${PUBLIC_SITE_PATH_PREFIX}/${space.slug}/`);
      } else if (isPathCanonical(space, requestOrigin)) {
        sitemaps.push(`Sitemap: ${main}${PUBLIC_SITE_PATH_PREFIX}/${space.slug}/sitemap.xml`);
      }
    }
  }
  return [...lines, ...(sitemaps.length ? ['', ...sitemaps] : []), ''].join('\n');
}

interface SitemapRow {
  id: string;
  path: string;
  kind: storage.PageIndexEntry['kind'];
  updated_at: string | Date;
}

/** The sitemap of a published space, or null when the site must not be indexed. */
export async function sitemapXml(record: PublicSpace, originFallback: string): Promise<string | null> {
  if (!siteIndexable(record)) return null;
  const base = canonicalSiteBase(record, originFallback);
  const [rows, readable, homePageId] = await Promise.all([
    query<SitemapRow>('SELECT id, path, kind, updated_at FROM pages_index WHERE space_slug = $1 ORDER BY path', [record.slug]),
    publicReadablePageIds(record.slug),
    publicHomePageId(record.slug),
  ]);
  const contentDir = storage.getSpaceDir(record.slug);
  const urls: Array<{ loc: string; lastmod: string; home: boolean }> = [];
  for (const row of rows) {
    if (!readable.has(row.id) || isAgentPath(row.path)) continue;
    const fields = await pageSeoFields({ kind: row.kind, absPath: `${contentDir}/${row.path}` });
    if (fields.unlisted) continue;
    const updated = new Date(row.updated_at);
    urls.push({
      loc: canonicalPageUrl(base, row.id, homePageId),
      lastmod: Number.isNaN(updated.getTime()) ? '' : updated.toISOString(),
      home: row.id === homePageId,
    });
  }
  urls.sort((a, b) => Number(b.home) - Number(a.home));
  const body = urls
    .map((u) => `  <url>\n    <loc>${xmlEscape(u.loc)}</loc>\n${u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>\n` : ''}  </url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}${body ? '\n' : ''}</urlset>\n`;
}

/** The main host's sitemap index: the sitemaps of every indexable path-mode site; null when there is none. */
export async function sitemapIndexXml(requestOrigin: string): Promise<string | null> {
  if (isDemoMode()) return null;
  const main = publicUrlOrOrigin(requestOrigin);
  const entries = (await listPublicSpaces())
    .filter((space) => siteIndexable(space) && isPathCanonical(space, requestOrigin))
    .map((space) => `  <sitemap>\n    <loc>${xmlEscape(`${main}${PUBLIC_SITE_PATH_PREFIX}/${space.slug}/sitemap.xml`)}</loc>\n  </sitemap>`);
  if (entries.length === 0) return null;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</sitemapindex>\n`;
}

export function registerPublicSeoRoutes(app: FastifyInstance): void {
  app.get('/robots.txt', async (request, reply) => {
    const body = await robotsTxt(request.hostname, requestOrigin(request));
    return reply.header('Cache-Control', 'public, max-age=300').type('text/plain; charset=utf-8').send(body);
  });

  app.get('/sitemap.xml', async (request, reply) => {
    const site = await resolvePublicSiteByHost(request.hostname);
    const xml = site ? await sitemapXml(site, requestOrigin(request)) : await sitemapIndexXml(requestOrigin(request));
    if (!xml) throw notFound('sitemap');
    return reply.header('Cache-Control', 'public, max-age=300').type('application/xml; charset=utf-8').send(xml);
  });

  app.get(`${PUBLIC_SITE_PATH_PREFIX}/:slug/sitemap.xml`, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const site = await getPublicSpace(slug);
    if (!site) throw notFound('sitemap');
    const xml = await sitemapXml(site, requestOrigin(request));
    if (!xml) throw notFound('sitemap');
    return reply.header('Cache-Control', 'public, max-age=300').type('application/xml; charset=utf-8').send(xml);
  });
}
