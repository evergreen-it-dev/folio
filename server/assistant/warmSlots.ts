/**
 * Warm slots of the assistant: resources prepared when a user OPENS the panel (or switches conversation in it),
 * so that the first answer does not pay for them. The rules, from the owner (12.11.2026):
 *   - preparing costs zero model tokens: no prompt, no cache-prefill request, ever;
 *   - nothing is warmed at server start and there is no standing pool: a slot exists only because a user
 *     just opened that conversation, and it is closed after ASSISTANT_WARM_TTL_MS if no run took it;
 *   - at most ASSISTANT_WARM_MAX slots at once, the oldest evicted first.
 * Env knobs are read at call time (like providerFlags.ts), so a test can flip them.
 *
 * The store is generic (a slot holds "something with a close()"); what is warmed for Cursor lives in cursorRuntime.ts.
 */
import { createHash } from 'node:crypto';

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_SLOTS = 20;

/** ASSISTANT_WARM: on unless 0 / false. */
export function warmEnabled(): boolean {
  const raw = process.env.ASSISTANT_WARM?.trim().toLowerCase();
  return raw !== '0' && raw !== 'false';
}

export function warmTtlMs(): number {
  const value = Number(process.env.ASSISTANT_WARM_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TTL_MS;
}

export function warmMaxSlots(): number {
  const value = Math.floor(Number(process.env.ASSISTANT_WARM_MAX));
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_SLOTS;
}

export interface WarmResource {
  /** Closes everything the slot holds. Must not throw and must not hang (cap each step). */
  close: () => Promise<void>;
}

interface Slot {
  fingerprint: string;
  ready: Promise<WarmResource | null>;
  timer: NodeJS.Timeout;
}

/** `userId:conversationId`. */
export function warmKey(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`;
}

/** A short digest of what must be identical between the warm-up and the run (a secret never sits in a map key or a log line). */
export function warmFingerprint(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

// Map keeps insertion order: the first key is the oldest slot.
const slots = new Map<string, Slot>();

async function closeSlot(slot: Slot): Promise<void> {
  clearTimeout(slot.timer);
  const resource = await slot.ready;
  if (resource) await resource.close().catch(() => undefined);
}

export function warmSlotCount(): number {
  return slots.size;
}

/**
 * Starts preparing a slot unless this key already has one with the same fingerprint (then a no-op: false).
 * A slot with another fingerprint (the model or the key changed) is closed and replaced. `build` errors are
 * logged and leave no slot behind; they never reach the caller.
 */
export function startWarmSlot(key: string, fingerprint: string, build: () => Promise<WarmResource>): boolean {
  const existing = slots.get(key);
  if (existing) {
    if (existing.fingerprint === fingerprint) return false;
    slots.delete(key);
    void closeSlot(existing);
  }
  while (slots.size >= warmMaxSlots()) {
    const oldest = slots.entries().next().value;
    if (!oldest) break;
    slots.delete(oldest[0]);
    void closeSlot(oldest[1]);
  }
  const slot: Slot = {
    fingerprint,
    ready: Promise.resolve().then(build).catch((error: unknown) => {
      console.warn('assistant warm-up failed:', error instanceof Error ? error.message : String(error));
      if (slots.get(key) === slot) slots.delete(key);
      clearTimeout(slot.timer);
      return null;
    }),
    timer: setTimeout(() => {
      if (slots.get(key) === slot) slots.delete(key);
      void closeSlot(slot);
    }, warmTtlMs()),
  };
  slot.timer.unref();
  slots.set(key, slot);
  return true;
}

export interface TakenWarmSlot {
  fingerprint: string;
  /** Resolves when the warm-up is done; null when it failed. */
  ready: Promise<WarmResource | null>;
}

/**
 * Removes the slot and hands it over. SYNCHRONOUS on purpose: called before the first await of a run, so two
 * parallel runs of one conversation cannot both get it. The caller owns closing it.
 */
export function takeWarmSlot(key: string): TakenWarmSlot | null {
  const slot = slots.get(key);
  if (!slot) return null;
  slots.delete(key);
  clearTimeout(slot.timer);
  return { fingerprint: slot.fingerprint, ready: slot.ready };
}

/** Closes a slot that was taken but not used (fingerprint mismatch). */
export async function closeTakenSlot(taken: TakenWarmSlot): Promise<void> {
  const resource = await taken.ready;
  if (resource) await resource.close().catch(() => undefined);
}

/** Server shutdown and tests. */
export async function closeAllWarmSlots(): Promise<void> {
  const all = [...slots.values()];
  slots.clear();
  await Promise.all(all.map(closeSlot));
}
