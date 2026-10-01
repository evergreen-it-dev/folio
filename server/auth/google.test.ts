import { describe, expect, it } from 'vitest';
import { isAllowedGoogleDomain, parseAllowedDomains, resolveGoogleUser } from './google.js';

describe('auth/google (pure helpers, no Postgres, no Google)', () => {
  describe('isAllowedGoogleDomain', () => {
    const allowed = ['acme.example', 'acme.test', 'acme-labs.example'];

    it('accepts an email whose domain is in the allowlist', () => {
      expect(isAllowedGoogleDomain('person@acme.example', undefined, allowed)).toBe(true);
    });

    it('rejects an email whose domain is outside the allowlist', () => {
      expect(isAllowedGoogleDomain('person@gmail.com', undefined, allowed)).toBe(false);
    });

    it('is case-insensitive on the domain', () => {
      expect(isAllowedGoogleDomain('Person@Acme.Example', undefined, allowed)).toBe(true);
    });

    it('respects `hd` when present: allowed domain but a disallowed hosted-domain claim is rejected', () => {
      expect(isAllowedGoogleDomain('person@acme.example', 'someoneelse.example', allowed)).toBe(false);
    });

    it('respects `hd` when present: allowed domain and an allowed (differently-cased) hd both pass', () => {
      expect(isAllowedGoogleDomain('person@acme.example', 'Acme.Example', allowed)).toBe(true);
    });

    it('an email with no domain at all is rejected, not thrown on', () => {
      expect(isAllowedGoogleDomain('not-an-email', undefined, allowed)).toBe(false);
    });
  });

  describe('parseAllowedDomains', () => {
    it('is an empty allowlist when unset — no domain is baked into the code', () => {
      expect(parseAllowedDomains(undefined)).toEqual([]);
    });

    it('is an empty allowlist when the env var is empty/blank', () => {
      expect(parseAllowedDomains('')).toEqual([]);
      expect(parseAllowedDomains('  ,  ,')).toEqual([]);
    });

    it('an empty allowlist lets nobody in', () => {
      expect(isAllowedGoogleDomain('person@acme.example', undefined, [])).toBe(false);
    });

    it('parses a comma-separated list, trimming and lower-casing each entry', () => {
      expect(parseAllowedDomains(' Example.com, Other.Org ,example.com')).toEqual(['example.com', 'other.org']);
    });
  });

  describe('resolveGoogleUser: find by google_sub -> else by email (link) -> else create', () => {
    interface FakeUser {
      id: string;
      email: string;
      googleSub?: string;
    }

    it('branch 1: an existing google_sub match is returned as "existing" (no lookup by email needed)', async () => {
      const bySub: FakeUser = { id: 'u1', email: 'person@acme.example', googleSub: 'google-sub-1' };
      let emailLookupCalled = false;
      const result = await resolveGoogleUser(
        { sub: 'google-sub-1', email: 'person@acme.example' },
        {
          findByGoogleSub: async (sub) => (sub === 'google-sub-1' ? bySub : undefined),
          findByEmail: async () => {
            emailLookupCalled = true;
            return undefined;
          },
        },
      );
      expect(result).toEqual({ kind: 'existing', user: bySub });
      expect(emailLookupCalled).toBe(false);
    });

    it('branch 2: no google_sub match but a matching email -> "link" (existing password account gets linked)', async () => {
      const byEmail: FakeUser = { id: 'u2', email: 'person@acme.example' };
      const result = await resolveGoogleUser(
        { sub: 'google-sub-2', email: 'person@acme.example' },
        {
          findByGoogleSub: async () => undefined,
          findByEmail: async (email) => (email === 'person@acme.example' ? byEmail : undefined),
        },
      );
      expect(result).toEqual({ kind: 'link', user: byEmail });
    });

    it('branch 3: neither a google_sub nor an email match -> "create" (brand-new, no-space-access account)', async () => {
      const result = await resolveGoogleUser<FakeUser>(
        { sub: 'google-sub-3', email: 'new-person@acme.example' },
        { findByGoogleSub: async () => undefined, findByEmail: async () => undefined },
      );
      expect(result).toEqual({ kind: 'create' });
    });
  });
});
