import { describe, expect, it } from 'vitest';
import type { AppearanceFileState, SpacePublicSettingsResponse } from '@shared/contracts';
import {
  adoptServerFiles,
  applySaved,
  changesFor,
  checkAssetFile,
  filesFromConflictBody,
  mergeServerFiles,
  parseSiteJson,
  repoFileUrl,
  robotsAndSitemapUrls,
  setDraft,
  siteSwitchOn,
  withSiteField,
  withSiteSwitch,
} from './appearanceLogic';
import { collapseUnchanged, diffLines } from './lineDiff';

const stored = (file: AppearanceFileState['file'], content: string, etag: string | null): AppearanceFileState => ({
  file,
  path: `.folio/${file}`,
  exists: etag !== null,
  etag,
  content,
  source: etag ? 'folio' : 'none',
  warnings: [],
});

describe('drafts and etags', () => {
  it('keeps the etag an edit started from when the server answers again, and sends it back', () => {
    let state = mergeServerFiles({}, [stored('site.css', 'a{}', 'e1')]);
    state = setDraft(state, 'site.css', 'a{color:red}', { content: 'a{}', etag: 'e1' });
    // A refetch while the draft is dirty must not move the base (that would hide a race from the server's etag check).
    state = mergeServerFiles(state, [stored('site.css', 'b{}', 'e2')]);
    expect(changesFor(state, ['site.css'])).toEqual([{ file: 'site.css', content: 'a{color:red}', etag: 'e1' }]);

    // Going back to the stored text is no change at all.
    expect(changesFor(setDraft(state, 'site.css', 'a{}', { content: 'a{}', etag: 'e1' }), ['site.css'])).toEqual([]);
  });

  it('quotes a null etag for a file that did not exist, and drops the draft only if nothing was typed since the save', () => {
    let state = setDraft({}, 'pdf-header.html', 'x', { content: '', etag: null });
    const sent = changesFor(state, ['pdf-header.html']);
    expect(sent[0].etag).toBeNull();

    state = setDraft(state, 'pdf-header.html', 'xy', { content: '', etag: null }); // typed while the request was in flight
    const after = applySaved(state, sent, [stored('pdf-header.html', 'x', 'e9')]);
    expect(after['pdf-header.html']?.draft).toBe('xy');

    const settled = applySaved(setDraft({}, 'pdf-header.html', 'x', { content: '', etag: null }), sent, [stored('pdf-header.html', 'x', 'e9')]);
    expect(settled['pdf-header.html']).toEqual({ base: { content: 'x', etag: 'e9' }, draft: null });
  });

  it('adopts the repository\'s files after a conflict and keeps only the drafts it is told to', () => {
    const state = setDraft(setDraft({}, 'site.css', 'mine', { content: 'a', etag: 'e1' }), 'site.json', 'mine', { content: '', etag: null });
    const next = adoptServerFiles(state, [stored('site.css', 'theirs', 'e2'), stored('site.json', 'theirs', 'e3')], ['site.json']);
    expect(next['site.css']).toEqual({ base: { content: 'theirs', etag: 'e2' }, draft: null });
    expect(next['site.json']).toEqual({ base: { content: 'theirs', etag: 'e3' }, draft: 'mine' });
  });

  it('reads the current files out of a 409 body, in either shape, and tolerates nothing', () => {
    const file = stored('site.css', 'x', 'e1');
    expect(filesFromConflictBody({ error: 'x', files: [file] })).toEqual([file]);
    expect(filesFromConflictBody({ error: 'x', current: { files: [file] } })).toEqual([file]);
    expect(filesFromConflictBody({ error: 'x' })).toEqual([]);
    expect(filesFromConflictBody(undefined)).toEqual([]);
  });
});

