/**
 * Whether the page's right panel (OutlinePanel) is put away, shared between the panel and the editor's toolbar row,
 * where the show/hide button lives. The choice is persisted under the same key the panel always used
 * (`folio:outline-panel-hidden`, JSON boolean), so an existing preference survives.
 *
 * Two more bits of shared state keep the button honest: whether a panel is mounted at all (a page with nothing to
 * list has none, so the toolbar offers no button), and whether an editor toolbar is mounted (without one the panel
 * falls back to its own hide button).
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import '../i18n/register';

export const PANEL_HIDDEN_KEY = 'folio:outline-panel-hidden';

const listeners = new Set<() => void>();
let panelCount = 0;
let toolbarCount = 0;
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

function readHidden(): boolean {
  try {
    return localStorage.getItem(PANEL_HIDDEN_KEY) === 'true';
  } catch {
    return false;
  }
}
let hidden = readHidden();

export function setPanelHidden(next: boolean): void {
  hidden = next;
  try {
    localStorage.setItem(PANEL_HIDDEN_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — in-memory only */
  }
  emit();
}

export function usePanelHidden(): boolean {
  return useSyncExternalStore(subscribe, () => hidden, () => false);
}

/** The panel calls this while it renders something. */
export function useRegisterPanel(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    panelCount += 1;
    emit();
    return () => {
      panelCount -= 1;
      emit();
    };
  }, [active]);
}

export function usePanelMounted(): boolean {
  return useSyncExternalStore(subscribe, () => panelCount > 0, () => false);
}

/** True while an editor toolbar with the show/hide button is on the page. */
export function useToolbarButtonMounted(): boolean {
  return useSyncExternalStore(subscribe, () => toolbarCount > 0, () => false);
}

/** The icon button for the editor's toolbar row (after the mode switch); renders only where a panel exists. */
export function PanelVisibilityToggle() {
  const { t } = useTranslation('app');
  const isHidden = usePanelHidden();
  const mounted = usePanelMounted();
  useEffect(() => {
    toolbarCount += 1;
    emit();
    return () => {
      toolbarCount -= 1;
      emit();
    };
  }, []);
  if (!mounted) return null;
  const label = isHidden ? t('outline.showPanel') : t('outline.hidePanel');
  const Icon = isHidden ? PanelRightOpen : PanelRightClose;
  return (
    <button
      type="button"
      className="folio-editor__panel-toggle max-[1099px]:hidden"
      aria-label={label}
      title={label}
      data-panel-visibility=""
      onClick={() => setPanelHidden(!isHidden)}
    >
      <Icon size={15} aria-hidden="true" />
    </button>
  );
}
