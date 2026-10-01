import { describe, expect, it } from 'vitest';
import type { Element, Root, Text } from 'hast';
import { rehypeFolioPageLinks } from './rehypeFolioLinks';
import type { FolioLinkRef } from './folioLinks';
import type { ResolvedFolioLink } from './folioLinkIndex';

const ORIGIN = 'https://folio.example.com';
const URL_STR = `${ORIGIN}/s/team-sales/p/01M320X0C31RCCZN6HYD6YQ7J0`;

function anchor(href: string): Element {
  return { type: 'element', tagName: 'a', properties: { href }, children: [{ type: 'text', value: href } as Text] };
}

function treeWith(el: Element): Root {
  return { type: 'root', children: [{ type: 'element', tagName: 'p', properties: {}, children: [el] }] };
}

describe('rehypeFolioPageLinks', () => {
  it('replaces the raw URL with the resolved title once it is cached', () => {
    const entry: ResolvedFolioLink = { title: 'Roadmap Q4', navPath: '/s/team-sales/p/01M320X0C31RCCZN6HYD6YQ7J0' };
    const el = anchor(URL_STR);
    const tree = treeWith(el);

    rehypeFolioPageLinks({ origin: ORIGIN, resolve: () => entry, hasFailed: () => false, ensureResolve: () => {} })(tree);

    expect(el.properties.href).toBe(entry.navPath);
    expect(el.properties.dataFolioNav).toBe(entry.navPath);
    expect((el.children[0] as Text).value).toBe('Roadmap Q4');
    expect((el.children[0] as Text).value).not.toContain('https://');
  });

  it('prefixes the icon when the resolved page has one', () => {
    const entry: ResolvedFolioLink = { title: 'Roadmap', icon: '🗺️', navPath: '/s/eng/p/x' };
    const el = anchor(`${ORIGIN}/s/eng/p/x`);
    rehypeFolioPageLinks({ origin: ORIGIN, resolve: () => entry, hasFailed: () => false, ensureResolve: () => {} })(
      treeWith(el),
    );
    expect((el.children[0] as Text).value).toBe('🗺️ Roadmap');
  });

  it('leaves an unresolved link exactly as authored, and kicks off resolution for it', () => {
    const el = anchor(URL_STR);
    const requested: FolioLinkRef[] = [];
    rehypeFolioPageLinks({
      origin: ORIGIN,
      resolve: () => undefined,
      hasFailed: () => false,
      ensureResolve: (ref) => requested.push(ref),
    })(treeWith(el));

    expect(el.properties.href).toBe(URL_STR);
    expect(el.properties.dataFolioNav).toBeUndefined();
    expect((el.children[0] as Text).value).toBe(URL_STR);
    expect(requested).toEqual([{ space: 'team-sales', kind: 'page', id: '01M320X0C31RCCZN6HYD6YQ7J0' }]);
  });

  it('does not re-request a ref that already failed (a page the reader cannot see, or a gone id)', () => {
    const el = anchor(URL_STR);
    let requested = false;
    rehypeFolioPageLinks({
      origin: ORIGIN,
      resolve: () => undefined,
      hasFailed: () => true,
      ensureResolve: () => {
        requested = true;
      },
    })(treeWith(el));

    expect(requested).toBe(false);
    expect(el.properties.href).toBe(URL_STR); // degrades to the plain URL, never an error
  });

  it('never touches a foreign link', () => {
    const el = anchor('https://example.com/whatever');
    let requested = false;
    rehypeFolioPageLinks({
      origin: ORIGIN,
      resolve: () => ({ title: 'should never be used', navPath: '/x' }),
      hasFailed: () => false,
      ensureResolve: () => {
        requested = true;
      },
    })(treeWith(el));

    expect(el.properties.href).toBe('https://example.com/whatever');
    expect(requested).toBe(false);
  });

  it('skips resolution entirely on a public share render (no session to resolve with)', () => {
    const el = anchor(URL_STR);
    let requested = false;
    rehypeFolioPageLinks({
      origin: ORIGIN,
      shareToken: 'tok123',
      resolve: () => undefined,
      hasFailed: () => false,
      ensureResolve: () => {
        requested = true;
      },
    })(treeWith(el));

    expect(requested).toBe(false);
    expect(el.properties.href).toBe(URL_STR);
  });
});
