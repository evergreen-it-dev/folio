/**
 * Which provider, model and credential a run uses. Nothing here is decrypted
 * until a run really needs it (`plan*` and `describe*` only read which levels
 * are configured), so the settings screen keeps working when FOLIO_SECRET is
 * missing or was changed.
 *
 * The order per provider: personal (while the instance policy allows personal
 * keys) -> the current space's key -> the instance key -> the operator's
 * environment variable. Codex is personal only and never reaches a public site.
 * `space` must already be authorized by the caller.
 */
import type { AssistantCredentialProviderId, AssistantKeySource, AssistantProviderStatus } from '../../shared/contracts.js';
import * as assistantStore from './store.js';
import type { AssistantSettingsRow } from './store.js';
import { providerEnabled } from './providerFlags.js';
import { codexRuntimeAvailable } from './codexHome.js';
import { cursorRuntimeAvailable } from './cursorRuntime.js';
import { parseAssistantModel, PROVIDER_LABELS, providerDefaultModel } from './models.js';
import { getDecryptedProviderSecret, listApplicableCredentials, type ApplicableCredential, type ProviderCredentialTarget } from './providerCredentials.js';
import type { AssistantRoute } from './runtime/types.js';
import * as sharedKeys from './sharedKeys.js';

type ResolvedKeySource = { source: AssistantKeySource; apiKeyName: string | null; personalKeysAllowed: boolean };

export type AssistantRoutePlan = Omit<AssistantRoute, 'secret'>;

