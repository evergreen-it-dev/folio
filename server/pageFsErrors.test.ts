/**
 * Sentry 500s turned into proper statuses: a page folder path taken by a FILE
 * answers 409 (create and move), and a page whose file vanished under the index
 * row answers 404. Real PG + real files, through storage.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as authStore from './auth/store.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import * as storage from './storage.js';

const statusOf = async (p: Promise<unknown>): Promise<number | undefined> => {
  try {
    await p;
  } catch (err) {
    return err instanceof HttpError ? err.status : -1;
  }
  return undefined;
};

describe('page fs errors map to 409/404 (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let slug: string;
  let dir: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const owner = await authStore.createUser({ email: `fserr-${Date.now()}@example.com`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    slug = (await storage.createSpace(`FsErr ${Date.now()}`, owner.id)).slug;
    dir = storage.getSpaceDir(slug);
  });
  afterAll(async () => {
    await deleteTestSpace(slug);
    await teardownSchema();
  });

  it('creating a page under a path that is a file answers 409', async () => {
    await fs.writeFile(path.join(dir, 'taken'), 'not a folder', 'utf8');
    expect(await statusOf(storage.createPage({ space: slug, parentPath: 'taken', title: 'X', kind: 'doc' }))).toBe(409);
    expect(await statusOf(storage.createPage({ space: slug, parentPath: 'taken/deeper', title: 'X', kind: 'doc' }))).toBe(409);
  });

  it('moving a page to a parent path that is a file answers 409 and leaves the page where it was', async () => {
    await fs.writeFile(path.join(dir, 'blocker'), 'not a folder', 'utf8');
    const page = await storage.createPage({ space: slug, parentPath: '', title: 'Mover', kind: 'doc' });
    expect(await statusOf(storage.movePageTracked(page.id, 'blocker'))).toBe(409);
    expect((await storage.requireEntry(page.id)).relPath).toBe(page.path);
    await fs.access(path.join(dir, page.path));
  });

  it('reading the body of a page whose file vanished answers 404', async () => {
    const page = await storage.createPage({ space: slug, parentPath: '', title: 'Ghost', kind: 'doc' });
    await fs.rm(path.join(dir, page.path));
    expect(await statusOf(storage.readFreshDocBody(page.id))).toBe(404);
  });
});
