import { describe, expect, it } from 'vitest';
import type { AccessMatrixResponse } from '@shared/contracts';
import {
  activeUserCount,
  chipsForUser,
  copyMembershipsPlan,
  hasNoExplicitAccess,
  matchesSpaceQuery,
  matchesUserQuery,
  matrixCellState,
  usersLosingAccessOnPrivate,
} from './logic';

describe('matrixCellState', () => {
  it('reports an explicit role when one exists, regardless of visibility', () => {
    expect(matrixCellState({ visibility: 'private' }, 'editor')).toEqual({ kind: 'explicit', role: 'editor' });
    expect(matrixCellState({ visibility: 'instance' }, 'admin')).toEqual({ kind: 'explicit', role: 'admin' });
  });

  it('reports implicit-viewer for an instance-visibility space with no explicit row', () => {
    expect(matrixCellState({ visibility: 'instance' }, undefined)).toEqual({ kind: 'implicit-viewer' });
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
