import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_OG_DESCRIPTION,
  DEFAULT_OG_TITLE,
  DEMO_OG_DESCRIPTION,
  DEMO_OG_TITLE,
  renderIndexHtml,
} from './pageMeta.js';

const BUILT_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="description" content="old" />
    <meta property="og:title" content="old" />
    <meta name="twitter:card" content="summary" />
    <meta name="theme-color" content="#ffffff" />
    <title>Folio</title>
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>
`;

const ENV_KEYS = ['FOLIO_DEMO_MODE', 'FOLIO_OG_TITLE', 'FOLIO_OG_DESCRIPTION', 'FOLIO_OG_IMAGE', 'PUBLIC_URL'] as const;

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe('pageMeta.ts — link-preview meta in index.html', () => {
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it('a plain instance gets the neutral product defaults and the generic image, with every preview tag exactly once', () => {
    const html = renderIndexHtml(BUILT_INDEX, 'https://wiki.example.com', '/');
    expect(html).toContain(`<title>${DEFAULT_OG_TITLE}</title>`);
    expect(html).toContain(`<meta property="og:title" content="${DEFAULT_OG_TITLE}" />`);
    expect(html).toContain(`<meta name="description" content="${DEFAULT_OG_DESCRIPTION}" />`);
    expect(html).toContain('<meta property="og:image" content="https://wiki.example.com/og/og-folio.png" />');
    expect(html).toContain('<meta property="og:image:width" content="1200" />');
    expect(html).toContain('<meta property="og:image:height" content="630" />');
    expect(html).toContain('<meta property="og:url" content="https://wiki.example.com/" />');
    expect(html).toContain('<meta property="og:type" content="website" />');
    expect(html).toContain('<meta property="og:site_name" content="Folio" />');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).toContain('<meta name="twitter:image" content="https://wiki.example.com/og/og-folio.png" />');
    expect(html).not.toContain('content="old"');
    for (const tag of ['og:title', 'og:image"', 'twitter:card', 'name="description"', '<title>']) expect(count(html, tag), tag).toBe(1);
    // the rest of the head is untouched
    expect(html).toContain('<script type="module" crossorigin src="/assets/index-abc.js"></script>');
  });

  it('demo mode switches to the demo text and image; PUBLIC_URL wins over the request origin', () => {
    process.env.FOLIO_DEMO_MODE = '1';
    process.env.PUBLIC_URL = 'demo.foliowiki.online';
    const html = renderIndexHtml(BUILT_INDEX, 'http://internal:4870', '/');
    expect(html).toContain(`<meta property="og:title" content="${DEMO_OG_TITLE}" />`);
    expect(html).toContain(`<meta property="og:description" content="${DEMO_OG_DESCRIPTION}" />`);
    expect(html).toContain('<meta property="og:image" content="https://demo.foliowiki.online/og/og-demo.png" />');
    expect(html).not.toContain(DEFAULT_OG_TITLE);
  });

  it('FOLIO_OG_* override the text and image, and the values are HTML-escaped', () => {
    process.env.FOLIO_OG_TITLE = 'Acme "Wiki" <b>';
    process.env.FOLIO_OG_DESCRIPTION = "Tom & Jerry's <script>alert(1)</script>";
    process.env.FOLIO_OG_IMAGE = 'https://cdn.example.com/card.png?a=1&b="2"';
    const html = renderIndexHtml(BUILT_INDEX, 'https://wiki.example.com', '/login');
    expect(html).toContain('<meta property="og:title" content="Acme &quot;Wiki&quot; &lt;b&gt;" />');
    expect(html).toContain('content="Tom &amp; Jerry&#39;s &lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(html).toContain('<meta property="og:image" content="https://cdn.example.com/card.png?a=1&amp;b=&quot;2&quot;" />');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('og:image:width'); // size of a custom image is unknown
    expect(html).toContain('<meta property="og:url" content="https://wiki.example.com/login" />');
  });

  it('HTML without a </head> is returned unchanged', () => {
    expect(renderIndexHtml('<p>hi</p>', 'https://x.test', '/')).toBe('<p>hi</p>');
  });
});
