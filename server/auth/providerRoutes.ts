/**
 * /admin/auth's API: the single sign-on providers (docs/AUTH.md). Instance
 * admin on a cookie session only — a PAT never reaches it. Providers defined
 * in the environment are listed read-only. The client secret is write-only:
 * no response carries it, only `hasClientSecret`.
 *
 * "Test connection" is GET /api/auth/oidc/:slug/start?test=1 (oidc.ts) or
 * /api/auth/saml/:slug/start?test=1 (saml.ts), opened in a popup: a real
 * round-trip whose claims / attributes are shown, nothing created or linked.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthProviderInfo } from '../../shared/contracts.js';
import { authProviderBodySchema, authProviderPatchSchema } from '../../shared/contracts.js';
import { parseBody } from '../validate.js';
import { badRequest } from '../errors.js';
import { recordAudit } from '../audit.js';
import { assertNotDemo } from '../demo.js';
import { hasSecretConfigured } from '../secretCrypto.js';
import * as session from './session.js';
import * as providers from './providers.js';
import { redirectUriFor as oidcRedirectUri } from './oidc.js';
import { samlSpFor } from './saml.js';
import { isScimEnabled, scimEnabledProviderIds } from '../scim/tokens.js';
import { requestOrigin } from '../publicUrl.js';

/** What the admin registers at the IdP: the OIDC redirect URL, or the SAML ACS URL plus the SP entity ID / metadata URL. */
function infoFor(p: providers.AuthProvider, origin: string, identities: number): AuthProviderInfo {
  if (p.kind === 'saml') {
    const sp = samlSpFor(p, origin);
    return providers.toProviderInfo(p, sp.acsUrl, identities, sp);
  }
  return providers.toProviderInfo(p, oidcRedirectUri(p, origin), identities);
}

function guard(request: FastifyRequest): void {
  session.requireCookieAuth(request);
  session.requireInstanceAdmin(request);
}

/** What changed, for the audit log — never the secret itself, nor whole metadata documents / certificates. */
function auditFields(body: Record<string, unknown>): Record<string, unknown> {
  const { clientSecret, saml, ...rest } = body;
  const samlFields = saml && typeof saml === 'object' ? { ...(saml as Record<string, unknown>) } : undefined;
  if (samlFields) {
    for (const k of ['metadataXml', 'idpCert']) if (typeof samlFields[k] === 'string') samlFields[k] = samlFields[k] ? 'set' : 'cleared';
  }
  return {
    ...rest,
    ...(clientSecret !== undefined ? { clientSecret: clientSecret ? 'set' : 'cleared' } : {}),
    ...(samlFields ? { saml: samlFields } : {}),
  };
}

export function registerAuthProviderRoutes(app: FastifyInstance): void {
  app.get('/api/admin/auth/providers', async (request): Promise<{ providers: AuthProviderInfo[]; secretConfigured: boolean }> => {
    guard(request);
    const counts = await providers.countIdentitiesByProvider();
    const origin = requestOrigin(request);
    const list = await providers.listProviders();
    const scim = await scimEnabledProviderIds();
    return {
      providers: list.map((p) => ({ ...infoFor(p, origin, counts.get(p.id) ?? 0), scimEnabled: scim.has(p.id) })),
      secretConfigured: hasSecretConfigured(),
    };
  });

  app.post('/api/admin/auth/providers', async (request, reply): Promise<AuthProviderInfo> => {
    guard(request);
    assertNotDemo('Configuring single sign-on');
    const body = parseBody(authProviderBodySchema, request.body);
    const created = await providers.createProvider(body);
    recordAudit(request.authUser!.id, 'auth.provider_created', created.slug, auditFields(body));
    reply.status(201);
    return infoFor(created, requestOrigin(request), 0);
  });

  app.patch('/api/admin/auth/providers/:id', async (request): Promise<AuthProviderInfo> => {
    guard(request);
    assertNotDemo('Configuring single sign-on');
    const { id } = request.params as { id: string };
    const body = parseBody(authProviderPatchSchema, request.body);
    // SCIM provisioning replaces JIT creation: both on at once would let sign-in create accounts SCIM never sent.
    if (body.jitEnabled === true && (await isScimEnabled(id))) {
      throw badRequest('SCIM provisioning is on for this provider: accounts come from SCIM, so JIT account creation stays off. Revoke the SCIM token first.');
    }
    const updated = await providers.updateProvider(id, body);
    recordAudit(request.authUser!.id, 'auth.provider_updated', updated.slug, auditFields(body));
    const counts = await providers.countIdentitiesByProvider();
    return { ...infoFor(updated, requestOrigin(request), counts.get(updated.id) ?? 0), scimEnabled: await isScimEnabled(updated.id) };
  });

  app.delete('/api/admin/auth/providers/:id', async (request) => {
    guard(request);
    assertNotDemo('Configuring single sign-on');
    const { id } = request.params as { id: string };
    const deleted = await providers.deleteProvider(id);
    recordAudit(request.authUser!.id, 'auth.provider_deleted', deleted.slug);
    return { ok: true };
  });
}
