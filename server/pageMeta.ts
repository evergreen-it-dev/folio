/**
 * Link-preview ("Open Graph" / Twitter card) meta for the SPA's index.html.
 *
 * Link-preview bots (LinkedIn, Facebook, Slack, Telegram, ...) read the raw
 * HTML and never run the SPA's JS, so the preview tags must be in the first
 * response. This module rewrites the head of web/dist/index.html per request:
 * a plain self-hosted instance gets neutral product defaults; the public demo
 * (FOLIO_DEMO_MODE) gets its own text and image. Any of the three can be
 * overridden with FOLIO_OG_TITLE / FOLIO_OG_DESCRIPTION / FOLIO_OG_IMAGE.
 *
 * Share links (shareMeta.ts) run on top of this: they replace title,
 * description and url with the shared page's own. Public-site pages
 * (publicSiteMeta.ts) hand renderIndexHtml a resolved `seo` block: title,
 * description, site name, canonical URL, image, lang, favicon and noindex.
 *
 * Every env value reaches an HTML attribute, so every value is escaped.
 */
import { isDemoMode } from './demo.js';
import { publicUrlOrOrigin } from './publicUrl.js';
import { escapeHtmlAttr } from './shareMeta.js';

export const DEFAULT_OG_TITLE = 'Folio — team wiki in Git';
export const DEFAULT_OG_DESCRIPTION =
  'Markdown pages, data tables, whiteboards and forms for your team, stored as plain files in Git. Self-hosted, open source, with AI agents through MCP.';
export const DEFAULT_OG_IMAGE = '/og/og-folio.png';
export const DEMO_OG_TITLE = 'Folio public demo — try a Git-backed team wiki with AI agents';
export const DEMO_OG_DESCRIPTION =
  'Sign in as Sam in one click: pages, data tables, whiteboards, forms, PDFs and the .agent rules. Resets daily.';
export const DEMO_OG_IMAGE = '/og/og-demo.png';
const OG_IMAGE_ALT_DEFAULT = 'Folio: the wiki that lives in Git. Made by agents, for agents.';
const OG_IMAGE_ALT_DEMO = 'Folio public demo: try Folio in your browser, AI-friendly from day one.';

export interface PageMeta {
  title: string;
  description: string;
  /** Absolute URL of the preview image. */
  image: string;
  imageAlt: string;
  /** Only known for the bundled 1200x630 images, not for a custom FOLIO_OG_IMAGE. */
  imageSize?: { width: number; height: number };
  /** og:site_name; "Folio" when absent. */
  siteName?: string;
}

function envText(name: string): string {
  return (process.env[name] ?? '').trim();
}

/** Resolves the preview text/image for this instance. `origin` is the public origin without a trailing slash. */
export function resolvePageMeta(origin: string): PageMeta {
  const demo = isDemoMode();
  const customImage = envText('FOLIO_OG_IMAGE');
  const imagePath = customImage || (demo ? DEMO_OG_IMAGE : DEFAULT_OG_IMAGE);
  const image = /^https?:\/\//i.test(imagePath) ? imagePath : `${origin}${imagePath.startsWith('/') ? '' : '/'}${imagePath}`;
  return {
    title: envText('FOLIO_OG_TITLE') || (demo ? DEMO_OG_TITLE : DEFAULT_OG_TITLE),
    description: envText('FOLIO_OG_DESCRIPTION') || (demo ? DEMO_OG_DESCRIPTION : DEFAULT_OG_DESCRIPTION),
    image,
    imageAlt: demo ? OG_IMAGE_ALT_DEMO : OG_IMAGE_ALT_DEFAULT,
    imageSize: customImage ? undefined : { width: 1200, height: 630 },
  };
}

// Tags this module owns: removed from the built HTML, then written back once, in a fixed shape that shareMeta.ts keys on.
const OWNED_TAGS: RegExp[] = [
  /[ \t]*<meta\s+name="robots"[^>]*>\s*\n?/g,
  /[ \t]*<meta\s+name="description"[^>]*>\s*\n?/g,
  /[ \t]*<meta\s+property="og:[^"]*"[^>]*>\s*\n?/g,
  /[ \t]*<meta\s+name="twitter:[^"]*"[^>]*>\s*\n?/g,
  /[ \t]*<link\s+rel="canonical"[^>]*>\s*\n?/g,
];

