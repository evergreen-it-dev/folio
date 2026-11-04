/**
 * The SQL source of truth for "what role does a person have in a space" and
 * "which grant does a person hold on a restricted page". Every query that
 * enumerates members, readers, recipients or readable pages builds on these
 * fragments instead of spelling out `space_members` / `visibility IN (...)` /
 * `page_access_grants` itself: the search/index ACL (accessSql.ts), the
 * `/events` socket audience (auth/store.ts sessionsThatCanReadSpace), the
 * @mention list, page-access candidates, access-request recipients, the
 * page-restriction checks (closedPagesSql / notClosedSql: pageAccess.ts,
 * accessSql.ts, bases/query.ts).
 *
 * The TypeScript twin is access/roles.ts (resolveSpaceRole / resolvePageRole);
 * server/access/roles.test.ts runs random fixtures through both and requires
 * them to agree for every (user, space, page). A new SOURCE of a role is added
 * here (one more UNION ALL branch) and in roles.ts's loader — nowhere else.
 *
 * The rule (docs/spec-access.md §1–§5, §13):
 *  - a disabled user has no role anywhere;
 *  - a system user (the public visitor, migration 039) is only ever an implicit
 *    viewer of a `public` space — never a member, never via visibility
 *    `instance`;
 *  - everybody else: the highest of their direct `space_members` role, the
 *    roles of the active (not archived) groups they belong to
 *    (`space_group_roles` × `group_members`, migration 053) and the implicit
 *    `viewer` of an `instance` / `public` space;
 *  - no instance-admin bypass: `users.is_admin` is not a source;
 *  - a page is closed by its own `page_access` rule and by those of its
 *    restricted ancestors (stage 7, childPrefixSql): readable only for who
 *    passes every one of them (owner or grant), editable only with an editor
 *    grant (or ownership) on every one.
 *
 * This file imports nothing on purpose (auth/store.ts and others import it).
 */

/** `role` text -> 1..3, so the highest of several roles is `max(rank)`. */
function spaceRank(column: string): string {
  return `CASE ${column} WHEN 'admin' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END`;
}

/** 1..3 -> role text (NULL for an empty set). */
function spaceRoleOfRank(rank: string): string {
  return `(ARRAY['viewer', 'editor', 'admin'])[${rank}]`;
}

export interface RoleFilter {
  /** SQL expression for the user id (a `$n` placeholder, or an outer column like `u.id`). */
  user?: string;
  /** SQL expression for the space slug. */
  space?: string;
}

/**
 * A SELECT producing one row `(user_id uuid, space_slug text, role text)` per
 * (user, space) pair where the user has a role — the effective role, already
 * combined. `filter` narrows it inside every branch (so it stays an index
 * lookup); the expressions may reference outer query columns. Inner aliases
 * all start with `er_`, so an outer `u`, `m`, `s`, `p`, `sp` stays visible.
 */
export function effectiveRolesSql(filter: RoleFilter = {}): string {
  const userIs = (column: string) => (filter.user ? ` AND ${column} = ${filter.user}` : '');
  const spaceIs = (column: string) => (filter.space ? ` AND ${column} = ${filter.space}` : '');
  return `SELECT er_x.user_id, er_x.space_slug, ${spaceRoleOfRank('max(er_x.rank)')} AS role
      FROM (
        SELECT er_m.user_id, er_m.space_slug, ${spaceRank('er_m.role')} AS rank, false AS sys
          FROM space_members er_m
         WHERE true${userIs('er_m.user_id')}${spaceIs('er_m.space_slug')}
        UNION ALL
        SELECT er_gm.user_id, er_gr.space_slug, ${spaceRank('er_gr.role')}, false
          FROM space_group_roles er_gr
          JOIN groups er_g ON er_g.id = er_gr.group_id AND er_g.archived_at IS NULL
          JOIN group_members er_gm ON er_gm.group_id = er_gr.group_id
         WHERE true${userIs('er_gm.user_id')}${spaceIs('er_gr.space_slug')}
        UNION ALL
        SELECT er_iu.id, er_isp.slug, 1, false
          FROM users er_iu
          JOIN spaces er_isp ON er_isp.visibility IN ('instance', 'public')
         WHERE NOT er_iu.is_system${userIs('er_iu.id')}${spaceIs('er_isp.slug')}
        UNION ALL
        SELECT er_su.id, er_ssp.slug, 1, true
          FROM users er_su
          JOIN spaces er_ssp ON er_ssp.visibility = 'public'
         WHERE er_su.is_system${userIs('er_su.id')}${spaceIs('er_ssp.slug')}
      ) er_x
      JOIN users er_u ON er_u.id = er_x.user_id AND NOT er_u.disabled AND er_u.is_system = er_x.sys
     GROUP BY er_x.user_id, er_x.space_slug`;
}

