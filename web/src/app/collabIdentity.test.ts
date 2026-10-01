// @vitest-environment jsdom
// (anonUser(), imported below for the guest-fallback test, touches localStorage)
import { beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@shared/contracts';
import { resolveAuthedIdentity } from './collabIdentity';
import { anonUser, PALETTE as EDITOR_PALETTE } from '../editor/collab';

const PALETTE = ['#d9480f', '#c2255c', '#7048e8', '#1971c2', '#0c8599', '#2f9e44', '#e8590c', '#5f3dc4'];

function user(overrides: Partial<User> = {}): Pick<User, 'id' | 'name' | 'username'> {
  return { id: 'u1', name: 'Ivan Koval', username: 'ivan.k', ...overrides };
}

describe('resolveAuthedIdentity', () => {
  it('uses the real name for a signed-in user', () => {
    const identity = resolveAuthedIdentity(user(), PALETTE);
    expect(identity.name).toBe('Ivan Koval');
  });

  it('falls back to @username when name is empty', () => {
    const identity = resolveAuthedIdentity(user({ name: '' }), PALETTE);
    expect(identity.name).toBe('@ivan.k');
  });

  it('picks the same colour for the same user.id across two calls', () => {
    const first = resolveAuthedIdentity(user(), PALETTE);
    const second = resolveAuthedIdentity(user(), PALETTE);
    expect(first.color).toBe(second.color);
    expect(PALETTE).toContain(first.color);
    expect(first.colorLight).toBe(`${first.color}33`);
  });

  it('a different user.id can land on a different colour', () => {
    const a = resolveAuthedIdentity(user({ id: 'aaa' }), PALETTE);
    const b = resolveAuthedIdentity(user({ id: 'zzz' }), PALETTE);
    // Not a strict guarantee for arbitrary ids, but these two specific ids
    // are chosen to hash to different palette slots — regression signal for
    // "the colour is derived from id, not hardcoded".
    expect(a.color).not.toBe(b.color);
  });
});

describe('anonUser (the guest fallback resolveAuthedIdentity is NOT used for)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('mints a random "Adjective Animal" name for a guest with no stored identity', () => {
    const identity = anonUser();
    expect(identity.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(EDITOR_PALETTE).toContain(identity.color);
  });
});
