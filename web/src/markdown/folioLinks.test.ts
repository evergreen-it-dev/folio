import { describe, expect, it } from 'vitest';
import { folioLinkKey, folioLinkNavPath, parseFolioLink } from './folioLinks';

const ORIGIN = 'https://folio.example.com';

describe('parseFolioLink', () => {
  it('detects an absolute page URL — exactly what "Copy link" produces', () => {
    expect(parseFolioLink(`${ORIGIN}/s/team-sales/p/01M320X0C31RCCZN6HYD6YQ7J0`, ORIGIN)).toEqual({
      space: 'team-sales',
      kind: 'page',
      id: '01M320X0C31RCCZN6HYD6YQ7J0',
    });
  });

  it('detects an absolute folder URL', () => {
    expect(parseFolioLink(`${ORIGIN}/s/team-sales/d/architecture/notes`, ORIGIN)).toEqual({
      space: 'team-sales',
      kind: 'dir',
      path: 'architecture/notes',
    });
  });

  it('detects an absolute bare-space (home) URL', () => {
    expect(parseFolioLink(`${ORIGIN}/s/team-sales`, ORIGIN)).toEqual({ space: 'team-sales', kind: 'space' });
  });

  it('detects the same three shapes root-relative, with no origin needed', () => {
    expect(parseFolioLink('/s/eng/p/abc', undefined)).toEqual({ space: 'eng', kind: 'page', id: 'abc' });
    expect(parseFolioLink('/s/eng/d/docs', undefined)).toEqual({ space: 'eng', kind: 'dir', path: 'docs' });
    expect(parseFolioLink('/s/eng', undefined)).toEqual({ space: 'eng', kind: 'space' });
  });

  it('leaves a foreign URL (any other origin) completely untouched', () => {
    expect(parseFolioLink('https://example.com/s/eng/p/abc', ORIGIN)).toBeNull();
    expect(parseFolioLink('https://evil.example/', ORIGIN)).toBeNull();
  });

  it('ignores an absolute URL when there is no origin to compare it against', () => {
    expect(parseFolioLink(`${ORIGIN}/s/eng/p/abc`, undefined)).toBeNull();
  });

  it('strips a trailing slash and a query/hash', () => {
    expect(parseFolioLink(`${ORIGIN}/s/eng/p/abc/`, ORIGIN)).toEqual({ space: 'eng', kind: 'page', id: 'abc' });
    expect(parseFolioLink(`${ORIGIN}/s/eng/p/abc?x=1#y`, ORIGIN)).toEqual({ space: 'eng', kind: 'page', id: 'abc' });
  });

  it('decodes percent-encoded space/id/path segments', () => {
    expect(parseFolioLink(`${ORIGIN}/s/my%20space/p/abc`, ORIGIN)).toEqual({ space: 'my space', kind: 'page', id: 'abc' });
  });

  it('is null for a plain external link, a relative link, and a bare anchor', () => {
    expect(parseFolioLink('https://example.com/', ORIGIN)).toBeNull();
    expect(parseFolioLink('../other.md', ORIGIN)).toBeNull();
    expect(parseFolioLink('#section', ORIGIN)).toBeNull();
  });

  it('is null for an app route this instance has but isn\'t a page link (e.g. /admin/access)', () => {
    expect(parseFolioLink(`${ORIGIN}/admin/access`, ORIGIN)).toBeNull();
    expect(parseFolioLink('/trash', undefined)).toBeNull();
  });
});

describe('folioLinkKey / folioLinkNavPath', () => {
  it('gives each kind a distinct, stable key', () => {
    expect(folioLinkKey({ space: 's', kind: 'page', id: 'a' })).toBe('page:s:a');
    expect(folioLinkKey({ space: 's', kind: 'dir', path: 'a/b' })).toBe('dir:s:a/b');
    expect(folioLinkKey({ space: 's', kind: 'space' })).toBe('space:s');
  });

  it('rebuilds the exact app route for each kind', () => {
    expect(folioLinkNavPath({ space: 's', kind: 'page', id: 'a' })).toBe('/s/s/p/a');
    expect(folioLinkNavPath({ space: 's', kind: 'dir', path: 'a/b' })).toBe('/s/s/d/a/b');
    expect(folioLinkNavPath({ space: 's', kind: 'space' })).toBe('/s/s');
  });
});
