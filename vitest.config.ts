import { defineConfig } from 'vitest/config';
import path from 'node:path';

// @shared works in tsc (paths) and in vite (resolve.alias in web/vite.config.ts);
// without this alias vitest fails on value imports from shared/contracts.
export default defineConfig({
  resolve: {
    alias: { '@shared': path.resolve(import.meta.dirname, 'shared') },
  },
  test: {
    // server/db/testSchema.ts's per-test-file PG isolation works by setting
    // process.env.DB_SCHEMA before that file's first query — but process.env
    // is a single object shared by the whole OS process, not scoped per test
    // file. When vitest runs multiple test files CONCURRENTLY (its default),
    // two files' async beforeAll hooks can interleave and race on that one
    // global: file A sets DB_SCHEMA='test_A', then awaits something; file B's
    // beforeAll runs in that gap and sets DB_SCHEMA='test_B' before file A's
    // OWN first real query — file A's connection pool (server/db/pool.ts is
    // ALSO a lazy singleton, memoized on first use) then gets built against
    // file B's schema. Fast/synchronous tests rarely hit the gap; a test
    // doing real async work with real timing (e.g. server/shareCollab.test.ts,
    // a real WS server + real clients + a real debounced write-back) hits it
    // often enough to be genuinely flaky — confirmed by instrumenting
    // collab.ts's write-back path: it fired, but storage.getEntry() came back
    // undefined for a page id that very much existed, in the OTHER file's
    // schema. Serializing test FILES (not the tests within one file) closes
    // the race outright, for every current and future PG-backed test, not
    // just this one — the full suite still runs in single-digit seconds.
    fileParallelism: false,
  },
});
