/**
 * AI assistant (Cursor SDK) — model catalog filtering. Ported near-verbatim
 * from a sibling project's server/assistant/models.ts (see that repo's
 * server/assistant/cursor-runtime.ts for how listCursorModels feeds this).
 * 'auto' is always first and never duplicated from the raw catalog — Cursor's
 * own catalog includes an 'auto'/'default' entry, which this collapses into
 * the one synthetic entry every caller expects.
 */
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
  return assistantModelAllowed(trimmed) ? trimmed : 'auto';
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
