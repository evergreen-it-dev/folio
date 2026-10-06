/**
 * Public-demo limits for /mcp (see demo.ts for the mode itself). The demo's OAuth connectors
 * keep the same rights as the shared "sam" login in the UI, so instead of narrowing them the
 * demo caps how hard they can be driven. All of it is inert unless FOLIO_DEMO_MODE is on.
 *
 *   FOLIO_DEMO_MCP_RPM              /mcp requests per minute per user+IP        (default 60)
 *   FOLIO_DEMO_MCP_WRITES_PER_HOUR  writing tool calls (readOnlyHint=false)
 *                                   per hour per IP                             (default 100)
 *
 * Fixed caps (not env-tunable): a /mcp request body of at most 1 MiB, the arguments of one
 * writing tool call (page markdown, board scene, table rows) at most 200 KiB, and 30 requests
 * a minute per IP on POST /oauth/authorize and POST /oauth/token (oauth/routes.ts).
 *
 * Storage: in process memory, a sliding window like auth/session.ts's login limiter and
 * forms/rateLimit.ts. The demo is ONE instance, so there is nothing to share, and unlike the
 * login limiter this is an abuse backstop, not a security control, so a restart resetting the
 * counters is acceptable. (The login limiter's Redis variant is not reused: the demo does not
 * need Redis.) The IP is request.ip, which is the real client address only with TRUST_PROXY set.
 */
import { isDemoMode } from './demo.js';

const DEFAULT_MCP_RPM = 60;
const DEFAULT_MCP_WRITES_PER_HOUR = 100;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Largest /mcp request body in demo mode. Fastify's own default is the same 1 MiB; this pins it so the demo does not depend on that default. */
export const DEMO_MCP_MAX_BODY_BYTES = 1024 * 1024;
/** Largest `arguments` of ONE writing tool call in demo mode (what update_page/create_page would write, and a board scene or a batch of table rows). */
export const DEMO_MCP_MAX_WRITE_ARGS_BYTES = 200 * 1024;
/** POST /oauth/authorize and POST /oauth/token, per IP per minute, in demo mode. */
export const DEMO_OAUTH_PER_MINUTE = 30;

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? '').trim());
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

export function demoMcpRpm(): number {
  return positiveInt(process.env.FOLIO_DEMO_MCP_RPM, DEFAULT_MCP_RPM);
}
export function demoMcpWritesPerHour(): number {
  return positiveInt(process.env.FOLIO_DEMO_MCP_WRITES_PER_HOUR, DEFAULT_MCP_WRITES_PER_HOUR);
}

export interface DemoLimitResult {
  limited: boolean;
  retryAfterSeconds: number;
}

const hits = new Map<string, number[]>();
let lastSweep = 0;

function sweep(now: number): void {
  if (now - lastSweep < MINUTE_MS) return;
  lastSweep = now;
  for (const [key, stamps] of hits) if (stamps[stamps.length - 1] <= now - HOUR_MS) hits.delete(key);
}

/**
 * Sliding window: `cost` hits against `max` per `windowMs`. A refused call records nothing, so
 * a client that keeps hammering cannot extend its own lockout.
 */
function consume(bucket: string, key: string, cost: number, max: number, windowMs: number): DemoLimitResult {
  const now = Date.now();
  sweep(now);
  const id = `${bucket}|${key}`;
  const recent = (hits.get(id) ?? []).filter((t) => t > now - windowMs);
  if (recent.length + cost > max) {
    hits.set(id, recent);
    const needFree = recent.length + cost - max; // the window must shed this many hits
    const oldest = recent[Math.min(needFree, recent.length) - 1] ?? now;
    return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)) };
  }
  for (let i = 0; i < cost; i++) recent.push(now);
  hits.set(id, recent);
  return { limited: false, retryAfterSeconds: 0 };
}

/** An authenticated /mcp request: FOLIO_DEMO_MCP_RPM per minute per user+IP. */
export function checkDemoMcpRate(userId: string, ip: string): DemoLimitResult {
  if (!isDemoMode()) return { limited: false, retryAfterSeconds: 0 };
  return consume('mcp-rpm', `${userId}|${ip}`, 1, demoMcpRpm(), MINUTE_MS);
}

/** A /mcp request that failed authentication: the same per-minute cap per IP, so token guessing is throttled too. */
export function checkDemoMcpAnonymousRate(ip: string): DemoLimitResult {
  if (!isDemoMode()) return { limited: false, retryAfterSeconds: 0 };
  return consume('mcp-anon', ip, 1, demoMcpRpm(), MINUTE_MS);
}

/** `writeCalls` writing tool calls in one request: FOLIO_DEMO_MCP_WRITES_PER_HOUR per hour per IP. All or nothing. */
export function checkDemoMcpWrites(ip: string, writeCalls: number): DemoLimitResult {
  if (!isDemoMode() || writeCalls <= 0) return { limited: false, retryAfterSeconds: 0 };
  return consume('mcp-writes', ip, writeCalls, demoMcpWritesPerHour(), HOUR_MS);
}

export function __resetDemoLimitsForTests(): void {
  hits.clear();
  lastSweep = 0;
}

export interface McpBodyInspection {
  /** Tool calls in the request whose tool is a writing one. */
  writeCalls: number;
  /** True when any single writing tool call carries more than DEMO_MCP_MAX_WRITE_ARGS_BYTES of arguments. */
  oversizedWrite: boolean;
  /** JSON-RPC id of the first request, echoed in a refusal (null for a notification, a batch without ids or junk). */
  id: string | number | null;
}

/** Reads a parsed /mcp body (one JSON-RPC message or a batch) without trusting its shape. */
export function inspectMcpBody(body: unknown, writeToolNames: ReadonlySet<string>): McpBodyInspection {
  const messages = Array.isArray(body) ? body : [body];
  const out: McpBodyInspection = { writeCalls: 0, oversizedWrite: false, id: null };
  for (const m of messages) {
    if (typeof m !== 'object' || m === null) continue;
    const msg = m as { id?: unknown; method?: unknown; params?: unknown };
    if (out.id === null && (typeof msg.id === 'string' || typeof msg.id === 'number')) out.id = msg.id;
    if (msg.method !== 'tools/call' || typeof msg.params !== 'object' || msg.params === null) continue;
    const params = msg.params as { name?: unknown; arguments?: unknown };
    if (typeof params.name !== 'string' || !writeToolNames.has(params.name)) continue;
    out.writeCalls++;
    if (Buffer.byteLength(JSON.stringify(params.arguments ?? null)) > DEMO_MCP_MAX_WRITE_ARGS_BYTES) out.oversizedWrite = true;
  }
  return out;
}
