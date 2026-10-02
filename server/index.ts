import Fastify from 'fastify';
// These @fastify/* plugins are CJS (`export =`); this project has no
// esModuleInterop, so import the namespace and pull out `.default` (typed as
// a plain callable plugin, unlike the namespace binding itself).
import * as fastifyCorsModule from '@fastify/cors';
import * as fastifyMultipartModule from '@fastify/multipart';
import * as fastifyStaticModule from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import * as fastifyCookieModule from '@fastify/cookie';
import { SERVER_PORT } from '../shared/contracts.js';
import { loadEnv } from './env.js';
import { HttpError } from './errors.js';
import * as storage from './storage.js';
import * as collab from './collab.js';
import { registerRoutes, registerPublicShareRoutes, registerPublicInviteRoutes } from './routes.js';
import { registerTableRoutes } from './tables/routes.js';
import { registerFormRoutes, registerPublicFormRoutes } from './forms/routes.js';
import { registerExportRoutes, registerPublicExportRoutes } from './export/routes.js';
import { registerAccessRoutes } from './access/routes.js';
import { registerTrashRoutes } from './trash/routes.js';
import { registerPageChangeRoutes } from './pageChangesRoutes.js';
import { registerAssistantRoutes } from './assistant/routes.js';
import { registerAssistantAdminRoutes } from './assistant/adminRoutes.js';
import { registerNotificationRoutes } from './notifications/routes.js';
import * as notificationSocket from './notifications/socket.js';
import { startTreeSignal, stopTreeSignal } from './treeSignal.js';
import * as assistantRuns from './assistant/runs.js';
import { buildFolioMcpServer } from './mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as session from './auth/session.js';
import { registerPublicAuthRoutes, registerProtectedAuthRoutes } from './auth/routes.js';
import { registerGoogleAuthRoutes } from './auth/google.js';
import { importJsonIfNeeded } from './auth/importJson.js';
import { ensurePgReachable, getPool, closePool } from './db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { getRedis, closeRedis } from './db/redis.js';
import { registerAssetRoute } from './assetRoute.js';
import { registerFileRoutes } from './fileAccess.js';
import { ensureAskpassScript } from './gitCredentials.js';
import { startPeriodicFetchForAllSpaces, stopAllPeriodicFetch, flushAllPendingSyncs } from './gitSync.js';
import { stopGitTreeCache } from './gitTree.js';
import { shouldServeSpaFallback, spaStaticOptions } from './spaFallback.js';
import { matchShareRoute, renderShareIndexHtml } from './shareMeta.js';
import { publicUrlOrOrigin } from './publicUrl.js';
import { runBootScan } from './bootScan.js';

loadEnv();

const fastifyCors = fastifyCorsModule.default;
const fastifyMultipart = fastifyMultipartModule.default;
const fastifyStatic = fastifyStaticModule.default;
const fastifyCookie = fastifyCookieModule.default;

// `PORT` overrides the shared SERVER_PORT contract for THIS process only — used to run a
// second, disposable instance for smoke-testing while another one (e.g. `npm run dev`) is
// already bound to the default port. The contract itself (and the web dev proxy) is untouched.
const PORT = process.env.PORT ? Number(process.env.PORT) : SERVER_PORT;

const app = Fastify({ logger: true });
app.decorateRequest('authUser', null);

