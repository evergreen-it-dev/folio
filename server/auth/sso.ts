/**
 * What OpenID Connect (oidc.ts) and SAML 2.0 (saml.ts) sign-in share (docs/AUTH.md): who gets in once the
 * provider's answer is validated, the audit trail, the session, the error redirect, the signed flow cookie and the
 * "Test connection" result page. The protocol modules only validate the provider's answer and map it to
 * MappedClaims; everything after that is here, so both protocols follow the same rules.
 *
 * Who gets in (resolveSsoSignIn):
 *  1. an identity (issuer, subject) exists -> that account signs in;
 *  2. else an account with the same email exists -> linked ONLY when the email counts as verified (OIDC:
 *     `email_verified: true`; SAML: the provider is marked authoritative for its allowed domains), the email's
 *     domain is in the provider's allowed domains, and the account has no identity at this provider yet;
 *  3. else, from an invite -> the account is created with the invite's access;
 *  4. else JIT on -> the account is created (no password, not an admin) and gets the provider's default spaces;
 *     JIT off -> refused ("ask an admin to invite you"). While SCIM provisioning is on for the provider, JIT is off.
 * An account the provider created over SCIM (server/scim/identities.ts) holds a placeholder identity until its first
 * sign-in: between 1 and 2 it is matched by its SCIM externalId (SAML: also its userName) equal to the subject; in 2
 * its placeholder does not count as "already linked" and becomes the real identity. Also between them: a placeholder of
 * this provider whose SCIM email/userName equals the sign-in email is matched even without a verified email (audit
 * meta via 'scim_email'; owner decision 22.10.2026/23.10.2026, for Entra ID over OIDC).
 * A non-empty allowed-domains list also gates every sign-in through the provider.
 * Disabled and system accounts are refused. Every outcome is audited. After a successful sign-in the provider's
 * groups are synced to Folio groups (groupSync.ts), when the provider has that switched on.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SsoProviderPublic, SsoTestResult } from '../../shared/contracts.js';
import { HttpError } from '../errors.js';
import { recordAudit } from '../audit.js';
import { publicUrlOrOrigin } from '../publicUrl.js';
import { resolveTextLanguage, serverText } from '../serverText.js';
import * as invites from '../invites.js';
import * as storage from '../storage.js';
import * as store from './store.js';
import * as session from './session.js';
import * as providers from './providers.js';
import { syncIdpGroups } from './groupSync.js';
import { safeAppPath, withAuthError } from './returnPath.js';
import type { AuthProvider } from './providers.js';
import { completeScimPlaceholder, findPendingScimIdentity, findPendingScimIdentityByEmail } from '../scim/identities.js';
import { isScimEnabled } from '../scim/tokens.js';

export type SsoErrorCode =
  | 'state'
  | 'exchange'
  | 'provider'
  | 'denied'
  | 'domain'
  | 'unverified'
  | 'disabled'
  | 'no_account'
  | 'no_email'
  | 'link_unverified'
  | 'link_not_authoritative'
  | 'link_domain'
  | 'already_linked'
  | 'invite'
  | 'invite_email'
  | 'replay';

/** What a provider said about the person, after the provider's attribute/claim mapping. */
export interface MappedClaims {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  /** The provider explicitly said the email is NOT verified (OIDC `email_verified: false`; Entra and SAML send nothing). */
  emailUnverifiedExplicitly: boolean;
  name: string | null;
  groups: unknown;
  /** Entra "overage": too many groups for the token, the claim was replaced by `_claim_names` / `hasgroups` — the list is unknown, not empty. OIDC only. */
  groupsOverage?: boolean;
  /** Google's hosted-domain claim. */
  hd: string | undefined;
}

export type SsoOutcome =
  | { kind: 'login'; userId: string; how: 'existing' | 'linked' | 'created' | 'invite'; via?: 'scim_email' }
  | { kind: 'refuse'; reason: SsoErrorCode; userId?: string };

function refuse(reason: SsoErrorCode, userId?: string): SsoOutcome {
  return { kind: 'refuse', reason, userId };
}

async function applyJitSpaces(userId: string, spaces: AuthProvider['jitDefaultSpaces']): Promise<void> {
  for (const [slug, role] of Object.entries(spaces)) {
    if (!(await storage.spaceExists(slug))) continue; // a renamed/removed space is skipped, not an error
    await store.setMembership(slug, userId, role);
  }
}

