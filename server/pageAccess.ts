import type { PageAccessGrant, PageAccessGrantRole, PageAccessGroup, PageAccessInfo, SpaceRole, User } from '../shared/contracts.js';
import type { PageIndexEntry } from './storage.js';
import { query, queryOne, withTransaction } from './db/pool.js';
import * as authStore from './auth/store.js';
import * as roles from './access/roles.js';
import { closedPagesSql, groupInSpaceSql, notClosedSql } from './access/roleSql.js';
import * as groupStore from './groups/store.js';
import { recordAudit } from './audit.js';
import { badRequest, conflict } from './errors.js';
import * as storage from './storage.js';
import { AGENT_FOLDER, isAgentPath } from './agentPath.js';

/** The page role on top of `spaceRole` (access/roles.ts resolvePageRole over the page's restriction chain: its own rule and its restricted ancestors'). */
export async function effectivePageRole(user: User, entry: PageIndexEntry, spaceRole: SpaceRole | undefined): Promise<SpaceRole | undefined> {
  if (!spaceRole || user.disabled) return undefined;
  return roles.resolvePageRole(user.id, spaceRole, await roles.loadPageRoleSources(user.id, entry.id));
}

/**
 * IDs that may be exposed through tree/search/subtree surfaces: every page of
 * `space` no restriction on its chain hides from `userId` (roleSql.ts
 * closedPagesSql — a restricted page and everything below it, unless the user
 * owns or is granted every restriction on the way).
 * `includeAgent` is the caller's own "is this user a space (or instance)
 * admin" check (session.ts's canAdministerSpace) — a non-admin never sees a
 * `.agent/**` page here, same as if it didn't exist (owner spec, 21.09.2026:
 * ".agent" is admin-only everywhere pages are listed).
 */
export async function readablePageIds(userId: string, space: string, includeAgent: boolean): Promise<Set<string>> {
  const rows = await query<{ id: string; path: string }>(
    `SELECT p.id, p.path
       FROM pages_index p
      WHERE p.space_slug = $2
        AND ${notClosedSql('p.id', { user: '$1', space: '$2' })}`,
    [userId, space],
  );
  return new Set(rows.filter((row) => includeAgent || !isAgentPath(row.path)).map((row) => row.id));
}

/**
 * The exact complement of `readablePageIds` within `space`: the pages page
 * access hides from `userId` (closedPagesSql: under a restriction they neither
 * own nor hold a grant on), plus `.agent/**` unless `includeAgent`. Only the
 * restricted subtrees are read, so the common "nothing hidden" answer is one
 * cheap query — the raw-file route (server/fileAccess.ts) asks this on every
 * attachment.
 */
export async function hiddenPages(userId: string, space: string, includeAgent: boolean): Promise<Array<{ id: string; path: string; kind: PageIndexEntry['kind'] }>> {
  const rows = await query<{ id: string; path: string; kind: PageIndexEntry['kind']; hidden_by_acl: boolean }>(
    `WITH closed AS (${closedPagesSql({ user: '$1', space: '$2' })})
     SELECT p.id, p.path, p.kind, (p.id IN (SELECT c.id FROM closed c)) AS hidden_by_acl
       FROM pages_index p
      WHERE p.space_slug = $2
        AND (p.id IN (SELECT c.id FROM closed c) OR p.path = $3 OR substr(p.path, 1, length($4)) = $4)`,
    [userId, space, AGENT_FOLDER, `${AGENT_FOLDER}/`],
  );
  return rows
    .filter((row) => row.hidden_by_acl || (!includeAgent && isAgentPath(row.path)))
    .map(({ id, path, kind }) => ({ id, path, kind }));
}

/**
 * IDs of the pages in `space` that are NOT open to everyone who can read the
 * space: every page with a `page_access` row (private mode — "only me" or
 * "specific people") and every page below one (inherited, closedPagesSql),
 * plus every `.agent/**` page (admin-only). User-independent: what a public
 * site (publicSites.ts) and a share guest's raw-file check (fileAccess.ts)
 * must never treat as open. A subtree share link cuts at
 * ownRuleOrAgentPageIds instead.
 */
