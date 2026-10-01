/** The HTTP wrapper of the personal history of structural changes to pages. */
import type { FastifyInstance } from 'fastify';
import * as session from './auth/session.js';
import { queryString } from './validate.js';
import { listPageChanges, undoPageChange } from './pageChanges.js';

export function registerPageChangeRoutes(app: FastifyInstance): void {
  app.get('/api/spaces/:space/changes', async (request) => {
    const { space } = request.params as { space: string };
    await session.requireSpaceRole(request, space, 'viewer');
    const parsed = Number(queryString(request.query, 'limit'));
    const limit = Number.isFinite(parsed) ? parsed : 10;
    return { changes: await listPageChanges(request.authUser!.id, space, limit) };
  });

  app.post('/api/spaces/:space/changes/:id/undo', async (request) => {
    const { space, id } = request.params as { space: string; id: string };
    await session.requireSpaceRole(request, space, 'editor');
    session.requireWriteScope(request);
    return undoPageChange(request.authUser!, space, id);
  });
}
