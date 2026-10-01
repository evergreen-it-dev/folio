/**
 * Minimal .env loader — no `dotenv` dependency (none is preinstalled).
 * Populates process.env for any key not already set there, so a real
 * environment variable always wins over the .env file. Synchronous and
 * idempotent so it's safe to call at the top of any entry point
 * (server/index.ts, db/migrate.ts, test setup) before anything else reads
 * process.env.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(root, '.env'), 'utf8');
  } catch {
    return; // no .env file present; rely on real environment variables only
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
