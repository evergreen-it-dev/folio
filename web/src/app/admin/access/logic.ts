import { spaceOpenToInstance } from '@shared/contracts';
import type { AccessLogEntry, AccessMatrixResponse, AccessMatrixSpace, AccessMatrixUser, SpaceRole, SpaceVisibility } from '@shared/contracts';

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
  // 'public' gives every active user the same implicit viewer role 'instance' does (anonymous visitors on top of it).
  if (spaceOpenToInstance(space.visibility)) return { kind: 'implicit-viewer' };
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
// Space visibility: private / instance-wide / public (published as a website)
// ---------------------------------------------------------------------------

export const VISIBILITY_OPTIONS: readonly SpaceVisibility[] = ['private', 'instance', 'public'];

/** i18n key (app namespace) of the visibility's name — a missing value reads as the default, private. */
export function visibilityLabelKey(visibility: SpaceVisibility | undefined): string {
  return visibility === 'public' ? 'access.spaces.visibilityPublic' : visibility === 'instance' ? 'access.spaces.visibilityInstance' : 'access.spaces.visibilityPrivate';
}

/** i18n key of the action "make it <visibility>". */
export function makeVisibilityLabelKey(visibility: SpaceVisibility): string {
  return visibility === 'public' ? 'access.spaces.makePublic' : visibility === 'instance' ? 'access.spaces.makeInstance' : 'access.spaces.makePrivate';
}

/**
 * What clicking a space's visibility badge proposes: private <-> instance-wide, and a public space steps
 * back to private. Going PUBLIC is deliberately not one click on a badge — it is chosen from the actions
 * menu / the Publish dialog, where its consequences are spelled out.
 */
export function nextVisibilityOnToggle(visibility: SpaceVisibility | undefined): SpaceVisibility {
  return visibility === 'private' || visibility === undefined ? 'instance' : 'private';
}

/** Tailwind classes of the badge: grey private, blue instance-wide, green public. */
export function visibilityBadgeClass(visibility: SpaceVisibility | undefined): string {
  if (visibility === 'public') return 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300';
  if (visibility === 'instance') return 'bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300';
  return 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300';
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

// ---------------------------------------------------------------------------
// Access-change feed: the short detail shown after an entry's action label.
// audit_log.meta is free-form JSON, so every field is type-checked before use.
// ---------------------------------------------------------------------------

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * What follows the "<actor> · <action label>" part of a feed row: the role of a grant ("→ editor"), the
 * new visibility ("→ Public"), or the four publishing settings
 * ("(download: on, assistant: off, domain: docs.example.com)"). `null` when the entry carries nothing to show.
 */
export function accessLogDetail(entry: Pick<AccessLogEntry, 'action' | 'meta'>, t: Translate, options: { person?: boolean } = {}): string | null {
  const { meta } = entry;
  if (options.person && (entry.action === 'access.grant' || entry.action === 'access.revoke' || entry.action === 'access.self_grant')) {
    const person = typeof meta.targetUserName === 'string' && meta.targetUserName ? ` · ${meta.targetUserName}` : '';
    const role = entry.action !== 'access.revoke' && typeof meta.role === 'string' ? ` → ${meta.role}` : '';
    return person || role ? person + role : null;
  }
  if (entry.action === 'space.visibility') {
    const v = meta.visibility;
    return v === 'public' || v === 'instance' || v === 'private' ? ` → ${t(visibilityLabelKey(v))}` : null;
  }
  if (entry.action === 'space.public_settings') {
    const state = (on: boolean) => t(on ? 'access.log.settingOn' : 'access.log.settingOff');
    const parts: string[] = [];
    if (typeof meta.allowDownload === 'boolean') parts.push(t('access.log.settingDownload', { state: state(meta.allowDownload) }));
    if (typeof meta.allowAssistant === 'boolean') parts.push(t('access.log.settingAssistant', { state: state(meta.allowAssistant) }));
    if (typeof meta.subdomain === 'string' && meta.subdomain) parts.push(t('access.log.settingSubdomain', { value: meta.subdomain }));
    if (typeof meta.domain === 'string' && meta.domain) parts.push(t('access.log.settingDomain', { value: meta.domain }));
    return parts.length > 0 ? ` (${parts.join(', ')})` : null;
  }
  if (entry.action === 'access.group_grant' || entry.action === 'access.group_revoke') {
    const parts: string[] = [];
    if (typeof meta.groupName === 'string' && meta.groupName) parts.push(` · ${meta.groupName}`);
    if (entry.action === 'access.group_grant' && typeof meta.role === 'string') parts.push(` → ${meta.role}`);
    if (typeof meta.pageId === 'string' && meta.pageId) parts.push(` (${t('access.log.pageLevel')})`);
    return parts.length > 0 ? parts.join('') : null;
  }
  if (entry.action === 'group.member_add' || entry.action === 'group.member_remove') {
    return typeof meta.targetUserName === 'string' && meta.targetUserName ? ` · ${meta.targetUserName}` : null;
  }
  if (entry.action === 'group.manager_set') {
    if (typeof meta.targetUserName !== 'string' || !meta.targetUserName) return null;
    return ` · ${meta.targetUserName} (${t(meta.isManager === true ? 'access.log.managerOn' : 'access.log.managerOff')})`;
  }
  return typeof meta.role === 'string' ? ` → ${meta.role}` : null;
}

/** What a log row names as its subject: the group's name for `group.*` events (their `target` is a bare id), otherwise `target` (a space slug). */
export function accessLogTarget(entry: Pick<AccessLogEntry, 'action' | 'target' | 'meta'>): string {
  if (entry.action.startsWith('group.') && typeof entry.meta.groupName === 'string' && entry.meta.groupName) return entry.meta.groupName;
  return entry.target;
}
