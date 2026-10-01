import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { updateMyPreferencesBodySchema } from '../shared/contracts.js';
import { setUpTestSchema } from './db/testSchema.js';
import * as authStore from './auth/store.js';

describe('user language preference (round 10, real PG)', () => {
  let teardownSchema: () => Promise<void>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  it('a fresh user has no lang set (undefined, not a stored default) until updateUserLang is called', async () => {
    const user = await authStore.createUser({ email: 'fresh-lang@prefs-test.local', name: 'Fresh', passwordHash: 'x', isAdmin: false });
    expect(user.lang).toBeUndefined(); // NULL in the DB -> undefined on the User, never a baked-in 'uk'

    const updated = await authStore.updateUserLang(user.id, 'ru');
    expect(updated.lang).toBe('ru');

    // The update is durable, and every read path (findStoredUserById, listUsers)
    // carries it through the SAME row-mapping function -- not just the direct
    // return value of updateUserLang.
    const reloaded = await authStore.findStoredUserById(user.id);
    expect(reloaded?.lang).toBe('ru');

    const listed = await authStore.listUsers();
    expect(listed.find((u) => u.id === user.id)?.lang).toBe('ru');
  });

  it('lang can be changed repeatedly across all three supported languages', async () => {
    const user = await authStore.createUser({ email: 'multi-lang@prefs-test.local', name: 'Multi', passwordHash: 'x', isAdmin: false });
    for (const lang of ['uk', 'en', 'ru'] as const) {
      const updated = await authStore.updateUserLang(user.id, lang);
      expect(updated.lang).toBe(lang);
    }
  });

  it('updateUserLang for a nonexistent user throws (not found), never silently no-ops', async () => {
    await expect(authStore.updateUserLang('00000000-0000-0000-0000-000000000000', 'en')).rejects.toThrow();
  });
});

/**
 * Round 28: PATCH /api/me/preferences learned `name` so a user can change
 * their OWN display name (the personal-settings dialog). The route hands the
 * validated value to store.updateUser — the same writer the instance-admin
 * PATCH /api/users/:id already used — so what's genuinely new is the contract
 * accepting the field at all, and rejecting a blank one before it can reach a
 * NOT NULL column.
 */
describe('own display name preference (round 28)', () => {
  let teardownSchema: () => Promise<void>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  it('the contract trims the name and rejects a blank/whitespace-only or over-long one', () => {
    // .trim() runs BEFORE min(1)/max(80), so the parsed value is what gets stored.
    expect(updateMyPreferencesBodySchema.parse({ name: '  Anna Kim  ' }).name).toBe('Anna Kim');
    expect(updateMyPreferencesBodySchema.safeParse({ name: '' }).success).toBe(false);
    expect(updateMyPreferencesBodySchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(updateMyPreferencesBodySchema.safeParse({ name: 'x'.repeat(81) }).success).toBe(false);
    expect(updateMyPreferencesBodySchema.safeParse({ name: 'x'.repeat(80) }).success).toBe(true);
    // A name can't be UNSET, unlike the @mention username right next to it.
    expect(updateMyPreferencesBodySchema.safeParse({ name: null }).success).toBe(false);
    // Additive change: the pre-round-28 bodies are all still valid, unchanged.
    expect(updateMyPreferencesBodySchema.safeParse({}).success).toBe(true);
    expect(updateMyPreferencesBodySchema.safeParse({ lang: 'ru' }).success).toBe(true);
    expect(updateMyPreferencesBodySchema.safeParse({ username: null }).success).toBe(true);
  });

  it('the store write is durable and reaches every read path, leaving the rest of the row alone', async () => {
    const user = await authStore.createUser({ email: 'own-name@prefs-test.local', name: 'Old Name', passwordHash: 'x', isAdmin: true });
    await authStore.updateUsername(user.id, 'ownname');

    const updated = await authStore.updateUser(user.id, { name: '  New Name  ' });
    expect(updated.name).toBe('New Name'); // trimmed by the store too, not only by the schema

    const reloaded = await authStore.findStoredUserById(user.id);
    expect(reloaded?.name).toBe('New Name');
    expect((await authStore.listUsers()).find((u) => u.id === user.id)?.name).toBe('New Name');
    // Renaming yourself touches nothing else on the row -- in particular not
    // is_admin/disabled, which is why the route needs no last-admin guard.
    expect(reloaded?.isAdmin).toBe(true);
    expect(reloaded?.disabled).toBe(false);
    expect(reloaded?.username).toBe('ownname');
    expect(reloaded?.email).toBe('own-name@prefs-test.local');
  });
});
