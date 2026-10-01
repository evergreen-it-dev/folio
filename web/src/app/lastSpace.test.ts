// @vitest-environment jsdom
/**
 * Round (page presence tail) — "I come back from settings and end up in
 * another space" (the owner, 11.09). /admin/access and /trash lead "back" to
 * `/`, and RootRedirect sent to spaces[0] regardless of where you came from.
 *
 * What is checked here is the memory carrier itself plus — the main thing —
 * the rule for choosing the target, which RootRedirect applies to the list
 * of spaces from the SERVER: the remembered slug is a navigation convenience,
 * not an access decision, so a space that is no longer in the response is
 * silently dropped.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readLastSpace, rememberLastSpace } from './lastSpace';

/** The same rule as in RootRedirect.tsx — kept tested separately from the React tree. */
function pickTarget(spaces: { slug: string }[], remembered: string | null): string {
  return remembered && spaces.some((space) => space.slug === remembered) ? remembered : spaces[0].slug;
}

afterEach(() => {
  localStorage.clear();
});

describe('lastSpace', () => {
  it('returns the stored slug, and null when nothing is stored', () => {
    expect(readLastSpace()).toBeNull();
    rememberLastSpace('fourth-space');
    expect(readLastSpace()).toBe('fourth-space');
  });

  it('an empty slug does not overwrite the previous one (Shell renders outside a space route too)', () => {
    rememberLastSpace('fourth-space');
    rememberLastSpace('');
    expect(readLastSpace()).toBe('fourth-space');
  });
});

describe('choosing the target for RootRedirect', () => {
  const spaces = [{ slug: 'alpha' }, { slug: 'beta' }, { slug: 'fourth-space' }];

  it('leads to where the user was, not to the first one in the list', () => {
    expect(pickTarget(spaces, 'fourth-space')).toBe('fourth-space');
  });

  it('without a memory it behaves as before', () => {
    expect(pickTarget(spaces, null)).toBe('alpha');
  });

  it('a space that is not in the server response (access taken away / renamed) is ignored', () => {
    expect(pickTarget(spaces, 'gone-space')).toBe('alpha');
  });
});