export async function restrictedPageIds(space: string): Promise<Set<string>> {
  const rows = await query<{ id: string; path: string; restricted: boolean }>(
    `WITH closed AS (${closedPagesSql({ space: '$1' })})
     SELECT p.id, p.path, (p.id IN (SELECT c.id FROM closed c)) AS restricted
       FROM pages_index p
      WHERE p.space_slug = $1
        AND (p.id IN (SELECT c.id FROM closed c) OR p.path = $2 OR substr(p.path, 1, length($3)) = $3)`,
    [space, AGENT_FOLDER, `${AGENT_FOLDER}/`],
  );
  return new Set(rows.filter((row) => row.restricted || isAgentPath(row.path)).map((row) => row.id));
}

/**
 * IDs of the pages in `space` that carry a restriction OF THEIR OWN (a
 * `page_access` row), plus every `.agent/**` page — not the ones restricted
 * only through an ancestor. The cut points of a subtree share link
 * (export/shareScope.ts): it leaves out such a page and everything below it,
 * but keeps what lies below its own root even when that root is restricted
 * (by its own rule or a parent's) — the creator, who can open the root, chose
 * it explicitly. Share-link semantics are unchanged by inherited restrictions.
 */
export async function ownRuleOrAgentPageIds(space: string): Promise<Set<string>> {
  const rows = await query<{ id: string; path: string; restricted: boolean }>(
    `SELECT p.id, p.path, (a.page_id IS NOT NULL) AS restricted
       FROM pages_index p
       LEFT JOIN page_access a ON a.page_id = p.id
      WHERE p.space_slug = $1
        AND (a.page_id IS NOT NULL OR p.path = $2 OR substr(p.path, 1, length($3)) = $3)`,
    [space, AGENT_FOLDER, `${AGENT_FOLDER}/`],
  );
  return new Set(rows.filter((row) => row.restricted || isAgentPath(row.path)).map((row) => row.id));
}

/**
 * For the sidebar's lock marks: page id -> `restricted` (a rule of its own) or
 * `inherited` (restricted only through an ancestor), for every page of
 * `space` under a restriction. One query; who may see a mark is decided by
 * the tree itself (a page the caller cannot open is not in it).
 */
export async function accessMarks(space: string): Promise<Map<string, 'restricted' | 'inherited'>> {
  const rows = await query<{ id: string; own: boolean }>(
    `SELECT c.id, EXISTS (SELECT 1 FROM page_access a WHERE a.page_id = c.id) AS own
       FROM (${closedPagesSql({ space: '$1' })}) c`,
    [space],
  );
  return new Map(rows.map((row) => [row.id, row.own ? 'restricted' : 'inherited']));
}

