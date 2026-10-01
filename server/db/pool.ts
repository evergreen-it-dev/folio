/**
 * PostgreSQL connection pool + query helpers. Lazy singleton: getPool()
 * reads DATABASE_URL (and the optional DB_SCHEMA test override) the first
 * time it's actually needed, not at module-import time, so a test file can
 * set process.env.DB_SCHEMA before its first query and get an isolated
 * per-run schema (CREATE SCHEMA test_xxx + this pool's search_path) without
 * this module needing to know anything about tests.
 */
import { Pool, type PoolClient } from 'pg';
import { loadEnv } from '../env.js';

let pool: Pool | undefined;

function connectionOptions(): string | undefined {
  const schema = process.env.DB_SCHEMA;
  return schema ? `-c search_path=${schema},public` : undefined;
}

export function getPool(): Pool {
  if (!pool) {
    loadEnv();
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set (check .env)');
    pool = new Pool({ connectionString, options: connectionOptions() });
  }
  return pool;
}

export async function query<T extends object = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
  const res = await getPool().query(text, params);
  return res.rows as T[];
}

export async function queryOne<T extends object = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T | undefined> {
  const rows = await query<T>(text, params);
  return rows[0];
}

/** Runs `fn` inside a BEGIN/COMMIT, ROLLBACK on throw. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url;
  }
}

/** Fail-fast connectivity check — call once at boot (DEV-PLAN: "PG unreachable -> fail-fast with a clear hint"). */
export async function ensurePgReachable(): Promise<void> {
  try {
    await getPool().query('SELECT 1');
  } catch (err) {
    const url = process.env.DATABASE_URL ?? '(DATABASE_URL is not set)';
    throw new Error(
      `Cannot reach PostgreSQL at ${redact(url)}. Is it running? Try: docker compose up -d\n` + `Original error: ${(err as Error).message}`,
    );
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
