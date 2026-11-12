import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetWarmDedupe, warmAssistantOnce, WARM_DEDUPE_MS } from './useAssistantWarm';

const body = (conversationId: string | null) => ({ conversationId, runMode: 'ask' as const, space: null, pageId: null, currentPath: '/' });

describe('warmAssistantOnce', () => {
  beforeEach(() => resetWarmDedupe());

  it('sends once per conversation within the window, again after it, and swallows errors', async () => {
    const send = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(warmAssistantOnce(body('c1'), send, 1000)).toBe(true);
    expect(warmAssistantOnce(body('c1'), send, 1000 + WARM_DEDUPE_MS - 1)).toBe(false);
    expect(warmAssistantOnce(body('c2'), send, 1000)).toBe(true);
    expect(warmAssistantOnce(body('c1'), send, 1000 + WARM_DEDUPE_MS)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(send).toHaveBeenCalledTimes(3);
  });
});
