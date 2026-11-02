import { describe, expect, it } from 'vitest';
import type { AccessMatrixResponse } from '@shared/contracts';
import {
  accessLogDetail,
  activeUserCount,
  chipsForUser,
  copyMembershipsPlan,
  hasNoExplicitAccess,
  matchesSpaceQuery,
  matchesUserQuery,
  makeVisibilityLabelKey,
  matrixCellState,
  nextVisibilityOnToggle,
  usersLosingAccessOnPrivate,
  visibilityBadgeClass,
  visibilityLabelKey,
} from './logic';

describe('matrixCellState', () => {
  it('reports an explicit role when one exists, regardless of visibility', () => {
    expect(matrixCellState({ visibility: 'private' }, 'editor')).toEqual({ kind: 'explicit', role: 'editor' });
    expect(matrixCellState({ visibility: 'instance' }, 'admin')).toEqual({ kind: 'explicit', role: 'admin' });
  });

  it('reports implicit-viewer for an instance-visibility space with no explicit row', () => {
    expect(matrixCellState({ visibility: 'instance' }, undefined)).toEqual({ kind: 'implicit-viewer' });
  });

  it('a public space gives the same grey implicit-viewer cell: every active user reads it as a viewer', () => {
    expect(matrixCellState({ visibility: 'public' }, undefined)).toEqual({ kind: 'implicit-viewer' });
    expect(matrixCellState({ visibility: 'public' }, 'editor')).toEqual({ kind: 'explicit', role: 'editor' });
  });

  it('reports none for a private space with no explicit row', () => {
    expect(matrixCellState({ visibility: 'private' }, undefined)).toEqual({ kind: 'none' });
  });
});

describe('chipsForUser', () => {
  it('sorts by space name and caps at max, reporting the overflow', () => {
    const roles = { zeta: 'viewer', alpha: 'editor', beta: 'admin', gamma: 'viewer' } as const;
    const { shown, overflowCount } = chipsForUser(roles, 3);
    expect(shown).toEqual([
      { space: 'alpha', role: 'editor' },
      { space: 'beta', role: 'admin' },
      { space: 'gamma', role: 'viewer' },
    ]);
    expect(overflowCount).toBe(1);
  });

  it('handles undefined/empty roles', () => {
    expect(chipsForUser(undefined)).toEqual({ shown: [], overflowCount: 0 });
    expect(chipsForUser({})).toEqual({ shown: [], overflowCount: 0 });
  });
});

describe('hasNoExplicitAccess', () => {
  it('true only for zero explicit memberships', () => {
    expect(hasNoExplicitAccess(undefined)).toBe(true);
    expect(hasNoExplicitAccess({})).toBe(true);
    expect(hasNoExplicitAccess({ eng: 'viewer' })).toBe(false);
  });
});

describe('activeUserCount / usersLosingAccessOnPrivate', () => {
  const matrix: Pick<AccessMatrixResponse, 'users' | 'roles'> = {
    users: [
      { id: 'u1', name: 'A', email: 'a@t', isAdmin: true, disabled: false },
      { id: 'u2', name: 'B', email: 'b@t', isAdmin: false, disabled: false },
      { id: 'u3', name: 'C', email: 'c@t', isAdmin: false, disabled: true },
    ],
    roles: { u2: { eng: 'editor' } },
  };

  it('counts only active users', () => {
    expect(activeUserCount(matrix.users)).toBe(2);
  });

  it('lists active users with no explicit row in the target space as losing access', () => {
    const losing = usersLosingAccessOnPrivate(matrix, 'eng');
    expect(losing.map((u) => u.id)).toEqual(['u1']);
  });

  it('excludes disabled users (they never had access to lose)', () => {
    const losing = usersLosingAccessOnPrivate(matrix, 'nowhere');
    expect(losing.map((u) => u.id).sort()).toEqual(['u1', 'u2']);
  });
});

describe('matchesUserQuery / matchesSpaceQuery', () => {
  it('matches name or email, case-insensitively; empty query matches everything', () => {
    const user = { name: 'Maria Ivanenko', email: 'maria@example.com' };
    expect(matchesUserQuery(user, '')).toBe(true);
    expect(matchesUserQuery(user, 'MARIA')).toBe(true);
    expect(matchesUserQuery(user, 'example.com')).toBe(true);
    expect(matchesUserQuery(user, 'nope')).toBe(false);
  });

  it('matches space name or slug', () => {
    const space = { name: 'Engineering', slug: 'eng' };
    expect(matchesSpaceQuery(space, 'engineer')).toBe(true);
    expect(matchesSpaceQuery(space, 'eng')).toBe(true);
    expect(matchesSpaceQuery(space, 'sales')).toBe(false);
  });
});

describe('copyMembershipsPlan', () => {
  it('copies every explicit membership from source to target', () => {
    const matrix: Pick<AccessMatrixResponse, 'roles'> = {
      roles: { u1: { source: 'editor' }, u2: { source: 'viewer' } },
    };
    const plan = copyMembershipsPlan(matrix, 'source', 'target');
    expect(plan).toEqual(
      expect.arrayContaining([
        { userId: 'u1', space: 'target', role: 'editor' },
        { userId: 'u2', space: 'target', role: 'viewer' },
      ]),
    );
    expect(plan).toHaveLength(2);
  });

  it('skips a user who already has an equal-or-higher role in the target space', () => {
    const matrix: Pick<AccessMatrixResponse, 'roles'> = {
      roles: { u1: { source: 'viewer', target: 'admin' }, u2: { source: 'editor', target: 'viewer' } },
    };
    const plan = copyMembershipsPlan(matrix, 'source', 'target');
    // u1 already has admin (>= viewer) in target -> skipped
    // u2 has only viewer in target, source grants editor (higher) -> included
    expect(plan).toEqual([{ userId: 'u2', space: 'target', role: 'editor' }]);
  });

  it('ignores a user with no membership in the source space', () => {
    const matrix: Pick<AccessMatrixResponse, 'roles'> = { roles: { u1: { other: 'admin' } } };
    expect(copyMembershipsPlan(matrix, 'source', 'target')).toEqual([]);
  });
});

