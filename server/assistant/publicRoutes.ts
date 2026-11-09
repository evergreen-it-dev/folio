/**
 * "Ask Folio AI" on a public site (13.10.2026) — anonymous visitors of a
 * published space ask questions about THAT space. Routes under
 * /api/public/spaces/:slug/assistant/**, registered in server/index.ts OUTSIDE
 * the session scope, next to registerPublicSiteRoutes. Nothing here reads
 * `request.authUser`: the visitor has no identity.
 *
 * Who the run is: the built-in "Public visitor" SYSTEM user
 * (db/migrations/039_public_assistant.sql, authStore.PUBLIC_VISITOR_USER_ID).
 * It owns every public conversation and run, so the existing tables, analytics
 * and RunManager work unchanged. What it may read is confined twice:
 *  - session.ts: a system user is an implicit viewer of PUBLIC spaces only, and
 *    only of their public page set (no restricted page, no `.agent/**`, no
 *    `_templates/`) — never a membership, never an `instance` space, never admin;
 *  - the run itself carries `publicSpace: <slug>` down to the MCP actor
 *    (mcp.ts McpActor.publicSpace): every tool answers for that ONE space only,
 *    and the run is Ask-only (tools.ts refuses anything else).
 *
 * Every handler: refused in the public demo (assertNotDemo), then 404 `space
 * not found` unless the space is public AND its admin switched the assistant on
 * (`public_allow_assistant`). Private, instance, unknown and "assistant off"
 * spaces look the same.
 *
 * Who may continue a conversation: whoever holds its guest token — a random
 * 48-hex secret created with the conversation and returned once; only its
 * sha256 is stored (ai_conversations.guest_token_hash) and it is compared in
 * constant time. A wrong token, a conversation of another space and an unknown
 * id are all the same 404, for runs, events, stop and the message history.
 *
 * Cost control: the key is the space's shared key, else the instance key, else
 * CURSOR_API_KEY (never a personal key — the system user has none), and starting
 * a run is limited per IP and per space per hour (PUBLIC_ASSISTANT_RUNS_PER_HOUR,
 * PUBLIC_ASSISTANT_SPACE_RUNS_PER_HOUR) BEFORE anything else is done.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  publicAssistantRunBodySchema,
  publicAssistantStopBodySchema,
  type PublicAssistantConversation,
  type PublicAssistantRunStarted,
  type User,
} from '../../shared/contracts.js';
import * as authStore from '../auth/store.js';
import { assertNotDemo } from '../demo.js';
import { conflict, HttpError, notFound } from '../errors.js';
import { getPublicSpace, isPublicPage, type PublicSpace } from '../publicSites.js';
import { rateLimited, retryAfterSeconds } from '../rateLimit.js';
import * as storage from '../storage.js';
import { parseBody, queryString } from '../validate.js';
import { cursorRuntimeAvailable } from './cursorRuntime.js';
import { resolvePublicAssistantRoute } from './providerRouting.js';
import { streamRunEvents } from './routes.js';
import * as runs from './runs.js';
import * as assistantStore from './store.js';
import type { AssistantConversationRow } from './store.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR_MS = 3_600_000;
const IP_BUCKET = 'public-assistant-ip';
const SPACE_BUCKET = 'public-assistant-space';

export const PUBLIC_ASSISTANT_NO_KEY_MESSAGE = 'Folio AI is not configured for this site';

function positiveIntEnv(name: string, fallback: number): number {
  const n = Math.floor(Number((process.env[name] ?? '').trim()));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** PUBLIC_ASSISTANT_RUNS_PER_HOUR: runs one IP may start per hour across all public sites (default 20). */
export function publicRunsPerIpPerHour(): number {
  return positiveIntEnv('PUBLIC_ASSISTANT_RUNS_PER_HOUR', 20);
}

/** PUBLIC_ASSISTANT_SPACE_RUNS_PER_HOUR: runs all visitors together may start per hour on one public site (default 200). */
export function publicRunsPerSpacePerHour(): number {
  return positiveIntEnv('PUBLIC_ASSISTANT_SPACE_RUNS_PER_HOUR', 200);
}

/** The published space named by `:slug` with the assistant switched on, or 404 `space not found` (same answer for every other case). */
async function requireAssistantSite(request: FastifyRequest): Promise<PublicSpace> {
  const { slug } = request.params as { slug: string };
  const site = await getPublicSpace(slug);
  if (!site || !site.allowAssistant) throw notFound('space');
  return site;
}

/** The public visitor system user; 503 if the migration's row is missing (e.g. an email clash prevented its insert). */
async function requirePublicVisitor(): Promise<User> {
  const user = await authStore.findUserById(authStore.PUBLIC_VISITOR_USER_ID);
  if (!user || !user.isSystem || user.disabled) throw new HttpError(503, 'the public assistant is not available on this instance');
  return user;
}

function hashGuestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time: sha256 of the presented token against the stored sha256 (both 32 bytes, so no length leak either). */
function guestTokenMatches(presented: string | undefined, storedHash: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(hashGuestToken(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The public conversation `id` of `space` when `guestToken` is its token; null for anything else (wrong token, other space, unknown or malformed id). */
async function findGuestConversation(id: string, space: string, guestToken: string | undefined): Promise<AssistantConversationRow | null> {
  if (!UUID_RE.test(id)) return null;
  const found = await assistantStore.findPublicConversation(id, authStore.PUBLIC_VISITOR_USER_ID, space);
  if (!found || !guestTokenMatches(guestToken, found.guestTokenHash)) return null;
  return found.conversation;
}

/** May the holder of `guestToken` on site `space` see this run? Only a run of the public visitor in a conversation of this space with this token. */
async function guestOwnsRun(run: { userId: string; conversationId: string }, space: string, guestToken: string | undefined): Promise<boolean> {
  if (run.userId !== authStore.PUBLIC_VISITOR_USER_ID) return false;
  return (await findGuestConversation(run.conversationId, space, guestToken)) !== null;
}

/**
 * Per-IP first, then per-space: an IP that is already over its own limit must
 * not also eat into the whole site's budget. True (after sending the 429 with
 * Retry-After) when the request must stop here.
 */
function runStartThrottled(request: FastifyRequest, reply: FastifyReply, space: string): boolean {
  let bucket: string;
  let key: string;
  if (rateLimited(IP_BUCKET, request.ip, publicRunsPerIpPerHour(), HOUR_MS)) {
    [bucket, key] = [IP_BUCKET, request.ip];
  } else if (rateLimited(SPACE_BUCKET, space, publicRunsPerSpacePerHour(), HOUR_MS)) {
    [bucket, key] = [SPACE_BUCKET, space];
  } else {
    return false;
  }
  void reply
    .status(429)
    .header('Retry-After', String(retryAfterSeconds(bucket, key, HOUR_MS)))
    .send({ error: 'too many questions, try again later' });
  return true;
}

/** A `pageId` from the visitor counts only when it is a public page of this site; anything else is dropped (null), never an error. */
async function publicPageIdOrNull(pageId: string | undefined, space: string): Promise<string | null> {
  const id = pageId?.trim();
  if (!id || id.startsWith('dir:')) return null;
  const entry = await storage.getEntry(id).catch(() => undefined);
  if (!entry || entry.space !== space || !(await isPublicPage(entry))) return null;
  return entry.id;
}

export function registerPublicAssistantRoutes(app: FastifyInstance): void {
  app.post('/api/public/spaces/:slug/assistant/runs', async (request, reply): Promise<PublicAssistantRunStarted | FastifyReply> => {
    assertNotDemo('The AI assistant');
    const site = await requireAssistantSite(request);
    // Limits before any real work (key decryption, conversation rows, the provider).
    if (runStartThrottled(request, reply, site.slug)) return reply;
    const body = parseBody(publicAssistantRunBodySchema, request.body);

    const visitor = await requirePublicVisitor();
    // A continued conversation keeps its model; a new one takes the configured default.
    const existing = body.conversationId ? await findGuestConversation(body.conversationId, site.slug, body.guestToken) : null;
    if (body.conversationId && !existing) throw notFound('assistant conversation');
    // Never a personal credential: Cursor from space -> instance -> CURSOR_API_KEY, else the same order for Anthropic, then MiniMax.
    const route = await resolvePublicAssistantRoute(visitor, site.slug, existing?.model ?? (await assistantStore.getModel(visitor.id)));
    if (!route) throw conflict(PUBLIC_ASSISTANT_NO_KEY_MESSAGE);
    if (route.provider === 'cursor' && !cursorRuntimeAvailable()) throw new HttpError(503, 'Cursor SDK requires Node.js 22.13 or newer');

    let conversation: AssistantConversationRow;
    let guestToken: string;
    if (existing) {
      conversation = existing;
      guestToken = body.guestToken!;
    } else {
      guestToken = randomBytes(24).toString('hex');
      conversation = await assistantStore.insertPublicConversation({
        userId: visitor.id,
        space: site.slug,
        guestTokenHash: hashGuestToken(guestToken),
        title: body.message.slice(0, 80),
        cursorAgentId: `agent-${randomUUID()}`,
        model: await assistantStore.getModel(visitor.id),
      });
    }

    const { runId, conversationId } = await runs.startRun({
      user: visitor,
      conversation,
      message: body.message,
      runMode: 'ask',
      currentPath: null,
      space: site.slug,
      pageId: await publicPageIdOrNull(body.pageId, site.slug),
      route,
      publicSpace: site.slug,
    });
    reply.status(202);
    return { runId, conversationId, guestToken };
  });

  app.get('/api/public/spaces/:slug/assistant/runs/:runId/events', async (request, reply) => {
    assertNotDemo('The AI assistant');
    const site = await requireAssistantSite(request);
    const { runId } = request.params as { runId: string };
    if (!UUID_RE.test(runId)) throw notFound('assistant run');
    const guestToken = queryString(request.query, 'guestToken') || undefined;
    const since = Number(queryString(request.query, 'since')) || 0;
    await streamRunEvents(request, reply, runId, since, (run) => guestOwnsRun(run, site.slug, guestToken));
  });

  app.post('/api/public/spaces/:slug/assistant/runs/:runId/stop', async (request, reply) => {
    assertNotDemo('The AI assistant');
    const site = await requireAssistantSite(request);
    const { runId } = request.params as { runId: string };
    const body = parseBody(publicAssistantStopBodySchema, request.body ?? {});
    const run = UUID_RE.test(runId) ? runs.peek(runId) : null;
    if (!run || !(await guestOwnsRun(run, site.slug, body.guestToken))) throw notFound('active assistant run');
    if (!(await runs.stop(runId, authStore.PUBLIC_VISITOR_USER_ID))) throw notFound('active assistant run');
    reply.status(202);
    return { stopped: true };
  });

  app.get('/api/public/spaces/:slug/assistant/conversations/:id', async (request): Promise<PublicAssistantConversation> => {
    assertNotDemo('The AI assistant');
    const site = await requireAssistantSite(request);
    const { id } = request.params as { id: string };
    const conversation = await findGuestConversation(id, site.slug, queryString(request.query, 'guestToken') || undefined);
    if (!conversation) throw notFound('assistant conversation');
    const messages = await assistantStore.listMessages(conversation.id);
    return {
      messages: messages.map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.createdAt.toISOString() })),
      activeRunId: runs.getActiveRunForConversation(conversation.id)?.runId ?? null,
    };
  });
}
