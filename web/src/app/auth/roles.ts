import type { SpaceInfo, SpaceRole } from '@shared/contracts';
import { t } from '../i18n/register';
import '../i18n/register';

/** Live lookup (round 10) — shared by MembersDialog and InviteDialog's role pickers/labels. */
export function roleLabel(role: SpaceRole): string {
  return t(`roles.${role}`);
}

/**
 * Pure role-gating logic. `role` is `undefined` for "no membership at all"
 * (not a member of the space, and not an instance admin) — always the
 * least-privileged case, same as viewer would be but explicitly distinct
 * since a non-member shouldn't see the space at all (the server already
 * filters it out of every list; this is defense in depth on the client).
 */
const ROLE_RANK: Record<SpaceRole, number> = { viewer: 0, editor: 1, admin: 2 };

/** True when `role` is at least as privileged as `min` (admin > editor > viewer). */
export function roleAtLeast(role: SpaceRole | undefined, min: SpaceRole): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Can create/rename/move/delete pages and boards, and edit their content. */
export function canEditContent(role: SpaceRole | undefined): boolean {
  return roleAtLeast(role, 'editor');
}

/** Can manage space membership (add/remove members, change roles). */
export function canManageMembers(role: SpaceRole | undefined): boolean {
  return roleAtLeast(role, 'admin');
}

/**
 * Round 7 (prod bug fix): resolves a space role from two sources —
 * AuthProvider's `memberships` map (fetched once at login/setup, refreshed
 * on explicit invalidation) and the `['spaces']` list's own per-space
 * `SpaceInfo.myRole` (refetched far more often — SpaceSwitcher, Sidebar,
 * Breadcrumbs, MembersDialog all query it, and creating a space or being
 * added as a member both naturally invalidate `['spaces']` as part of that
 * same action). `memberships[space]` wins when both know about the space
 * (it's the more specific, purpose-built source); `spaces`' own `myRole` is
 * the fallback specifically for a space `memberships` hasn't caught up to
 * yet — most commonly a space *just* created or joined in this session,
 * before an explicit `['auth','state']` invalidation/refetch lands. This
 * means a stale `memberships` map can produce a false "not a member"
 * (`undefined`) for a space it hasn't heard of, but it can never produce a
 * false *read-only* for a space the fresher spaces list already knows about
 * — which is the actual bug this fixes (editor stuck on "Read-only"
 * after creating a space, until a full reload).
 */
export function resolveSpaceRole(
  memberships: Record<string, SpaceRole>,
  spaces: readonly SpaceInfo[] | undefined,
  space: string | undefined,
): SpaceRole | undefined {
  if (!space) return undefined;
  return memberships[space] ?? spaces?.find((s) => s.slug === space)?.myRole;
}
