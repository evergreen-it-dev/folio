/**
 * Per-test-run PostgreSQL isolation (DEV-PLAN round 4 tests: "a separate
 * schema ... per run, cleaned up afterwards"). Call `setUpTestSchema()` from a test
 * file's own `beforeAll`, and the returned teardown from `afterAll`.
 *
 * Works because server/db/pool.ts's getPool() is lazy — it only reads
 * process.env.DB_SCHEMA the first time a query actually runs, not at
 * import time — so setting the env var here, before any test body has made
 * a real query, is enough to redirect that whole test file's pool at an
 * isolated schema. vitest gives each test file its own module registry, so
 * the pool singleton (and this env var) never leaks across files.
 */
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import * as fs from 'node:fs/promises';
import { loadEnv } from '../env.js';
import { runMigrations } from '../../db/migrate.js';

export async function setUpTestSchema(): Promise<() => Promise<void>> {
  loadEnv();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set — PG integration tests need a real local PostgreSQL (see .env)');

  const schema = `test_${randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.end();

  process.env.DB_SCHEMA = schema;
  const { getPool } = await import('./pool.js');
  await runMigrations(getPool());

  return async () => {
    const { closePool } = await import('./pool.js');
    await closePool();
    delete process.env.DB_SCHEMA;

    const cleanup = new Pool({ connectionString });
    await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
    await cleanup.end();
  };
}

/**
 * Deletes a test-created space's `spaces` row (cascading to space_members/
 * pages_index/links/ydoc_state) AND its data/repos/<slug> directory —
 * together, always. `fs.rm(storage.getRepoDir(slug), ...)` alone (a pattern
 * that crept into a lot of test cleanup before this helper existed) only
 * ever removes the directory; the DB row survives unless something else
 * separately prunes it (e.g. storage.deletePage's rescan-detects-missing-
 * file path, which most space-level cleanup never goes through). Inside a
 * setUpTestSchema()-isolated schema this is mostly hygiene — DROP SCHEMA
 * CASCADE above wipes every row in it regardless, test-by-test cleanup or
 * not — but the identical "just fs.rm the directory" pattern, copy-pasted
 * into an ad hoc live-verification script running against the REAL
 * 'public' schema (not a test file), leaves a permanent stale row behind.
 * Use this instead, in both contexts.
 */
export async function deleteTestSpace(slug: string): Promise<void> {
  const { query } = await import('./pool.js');
  const storage = await import('../storage.js');
  await query('DELETE FROM spaces WHERE slug = $1', [slug]).catch(() => {});
  await fs.rm(storage.getRepoDir(slug), { recursive: true, force: true }).catch(() => {});
}
