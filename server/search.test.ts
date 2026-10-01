import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpTestSchema } from './db/testSchema.js';
import * as storage from './storage.js';
import { searchPages } from './search.js';
import * as authStore from './auth/store.js';

describe('search (real PG: tsvector/simple + unaccent + pg_trgm)', () => {
  let teardownSchema: () => Promise<void>;
  let memberId: string;
  let outsiderId: string;
  let spaceASlug: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();

    memberId = (await authStore.createUser({ email: 'member@search-test.local', name: 'Member', passwordHash: 'x', isAdmin: false })).id;
    outsiderId = (await authStore.createUser({ email: 'outsider@search-test.local', name: 'Outsider', passwordHash: 'x', isAdmin: false })).id;

    const spaceA = await storage.createSpace(`Search Test A ${Date.now()}`, memberId);
    spaceASlug = spaceA.slug;
    await authStore.setMembership(spaceASlug, memberId, 'admin'); // outsider is deliberately NOT added

    await storage.createPage({
      space: spaceASlug,
      parentPath: '',
      title: 'Roadmap Alpha',
      kind: 'doc',
    });
  });

  afterAll(async () => {
    const root = (await storage.listEntries(spaceASlug)).find((e) => e.dirPath === '' && e.isIndex);
    if (root) await storage.deletePage(root.id).catch(() => {});
    await teardownSchema();
  });

  it('a member sees hits from their own space', async () => {
    const hits = await searchPages('Roadmap', { userId: memberId });
    expect(hits.some((h) => h.title === 'Roadmap Alpha')).toBe(true);
  });

  it('a non-member sees NO hits from a space they cannot see — filtered in-query, not post-filtered', async () => {
    const hits = await searchPages('Roadmap', { userId: outsiderId });
    expect(hits.some((h) => h.space === spaceASlug)).toBe(false);
  });

  // Round 27 (access and rights): the old instance-admin search bypass is gone —
  // an instance-admin with NO explicit membership sees exactly what any other
  // non-member sees: nothing from a private space. `isAdmin` grants nothing
  // extra to search (spec-access.md §1/§2); SearchOptions no longer even
  // accepts an admin flag. See server/access/accessBoundary.test.ts's "path
  // 3" test for the full six-path acceptance version of this.
  it('an instance admin with NO explicit membership sees NOTHING from a private space — the old admin bypass is gone', async () => {
    const adminId = (await authStore.createUser({ email: 'admin@search-test.local', name: 'Admin', passwordHash: 'x', isAdmin: true })).id;
    const hits = await searchPages('Roadmap', { userId: adminId });
    expect(hits.some((h) => h.space === spaceASlug)).toBe(false);
  });

  it('a space with visibility "instance" is searchable by any active user, membership or not — including an instance-admin', async () => {
    const anyUserId = (await authStore.createUser({ email: 'any-instance-vis@search-test.local', name: 'Any', passwordHash: 'x', isAdmin: false })).id;
    const adminId = (await authStore.createUser({ email: 'admin2@search-test.local', name: 'Admin2', passwordHash: 'x', isAdmin: true })).id;
    await authStore.setSpaceVisibility(spaceASlug, 'instance');
    try {
      expect((await searchPages('Roadmap', { userId: anyUserId })).some((h) => h.title === 'Roadmap Alpha')).toBe(true);
      expect((await searchPages('Roadmap', { userId: adminId })).some((h) => h.title === 'Roadmap Alpha')).toBe(true);
    } finally {
      await authStore.setSpaceVisibility(spaceASlug, 'private');
    }
  });

  it('pg_trgm catches a typo in the title that a token match would miss', async () => {
    // "Rodmap" is not a token of "Roadmap Alpha" at all (missing the 'a'), so
    // plain tsvector/tsquery matching alone would find nothing here — only
    // title similarity (pg_trgm's `%` operator) can.
    const hits = await searchPages('Rodmap', { userId: memberId });
    expect(hits.some((h) => h.title === 'Roadmap Alpha')).toBe(true);
  });

  it('an empty query returns no hits', async () => {
    const hits = await searchPages('   ', { userId: memberId });
    expect(hits).toEqual([]);
  });
});
