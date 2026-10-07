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
 * description and url with the shared page's own.
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
    `<meta property="og:site_name" content="Folio" />`,
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

/** index.html with this instance's preview meta for the request at `${requestOrigin}${pathname}`. */
export function renderIndexHtml(html: string, requestOrigin: string, pathname: string): string {
  const origin = publicUrlOrOrigin(requestOrigin);
  return applyPageMeta(html, resolvePageMeta(origin), `${origin}${pathname}`);
}