describe('site.json editing', () => {
  it('sets and clears one key, keeps the others, and writes no file at all when nothing is left', () => {
    const withTitle = withSiteField('', 'title', 'Acme');
    expect(JSON.parse(withTitle)).toEqual({ v: 1, title: 'Acme' });
    const more = withSiteField('{"v":1,"title":"Acme","x-hand":[1,2]}', 'tagline', 'Docs');
    expect(JSON.parse(more)).toEqual({ v: 1, title: 'Acme', 'x-hand': [1, 2], tagline: 'Docs' });
    expect(withSiteField(withTitle, 'title', '')).toBe('');
  });

  it('refuses to rewrite a file that is not valid JSON', () => {
    expect(parseSiteJson('{oops').ok).toBe(false);
    expect(parseSiteJson('[1]').ok).toBe(false);
    expect(withSiteField('{oops', 'title', 'x')).toBe('{oops');
  });
});

describe('assets and addresses', () => {
  it('turns a picked file into an asset name the contract accepts, or says why not', () => {
    expect(checkAssetFile({ name: 'My Logo (2).PNG', size: 100, type: 'image/png' })).toEqual({ ok: true, name: 'my-logo-2.png', type: 'image/png' });
    expect(checkAssetFile({ name: 'font.woff2', size: 100, type: '' })).toEqual({ ok: true, name: 'font.woff2', type: 'font/woff2' });
    expect(checkAssetFile({ name: 'notes.txt', size: 1, type: 'text/plain' })).toEqual({ ok: false, reason: 'name' });
    expect(checkAssetFile({ name: 'big.png', size: 2 * 1024 * 1024, type: 'image/png' })).toEqual({ ok: false, reason: 'size' });
  });

  it('builds repository links, robots.txt and the sitemap of a path-mode and of a host-mode site', () => {
    expect(repoFileUrl('https://github.com/a/b/blob/main/', 'docs/.folio/site.css')).toBe('https://github.com/a/b/blob/main/docs/.folio/site.css');
    expect(repoFileUrl(null, 'x')).toBeNull();

    const base: SpacePublicSettingsResponse = {
      visibility: 'public',
      settings: { subdomain: null, domain: null, allowDownload: false, allowAssistant: false, indexing: true, primaryHost: 'auto' },
      urls: { path: 'https://folio.example.com/public/docs', subdomain: null, domain: null },
      sitesDomain: null,
      mainHost: 'folio.example.com',
    };
    expect(robotsAndSitemapUrls(base)).toEqual({ robots: 'https://folio.example.com/robots.txt', sitemap: 'https://folio.example.com/public/docs/sitemap.xml', llms: 'https://folio.example.com/public/docs/llms.txt' });
    const onDomain = { ...base, urls: { ...base.urls, domain: 'https://docs.acme.com' } };
    expect(robotsAndSitemapUrls(onDomain)).toEqual({ robots: 'https://docs.acme.com/robots.txt', sitemap: 'https://docs.acme.com/sitemap.xml', llms: 'https://docs.acme.com/llms.txt' });
  });
});

describe('site.json switches', () => {
  it('are on unless the file says false: off writes false, on removes the key and keeps the rest', () => {
    expect(siteSwitchOn({}, 'llms')).toBe(true);
    const off = withSiteSwitch('{"v":1,"title":"Acme"}', 'llms', false);
    expect(JSON.parse(off)).toEqual({ v: 1, title: 'Acme', llms: false });
    expect(siteSwitchOn(JSON.parse(off), 'llms')).toBe(false);
    expect(withSiteSwitch(off, 'llms', true)).toBe(withSiteField('', 'title', 'Acme'));
    expect(withSiteSwitch('{oops', 'llms', false)).toBe('{oops');
  });
});

describe('line diff', () => {
  it('marks what the repository has and the draft lacks, and folds long unchanged runs', () => {
    const theirs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].join('\n');
    const mine = ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h', 'i'].join('\n');
    const rows = collapseUnchanged(diffLines(theirs, mine), 1);
    expect(rows.filter((r) => r.kind === 'del')).toEqual([{ kind: 'del', text: 'e' }]);
    expect(rows.filter((r) => r.kind === 'add')).toEqual([{ kind: 'add', text: 'E' }]);
    expect(rows.some((r) => r.kind === 'skip')).toBe(true);
  });
});
