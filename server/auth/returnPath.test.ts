import { describe, expect, it } from 'vitest';
import { safeAppPath, withAuthError } from './returnPath.js';

describe('safeAppPath', () => {
  it('keeps a same-origin app path with its query and fragment', () => {
    expect(safeAppPath('/s/team/p/abc')).toBe('/s/team/p/abc');
    expect(safeAppPath('/s/team/p/abc?x=1&y=2#h')).toBe('/s/team/p/abc?x=1&y=2#h');
  });

  it.each([undefined, null, 42, '', 'p/abc', '//evil.com', '/\\evil.com', '/a\\b', 'https://evil.com', 'javascript:alert(1)', '/api', '/api/auth/state', '/x/../api/auth/state', '/login', '/', '/\tfoo', '/a\r\nb', `/${'a'.repeat(1100)}`])(
    'rejects %j',
    (bad) => {
      expect(safeAppPath(bad)).toBeNull();
    },
  );
});

describe('withAuthError', () => {
  it('adds authError to the page the person came from, before the fragment', () => {
    expect(withAuthError('/s/t/p/a', 'domain')).toBe('/s/t/p/a?authError=domain');
    expect(withAuthError('/s/t/p/a?x=1#h', 'domain')).toBe('/s/t/p/a?x=1&authError=domain#h');
  });

  it('falls back to the root without a usable returnTo', () => {
    expect(withAuthError(undefined, 'state')).toBe('/?authError=state');
    expect(withAuthError('//evil.com', 'state')).toBe('/?authError=state');
  });
});
