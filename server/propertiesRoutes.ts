/**
 * Properties (front matter) and property types (Obsidian brief, wave 3) — the
 * HTTP surface of server/properties.ts and server/propertyTypes.ts. Registered
 * in the protected scope.
 *
 *   GET /api/pages/:id/properties          viewer+ on the page            -> PagePropertiesResponse
 *   PUT /api/pages/:id/properties          editor+ on the page, cookie or write-scope PAT
 *                                          body UpdatePagePropertiesBody  -> PagePropertiesResponse (409 + current on an etag mismatch)
 *                                          documents, data tables, forms (front matter), boards, PDFs, Office
 *                                          pages (sidecar `.folio/<path>.props.yaml`); a folder: 400
 *   PUT /api/pages/:id/verification        editor+ on the page, cookie or write-scope PAT
 *                                          body UpdateVerificationBody    -> VerificationResponse (owner, review_by, "Mark as verified")
 *   GET /api/spaces/:space/property-types  viewer+ on the space           -> SpacePropertyTypesResponse
 *   PUT /api/spaces/:space/property-types  admin of the space, cookie session only, not the shared demo login
 *                                          body UpdatePropertyTypesBody   -> SpacePropertyTypesResponse
 *
 * A page's properties are content: edited like the body (the demo allows it,
 * a write-scope token may do it). The types file is a space setting: written
 * like the appearance files (spaceAppearanceRoutes.ts) — a PAT does not change
 * settings.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { updatePagePropertiesBodySchema, updatePropertyTypesBodySchema, updateVerificationBodySchema } from '../shared/contracts.js';
import { userViewer } from './accessSql.js';
import { recordAudit } from './audit.js';
import * as session from './auth/session.js';
import { assertNotDemoAccount } from './demo.js';
import { badRequest } from './errors.js';
import { PropertiesConflictError, propertiesStoreOf, readPageProperties, savePageProperties } from './properties.js';
import { readSpacePropertyTypes, writeSpacePropertyTypes } from './propertyTypes.js';
import type { PageIndexEntry } from './storage.js';
import { updateVerification } from './verification.js';
import { parseBody } from './validate.js';

/** Editor+ on the page, and not a read-only token: what `canEdit` reports. */
async function mayEdit(request: FastifyRequest, entry: PageIndexEntry): Promise<boolean> {
  const role = await session.effectivePageRole(request.authUser!, entry);
  const tokenMayWrite = request.tokenScopes === undefined || request.tokenScopes.includes('write');
  return session.roleAtLeast(role, 'editor') && tokenMayWrite;
}

export function registerPropertiesRoutes(app: FastifyInstance): void {
  app.get('/api/pages/:id/properties', async (request) => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'viewer');
    return readPageProperties(entry, await mayEdit(request, entry));
  });

  app.put('/api/pages/:id/properties', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parseBody(updatePagePropertiesBodySchema, request.body);
    const entry = await session.requirePageRole(request, id, 'editor');
    session.requireWriteScope(request);
    if (propertiesStoreOf(entry.kind) === 'none') throw badRequest('this page has no properties');
    try {
      const result = await savePageProperties(entry, request.authUser!, body);
      return result.response;
    } catch (err) {
      if (err instanceof PropertiesConflictError) return reply.status(409).send({ error: err.message, ...err.current });
      throw err;
    }
  });

  // Owner, deadline and "Mark as verified" (shared/verification.ts): a merge into the page's own properties.
  app.put('/api/pages/:id/verification', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parseBody(updateVerificationBodySchema, request.body);
    const entry = await session.requirePageRole(request, id, 'editor');
    session.requireWriteScope(request);
    try {
      return await updateVerification(entry, request.authUser!, body);
    } catch (err) {
      if (err instanceof PropertiesConflictError) return reply.status(409).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/spaces/:space/property-types', async (request) => {
    const { space } = request.params as { space: string };
    await session.requireSpaceRole(request, space, 'viewer');
    return readSpacePropertyTypes(space, userViewer(request.authUser!));
  });

  app.put('/api/spaces/:space/property-types', async (request) => {
    const { space } = request.params as { space: string };
    const user = request.authUser!;
    assertNotDemoAccount(user, 'Editing property types');
    session.requireCookieAuth(request);
    await session.requireSpaceRole(request, space, 'admin');
    session.requireWriteScope(request);
    const body = parseBody(updatePropertyTypesBodySchema, request.body);
    const written = await writeSpacePropertyTypes(space, { name: user.name, email: user.email }, body.types);
    if (written) recordAudit(user.id, 'space.property-types', space, { keys: Object.keys(body.types).sort() });
    return readSpacePropertyTypes(space, userViewer(user));
  });
}
