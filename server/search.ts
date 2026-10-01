/**
 * Search — PostgreSQL FTS + pg_trgm (round 4; replaces round 2's in-memory
 * substring index, which is now deleted). Config 'simple' + unaccent (no
 * stemming — DEV-PLAN's explicit, fixed ru/uk/en compromise). Title carries
 * tsvector weight 'A', body 'B' (set at write time in storage.ts), so
 * ts_rank_cd alone already ranks title matches first; pg_trgm's `%`
 * similarity operator on title additionally catches a typo that wouldn't
 * tokenize-match at all. Permission filtering is a JOIN inside the query
 * (EXISTS against space_members, OR the space's own `visibility`), not a
 * post-filter, so an invisible space's rows are never even ranked, let alone
 * returned.
 *
 * Round 27 (access and rights): removed the old instance-admin bypass (this
 * used to be `$2::boolean OR EXISTS(...)`, with an `isInstanceAdmin` flag
 * short-circuiting the membership check entirely). Search now applies the
 * SAME visibility rule as effectiveRole/membershipsFor in auth/session.ts:
 * an explicit `space_members` row, OR the space being `visibility:
 * 'instance'`. `isAdmin` grants nothing extra here — see docs/spec-access.md
 * §1/§2 ("not 'an admin cannot read a private space', but 'an admin cannot
 * read it silently'"). Callers (server/routes.ts, server/mcp.ts) no
 * longer pass an admin flag at all.
 */
import type { SearchHit } from '../shared/contracts.js';
import { query } from './db/pool.js';

interface SearchRow {
  id: string;
  space: string;
  path: string;
  title: string;
  snippet: string;
}

const RESULT_LIMIT = 50;

export interface SearchOptions {
  userId: string;
  /** Restrict to one space; omit to search every space the caller can see. */
  space?: string;
  /**
   * Round `.agent` (owner spec, 21.09.2026): instance admins see `.agent/**`
   * hits everywhere, same as canAdministerSpace's rule elsewhere — a space
   * admin without that flag still sees them via the per-row space_members
   * EXISTS below. Default false (every caller must say explicitly).
   */
  isInstanceAdmin?: boolean;
}

export async function searchPages(q: string, options: SearchOptions): Promise<SearchHit[]> {
  const trimmed = q.trim();
  if (!trimmed) return [];

  const rows = await query<SearchRow>(
    `SELECT p.id, p.space_slug AS space, p.path, p.title,
            ts_headline(
              'simple',
              coalesce(NULLIF(p.plain_text, ''), p.title),
              plainto_tsquery('simple', unaccent($1)),
              'MaxWords=30, MinWords=10, ShortWord=3, HighlightAll=false'
            ) AS snippet
       FROM pages_index p
      WHERE (p.tsv @@ plainto_tsquery('simple', unaccent($1)) OR p.title % $1)
        AND (
          EXISTS (SELECT 1 FROM space_members m WHERE m.space_slug = p.space_slug AND m.user_id = $2)
          OR EXISTS (SELECT 1 FROM spaces sp WHERE sp.slug = p.space_slug AND sp.visibility = 'instance')
        )
        AND (
          NOT EXISTS (SELECT 1 FROM page_access a WHERE a.page_id = p.id)
          OR EXISTS (SELECT 1 FROM page_access a WHERE a.page_id = p.id AND a.owner_id = $2)
          OR EXISTS (SELECT 1 FROM page_access_grants g WHERE g.page_id = p.id AND g.user_id = $2)
        )
        AND (
          -- Mirrors agentPath.ts's isAgentPath (can't call it from SQL) — keep both in sync.
          NOT (p.path = '.agent' OR p.path LIKE '.agent/%')
          OR $4::boolean
          OR EXISTS (SELECT 1 FROM space_members m2 WHERE m2.space_slug = p.space_slug AND m2.user_id = $2 AND m2.role = 'admin')
        )
        AND ($3::text IS NULL OR p.space_slug = $3)
      ORDER BY (ts_rank_cd(p.tsv, plainto_tsquery('simple', unaccent($1))) + similarity(p.title, $1)) DESC, p.title
      LIMIT ${RESULT_LIMIT}`,
    [trimmed, options.userId, options.space ?? null, options.isInstanceAdmin ?? false],
  );

  // ts_headline's default StartSel/StopSel are <b>/</b> (its options string doesn't
  // accept an empty override in this PG version) — SearchHit.snippet is plain text.
  return rows.map((r) => ({
    id: r.id,
    space: r.space,
    path: r.path,
    title: r.title,
    snippet: r.snippet.replace(/<\/?b>/g, '').trim(),
  }));
}
