/**
 * Public sites, agent files (03.11.2026): llms.txt, llms-full.txt and the `.md` copy of every page, plus the
 * <link rel="alternate"> in the head and the per-site switch. Real PG, real files, the real route registrations
 * through fastify inject. The visibility rule is the HTML site's own, so the tests prove a restricted page (and its
 * children) is nowhere: not in either file, and its `.md` is a 404.
 *
 * Fixture (acme: public, subdomain "acme"): index.md (home), guide.md (front matter), secret.md (restricted) with a
 * child under secret/, draft.md (`unlisted: true`), handbook/index.md + handbook/setup.md, onboarding/laptop.md (a folder
 * with no page of its own), perks.md + perks/card.md (a page that stands for its folder), rich.md (a messy body and
 * wikilinks to published, restricted and missing pages). `off` has
 * `"llms": false`, `closed` has indexing off, `priv` is private.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import * as pageAccess from './pageAccess.js';
import { renderIndexHtml } from './pageMeta.js';
import { cutAtSentence, firstParagraph, llmsDescription } from './llmsDescription.js';
import { registerPublicLlmsRoutes, LLMS_FULL_MAX_BYTES } from './publicLlms.js';
import { resolvePublicSiteHead } from './publicSiteMeta.js';
import { registerPublicSiteRoutes, updatePublicSettings } from './publicSiteRoutes.js';
import { invalidatePublicSiteCache } from './publicSites.js';
import * as storage from './storage.js';

const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Folio</title>
  </head>
  <body><div id="root"></div></body>
</html>
`;
const ORIGIN = 'https://folio.example.com';
const SITE_HOST = 'acme.sites.example.com';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  registerPublicSiteRoutes(app);
  registerPublicLlmsRoutes(app);
  await app.ready();
  return app;
}

describe('public sites — llms.txt and Markdown copies (real PG)', () => {
  const savedEnv = { url: process.env.PUBLIC_URL, sites: process.env.PUBLIC_SITES_DOMAIN, demo: process.env.FOLIO_DEMO_MODE };
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let admin: User;
  let acme: string;
  let off: string;
  let closed: string;
  let priv: string;
  let home: storage.PageIndexEntry;
  let guide: storage.PageIndexEntry;
  let secret: storage.PageIndexEntry;
  let secretChild: storage.PageIndexEntry;
  let draft: storage.PageIndexEntry;
  let setup: storage.PageIndexEntry;
  let rich: storage.PageIndexEntry;

  async function doc(space: string, title: string, body: string, opts: { parentPath?: string; fileStem?: string; frontMatter?: string } = {}): Promise<storage.PageIndexEntry> {
    const meta = await storage.createPage({ space, parentPath: opts.parentPath ?? '', title, kind: 'doc', ...(opts.fileStem ? { fileStem: opts.fileStem } : {}) });
    await storage.writeDocBody(meta.id, body);
    const entry = await storage.requireEntry(meta.id);
    if (opts.frontMatter) {
      const raw = await fs.readFile(entry.absPath, 'utf8');
      await fs.writeFile(entry.absPath, raw.replace(/^---\n/, `---\n${opts.frontMatter}`));
    }
    return storage.requireEntry(meta.id);
  }
  const get = (url: string, host = 'folio.example.com') => app.inject({ method: 'GET', url, headers: { host } });

  beforeAll(async () => {
    process.env.PUBLIC_URL = ORIGIN;
    process.env.PUBLIC_SITES_DOMAIN = 'sites.example.com';
    delete process.env.FOLIO_DEMO_MODE;
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    admin = await authStore.createUser({ email: `llms-admin-${stamp}@example.com`, name: 'Llms Admin', passwordHash: 'x', isAdmin: true });
    acme = (await storage.createSpace(`Acme ${stamp}`, admin.id)).slug;
    off = (await storage.createSpace(`Off ${stamp}`, admin.id)).slug;
    closed = (await storage.createSpace(`Closed ${stamp}`, admin.id)).slug;
    priv = (await storage.createSpace(`Priv ${stamp}`, admin.id)).slug;
    for (const space of [acme, off, closed, priv]) await authStore.setMembership(space, admin.id, 'admin');

    // createSpace seeds the home page (index.md); give it a title and a text.
    const seeded = await storage.resolve(acme, '');
    await storage.writeDocBody(seeded.id, '# Acme Home\n\nWelcome to the Acme handbook.\n');
    home = await storage.requireEntry(seeded.id);
    guide = await doc(acme, 'Guide', '# Guide\n\nRead the [home page](index.md), the [setup](handbook/setup.md) and the [secret](secret.md).\n\n![logo](img/logo.png)\n', {
      frontMatter: 'title: Guide Title\ndescription: "All about [zebrafish]\\nand friends"\n',
    });
    secret = await doc(acme, 'Secret', '# Secret\n\nThe launch code is zebrafish-42.\n');
    secretChild = await doc(acme, 'Secret Child', '# Secret Child\n\nInherited restriction.\n', { parentPath: 'secret' });
    draft = await doc(acme, 'Draft', '# Draft\n\nA draft.\n', { frontMatter: 'unlisted: true\n' });
    await doc(acme, 'Handbook', '# Handbook\n\nThe handbook section.\n', { parentPath: 'handbook', fileStem: 'index' });
    setup = await doc(acme, 'Setup', '# Setup\n\nInstall it.\n', { parentPath: 'handbook' });
    await doc(acme, 'Laptop setup', '# Laptop setup\n\nInstall the VPN client.\n', { parentPath: 'onboarding' });
    await doc(acme, 'Employee Perks', '# Employee Perks\n\nWhat the company pays for.\n', { fileStem: 'perks' });
    await doc(acme, 'Card', '# Card\n\nThe lunch card.\n', { parentPath: 'perks' });
    rich = await doc(
      acme,
      'Rich',
      [
        '# Rich',
        '',
        '## Contents',
        '',
        '- first item',
        '- second item',
        '',
        '<Callout type="info">',
        '',
        'Hidden JSX text.',
        '',
        '</Callout>',
        '',
        '```',
        'code sample',
        '```',
        '',
        'Start with [[Setup]], then the **[docs](handbook/setup.md)** and `code`. Second sentence of the paragraph.',
        'Same paragraph, next line.',
        '',
        '## Later',
        '',
        'Not this one.',
        '',
        'Links: [[Setup]], [[Setup|the setup guide]], [[Secret]], [[Secret|classified notes]], [[Nope]], [[Setup#Install|install step]], `[[Setup]]` and ![[diagram.png]].',
        '',
      ].join('\n'),
    );
    await pageAccess.setAccess(admin, secret, 'restricted', []);

    await fs.mkdir(path.join(storage.getSpaceDir(acme), '.folio'), { recursive: true });
    await fs.writeFile(path.join(storage.getSpaceDir(acme), '.folio', 'site.json'), JSON.stringify({ v: 1, title: 'Acme Docs', description: 'The Acme handbook.' }));
    await fs.mkdir(path.join(storage.getSpaceDir(off), '.folio'), { recursive: true });
    await fs.writeFile(path.join(storage.getSpaceDir(off), '.folio', 'site.json'), JSON.stringify({ v: 1, llms: false }));

    for (const space of [acme, off, closed]) await authStore.setSpaceVisibility(space, 'public');
    await updatePublicSettings(admin, acme, { subdomain: 'acme', domain: null, allowDownload: false, allowAssistant: false }, ORIGIN);
    await updatePublicSettings(admin, closed, { subdomain: null, domain: null, allowDownload: false, allowAssistant: false, indexing: false }, ORIGIN);
    invalidatePublicSiteCache();
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    for (const space of [acme, off, closed, priv]) await deleteTestSpace(space).catch(() => {});
    await teardownSchema();
    for (const [key, value] of [['PUBLIC_URL', savedEnv.url], ['PUBLIC_SITES_DOMAIN', savedEnv.sites], ['FOLIO_DEMO_MODE', savedEnv.demo]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('llms.txt follows the llmstxt.org shape: title, summary, sections of linked .md pages with descriptions', async () => {
    const res = await get('/llms.txt', SITE_HOST);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain; charset=utf-8/);
    const lines = res.body.split('\n');
    expect(lines[0]).toBe('# Acme Docs');
    expect(lines[2]).toBe('> The Acme handbook.');
    expect(res.body).toContain(`- [Acme Home](https://${SITE_HOST}/index.md): Welcome to the Acme handbook.`);
    expect(res.body).toContain(`- [Guide Title](https://${SITE_HOST}/p/${guide.id}.md): All about [zebrafish] and friends`);
    // The folder is a section named after its index page, else the page that stands for it, else the folder's name made readable.
    expect(res.body).toContain('## Onboarding\n\n- [Laptop setup]');
    expect(res.body).not.toContain('## onboarding');
    expect(res.body).toMatch(/## Employee Perks\n\n- \[Employee Perks\]\([^)]+\): What the company pays for\.\n- \[Card\]/);
    expect(res.body).not.toContain('## perks');
    expect(res.body.match(/\[Employee Perks\]/g)).toHaveLength(1); // it heads its section, it is not also under Pages
    const handbook = res.body.indexOf('## Handbook');
    expect(handbook).toBeGreaterThan(res.body.indexOf('## Pages'));
    expect(res.body.indexOf(`/p/${setup.id}.md`)).toBeGreaterThan(handbook);
    expect(res.body).toContain(`(https://${SITE_HOST}/llms-full.txt)`);
    // The same file under the main host's path form lists the same canonical URLs.
    const viaPath = await get(`/public/${acme}/llms.txt`);
    expect(viaPath.statusCode).toBe(200);
    expect(viaPath.body).toBe(res.body);
  });

  it('descriptions are one plain sentence or two: the first prose paragraph only, Markdown and wikilinks reduced to words', async () => {
    const res = await get('/llms.txt', SITE_HOST);
    expect(res.body).toContain(`- [Rich](https://${SITE_HOST}/p/${rich.id}.md): Start with Setup, then the docs and code. Second sentence of the paragraph. Same paragraph, next line.`);
    for (const line of res.body.split('\n').filter((l) => l.startsWith('- ['))) {
      const description = line.replace(/^- \[[^\]]*\]\([^)]*\):?\s?/, '');
      expect(description, line).not.toMatch(/\[\[|\]\]|\*\*|`|^#|Hidden JSX|first item|code sample/);
      expect(description.length, line).toBeLessThanOrEqual(160);
    }
  });

  it('a restricted page, its child and an unlisted page are not in llms.txt or llms-full.txt; the restricted .md is a 404', async () => {
    for (const url of [`/public/${acme}/llms.txt`, `/public/${acme}/llms-full.txt`]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toContain('zebrafish-42');
      expect(res.body, url).not.toContain('Inherited restriction');
      expect(res.body, url).not.toContain(secret.id);
      expect(res.body, url).not.toContain(secretChild.id);
      expect(res.body, url).not.toContain(draft.id);
      expect(res.body, url).toContain('Install it.');
    }
    for (const id of [secret.id, secretChild.id]) {
      expect((await get(`/p/${id}.md`, SITE_HOST)).statusCode).toBe(404);
      expect((await get(`/public/${acme}/p/${id}.md`)).statusCode).toBe(404);
    }
    // An unlisted page is only left out of the lists; by link it is as open as its HTML page.
    expect((await get(`/p/${draft.id}.md`, SITE_HOST)).statusCode).toBe(200);
  });

  it('llms-full.txt: every listed page under its title and URL, home first', async () => {
    const res = await get('/llms-full.txt', SITE_HOST);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-folio-llms-truncated']).toBeUndefined();
    expect(res.body).toContain(`# Guide Title\n\nURL: https://${SITE_HOST}/p/${guide.id}\n`);
    expect(res.body).toContain(`# Acme Home\n\nURL: https://${SITE_HOST}/\n\nWelcome to the Acme handbook.`);
    expect(res.body.indexOf('Welcome to the Acme handbook.')).toBeLessThan(res.body.indexOf('Install it.'));
  });

  it('a page .md is clean Markdown: no front matter, links to public pages point at their .md, others stay as written', async () => {
    const res = await get(`/p/${guide.id}.md`, SITE_HOST);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(res.body).not.toMatch(/^---/);
    expect(res.body).not.toContain('description:');
    expect(res.body).toContain(`[home page](https://${SITE_HOST}/index.md)`);
    expect(res.body).toContain(`[setup](https://${SITE_HOST}/p/${setup.id}.md)`);
    expect(res.body).toContain('[secret](secret.md)'); // not public: not rewritten to anything that names it
    expect(res.body).not.toContain(secret.id);
    expect(res.body).toContain(`![logo](https://${SITE_HOST}/files/${acme}/img/logo.png)`);

    // [[Wikilinks]] to published pages are Markdown links to their .md; unpublished or missing targets are plain text.
    const links = (await get(`/p/${rich.id}.md`, SITE_HOST)).body;
    expect(links).toContain(`Links: [Setup](https://${SITE_HOST}/p/${setup.id}.md), [the setup guide](https://${SITE_HOST}/p/${setup.id}.md), Secret, classified notes, Nope,`);
    expect(links).toContain(`[install step](https://${SITE_HOST}/p/${setup.id}.md)`);
    expect(links).toContain('`[[Setup]]`'); // code stays as written
    expect(links).not.toContain(secret.id);
    expect(links.replace(/`[^`]*`/g, '')).not.toMatch(/\[\[(Setup|Secret|Nope)/);
    const full = (await get('/llms-full.txt', SITE_HOST)).body;
    expect(full).toContain(`Links: [Setup](https://${SITE_HOST}/p/${setup.id}.md)`);
    expect(full).not.toContain(secret.id);

    const index = await get('/index.md', SITE_HOST);
    expect(index.body).toContain('Welcome to the Acme handbook.');
    expect((await get(`/p/${home.id}.md`, SITE_HOST)).body).toBe(index.body);
    expect((await get(`/public/${acme}/p/${guide.id}.md`)).body).toBe(res.body);
    expect((await get('/p/doc-000000000000000000000000.md', SITE_HOST)).statusCode).toBe(404);
  });

  it('the page head links to its Markdown copy and to llms.txt', async () => {
    const resolved = await resolvePublicSiteHead(SITE_HOST, `/p/${guide.id}`, `https://${SITE_HOST}`);
    const html = renderIndexHtml(SHELL, `https://${SITE_HOST}`, `/p/${guide.id}`, resolved?.site);
    expect(html).toContain(`<link rel="alternate" type="text/markdown" href="https://${SITE_HOST}/p/${guide.id}.md" />`);
    expect(html).toContain(`<link rel="alternate" type="text/plain" href="https://${SITE_HOST}/llms.txt" title="llms.txt" />`);
    const homeHead = await resolvePublicSiteHead(SITE_HOST, '/', `https://${SITE_HOST}`);
    expect(renderIndexHtml(SHELL, `https://${SITE_HOST}`, '/', homeHead?.site)).toContain(`href="https://${SITE_HOST}/index.md"`);
    // A 404 page advertises nothing.
    const missing = await resolvePublicSiteHead(SITE_HOST, `/p/${secret.id}`, `https://${SITE_HOST}`);
    expect(renderIndexHtml(SHELL, `https://${SITE_HOST}`, `/p/${secret.id}`, missing?.site)).not.toContain('text/markdown');
  });

  it('"llms": false in site.json, indexing off, a private space and the main host all answer 404, and the head says nothing', async () => {
    for (const url of [`/public/${off}/llms.txt`, `/public/${off}/llms-full.txt`, `/public/${off}/index.md`, `/public/${closed}/llms.txt`, `/public/${closed}/index.md`, `/public/${priv}/llms.txt`, '/llms.txt', '/llms-full.txt', '/index.md']) {
      expect((await get(url)).statusCode, url).toBe(404);
    }
    for (const slug of [off, closed]) {
      const resolved = await resolvePublicSiteHead('folio.example.com', `/public/${slug}`, ORIGIN);
      const html = renderIndexHtml(SHELL, ORIGIN, `/public/${slug}`, resolved?.site);
      expect(html, slug).not.toContain('text/markdown');
      expect(html, slug).not.toContain('llms.txt');
    }
  });

  it('llms-full.txt is capped by size and says so, up front and in a header', async () => {
    const chunk = `${'lorem ipsum dolor sit amet '.repeat(40)}\n\n`;
    const big = chunk.repeat(Math.ceil((LLMS_FULL_MAX_BYTES * 0.6) / chunk.length));
    await doc(acme, 'Big One', `# Big One\n\n${big}`);
    await doc(acme, 'Big Two', `# Big Two\n\n${big}`);
    await doc(acme, 'Big Three', `# Big Three\n\n${big}`);
    const res = await get('/llms-full.txt', SITE_HOST);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-folio-llms-truncated']).toBe('true');
    expect(res.body).toMatch(/<!-- Truncated: \d+ of \d+ pages are not included here\./);
    expect(Buffer.byteLength(res.body)).toBeLessThan(LLMS_FULL_MAX_BYTES + 64 * 1024);
    expect((await get('/llms.txt', SITE_HOST)).body).toContain('Big Three'); // the index still lists everything
  }, 60_000);
});

describe('llms.txt descriptions (pure)', () => {
  it('takes the first prose paragraph and skips headings, lists, tables, quotes, code, MDX and HTML blocks', () => {
    const body = [
      '---',
      'title: x',
      '---',
      '# Title',
      '',
      'import Chart from "./Chart";',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '> [!note] A callout',
      '',
      '- item one',
      '- item two',
      '',
      '<div>',
      'raw html',
      '</div>',
      '',
      '    indented code',
      '',
      '![](pic.png)',
      '',
      'The *real* text with a [link](a.md), a [[Wiki Page|label]] and [[folder/Other]].',
      '',
      'Second paragraph.',
    ].join('\n');
    expect(firstParagraph(body)).toBe('The real text with a link, a label and Other.');
  });

  it('does not glue a list to the paragraph above it', () => {
    expect(firstParagraph('Intro line:\n- one\n- two\n')).toBe('Intro line:');
  });

  it('prefers the front matter description, cuts at a sentence end within 160 characters, else at a word with an ellipsis', () => {
    expect(llmsDescription('Own **text**.', 'Body text.')).toBe('Own text.');
    const long = `${'Short sentence here. '.repeat(12)}Tail.`;
    const cut = llmsDescription(undefined, long);
    expect(cut.length).toBeLessThanOrEqual(160);
    expect(cut.endsWith('here.')).toBe(true);
    const noStops = cutAtSentence('word '.repeat(60).trim());
    expect(noStops.length).toBeLessThanOrEqual(160);
    expect(noStops.endsWith('…')).toBe(true);
    expect(llmsDescription(undefined, '# Only a heading\n\n- and a list\n')).toBe('');
  });
});
