/**
 * Opens a text container (a freshly inserted sticky note, or an empty shape
 * that was double-clicked off-centre, see boardDblclickText.ts) for text entry.
 *
 * The imperative API has no "start editing this container's text" method, so
 * the package's own keyboard path is used: with exactly ONE selected element
 * that is a valid text container, `Enter` calls `startTextEditing` for it
 * (installed 0.18.1, App.onKeyDown). This replaces a synthetic `dblclick` at
 * the note's screen centre, which was broken in a way that even corrupted
 * data: `startTextEditing` resolves the text to edit from the CURRENT
 * SELECTION first (`selectedElements[0]`'s bound text) and only then from the
 * hit container. After "insert sticky -> Escape" the first note is still the
 * selected element, so inserting a second note at the same spot opened the
 * FIRST note's text for editing and the new note got no text field at all.
 *
 * So the caller must make the new note the only selected element (see
 * `soleSelection`), and this function waits until Excalidraw has committed
 * that state before sending `Enter`; no hit-testing, coordinates or stacking
 * order are involved.
 */

/** The slice of Excalidraw's imperative API this module needs. */
export interface StickyEditApi {
  getAppState(): { selectedElementIds: Readonly<Record<string, boolean>> };
}

/** appState patch that makes `elementId` the only selected element and drops any group scope. */
export function soleSelection(elementId: string) {
  return { selectedElementIds: { [elementId]: true as const }, selectedGroupIds: {}, editingGroupId: null };
}

const POLL_INTERVAL_MS = 16;
const MAX_POLLS = 40;

/** True when the committed selection is exactly `elementId`. */
export function isSoleSelection(api: StickyEditApi, elementId: string): boolean {
  const selected = api.getAppState().selectedElementIds ?? {};
  const ids = Object.keys(selected).filter((id) => selected[id]);
  return ids.length === 1 && ids[0] === elementId;
}

/**
 * Closes a text editor that is still open (its textarea submits on blur),
 * waits for `elementId` to be the committed sole selection, then presses
 * Enter on the interactive canvas. Polling uses setTimeout, not
 * requestAnimationFrame: rAF never fires in a backgrounded tab. Returns a
 * cancel function; it also gives up silently if the host was unmounted or the
 * selection never settled (the note is still inserted and selected, the user
 * can press Enter or double-click).
 */
export function openStickyTextEditor(api: StickyEditApi, host: HTMLElement, elementId: string): () => void {
  host.querySelector<HTMLTextAreaElement>('textarea.excalidraw-wysiwyg')?.blur();
  let polls = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    timer = undefined;
    if (!host.isConnected) return;
    if (!isSoleSelection(api, elementId)) {
      if (++polls < MAX_POLLS) timer = setTimeout(tick, POLL_INTERVAL_MS);
      return;
    }
    const target = host.querySelector<HTMLElement>('canvas.excalidraw__canvas.interactive') ?? host;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  };
  timer = setTimeout(tick, 0);
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
}
