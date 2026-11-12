/**
 * POST /api/assistant/warm — "the user just opened the assistant panel (or switched conversation in it)".
 * Prepares what the next run would otherwise build while the user waits. Zero model tokens: nothing here ever
 * sends a prompt (see warmSlots.ts for the rules). Errors are logged, never surfaced; the caller already answered 202.
 *
 *   - process level: the modules the route's provider needs (Cursor SDK + its configuration; the Anthropic
 *     runtime modules);
 *   - per conversation (Cursor only, and only for a conversation of this user): the workspace and a resumed,
 *     reloaded SDK agent in a warm slot, which the next run of that conversation takes (cursorRuntime.ts).
 *     The Anthropic runtime is in-process (no subprocess, no agent to resume), so it gets the module warm only.
 */
import type { AssistantRunMode, User } from '../../shared/contracts.js';
import { providerEnabled } from './providerFlags.js';
import { resolveAssistantRoute } from './providerRouting.js';
import { cursorRuntimeAvailable, warmCursorConversation, warmCursorModules } from './cursorRuntime.js';
import * as assistantStore from './store.js';
import type { AssistantConversationRow } from './store.js';
import { warmEnabled } from './warmSlots.js';

/** The same user warming the same target again within this window is ignored. */
const RATE_LIMIT_MS = 30_000;
const recent = new Map<string, number>();

/** True when this call should go ahead; false when the same user warmed the same target moments ago. */
export function warmRateLimitAllows(userId: string, target: readonly (string | null)[], now = Date.now()): boolean {
  if (recent.size > 500) for (const [key, at] of recent) if (now - at > RATE_LIMIT_MS) recent.delete(key);
  const key = `${userId}|${target.map((part) => part ?? '').join('|')}`;
  const last = recent.get(key);
  if (last !== undefined && now - last < RATE_LIMIT_MS) return false;
  recent.set(key, now);
  return true;
}

export function resetWarmRateLimit(): void {
  recent.clear();
}

export interface WarmRequest {
  user: User;
  /** Already authorized (access.ts authorizeAssistantNavigation). */
  space: string | null;
  pageId: string | null;
  currentPath: string | null;
  runMode: AssistantRunMode;
  /** The user's own conversation (already looked up with the user id), or null: process-level warm only. */
  conversation: AssistantConversationRow | null;
}

export async function warmAssistant(request: WarmRequest): Promise<void> {
  try {
    if (!warmEnabled()) return;
    const { user, conversation } = request;
    const model = conversation?.model ?? (await assistantStore.getModel(user.id));
    const route = await resolveAssistantRoute(user, request.space, model);
    if (!route) return;
    switch (route.provider) {
      case 'cursor': {
        if (!cursorRuntimeAvailable()) return;
        await warmCursorModules();
        if (conversation) {
          warmCursorConversation({
            apiKey: route.secret,
            model: route.modelId,
            user,
            conversation,
            runMode: request.runMode,
            currentPath: request.currentPath,
            space: request.space,
            pageId: request.pageId,
          });
        }
        return;
      }
      case 'anthropic':
        if (providerEnabled('anthropic')) await Promise.all([import('./runtime/harness.js'), import('./runtime/anthropic.js')]);
        return;
      case 'minimax':
        if (providerEnabled('minimax')) await Promise.all([import('./runtime/harness.js'), import('./runtime/minimax.js')]);
        return;
      default:
        return; // codex: its own child process, nothing cheap to prepare
    }
  } catch (error) {
    console.warn('assistant warm-up failed:', error instanceof Error ? error.message : String(error));
  }
}
