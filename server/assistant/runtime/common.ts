/**
 * Bits shared by every assistant runtime (Cursor and the providers driven by
 * agentLoop.ts): the cancelled-run error and the run deadlines. Deliberately
 * free of SDK and database imports so the loop stays testable on its own.
 */
import type { AssistantRunMode } from '../../../shared/contracts.js';

export class AssistantRunCancelledError extends Error {
  constructor() {
    super('Cursor agent run cancelled');
    this.name = 'AssistantRunCancelledError';
  }
}

/** Ask is a single Q&A turn (default 300 s); Agent can chain many tool calls toward a goal and legitimately runs much longer (default 30 min) — see .env.example. */
export function defaultTotalTimeoutMs(runMode: AssistantRunMode): number {
  if (runMode === 'agent') return Number(process.env.CURSOR_AGENT_TIMEOUT_MS_AGENT) || 1_800_000;
  return Number(process.env.CURSOR_AGENT_TIMEOUT_MS) || 300_000;
}

/** No activity at all for this long means the run hung silently. */
export function defaultIdleTimeoutMs(): number {
  return Number(process.env.CURSOR_AGENT_IDLE_TIMEOUT_MS) || 600_000;
}

/** Awaits `work` for at most `ms`, never rejecting: cleanup must not hold the HTTP response hostage. */
export async function withCap(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    work.catch(() => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

/** Result of testing a provider credential before it is stored. */
export type ProviderKeyVerdict = 'ok' | 'rejected' | 'unavailable';
