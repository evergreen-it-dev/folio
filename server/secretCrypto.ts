/**
 * Round 11: app-level encryption for git_credentials.token_enc (a saved
 * GitLab/GitHub PAT), keyed by the FOLIO_SECRET env var. AES-256-GCM: a
 * random 12-byte IV per encryption (GCM's own recommendation — reusing an IV
 * with the same key breaks its authentication guarantee entirely), the
 * 16-byte auth tag, then the ciphertext, concatenated into one buffer for
 * storage in a single `bytea` column rather than three separate ones.
 *
 * FOLIO_SECRET itself is hashed (sha256) into a 32-byte key rather than used
 * directly — callers can set ANY length/shape secret in .env, not just a
 * pre-formatted 32-byte hex string.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { loadEnv } from './env.js';

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/** Throws with a clear, actionable message if FOLIO_SECRET isn't set — callers (userGitCredentials.ts) turn this into a 500, per DEV-PLAN: "if absent, refuse to store". Never silently falls back to a fixed/derived key: that would make every uninitialized deployment share the same effective encryption key. */
function secretKey(): Buffer {
  loadEnv();
  const secret = process.env.FOLIO_SECRET;
  if (!secret) {
    throw new Error('FOLIO_SECRET is not set — cannot encrypt/decrypt saved git credentials. Set FOLIO_SECRET in .env (see .env.example).');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encryptSecret(plaintext: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

export function decryptSecret(stored: Buffer): string {
  const iv = stored.subarray(0, IV_LENGTH);
  const authTag = stored.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = stored.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', secretKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** True iff FOLIO_SECRET is actually set — routes check this to fail fast with a clear 500 instead of an opaque throw from deep inside encryptSecret. */
export function hasSecretConfigured(): boolean {
  loadEnv();
  return Boolean(process.env.FOLIO_SECRET);
}
