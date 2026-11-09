/**
 * Everything a loop-driven provider run needs before the first model request:
 * the same workspace, tools and prompt as a Cursor run, plus the plain-text
 * history of the conversation (Cursor keeps that in its own agent state).
 */
import type { SDKMessage } from '@cursor/sdk';
import { buildAssistantTools } from '../tools.js';
import { prepareAssistantWorkspace } from '../workspace.js';
import * as assistantStore from '../store.js';
import { runAgentLoop, chatToolDefinitions, type ChatModel, type ChatModelSeed } from './agentLoop.js';
import { withCap } from './common.js';
import { buildReplayHistory, REPLAY_MAX_MESSAGES } from './history.js';
import { buildAssistantPromptParts } from './prompt.js';
import type { RunAssistantInput } from './types.js';

export async function runWithChatModel(input: RunAssistantInput, createModel: (seed: ChatModelSeed) => ChatModel): Promise<string> {
  const workspace = await prepareAssistantWorkspace({
    user: input.user,
    conversationId: input.conversation.id,
    runMode: input.runMode,
    currentPath: input.currentPath,
    space: input.space,
    pageId: input.pageId,
    publicSpace: input.publicSpace ?? null,
  });
  const toolsHandle = await buildAssistantTools(input.user, input.runMode, {
    runId: input.runId,
    conversationId: input.conversation.id,
    space: input.space,
    pageId: input.pageId,
    publicSpace: input.publicSpace ?? null,
    onToolFinished: input.onToolFinished,
  });
  input.onMilestone?.('tools-ready');
  try {
    const parts = buildAssistantPromptParts(workspace, input.runMode, input.message);
    // One more than the replay limit: the newest row is the message that started this run.
    const rows = await assistantStore.listRecentMessages(input.conversation.id, REPLAY_MAX_MESSAGES + 1);
    const model = createModel({
      system: { stable: parts.stable, volatile: parts.volatile },
      history: buildReplayHistory(rows),
      userMessage: input.message,
      tools: chatToolDefinitions(toolsHandle.tools),
    });
    input.onMilestone?.('agent-ready');
    return await runAgentLoop({
      model,
      tools: toolsHandle.tools,
      runMode: input.runMode,
      signal: input.signal,
      totalTimeoutMs: input.totalTimeoutMs,
      idleTimeoutMs: input.idleTimeoutMs,
      onTextDelta: input.onTextDelta,
      onTool: input.onTool,
      onUpdate: input.onUpdate,
      onMilestone: input.onMilestone,
      // runs.ts shows "thinking" for this message; only its type is read.
      onWaitingForModel: () => input.onEvent?.({ type: 'thinking' } as SDKMessage),
    });
  } finally {
    await withCap(toolsHandle.close(), 5_000);
  }
}
