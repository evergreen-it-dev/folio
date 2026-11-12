/**
 * Per-step timing of one assistant run — numbers only. Nothing the user or the model wrote (prompt, page
 * text, tool arguments or results) is recorded here, only the names of tools and durations, so the
 * summary can go to the server log and to `ai_runs.timing` as it is.
 */
import type { SdkUpdateLike } from './genProgress.js';

/** Did the run find a warm agent waiting (warmSlots.ts)? `off`: warm-up disabled or not used by this provider. */
export type RunWarm = 'hit' | 'miss' | 'off';

export type RunMilestone = 'tools-ready' | 'agent-ready' | 'sent';

export interface ToolTiming {
  tool: string;
  /** How long the tool's execute() took. */
  ms: number;
  ok: boolean;
}

export interface RunTimingSnapshot {
  /** Cursor runs: whether a warm agent (made when the panel was opened) was used, so that agentReadyMs shows the effect. */
  warm: RunWarm;
  /** Workspace + tool set built (before the SDK agent is touched). */
  toolsReadyMs: number | null;
  /** SDK agent created or resumed and reloaded. */
  agentReadyMs: number | null;
  /** agent.send() returned a run. */
  sentMs: number | null;
  /** First SDK update of any kind / the first reply-text delta, from the start of the run. */
  firstDeltaMs: number | null;
  firstTextMs: number | null;
  /** Model round trips: one per generation phase (the first, and each one after tool results went back); the SDK's `turn-ended` fires once per whole run. */
  turns: number;
  toolCalls: number;
  /** Sum of the tools' execute() times. */
  toolMs: number;
  tools: ToolTiming[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalMs: number;
}

export interface RunTiming {
  milestone: (name: RunMilestone) => number;
  /** Feed every SDK update; returns which "first" it was, so the caller can log it. */
  onUpdate: (update: SdkUpdateLike) => { firstDelta: number | null; firstText: number | null };
  toolFinished: (timing: ToolTiming) => void;
  setWarm: (warm: RunWarm) => void;
  snapshot: () => RunTimingSnapshot;
}

const MAX_TOOLS_RECORDED = 100;

export function createRunTiming(now: () => number = Date.now): RunTiming {
  const t0 = now();
  const since = (): number => now() - t0;
  const marks: Partial<Record<RunMilestone, number>> = {};
  let firstDeltaMs: number | null = null;
  let firstTextMs: number | null = null;
  let rounds = 0;
  // A new model round begins with its first model output after the start or after the last in-flight tool finished.
  let needRound = true;
  let toolsInFlight = 0;
  let turnsEnded = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let toolCalls = 0;
  let toolMs = 0;
  const tools: ToolTiming[] = [];
  let warm: RunWarm = 'off';

  return {
    milestone(name) {
      const ms = since();
      if (marks[name] === undefined) marks[name] = ms;
      return marks[name] as number;
    },
    onUpdate(update) {
      const result = { firstDelta: null as number | null, firstText: null as number | null };
      if (firstDeltaMs === null) firstDeltaMs = result.firstDelta = since();
      if (update.type === 'text-delta' && firstTextMs === null) firstTextMs = result.firstText = since();
      switch (update.type) {
        case 'step-started':
        case 'thinking-delta':
        case 'partial-tool-call':
        case 'text-delta':
        case 'tool-call-started':
          if (needRound && toolsInFlight === 0) {
            rounds += 1;
            needRound = false;
          }
          if (update.type === 'tool-call-started') toolsInFlight += 1;
          break;
        case 'tool-call-completed':
          toolsInFlight = Math.max(0, toolsInFlight - 1);
          if (toolsInFlight === 0) needRound = true;
          break;
        default:
          break;
      }
      if (update.type === 'turn-ended') {
        turnsEnded += 1;
        const usage = update.usage as Record<string, unknown> | undefined;
        const num = (key: string): number => (typeof usage?.[key] === 'number' ? (usage[key] as number) : 0);
        inputTokens += num('inputTokens');
        outputTokens += num('outputTokens');
        cacheReadTokens += num('cacheReadTokens');
      }
      return result;
    },
    setWarm(value) {
      warm = value;
    },
    toolFinished(timing) {
      toolCalls += 1;
      toolMs += timing.ms;
      if (tools.length < MAX_TOOLS_RECORDED) tools.push(timing);
    },
    snapshot() {
      return {
        warm,
        toolsReadyMs: marks['tools-ready'] ?? null,
        agentReadyMs: marks['agent-ready'] ?? null,
        sentMs: marks.sent ?? null,
        firstDeltaMs,
        firstTextMs,
        turns: Math.max(rounds, turnsEnded),
        toolCalls,
        toolMs,
        tools: [...tools],
        inputTokens,
        outputTokens,
        cacheReadTokens,
        totalMs: since(),
      };
    },
  };
}