/**
 * The decision, with every write it implies (identity, link, account). `issuer` is the provider's validated issuer
 * (OIDC: the discovery document's, which the ID token's `iss` was checked against; SAML: the IdP entity ID the
 * assertion's Issuer was checked against). Never called in test mode.
 */
export async function resolveSsoSignIn(
  provider: AuthProvider,
  issuer: string,
  m: MappedClaims,
  opts: { inviteToken?: string } = {},
): Promise<SsoOutcome> {
  if (!m.subject) return refuse('exchange');

  // A non-empty allowlist gates every sign-in through this provider (Google: a personal account is not let in).
  if (provider.allowedDomains.length > 0) {
    if (!m.email) return refuse('no_email');
    if (!providers.domainAllowed(provider, m.email)) return refuse('domain');
    if (m.hd && !provider.allowedDomains.includes(m.hd.trim().toLowerCase())) return refuse('domain');
  }

  const identity = await providers.findIdentity(issuer, m.subject);
  if (identity) {
    const user = await store.findStoredUserById(identity.userId);
    if (!user || user.isSystem || user.disabled) return refuse('disabled', identity.userId);
    await providers.touchIdentity(identity.id, m.email, m.groups);
    return { kind: 'login', userId: user.id, how: 'existing' };
  }

  // An account this provider created over SCIM, signing in for the first time with the id SCIM gave it.
  const pending = await findPendingScimIdentity(provider.id, m.subject, { matchUserName: provider.kind === 'saml' });
  if (pending) {
    const user = await store.findStoredUserById(pending.userId);
    if (!user || user.isSystem || user.disabled) return refuse('disabled', pending.userId);
    await completeScimPlaceholder(provider.id, user.id, { issuer, subject: m.subject, email: m.email, groups: m.groups });
    return { kind: 'login', userId: user.id, how: 'linked' };
  }

  // Same provider's SCIM placeholder with this very email: trusted without email_verified (Entra over OIDC sends none).
  // Owner decision 22.10.2026/23.10.2026. Placeholders only; ordinary accounts go through the verified-email rule below.
  if (m.email && (provider.allowedDomains.length === 0 || providers.domainAllowed(provider, m.email))) {
    const byEmail = await findPendingScimIdentityByEmail(provider.id, m.email);
    if (byEmail) {
      const user = await store.findStoredUserById(byEmail.userId);
      if (!user || user.isSystem || user.disabled) return refuse('disabled', byEmail.userId);
      if (await completeScimPlaceholder(provider.id, user.id, { issuer, subject: m.subject, email: m.email, groups: m.groups })) {
        return { kind: 'login', userId: user.id, how: 'linked', via: 'scim_email' };
      }
    }
  }

  if (m.email) {
    const existing = await store.findStoredUserByEmail(m.email);
    if (existing) {
      if (existing.isSystem) return refuse('disabled', existing.id);
      // OIDC: the provider did not vouch for the email. SAML has no such flag, so there the admin must have marked the IdP
      // authoritative for the domain: a different remedy, and a different message.
      if (!m.emailVerified) return refuse(provider.kind === 'saml' ? 'link_not_authoritative' : 'link_unverified', existing.id);
      if (!providers.domainAllowed(provider, m.email)) return refuse('link_domain', existing.id);
      if (await providers.userHasIdentityForProvider(existing.id, provider.id)) return refuse('already_linked', existing.id);
      if (existing.disabled) return refuse('disabled', existing.id);
      const identity = { issuer, subject: m.subject, email: m.email, groups: m.groups };
      if (!(await completeScimPlaceholder(provider.id, existing.id, identity))) {
        await providers.createIdentity({ userId: existing.id, providerId: provider.id, ...identity });
      }
      return { kind: 'login', userId: existing.id, how: 'linked' };
    }
  }

  if (opts.inviteToken) {
    const invite = await invites.getInviteByToken(opts.inviteToken);
    if (invites.invalidReason(invite)) return refuse('invite');
    if (!m.email) return refuse('no_email');
    if (m.emailUnverifiedExplicitly) return refuse('unverified');
    if (invite!.email && invite!.email.trim().toLowerCase() !== m.email) return refuse('invite_email');
    const claimed = await invites.claimInviteUse(opts.inviteToken);
    if (!claimed) return refuse('invite');
    const user = await store.createUser({ email: m.email, name: m.name || m.email, isAdmin: claimed.isAdmin, passwordHash: null });
    await providers.createIdentity({ userId: user.id, providerId: provider.id, issuer, subject: m.subject, email: m.email, groups: m.groups });
    for (const ms of claimed.memberships) await store.setMembership(ms.space, user.id, ms.role);
    recordAudit(user.id, 'invite.accepted', claimed.id, { email: m.email, via: 'sso', provider: provider.slug });
    return { kind: 'login', userId: user.id, how: 'invite' };
  }

  if (!provider.jitEnabled || (await isScimEnabled(provider.id))) return refuse('no_account');
  if (!m.email) return refuse('no_email');
  if (m.emailUnverifiedExplicitly) return refuse('unverified');
  const user = await store.createUser({ email: m.email, name: m.name || m.email, isAdmin: false, passwordHash: null });
  await providers.createIdentity({ userId: user.id, providerId: provider.id, issuer, subject: m.subject, email: m.email, groups: m.groups });
  await applyJitSpaces(user.id, provider.jitDefaultSpaces);
  return { kind: 'login', userId: user.id, how: 'created' };
}

