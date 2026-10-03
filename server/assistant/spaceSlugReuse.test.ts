import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setUpTestSchema, deleteTestSpace } from '../db/testSchema.js';
import * as authStore from '../auth/store.js';
import * as storage from '../storage.js';
import * as gitSync from '../gitSync.js';
import { restoreTrashItem } from '../trash/service.js';
import { query, queryOne } from '../db/pool.js';

// Runs and unanswered reports remember their space by slug, and a space admin
// sees analytics only for their slugs. A new space that takes the slug of a
// deleted one must not inherit the old space's conversations.
describe('assistant analytics and a reused space slug', () => {
  let teardownSchema: () => Promise<void>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  async function spaceWithAssistantActivity(label: string) {
    const actor = await authStore.createUser({
      email: `slug-reuse-${label}-${Date.now()}@test.local`,
      name: 'Owner',
      passwordHash: 'x',
      isAdmin: true,
    });
    const space = await storage.createSpace(`Assistant ${label} ${Date.now()}`, actor.id);
    const conversationId = randomUUID();
    await query(`INSERT INTO ai_conversations (id, user_id, title, cursor_agent_id) VALUES ($1, $2, 'q', $3)`, [
      conversationId,
      actor.id,
      `agent-${conversationId}`,
    ]);
    await query(
      `INSERT INTO ai_runs (id, conversation_id, user_id, run_mode, status, space) VALUES ($1, $2, $3, 'ask', 'done', $4)`,
      [randomUUID(), conversationId, actor.id, space.slug],
    );
    await query(
      `INSERT INTO ai_unanswered_questions (id, conversation_id, user_id, space, question, reason) VALUES ($1, $2, $3, $4, 'q', 'no_answer')`,
      [randomUUID(), conversationId, actor.id, space.slug],
    );
    return { actor, space, conversationId };
  }

  async function spacesOf(conversationId: string) {
    const run = await queryOne<{ space: string | null }>(`SELECT space FROM ai_runs WHERE conversation_id = $1`, [conversationId]);
    const report = await queryOne<{ space: string | null }>(
      `SELECT space FROM ai_unanswered_questions WHERE conversation_id = $1`,
      [conversationId],
    );
    return { run: run?.space ?? null, report: report?.space ?? null };
  }

  it('detaches the old runs and reports when a NEW space takes the same slug', async () => {
    const { actor, space, conversationId } = await spaceWithAssistantActivity('recreated');
    await storage.deleteSpace(space.slug, actor.id);
    expect(await spacesOf(conversationId)).toEqual({ run: space.slug, report: space.slug }); // deletion keeps them

    const again = await storage.createSpace(space.name, actor.id);
    try {
      expect(again.slug).toBe(space.slug);
      expect(await spacesOf(conversationId)).toEqual({ run: null, report: null });
    } finally {
      await gitSync.flushAllPendingSyncs();
      await deleteTestSpace(again.slug);
    }
  });

  it('keeps them when the deleted space itself is restored', async () => {
    const { actor, space, conversationId } = await spaceWithAssistantActivity('restored');
    await storage.deleteSpace(space.slug, actor.id);
    const row = await queryOne<{ id: string }>(`SELECT id FROM trash_items WHERE kind = 'space' AND page_id = $1`, [space.slug]);
    const restored = await restoreTrashItem(actor, row!.id);
    try {
      expect(restored.space).toBe(space.slug);
      expect(await spacesOf(conversationId)).toEqual({ run: space.slug, report: space.slug });
    } finally {
      await gitSync.flushAllPendingSyncs();
      await deleteTestSpace(restored.space);
    }
  });
});
