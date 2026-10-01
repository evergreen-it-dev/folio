import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { AssistantRunProvider } from './runState';
import { AssistantPanel } from './AssistantPanel';

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

interface AssistantUi {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
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

  const value = useMemo<AssistantUi>(() => ({ open, setOpen, toggle }), [open, setOpen, toggle]);

  return (
    <AssistantRunProvider>
      <AssistantUiContext.Provider value={value}>
        {children}
        {/* Always mounted, above the routes: navigation never unmounts it. */}
        <AssistantPanel open={open} onClose={() => setOpen(false)} />
      </AssistantUiContext.Provider>
    </AssistantRunProvider>
  );
}
