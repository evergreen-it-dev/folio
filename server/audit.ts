/**
 * audit_log (round 7's first actual writer — the table has existed since
 * 001_init.sql but nothing wrote to it until PAT create/revoke and MCP
 * writes needed a real audit trail). Deliberately fire-and-forget: an audit
 * write failing must never fail or delay the request it's describing.
 */
import { query } from './db/pool.js';

/** actor_id is null for an unauthenticated actor (round 8: a guest editing through a share link — audit_log.actor_id is nullable exactly for this, never a placeholder/fake uuid, which would either violate the FK or, worse, coincidentally collide with a real user). */
export function recordAudit(actorId: string | null, action: string, target?: string, meta?: Record<string, unknown>): void {
  void query('INSERT INTO audit_log (actor_id, action, target, meta) VALUES ($1, $2, $3, $4)', [
    actorId,
    action,
    target ?? null,
    meta ? JSON.stringify(meta) : null,
  ]).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[audit] failed to record "${action}" for actor ${actorId ?? '(guest)'}:`, err);
  });
}
