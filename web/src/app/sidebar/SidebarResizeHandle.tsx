import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, clampSidebarWidth, nextWidthForKey } from './sidebarWidth';
import '../i18n/register';

export interface SidebarResizeHandleProps {
  width: number;
  onResize: (width: number) => void;
}

/**
 * Drag handle on the sidebar's right edge (round 8 follow-up). A thin
 * absolutely-positioned strip rather than a layout sibling, so it doesn't
 * itself take up flex space or need the parent to reserve room for it.
 *
 * Width updates fire live during the drag (not just on mouseup) — Sidebar.tsx
 * writes them straight through to useLocalStorage, and the main area's
 * flex-1 reflows every frame the same way it would from any other width
 * change, so there's nothing separate to "commit".
 */
export function SidebarResizeHandle({ width, onResize }: SidebarResizeHandleProps) {
  const { t } = useTranslation('app');
  const startRef = useRef<{ x: number; width: number } | null>(null);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const [dragging, setDragging] = useState(false);

  // Listeners live on window (not the handle) since the mouse routinely
  // leaves the handle's own ~6px hit area the instant a real drag starts.
  // Attached once (empty deps) and reading the latest callback through a
  // ref, rather than re-subscribing on every width change.
  useEffect(() => {
    function onMouseMove(event: MouseEvent) {
      if (!startRef.current) return;
      const delta = event.clientX - startRef.current.x;
      onResizeRef.current(clampSidebarWidth(startRef.current.width + delta));
    }
    function stopDragging() {
      if (!startRef.current) return;
      startRef.current = null;
      setDragging(false);
      document.body.style.cursor = '';
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', stopDragging);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', stopDragging);
      // Safety net if this unmounts mid-drag (e.g. the sidebar gets
      // collapsed via the header toggle while a drag is in progress).
      document.body.style.cursor = '';
    };
  }, []);

  function handleMouseDown(event: ReactMouseEvent) {
    event.preventDefault();
    startRef.current = { x: event.clientX, width };
    setDragging(true);
    // Keeps the resize cursor while the pointer is over ordinary content
    // mid-drag, instead of flickering back to the default cursor between
    // mousemove events — standard drag-to-resize affordance.
    document.body.style.cursor = 'col-resize';
  }

  function handleKeyDown(event: KeyboardEvent) {
    const next = nextWidthForKey(width, event.key);
    if (next === null) return;
    event.preventDefault();
    onResize(next);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('sidebar.resizeHandle.label')}
      aria-valuenow={Math.round(width)}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      tabIndex={0}
      onMouseDown={handleMouseDown}
      onDoubleClick={() => onResize(SIDEBAR_DEFAULT_WIDTH)}
      onKeyDown={handleKeyDown}
      title={t('sidebar.resizeHandle.title')}
      className="absolute inset-y-0 -right-0.5 z-10 w-1.5 cursor-col-resize touch-none select-none focus:outline-none"
    >
      <div
        className={`mx-auto h-full w-px transition-colors ${
          dragging ? 'bg-blue-400' : 'bg-transparent hover:bg-neutral-300 dark:hover:bg-neutral-700'
        }`}
      />
    </div>
  );
}
