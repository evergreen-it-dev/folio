/**
 * Public-demo mode. OFF by default: an ordinary instance (and our production)
 * never serves any of this.
 *
 *   FOLIO_DEMO_MODE=1            switches the mode on ("1", "true", "yes", "on").
 *   FOLIO_DEMO_ACCOUNTS          the accounts offered on the login screen: a JSON
 *                                array of {email, password, name, role, description},
 *                                or a path to a file holding that array. The accounts
 *                                themselves must already exist (seeded by the
 *                                operator) — this only advertises them.
 *   FOLIO_DEMO_RESET_HOURS       how often the operator resets the demo data (a
 *                                number; shown in the sign-in note and the banner).
 *
 * The demo passwords are public by design, so they are handed out ONLY while the
 * mode is on and ONLY through the public GET /api/auth/state (the same payload
 * that already tells the login screen about Google). They are never logged: a
 * malformed config is reported by reason, never by echoing its content.
 *
 *   FOLIO_DEMO_MAX_UPLOAD_MB     cap for ANY upload while the mode is on (default 5).
 *
 * The demo login is shared and public, so anybody can act as it. Two kinds of guard:
 *
 *   assertNotDemo(what)          for everyone, while the mode is on: PATs, the AI
 *                                assistant, git/Confluence endpoints that make the
 *                                server connect to a caller-chosen host (SSRF),
 *                                share links, invites, name/username changes.
 *   assertNotDemoAccount(user)   only for the listed demo accounts: changing a
 *                                password — otherwise one visitor could lock
 *                                everybody else out of the shared login.
 *
 * Every refusal is a 403 "<what> is disabled in the public demo". Outside demo
 * mode all of it is inert.
 */
import * as fs from 'node:fs';
import { z } from 'zod';
import type { DemoAccount, DemoInfo, User } from '../shared/contracts.js';
import { forbidden } from './errors.js';

const demoAccountSchema = z.object({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().max(40).default(''),
  description: z.string().trim().max(200).default(''),
});
const demoAccountsSchema = z.array(demoAccountSchema).max(12);

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function isDemoMode(): boolean {
  return TRUTHY.has((process.env.FOLIO_DEMO_MODE ?? '').trim().toLowerCase());
}

/** FOLIO_DEMO_RESET_HOURS as a positive number, or null when unset/invalid. */
export function demoResetHours(): number | null {
  const raw = (process.env.FOLIO_DEMO_RESET_HOURS ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parsed accounts keyed by the raw FOLIO_DEMO_ACCOUNTS value, so the file is read (and a bad config reported) once per process. */
let cache: { raw: string; accounts: DemoAccount[] } | null = null;

export function __resetDemoConfigForTests(): void {
  cache = null;
}

function parseAccounts(raw: string): DemoAccount[] {
  let json = raw;
  if (!raw.startsWith('[')) {
    try {
      json = fs.readFileSync(raw, 'utf8');
    } catch {
      console.warn('demo: FOLIO_DEMO_ACCOUNTS is neither a JSON array nor a readable file path; no demo accounts will be offered');
      return [];
    }
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    console.warn('demo: FOLIO_DEMO_ACCOUNTS is not valid JSON; no demo accounts will be offered');
    return [];
  }
  const parsed = demoAccountsSchema.safeParse(data);
  if (!parsed.success) {
    // Report the shape problem (field path), never the values: they include passwords.
    const where = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    console.warn(`demo: FOLIO_DEMO_ACCOUNTS is invalid (${where}); no demo accounts will be offered`);
    return [];
  }
  return parsed.data;
}

/** The configured demo accounts; always [] outside demo mode. */
export function getDemoAccounts(): DemoAccount[] {
  if (!isDemoMode()) return [];
  const raw = (process.env.FOLIO_DEMO_ACCOUNTS ?? '').trim();
  if (!raw) return [];
  if (cache?.raw !== raw) cache = { raw, accounts: parseAccounts(raw) };
  return cache.accounts;
}

/**
 * The `demo` field of GET /api/auth/state: undefined outside demo mode. The
 * account list (with passwords) goes only to a visitor who is not signed in.
 */
export function demoInfoFor(signedIn: boolean): DemoInfo | undefined {
  if (!isDemoMode()) return undefined;
  return { accounts: signedIn ? [] : getDemoAccounts(), resetHours: demoResetHours() };
}

/** True when `email` belongs to a configured demo account (case-insensitive). Always false outside demo mode. */
export function isDemoAccountEmail(email: string): boolean {
  if (!isDemoMode()) return false;
  const e = email.trim().toLowerCase();
  return getDemoAccounts().some((a) => a.email.trim().toLowerCase() === e);
}

/** Refuses (403) a capability the public demo does not offer to anybody. A no-op outside demo mode. */
export function assertNotDemo(what: string): void {
  if (isDemoMode()) throw forbidden(`${what} is disabled in the public demo`);
}

/** Refuses (403) an action a shared demo login must not perform. A no-op outside demo mode and for every non-demo user. */
export function assertNotDemoAccount(user: Pick<User, 'email'>, what: string): void {
  if (isDemoAccountEmail(user.email)) throw forbidden(`${what} is disabled in the public demo`);
}

const DEFAULT_DEMO_MAX_UPLOAD_MB = 5;

/** The upload cap in demo mode (FOLIO_DEMO_MAX_UPLOAD_MB, default 5 MB); null outside demo mode = the ordinary limit applies. */
export function demoMaxUploadBytes(): number | null {
  if (!isDemoMode()) return null;
  const n = Number((process.env.FOLIO_DEMO_MAX_UPLOAD_MB ?? '').trim());
  return Math.floor((Number.isFinite(n) && n > 0 ? n : DEFAULT_DEMO_MAX_UPLOAD_MB) * 1024 * 1024);
}
