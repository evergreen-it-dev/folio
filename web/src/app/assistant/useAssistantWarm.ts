import { useEffect } from 'react';
import type { AssistantRunMode, AssistantWarmBody } from '@shared/contracts';
import { api } from '../api';

/** The same conversation is not warmed again within this window (the server keeps a warm slot for minutes, so a repeat is pointless). */
export const WARM_DEDUPE_MS = 60_000;
const lastWarmed = new Map<string, number>();

/**
 * Tells the server the assistant is about to be used, so it can get ready (POST /api/assistant/warm — costs no model
 * tokens). Fire and forget, never throws, at most one call per conversation per WARM_DEDUPE_MS. Returns whether a
 * request was sent.
 */
export function warmAssistantOnce(
  body: AssistantWarmBody,
  send: (body: AssistantWarmBody) => Promise<unknown> = api.warmAssistant,
  now: number = Date.now(),
): boolean {
  const key = body.conversationId ?? 'none';
  const last = lastWarmed.get(key);
  if (last !== undefined && now - last < WARM_DEDUPE_MS) return false;
  lastWarmed.set(key, now);
  void Promise.resolve()
    .then(() => send(body))
    .catch(() => undefined);
  return true;
}

export function resetWarmDedupe(): void {
  lastWarmed.clear();
}

/**
 * While the panel is visible: warm when it opens and when its conversation changes. Nothing while it is closed,
 * no timers, no polling. `ready` is false when no key/runtime is configured (nothing to warm then).
 */
export function useAssistantWarm(opts: {
  open: boolean;
  ready: boolean;
  conversationId: string | null;
  runMode: AssistantRunMode;
  space: string | null;
  pageId: string | null;
  currentPath: string;
}): void {
  const { open, ready, conversationId, runMode, space, pageId, currentPath } = opts;
  useEffect(() => {
    if (!open || !ready) return;
    warmAssistantOnce({ conversationId, runMode, space, pageId, currentPath });
    // Only opening and switching conversation warm; moving between pages inside an open panel does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ready, conversationId]);
}
