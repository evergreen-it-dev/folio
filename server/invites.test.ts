import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as authStore from './auth/store.js';
import * as invites from './invites.js';
import { query } from './db/pool.js';

describe('invites.ts (round 9, real PG)', () => {
  let teardownSchema: () => Promise<void>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  it('create -> list (all + by creator) -> getByToken -> claim -> revoke', async () => {
    const admin = await authStore.createUser({ email: 'inviter@invites-test.local', name: 'Inviter', passwordHash: 'x', isAdmin: true });
    const space = await storage.createSpace(`Invite Lifecycle ${Date.now()}`, admin.id);

    const created = await invites.createInvite(
      { memberships: [{ space: space.slug, role: 'editor' }], isAdmin: false, expiresInDays: 7, maxUses: 3 },
      admin.id,
      'http://fallback.test',
    );
    expect(created.createdBy).toBe('Inviter');
    expect(created.uses).toBe(0);
    expect(created.maxUses).toBe(3);
    expect(created.memberships).toEqual([{ space: space.slug, role: 'editor' }]);
    expect(created.url).toMatch(/\/invite\/[0-9a-f]{32}$/); // 32 hex chars, matches randomBytes(16).toString('hex')

    const token = created.url.split('/invite/')[1];

    const all = await invites.listAllInvites('http://fallback.test');
    expect(all.map((i) => i.id)).toContain(created.id);

    const mine = await invites.listInvitesCreatedBy(admin.id, 'http://fallback.test');
    expect(mine.map((i) => i.id)).toEqual([created.id]);

    const raw = await invites.getInviteByToken(token);
    expect(raw?.id).toBe(created.id);
    expect(invites.invalidReason(raw)).toBeUndefined(); // still valid

    const claimed = await invites.claimInviteUse(token);
    expect(claimed?.id).toBe(created.id);
    expect(claimed?.memberships).toEqual([{ space: space.slug, role: 'editor' }]);
    const afterClaim = await invites.getInviteByToken(token);
    expect(afterClaim?.uses).toBe(1); // one used, two left of maxUses=3

    await invites.revokeInvite(created.id);
    const afterRevoke = await invites.getInviteByToken(token);
    expect(invites.invalidReason(afterRevoke)).toBe('revoked');
    expect(await invites.claimInviteUse(token)).toBeUndefined(); // revoked -> can no longer be claimed
    expect(await invites.getInviteForRevoke(created.id)).toBeUndefined(); // already revoked -> not returned again

    await deleteTestSpace(space.slug);
  });

  it('round 19: PUBLIC_URL (both a schemed and a schemeless value) wins over the request-origin fallback, normalized', async () => {
    const admin = await authStore.createUser({ email: 'pub-url@invites-test.local', name: 'PubUrl', passwordHash: 'x', isAdmin: true });
    const space = await storage.createSpace(`Invite PubUrl ${Date.now()}`, admin.id);

    const original = process.env.PUBLIC_URL;
    try {
      process.env.PUBLIC_URL = 'https://folio.example.com';
      const created = await invites.createInvite(
        { memberships: [{ space: space.slug, role: 'viewer' }], isAdmin: false, expiresInDays: 7, maxUses: 1 },
        admin.id,
        'http://this-should-be-ignored.test',
      );
      expect(created.url.startsWith('https://folio.example.com/invite/')).toBe(true);

      // Coolify's SERVICE_FQDN_APP shape (round 19 prod bug): schemeless, must become https://.
      process.env.PUBLIC_URL = 'folio.example.com';
      const createdSchemeless = await invites.createInvite(
        { memberships: [{ space: space.slug, role: 'viewer' }], isAdmin: false, expiresInDays: 7, maxUses: 1 },
        admin.id,
        'http://this-should-be-ignored.test',
      );
      expect(createdSchemeless.url).toMatch(/^https:\/\/folio\.example\.com\/invite\//);

      delete process.env.PUBLIC_URL;
      const createdFallback = await invites.createInvite(
        { memberships: [{ space: space.slug, role: 'viewer' }], isAdmin: false, expiresInDays: 7, maxUses: 1 },
        admin.id,
        'http://fallback-used.test',
      );
      expect(createdFallback.url.startsWith('http://fallback-used.test/invite/')).toBe(true);
    } finally {
      if (original === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = original;
    }

    await deleteTestSpace(space.slug);
  });

  it('invalidReason: not_found, expired, exhausted, and the valid case', async () => {
    const admin = await authStore.createUser({ email: 'reasons@invites-test.local', name: 'Reasons', passwordHash: 'x', isAdmin: true });
    const space = await storage.createSpace(`Invite Reasons ${Date.now()}`, admin.id);

    expect(invites.invalidReason(undefined)).toBe('not_found');

    // Exhausted: maxUses=1, claimed once already.
    const exhausted = await invites.createInvite({ memberships: [], isAdmin: false, expiresInDays: 7, maxUses: 1 }, admin.id, 'http://fallback.test');
    const exhaustedToken = exhausted.url.split('/invite/')[1];
    expect(await invites.claimInviteUse(exhaustedToken)).toBeDefined();
    const exhaustedRaw = await invites.getInviteByToken(exhaustedToken);
    expect(invites.invalidReason(exhaustedRaw)).toBe('exhausted');
    expect(await invites.claimInviteUse(exhaustedToken)).toBeUndefined();

    // maxUses=0 means unlimited -- never exhausted no matter how many claims.
    const unlimited = await invites.createInvite({ memberships: [], isAdmin: false, expiresInDays: 7, maxUses: 0 }, admin.id, 'http://fallback.test');
    const unlimitedToken = unlimited.url.split('/invite/')[1];
    for (let i = 0; i < 5; i++) expect(await invites.claimInviteUse(unlimitedToken)).toBeDefined();
    expect(invites.invalidReason(await invites.getInviteByToken(unlimitedToken))).toBeUndefined();

    // Expired: backdate expires_at directly (no public API takes a negative expiresInDays).
    const expiring = await invites.createInvite({ memberships: [], isAdmin: false, expiresInDays: 7, maxUses: 1 }, admin.id, 'http://fallback.test');
    const expiringToken = expiring.url.split('/invite/')[1];
    await query('UPDATE invites SET expires_at = now() - interval \'1 day\' WHERE id = $1', [expiring.id]);
    expect(invites.invalidReason(await invites.getInviteByToken(expiringToken))).toBe('expired');
    expect(await invites.claimInviteUse(expiringToken)).toBeUndefined(); // the atomic claim re-checks expiry too, not just invalidReason

    await deleteTestSpace(space.slug);
  });

  it('a pinned email is carried through on the invite row (route-level match/mismatch is tested via curl smoke)', async () => {
    const admin = await authStore.createUser({ email: 'pin@invites-test.local', name: 'Pin', passwordHash: 'x', isAdmin: true });
    const created = await invites.createInvite(
      { memberships: [], isAdmin: false, expiresInDays: 7, maxUses: 1, email: 'pinned@example.com' },
      admin.id,
      'http://fallback.test',
    );
    expect(created.email).toBe('pinned@example.com');
    const raw = await invites.getInviteByToken(created.url.split('/invite/')[1]);
    expect(raw?.email).toBe('pinned@example.com');
  });

  it('CONCURRENCY GUARD: two parallel claims on a max_uses=1 invite -- exactly one wins', async () => {
    const admin = await authStore.createUser({ email: 'race@invites-test.local', name: 'Race', passwordHash: 'x', isAdmin: true });
    const created = await invites.createInvite({ memberships: [], isAdmin: false, expiresInDays: 7, maxUses: 1 }, admin.id, 'http://fallback.test');
    const token = created.url.split('/invite/')[1];

    // Fire both claims genuinely concurrently (no await between them) -- this is
    // exactly what two browsers racing to accept the same link produces at the
    // DB layer: two UPDATE statements against the same row, resolved by
    // Postgres's normal row-level locking, not by anything in application code.
    const [a, b] = await Promise.all([invites.claimInviteUse(token), invites.claimInviteUse(token)]);
    const results = [a, b];
    const wins = results.filter((r) => r !== undefined);
    const losses = results.filter((r) => r === undefined);
    expect(wins.length).toBe(1);
    expect(losses.length).toBe(1);

    // uses ends at exactly 1, never 2 -- the double-claim genuinely never happened,
    // not just "one request's response said so".
    const final = await invites.getInviteByToken(token);
    expect(final?.uses).toBe(1);
  });

  it('CONCURRENCY GUARD at higher fan-out: ten parallel claims on max_uses=3 -- exactly three win', async () => {
    const admin = await authStore.createUser({ email: 'race-fanout@invites-test.local', name: 'RaceFanout', passwordHash: 'x', isAdmin: true });
    const created = await invites.createInvite({ memberships: [], isAdmin: false, expiresInDays: 7, maxUses: 3 }, admin.id, 'http://fallback.test');
    const token = created.url.split('/invite/')[1];

    const results = await Promise.all(Array.from({ length: 10 }, () => invites.claimInviteUse(token)));
    const wins = results.filter((r) => r !== undefined);
    expect(wins.length).toBe(3);

    const final = await invites.getInviteByToken(token);
    expect(final?.uses).toBe(3);
  });
});
