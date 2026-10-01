import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as authStore from './auth/store.js';
import * as shares from './shares.js';
import { renderShareIndexHtml } from './shareMeta.js';

/**
 * OWNER ASK 22.09.2026 (SEO extension screenshots): per-page Open Graph meta
 * for share links, injected server-side into the SPA's index.html — see
 * server/index.ts's setNotFoundHandler and server/shareMeta.ts. Kept to
 * exactly three tests per the owner's "a minimum of tests" rule: a happy path,
 * the escaping case that matters most (this is user content landing in an
 * HTML attribute), and the fail-safe for a bad token.
 */
const STUB_INDEX_HTML = `<!doctype html>
<html lang="uk">
  <head>
    <meta charset="utf-8" />
    <meta name="description" content="Folio — a git-native wiki." />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Folio" />
    <meta property="og:title" content="Folio" />
    <meta property="og:description" content="Folio — a git-native wiki." />
    <meta name="twitter:card" content="summary" />
    <title>Folio</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

describe('shareMeta.ts — per-share-link Open Graph injection (real PG)', () => {
  let teardownSchema: () => Promise<void>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  it('a valid share token yields the page\'s title/description in the injected meta', async () => {
    const user = await authStore.createUser({ email: 'meta-happy@share-test.local', name: 'Meta', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Share Meta Happy ${Date.now()}`, user.id);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Q3 Roadmap', kind: 'doc' });
    await storage.writeDocBody(page.id, '# Q3 Roadmap\n\nWe are shipping **per-page previews** for share links this quarter, see [the plan](https://example.com).');

    const link = await shares.createShareLink(page.id, user.id, 'view', 'http://fallback.test');
    const token = link.url.split('/share/')[1];

    const html = await renderShareIndexHtml(STUB_INDEX_HTML, `/share/${token}`, `http://fallback.test/share/${token}`);

    expect(html).toContain('<title>Q3 Roadmap · Folio</title>');
    expect(html).toContain('<meta property="og:title" content="Q3 Roadmap" />');
    expect(html).toContain('We are shipping per-page previews for share links this quarter, see the plan.');
    expect(html).toContain(`<meta property="og:url" content="http://fallback.test/share/${token}" />`);
    expect(html).toContain('<meta name="twitter:card" content="summary" />');

    await deleteTestSpace(space.slug);
  });

  it('a title containing "><script> is escaped and cannot break out of the attribute', async () => {
    const user = await authStore.createUser({ email: 'meta-xss@share-test.local', name: 'Meta XSS', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Share Meta XSS ${Date.now()}`, user.id);
    const evilTitle = `"><script>alert(1)</script>`;
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: evilTitle, kind: 'doc' });
    // storage's own title derivation reads the doc's H1 (extractH1) and falls
    // back to a filename-derived slug when there isn't one — the H1 must
    // carry the raw evil title through unslugified for this test to exercise
    // what it says it does.
    await storage.writeDocBody(page.id, `# ${evilTitle}\n\nharmless body text`);

    const link = await shares.createShareLink(page.id, user.id, 'view', 'http://fallback.test');
    const token = link.url.split('/share/')[1];

    const html = await renderShareIndexHtml(STUB_INDEX_HTML, `/share/${token}`, `http://fallback.test/share/${token}`);

    // The raw payload must never appear verbatim — that would break out of
    // the attribute (or the <title> text node) and inject a live <script>.
    expect(html).not.toContain(`"><script>alert(1)</script>`);
    expect(html).not.toContain('<script>alert(1)</script>');
    // The escaped form must be present, inside the og:title attribute...
    expect(html).toContain('<meta property="og:title" content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;" />');
    // ...and inside <title>, where a raw `<` would have closed the tag early.
    expect(html).toContain('<title>&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; · Folio</title>');

    await deleteTestSpace(space.slug);
  });

  it('an unknown token serves the unmodified index.html', async () => {
    const html = await renderShareIndexHtml(STUB_INDEX_HTML, '/share/not-a-real-token', 'http://fallback.test/share/not-a-real-token');
    expect(html).toBe(STUB_INDEX_HTML);
  });
});
