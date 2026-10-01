import { describe, expect, it } from 'vitest';
import type { SpaceInfo } from '@shared/contracts';
import { canEditContent, canManageMembers, resolveSpaceRole, roleAtLeast } from './roles';

function space(slug: string, myRole?: SpaceInfo['myRole']): SpaceInfo {
  return { slug, name: slug, pageCount: 0, myRole };
}

describe('roleAtLeast', () => {
  it('treats undefined (no membership) as below every role', () => {
    expect(roleAtLeast(undefined, 'viewer')).toBe(false);
    expect(roleAtLeast(undefined, 'editor')).toBe(false);
    expect(roleAtLeast(undefined, 'admin')).toBe(false);
  });

  it('ranks admin > editor > viewer', () => {
    expect(roleAtLeast('admin', 'viewer')).toBe(true);
    expect(roleAtLeast('admin', 'editor')).toBe(true);
    expect(roleAtLeast('admin', 'admin')).toBe(true);

    expect(roleAtLeast('editor', 'viewer')).toBe(true);
    expect(roleAtLeast('editor', 'editor')).toBe(true);
    expect(roleAtLeast('editor', 'admin')).toBe(false);

    expect(roleAtLeast('viewer', 'viewer')).toBe(true);
    expect(roleAtLeast('viewer', 'editor')).toBe(false);
    expect(roleAtLeast('viewer', 'admin')).toBe(false);
  });
});

describe('canEditContent', () => {
  it('is false for viewer/undefined, true for editor and admin', () => {
    expect(canEditContent(undefined)).toBe(false);
    expect(canEditContent('viewer')).toBe(false);
    expect(canEditContent('editor')).toBe(true);
    expect(canEditContent('admin')).toBe(true);
  });
});

describe('canManageMembers', () => {
  it('is true only for admin', () => {
    expect(canManageMembers(undefined)).toBe(false);
    expect(canManageMembers('viewer')).toBe(false);
    expect(canManageMembers('editor')).toBe(false);
    expect(canManageMembers('admin')).toBe(true);
  });
});

describe('resolveSpaceRole', () => {
  it('prefers memberships[space] when both sources know the space', () => {
    // The actual prod bug scenario in reverse: a *stale* spaces list would
    // be the wrong thing to trust here, so memberships (once it does know
    // about the space) always wins.
    const memberships = { engineering: 'viewer' as const };
    const spaces = [space('engineering', 'admin')];
    expect(resolveSpaceRole(memberships, spaces, 'engineering')).toBe('viewer');
  });

  it('falls back to the spaces list myRole when memberships has no entry for the space', () => {
    // The actual bug: memberships hasn't caught up yet (no explicit
    // ['auth','state'] refetch since the space was created), but the
    // (fresher) spaces list already reports the role — must not read as
    // "not a member" / read-only.
    const memberships = {};
    const spaces = [space('brand-new-space', 'admin')];
    expect(resolveSpaceRole(memberships, spaces, 'brand-new-space')).toBe('admin');
  });

  it('returns undefined when neither source knows the space', () => {
    expect(resolveSpaceRole({}, [space('engineering', 'viewer')], 'unknown-space')).toBeUndefined();
  });

  it('returns undefined when space itself is undefined (no active space yet)', () => {
    expect(resolveSpaceRole({ engineering: 'admin' }, [space('engineering', 'admin')], undefined)).toBeUndefined();
  });

  it('falls back correctly even when the spaces list has not loaded yet', () => {
    expect(resolveSpaceRole({}, undefined, 'engineering')).toBeUndefined();
  });

  it('falls back to undefined when the spaces-list entry exists but has no myRole (unauthenticated-shaped response)', () => {
    expect(resolveSpaceRole({}, [space('engineering', undefined)], 'engineering')).toBeUndefined();
  });
});