/** Scalar SQL expression: the effective role of `user` in `space` ('viewer' | 'editor' | 'admin'), NULL for none. */
export function spaceRoleSql(user: string, space: string): string {
  return `(SELECT er_r.role FROM (${effectiveRolesSql({ user, space })}) er_r)`;
}

/** SQL for the set of space slugs where `user` has a role (at least `minRole` when given) — for `slug IN (...)`. Uncorrelated when `user` is a placeholder, so Postgres evaluates it once. */
export function spacesWithRoleSql(user: string, minRole?: 'editor' | 'admin'): string {
  const where = minRole === 'admin' ? ` WHERE er_r.role = 'admin'` : minRole === 'editor' ? ` WHERE er_r.role IN ('editor', 'admin')` : '';
  return `SELECT er_r.space_slug FROM (${effectiveRolesSql({ user })}) er_r${where}`;
}

/**
 * SQL condition: group `group` "is in" space `space` — it holds a role there,
 * or the space is open to the whole instance. The group twin of "a grantee
 * must be a member of the space": a page grant to a group counts only while
 * this holds (and pageAccess.setAccess refuses to create one otherwise).
 */
export function groupInSpaceSql(group: string, space: string): string {
  return `(EXISTS (SELECT 1 FROM space_group_roles gis_r WHERE gis_r.space_slug = ${space} AND gis_r.group_id = ${group})
      OR EXISTS (SELECT 1 FROM spaces gis_s WHERE gis_s.slug = ${space} AND gis_s.visibility IN ('instance', 'public')))`;
}

/**
 * A SELECT of the ids of the restricted pages `user` holds a page-level grant
 * on — their own, or one of an active group they belong to that is in the
 * page's space (groupInSpaceSql); with `minRole: 'editor'` only editor grants.
 * Ownership is not a grant (callers check `page_access.owner_id` themselves),
 * and a grant means something only together with a space role — callers gate
 * on that too.
 */
export function grantedPagesSql(user: string, minRole?: 'editor'): string {
  const role = (alias: string) => (minRole === 'editor' ? ` AND ${alias}.role = 'editor'` : '');
  return `SELECT pg_g.page_id FROM page_access_grants pg_g WHERE pg_g.user_id = ${user}${role('pg_g')}
      UNION ALL
      SELECT pg_gg.page_id
        FROM page_access_grants pg_gg
        JOIN group_members pg_gm ON pg_gm.group_id = pg_gg.group_id AND pg_gm.user_id = ${user}
        JOIN groups pg_grp ON pg_grp.id = pg_gg.group_id AND pg_grp.archived_at IS NULL
        JOIN pages_index pg_p ON pg_p.id = pg_gg.page_id
       WHERE pg_gg.group_id IS NOT NULL${role('pg_gg')} AND ${groupInSpaceSql('pg_gg.group_id', 'pg_p.space_slug')}`;
}

// ---------------------------------------------------------------------------
// Inherited page restrictions (docs/spec-access.md §13, stage 7)
// ---------------------------------------------------------------------------

/**
 * Length of the page-file suffix `relPathStem` strips for each page kind
 * (storage.ts relPathStem; access/pageTree.ts childPrefixOf is the TypeScript
 * twin and pageTree.test.ts checks all three agree). A kind always comes from
 * its file's suffix (storage.ts pageFileKind), so a fixed length per kind is
 * exact. `doc` is the ELSE branch: 3 for `.md`, 4 for `.mdx`.
 */
const KIND_SUFFIX_LENGTH: ReadonlyArray<[string, number]> = [
  ['board', '.excalidraw.svg'.length],
  ['table', '.table.md'.length],
  ['form', '.form.md'.length],
  ['pdf', '.pdf'.length],
  ['canvas', '.canvas'.length],
  ['base', '.base'.length],
  ['artifact', '.artifact'.length],
  ['office', '.docx'.length],
];

/**
 * SQL expression: the folder prefix (`dir/`, with the trailing slash) whose
 * contents are the CHILDREN of the `pages_index` row aliased `alias` — the same
 * two page shapes storage.getTree / getSubtree model:
 *  - a directory index (index.md, or README.md without one): its own folder;
 *  - any other page `X.<ext>`: the same-named folder `X/` next to it.
 * NULL for the space's root index page: it stands for the space itself (the
 * sidebar unwraps it, deleting it deletes the space), so its restriction covers
 * that one page only — the space as a whole is closed by membership.
 * Path-derived on purpose (no stored closure to keep in sync): a move, rename,
 * git sync or trash restore changes the path, and the inheritance follows.
 */
