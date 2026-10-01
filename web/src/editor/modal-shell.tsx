/**
 * The `folio-modal` chrome shared by the block editors (mermaid, table).
 *
 * Extracted verbatim from the mermaid modal so both dialogs keep exactly the
 * same behaviour: portal into <body>, backdrop click cancels, Esc cancels,
 * Ctrl/Cmd+Enter saves, and Tab cycles inside the panel instead of escaping to
 * the page behind it. The full-screen phone layout (round 14) is CSS on these
 * same class names, so it applies to every dialog built from this shell.
 */
import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2 } from 'lucide-react';

const FOCUSABLE =
  'button:not([disabled]), [href], input, textarea, select, [tabindex]:not([tabindex="-1"])';

export interface ModalShellProps {
  ariaLabel: string;
  title: string;
  closeLabel: string;
  hint: string;
  cancelLabel: string;
  saveLabel: string;
  onCancel: () => void;
  onSave: () => void;
  /** Optional strip between the header and the body (mermaid's templates). */
  toolbar?: ReactNode;
  /** Extra class on the body grid — `--single` for a one-pane dialog. */
  bodyClassName?: string;
  fullscreenLabel?: string;
  restoreLabel?: string;
  children: ReactNode;
}

export function ModalShell({
  ariaLabel,
  title,
  closeLabel,
  hint,
  cancelLabel,
  saveLabel,
  onCancel,
  onSave,
  toolbar,
  bodyClassName,
  fullscreenLabel,
  restoreLabel,
  children,
}: ModalShellProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSave();
      return;
    }
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null,
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    }
  };

  return createPortal(
    <div className="folio-modal" role="dialog" aria-modal="true" aria-label={ariaLabel} onKeyDown={onKeyDown}>
      <div className="folio-modal__backdrop" onMouseDown={onCancel} />
      <div className={`folio-modal__panel${fullscreen ? ' folio-modal__panel--fullscreen' : ''}`} ref={panelRef}>
        <header className="folio-modal__head">
          <h2 className="folio-modal__title">{title}</h2>
          <div className="folio-modal__head-actions">
            {fullscreenLabel && restoreLabel && (
              <button
                type="button"
                className="folio-modal__close"
                onClick={() => setFullscreen((value) => !value)}
                aria-label={fullscreen ? restoreLabel : fullscreenLabel}
                title={fullscreen ? restoreLabel : fullscreenLabel}
              >
                {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
            )}
            <button type="button" className="folio-modal__close" onClick={onCancel} aria-label={closeLabel}>
              ×
            </button>
          </div>
        </header>

        {toolbar}

        <div className={bodyClassName ? `folio-modal__body ${bodyClassName}` : 'folio-modal__body'}>
          {children}
        </div>

        <footer className="folio-modal__foot">
          <span className="folio-modal__hint">{hint}</span>
          <button type="button" className="folio-modal__button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="folio-modal__button folio-modal__button--primary" onClick={onSave}>
            {saveLabel}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
