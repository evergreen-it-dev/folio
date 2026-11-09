/**
 * AI assistant (Cursor SDK) — model catalog filtering. Ported near-verbatim
 * from a sibling project's server/assistant/models.ts (see that repo's
 * server/assistant/cursor-runtime.ts for how listCursorModels feeds this).
 * 'auto' is always first and never duplicated from the raw catalog — Cursor's
 * own catalog includes an 'auto'/'default' entry, which this collapses into
 * the one synthetic entry every caller expects.
 */
import type { AssistantCredentialProviderId, AssistantProviderId } from '../../shared/contracts.js';
import { providerEnabled } from './providerFlags.js';

export interface AssistantModelCatalogItem {
  id: string;
  label: string;
  description: string | null;
}

const BLOCKED_MODEL_NAME = /(claude|gpt)/i;
const AUTO_MODEL_ALIASES = new Set(['auto', 'default']);

export function assistantModelAllowed(id: string, label = id): boolean {
  return !BLOCKED_MODEL_NAME.test(`${id} ${label}`);
}

export function normalizeAssistantModelPreference(model: string): string {
  const trimmed = model.trim();
  if (AUTO_MODEL_ALIASES.has(trimmed.toLowerCase())) return 'auto';
  const parsed = parseAssistantModel(trimmed);
  // A stored model of a provider that is switched off (see providerFlags.ts) is just `auto`.
  if (parsed.provider !== 'cursor' && !providerEnabled(parsed.provider)) return 'auto';
  if (parsed.provider !== 'cursor') return isKnownProviderModel(parsed.provider, parsed.modelId) ? trimmed : 'auto';
  return assistantModelAllowed(trimmed) ? trimmed : 'auto';
}

/**
 * Providers other than Cursor. A stored model id is `<provider>:<id>`; a bare
 * id or `auto` belongs to Cursor, and BLOCKED_MODEL_NAME above only applies to
 * those bare ids, because it describes what the Cursor catalogue may offer.
 */
export const PROVIDER_MODELS: Record<AssistantCredentialProviderId, AssistantModelCatalogItem[]> = {
  anthropic: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', description: null },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', description: null },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', description: null },
  ],
  minimax: [
    { id: 'MiniMax-M3', label: 'MiniMax M3', description: null },
    { id: 'MiniMax-M3-thinking', label: 'MiniMax M3 (thinking)', description: null },
    { id: 'MiniMax-M3.1-Flash', label: 'MiniMax M3.1 Flash', description: null },
  ],
  // `default` passes no model to the CLI, which then picks what the ChatGPT subscription allows; no other id is known to work for every plan.
  codex: [{ id: 'default', label: 'Codex (your ChatGPT plan)', description: 'The model your ChatGPT subscription allows' }],
};

export const PROVIDER_LABELS: Record<AssistantProviderId, string> = {
  cursor: 'Cursor',
  anthropic: 'Claude (Anthropic API)',
  minimax: 'MiniMax',
  codex: 'Codex (ChatGPT subscription)',
};

/** The first model of a provider is its default. */
export function providerDefaultModel(provider: AssistantCredentialProviderId): string {
  return PROVIDER_MODELS[provider][0]!.id;
}

export function isKnownProviderModel(provider: AssistantCredentialProviderId, modelId: string): boolean {
  return PROVIDER_MODELS[provider].some((model) => model.id === modelId);
}

/** The id a model has in settings and on conversations. */
export function providerModelId(provider: AssistantCredentialProviderId, modelId: string): string {
  return `${provider}:${modelId}`;
}

export type ParsedAssistantModel =
  | { provider: 'cursor'; modelId: string }
  | { provider: AssistantCredentialProviderId; modelId: string };

export function parseAssistantModel(model: string): ParsedAssistantModel {
  const separator = model.indexOf(':');
  const prefix = separator > 0 ? model.slice(0, separator) : '';
  if (prefix === 'minimax' || prefix === 'anthropic' || prefix === 'codex') return { provider: prefix, modelId: model.slice(separator + 1) };
  return { provider: 'cursor', modelId: model };
}

export function filterAssistantModels(models: AssistantModelCatalogItem[]): AssistantModelCatalogItem[] {
  const seen = new Set<string>();
  const allowed: AssistantModelCatalogItem[] = [];
  for (const model of models) {
    const id = model.id.trim();
    const label = model.label.trim();
    const normalizedId = id.toLowerCase();
    if (!id || AUTO_MODEL_ALIASES.has(normalizedId) || label.toLowerCase() === 'auto') continue;
    if (!assistantModelAllowed(id, label) || seen.has(normalizedId)) continue;
    seen.add(normalizedId);
    allowed.push({ ...model, id, label });
  }
  return [{ id: 'auto', label: 'Auto', description: null }, ...allowed.sort((left, right) => left.label.localeCompare(right.label))];
}
