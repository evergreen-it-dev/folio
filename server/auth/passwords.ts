/**
 * Password hashing (bcryptjs, cost 12), mirroring a sibling project's
 * server/domain/password.ts pattern: a real bcrypt comparison always runs,
 * even for an unknown/passwordless account, against a fixed dummy hash
 * computed once at module load — so "no such user" and "wrong password"
 * take the same amount of time and can't be told apart by timing.
 */
import bcrypt from 'bcryptjs';

export const BCRYPT_COST = 12;

const DUMMY_HASH = bcrypt.hashSync('a-password-nobody-will-ever-set-hashed-only-for-timing-safety', BCRYPT_COST);

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

/** `hash` is `string | null` on purpose — pass a missing user's hash through as null, don't skip the call. */
export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  if (hash === null) {
    await bcrypt.compare(password, DUMMY_HASH);
    return false;
  }
  return bcrypt.compare(password, hash);
}
