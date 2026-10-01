import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '../i18n/register';

export interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Optional footer, typically Cancel/Confirm buttons. */
  footer?: ReactNode;
  /** 'md' (default) fits simple forms; 'lg' is for content with real width needs (e.g. the history panel's list+preview). */
  size?: 'md' | 'lg' | 'xl';
}

const SIZE_CLASS: Record<'md' | 'lg' | 'xl', string> = { md: 'max-w-md', lg: 'max-w-3xl', xl: 'max-w-6xl' };

/** Small centered dialog: backdrop click and Escape both close it. No routing/URL state — purely local UI. */
export function Modal({ title, onClose, children, footer, size = 'md' }: ModalProps) {
  const { t } = useTranslation('app');
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Round 14 QA fix ("history window broken", root-caused live on prod): a
  // caller can sit anywhere in the tree — HistoryButton/ShareButton render
  // their panel from *inside* <header>, which has `backdrop-blur` (i.e. a
  // `backdrop-filter` other than `none`). Per the CSS spec that makes the
  // header a containing block for ITS OWN `position: fixed` descendants —
  // exactly like `transform` does (see Sidebar.tsx's docblock on its <md
  // drawer for the same rule from the other direction) — so this dialog's
  // `fixed inset-0` backdrop, rendered inline, was resolving `inset: 0`
  // against the ~55px-tall header box instead of the viewport, not the
  // max-h-less overflow this comment used to blame alone. Portaling to
  // document.body sidesteps every such ancestor unconditionally, the same
  // reason ui/Menu.tsx's dropdown panel already portals. max-h/overflow
  // below stays as a second, independent layer: correct positioning still
  // doesn't cap height on a short viewport by itself.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // max-h + flex-col + the content area (below) owning its own
        // overflow-y-auto is what keeps title/close-X reachable on a short
        // viewport instead of the dialog silently growing past it. 2rem
        // matches this backdrop's own p-4 (1rem top + 1rem bottom).
        className={`flex max-h-[calc(100dvh-2rem)] w-full ${SIZE_CLASS[size]} flex-col rounded-xl border border-neutral-200 bg-white p-4 shadow-xl dark:border-neutral-700 dark:bg-neutral-900 md:p-5`}
      >
        <div className="mb-4 flex shrink-0 items-center justify-between">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('ui.close')}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto text-sm">{children}</div>
        {footer && <div className="mt-5 flex shrink-0 justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
