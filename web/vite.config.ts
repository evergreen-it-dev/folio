import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { offlineReaderWorker } from './pwa/buildWorker';
import { sentryVitePlugin } from '@sentry/vite-plugin';

// Source maps for Sentry (docs/DEPLOYMENT-PAAS.md "Sentry"). They are produced and uploaded ONLY when the build is
// given a token, the org and the project slug AND a release name; otherwise the build is exactly what it was and no
// .map file exists. After the upload the maps are deleted from dist, so they are never served to the public.
//   SENTRY_AUTH_TOKEN   an org auth token with release/sourcemap upload rights (a build secret, never an image layer)
//   SENTRY_ORG, SENTRY_PROJECT   the slugs
//   SENTRY_URL          the region host, e.g. https://de.sentry.io (the default is sentry.io, the US region)
//   FOLIO_RELEASE       the release name; must equal what the server reports (the short git sha)
const env = process.env;
const sentryRelease = (env.SENTRY_RELEASE ?? env.FOLIO_RELEASE ?? '').trim();
const uploadSourceMaps = Boolean(env.SENTRY_AUTH_TOKEN && env.SENTRY_ORG && env.SENTRY_PROJECT && sentryRelease);
if (env.SENTRY_AUTH_TOKEN && !uploadSourceMaps) {
  console.warn('[sentry] SENTRY_AUTH_TOKEN is set but SENTRY_ORG, SENTRY_PROJECT or FOLIO_RELEASE is missing: source maps are NOT uploaded.');
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    react(),
    tailwindcss(),
    offlineReaderWorker(),
    ...(uploadSourceMaps
      ? [
          sentryVitePlugin({
            authToken: env.SENTRY_AUTH_TOKEN,
            org: env.SENTRY_ORG,
            project: env.SENTRY_PROJECT,
            ...(env.SENTRY_URL ? { url: env.SENTRY_URL } : {}),
            release: { name: sentryRelease },
            sourcemaps: { filesToDeleteAfterUpload: ['**/*.map'] },
            telemetry: false,
          }),
        ]
      : []),
  ],
  resolve: { alias: { '@shared': path.resolve(import.meta.dirname, '../shared') } },
  server: {
    port: 4871,
    proxy: {
      '/api': 'http://localhost:4870',
      '/files': 'http://localhost:4870',
      // OAuth for MCP: discovery documents, the consent screen, token endpoints.
      '/oauth/': 'http://localhost:4870',
      '/.well-known/': 'http://localhost:4870',
      '/mcp': 'http://localhost:4870',
      // QA-3 P2 #8 (dev only): a plain string key matches by PREFIX, not by
      // path segment, so '/a' swallowed EVERY url starting with those two
      // characters — `/admin/access`, `/admin/users`, `/admin/spaces` and any
      // `/a…` route all reached the API instead of the SPA and came back as
      // `404 {"error":"not found"}` in the browser. Production was never
      // affected (Fastify's own SPA fallback serves index.html there), which
      // is exactly why it survived: it only ever broke `npm run dev`. A RegExp
      // key anchors it to the real asset route, `/a/<sha>/<file>`.
      '^/a/': 'http://localhost:4870',
      // Artifacts: the sandboxed iframe's files (server/artifact/serve.ts).
      '^/art/': 'http://localhost:4870',
      '/collab': { target: 'ws://localhost:4870', ws: true },
    },
  },
  // `manifest`: the chunk graph, written next to the chunks. Offline mode reads
  // it to fetch, ahead of need, everything the board editor may load on demand
  // (web/src/app/offline/warmUp.ts) — without a network there is nowhere to
  // load a missing chunk from. Served from /assets/ like the chunks themselves,
  // but it is NOT content-hashed, so the server must not cache it as immutable
  // (server/index.ts).
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    manifest: 'assets/manifest.json',
    sourcemap: uploadSourceMaps ? 'hidden' : false,
    rolldownOptions: { input: ['index.html', 'offline.html'].map((file) => path.resolve(import.meta.dirname, file)) },
  },
});
