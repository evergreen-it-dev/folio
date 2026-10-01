import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setUpTestSchema } from './db/testSchema.js';
import * as authStore from './auth/store.js';
import * as userConfluenceCredentials from './userConfluenceCredentials.js';
import { query } from './db/pool.js';

describe('userConfluenceCredentials.ts (round 22b, real PG)', () => {
  let teardownSchema: () => Promise<void>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  it('save (pat) -> list -> the stored token_enc column is never plaintext -> delete', async () => {
    const user = await authStore.createUser({ email: 'conf-pat@conf-cred-test.local', name: 'Conf PAT', passwordHash: 'x', isAdmin: false });

    const created = await userConfluenceCredentials.saveCredential(user.id, 'https://wiki.example.com/', 'pat', 'conf-pat-token-abc', {
      label: 'On-prem Wiki',
    });
    expect(created.host).toBe('wiki.example.com'); // normalized: scheme + trailing slash stripped
    expect(created.kind).toBe('pat');
    expect(created.label).toBe('On-prem Wiki');
    expect(created.email).toBeUndefined(); // a pat credential never carries an email
    expect((created as unknown as { token?: string }).token).toBeUndefined(); // ConfluenceCredentialInfo has no token field at all

    const rows = await query<{ token_enc: Buffer }>('SELECT token_enc FROM confluence_credentials WHERE id = $1', [created.id]);
    expect(rows[0].token_enc.toString('utf8')).not.toContain('conf-pat-token-abc');

    const list = await userConfluenceCredentials.listForUser(user.id);
    expect(list.map((c) => c.id)).toEqual([created.id]);

    const resolved = await userConfluenceCredentials.getDecryptedTokenForHost(user.id, 'wiki.example.com');
    expect(resolved).toEqual({ token: 'conf-pat-token-abc', kind: 'pat' });

    const deleted = await userConfluenceCredentials.deleteCredential(user.id, created.id);
    expect(deleted).toBe(true);
    expect(await userConfluenceCredentials.listForUser(user.id)).toEqual([]);
    expect(await userConfluenceCredentials.getDecryptedTokenForHost(user.id, 'wiki.example.com')).toBeUndefined();
  });

  it('save (cloud) requires and stores the email alongside the encrypted token, never inside it', async () => {
    const user = await authStore.createUser({ email: 'conf-cloud@conf-cred-test.local', name: 'Conf Cloud', passwordHash: 'x', isAdmin: false });

    const created = await userConfluenceCredentials.saveCredential(user.id, 'my-team.atlassian.net', 'cloud', 'atl-api-token-xyz', {
      email: 'me@example.com',
      label: 'Cloud docs',
    });
    expect(created.kind).toBe('cloud');
    expect(created.email).toBe('me@example.com');

    const rows = await query<{ token_enc: Buffer; email: string }>('SELECT token_enc, email FROM confluence_credentials WHERE id = $1', [created.id]);
    expect(rows[0].email).toBe('me@example.com');
    expect(rows[0].token_enc.toString('utf8')).not.toContain('atl-api-token-xyz');

    const resolved = await userConfluenceCredentials.getDecryptedTokenById(user.id, created.id);
    expect(resolved).toEqual({ token: 'atl-api-token-xyz', kind: 'cloud', email: 'me@example.com' });
  });

  it('rejects a cloud credential with no email before ever writing a row', async () => {
    const user = await authStore.createUser({ email: 'conf-cloud-noemail@conf-cred-test.local', name: 'No Email', passwordHash: 'x', isAdmin: false });
    await expect(userConfluenceCredentials.saveCredential(user.id, 'no-email.atlassian.net', 'cloud', 'some-token')).rejects.toThrow(/email/i);
    expect(await userConfluenceCredentials.listForUser(user.id)).toEqual([]);
  });

  it('a "pat" save silently ignores any email passed alongside it -- always stored NULL', async () => {
    const user = await authStore.createUser({ email: 'conf-pat-stray-email@conf-cred-test.local', name: 'Stray Email', passwordHash: 'x', isAdmin: false });
    const created = await userConfluenceCredentials.saveCredential(user.id, 'wiki.stray-email-test.com', 'pat', 'pat-token', {
      email: 'ignored@example.com',
    });
    expect(created.email).toBeUndefined();
    const resolved = await userConfluenceCredentials.getDecryptedTokenById(user.id, created.id);
    expect(resolved?.email).toBeUndefined();
  });

  it('saving a second credential for the SAME host replaces the first (upsert), never a duplicate row', async () => {
    const user = await authStore.createUser({ email: 'conf-upsert@conf-cred-test.local', name: 'Upsert', passwordHash: 'x', isAdmin: false });
    await userConfluenceCredentials.saveCredential(user.id, 'wiki.upsert-test.com', 'pat', 'first-token');
    await userConfluenceCredentials.saveCredential(user.id, 'wiki.upsert-test.com', 'cloud', 'second-token', { email: 'x@y.com', label: 'Renamed' });

    const list = await userConfluenceCredentials.listForUser(user.id);
    expect(list.length).toBe(1);
    expect(list[0].label).toBe('Renamed');
    expect(list[0].kind).toBe('cloud');
    const resolved = await userConfluenceCredentials.getDecryptedTokenForHost(user.id, 'wiki.upsert-test.com');
    expect(resolved).toEqual({ token: 'second-token', kind: 'cloud', email: 'x@y.com' }); // the OLD token is genuinely gone, not just shadowed
  });

  it('one user can never delete (or resolve) another user\'s Confluence credential -- indistinguishable from a nonexistent id', async () => {
    const owner = await authStore.createUser({ email: 'conf-real-owner@conf-cred-test.local', name: 'Owner', passwordHash: 'x', isAdmin: false });
    const intruder = await authStore.createUser({ email: 'conf-intruder@conf-cred-test.local', name: 'Intruder', passwordHash: 'x', isAdmin: false });
    const created = await userConfluenceCredentials.saveCredential(owner.id, 'wiki.intruder-test.com', 'pat', 'owner-token');

    expect(await userConfluenceCredentials.deleteCredential(intruder.id, created.id)).toBe(false);
    expect(await userConfluenceCredentials.listForUser(intruder.id)).toEqual([]); // still invisible to them
    expect(await userConfluenceCredentials.getDecryptedTokenById(intruder.id, created.id)).toBeUndefined();
    expect(await userConfluenceCredentials.getDecryptedTokenForHost(intruder.id, 'wiki.intruder-test.com')).toBeUndefined(); // host-scoped lookup is ALSO per-user, not global
    expect(await userConfluenceCredentials.getDecryptedTokenById(intruder.id, randomUUID())).toBeUndefined(); // a well-formed but nonexistent id looks identical
    // ...but the owner's own credential is untouched by the failed attempts.
    expect(await userConfluenceCredentials.getDecryptedTokenById(owner.id, created.id)).toEqual({ token: 'owner-token', kind: 'pat' });
  });
});
