import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpTestSchema } from '../db/testSchema.js';
import * as storage from '../storage.js';
import * as store from './store.js';

describe('auth/store (real PG)', () => {
  let teardownSchema: () => Promise<void>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });

  afterAll(async () => {
    await teardownSchema();
  });

  it('creates a user and rejects a duplicate email as a conflict', async () => {
    const user = await store.createUser({ email: 'dup@store-test.local', name: 'One', passwordHash: 'x', isAdmin: false });
    expect(user.email).toBe('dup@store-test.local');
    await expect(store.createUser({ email: 'DUP@store-test.local', name: 'Two', passwordHash: 'y', isAdmin: false })).rejects.toThrow();
  });

  it('session lifecycle: create, resolve, destroy', async () => {
    const user = await store.createUser({ email: 'session@store-test.local', name: 'S', passwordHash: 'x', isAdmin: false });
    const { token } = await store.createSession(user.id);
    expect(await store.resolveSessionUserId(token)).toBe(user.id);
    await store.destroySession(token);
    expect(await store.resolveSessionUserId(token)).toBeUndefined();
  });

  it('wouldRemoveLastActiveAdmin: true only when the patch would leave zero active admins', async () => {
    const solo = await store.createUser({ email: 'solo@store-test.local', name: 'Solo', passwordHash: 'x', isAdmin: true });
    expect(await store.wouldRemoveLastActiveAdmin(solo.id, { isAdmin: false })).toBe(true);
    expect(await store.wouldRemoveLastActiveAdmin(solo.id, { disabled: true })).toBe(true);
    expect(await store.wouldRemoveLastActiveAdmin(solo.id, { name: 'Renamed' })).toBe(false);

    const second = await store.createUser({ email: 'second-admin@store-test.local', name: 'Second', passwordHash: 'x', isAdmin: true });
    expect(await store.wouldRemoveLastActiveAdmin(solo.id, { isAdmin: false })).toBe(false);
    // a non-admin target never trips the guard, regardless of the patch
    expect(await store.wouldRemoveLastActiveAdmin(second.id, {})).toBe(false);
  });

  it('countSpaceAdmins counts space_members with role=admin, optionally excluding one user (regression: uuid/text parameter typing)', async () => {
    const space = await storage.createSpace(`Store Test Space ${Date.now()}`, null);
    const admin1 = await store.createUser({ email: 'space-admin-1@store-test.local', name: 'A1', passwordHash: 'x', isAdmin: false });
    const admin2 = await store.createUser({ email: 'space-admin-2@store-test.local', name: 'A2', passwordHash: 'x', isAdmin: false });

    await store.setMembership(space.slug, admin1.id, 'admin');
    expect(await store.countSpaceAdmins(space.slug)).toBe(1);
    expect(await store.countSpaceAdmins(space.slug, admin1.id)).toBe(0);

    await store.setMembership(space.slug, admin2.id, 'admin');
    expect(await store.countSpaceAdmins(space.slug)).toBe(2);
    expect(await store.countSpaceAdmins(space.slug, admin1.id)).toBe(1);
    expect(await store.countSpaceAdmins(space.slug, undefined)).toBe(2);

    const root = (await storage.listEntries(space.slug)).find((e) => e.dirPath === '' && e.isIndex);
    if (root) await storage.deletePage(root.id);
  });

  it('stars round-trip and are isolated per user', async () => {
    const u1 = await store.createUser({ email: 'stars-1@store-test.local', name: 'U1', passwordHash: 'x', isAdmin: false });
    const u2 = await store.createUser({ email: 'stars-2@store-test.local', name: 'U2', passwordHash: 'x', isAdmin: false });
    await store.setSpaceStar(u1.id, 'some-space', true);
    expect((await store.getStars(u1.id)).spaces).toEqual(['some-space']);
    expect((await store.getStars(u2.id)).spaces).toEqual([]);
    await store.setSpaceStar(u1.id, 'some-space', false);
    expect((await store.getStars(u1.id)).spaces).toEqual([]);
  });

  it('emoji favorites: toggle on/off, insertion order preserved, multi-codepoint sequences round-trip byte-identical', async () => {
    const user = await store.createUser({ email: 'emoji-star@store-test.local', name: 'Emoji', passwordHash: 'x', isAdmin: false });

    // 🛠️ = U+1F6E0 WRENCH + U+FE0F VARIATION SELECTOR-16 (2 codepoints, 3 UTF-16 units)
    // 👨‍👩‍👧 = U+1F468 MAN + ZWJ + U+1F469 WOMAN + ZWJ + U+1F467 GIRL (5 codepoints, 8 UTF-16 units)
    const wrench = '\u{1F6E0}\u{FE0F}';
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const star = '\u2B50';

    // toggle on
    await store.setEmojiStar(user.id, star, true);
    expect((await store.getStars(user.id)).emojis).toEqual([star]);

    // order preserved across several additions
    await store.setEmojiStar(user.id, wrench, true);
    await store.setEmojiStar(user.id, family, true);
    expect((await store.getStars(user.id)).emojis).toEqual([star, wrench, family]);

    // byte-identical round-trip for the multi-codepoint ones specifically
    const stars = await store.getStars(user.id);
    expect(stars.emojis![1]).toBe(wrench);
    expect(stars.emojis![1].length).toBe(3); // UTF-16 code units: surrogate pair + VS16
    expect(stars.emojis![2]).toBe(family);
    expect(stars.emojis![2].length).toBe(8); // 3 surrogate-pair emoji + 2 ZWJ

    // toggle off removes just that one, preserving the rest's relative order
    await store.setEmojiStar(user.id, wrench, false);
    expect((await store.getStars(user.id)).emojis).toEqual([star, family]);

    // re-adding an already-favorited emoji is a no-op (ON CONFLICT DO NOTHING),
    // not a duplicate or a reorder to the end
    await store.setEmojiStar(user.id, star, true);
    expect((await store.getStars(user.id)).emojis).toEqual([star, family]);

    // isolated from spaces/pages and from other users, same as the existing kinds
    expect((await store.getStars(user.id)).spaces).toEqual([]);
    const other = await store.createUser({ email: 'emoji-star-2@store-test.local', name: 'Other', passwordHash: 'x', isAdmin: false });
    expect((await store.getStars(other.id)).emojis).toEqual([]);
  });
});
