/**
 * Trash round route registration — registered once from server/index.ts's
 * protectedScope (same one-line-per-round pattern as
 * registerTableRoutes/registerExportRoutes/registerAccessRoutes, so
 * server/routes.ts stays out of this round's merge surface).
 *
 * Handlers are thin wrappers over server/trash/service.ts's exported
 * functions, which carry the authorization themselves (space admin sees
 * their space, instance admin everything — see that module's doc comment
 * for why the instance-admin exception is deliberate) and are unit-tested
 * directly against real PG + real fs (no HTTP harness in this codebase).
 *
 * Registration also kicks off the boot-time backfill of any PRE-EXISTING
 * data/.trash/** (spec item 3) — fire-and-forget on purpose: it's
 * best-effort reconstruction that must never delay or fail boot, and by
 * the time index.ts registers routes the migrations (which create
 * trash_items) have already run. Living here keeps this round's index.ts
 * footprint to the agreed single import+call line.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as session from '../auth/session.js';
import { parseBody, queryString } from '../validate.js';
import { assertNotDemoAccount } from '../demo.js';
import { backfillTrashFromDisk } from './backfill.js';
import { emptyTrash, getTrashSettings, listTrash, purgeTrashItem, restoreTrashItem, setTrashRetention } from './service.js';

/** PUT /api/trash/settings body. Local to the route (shared/contracts.ts carries only the domain types for this round); null = no auto-purge, ever. */
const trashSettingsBodySchema = z.object({
  retentionDays: z.number().int().min(1).max(3650).nullable(),
});

export function registerTrashRoutes(app: FastifyInstance): void {
  app.get('/api/trash', async (request) => {
    const limitRaw = queryString(request.query, 'limit');
    const offsetRaw = queryString(request.query, 'offset');
    return listTrash(request.authUser!, {
      space: queryString(request.query, 'space') || undefined,
      kind: queryString(request.query, 'kind') || undefined,
      from: queryString(request.query, 'from') || undefined,
      to: queryString(request.query, 'to') || undefined,
      limit: limitRaw ? Number(limitRaw) : undefined,
      offset: offsetRaw ? Number(offsetRaw) : undefined,
    });
  });

  // Static /settings paths registered alongside the parameterized /:id ones —
  // Fastify's router prefers the static match, and service-side the :id
  // handlers additionally reject any non-uuid id as 404.
  app.get('/api/trash/settings', async () => getTrashSettings());

  app.put('/api/trash/settings', async (request) => {
    assertNotDemoAccount(request.authUser!, 'Changing the trash retention');
    // The one instance-ADMIN endpoint in this file (setTrashRetention rejects
    // a non-admin actor), so it falls under DEV-PLAN round 7's blanket rule:
    // admin endpoints are unreachable via a PAT whatever its scope. The
    // per-item routes below stay PAT-usable with write scope — those are
    // content the caller already administers, not instance configuration.
    session.requireCookieAuth(request);
    session.requireWriteScope(request);
    const body = parseBody(trashSettingsBodySchema, request.body);
    return setTrashRetention(request.authUser!, body.retentionDays);
  });

  app.post('/api/trash/:id/restore', async (request) => {
    const { id } = request.params as { id: string };
    session.requireWriteScope(request);
    return restoreTrashItem(request.authUser!, id);
  });

  app.delete('/api/trash/:id', async (request) => {
    assertNotDemoAccount(request.authUser!, 'Purging the trash');
    const { id } = request.params as { id: string };
    session.requireWriteScope(request);
    return purgeTrashItem(request.authUser!, id);
  });

  // "Empty the trash" — everything the caller can see, optionally one space.
  app.delete('/api/trash', async (request) => {
    assertNotDemoAccount(request.authUser!, 'Emptying the trash');
    session.requireWriteScope(request);
    return emptyTrash(request.authUser!, queryString(request.query, 'space') || undefined);
  });

  void backfillTrashFromDisk().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[trash] boot backfill failed:', err);
  });
}