const AUDIT_ACTION: Record<'existing' | 'linked' | 'created' | 'invite', string> = {
  existing: 'auth.sso_login',
  linked: 'auth.sso_link',
  created: 'auth.sso_jit_create',
  invite: 'auth.sso_jit_create',
};

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

export function requestOrigin(request: FastifyRequest): string {
  return `${request.protocol}://${request.hostname}`;
}

/** Back to the app with `authError=<code>`: to the page the person started from (`returnTo`, when the flow kept one) so a retry returns there too, else to `/`. */
export function redirectToLoginError(reply: FastifyReply, request: FastifyRequest, code: SsoErrorCode, returnTo?: string | null): FastifyReply {
  return reply.redirect(`${publicUrlOrOrigin(requestOrigin(request))}${withAuthError(returnTo, code)}`);
}

/** The query `returnTo` of a start URL, validated: the page to come back to, or undefined (default landing). */
export function startReturnTo(query: { returnTo?: unknown }): string | undefined {
  return safeAppPath(query.returnTo) ?? undefined;
}

/**
 * After the protocol module validated the provider's answer: decide (resolveSsoSignIn), audit, and either start a
 * session and go home or refuse through `fail`. `protocol` lands in the audit meta.
 */
export async function finishSsoSignIn(
  request: FastifyRequest,
  reply: FastifyReply,
  input: {
    provider: AuthProvider;
    issuer: string;
    mapped: MappedClaims;
    inviteToken?: string;
    /** The page the person opened before signing in (validated at the start and again here); default: the app root. */
    returnTo?: string;
    protocol: 'oidc' | 'saml';
    fail: (code: SsoErrorCode, detail?: string) => FastifyReply;
  },
): Promise<FastifyReply> {
  const { provider, issuer, mapped, protocol, fail } = input;
  const slug = provider.slug;
  let outcome: SsoOutcome;
  try {
    outcome = await resolveSsoSignIn(provider, issuer, mapped, { inviteToken: input.inviteToken });
  } catch (err) {
    request.log.error({ err: err instanceof Error ? err.message : err, provider: slug }, 'sso: sign-in resolution failed');
    return fail('exchange');
  }

  if (outcome.kind === 'refuse') {
    request.log.warn({ reason: outcome.reason, provider: slug, email: mapped.email }, 'sso: sign-in refused');
    recordAudit(outcome.userId ?? null, 'auth.sso_refused', slug, { reason: outcome.reason, email: mapped.email, subject: mapped.subject, protocol });
    return fail(outcome.reason);
  }

  recordAudit(outcome.userId, AUDIT_ACTION[outcome.how], slug, {
    email: mapped.email,
    subject: mapped.subject,
    protocol,
    ...(outcome.how === 'invite' ? { via: 'invite' } : {}),
    ...(outcome.how === 'linked' && outcome.via ? { via: outcome.via } : {}),
  });
  // Every kind of sign-in (existing, linked, invite, JIT), OIDC and SAML alike — the account exists by now. Never fails the sign-in.
  await syncIdpGroups(outcome.userId, provider.id, provider.kind, mapped.groups, { provider, overage: mapped.groupsOverage });
  const { token } = await store.createSession(outcome.userId, { userAgent: request.headers['user-agent'], ip: request.ip });
  session.setSessionCookie(reply, token);
  return reply.redirect(`${publicUrlOrOrigin(requestOrigin(request))}${safeAppPath(input.returnTo) ?? '/'}`);
}

/** 403 `sso_required`: the login screen then sends the person to the provider (POST /api/auth/sso/discover names it). */
export function ssoRequired(_provider: AuthProvider, message = 'this email domain signs in with single sign-on'): HttpError {
  return new HttpError(403, message, 'sso_required');
}

