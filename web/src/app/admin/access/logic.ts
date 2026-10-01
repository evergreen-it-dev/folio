import type { AccessMatrixResponse, AccessMatrixSpace, AccessMatrixUser, SpaceRole } from '@shared/contracts';

/**
 * Round 27 (access and rights) — pure, framework-free helpers backing the
 * Access page's three tabs (docs/spec-access.md §6). Kept separate from
 * the components so the matrix/visibility-loss/chip logic is unit-testable
 * without mounting React, react-query, or AuthProvider.
 */

// ---------------------------------------------------------------------------
// Matrix cell state (§6.2) — the grey "viewer (all)" cell is NOT a role from
// AccessMatrixResponse.roles (that map deliberately excludes it, see the
// type's own doc comment in shared/contracts.ts); it's derived here from the
// space's own visibility instead.
// ---------------------------------------------------------------------------

export type MatrixCellState =
  | { kind: 'none' }
  | { kind: 'explicit'; role: SpaceRole }
  | { kind: 'implicit-viewer' };

/** `explicitRole` is `roles[userId]?.[space.slug]` — undefined when there's no row in space_members. */
export function matrixCellState(space: Pick<AccessMatrixSpace, 'visibility'>, explicitRole: SpaceRole | undefined): MatrixCellState {
  if (explicitRole) return { kind: 'explicit', role: explicitRole };
  if (space.visibility === 'instance') return { kind: 'implicit-viewer' };
  return { kind: 'none' };
}

// ---------------------------------------------------------------------------
// The "Spaces" chips column (§6.1) — up to `max` explicit space:role pairs,
// then an overflow count. Explicit memberships only, same reasoning as the
// matrix cell above (implicit instance-viewer access isn't a per-user grant
// to list here — it belongs to the space, not the person).
// ---------------------------------------------------------------------------

export interface AccessChip {
  space: string;
  role: SpaceRole;
}

export interface ChipSummary {
  shown: AccessChip[];
  overflowCount: number;
}

export function chipsForUser(roles: Record<string, SpaceRole> | undefined, max = 3): ChipSummary {
  const entries = Object.entries(roles ?? {}).map(([space, role]) => ({ space, role }));
  entries.sort((a, b) => a.space.localeCompare(b.space));
  return { shown: entries.slice(0, max), overflowCount: Math.max(0, entries.length - max) };
}

/** §6.1's "no access" filter: zero explicit memberships. Implicit instance-visibility access deliberately doesn't count — that's the space being open, not this person having been granted anything. */
export function hasNoExplicitAccess(roles: Record<string, SpaceRole> | undefined): boolean {
  return Object.keys(roles ?? {}).length === 0;
}

// ---------------------------------------------------------------------------
// §3 visibility-change confirmations
// ---------------------------------------------------------------------------

/** private -> instance confirmation needs "N users of the instance" — every active user, since disabled users get nothing per spec §5. */
export function activeUserCount(users: AccessMatrixUser[]): number {
  return users.filter((u) => !u.disabled).length;
}

/** instance -> private confirmation needs WHO loses access: active users with no explicit row for this space (their read access today is purely the implicit grant this change removes). Instance admins are included — the honest framing (spec §2) is that they keep the ability to grant themselves access back, not that they're silently exempt from losing it. */
export function usersLosingAccessOnPrivate(matrix: Pick<AccessMatrixResponse, 'users' | 'roles'>, space: string): AccessMatrixUser[] {
  return matrix.users.filter((u) => !u.disabled && !matrix.roles[u.id]?.[space]);
}

// ---------------------------------------------------------------------------
// Search (both axes of the matrix, §6.2; also §6.1's people search)
// ---------------------------------------------------------------------------

export function matchesUserQuery(user: Pick<AccessMatrixUser, 'name' | 'email'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return user.name.toLowerCase().includes(q) || user.email.toLowerCase().includes(q);
}

export function matchesSpaceQuery(space: Pick<AccessMatrixSpace, 'name' | 'slug'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return space.name.toLowerCase().includes(q) || space.slug.toLowerCase().includes(q);
}

// ---------------------------------------------------------------------------
// §6.2 "add all members of another space" — no dedicated endpoint (spec
// §6.2/report), composed client-side from the matrix + POST /api/access/bulk:
// every explicit membership of `sourceSpace` becomes a bulk change row for
// `targetSpace`, at the same role, skipping anyone who already has an equal-
// or-higher role there (never downgrades an existing admin to editor just
// because the source space had them as editor).
// ---------------------------------------------------------------------------

const ROLE_RANK: Record<SpaceRole, number> = { viewer: 0, editor: 1, admin: 2 };

export function copyMembershipsPlan(
  matrix: Pick<AccessMatrixResponse, 'roles'>,
  sourceSpace: string,
  targetSpace: string,
): { userId: string; space: string; role: SpaceRole }[] {
  const plan: { userId: string; space: string; role: SpaceRole }[] = [];
  for (const [userId, spaces] of Object.entries(matrix.roles)) {
    const sourceRole = spaces[sourceSpace];
    if (!sourceRole) continue;
    const targetRole = spaces[targetSpace];
    if (targetRole && ROLE_RANK[targetRole] >= ROLE_RANK[sourceRole]) continue;
    plan.push({ userId, space: targetSpace, role: sourceRole });
  }
  return plan;
}
