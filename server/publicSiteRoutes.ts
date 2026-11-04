/**
 * Public sites (13.10.2026) — the HTTP surface. Two groups:
 *
 *  - `registerPublicSiteRoutes(app)`: ANONYMOUS read routes under /api/public/**,
 *    registered in the public scope (outside the session hook), next to
 *    registerPublicShareRoutes. Every handler answers 404 `space not found`
 *    unless the space's visibility is 'public', never reads `request.authUser`
 *    and only ever serves pages in the public set (publicSites.ts: no
 *    restricted page, no `.agent/**`, no `_templates/`). Unlike a share link,
 *    a public site is meant to be indexed, so no `X-Robots-Tag: noindex`.
 *  - `registerPublicSiteAdminRoutes(app)`: GET/PUT /api/spaces/:space/public-settings
 *    in the protected scope — a space admin or instance admin, cookie session only.
 *
 * Files (/files/<space>/...), the collab socket and the HTML shell have their
 * own public-site branches in fileAccess.ts, collab.ts and index.ts; they all
 * ask publicSites.ts what is public.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  updateSpacePublicSettingsBodySchema,
  type EmbedPayload,
  type PublicPageLinks,
  type PublicPagePayload,
  type PublicSiteInfo,
  type SearchHit,
  type SpacePublicSettingsResponse,
  type TreeNode,
  type User,
} from '../shared/contracts.js';
import { recordAudit } from './audit.js';
import * as session from './auth/session.js';
import { assertNoDemoPublicHostnames, isDemoMode } from './demo.js';
import { buildEmbed, parseEmbedDepth } from './embed.js';
import { forbidden, notFound } from './errors.js';
import { registerPublicSiteExportRoutes } from './export/routes.js';
import { getPageLinks } from './indexV2/read.js';
import { buildPageDoc } from './pageDoc.js';
import {
  buildPublicSiteInfo,
  getPublicSpace,
  findPublicMovedPage,
  getSpacePublicSettings,
  isPublicPage,
  mainHost,
  publicReadablePageIds,
  publicSiteUrls,
  resolvePublicSiteByHost,
  setSpacePublicSettings,
  sitesDomain,
  type PublicSpace,
  type SpacePublicSettingsInput,
} from './publicSites.js';
import { searchPublicSpace } from './search.js';
import { readAsset, readSiteCss } from './spaceAppearance.js';
import * as storage from './storage.js';
import { parseBody, queryString } from './validate.js';

/** Longest search query a public visitor can send; longer input is cut, not rejected. */
const MAX_PUBLIC_QUERY_LENGTH = 200;

function requestOrigin(request: FastifyRequest): string {
  return `${request.protocol}://${request.hostname}`;
}

/** The published space named by `:slug`, or 404 `space not found` (private, instance-wide and unknown spaces are indistinguishable). */
async function requirePublicSpace(request: FastifyRequest): Promise<PublicSpace> {
  const { slug } = request.params as { slug: string };
  const site = await getPublicSpace(slug);
  if (!site) throw notFound('space');
  return site;
}

/**
 * The page `:id` of a published space, or 404 `page not found`. The same 404 for "no such page", "page of another
 * space", a synthetic folder node (`dir:...`, which storage.getEntry would 400 on) and "not public" - nothing to probe.
 */
async function requirePublicPage(request: FastifyRequest, site: PublicSpace): Promise<storage.PageIndexEntry> {
  const { id } = request.params as { id: string };
  const entry = id.startsWith('dir:') ? undefined : await storage.getEntry(id);
  if (!entry || entry.space !== site.slug || !(await isPublicPage(entry))) throw notFound('page');
  return entry;
}