/** Rewrites <title> and the preview meta block of the SPA's index.html. Returns the input unchanged when it has no </head>. */
export function applyPageMeta(html: string, meta: PageMeta, absoluteUrl: string): string {
  const headClose = html.indexOf('</head>');
  if (headClose === -1) return html;
  let head = html.slice(0, headClose);
  for (const re of OWNED_TAGS) head = head.replace(re, '');
  head = head.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtmlAttr(meta.title)}</title>`);

  const t = escapeHtmlAttr(meta.title);
  const d = escapeHtmlAttr(meta.description);
  const img = escapeHtmlAttr(meta.image);
  const alt = escapeHtmlAttr(meta.imageAlt);
  const lines = [
    `<meta name="description" content="${d}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${escapeHtmlAttr(meta.siteName ?? 'Folio')}" />`,
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    `<meta property="og:url" content="${escapeHtmlAttr(absoluteUrl)}" />`,
    `<meta property="og:image" content="${img}" />`,
    ...(meta.imageSize
      ? [
          `<meta property="og:image:width" content="${meta.imageSize.width}" />`,
          `<meta property="og:image:height" content="${meta.imageSize.height}" />`,
        ]
      : []),
    `<meta property="og:image:alt" content="${alt}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${t}" />`,
    `<meta name="twitter:description" content="${d}" />`,
    `<meta name="twitter:image" content="${img}" />`,
    `<meta name="twitter:image:alt" content="${alt}" />`,
  ];
  return `${head.replace(/\s*$/, '\n')}    ${lines.join('\n    ')}\n  ${html.slice(headClose)}`;
}

/** The resolved SEO head of one public-site page (publicSiteMeta.resolvePublicSiteHead). Values are raw: escaped here. */
export interface PublicPageSeo {
  /** Full <title>: page title · site title (or the site title alone). */
  title: string;
  description: string;
  /** og:site_name — the site title. */
  siteName: string;
  /** Absolute canonical URL (<link rel=canonical>, og:url); undefined for a 404 or a redirecting path. */
  canonical?: string;
  /** Absolute og:image; the instance image when undefined. */
  image?: string;
  /** <html lang>; the built index.html's own when undefined. */
  lang?: string;
  /** Favicon URL (a site asset); /favicon.svg stays when undefined. */
  favicon?: string;
  /** Absolute URL of this page's Markdown copy (<link rel=alternate type=text/markdown>); none when the site's agent files are off. */
  markdownUrl?: string;
  /** Absolute URL of the site's llms.txt (<link rel=alternate type=text/plain>). */
  llmsUrl?: string;
  noindex: boolean;
}

/** A published space the page belongs to (publicSites.publicSiteForShell / publicSiteMeta.resolvePublicSiteHead). */
export interface PublicSiteMeta {
  slug: string;
  name: string;
  /** Served on the site's own host: the SPA mounts the site at '/', which it learns from the `folio-public-site` meta tag. */
  hostMode: boolean;
  /** 14.10.2026: the page's own SEO head; without it the space name is the title (as before). */
  seo?: PublicPageSeo;
}

function faviconType(href: string): string {
  const ext = href.split('?')[0].split('.').pop()?.toLowerCase();
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'png') return 'image/png';
  if (ext === 'ico') return 'image/x-icon';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  return 'image/png';
}

/** canonical, robots, lang and favicon of a public-site page — on top of applyPageMeta's output. */
function applySeoExtras(html: string, seo: PublicPageSeo): string {
  let out = html;
  if (seo.lang) out = out.replace(/<html\b([^>]*?)\slang="[^"]*"/i, `<html$1 lang="${escapeHtmlAttr(seo.lang)}"`).replace(/<html(?![^>]*\slang=)([^>]*)>/i, `<html lang="${escapeHtmlAttr(seo.lang)}"$1>`);
  if (seo.favicon) {
    const tag = `<link rel="icon" type="${faviconType(seo.favicon)}" href="${escapeHtmlAttr(seo.favicon)}" />`;
    out = /<link\s+rel="icon"[^>]*>/i.test(out) ? out.replace(/<link\s+rel="icon"[^>]*>/i, tag) : out;
    if (!out.includes(tag)) out = insertBeforeHeadClose(out, tag);
  }
  if (seo.canonical) out = insertBeforeHeadClose(out, `<link rel="canonical" href="${escapeHtmlAttr(seo.canonical)}" />`);
  if (seo.markdownUrl) out = insertBeforeHeadClose(out, `<link rel="alternate" type="text/markdown" href="${escapeHtmlAttr(seo.markdownUrl)}" />`);
  if (seo.llmsUrl) out = insertBeforeHeadClose(out, `<link rel="alternate" type="text/plain" href="${escapeHtmlAttr(seo.llmsUrl)}" title="llms.txt" />`);
  if (seo.noindex) out = insertBeforeHeadClose(out, '<meta name="robots" content="noindex" />');
  return out;
}

function insertBeforeHeadClose(html: string, tag: string): string {
  const headClose = html.indexOf('</head>');
  return headClose === -1 ? html : `${html.slice(0, headClose)}  ${tag}\n  ${html.slice(headClose)}`;
}

/**
 * index.html with this instance's preview meta for the request at
 * `${requestOrigin}${pathname}`. For a published space (`site`) the title is
 * the space's name, and on the site's own host the `folio-public-site` meta
 * tag tells the SPA which space to mount; the canonical URL is the host the
 * visitor is actually on, not PUBLIC_URL.
 */
export function renderIndexHtml(html: string, requestOrigin: string, pathname: string, site?: PublicSiteMeta): string {
  const origin = publicUrlOrOrigin(requestOrigin);
  if (!site) return applyPageMeta(html, resolvePageMeta(origin), `${origin}${pathname}`);

  const base = resolvePageMeta(origin);
  const requestUrl = `${site.hostMode ? requestOrigin : origin}${pathname}`;
  let rendered: string | undefined;
  if (site.seo) {
    try {
      const seo = site.seo;
      const meta: PageMeta = {
        ...base,
        title: seo.title,
        description: seo.description,
        siteName: seo.siteName,
        ...(seo.image ? { image: seo.image, imageAlt: seo.title, imageSize: undefined } : {}),
      };
      rendered = applySeoExtras(applyPageMeta(html, meta, seo.canonical ?? requestUrl), seo);
    } catch {
      rendered = undefined; // never fail a page over its SEO head: the plain site shell below
    }
  }
  if (rendered === undefined) {
    const meta: PageMeta = { ...base, title: site.name, description: `${site.name} \u2014 published with Folio` };
    rendered = applyPageMeta(html, meta, requestUrl);
  }
  if (!site.hostMode) return rendered;
  return insertBeforeHeadClose(rendered, `<meta name="folio-public-site" content="${escapeHtmlAttr(site.slug)}" />`);
}
