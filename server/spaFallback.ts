/**
 * Decides whether a GET request that matched no route should fall back to
 * the SPA's index.html (client-side routing) or stay a plain 404.
 *
 * Split out of index.ts so this one small decision is unit-testable without
 * booting the whole server (index.ts calls `main()` — real PG, real Redis —
 * unconditionally at module load, which is exactly right for an entrypoint
 * and exactly wrong for `import`ing it from a test).
 */
import type { FastifyStaticOptions } from '@fastify/static';

// Prefixes that must NEVER fall back to index.html even though nothing above
// claimed the route. `/api|/files|/a|/collab` are existing server routes —
// their 404 is already meaningful. `/assets/` is the one that mattered less
// obviously (found in prod): it's the built SPA's OWN hashed chunk directory
// (web/dist/assets — every lazy `import()` lands there: mermaid diagram
// types, TableGrid, BoardCanvas, ...). Every deploy replaces those hashes, so
// a tab left open across a deploy can ask for a chunk that's simply gone
// from disk. Before this list included it, that request fell through to the
// SPA fallback below and got back index.html with HTTP 200 — which the
// browser dutifully tried to run as a JS/CSS module, producing an
// inscrutable "Failed to fetch dynamically imported module" instead of a
// clean 404 the client can actually detect and recover from (see
// web/src/app/stale-chunk.ts).
const NEVER_SPA_FALLBACK = ['/api/', '/files/', '/a/', '/collab', '/assets/'];

export function shouldServeSpaFallback(method: string | undefined, url: string): boolean {
  if (method !== 'GET') return false;
  return !NEVER_SPA_FALLBACK.some((prefix) => url.startsWith(prefix));
}

/**
 * Vite names every chunk and asset after its content: `index-C25_wABs.js`,
 * `Assistant-Bold-gm-uSS1B.woff2`. A different content is a different name,
 * so such a file never changes and may be cached for good.
 *
 * It used to go out as `max-age=0`: the browser kept a copy but had to ask
 * the server before every use — which, without a network, is a failure. The
 * board editor could therefore never be opened offline, however many times
 * it had been opened before (29.09.2026).
 *
 * NOT everything under /assets/ is content-hashed: `manifest.json`
 * (vite.config.ts `build.manifest`) keeps its name across deploys and must
 * be asked for every time, like index.html.
 */
export function isContentHashedAsset(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  if (!/(^|\/)assets\//.test(normalized)) return false;
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  return /-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/.test(name);
}

/** `Cache-Control` for a file of the built SPA. */
export function spaCacheControl(filePath: string): string {
  return isContentHashedAsset(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache';
}

/**
 * How @fastify/static serves the built SPA (web/dist) at `/`. Lives here so a
 * test can mount exactly what production mounts.
 *
 * `setHeaders` receives the Fastify reply since @fastify/static 10 (it used to
 * be the raw Node response, with `setHeader`) and runs after the plugin set
 * its own headers, so what it sets wins. `cacheControl: false` keeps the
 * plugin from adding its own `Cache-Control` first.
 */
export function spaStaticOptions(root: string): FastifyStaticOptions {
  return {
    root,
    prefix: '/',
    decorateReply: false,
    index: ['index.html'],
    // Content-hashed chunks are immutable; index.html and the build
    // manifest are revalidated every time — see spaCacheControl.
    cacheControl: false,
    setHeaders: (reply, filePath) => {
      reply.header('Cache-Control', spaCacheControl(filePath));
    },
  };
}