export function registerPublicSiteRoutes(app: FastifyInstance): void {
  // The site served at this request's Host (subdomain / custom domain) — what the SPA asks first when the HTML shell carries the folio-public-site marker.
  app.get('/api/public/site', async (request): Promise<PublicSiteInfo> => {
    const site = await resolvePublicSiteByHost(request.hostname);
    if (!site) throw notFound('a public site');
    return buildPublicSiteInfo(site, 'host', requestOrigin(request));
  });

  app.get('/api/public/spaces/:slug', async (request): Promise<PublicSiteInfo> => {
    const site = await requirePublicSpace(request);
    return buildPublicSiteInfo(site, 'path', requestOrigin(request));
  });

  app.get('/api/public/spaces/:slug/tree', async (request): Promise<{ tree: TreeNode[] }> => {
    const site = await requirePublicSpace(request);
    return { tree: await storage.getTree(site.slug, await publicReadablePageIds(site.slug)) };
  });

  app.get('/api/public/spaces/:slug/pages/:id', async (request): Promise<PublicPagePayload> => {
    const site = await requirePublicSpace(request);
    // An id that no longer exists but meant a page that does (storage.findMovedPage) answers with THAT page: the
    // payload's own id differs from the one asked for, which tells the site to move the address bar to it.
    const entry = await requirePublicPage(request, site).catch(async (err: unknown) => {
      const moved = await findPublicMovedPage(site, (request.params as { id: string }).id);
      if (moved) return moved;
      throw err;
    });
    return { page: await buildPageDoc(entry, { kind: 'public', space: site.slug }), spaceName: site.name };
  });

  // Wave 2 (Obsidian): an embedded note (`![[Note#Heading]]`) of a public page - the whole page, a heading section or a ^block (server/embed.ts).
  app.get('/api/public/spaces/:slug/pages/:id/embed', async (request): Promise<EmbedPayload> => {
    const site = await requirePublicSpace(request);
    const entry = await requirePublicPage(request, site);
    parseEmbedDepth(queryString(request.query, 'depth'));
    return buildEmbed(entry, queryString(request.query, 'fragment') || null);
  });

  // Wave 2: the typed links of a public page, for its wikilinks. The SQL ACL (accessSql.ts) reads a target outside the public set as unresolved; nothing but `links` leaves.
  app.get('/api/public/spaces/:slug/pages/:id/links', async (request): Promise<PublicPageLinks> => {
    const site = await requirePublicSpace(request);
    const entry = await requirePublicPage(request, site);
    return { links: await getPageLinks(entry.id, { kind: 'public', space: site.slug }) };
  });

  // Relative .md links inside a page: space-relative path -> page id.
  app.get('/api/public/spaces/:slug/resolve', async (request): Promise<{ id: string }> => {
    const site = await requirePublicSpace(request);
    const resolved = await storage.resolve(site.slug, queryString(request.query, 'path'));
    if (!(await isPublicPage({ id: resolved.id, space: site.slug, relPath: resolved.path }))) throw notFound('page');
    return { id: resolved.id };
  });

  app.get('/api/public/spaces/:slug/search', async (request): Promise<{ hits: SearchHit[] }> => {
    const site = await requirePublicSpace(request);
    const q = queryString(request.query, 'q').trim().slice(0, MAX_PUBLIC_QUERY_LENGTH);
    return { hits: q ? await searchPublicSpace(q, site.slug) : [] };
  });

  // .../pages/:id/export.(md|pdf|docx) - opt-in per space, throttled per IP.
  registerPublicSiteExportRoutes(app);

  // The site's own stylesheet, `.folio/site.css` sanitized (shared/siteCss.ts): 404 when the space has none.
  app.get('/api/public/spaces/:slug/site.css', async (request, reply) => {
    const site = await requirePublicSpace(request);
    const css = await readSiteCss(site.slug);
    if (!css || !css.css.trim()) throw notFound('site.css');
    const etag = `"${css.etag}"`;
    reply.header('Content-Type', 'text/css; charset=utf-8');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('ETag', etag);
    reply.header('Cache-Control', 'public, max-age=300');
    if (request.headers['if-none-match'] === etag) return reply.status(304).send();
    return reply.send(css.css);
  });

  // A file of `.folio/assets/` (logo, favicon, og image, fonts): images inline (SVG sandboxed), fonts as font/*.
  app.get('/api/public/spaces/:slug/site-assets/:name', async (request, reply) => {
    const site = await requirePublicSpace(request);
    const { name } = request.params as { name: string };
    const asset = await readAsset(site.slug, name);
    if (!asset) throw notFound('asset');
    reply.headers(asset.headers);
    const versioned = queryString(request.query, 'v') !== '';
    reply.header('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
    return reply.send(asset.bytes);
  });
}

// ---------------------------------------------------------------------------
// Admin: GET/PUT /api/spaces/:space/public-settings
// ---------------------------------------------------------------------------

async function requireSettingsAdmin(actor: User, space: string): Promise<void> {
  if (!(await storage.spaceExists(space))) throw notFound('space');
  if (!(await session.canAdministerSpace(actor, space))) throw forbidden('requires instance admin, or admin role in this space');
}

async function settingsResponse(space: string, originFallback: string): Promise<SpacePublicSettingsResponse> {
  const state = await getSpacePublicSettings(space);
  if (!state) throw notFound('space');
  return {
    visibility: state.visibility,
    settings: state.settings,
    urls: publicSiteUrls(space, state.settings, originFallback),
    sitesDomain: sitesDomain(),
    mainHost: mainHost(originFallback),
  };
}

export async function getPublicSettings(actor: User, space: string, originFallback: string): Promise<SpacePublicSettingsResponse> {
  await requireSettingsAdmin(actor, space);
  return settingsResponse(space, originFallback);
}

/** Space admin or instance admin only. In the public demo the demo accounts may publish too, but subdomain and custom domain are refused (demo.ts: assertNoDemoPublicHostnames) and Ask stays off. */
export async function updatePublicSettings(actor: User, space: string, input: SpacePublicSettingsInput, originFallback: string): Promise<SpacePublicSettingsResponse> {
  await requireSettingsAdmin(actor, space);
  assertNoDemoPublicHostnames(input);
  // Public demo: the assistant runs are refused for everyone there (assertNotDemo), so a
  // saved `allowAssistant` would only put an "Ask AI" button on the site that answers 403.
  const effective: SpacePublicSettingsInput = isDemoMode() ? { ...input, allowAssistant: false } : input;
  const { settings } = await setSpacePublicSettings(space, effective, originFallback);
  recordAudit(actor.id, 'space.public_settings', space, {
    subdomain: settings.subdomain,
    domain: settings.domain,
    allowDownload: settings.allowDownload,
    allowAssistant: settings.allowAssistant,
    indexing: settings.indexing,
    primaryHost: settings.primaryHost,
  });
  return settingsResponse(space, originFallback);
}

/** Cookie session only (a PAT never administers access - same rule as every route in access/routes.ts). */
export function registerPublicSiteAdminRoutes(app: FastifyInstance): void {
  app.get('/api/spaces/:space/public-settings', async (request) => {
    session.requireCookieAuth(request);
    const { space } = request.params as { space: string };
    return getPublicSettings(request.authUser!, space, requestOrigin(request));
  });

  app.put('/api/spaces/:space/public-settings', async (request) => {
    session.requireCookieAuth(request);
    session.requireWriteScope(request);
    const { space } = request.params as { space: string };
    const body = parseBody(updateSpacePublicSettingsBodySchema, request.body);
    return updatePublicSettings(request.authUser!, space, body, requestOrigin(request));
  });
}
