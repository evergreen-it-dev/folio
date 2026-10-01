/**
 * One-shot JSON -> PostgreSQL import (DEV-PLAN round 4): if PG has zero
 * users AND data/system/*.json (round 2's storage format) exist, imports
 * users/sessions/memberships/stars and renames the json files to *.imported
 * so this never runs again. Existing ids are preserved (not regenerated) so
 * sessions/memberships/stars, which reference a userId, stay consistent
 * with the imported users.
 *
 * Must run AFTER storage.scanAllSpaces() in index.ts's boot sequence:
 * space_members.space_slug has a foreign key on spaces(slug), and
 * scanAllSpaces() is what populates that registry from the on-disk
 * directories — importing memberships first would violate the FK for every
 * row.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, queryOne } from '../db/pool.js';

const AUTH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/system');
const JSON_FILES = ['users.json', 'sessions.json', 'memberships.json', 'stars.json'] as const;

interface JsonUser {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  isAdmin: boolean;
  disabled?: boolean;
  createdAt: string;
}
interface JsonSessionRecord {
  userId: string;
  createdAt: string;
  expiresAt: string;
}
type JsonMemberships = Record<string, Record<string, string>>; // space slug -> userId -> role
interface JsonStars {
  spaces: string[];
  pages: string[];
}
type JsonStarsFile = Record<string, JsonStars>; // userId -> stars

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function importJsonIfNeeded(): Promise<void> {
  const countRow = await queryOne<{ count: string }>('SELECT COUNT(*) FROM users');
  if (Number(countRow?.count ?? '0') > 0) return; // PG already has users: never import, even if the json files are still there

  const usersPath = path.join(AUTH_DIR, 'users.json');
  const users = await readJsonIfExists<JsonUser[]>(usersPath);
  if (!users || users.length === 0) return; // nothing to import

  // eslint-disable-next-line no-console
  console.log(`[import] migrating ${users.length} user(s) from data/system/*.json into PostgreSQL`);

  for (const u of users) {
    await query(
      `INSERT INTO users (id, email, name, password_hash, is_admin, disabled, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [u.id, u.email, u.name, u.passwordHash, u.isAdmin, u.disabled ?? false, u.createdAt],
    );
  }

  const sessions = await readJsonIfExists<Record<string, JsonSessionRecord>>(path.join(AUTH_DIR, 'sessions.json'));
  if (sessions) {
    let imported = 0;
    for (const [token, rec] of Object.entries(sessions)) {
      if (new Date(rec.expiresAt).getTime() <= Date.now()) continue; // skip already-expired sessions
      const tokenHash = createHash('sha256').update(token).digest('hex');
      await query(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4) ON CONFLICT (token_hash) DO NOTHING`,
        [tokenHash, rec.userId, rec.createdAt, rec.expiresAt],
      );
      imported++;
    }
    // eslint-disable-next-line no-console
    console.log(`[import] carried over ${imported} still-valid session(s) (old cookies keep working)`);
  }

  const memberships = await readJsonIfExists<JsonMemberships>(path.join(AUTH_DIR, 'memberships.json'));
  if (memberships) {
    for (const [space, roles] of Object.entries(memberships)) {
      for (const [userId, role] of Object.entries(roles)) {
        // A membership for a space slug with no matching `spaces` row (e.g. its on-disk
        // directory was removed between rounds) can't satisfy the FK — skip it rather
        // than fail the whole import.
        await query(
          `INSERT INTO space_members (space_slug, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (space_slug, user_id) DO NOTHING`,
          [space, userId, role],
        ).catch(() => {});
      }
    }
  }

  const stars = await readJsonIfExists<JsonStarsFile>(path.join(AUTH_DIR, 'stars.json'));
  if (stars) {
    for (const [userId, s] of Object.entries(stars)) {
      for (const slug of s.spaces ?? []) {
        await query(`INSERT INTO stars (user_id, kind, key) VALUES ($1, 'space', $2) ON CONFLICT DO NOTHING`, [userId, slug]).catch(() => {});
      }
      for (const pageId of s.pages ?? []) {
        await query(`INSERT INTO stars (user_id, kind, key) VALUES ($1, 'page', $2) ON CONFLICT DO NOTHING`, [userId, pageId]).catch(() => {});
      }
    }
  }

  for (const file of JSON_FILES) {
    const full = path.join(AUTH_DIR, file);
    await fs.rename(full, `${full}.imported`).catch(() => {});
  }
  // eslint-disable-next-line no-console
  console.log('[import] done — data/system/*.json renamed to *.imported');
}
