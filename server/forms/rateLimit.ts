/**
 * Round FORMS — rate limit for ANONYMOUS (share-token) form submissions.
 * Same in-memory sliding-window SHAPE as server/auth/session.ts's login
 * limiter (checkLoginRateLimitMemory) — deliberately without that module's
 * Redis-backed variant: a login attempt is a security-sensitive, per-process
 * concern already wired through server/db/redis.ts; a form-spam guard is a
 * lighter-weight abuse backstop, and one in-memory window per server
 * instance is judged good enough for v1 (see the round report).
 *
 * Keyed by `${shareToken}:${ip}` — either alone is either too coarse (one
 * public form's token shared in a group chat would throttle every visitor
 * behind the same IP together) or too loose (a script rotating IPs would
 * bypass a token-only limit).
 */
export interface RateLimitResult {
  limited: boolean;
  retryAfterSeconds?: number;
}

const WINDOW_MS = 60_000;
const MAX_SUBMISSIONS = 5;
const attemptsByKey = new Map<string, number[]>();

function pruneExpired(now: number): void {
  const windowStart = now - WINDOW_MS;
  for (const [key, timestamps] of attemptsByKey) {
    if (timestamps.every((t) => t <= windowStart)) attemptsByKey.delete(key);
  }
}

export function checkAnonymousSubmitRateLimit(shareToken: string, ip: string): RateLimitResult {
  const key = `${shareToken}:${ip}`;
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  pruneExpired(now);

  const recent = (attemptsByKey.get(key) ?? []).filter((t) => t > windowStart);
  if (recent.length >= MAX_SUBMISSIONS) {
    attemptsByKey.set(key, recent);
    const retryAfterMs = recent[0] + WINDOW_MS - now;
    return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }
  recent.push(now);
  attemptsByKey.set(key, recent);
  return { limited: false };
}

/** Test-only escape hatch — mirrors session.__resetLoginRateLimitForTests. */
export function __resetFormRateLimitForTests(): void {
  attemptsByKey.clear();
}