describe('space visibility helpers', () => {
  it('names each visibility and the action that sets it', () => {
    expect(visibilityLabelKey('private')).toBe('access.spaces.visibilityPrivate');
    expect(visibilityLabelKey('instance')).toBe('access.spaces.visibilityInstance');
    expect(visibilityLabelKey('public')).toBe('access.spaces.visibilityPublic');
    expect(visibilityLabelKey(undefined)).toBe('access.spaces.visibilityPrivate');
    expect(makeVisibilityLabelKey('public')).toBe('access.spaces.makePublic');
    expect(makeVisibilityLabelKey('instance')).toBe('access.spaces.makeInstance');
    expect(makeVisibilityLabelKey('private')).toBe('access.spaces.makePrivate');
  });

  it('a badge click toggles private <-> instance-wide and steps a public space back to private; going public is never one click', () => {
    expect(nextVisibilityOnToggle('private')).toBe('instance');
    expect(nextVisibilityOnToggle(undefined)).toBe('instance');
    expect(nextVisibilityOnToggle('instance')).toBe('private');
    expect(nextVisibilityOnToggle('public')).toBe('private');
  });

  it('colours public apart from private and instance-wide', () => {
    const classes = new Set([visibilityBadgeClass('private'), visibilityBadgeClass('instance'), visibilityBadgeClass('public')]);
    expect(classes.size).toBe(3);
  });
});

describe('accessLogDetail', () => {
  // a stand-in translator: returns the key plus its interpolation values, so the test pins down which keys are used
  const t = (key: string, options?: Record<string, unknown>) => (options ? `${key}(${Object.values(options).join(',')})` : key);

  it('shows the role of a grant and nothing for an entry without one', () => {
    expect(accessLogDetail({ action: 'access.grant', meta: { role: 'editor', targetUserId: 'u1' } }, t)).toBe(' → editor');
    expect(accessLogDetail({ action: 'access.revoke', meta: { targetUserId: 'u1' } }, t)).toBeNull();
  });

  it('names the person in a space log, and only there', () => {
    const grant = { action: 'access.grant' as const, meta: { role: 'editor', targetUserId: 'u1', targetUserName: 'Jane Doe' } };
    expect(accessLogDetail(grant, t, { person: true })).toBe(' · Jane Doe → editor');
    expect(accessLogDetail(grant, t)).toBe(' → editor');
    expect(accessLogDetail({ action: 'access.revoke', meta: { targetUserId: 'u1', targetUserName: 'Jane Doe', previousRole: 'viewer' } }, t, { person: true })).toBe(' · Jane Doe');
    expect(accessLogDetail({ action: 'access.self_grant', meta: { role: 'admin', targetUserId: 'u1', targetUserName: 'Jane Doe' } }, t, { person: true })).toBe(' · Jane Doe → admin');
    expect(accessLogDetail({ action: 'access.grant', meta: { role: 'viewer', targetUserId: 'u1' } }, t, { person: true })).toBe(' → viewer');
    expect(accessLogDetail({ action: 'access.revoke', meta: { targetUserId: 'u1' } }, t, { person: true })).toBeNull();
  });

  it('names the new visibility, public included, and ignores an unknown value', () => {
    expect(accessLogDetail({ action: 'space.visibility', meta: { visibility: 'public' } }, t)).toBe(' → access.spaces.visibilityPublic');
    expect(accessLogDetail({ action: 'space.visibility', meta: { visibility: 'instance' } }, t)).toBe(' → access.spaces.visibilityInstance');
    expect(accessLogDetail({ action: 'space.visibility', meta: { visibility: 'private' } }, t)).toBe(' → access.spaces.visibilityPrivate');
    expect(accessLogDetail({ action: 'space.visibility', meta: { visibility: 'bogus' } }, t)).toBeNull();
    expect(accessLogDetail({ action: 'space.visibility', meta: {} }, t)).toBeNull();
  });

  it('summarises the four publishing settings and skips the empty host fields', () => {
    expect(
      accessLogDetail({ action: 'space.public_settings', meta: { subdomain: null, domain: 'docs.example.com', allowDownload: true, allowAssistant: false } }, t),
    ).toBe(' (access.log.settingDownload(access.log.settingOn), access.log.settingAssistant(access.log.settingOff), access.log.settingDomain(docs.example.com))');
    expect(accessLogDetail({ action: 'space.public_settings', meta: { subdomain: 'docs', domain: null, allowDownload: false, allowAssistant: true } }, t)).toBe(
      ' (access.log.settingDownload(access.log.settingOff), access.log.settingAssistant(access.log.settingOn), access.log.settingSubdomain(docs))',
    );
    expect(accessLogDetail({ action: 'space.public_settings', meta: {} }, t)).toBeNull();
  });
});
