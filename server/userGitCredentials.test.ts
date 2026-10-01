import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setUpTestSchema } from './db/testSchema.js';
import * as authStore from './auth/store.js';
import * as userGitCredentials from './userGitCredentials.js';
import { encryptSecret, decryptSecret, hasSecretConfigured } from './secretCrypto.js';
import { query } from './db/pool.js';

describe('secretCrypto.ts (round 11)', () => {
  it('round-trips: decrypt(encrypt(x)) === x, and the stored bytes never contain the plaintext', () => {
    const plaintext = 'glpat-superSecretToken1234567890';
    const stored = encryptSecret(plaintext);
    expect(Buffer.isBuffer(stored)).toBe(true);
    expect(stored.toString('utf8')).not.toContain(plaintext);
    expect(stored.toString('base64')).not.toContain(Buffer.from(plaintext).toString('base64'));
    expect(decryptSecret(stored)).toBe(plaintext);
  });

  it('two encryptions of the SAME plaintext produce different ciphertext (random IV per call)', () => {
    const a = encryptSecret('same-token');
    const b = encryptSecret('same-token');
    expect(a.equals(b)).toBe(false); // different IV -> different bytes, even though both decrypt correctly
    expect(decryptSecret(a)).toBe('same-token');
    expect(decryptSecret(b)).toBe('same-token');
  });

  it('tampered ciphertext fails to decrypt rather than silently returning garbage (GCM auth tag catches it)', () => {
    const stored = encryptSecret('a-token');
    const tampered = Buffer.from(stored);
    tampered[tampered.length - 1] ^= 0xff; // flip a bit in the ciphertext
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('hasSecretConfigured reflects FOLIO_SECRET being set (it is, in this test env — see .env)', () => {
    expect(hasSecretConfigured()).toBe(true);
  });
});

describe('userGitCredentials.ts (round 11, real PG)', () => {
  let teardownSchema: () => Promise<void>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  it('save -> list -> the stored token_enc column is never plaintext -> delete', async () => {
    const user = await authStore.createUser({ email: 'cred-owner@gitcred-test.local', name: 'Cred Owner', passwordHash: 'x', isAdmin: false });

    const created = await userGitCredentials.saveCredential(user.id, 'https://gitlab.example.com/', 'gitlab', 'glpat-abc123', 'Work GitLab');
    expect(created.host).toBe('gitlab.example.com'); // normalized: scheme + trailing slash stripped
    expect(created.provider).toBe('gitlab');
    expect(created.label).toBe('Work GitLab');
    expect((created as unknown as { token?: string }).token).toBeUndefined(); // GitCredentialInfo has no token field at all

    const rows = await query<{ token_enc: Buffer }>('SELECT token_enc FROM git_credentials WHERE id = $1', [created.id]);
    expect(rows[0].token_enc.toString('utf8')).not.toContain('glpat-abc123');

    const list = await userGitCredentials.listForUser(user.id);
    expect(list.map((c) => c.id)).toEqual([created.id]);

    const resolved = await userGitCredentials.getDecryptedTokenForHost(user.id, 'gitlab.example.com');
    expect(resolved?.token).toBe('glpat-abc123'); // internal-only decrypt path actually round-trips the real secret
    expect(resolved?.provider).toBe('gitlab');

    const deleted = await userGitCredentials.deleteCredential(user.id, created.id);
    expect(deleted).toBe(true);
    expect(await userGitCredentials.listForUser(user.id)).toEqual([]);
    expect(await userGitCredentials.getDecryptedTokenForHost(user.id, 'gitlab.example.com')).toBeUndefined();
  });

  it('saving a second credential for the SAME host replaces the first (upsert), never a duplicate row', async () => {
    const user = await authStore.createUser({ email: 'upsert@gitcred-test.local', name: 'Upsert', passwordHash: 'x', isAdmin: false });
    await userGitCredentials.saveCredential(user.id, 'github.com', 'github', 'ghp_first');
    await userGitCredentials.saveCredential(user.id, 'github.com', 'github', 'ghp_second', 'Renamed');

    const list = await userGitCredentials.listForUser(user.id);
    expect(list.length).toBe(1);
    expect(list[0].label).toBe('Renamed');
    const resolved = await userGitCredentials.getDecryptedTokenForHost(user.id, 'github.com');
    expect(resolved?.token).toBe('ghp_second'); // the OLD token is genuinely gone, not just shadowed
  });

  it('one user can never delete (or resolve) another user\'s credential', async () => {
    const owner = await authStore.createUser({ email: 'real-owner@gitcred-test.local', name: 'Owner', passwordHash: 'x', isAdmin: false });
    const intruder = await authStore.createUser({ email: 'intruder@gitcred-test.local', name: 'Intruder', passwordHash: 'x', isAdmin: false });
    const created = await userGitCredentials.saveCredential(owner.id, 'gitlab.intruder-test.com', 'gitlab', 'owner-token');

    expect(await userGitCredentials.deleteCredential(intruder.id, created.id)).toBe(false);
    expect(await userGitCredentials.listForUser(intruder.id)).toEqual([]); // still invisible to them
    expect(await userGitCredentials.getDecryptedTokenForHost(intruder.id, 'gitlab.intruder-test.com')).toBeUndefined(); // host-scoped lookup is ALSO per-user, not global
    // ...but the owner's own credential is untouched by the failed attempt.
    expect(await userGitCredentials.getDecryptedTokenForHost(owner.id, 'gitlab.intruder-test.com')).toEqual({ token: 'owner-token', provider: 'gitlab' });
  });

  describe('getDecryptedTokenById (round 19: GET /api/git/tree looks up a credential by id, not by host)', () => {
    it('the owner resolves their own credential by id, decrypted', async () => {
      const owner = await authStore.createUser({ email: 'by-id-owner@gitcred-test.local', name: 'ById Owner', passwordHash: 'x', isAdmin: false });
      const created = await userGitCredentials.saveCredential(owner.id, 'gitlab.by-id-test.com', 'gitlab', 'by-id-token');

      const resolved = await userGitCredentials.getDecryptedTokenById(owner.id, created.id);
      expect(resolved).toEqual({ token: 'by-id-token', provider: 'gitlab' });
    });

    it('a different user gets undefined for someone else\'s credential id -- indistinguishable from a nonexistent id', async () => {
      const owner = await authStore.createUser({ email: 'by-id-real-owner@gitcred-test.local', name: 'Owner', passwordHash: 'x', isAdmin: false });
      const intruder = await authStore.createUser({ email: 'by-id-intruder@gitcred-test.local', name: 'Intruder', passwordHash: 'x', isAdmin: false });
      const created = await userGitCredentials.saveCredential(owner.id, 'gitlab.by-id-intruder-test.com', 'gitlab', 'owner-only-token');

      expect(await userGitCredentials.getDecryptedTokenById(intruder.id, created.id)).toBeUndefined();
      // A well-formed but nonexistent id -- NOT a malformed one: every id-lookup in this
      // codebase (e.g. auth/store.ts's revokeApiToken) assumes a syntactically valid UUID
      // and lets Postgres itself reject anything else, so this isn't special-cased here either.
      expect(await userGitCredentials.getDecryptedTokenById(intruder.id, randomUUID())).toBeUndefined();
      // ...but the owner's own lookup still works.
      expect(await userGitCredentials.getDecryptedTokenById(owner.id, created.id)).toEqual({ token: 'owner-only-token', provider: 'gitlab' });
    });
  });

  describe('hostFromRepoUrl', () => {
    it('extracts the host from https, ssh://, and scp-like (git@host:path) URLs', () => {
      expect(userGitCredentials.hostFromRepoUrl('https://gitlab.example.com/group/repo.git')).toBe('gitlab.example.com');
      expect(userGitCredentials.hostFromRepoUrl('ssh://git@github.com/org/repo.git')).toBe('github.com');
      expect(userGitCredentials.hostFromRepoUrl('git@gitlab.example.com:group/repo.git')).toBe('gitlab.example.com');
    });

    it('returns undefined for a URL it cannot parse a host from', () => {
      expect(userGitCredentials.hostFromRepoUrl('not a url at all')).toBeUndefined();
    });
  });

  describe('resolveGitToken (auto-token selection)', () => {
    it('an explicit token always wins over a saved credential', async () => {
      const user = await authStore.createUser({ email: 'explicit-wins@gitcred-test.local', name: 'Explicit', passwordHash: 'x', isAdmin: false });
      await userGitCredentials.saveCredential(user.id, 'gitlab.explicit-test.com', 'gitlab', 'saved-token');
      const resolved = await userGitCredentials.resolveGitToken(user.id, 'https://gitlab.explicit-test.com/x/y.git', 'pasted-token');
      expect(resolved).toBe('pasted-token');
    });

    it('falls back to the saved credential for a matching host when no explicit token is given', async () => {
      const user = await authStore.createUser({ email: 'auto-token@gitcred-test.local', name: 'Auto', passwordHash: 'x', isAdmin: false });
      await userGitCredentials.saveCredential(user.id, 'gitlab.auto-test.com', 'gitlab', 'auto-saved-token');
      const resolved = await userGitCredentials.resolveGitToken(user.id, 'https://gitlab.auto-test.com/x/y.git', undefined);
      expect(resolved).toBe('auto-saved-token');
    });

    it('returns undefined (not an error) for a public repo with no matching saved credential -- and never leaks a DIFFERENT host\'s saved token', async () => {
      const user = await authStore.createUser({ email: 'no-match@gitcred-test.local', name: 'NoMatch', passwordHash: 'x', isAdmin: false });
      await userGitCredentials.saveCredential(user.id, 'gitlab.some-other-host.com', 'gitlab', 'unrelated-token');
      const resolved = await userGitCredentials.resolveGitToken(user.id, 'https://github.com/totally/public.git', undefined);
      expect(resolved).toBeUndefined();
    });
  });
});
