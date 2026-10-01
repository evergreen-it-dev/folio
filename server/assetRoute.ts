import type { FastifyInstance } from 'fastify';
import * as assets from './assets.js';
import { notFound } from './errors.js';
import { serveHeaders } from './safeServe.js';

/**
 * GET /a/:sha/:filename — the public attachment route (see the long comment
 * at its registration in server/index.ts for why it takes no session).
 * Lives in its own module so a test can mount it on a bare Fastify app.
 *
 * Whoever uploaded a file chose its bytes, its name and its claimed MIME
 * type, and this route serves it on Folio's own origin — so none of those
 * decides the response headers. safeServe.ts derives them from the bytes:
 * verified rasters and PDF inline, SVG inline under a sandboxing CSP, every
 * other file an opaque download (F-04).
 */
export function registerAssetRoute(app: FastifyInstance): void {
  app.get('/a/:sha/:filename', async (request, reply) => {
    const { sha } = request.params as { sha: string; filename: string };
    const asset = await assets.getAsset(sha);
    if (!asset) throw notFound('asset');
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.headers(serveHeaders(asset.filename, asset.data));
    return reply.send(asset.data);
  });
}
