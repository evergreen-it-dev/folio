import type { FastifyInstance } from 'fastify';
import {
  createApiTokenBodySchema,
  createUserBodySchema,
  loginBodySchema,
  saveGitCredentialBodySchema,
  setMemberBodySchema,
  setStarBodySchema,
  setupBodySchema,
  updateMyPreferencesBodySchema,
  updateUserBodySchema,
  normalizeUsername,
} from '../../shared/contracts.js';
import type { ApiTokenInfo, AuthState, CreatedApiToken, GitCredentialInfo, MentionableUser, SpaceMemberInfo, User } from '../../shared/contracts.js';
import { parseBody } from '../validate.js';
import { badRequest, conflict, unauthorized, HttpError } from '../errors.js';
import { hashPassword, verifyPassword } from './passwords.js';
import * as store from './store.js';
import * as session from './session.js';
import { isGoogleEnabled } from './google.js';
import * as userGitCredentials from '../userGitCredentials.js';
import * as userConfluenceCredentials from '../userConfluenceCredentials.js';
import { saveConfluenceCredentialBodySchema } from '../userConfluenceCredentials.js';
import type { ConfluenceCredentialInfo } from '../userConfluenceCredentials.js';
import { recordAudit } from '../audit.js';
import { assertNotDemo, assertNotDemoAccount, demoInfoFor, isDemoAccountEmail } from '../demo.js';
import { VISITOR_HEADER, analyticsConfig, rememberVisitor } from '../analytics.js';


async function toAuthState(user: User): Promise<AuthState> {
  return { needsSetup: false, user, memberships: await session.membershipsFor(user), google: isGoogleEnabled(), demo: demoInfoFor(true) };
}

/** Space-member endpoints accept either a user id or an email as the :identifier segment. */
async function resolveUserIdentifier(identifier: string) {
  const stored = identifier.includes('@') ? await store.findStoredUserByEmail(identifier) : await store.findStoredUserById(identifier);
  if (!stored) throw new HttpError(404, 'user not found');
  return stored;
}

/** GET /api/auth/state, POST /api/auth/setup, POST /api/auth/login — the only public auth routes. */
export function registerPublicAuthRoutes(app: FastifyInstance): void {
  app.get('/api/auth/state', async (request) => {
    const user = await session.userForRequest(request);
    const state: AuthState = {
      needsSetup: !(await store.hasAnyUsers()),
      user,
      memberships: user ? await session.membershipsFor(user) : {},
      google: isGoogleEnabled(),
      // Public-demo mode only (server/demo.ts); undefined — and so absent from the JSON — everywhere else.
      demo: demoInfoFor(Boolean(user)),
      // Optional analytics (server/analytics.ts); undefined — and so absent from the JSON — unless the operator switched it on.
      analytics: analyticsConfig(),
    };
    if (user) rememberVisitor(request.cookies?.[session.SESSION_COOKIE_NAME], request.headers[VISITOR_HEADER]);
    return state;
  });

  app.post('/api/auth/setup', async (request, reply) => {
    if (await store.hasAnyUsers()) throw conflict('setup has already been completed');
    const body = parseBody(setupBodySchema, request.body);
    const passwordHash = await hashPassword(body.password);
    const user = await store.createUser({ email: body.email, name: body.name, passwordHash, isAdmin: true });
    const { token } = await store.createSession(user.id);
    session.setSessionCookie(reply, token);
    reply.status(201);
    return toAuthState(user);
  });

  app.post('/api/auth/login', async (request, reply) => {
    const rl = await session.checkLoginRateLimit(request.ip);
    if (rl.limited) {
      reply.header('Retry-After', String(rl.retryAfterSeconds));
      throw new HttpError(429, 'too many login attempts, try again later');
    }

    const body = parseBody(loginBodySchema, request.body);
    const email = body.email.trim().toLowerCase();
    // Look up and verify unconditionally (even for an unknown email) so a real
    // bcrypt comparison always runs — see passwords.ts's DUMMY_HASH.
    const stored = await store.findStoredUserByEmail(email);
    const passwordOk = await verifyPassword(body.password, stored?.passwordHash ?? null);
    if (!stored || stored.disabled || !passwordOk) throw unauthorized('invalid email or password');

    const { token } = await store.createSession(stored.id);
    session.setSessionCookie(reply, token);
    rememberVisitor(token, request.headers[VISITOR_HEADER]);
    const { passwordHash: _passwordHash, googleSub: _googleSub, ...user } = stored;
    return toAuthState(user);
  });
}

