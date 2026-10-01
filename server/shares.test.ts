import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as authStore from './auth/store.js';
import * as shares from './shares.js';
import { query } from './db/pool.js';

describe('shares.ts (round 8, real PG)', () => {
  let teardownSchema: () => Promise<void>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  it('create -> list -> resolve -> revoke -> resolve fails, list no longer shows it', async () => {
    const user = await authStore.createUser({ email: 'sharer@shares-test.local', name: 'Sharer', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Share Lifecycle ${Date.now()}`, user.id);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Shared Doc', kind: 'doc' });

    const created = await shares.createShareLink(page.id, user.id, 'view', 'http://fallback.test');
    expect(created.mode).toBe('view');
    expect(created.createdBy).toBe('Sharer');
    expect(created.url).toMatch(/\/share\/[0-9a-f]{32}$/); // 32 hex chars, matches crypto.randomBytes(16).toString('hex')

    const token = created.url.split('/share/')[1];
    const resolved = await shares.resolveShareToken(token);
    expect(resolved?.pageId).toBe(page.id);
    expect(resolved?.mode).toBe('view');

    const list = await shares.listSharesForPage(page.id, 'http://fallback.test');
    expect(list.map((s) => s.id)).toEqual([created.id]);

    await shares.revokeShare(created.id);
    expect(await shares.resolveShareToken(token)).toBeUndefined(); // 404-equivalent at the resolver level
    expect(await shares.listSharesForPage(page.id, 'http://fallback.test')).toEqual([]);

    await deleteTestSpace(space.slug);
  });

  it('multiple share links on the same page keep independent modes and insertion order', async () => {
    const user = await authStore.createUser({ email: 'multi-share@shares-test.local', name: 'Multi', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Share Multi ${Date.now()}`, user.id);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Multi Shared', kind: 'doc' });

    const viewLink = await shares.createShareLink(page.id, user.id, 'view', 'http://fallback.test');
    const editLink = await shares.createShareLink(page.id, user.id, 'edit', 'http://fallback.test');

    const list = await shares.listSharesForPage(page.id, 'http://fallback.test');
    expect(list.map((s) => ({ id: s.id, mode: s.mode }))).toEqual([
      { id: viewLink.id, mode: 'view' },
      { id: editLink.id, mode: 'edit' },
    ]);

    await deleteTestSpace(space.slug);
  });

  it('PUBLIC_URL env var wins over the request-origin fallback when set', async () => {
    const user = await authStore.createUser({ email: 'pub-url@shares-test.local', name: 'PubUrl', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Share PubUrl ${Date.now()}`, user.id);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Pub Url', kind: 'doc' });

    const original = process.env.PUBLIC_URL;
    try {
      process.env.PUBLIC_URL = 'https://folio.example.com';
      const created = await shares.createShareLink(page.id, user.id, 'view', 'http://this-should-be-ignored.test');
      expect(created.url.startsWith('https://folio.example.com/share/')).toBe(true);

      delete process.env.PUBLIC_URL;
      const created2 = await shares.createShareLink(page.id, user.id, 'view', 'http://fallback-used.test');
      expect(created2.url.startsWith('http://fallback-used.test/share/')).toBe(true);
    } finally {
      if (original === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = original;
    }

    await deleteTestSpace(space.slug);
  });

  it('round 19: a schemeless PUBLIC_URL (Coolify SERVICE_FQDN_APP shape) is normalized to https:// instead of producing an unclickable relative link', async () => {
    const user = await authStore.createUser({ email: 'pub-url-schemeless@shares-test.local', name: 'PubUrlSchemeless', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Share PubUrl Schemeless ${Date.now()}`, user.id);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Pub Url Schemeless', kind: 'doc' });

    const original = process.env.PUBLIC_URL;
    try {
      process.env.PUBLIC_URL = 'folio.example.com'; // exactly the prod-observed shape -- no scheme
      const created = await shares.createShareLink(page.id, user.id, 'view', 'http://this-should-be-ignored.test');
      expect(created.url).toMatch(/^https:\/\/folio\.example\.com\/share\//);
    } finally {
      if (original === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = original;
    }

    await deleteTestSpace(space.slug);
  });

  it('deleting the page cascades to remove its share_links rows', async () => {
    const user = await authStore.createUser({ email: 'cascade@shares-test.local', name: 'Cascade', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Share Cascade ${Date.now()}`, user.id);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Will Be Deleted', kind: 'doc' });

    const created = await shares.createShareLink(page.id, user.id, 'edit', 'http://fallback.test');
    expect(await shares.resolveShareToken(created.url.split('/share/')[1])).toBeDefined();

    await storage.deletePage(page.id);

    const rows = await query('SELECT 1 FROM share_links WHERE id = $1', [created.id]);
    expect(rows.length).toBe(0);

    await deleteTestSpace(space.slug);
  });

  it('getShareForRevoke / revoke round-trip used by the DELETE route\'s creator-or-admin check', async () => {
    const user = await authStore.createUser({ email: 'revoke-check@shares-test.local', name: 'RevokeCheck', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Share Revoke Check ${Date.now()}`, user.id);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Revoke Check', kind: 'doc' });
    const created = await shares.createShareLink(page.id, user.id, 'view', 'http://fallback.test');

    const forRevoke = await shares.getShareForRevoke(created.id);
    expect(forRevoke?.createdBy).toBe(user.id);
    expect(forRevoke?.pageId).toBe(page.id);

    await shares.revokeShare(created.id);
    expect(await shares.getShareForRevoke(created.id)).toBeUndefined(); // already revoked -> not returned again

    await deleteTestSpace(space.slug);
  });
});