export function toPublicProvider(p: AuthProvider): SsoProviderPublic {
  return { slug: p.slug, name: p.displayName, kind: p.kind };
}

/** For GET /api/auth/state: the login buttons. */
export async function publicProviders(): Promise<SsoProviderPublic[]> {
  return (await providers.listEnabledProviders()).map(toPublicProvider);
}

// ---------------------------------------------------------------------------
// Signed flow cookies (HMAC, keyed by FOLIO_SECRET and the protocol)
// ---------------------------------------------------------------------------

const processKeys = new Map<string, Buffer>();
function flowKey(purpose: string): Buffer {
  const secret = process.env.FOLIO_SECRET;
  if (secret) return createHash('sha256').update(`${purpose}:${secret}`).digest();
  // Without FOLIO_SECRET a per-process key: a restart only invalidates sign-ins that are in flight.
  let key = processKeys.get(purpose);
  if (!key) {
    key = randomBytes(32);
    processKeys.set(purpose, key);
  }
  return key;
}

export function signPayload(purpose: string, payload: { exp: number }): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = createHmac('sha256', flowKey(purpose)).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/** The payload, or null when the value is missing, tampered with, signed for another purpose or past `exp` (seconds). */
export function verifyPayload<T extends { exp: number }>(purpose: string, raw: string | undefined): T | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const body = raw.slice(0, dot);
  const mac = Buffer.from(raw.slice(dot + 1), 'base64url');
  const expected = createHmac('sha256', flowKey(purpose)).update(body).digest();
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// "Test connection" result page
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * The language of the Test connection popup: the admin's saved UI language, else their browser's. `adminId` is the
 * admin the signed flow cookie names (a SAML response is a cross-site POST, so no session cookie comes along); without
 * it the session cookie is read. Never throws: the popup must render whatever happens.
 */
export async function testPopupLanguage(request: FastifyRequest, adminId?: string): Promise<string> {
  let preferred: string | null | undefined;
  try {
    const user = adminId ? await store.findStoredUserById(adminId) : await session.userForToken(request.cookies?.[session.SESSION_COOKIE_NAME]);
    preferred = user?.lang;
  } catch {
    preferred = undefined;
  }
  return resolveTextLanguage(preferred, request.headers['accept-language']);
}

/** The popup page "Test connection" ends on: the claims, visible, and posted to the admin screen that opened it. Its own words are in `lang`; the claims JSON and the provider's error details stay as they are. */
export function renderTestResult(reply: FastifyReply, origin: string, result: SsoTestResult, lang?: string): FastifyReply {
  const json = JSON.stringify(result, null, 2);
  const inScript = JSON.stringify(result).replace(/</g, '\\u003c');
  const html = `<!doctype html><html lang="${escapeHtml(lang ?? 'en')}"><head><meta charset="utf-8"><title>${escapeHtml(serverText('ssoTest.title', lang))}</title>
<style>body{font:14px system-ui,sans-serif;margin:16px;color:#222;background:#fff}pre{white-space:pre-wrap;word-break:break-word;background:#f4f4f5;padding:12px;border-radius:6px}</style></head>
<body><h1 style="font-size:16px">${escapeHtml(serverText(result.ok ? 'ssoTest.ok' : 'ssoTest.failed', lang))}</h1>
<p>${escapeHtml(serverText('ssoTest.note', lang))}</p><pre>${escapeHtml(json)}</pre>
<script>try{if(window.opener){window.opener.postMessage({type:'folio-sso-test',result:${inScript}},${JSON.stringify(origin)});}}catch(e){}</script>
</body></html>`;
  reply.header('Cache-Control', 'no-store');
  return reply.type('text/html; charset=utf-8').send(html);
}

/** A library error with its `cause` chain (the failed check: signature, nonce, audience...), never a token. */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur; i++) {
    if (cur instanceof Error) {
      const code = (cur as { code?: unknown }).code;
      parts.push(typeof code === 'string' ? `${cur.message} (${code})` : cur.message);
      // An OAuth error response (openid-client ResponseBodyError) carries the provider's own reason, e.g. invalid_client.
      const { error, error_description: description } = cur as { error?: unknown; error_description?: unknown };
      if (typeof error === 'string') parts.push(typeof description === 'string' ? `${error}: ${description}` : error);
      cur = (cur as { cause?: unknown }).cause;
    } else break;
  }
  return parts.length ? parts.join(': ') : String(err);
}
