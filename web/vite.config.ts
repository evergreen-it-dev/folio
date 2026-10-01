import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@shared': path.resolve(import.meta.dirname, '../shared') } },
  server: {
    port: 4871,
    proxy: {
      '/api': 'http://localhost:4870',
      '/files': 'http://localhost:4870',
      // QA-3 P2 #8 (dev only): a plain string key matches by PREFIX, not by
      // path segment, so '/a' swallowed EVERY url starting with those two
      // characters — `/admin/access`, `/admin/users`, `/admin/spaces` and any
      // `/a…` route all reached the API instead of the SPA and came back as
      // `404 {"error":"not found"}` in the browser. Production was never
      // affected (Fastify's own SPA fallback serves index.html there), which
      // is exactly why it survived: it only ever broke `npm run dev`. A RegExp
      // key anchors it to the real asset route, `/a/<sha>/<file>`.
      '^/a/': 'http://localhost:4870',
      '/collab': { target: 'ws://localhost:4870', ws: true },
    },
  },
  // `manifest`: the chunk graph, written next to the chunks. Offline mode reads
  // it to fetch, ahead of need, everything the board editor may load on demand
  // (web/src/app/offline/warmUp.ts) — without a network there is nowhere to
  // load a missing chunk from. Served from /assets/ like the chunks themselves,
  // but it is NOT content-hashed, so the server must not cache it as immutable
  // (server/index.ts).
  build: { outDir: 'dist', emptyOutDir: true, manifest: 'assets/manifest.json' },
});