export function childPrefixSql(alias: string): string {
  const suffix = `CASE ${alias}.kind ${KIND_SUFFIX_LENGTH.map(([kind, length]) => `WHEN '${kind}' THEN ${length}`).join(' ')} ELSE CASE WHEN lower(right(${alias}.path, 4)) = '.mdx' THEN 4 ELSE 3 END END`;
  return `(CASE WHEN ${alias}.is_index
              THEN CASE WHEN strpos(${alias}.path, '/') = 0 THEN NULL
                        ELSE left(${alias}.path, length(${alias}.path) - strpos(reverse(${alias}.path), '/') + 1) END
              ELSE left(${alias}.path, length(${alias}.path) - ${suffix}) || '/' END)`;
}

export interface RestrictionFilter {
  /** Only the rules this user does NOT pass (SQL expression for the user id); every rule when omitted. */
  user?: string;
  /** With `user`: a rule is passed only by its owner or an EDITOR grant. */
  minRole?: 'editor';
  /** Only rules of pages in this space (SQL expression for the slug). */
  space?: string;
}

/**
 * A SELECT of the ids of every page that the restricted pages selected by
 * `filter` close: the restricted page itself and every page below it
 * (childPrefixSql — inheritance: a child of a restricted page is restricted
 * too). With `filter.user` only the rules that user does not pass count, so
 * the result is exactly the pages page access hides from them (or, with
 * `minRole: 'editor'`, the pages they cannot edit); "passing" a rule is being
 * its owner or holding a grant (grantedPagesSql) — the TypeScript twin is
 * roles.ts resolvePageRole over the chain loadPageRoleSources returns.
 * The space role is NOT checked here — callers gate on it as before.
 *
 * Per row, use notClosedSql (evaluated once per query, then a hashed lookup);
 * alone, it is a set to join or scan. The rules are few (page_access rows),
 * each one's descendants are a range scan of pages_index_path_prefix_idx
 * (migration 050: `path >= 'd/' AND path < 'd0'` in the "C" collation is
 * exactly the prefix `d/`).
 */
export function closedPagesSql(filter: RestrictionFilter = {}): string {
  const conditions: string[] = [];
  if (filter.user) {
    conditions.push(`cl_a.owner_id <> ${filter.user}`);
    conditions.push(`cl_a.page_id NOT IN (${grantedPagesSql(filter.user, filter.minRole)})`);
  }
  if (filter.space) conditions.push(`cl_x.space_slug = ${filter.space}`);
  return `WITH cl_rule AS (
        SELECT cl_x.id, cl_x.space_slug, ${childPrefixSql('cl_x')} AS prefix
          FROM page_access cl_a
          JOIN pages_index cl_x ON cl_x.id = cl_a.page_id
         WHERE ${conditions.length > 0 ? conditions.join(' AND ') : 'true'}
      )
      SELECT cl_rule.id FROM cl_rule
      UNION
      SELECT cl_d.id
        FROM cl_rule
        JOIN pages_index cl_d
          ON cl_d.space_slug = cl_rule.space_slug
         AND cl_rule.prefix IS NOT NULL
         AND (cl_d.path COLLATE "C") >= (cl_rule.prefix COLLATE "C")
         AND (cl_d.path COLLATE "C") < ((left(cl_rule.prefix, -1) || '0') COLLATE "C")`;
}

/**
 * SQL condition: the page `pageId` (an id expression) is not closed by `filter`
 * (closedPagesSql). It runs per row of page lists (graph, search, bases, the
 * index reads), so it must be ONE hashed lookup per row whatever the planner
 * believes about page_access: the set is computed once into an array (an
 * InitPlan) and unnested, which the planner estimates at a handful of rows and
 * therefore always hashes. A plain `NOT IN (closedPagesSql)` is hashed only
 * when the estimate fits in work_mem — with page_access not yet analyzed it
 * did not, and the set was recomputed for every row (seconds on 5k pages).
 */
export function notClosedSql(pageId: string, filter: RestrictionFilter = {}): string {
  return `(${pageId} NOT IN (SELECT unnest(ARRAY(${closedPagesSql(filter)}))))`;
}

/**
 * A SELECT of the restrictions page `page` (an id expression) is under — its
 * own `page_access` row and those of its restricted ancestors (childPrefixSql)
 * — as `(page_id, owner_id, title, path)` of the restricted page. Driven from
 * page_access, which is small. The single-page twin of closedPagesSql.
 */
export function restrictionChainSql(page: string): string {
  return `SELECT rc_a.page_id, rc_a.owner_id, rc_x.title, rc_x.path
       FROM page_access rc_a
       JOIN pages_index rc_x ON rc_x.id = rc_a.page_id
       JOIN pages_index rc_t ON rc_t.id = ${page} AND rc_t.space_slug = rc_x.space_slug
      WHERE rc_x.id = rc_t.id OR starts_with(rc_t.path, ${childPrefixSql('rc_x')})`;
}
