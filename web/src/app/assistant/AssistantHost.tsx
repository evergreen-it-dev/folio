import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { track } from '../../analytics';
import { AssistantRunProvider } from './runState';
import { AssistantPanel } from './AssistantPanel';
import type { AssistantRunMode } from '@shared/contracts';

/**
 * App-level home of the Folio AI panel (05.09.2026, owner: "I move from page
 * to page — do not interrupt the agent and do not close the window").
 *
 * Mounted once inside AuthProvider, ABOVE the route tree: neither switching
 * pages nor switching spaces remounts the panel or its run tracking, so an
 * open chat stays open and a running agent keeps streaming while the user
 * navigates. Sidebar only toggles `open` through useAssistantUi(). The flag
 * is also persisted in sessionStorage so F5 brings the panel back as it was.
 */

const OPEN_STORAGE_KEY = 'folio:assistant-open';

/**
 * A message another part of the app wants the assistant to run ("Check against writing rules" in the page
 * header). The host opens the panel and hands the request to it; the panel sends it as soon as it is ready
 * (key configured, no run in flight) and then calls `onAskHandled`.
 */
export interface AssistantAskRequest {
  /** What the model is sent (an internal instruction prompt). */
  message: string;
  /** What the chat shows as the user's message instead of `message`, when `message` is not meant to be read. */
  displayMessage?: string;
  runMode: AssistantRunMode;
  /** Start a fresh conversation instead of continuing the current one. */
  startNew: boolean;
  /** Set for a writing-rules check: the panel then offers "Fix with Agent" under the findings. */
  writingRulesCheck?: { pageId: string; title: string };
}

export interface PendingAssistantAsk extends AssistantAskRequest {
  /** Increases with every request, so two identical ones in a row are still two. */
  id: number;
}

interface AssistantUi {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Opens the panel and sends `request` in it. */
  ask: (request: AssistantAskRequest) => void;
}

const AssistantUiContext = createContext<AssistantUi | null>(null);

export function useAssistantUi(): AssistantUi {
  const value = useContext(AssistantUiContext);
  if (!value) throw new Error('useAssistantUi must be used inside <AssistantHost>');
  return value;
}

function readStoredOpen(): boolean {
  try {
    return sessionStorage.getItem(OPEN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function AssistantHost({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState<boolean>(readStoredOpen);
  const [pendingAsk, setPendingAsk] = useState<PendingAssistantAsk | null>(null);
  const askCounter = useRef(0);

  // Optional analytics: the panel being opened by the person (not restored on load).
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) track('assistant_panel_open');
    wasOpen.current = open;
  }, [open]);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    try {
      sessionStorage.setItem(OPEN_STORAGE_KEY, next ? '1' : '0');
    } catch {
      // storage unavailable (private mode etc.) — the flag just won't survive reloads
    }
  }, []);

  const toggle = useCallback(() => {
    setOpenState((current) => {
      const next = !current;
      try {
        sessionStorage.setItem(OPEN_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // see setOpen
      }
      return next;
    });
  }, []);

  const ask = useCallback(
    (request: AssistantAskRequest) => {
      askCounter.current += 1;
      setPendingAsk({ ...request, id: askCounter.current });
      setOpen(true);
    },
    [setOpen],
  );
  const onAskHandled = useCallback((id: number) => setPendingAsk((current) => (current?.id === id ? null : current)), []);

  const value = useMemo<AssistantUi>(() => ({ open, setOpen, toggle, ask }), [open, setOpen, toggle, ask]);

  return (
    <AssistantRunProvider>
      <AssistantUiContext.Provider value={value}>
        {children}
        {/* Always mounted, above the routes: navigation never unmounts it. */}
        <AssistantPanel open={open} onClose={() => setOpen(false)} pendingAsk={pendingAsk} onAskHandled={onAskHandled} />
      </AssistantUiContext.Provider>
    </AssistantRunProvider>
  );
}
