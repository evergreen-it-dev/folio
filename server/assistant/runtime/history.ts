/**
 * What the model remembers of earlier turns: the plain text of `ai_messages`.
 * Tool calls of previous turns are not replayed.
 */
import type { ChatHistoryMessage } from './agentLoop.js';

export const REPLAY_MAX_MESSAGES = 40;
export const REPLAY_MAX_CHARS = 200_000;

/**
 * `rows` are the newest messages of the conversation, oldest first, including
 * the message that started this run (it is sent separately). Keeps the newest
 * messages that fit the limits; the first entry is always a user message.
 */
export function buildReplayHistory(rows: ChatHistoryMessage[]): ChatHistoryMessage[] {
  const earlier = rows.at(-1)?.role === 'user' ? rows.slice(0, -1) : rows;
  const kept: ChatHistoryMessage[] = [];
  let chars = 0;
  for (let index = earlier.length - 1; index >= 0 && kept.length < REPLAY_MAX_MESSAGES; index -= 1) {
    const row = earlier[index]!;
    if (!row.content.trim()) continue;
    if (chars + row.content.length > REPLAY_MAX_CHARS) break;
    chars += row.content.length;
    kept.unshift({ role: row.role, content: row.content });
  }
  const firstUser = kept.findIndex((row) => row.role === 'user');
  return firstUser < 0 ? [] : kept.slice(firstUser);
}
