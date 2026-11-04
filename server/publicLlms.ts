/**
 * Agent-readable files of a public site (llms.txt, 03.11.2026). Anonymous routes in the public scope, registered
 * before the SPA fallback. For a published space `S` (the same four addresses as the HTML site: its own host, or
 * `/public/<slug>` on the main host):
 *
 *   GET <site>/llms.txt        llmstxt.org index: title, summary, one `- [Title](<page>.md): description` per page,
 *                              grouped by the top-level sections of the tree
 *   GET <site>/llms-full.txt   the Markdown of every listed page, each under its title and URL (capped)
 *   GET <site>/index.md        the Markdown of the home page
 *   GET <site>/p/<id>.md       the Markdown of one page (`text/markdown`)
 *
 * Who may read what is NOT decided here: the pages come from publicSites.publicReadablePageIds (the very set the
 * HTML site and the sitemap use: no restricted page, no `.agent/**`, no `_templates/`), and the Markdown of a page
 * is the export's own (export/markdown.ts assembleMarkdown, the renderer behind `GET /share/:token.md`): front
 * matter is not part of it, links are absolute. A page the HTML site answers 404 for answers 404 here.
 *
 * Switched off (404 on all of the above, no <link> in the head) when `.folio/site.json` says `"llms": false`, or when
 * the site is not indexable (indexing off, or the public demo): a site that asks crawlers to stay away does not
 * advertise a machine-readable copy of itself. Default on.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PUBLIC_SITE_PATH_PREFIX, type SiteSettings } from '../shared/contracts.js';
import { isAgentPath } from './agentPath.js';
import { notFound } from './errors.js';
import { assembleMarkdown, loadAssembleLookups, type AssembleLookups } from './export/markdown.js';
import { MAX_EXPORT_PAGES } from './export/limits.js';
import { singlePage } from './export/collect.js';
import { llmsEnabled, llmsTxtUrl, markdownPageUrl, MARKDOWN_KINDS } from './publicLlmsLinks.js';
import { pageSeoFields } from './publicSiteMeta.js';
import {
  canonicalPageUrl,
  canonicalSiteBase,
  findPublicMovedPage,
  getPublicSpace,
  publicHomePageId,
  publicReadablePageIds,
  resolvePublicSiteByHost,
  type PublicSpace,
} from './publicSites.js';
import { llmsDescription } from './llmsDescription.js';
import { readSiteSettings } from './spaceAppearance.js';
import * as storage from './storage.js';
import { humanize, relPathStem, type PageIndexEntry } from './storage.js';

/** llms-full.txt stops here (bytes of Markdown) and says so; the page cap is the export's own. */
export const LLMS_FULL_MAX_BYTES = 2 * 1024 * 1024;

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function linkText(s: string): string {
  return oneLine(s).replace(/[[\]]/g, (c) => `\\${c}`);
}

interface ListedPage {
  entry: PageIndexEntry;
  title: string;
  description: string;
}

interface SiteContext {
  record: PublicSpace;
  site: SiteSettings;
  /** Canonical address of the site, no trailing slash. */
  base: string;
  /** Scheme and host of `base`: what `/files/…` and `/a/…` links hang on. */
  origin: string;
  homePageId: string | null;
  readable: Set<string>;
}

async function siteContext(record: PublicSpace, originFallback: string): Promise<SiteContext | null> {
  const site = await readSiteSettings(record.slug).catch(() => ({}) as SiteSettings);
  if (!llmsEnabled(record, site)) return null;
  const base = canonicalSiteBase(record, originFallback);
  const [homePageId, readable] = await Promise.all([publicHomePageId(record.slug), publicReadablePageIds(record.slug)]);
  return { record, site, base, origin: new URL(base).origin, homePageId, readable };
}