const ENV_KEYS: Partial<Record<AssistantCredentialProviderId, string>> = {
  minimax: 'MINIMAX_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};
/** The order `auto` tries after Cursor. */
const AUTO_PROVIDER_ORDER: readonly AssistantCredentialProviderId[] = ['anthropic', 'minimax', 'codex'];
/** A public site never gets a personal credential, so Codex is not on this list. */
const PUBLIC_PROVIDER_ORDER: readonly AssistantCredentialProviderId[] = ['anthropic', 'minimax'];

function envKey(provider: AssistantCredentialProviderId): string | null {
  const name = ENV_KEYS[provider];
  return (name && process.env[name]?.trim()) || null;
}

/**
 * Which level supplies the Cursor key, WITHOUT decrypting anything.
 * `includePersonal: false` skips the personal level whatever the policy says (public sites).
 */
export async function resolveKeySource(
  userId: string,
  space: string | null,
  personal?: AssistantSettingsRow,
  includePersonal = true,
): Promise<ResolvedKeySource> {
  const [personalKeysAllowed, settings] = await Promise.all([sharedKeys.getPersonalKeysAllowed(), personal ?? assistantStore.getSettings(userId)]);
  if (includePersonal && personalKeysAllowed && settings.hasKey) return { source: 'personal', apiKeyName: settings.cursorKeyName, personalKeysAllowed };
  if (space) {
    const spaceKey = await sharedKeys.getSpaceKeyInfo(space);
    if (spaceKey.configured) return { source: 'space', apiKeyName: spaceKey.apiKeyName, personalKeysAllowed };
  }
  const instanceKey = await sharedKeys.getInstanceKeyInfo();
  if (instanceKey.configured) return { source: 'instance', apiKeyName: instanceKey.apiKeyName, personalKeysAllowed };
  if (process.env.CURSOR_API_KEY?.trim()) return { source: 'environment', apiKeyName: null, personalKeysAllowed };
  return { source: 'none', apiKeyName: null, personalKeysAllowed };
}

/** Decrypted Cursor key for a run / a model list / a check. `space` is the already-authorized space the user is working in, or null. */
export async function resolveApiKey(
  userId: string,
  space: string | null,
  includePersonal = true,
): Promise<{ apiKey: string; source: AssistantKeySource; apiKeyName: string | null } | null> {
  const picked = await resolveKeySource(userId, space, undefined, includePersonal);
  let apiKey: string | null = null;
  switch (picked.source) {
    case 'personal':
      apiKey = await assistantStore.getDecryptedCursorKey(userId);
      break;
    case 'space':
      apiKey = (await sharedKeys.getDecryptedSpaceKey(space!))?.apiKey ?? null;
      break;
    case 'instance':
      apiKey = (await sharedKeys.getDecryptedInstanceKey())?.apiKey ?? null;
      break;
    case 'environment':
      apiKey = process.env.CURSOR_API_KEY?.trim() || null;
      break;
    case 'none':
      break;
  }
  return apiKey ? { apiKey, source: picked.source, apiKeyName: picked.apiKeyName } : null;
}

interface PickedCredential {
  source: Exclude<AssistantKeySource, 'none'>;
  keyName: string | null;
}

function pickCredential(
  provider: AssistantCredentialProviderId,
  rows: ApplicableCredential[],
  personalAllowed: boolean,
): PickedCredential | null {
  // A provider that is switched off (see providerFlags.ts) has no route, whatever row or environment key exists.
  if (!providerEnabled(provider)) return null;
  const inScope = (scope: ApplicableCredential['scope']): ApplicableCredential | undefined => rows.find((row) => row.provider === provider && row.scope === scope);
  const personal = personalAllowed ? inScope('user') : undefined;
  if (personal) return { source: 'personal', keyName: personal.label };
  if (provider === 'codex') return null;
  const space = inScope('space');
  if (space) return { source: 'space', keyName: space.label };
  const instance = inScope('instance');
  if (instance) return { source: 'instance', keyName: instance.label };
  return envKey(provider) ? { source: 'environment', keyName: null } : null;
}

interface PlanOptions {
  /** A run of an anonymous visitor of a public site: never a personal credential. */
  publicSite?: boolean;
  /**
   * Choosing a model on purpose (the settings screen): a named model whose credential is missing is no route.
   * A run is not strict: a signed-in run whose named model lost its credential resolves like `auto`, so the
   * conversation goes on instead of sticking on a 409.
   */
  strict?: boolean;
}

/** The route for this model preference, without decrypting anything. Null when no credential resolves. */
export async function planAssistantRoute(
  userId: string,
  space: string | null,
  modelPreference: string,
  options: PlanOptions = {},
): Promise<AssistantRoutePlan | null> {
  const publicSite = options.publicSite === true;
  const parsed = parseAssistantModel(modelPreference.trim() || 'auto');
  const [cursor, rows] = await Promise.all([resolveKeySource(userId, space, undefined, !publicSite), listApplicableCredentials(userId, space)]);
  const personalAllowed = !publicSite && cursor.personalKeysAllowed;
  const credentialPlan = (provider: AssistantCredentialProviderId, modelId: string): AssistantRoutePlan | null => {
    const credential = pickCredential(provider, rows, personalAllowed);
    return credential ? { provider, modelId, ...credential } : null;
  };
  const cursorPlan: AssistantRoutePlan | null = cursor.source === 'none'
    ? null
    : { provider: 'cursor', modelId: parsed.provider === 'cursor' ? parsed.modelId : 'auto', source: cursor.source, keyName: cursor.apiKeyName };

  // The fallback below is the `auto` order for a signed-in run; a public site never reaches a personal credential or Codex (see PUBLIC_PROVIDER_ORDER and publicSite above).
  if (parsed.provider !== 'cursor') {
    const concrete = credentialPlan(parsed.provider, parsed.modelId);
    if (concrete || (options.strict && !publicSite)) return concrete;
  } else if (parsed.modelId !== 'auto' && !publicSite) {
    if (cursorPlan || options.strict) return cursorPlan;
  }

  if (cursorPlan && cursorRuntimeAvailable()) return cursorPlan;
  for (const provider of publicSite ? PUBLIC_PROVIDER_ORDER : AUTO_PROVIDER_ORDER) {
    if (!providerEnabled(provider)) continue;
    // A server without the Codex binary never picks it on its own; a model chosen by name still gets the 503 at run start.
    if (provider === 'codex' && !codexRuntimeAvailable()) continue;
    const plan = credentialPlan(provider, providerDefaultModel(provider));
    if (plan) return plan;
  }
  // A Cursor key on a server that cannot run Cursor: the caller answers 503, as before other providers existed.
  return cursorPlan;
}

function credentialTarget(source: AssistantKeySource, userId: string, space: string | null): ProviderCredentialTarget | null {
  if (source === 'personal') return { scope: 'user', userId };
  if (source === 'space' && space) return { scope: 'space', space };
  if (source === 'instance') return { scope: 'instance' };
  return null;
}

async function decryptPlan(plan: AssistantRoutePlan, userId: string, space: string | null, includePersonal: boolean): Promise<string | null> {
  if (plan.provider === 'cursor') return (await resolveApiKey(userId, space, includePersonal))?.apiKey ?? null;
  if (plan.source === 'environment') return envKey(plan.provider);
  const target = credentialTarget(plan.source, userId, space);
  return target ? getDecryptedProviderSecret(plan.provider, target) : null;
}

/** The route of one run of a signed-in user, with the credential decrypted. */
export async function resolveAssistantRoute(user: { id: string }, space: string | null, modelPreference: string): Promise<AssistantRoute | null> {
  const plan = await planAssistantRoute(user.id, space, modelPreference);
  if (!plan) return null;
  const secret = await decryptPlan(plan, user.id, space, true);
  return secret ? { ...plan, secret } : null;
}

/** The route of a public-site run: Cursor as before when it resolves, otherwise space -> instance -> environment for Anthropic and then MiniMax. */
export async function resolvePublicAssistantRoute(user: { id: string }, space: string, modelPreference: string): Promise<AssistantRoute | null> {
  const plan = await planAssistantRoute(user.id, space, modelPreference, { publicSite: true });
  if (!plan) return null;
  const secret = await decryptPlan(plan, user.id, space, false);
  return secret ? { ...plan, secret } : null;
}

/** The saved credential of one provider for a check. */
export async function resolveProviderSecret(userId: string, space: string | null, provider: AssistantCredentialProviderId): Promise<string | null> {
  const [personalKeysAllowed, rows] = await Promise.all([sharedKeys.getPersonalKeysAllowed(), listApplicableCredentials(userId, space)]);
  const credential = pickCredential(provider, rows, personalKeysAllowed);
  if (!credential) return null;
  if (credential.source === 'environment') return envKey(provider);
  const target = credentialTarget(credential.source, userId, space);
  return target ? getDecryptedProviderSecret(provider, target) : null;
}

/** One entry per provider for the settings screen. */
export async function describeAssistantProviders(
  userId: string,
  space: string | null,
  cursor: Pick<ResolvedKeySource, 'source' | 'apiKeyName' | 'personalKeysAllowed'>,
): Promise<AssistantProviderStatus[]> {
  const rows = await listApplicableCredentials(userId, space);
  const statuses: AssistantProviderStatus[] = [{
    id: 'cursor',
    label: PROVIDER_LABELS.cursor,
    connected: cursor.source !== 'none',
    source: cursor.source,
    keyName: cursor.apiKeyName,
    shareable: true,
  }];
  for (const provider of AUTO_PROVIDER_ORDER) {
    if (!providerEnabled(provider)) continue;
    const credential = pickCredential(provider, rows, cursor.personalKeysAllowed);
    statuses.push({
      id: provider,
      label: PROVIDER_LABELS[provider],
      connected: credential !== null,
      source: credential?.source ?? 'none',
      keyName: credential?.keyName ?? null,
      shareable: provider !== 'codex',
    });
  }
  return statuses;
}
