import type { AssistantKeySource, AssistantProviderId } from '../../../shared/contracts.js';
import type { RunAssistantInput as CursorRunInput } from '../cursorRuntime.js';

/** Which provider, model and credential one run uses (providerRouting.ts). */
export interface AssistantRoute {
  provider: AssistantProviderId;
  /** The model id as the provider knows it, without the `<provider>:` prefix. `auto` is Cursor only. */
  modelId: string;
  /** Decrypted credential. Server-side only: never logged, never in an HTTP response or an error. */
  secret: string;
  source: Exclude<AssistantKeySource, 'none'>;
  keyName: string | null;
}

/**
 * Input of runAssistant: the Cursor runtime's input with `route` in place of
 * `apiKey`. `onRun` and `onEvent` are Cursor SDK objects and only fire there;
 * the other runtimes are stopped through `signal`.
 */
export interface RunAssistantInput extends Omit<CursorRunInput, 'apiKey'> {
  route: AssistantRoute;
}