/** Description of a page for the index: its front matter `description`, else its first prose paragraph (llmsDescription.ts), never the title again. */
function descriptionOf(entry: PageIndexEntry, fmDescription: string | undefined, title: string): string {
  const text = llmsDescription(fmDescription, entry.kind === 'doc' ? (entry.body ?? '').replace(/^\s*#[ \t]+[^\n]*\n?/, '') : '');
  return text === title ? '' : text;
}

/**
 * Pages of the site that appear in llms.txt / llms-full.txt, in tree order within each section: readable by the
 * public, a text kind, not `unlisted`. Same readable set and same `unlisted` rule as the sitemap.
 */
async function listedPages(ctx: SiteContext): Promise<ListedPage[]> {
  const entries = (await storage.listEntries(ctx.record.slug)).filter(
    (e) => ctx.readable.has(e.id) && MARKDOWN_KINDS.has(e.kind) && !isAgentPath(e.relPath),
  );
  const out: ListedPage[] = [];
  for (const entry of entries) {
    const fields = await pageSeoFields(entry);
    if (fields.unlisted) continue;
    const title = oneLine(fields.title || entry.title) || entry.relPath;
    out.push({ entry, title, description: descriptionOf(entry, fields.description, title) });
  }
  return out;
}

function byTreeOrder(a: ListedPage, b: ListedPage): number {
  if (a.entry.dirPath !== b.entry.dirPath) return a.entry.dirPath < b.entry.dirPath ? -1 : 1;
  if (a.entry.isIndex !== b.entry.isIndex) return a.entry.isIndex ? -1 : 1;
  return a.entry.order - b.entry.order || a.title.localeCompare(b.title);
}

interface Section {
  title: string;
  order: number;
  pages: ListedPage[];
}

/**
 * Pages at the root of the space go to "Pages"; every top-level folder is a section named after the page that stands
 * for the folder in the tree: its index page, else the page next to it with the folder's name (`onboarding.md` beside
 * `onboarding/`, which then heads its section), else the folder's name made readable ("Onboarding", never the slug).
 */
function sectionsOf(pages: ListedPage[], rootTitle: string): Section[] {
  const root: Section = { title: rootTitle, order: -1, pages: [] };
  const folders = new Map<string, Section>();
  const firstSegment = (p: ListedPage) => (p.entry.relPath.includes('/') ? p.entry.relPath.slice(0, p.entry.relPath.indexOf('/')) : '');
  const folderNames = new Set(pages.map(firstSegment).filter(Boolean));
  // A root-level page named like a folder claims it, as the tree does: only when it is the single such page and the folder has no index page.
  const hasIndex = new Set(pages.filter((p) => p.entry.isIndex && p.entry.dirPath && !p.entry.dirPath.includes('/')).map((p) => p.entry.dirPath));
  const claimants = new Map<string, ListedPage[]>();
  for (const p of pages) {
    if (firstSegment(p)) continue;
    const stem = relPathStem(p.entry.relPath, p.entry.kind);
    if (!folderNames.has(stem) || hasIndex.has(stem)) continue;
    claimants.set(stem, [...(claimants.get(stem) ?? []), p]);
  }
  const claimed = new Map<string, ListedPage>();
  for (const [folder, list] of claimants) if (list.length === 1) claimed.set(folder, list[0]);
  const claimedIds = new Set([...claimed.values()].map((p) => p.entry.id));

  const sectionFor = (folder: string): Section => {
    let section = folders.get(folder);
    if (!section) {
      const own = claimed.get(folder);
      section = { title: own?.title ?? humanize(folder), order: own?.entry.order ?? Number.MAX_SAFE_INTEGER, pages: own ? [own] : [] };
      folders.set(folder, section);
    }
    return section;
  };
  for (const page of [...pages].sort(byTreeOrder)) {
    const first = firstSegment(page);
    if (!first) {
      if (!claimedIds.has(page.entry.id)) root.pages.push(page);
      continue;
    }
    const section = sectionFor(first);
    if (page.entry.isIndex && page.entry.dirPath === first) {
      section.title = page.title;
      section.order = page.entry.order;
    }
    section.pages.push(page);
  }
  const sorted = [...folders.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  return [...(root.pages.length ? [root] : []), ...sorted];
}

function summaryOf(ctx: SiteContext): string {
  return oneLine(ctx.site.description || ctx.site.tagline || `${ctx.record.name} — published with Folio`);
}

function siteTitleOf(ctx: SiteContext): string {
  return oneLine(ctx.site.title || ctx.record.name);
}

/** The llms.txt of a site, or null when the agent files are off for it. */
export async function llmsTxt(record: PublicSpace, originFallback: string): Promise<string | null> {
  const ctx = await siteContext(record, originFallback);
  if (!ctx) return null;
  const pages = await listedPages(ctx);
  const lines = [`# ${siteTitleOf(ctx)}`, '', `> ${summaryOf(ctx)}`, ''];
  for (const section of sectionsOf(pages, 'Pages')) {
    lines.push(`## ${linkText(section.title)}`, '');
    for (const page of section.pages) {
      const url = markdownPageUrl(ctx.base, page.entry.id, ctx.homePageId);
      lines.push(`- [${linkText(page.title)}](${url})${page.description ? `: ${page.description}` : ''}`);
    }
    lines.push('');
  }
  lines.push('## Optional', '', `- [Full text](${ctx.base}/llms-full.txt): every page above in one file`, '');
  return lines.join('\n');
}

export interface LlmsFull {
  text: string;
  truncated: boolean;
}

/** `pageUrl` for assembleMarkdown: a link to a public page lands on its Markdown, a link to anything else stays as the author wrote it. */
function pageLinker(ctx: SiteContext): (pageId: string, fragment: string) => string | undefined {
  return (pageId, fragment) => {
    if (!ctx.readable.has(pageId)) return undefined;
    return `${markdownPageUrl(ctx.base, pageId, ctx.homePageId)}${fragment}`;
  };
}

async function markdownOf(ctx: SiteContext, entry: PageIndexEntry, lookups?: AssembleLookups): Promise<string> {
  const assembled = await assembleMarkdown(singlePage(entry), {
    baseUrl: ctx.origin,
    flatten: false,
    pageUrl: pageLinker(ctx),
    wikilinks: true,
    lookups,
  });
  return assembled.markdown;
}

/** Drops the page's own leading H1 when it only repeats the title the entry is already introduced by. */
function withoutLeadingTitle(markdown: string, title: string): string {
  const m = /^\s*#[ \t]+([^\n]*)\n+/.exec(markdown);
  return m && oneLine(m[1]) === title ? markdown.slice(m[0].length) : markdown;
}

/** The llms-full.txt of a site (null when off): every listed page under `# Title` and its URL, cut at the page and byte caps with a note. */
export async function llmsFullTxt(record: PublicSpace, originFallback: string): Promise<LlmsFull | null> {
  const ctx = await siteContext(record, originFallback);
  if (!ctx) return null;
  const pages = sectionsOf(await listedPages(ctx), 'Pages').flatMap((s) => s.pages);
  const lookups = await loadAssembleLookups(record.slug);
  const parts: string[] = [];
  let bytes = 0;
  let included = 0;
  for (const page of pages) {
    if (included >= MAX_EXPORT_PAGES) break;
    const markdown = withoutLeadingTitle(await markdownOf(ctx, page.entry, lookups), page.title).trim();
    const url = canonicalPageUrl(ctx.base, page.entry.id, ctx.homePageId);
    const block = `# ${page.title}\n\nURL: ${url}\n\n${markdown}`;
    const cost = Buffer.byteLength(block, 'utf8');
    // The first page always goes in whole; after it, a page that does not fit ends the file.
    if (included > 0 && bytes + cost > LLMS_FULL_MAX_BYTES) break;
    parts.push(block);
    bytes += cost;
    included++;
  }
  const omitted = pages.length - included;
  const head = [`# ${siteTitleOf(ctx)}`, '', `> ${summaryOf(ctx)}`];
  if (omitted > 0) {
    head.push('', `<!-- Truncated: ${omitted} of ${pages.length} pages are not included here. The index of all of them is ${llmsTxtUrl(ctx.base)} -->`);
  }
  return { text: `${head.join('\n')}\n\n${parts.join('\n\n---\n\n')}\n`, truncated: omitted > 0 };
}

/** The Markdown of one page of the site, or null when the page is not on it (unknown, restricted, another space, a kind without text) or the agent files are off. */
export async function pageMarkdown(record: PublicSpace, pageId: string | null, originFallback: string): Promise<string | null> {
  const ctx = await siteContext(record, originFallback);
  if (!ctx) return null;
  const id = pageId ?? ctx.homePageId;
  if (!id || id.startsWith('dir:') || !ctx.readable.has(id)) return null;
  const entry = await storage.getEntry(id).catch(() => undefined);
  if (!entry || entry.space !== record.slug || !MARKDOWN_KINDS.has(entry.kind) || isAgentPath(entry.relPath)) return null;
  return markdownOf(ctx, entry);
}

function requestOrigin(request: FastifyRequest): string {
  return `${request.protocol}://${request.hostname}`;
}

export function registerPublicLlmsRoutes(app: FastifyInstance): void {
  /** The site a request belongs to: by Host (its own address), else by `:slug` of `/public/:slug/…`. */
  async function siteOf(request: FastifyRequest): Promise<PublicSpace> {
    const { slug } = request.params as { slug?: string };
    const record = slug === undefined ? await resolvePublicSiteByHost(request.hostname) : await getPublicSpace(slug);
    if (!record) throw notFound('site');
    return record;
  }

  function route(suffix: string, handler: (request: FastifyRequest, record: PublicSpace) => Promise<{ body: string; type: string; cache: string; truncated?: boolean } | { redirect: string }>): void {
    const serve = async (request: FastifyRequest, reply: FastifyReply) => {
      const record = await siteOf(request);
      const out = await handler(request, record);
      if ('redirect' in out) return reply.redirect(out.redirect, 301);
      if (out.truncated) reply.header('X-Folio-Llms-Truncated', 'true');
      return reply.header('Cache-Control', out.cache).type(out.type).send(out.body);
    };
    app.get(suffix, serve);
    app.get(`${PUBLIC_SITE_PATH_PREFIX}/:slug${suffix}`, serve);
  }

  route('/llms.txt', async (request, record) => {
    const body = await llmsTxt(record, requestOrigin(request));
    if (body === null) throw notFound('llms.txt');
    return { body, type: 'text/plain; charset=utf-8', cache: 'public, max-age=300' };
  });

  route('/llms-full.txt', async (request, record) => {
    const full = await llmsFullTxt(record, requestOrigin(request));
    if (!full) throw notFound('llms-full.txt');
    return { body: full.text, type: 'text/plain; charset=utf-8', cache: 'public, max-age=300', truncated: full.truncated };
  });

  route('/index.md', async (request, record) => {
    const body = await pageMarkdown(record, null, requestOrigin(request));
    if (body === null) throw notFound('page');
    return { body, type: 'text/markdown; charset=utf-8', cache: 'public, max-age=60' };
  });

  route('/p/:id.md', async (request, record) => {
    const { id } = request.params as { id: string };
    const body = await pageMarkdown(record, id, requestOrigin(request));
    if (body === null) {
      // An id the page used to have: the same address with the current one, permanently.
      const moved = await findPublicMovedPage(record, id);
      if (moved) return { redirect: request.url.split('?')[0].replace(/\/p\/[^/]+$/, `/p/${encodeURIComponent(moved.id)}.md`) };
      throw notFound('page');
    }
    return { body, type: 'text/markdown; charset=utf-8', cache: 'public, max-age=60' };
  });
}
