import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type Tone = 'error' | 'info';
/**
 * Optional trailing action. With `href` it is a link (trash round: the after-restore toast links to the restored
 * page) — a plain <a>, not a router <Link>, since ToastProvider mounts OUTSIDE BrowserRouter (see App.tsx).
 * With `onClick` it is a button (the file-replace toast's «Undo»); the toast closes when it is pressed.
 */
export type ToastAction = { label: string; href: string; onClick?: never } | { label: string; onClick: () => void; href?: never };
interface ToastItem {
  id: number;
  message: string;
  tone: Tone;
  action?: ToastAction;
}

const ToastContext = createContext<((message: string, tone?: Tone, action?: ToastAction) => void) | null>(null);

/** App-wide corner toasts, mainly for surfacing failed mutations (create/rename/move/delete). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => setItems((prev) => prev.filter((item) => item.id !== id)), []);

  const show = useCallback((message: string, tone: Tone = 'error', action?: ToastAction) => {
    const id = ++nextId.current;
    setItems((prev) => [...prev, { id, message, tone, action }]);
    // a toast carrying a link sticks around longer — it's an offer to act, not just a notice
    setTimeout(() => setItems((prev) => prev.filter((item) => item.id !== id)), action ? 9000 : 4500);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {items.map((item) => (
          <div
            key={item.id}
            role="status"
            className={`pointer-events-auto rounded-lg border px-3 py-2 text-sm shadow-lg ${
              item.tone === 'error'
                ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200'
                : 'border-neutral-200 bg-white text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100'
            }`}
          >
            {item.message}
            {item.action?.href !== undefined && (
              <a href={item.action.href} className="mt-1 block truncate font-medium text-blue-600 underline underline-offset-2 dark:text-blue-400">
                {item.action.label}
              </a>
            )}
            {item.action?.onClick && (
              <button
                type="button"
                onClick={() => {
                  item.action?.onClick?.();
                  dismiss(item.id);
                }}
                className="mt-1 block truncate font-medium text-blue-600 underline underline-offset-2 dark:text-blue-400"
              >
                {item.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Returns `show(message, tone?, action?)`. Must be called under <ToastProvider> (mounted once in App). */
export function useToast() {
  const show = useContext(ToastContext);
  if (!show) throw new Error('useToast must be used within <ToastProvider>');
  return show;
}