app.setErrorHandler((err, request, reply) => {
  if (err instanceof HttpError) {
    reply.status(err.status).send({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : 'invalid request';
  // fastify's own body/schema validation errors carry a `validation` array.
  if ((err as { validation?: unknown }).validation) {
    reply.status(400).send({ error: message });
    return;
  }
  // Fastify's own built-in errors (malformed JSON body, unsupported media type,
  // payload too large, etc. — e.g. FST_ERR_CTP_INVALID_JSON_BODY) already carry
  // the right client-error status on `statusCode`; respect it instead of
  // reporting every non-HttpError as a misleading 500.
  const fastifyStatus = (err as { statusCode?: number }).statusCode;
  if (fastifyStatus && fastifyStatus >= 400 && fastifyStatus < 500) {
    reply.status(fastifyStatus).send({ error: message });
    return;
  }
  request.log.error(err);
  reply.status(500).send({ error: 'internal server error' });
});

let spaFallbackRoot: string | null = null;

app.setNotFoundHandler(async (request, reply) => {
  if (!spaFallbackRoot || !shouldServeSpaFallback(request.raw.method, request.url)) {
    reply.status(404).send({ error: 'not found' });
    return;
  }
  const indexPath = path.join(spaFallbackRoot, 'index.html');
  // /share/:token(/p/:pageId) is the ONE ordinary SPA route needing more than
  // a static file read — see shareMeta.ts. Every other fallback (the vast
  // majority of hits: `/`, every authenticated client route, ...) keeps the
  // exact sync Buffer read this always did; matchShareRoute is a single
  // regex test, so a non-share 404/route never pays for the DB lookup below.
  const pathname = request.url.split('?')[0];
  const shareMatch = matchShareRoute(pathname);
  if (!shareMatch) {
    reply.type('text/html').send(fs.readFileSync(indexPath));
    return;
  }
  // Share links are unlisted, not public — same header the JSON share
  // endpoint sets (routes.ts's registerPublicShareRoutes), now also on the
  // HTML a preview bot/crawler actually fetches for these routes.
  reply.header('X-Robots-Tag', 'noindex');
  const origin = publicUrlOrOrigin(`${request.protocol}://${request.hostname}`);
  const html = await renderShareIndexHtml(fs.readFileSync(indexPath, 'utf8'), pathname, `${origin}${request.url}`);
  reply.type('text/html').send(html);
});

async function main(): Promise<void> {
  // PostgreSQL is the core database (DEV-PLAN round 4): fail fast with a clear hint rather
  // than limping along and failing confusingly on the first request.
  await ensurePgReachable().catch((err: Error) => {
    throw new Error(`${err.message}\n(server refusing to start — Folio's storage layer requires PostgreSQL)`);
  });
  await runMigrations(getPool());
  // A `running` ai_runs row with no in-memory RunState behind it (runs.ts) is
  // a run this process died mid-turn — mark it `error` so it doesn't sit
  // "running" forever after a restart (05.09.2026, continuous runs).
  await assistantRuns.recoverAfterRestart();

  // Redis is best-effort (transient-only: rate limiting, advisory locks) — instantiate it but
  // never block boot on it; server/db/redis.ts degrades every caller gracefully if it's down.
  getRedis();

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyMultipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  // Populates request.cookies for every route (public and protected) — /api/auth/state
  // needs to read the session cookie without requiring one, so this is registered globally
  // rather than only inside the protected scope below.
  await app.register(fastifyCookie);

  // --- Public: health + the auth gate's own three routes ------------------
  app.get('/api/health', async () => ({ ok: true }));
  registerPublicAuthRoutes(app);
  // Round 32: GET /api/auth/google/start, GET /api/auth/google/callback —
  // "Sign in with Google", same public trust boundary as login above.
  registerGoogleAuthRoutes(app);
  // Round 8: GET /api/share/:token, PUT /api/share/:token/board — no session
  // at all, same public scope as the auth routes above.
  registerPublicShareRoutes(app);
  // Round 9: GET /api/invite/:token, POST /api/invite/:token/accept — same.
  registerPublicInviteRoutes(app);
  // Round 23: GET /share/:token.md — raw markdown for an AI agent/script, same
  // public trust boundary as the share routes above (token IS the auth).
  registerPublicExportRoutes(app);
  // Round FORMS: POST /api/forms/:id/submit — same "must reach an anonymous
  // share-link guest" reasoning as the share routes above; the handler does
  // its own session-or-share-token check (see server/forms/routes.ts).
  registerPublicFormRoutes(app);

  // Round 8 follow-up (prod bug: images inside a shared page were 401ing for a
  // guest — this route used to live inside the session-gated scope below).
  // GET /a/:sha/:filename is keyed purely by a 64-hex SHA-256 content hash
  // (assets.getAsset itself rejects anything not matching that shape) with NO
  // space/page association stored anywhere — the hash IS the access control,
  // exactly the same "unguessable capability URL" trust model the share token
  // uses. A shared page's rendered <img>/<a> tags point straight at this URL
  // regardless of who's viewing it, so it has to work with no session.
  // TRADEOFF, explicit: anyone who obtains the exact /a/<sha>/<filename> URL
  // (page source, browser network tab, a forwarded link) can fetch that asset
  // indefinitely — with no session and, unlike a share link, no revocation
  // path short of deleting the asset row itself. Accepted for the same reason
  // an inline image in an emailed PDF or a shared Google Doc is: the asset
  // was already handed to the page's recipient by design; this only removes
  // the redundant SEPARATE credential check for fetching what the page
  // already links to.
  // The response type/disposition/CSP come from the bytes (server/safeServe.ts),
  // never from the MIME type the uploader claimed — see assetRoute.ts.
  registerAssetRoute(app);

  // Round 8 follow-up: /files/<space>/<path> accepts a share token (?share=)
  // as an alternative to a session. Its own scope — deliberately NOT inside
  // protectedScope below — because that scope's blanket requireSession hook
  // runs first and would 401 a guest before this route ever got a chance to
  // check the token; onRequest hooks apply by registration scope, not route
  // order, so the only way to let a guest in here is to never put this route
  // under that blanket hook in the first place.
  // Who may read which file — page access for a session, the share's own
  // page set for a guest, no dotfiles/.git ever — is server/fileAccess.ts.
  await app.register(registerFileRoutes);

  // --- MCP (round 7): PAT Bearer ONLY, cookie sessions rejected ------------
  // Registered outside the protected scope below (which accepts cookie OR
  // PAT) — this mount does its own auth check instead of session.requireSession,
  // since MCP must reject a cookie session even though requireSession would
  // happily accept it. Stateless Streamable HTTP (no sessionIdGenerator): a
  // fresh McpServer + transport per POST, matching the SDK's own reference
  // implementation (dist/esm/examples/server/simpleStatelessStreamableHttp.js)
  // — see server/mcp.ts's module doc comment for why not one shared instance.
  app.post('/mcp', async (request, reply) => {
    const resolved = await session.resolvePatOnly(request);
    if (!resolved) {
      reply.status(401).send({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'authentication required: Authorization: Bearer folio_pat_... ' },
        id: null,
      });
      return;
    }
    reply.hijack();
    const server = buildFolioMcpServer({ user: resolved.user, scopes: resolved.tokenScopes ?? [], tokenId: resolved.tokenId! });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
      reply.raw.on('close', () => {
        void transport.close();
        void server.close();
      });
    } catch (err) {
      app.log.error(err);
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'internal server error' }, id: null }));
      }
    }
  });
  // Stateless mode has no session to stream (GET) or terminate (DELETE) — same
  // 405 the SDK's own stateless example returns for both.
  app.get('/mcp', async (request, reply) => {
    const resolved = await session.resolvePatOnly(request);
    if (!resolved) {
      reply.status(401).send({ jsonrpc: '2.0', error: { code: -32001, message: 'authentication required' }, id: null });
      return;
    }
    reply.status(405).send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  });
  app.delete('/mcp', async (request, reply) => {
    const resolved = await session.resolvePatOnly(request);
    if (!resolved) {
      reply.status(401).send({ jsonrpc: '2.0', error: { code: -32001, message: 'authentication required' }, id: null });
      return;
    }
    reply.status(405).send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  });

  // --- Everything else: session required ----------------------------------
  // A Fastify child scope, not registration order, is what actually exempts
  // the routes above: onRequest hooks apply to every route in this scope
  // (and its children) regardless of where in the file they're registered,
  // so `requireSession` must live on its OWN scope that the public routes
  // are never part of.
  await app.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', session.requireSession);

    // /files/<space>/... (share-token-or-session) and /a/:sha/:filename (fully
    // public) both moved OUT of this scope in round 8's follow-up — see the
    // dedicated filesScope above and the public /a/ route above that, plus
    // their doc comments for why each had to leave this blanket-requireSession
    // scope specifically.

    registerProtectedAuthRoutes(protectedScope);
    registerRoutes(protectedScope);
    // R26/R23/R27: each round owns its own route module (server/tables,
    // server/export, server/access) instead of growing server/routes.ts —
    // see DEV-PLAN.md's "Round 26" for why (that file is the single biggest
    // source of merge conflicts across parallel rounds). One line each, added
    // once by the orchestrator; the round's own agents never touch this file.
    registerTableRoutes(protectedScope);
    registerFormRoutes(protectedScope);
    registerExportRoutes(protectedScope);
    registerAccessRoutes(protectedScope);
    registerTrashRoutes(protectedScope);
    registerPageChangeRoutes(protectedScope);
    registerAssistantRoutes(protectedScope);
    registerAssistantAdminRoutes(protectedScope);
    registerNotificationRoutes(protectedScope);
  });

  // Production: the built SPA is served by this same process (Docker image has no
  // separate web server). Static assets under /assets/* plus an index.html fallback
  // for client-side routes; API/collab/files/asset routes above always win because
  // the fallback only runs from the not-found handler.
  if (process.env.NODE_ENV === 'production') {
    const distRoot = path.resolve(import.meta.dirname, '../web/dist');
    await app.register(fastifyStatic, spaStaticOptions(distRoot));
    spaFallbackRoot = distRoot;
  }

  await ensureAskpassScript();

  // Boot scan (storage.scanAllSpaces): migrates any leftover data/spaces/<slug> into
  // data/repos/<slug> (git-initializing it), registers every data/repos dir not yet in
  // the `spaces` table (round 3), then indexes every space. This populates `spaces` +
  // `pages_index` from disk FIRST — the one-shot JSON import inserts space_members rows
  // that have a foreign key on spaces(slug), so the spaces registry must already exist
  // by the time it runs.
  //
  // Incident 15.09: this used to await the WHOLE scan — every space's pages —
  // before app.listen, in one unguarded loop. When re-indexing got heavy and a
  // single space's scan threw, main() rejected and the process died before ever
  // opening its port, on every restart and every image. Now only the registry
  // (fast, and what importJsonIfNeeded/periodic fetch/collab lookups need) runs
  // before listen; page indexing runs after, per space and isolated — see
  // server/bootScan.ts.
  const spacesToIndex = await storage.prepareSpacesRegistry();
  await importJsonIfNeeded();
  await startPeriodicFetchForAllSpaces();

  collab.initCollab();

  await app.listen({ port: PORT, host: process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1' });
  collab.attachToServer(app.server);
  // Round 31: a second 'upgrade' listener — the /events socket. Both return
  // early for a path that is not theirs, so the order here does not matter (see notifications/socket.ts).
  notificationSocket.attachToServer(app.server);
  // The sidebar's live "tree changed" signal rides on that same socket — see server/treeSignal.ts.
  // Not awaited past its first attempt and never fatal: without it the sidebar still refetches on focus and by the poll.
  await startTreeSignal();

  // Deliberately not awaited: the server is up and serving while this catches up.
  void runBootScan(spacesToIndex);
}

// A rejection nobody handled used to end the process silently from Node's side
// and invisibly from ours (no host logs reachable). Record it; don't die for it.
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[process] unhandled rejection:', reason);
});
// A genuine uncaught exception leaves the process in an unknown state, so it
// still exits — but only after saying what it was.
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('[process] uncaught exception:', err);
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`received ${signal}, flushing collab writes and pending git syncs before shutdown`);
  stopAllPeriodicFetch();
  try {
    await collab.flushAll();
    await flushAllPendingSyncs();
    // Round 19: removes every cached GET /api/git/tree shallow clone's temp
    // dir under os.tmpdir() rather than leaving them for the next boot.
    await stopGitTreeCache();
  } catch (err) {
    app.log.error(err);
  }
  await stopTreeSignal();
  await app.close();
  await closePool().catch(() => {});
  await closeRedis().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
