/**
 * Migration runner (pattern mirrors a sibling project's db/migrate.ts): ensures
 * schema_migrations exists, applies every not-yet-applied db/migrations/*.sql
 * file in lexicographic order inside its own transaction, and records it.
 * Re-running does nothing once everything is applied. No automatic rollback
 * — a down-migration is a new numbered file.
 *
 * `runMigrations(pool)` is exported so both `server/index.ts` (boot) and the
 * vitest PG test helper (a freshly-created per-run schema) can call it
 * directly against a pool that's already pointed at the right
 * database/search_path, instead of shelling out to this file as a script.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

async function listMigrationFiles(): Promise<string[]> {
  try {
    const entries = await readdir(migrationsDir);
    return entries.filter((name) => name.endsWith('.sql')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function runMigrations(pool: Pool): Promise<{ applied: string[] }> {
  const client = await pool.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       );`,
    );

    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.name));
    const pending = (await listMigrationFiles()).filter((file) => !applied.has(file));

    for (const file of pending) {
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        // eslint-disable-next-line no-console
        console.log(`[migrate] applied ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    return { applied: pending };
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const { loadEnv } = await import('../server/env.js');
  loadEnv();
  const { Pool } = await import('pg');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const pool = new Pool({ connectionString });
  try {
    const { applied } = await runMigrations(pool);
    if (applied.length === 0) console.log('[migrate] no pending migrations');
  } finally {
    await pool.end();
  }
}

// Only run as a script (`node db/migrate.ts` / `tsx db/migrate.ts`), never on import.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error('[migrate] failed:', error);
    process.exitCode = 1;
  });
}