/** Every person with a role in `space` right now (access/roles.ts spaceMemberRoles: active, not a system account), name-sorted. */
async function candidateMembers(space: string): Promise<Array<{ userId: string; name: string; email: string; spaceRole: SpaceRole }>> {
  const [users, memberRoles] = await Promise.all([authStore.listUsers(), roles.spaceMemberRoles(space)]);
  return users
    .flatMap((user) => {
      const role = memberRoles.get(user.id);
      return role ? [{ userId: user.id, name: user.name, email: user.email, spaceRole: role }] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Ids of the people who can read `space` right now: its active (not disabled)
 * members, plus everybody active when the space is visible to the whole
 * instance. A page-access rule means something only for these — a grant to
 * anybody else is dormant (setAccess refuses to create one).
 */
export async function activeMemberIds(space: string): Promise<Set<string>> {
  return new Set((await candidateMembers(space)).map((member) => member.userId));
}

/**
 * Groups that may hold a grant on a page of `space` (groupInSpaceSql: the group
 * holds a role there, or the space is open to the instance), active ones only,
 * with their own space role and their current grant on `pageId`.
 */
async function candidateGroups(space: string, pageId: string): Promise<PageAccessGroup[]> {
  const rows = await query<{ id: string; slug: string; name: string; member_count: string; space_role: SpaceRole | null; grant_role: PageAccessGrantRole | null }>(
    `SELECT g.id, g.slug, g.name,
            (SELECT COUNT(*) FROM group_members gm JOIN users u ON u.id = gm.user_id
              WHERE gm.group_id = g.id AND NOT u.disabled AND NOT u.is_system) AS member_count,
            (SELECT r.role FROM space_group_roles r WHERE r.space_slug = $1 AND r.group_id = g.id) AS space_role,
            (SELECT pg.role FROM page_access_grants pg WHERE pg.page_id = $2 AND pg.group_id = g.id) AS grant_role
       FROM groups g
      WHERE g.archived_at IS NULL AND ${groupInSpaceSql('g.id', '$1')}
      ORDER BY lower(g.name)`,
    [space, pageId],
  );
  return rows.map((row) => ({
    groupId: row.id,
    slug: row.slug,
    name: row.name,
    memberCount: Number(row.member_count),
    ...(row.space_role ? { spaceRole: row.space_role } : {}),
    ...(row.grant_role ? { grant: row.grant_role } : {}),
  }));
}

export async function getInfo(user: User, entry: PageIndexEntry, effectiveRole: SpaceRole): Promise<PageAccessInfo> {
  const access = await queryOne<{ owner_id: string }>('SELECT owner_id FROM page_access WHERE page_id = $1', [entry.id]);
  const grants = access
    ? await query<{ user_id: string; role: PageAccessGrantRole }>('SELECT user_id, role FROM page_access_grants WHERE page_id = $1 AND user_id IS NOT NULL', [entry.id])
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
  const groups = (await candidateGroups(entry.space, entry.id)).filter((group) => canManage || (access && group.grant));
  // Whoever opens this page passes every restriction above it too, so naming them reveals nothing new.
  const inheritedFrom = (await roles.restrictionChain(entry.id)).filter((rule) => rule.pageId !== entry.id).map((rule) => ({ pageId: rule.pageId, title: rule.title }));
  let audience: PageAccessInfo['audience'];
  let audienceCount: number | undefined;
  if (access || inheritedFrom.length > 0) {
    const everyone = await candidateMembers(entry.space);
    const pageRoles = await roles.pageRolesFor(entry.id, everyone);
    const readers = everyone.flatMap((member) => {
      const role = pageRoles.get(member.userId);
      return role ? [{ userId: member.userId, name: member.name, role }] : [];
    });
    audienceCount = readers.length;
    if (canManage) audience = readers;
  }
  return {
    visibility: access ? 'restricted' : 'space',
    ...(access ? { ownerId: access.owner_id } : {}),
    canManage,
    members,
    groups: access ? groups : groups.map(({ grant: _grant, ...group }) => group),
    inheritedFrom,
    ...(audience ? { audience } : {}),
    ...(audienceCount !== undefined ? { audienceCount } : {}),
  };
}

/**
 * Writes the page's rule. Grants go to people (who must have a role in the
 * space) or to groups (which must be in the space — candidateGroups). A
 * change of a GROUP grant is audited as access.group_grant / access.group_revoke
 * (target = the space, meta.pageId), so it shows in the space's access feed.
 */
export async function setAccess(actor: User, entry: PageIndexEntry, visibility: 'space' | 'restricted', grants: PageAccessGrant[]): Promise<void> {
  const before = await query<{ group_id: string; role: PageAccessGrantRole; name: string; slug: string }>(
    `SELECT pg.group_id, pg.role, g.name, g.slug FROM page_access_grants pg JOIN groups g ON g.id = pg.group_id WHERE pg.page_id = $1`,
    [entry.id],
  );
  const userGrants = grants.filter((grant): grant is Extract<PageAccessGrant, { userId: string }> => 'userId' in grant);
  const groupGrants = new Map(
    grants.filter((grant): grant is Extract<PageAccessGrant, { groupId: string }> => 'groupId' in grant).map((grant) => [grant.groupId, grant.role]),
  );
  if (visibility === 'space') {
    await query('DELETE FROM page_access WHERE page_id = $1', [entry.id]);
    groupGrants.clear();
  } else {
    const candidates = new Set((await candidateMembers(entry.space)).map((member) => member.userId));
    for (const grant of userGrants) if (!candidates.has(grant.userId)) throw badRequest('page access user is not a member of this space');
    const groupCandidates = new Set((await candidateGroups(entry.space, entry.id)).map((group) => group.groupId));
    for (const groupId of groupGrants.keys()) if (!groupCandidates.has(groupId)) throw badRequest('page access group is not in this space');
    await withTransaction(async (client) => {
      const current = await client.query<{ owner_id: string }>('SELECT owner_id FROM page_access WHERE page_id = $1 FOR UPDATE', [entry.id]);
      const ownerId = current.rows[0]?.owner_id ?? actor.id;
      await client.query(
        `INSERT INTO page_access (page_id, owner_id) VALUES ($1, $2)
         ON CONFLICT (page_id) DO UPDATE SET updated_at = now()`,
        [entry.id, ownerId],
      );
      await client.query('DELETE FROM page_access_grants WHERE page_id = $1', [entry.id]);
      for (const grant of userGrants) {
        if (grant.userId === ownerId) continue;
        await client.query('INSERT INTO page_access_grants (page_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [entry.id, grant.userId, grant.role]);
      }
      for (const [groupId, role] of groupGrants) {
        await client.query('INSERT INTO page_access_grants (page_id, group_id, role) VALUES ($1, $2, $3)', [entry.id, groupId, role]);
      }
    });
  }
  await auditGroupGrantChanges(actor, entry, before, groupGrants);
}

async function auditGroupGrantChanges(
  actor: User,
  entry: PageIndexEntry,
  before: Array<{ group_id: string; role: PageAccessGrantRole; name: string; slug: string }>,
  after: ReadonlyMap<string, PageAccessGrantRole>,
): Promise<void> {
  const previous = new Map(before.map((row) => [row.group_id, row]));
  for (const row of before) {
    if (!after.has(row.group_id)) {
      recordAudit(actor.id, 'access.group_revoke', entry.space, { groupId: row.group_id, groupName: row.name, groupSlug: row.slug, previousRole: row.role, pageId: entry.id });
    }
  }
  const added = [...after].filter(([groupId, role]) => previous.get(groupId)?.role !== role);
  if (added.length === 0) return;
  const names = await groupStore.getGroupsByIds(added.map(([groupId]) => groupId));
  for (const [groupId, role] of added) {
    const group = names.get(groupId);
    recordAudit(actor.id, 'access.group_grant', entry.space, {
      groupId,
      groupName: group?.name ?? null,
      groupSlug: group?.slug ?? null,
      role,
      previousRole: previous.get(groupId)?.role ?? null,
      pageId: entry.id,
    });
  }
}

// ---------------------------------------------------------------------------
// Getting INTO a restricted page: an instance admin letting themselves in, and a
// page owner approving a request. Both write plain user grants (the same rows
// the access dialog writes) and leave an `access.*` audit row on the SPACE
// target, so the space's access log shows who opened what. Neither is a bypass
// of resolvePageRole: access still comes from a membership and grant rows.
// ---------------------------------------------------------------------------

/**
 * An instance admin gives THEMSELVES access to a page restricted to named people (there is deliberately no admin
 * bypass, so the way in is a grant — recorded, never silent). In one transaction:
 *  - no space role (explicit or implicit) -> a `viewer` membership, audited as `access.self_grant` on the space;
 *  - every restriction on the page's chain the admin does not pass -> a `viewer` user grant, audited as
 *    `access.self_grant` (meta.pageId = the restricted page). A restriction the admin already passes (owner, or any
 *    existing grant — an editor grant is never touched) gets nothing.
 * Idempotent: with nothing missing it changes nothing and records nothing.
 */
export async function selfGrantPageAccess(actor: User, entry: PageIndexEntry): Promise<{ space: string; pageId: string }> {
  const spaceRole = await roles.effectiveSpaceRole(roles.roleSubject(actor, false), entry.space);
  const { restrictions } = await roles.loadPageRoleSources(actor.id, entry.id);
  const missing = restrictions.filter((rule) => roles.restrictionRole(actor.id, rule) === undefined);
  if (spaceRole === undefined || missing.length > 0) {
    await withTransaction(async (client) => {
      if (spaceRole === undefined) {
        await client.query(
          `INSERT INTO space_members (space_slug, user_id, role) VALUES ($1, $2, 'viewer')
           ON CONFLICT (space_slug, user_id) DO NOTHING`,
          [entry.space, actor.id],
        );
      }
      for (const rule of missing) {
        await client.query(
          `INSERT INTO page_access_grants (page_id, user_id, role) VALUES ($1, $2, 'viewer')
           ON CONFLICT (page_id, user_id) DO NOTHING`,
          [rule.pageId, actor.id],
        );
      }
    });
    if (spaceRole === undefined) {
      recordAudit(actor.id, 'access.self_grant', entry.space, { targetUserId: actor.id, role: 'viewer', previousRole: null, reason: 'page access' });
    }
    for (const rule of missing) {
      recordAudit(actor.id, 'access.self_grant', entry.space, { targetUserId: actor.id, role: 'viewer', pageId: rule.pageId, reason: 'page access' });
    }
  }
  return { space: entry.space, pageId: entry.id };
}

/**
 * The restrictions on `entry`'s chain that `decider` may open for somebody else: those whose page they hold an
 * `editor`+ page role on (an owner is an editor of their own restriction, but a restriction below one they do not
 * pass themselves does not count — the same right that lets them use that page's access dialog).
 */
export async function restrictionsDeciderMayGrant(decider: User, entry: PageIndexEntry, spaceRole: SpaceRole | undefined): Promise<string[]> {
  if (!spaceRole || decider.disabled) return [];
  const mine: string[] = [];
  for (const rule of await roles.restrictionChain(entry.id)) {
    const ruleEntry = rule.pageId === entry.id ? entry : await storage.getEntry(rule.pageId);
    if (!ruleEntry) continue;
    if (roles.roleAtLeast(await effectivePageRole(decider, ruleEntry, spaceRole), 'editor')) mine.push(rule.pageId);
  }
  return mine;
}

/**
 * Approval of a page access request: a user grant (`viewer` | `editor`) for `requester` on each page of
 * `restrictedPageIds`, never lowering a grant they already hold, audited as `access.grant` (target = the space,
 * meta.pageId) per page. The requester must still hold a role in the space — a grant to anybody else would be dormant.
 * Returns whether the requester now opens `entry`: a restriction owned by somebody else on the chain may still shut them out.
 */
export async function grantRequestedPageAccess(
  actor: User,
  requester: User,
  entry: PageIndexEntry,
  restrictedPageIds: string[],
  role: PageAccessGrantRole,
): Promise<{ opensPage: boolean }> {
  const requesterSpaceRole = await roles.effectiveSpaceRole(roles.roleSubject(requester, false), entry.space);
  if (!requesterSpaceRole) throw conflict('the requester no longer has a role in this space');
  const previous = new Map<string, PageAccessGrantRole | null>();
  await withTransaction(async (client) => {
    for (const pageId of restrictedPageIds) {
      const row = await client.query<{ role: PageAccessGrantRole }>('SELECT role FROM page_access_grants WHERE page_id = $1 AND user_id = $2 FOR UPDATE', [pageId, requester.id]);
      previous.set(pageId, row.rows[0]?.role ?? null);
      await client.query(
        `INSERT INTO page_access_grants (page_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (page_id, user_id) DO UPDATE SET role = CASE WHEN page_access_grants.role = 'editor' THEN 'editor' ELSE EXCLUDED.role END`,
        [pageId, requester.id, role],
      );
    }
  });
  for (const pageId of restrictedPageIds) {
    recordAudit(actor.id, 'access.grant', entry.space, { targetUserId: requester.id, role, previousRole: previous.get(pageId) ?? null, pageId });
  }
  return { opensPage: (await effectivePageRole(requester, entry, requesterSpaceRole)) !== undefined };
}
