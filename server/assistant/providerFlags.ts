/**
 * Providers the operator of a self-hosted server switches on. Both are off unless their variable is 1 (or true):
 *   FOLIO_CODEX_ENABLED=1    Codex through a ChatGPT sign-in (OpenAI has not confirmed this use on a shared server)
 *   FOLIO_MINIMAX_ENABLED=1  MiniMax with an API key
 * Off means not listed, not routed, no routes, no credential used (even an existing row or environment key) and,
 * for Codex, no child process. Read at call time, so a test can flip it.
 */
import type { AssistantCredentialProviderId } from '../../shared/contracts.js';

const FLAG_VARIABLES: Partial<Record<AssistantCredentialProviderId, string>> = {
  codex: 'FOLIO_CODEX_ENABLED',
  minimax: 'FOLIO_MINIMAX_ENABLED',
};

/** Providers without a flag (Anthropic) are always on. */
export function providerEnabled(provider: AssistantCredentialProviderId): boolean {
  const name = FLAG_VARIABLES[provider];
  if (!name) return true;
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

export function codexEnabled(): boolean {
  return providerEnabled('codex');
}

/** Thrown by the places that would start Codex work while the flag is off. */
export class CodexDisabledError extends Error {
  constructor() {
    super('Codex is not enabled on this server');
    this.name = 'CodexDisabledError';
  }
}

export function assertCodexEnabled(): void {
  if (!codexEnabled()) throw new CodexDisabledError();
}