/** Everything else: requires a session (registered in index.ts's protected scope). */
export function registerProtectedAuthRoutes(app: FastifyInstance): void {
  app.post('/api/auth/logout', async (request, reply) => {
    session.requireCookieAuth(request);
    const token = request.cookies?.[session.SESSION_COOKIE_NAME];
    if (token) await store.destroySession(token);
    session.clearSessionCookie(reply);
    reply.status(204).send();
  });

  // --- Instance-admin user management --------------------------------

  app.get('/api/users', async (request) => {
    session.requireCookieAuth(request);
    session.requireInstanceAdmin(request);
    return { users: await store.listUsers() };
  });

  /**
   * Round 27 §6.4: "Add a person" saves the user AND its space memberships
   * in one call — `memberships` is optional (matches createUserBodySchema;
   * omitted/empty = a user with no space access yet, same as pre-round-27
   * behavior). Applied AFTER createUser succeeds, same order invite-accept
   * (registerPublicInviteRoutes, below) already uses for its own
   * memberships loop — a membership row's FK is on the new user's id, so it
   * can't exist before the user does.
   */
  app.post('/api/users', async (request, reply) => {
    session.requireCookieAuth(request);
    session.requireInstanceAdmin(request);
    const body = parseBody(createUserBodySchema, request.body);
    const passwordHash = await hashPassword(body.password);
    const user = await store.createUser({ email: body.email, name: body.name, passwordHash, isAdmin: body.isAdmin });
    for (const m of body.memberships ?? []) {
      await store.setMembership(m.space, user.id, m.role);
    }
    reply.status(201);
    return user;
  });

  app.patch('/api/users/:id', async (request) => {
    session.requireCookieAuth(request);
    session.requireInstanceAdmin(request);
    const { id } = request.params as { id: string };
    const target = await store.findStoredUserById(id);
    if (!target) throw new HttpError(404, 'user not found');
    const body = parseBody(updateUserBodySchema, lowerCaseUsernameField(request.body));

    // Public demo: a shared demo login must keep working for the next visitor.
    // A demo account may not set anyone's password, nor lock out / demote another demo account.
    const caller = request.authUser!;
    if (body.password !== undefined) assertNotDemoAccount(caller, 'Changing a password');
    if ((body.disabled !== undefined || body.isAdmin !== undefined) && isDemoAccountEmail(target.email)) {
      assertNotDemoAccount(caller, 'Changing a demo account');
    }

    if (await store.wouldRemoveLastActiveAdmin(id, body)) {
      throw conflict('cannot demote or disable the last active instance admin');
    }

    const passwordHash = body.password !== undefined ? await hashPassword(body.password) : undefined;
    return store.updateUser(id, { name: body.name, username: body.username, isAdmin: body.isAdmin, passwordHash, disabled: body.disabled });
  });

  // --- Space membership (space admin+) --------------------------------

  app.get('/api/spaces/:space/members', async (request) => {
    session.requireCookieAuth(request);
    const { space } = request.params as { space: string };
    await session.requireSpaceRole(request, space, 'admin');
    const members = await store.listMembersWithDetails(space);
    return { members };
  });

  app.put('/api/spaces/:space/members/:identifier', async (request) => {
    assertNotDemoAccount(request.authUser!, 'Changing space members and roles');
    session.requireCookieAuth(request);
    const { space, identifier } = request.params as { space: string; identifier: string };
    await session.requireSpaceRole(request, space, 'admin');
    const body = parseBody(setMemberBodySchema, request.body);
    const stored = await resolveUserIdentifier(identifier);
    const userId = stored.id;

    const currentRole = await store.getMembershipRole(space, userId);
    const wouldOrphanSpace = currentRole === 'admin' && body.role !== 'admin' && (await store.countSpaceAdmins(space, userId)) === 0;
    if (wouldOrphanSpace) throw conflict('cannot demote the last admin of this space');

    await store.setMembership(space, userId, body.role);
    const { passwordHash: _passwordHash, googleSub: _googleSub, ...user } = stored;
    const info: SpaceMemberInfo = { user, role: body.role };
    return info;
  });

  app.delete('/api/spaces/:space/members/:identifier', async (request) => {
    assertNotDemoAccount(request.authUser!, 'Removing a space member');
    session.requireCookieAuth(request);
    const { space, identifier } = request.params as { space: string; identifier: string };
    await session.requireSpaceRole(request, space, 'admin');
    const userId = (await resolveUserIdentifier(identifier)).id;

    const currentRole = await store.getMembershipRole(space, userId);
    if (currentRole === 'admin' && (await store.countSpaceAdmins(space, userId)) === 0) {
      throw conflict('cannot remove the last admin of this space');
    }

    await store.removeMembership(space, userId);
    return { ok: true };
  });

  // --- @mentions (round 15) --------------------------------------------

  /** GET /api/spaces/:space/mentionable — viewer+ (same gate as reading anything else in the space). */
  app.get('/api/spaces/:space/mentionable', async (request) => {
    const { space } = request.params as { space: string };
    await session.requireSpaceRole(request, space, 'viewer');
    const users: MentionableUser[] = await store.listMentionableUsers(space);
    return { users };
  });

  // --- Preferences (round 10: i18n; round 15: @mention username;
  //     round 28: own display name) --------------------------------------

  app.patch('/api/me/preferences', async (request) => {
    session.requireWriteScope(request);
    // usernameSchema's regex only accepts already-lower-case input -- normalize
    // BEFORE the zod parse below, so e.g. "JohnDoe" is accepted (as "johndoe")
    // instead of failing validation. null (unset) and a missing field pass
    // through untouched; store.updateUsername also lower-cases defensively,
    // but doing it here first is what keeps a mixed-case handle from being
    // rejected as invalid in the first place.
    const body = parseBody(updateMyPreferencesBodySchema, lowerCaseUsernameField(request.body));
    // Public demo: the login is shared, so a visitor must not rename it (language stays editable).
    if (body.name !== undefined || body.username !== undefined) assertNotDemo('Changing the name or username');
    // {} is valid per the schema (every field optional) -- nothing to change, return current state.
    let user = request.authUser!;
    if (body.lang !== undefined) user = await store.updateUserLang(user.id, body.lang);
    if (body.username !== undefined) user = await store.updateUsername(user.id, body.username);
    // Round 28: own display name. Reuses store.updateUser (the same writer
    // the instance-admin PATCH /api/users/:id above already goes through --
    // it trims and COALESCEs every other column) rather than adding a second
    // UPDATE path for the one column. Editing only your OWN name can never
    // touch is_admin/disabled, so the wouldRemoveLastActiveAdmin guard that
    // the admin route needs has nothing to check here. The schema already
    // rejected a blank/whitespace-only name (see updateMyPreferencesBodySchema).
    if (body.name !== undefined) user = await store.updateUser(user.id, { name: body.name });
    return user;
  });

  // --- Stars -----------------------------------------------------------

  app.get('/api/me/stars', async (request) => {
    return store.getStars(request.authUser!.id);
  });

  app.put('/api/me/stars/space/:slug', async (request) => {
    session.requireWriteScope(request);
    const { slug } = request.params as { slug: string };
    const body = parseBody(setStarBodySchema, request.body);
    return store.setSpaceStar(request.authUser!.id, slug, body.starred);
  });

  app.put('/api/me/stars/page/:id', async (request) => {
    session.requireWriteScope(request);
    const { id } = request.params as { id: string };
    const body = parseBody(setStarBodySchema, request.body);
    return store.setPageStar(request.authUser!.id, id, body.starred);
  });

  app.put('/api/me/stars/emoji/:key', async (request) => {
    session.requireWriteScope(request);
    // Fastify's router (find-my-way) decodes the path param for us — an emoji in the
    // URL path arrives here already URL-decoded, not still percent-escaped.
    const { key: rawKey } = request.params as { key: string };
    const key = validateEmojiKey(rawKey);
    const body = parseBody(setStarBodySchema, request.body);
    return store.setEmojiStar(request.authUser!.id, key, body.starred);
  });

  // --- API tokens (round 7) — cookie-only: a stolen PAT must not be usable to
  // list, mint, or revoke tokens (no self-escalation / persistence via the API
  // it's itself authenticating with). ---------------------------------------

  app.get('/api/me/tokens', async (request) => {
    session.requireCookieAuth(request);
    const tokens: ApiTokenInfo[] = await store.listApiTokens(request.authUser!.id);
    return { tokens };
  });

  app.post('/api/me/tokens', async (request, reply) => {
    session.requireCookieAuth(request);
    assertNotDemo('Creating API tokens');
    const body = parseBody(createApiTokenBodySchema, request.body);
    const created: CreatedApiToken = await store.createApiToken(request.authUser!.id, body.name, body.scopes);
    recordAudit(request.authUser!.id, 'token.created', created.id, { name: created.name, scopes: created.scopes });
    reply.status(201);
    return created;
  });

  app.delete('/api/me/tokens/:id', async (request) => {
    session.requireCookieAuth(request);
    const { id } = request.params as { id: string };
    const revoked = await store.revokeApiToken(request.authUser!.id, id);
    if (!revoked) throw new HttpError(404, 'token not found');
    recordAudit(request.authUser!.id, 'token.revoked', id);
    return { ok: true };
  });

  // --- Saved git credentials (round 11) — cookie-only, same reasoning as API
  // tokens above: a stolen PAT must not be able to read/mint/revoke a saved
  // git PAT either. Listing never returns the token itself (GitCredentialInfo
  // has no token field at all) — only host/provider/label/createdAt. ---------

  app.get('/api/me/git-credentials', async (request) => {
    session.requireCookieAuth(request);
    const credentials: GitCredentialInfo[] = await userGitCredentials.listForUser(request.authUser!.id);
    return { credentials };
  });

  app.post('/api/me/git-credentials', async (request, reply) => {
    assertNotDemo('Saving git credentials');
    session.requireCookieAuth(request);
    session.requireWriteScope(request);
    const body = parseBody(saveGitCredentialBodySchema, request.body);
    const created = await userGitCredentials.saveCredential(request.authUser!.id, body.host, body.provider, body.token, body.label);
    recordAudit(request.authUser!.id, 'git_credential.saved', created.id, { host: created.host, provider: created.provider });
    reply.status(201);
    return created;
  });

  app.delete('/api/me/git-credentials/:id', async (request) => {
    session.requireCookieAuth(request);
    const { id } = request.params as { id: string };
    const deleted = await userGitCredentials.deleteCredential(request.authUser!.id, id);
    if (!deleted) throw new HttpError(404, 'git credential not found');
    recordAudit(request.authUser!.id, 'git_credential.deleted', id);
    return { ok: true };
  });

  // --- Saved Confluence credentials (round 22b) — same cookie-only gate as
  // saved git credentials and API tokens above: a stolen PAT must not be
  // able to read/mint/revoke a saved Confluence credential either. Listing
  // never returns the token itself (ConfluenceCredentialInfo has no token
  // field) — only host/kind/label/email(cloud only)/createdAt. -----------

  app.get('/api/me/confluence-credentials', async (request) => {
    session.requireCookieAuth(request);
    const credentials: ConfluenceCredentialInfo[] = await userConfluenceCredentials.listForUser(request.authUser!.id);
    return { credentials };
  });

  app.post('/api/me/confluence-credentials', async (request, reply) => {
    assertNotDemo('Saving Confluence credentials');
    session.requireCookieAuth(request);
    session.requireWriteScope(request);
    const body = parseBody(saveConfluenceCredentialBodySchema, request.body);
    const created = await userConfluenceCredentials.saveCredential(request.authUser!.id, body.host, body.kind, body.token, {
      email: body.email,
      label: body.label,
    });
    recordAudit(request.authUser!.id, 'confluence_credential.saved', created.id, { host: created.host, kind: created.kind });
    reply.status(201);
    return created;
  });

  app.delete('/api/me/confluence-credentials/:id', async (request) => {
    session.requireCookieAuth(request);
    const { id } = request.params as { id: string };
    const deleted = await userConfluenceCredentials.deleteCredential(request.authUser!.id, id);
    if (!deleted) throw new HttpError(404, 'confluence credential not found');
    recordAudit(request.authUser!.id, 'confluence_credential.deleted', id);
    return { ok: true };
  });
}

/**
 * Round 15: lower-cases a raw (pre-validation) `username` field on the
 * PATCH /api/me/preferences body, so updateMyPreferencesBodySchema's
 * usernameSchema (which requires already-lower-case input) validates a
 * mixed-case handle instead of rejecting it. `null` (unset) and a missing/
 * non-string field pass through untouched -- only an actual string is
 * transformed.
 */
function lowerCaseUsernameField(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || !('username' in body)) return body;
  const { username } = body as { username: unknown };
  if (typeof username !== 'string') return body;
  // One normalization for the client and the server: trim, strip leading `@`, lower-case.
  return { ...body, username: normalizeUsername(username) };
}

/** 1..16 chars after trim, non-empty, no control characters. No emoji-shape check
 * beyond that — a multi-codepoint sequence (variation selectors, ZWJ joiners) is a
 * single legitimate "favorite," and validating actual emoji-ness isn't this
 * endpoint's job (the client already only offers real emoji to pick from). */
function validateEmojiKey(raw: string): string {
  const key = raw.trim();
  if (!key) throw badRequest('emoji is required');
  if (key.length > 16) throw badRequest('emoji favorite is too long');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f-\x9f]/.test(key)) throw badRequest('invalid characters in emoji favorite');
  return key;
}
