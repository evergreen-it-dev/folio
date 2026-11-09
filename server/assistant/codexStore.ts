/**
 * Where a user's Codex sign-in (the content of auth.json) is kept: the
 * `assistant_provider_credentials` row of scope user and provider codex,
 * encrypted like every other provider credential. Codex is personal only.
 */
import { getDecryptedProviderSecret, saveProviderCredential, updateProviderCredentialSecret } from './providerCredentials.js';
import type { CodexAuthStore } from './codexHome.js';

/** Load and write-back for a run or a status check; the write-back never resurrects a removed credential. */
export function codexAuthStore(userId: string): CodexAuthStore {
  return {
    load: () => getDecryptedProviderSecret('codex', { scope: 'user', userId }),
    save: async (authJson) => { await updateProviderCredentialSecret('codex', { scope: 'user', userId }, authJson); },
  };
}

/** A finished login: stores (or replaces) the sign-in. The label is the ChatGPT account's e-mail address when the token carries one. */
export async function saveCodexLogin(userId: string, authJson: string, email: string | null): Promise<void> {
  await saveProviderCredential('codex', { scope: 'user', userId }, authJson, email, userId);
}
