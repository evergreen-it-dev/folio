/**
 * The single entry point of an assistant run, dispatching on the provider of
 * its route. Cursor keeps its own runtime; the others share agentLoop.ts and
 * are loaded on first use.
 */
import type { AssistantCredentialProviderId } from '../../../shared/contracts.js';
import { assertCodexEnabled, providerEnabled } from '../providerFlags.js';
import { runCursorAssistant } from '../cursorRuntime.js';
import type { ProviderKeyVerdict } from './common.js';
import type { RunAssistantInput } from './types.js';

export type { AssistantRoute, RunAssistantInput } from './types.js';

export async function runAssistant(input: RunAssistantInput): Promise<string> {
  const { route } = input;
  if (route.provider !== 'cursor' && !providerEnabled(route.provider)) throw new Error(`The ${route.provider} provider is not enabled on this server`);
  switch (route.provider) {
    case 'cursor': {
      const { route: _route, ...rest } = input;
      return runCursorAssistant({ ...rest, apiKey: route.secret, model: route.modelId });
    }
    case 'minimax': {
      const [{ runWithChatModel }, { createMinimaxChatModel }] = await Promise.all([import('./harness.js'), import('./minimax.js')]);
      return runWithChatModel(input, (seed) => createMinimaxChatModel({ apiKey: route.secret, modelId: route.modelId, seed }));
    }
    case 'anthropic': {
      const [{ runWithChatModel }, { createAnthropicChatModel }] = await Promise.all([import('./harness.js'), import('./anthropic.js')]);
      return runWithChatModel(input, (seed) => createAnthropicChatModel({ apiKey: route.secret, modelId: route.modelId, runMode: input.runMode, seed }));
    }
    case 'codex': {
      assertCodexEnabled();
      const { runCodexAssistant } = await import('./codex.js');
      return runCodexAssistant(input);
    }
  }
}

/** Tests a credential with the provider before it is stored. Codex has a login flow instead of a key. */
export async function verifyProviderKey(provider: Exclude<AssistantCredentialProviderId, 'codex'>, apiKey: string): Promise<ProviderKeyVerdict> {
  if (provider === 'minimax') return (await import('./minimax.js')).verifyMinimaxKey(apiKey);
  return (await import('./anthropic.js')).verifyAnthropicKey(apiKey);
}
