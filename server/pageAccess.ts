import type { PageAccessGrantRole, PageAccessInfo, SpaceRole, User } from '../shared/contracts.js';
import type { PageIndexEntry } from './storage.js';
import { query, queryOne, withTransaction } from './db/pool.js';
import * as authStore from './auth/store.js';
import { badRequest } from './errors.js';
import { isAgentPath } from './agentPath.js';

interface AccessRow {
  owner_id: string;
  grant_role: PageAccessGrantRole | null;
}

export async function effectivePageRole(user: User, entry: PageIndexEntry, spaceRole: SpaceRole | undefined): Promise<SpaceRole | undefined> {
  if (!spaceRole || user.disabled) return undefined;
  const access = await queryOne<AccessRow>(
    `SELECT a.owner_id, g.role AS grant_role
       FROM page_access a
       LEFT JOIN page_access_grants g ON g.page_id = a.page_id AND g.user_id = $2
      WHERE a.page_id = $1`,
    [entry.id, user.id],
  );
  if (!access) return spaceRole;
  if (access.owner_id === user.id) return 'editor';
  return access.grant_role ?? undefined;
}

/**
 * IDs that may be exposed through tree/search/subtree surfaces.
 * `includeAgent` is the caller's own "is this user a space (or instance)
 * admin" check (session.ts's canAdministerSpace) — a non-admin never sees a
 * `.agent/**` page here, same as if it didn't exist (owner spec, 21.09.2026:
 * ".agent" is admin-only everywhere pages are listed).
 */
export async function readablePageIds(userId: string, space: string, includeAgent: boolean): Promise<Set<string>> {
  const rows = await query<{ id: string; path: string }>(
    `SELECT p.id, p.path
       FROM pages_index p
       LEFT JOIN page_access a ON a.page_id = p.id
      WHERE p.space_slug = $2
        AND (a.page_id IS NULL OR a.owner_id = $1 OR EXISTS (
          SELECT 1 FROM page_access_grants g WHERE g.page_id = p.id AND g.user_id = $1
        ))`,
    [userId, space],
  );
  return new Set(rows.filter((row) => includeAgent || !isAgentPath(row.path)).map((row) => row.id));
}

async function candidateMembers(space: string): Promise<Array<{ userId: string; name: string; email: string; spaceRole: SpaceRole }>> {
  const [users, explicit, visibility] = await Promise.all([
    authStore.listUsers(),
    authStore.listMembersOf(space),
    authStore.getSpaceVisibility(space),
  ]);
  const roles = new Map(Object.entries(explicit));
  return users
    .filter((user) => !user.disabled)
    .flatMap((user) => {
      const role = roles.get(user.id) ?? (visibility === 'instance' ? 'viewer' : undefined);
      return role ? [{ userId: user.id, name: user.name, email: user.email, spaceRole: role }] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getInfo(user: User, entry: PageIndexEntry, effectiveRole: SpaceRole): Promise<PageAccessInfo> {
  const access = await queryOne<{ owner_id: string }>('SELECT owner_id FROM page_access WHERE page_id = $1', [entry.id]);
  const grants = access
    ? await query<{ user_id: string; role: PageAccessGrantRole }>('SELECT user_id, role FROM page_access_grants WHERE page_id = $1', [entry.id])
    : [];
  const byUser = new Map(grants.map((grant) => [grant.user_id, grant.role]));
  const canManage = effectiveRole === 'editor' || effectiveRole === 'admin';
  const members = (await candidateMembers(entry.space))
    .map((member) => ({
      ...member,
      ...(byUser.get(member.userId) ? { grant: byUser.get(member.userId)! } : {}),
      owner: access?.owner_id === member.userId,
    }))
    // An ordinary reader is shown who the page is available to, but not the
    // whole list of the space's members with their email addresses.
    .filter((member) => canManage || member.owner || member.grant);
  return {
    visibility: access ? 'restricted' : 'space',
    ...(access ? { ownerId: access.owner_id } : {}),
    canManage,
    members,
  };
}

export async function setAccess(
  actor: User,
  entry: PageIndexEntry,
  visibility: 'space' | 'restricted',
  grants: Array<{ userId: string; role: PageAccessGrantRole }>,
): Promise<void> {
  if (visibility === 'space') {
    await query('DELETE FROM page_access WHERE page_id = $1', [entry.id]);
    return;
  }
  const candidates = new Set((await candidateMembers(entry.space)).map((member) => member.userId));
  for (const grant of grants) if (!candidates.has(grant.userId)) throw badRequest('page access user is not a member of this space');
  await withTransaction(async (client) => {
    const current = await client.query<{ owner_id: string }>('SELECT owner_id FROM page_access WHERE page_id = $1 FOR UPDATE', [entry.id]);
    const ownerId = current.rows[0]?.owner_id ?? actor.id;
    await client.query(
      `INSERT INTO page_access (page_id, owner_id) VALUES ($1, $2)
       ON CONFLICT (page_id) DO UPDATE SET updated_at = now()`,
      [entry.id, ownerId],
    );
    await client.query('DELETE FROM page_access_grants WHERE page_id = $1', [entry.id]);
    for (const grant of grants) {
      if (grant.userId === ownerId) continue;
      await client.query('INSERT INTO page_access_grants (page_id, user_id, role) VALUES ($1, $2, $3)', [entry.id, grant.userId, grant.role]);
    }
  });
}
