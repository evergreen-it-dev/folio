/**
 * Other people's selections and carets, drawn over the editor (08.10.2026).
 *
 * Replaces y-codemirror.next's `yRemoteSelections` inside `yCollab` (same
 * awareness field `cursor`, same relative positions — other clients, old or
 * new, see and are seen exactly as before). Why not the upstream plugin:
 *
 *  - It drew the lines in the middle of a multi-line selection with a LINE
 *    decoration (`.cm-yLineSelection` on the `.cm-line` itself) and the rest
 *    with marks that wrap the selected text. Our presence fade
 *    (remote-presence.ts) hid those classes with `opacity: 0` after 8 s of
 *    quiet — which hid the selected TEXT for everybody watching: a blank gap
 *    the height of the selection, with only a bullet or the caret left in it.
 *    Here the colour is a CSS variable on a mark; the fade switches only the
 *    background, never anything that holds document text.
 *  - The line decoration also overrode the line's own padding/margin (list
 *    indentation) through the upstream base theme.
 *  - Positions came straight from the Y.Text: when the Y.Text is ahead of the
 *    editor (a remote change not shown yet, see collab-sync.ts) or holds "\r",
 *    `doc.lineAt()` threw and CodeMirror switched the plugin off for good.
 *
 * Guarantees: building the decorations never throws (positions are mapped,
 * clamped and sorted; a failure leaves the previous set in place), a caret that
 * would land inside an atomic range (a replaced list marker, a widget) is moved
 * to its nearest edge so it stays visible, and the awareness listener never
 * dispatches into an update in progress.
 *
 * This is presentation only: nothing here writes to the document.
 */
import { Annotation, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { ySyncFacet, type YSyncConfig } from 'y-codemirror.next';
import * as Y from 'yjs';

/** Marks the "awareness changed, redraw" transaction. */
const remoteSelectionsRefresh = Annotation.define<true>();

/** One peer's selection in EDITOR positions (already mapped and clamped). */
export interface RemoteSelection {
  clientId: number;
  anchor: number;
  head: number;
  color: string;
  colorLight: string;
  name: string;
}

const DEFAULT_COLOR = '#30bced';
// The colour ends up in a style attribute and comes from another client:
// accept plain colour notations only.
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\([0-9.,%\s]+\))$/i;

function safeColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && SAFE_COLOR.test(value.trim()) ? value.trim() : fallback;
}

class RemoteCaretWidget extends WidgetType {
  constructor(
    readonly color: string,
    readonly name: string,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    // Same DOM and classes as y-codemirror's caret, so its base theme and our
    // editor.css keep styling it.
    const caret = document.createElement('span');
    caret.className = 'cm-ySelectionCaret';
    caret.style.backgroundColor = this.color;
    caret.style.borderColor = this.color;
    const dot = document.createElement('div');
    dot.className = 'cm-ySelectionCaretDot';
    const info = document.createElement('div');
    info.className = 'cm-ySelectionInfo';
    info.textContent = this.name;
    caret.append('⁠', dot, '⁠', info, '⁠');
    return caret;
  }

  eq(other: RemoteCaretWidget): boolean {
    return other.color === this.color && other.name === this.name;
  }

  get estimatedHeight(): number {
    return -1;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** `pos` moved out of any atomic range that strictly contains it, to the nearer edge. */
function outsideAtomic(view: EditorView | null, pos: number): number {
  if (!view) return pos;
  let result = pos;
  for (const source of view.state.facet(EditorView.atomicRanges)) {
    try {
      source(view).between(result, result, (from, to) => {
        if (from < result && result < to) {
          result = result - from <= to - result ? from : to;
          return false;
        }
        return undefined;
      });
    } catch {
      /* a provider that cannot answer right now: keep the position */
    }
  }
  return result;
}

/**
 * The decorations for `selections` over `state`. Pure apart from reading the
 * view's atomic ranges; never throws for any input positions.
 */
export function remoteSelectionDecorations(state: EditorState, selections: readonly RemoteSelection[], view: EditorView | null = null): DecorationSet {
  const length = state.doc.length;
  const clamp = (pos: number) => (Number.isFinite(pos) ? Math.max(0, Math.min(Math.trunc(pos), length)) : 0);
  const ranges: Range<Decoration>[] = [];
  for (const sel of selections) {
    const anchor = clamp(sel.anchor);
    const head = clamp(sel.head);
    const from = Math.min(anchor, head);
    const to = Math.max(anchor, head);
    if (from < to) {
      // ONE mark over the whole range: CodeMirror splits it at line breaks and
      // around replaced content by itself. No line decorations — they restyle
      // the line, and anything hidden on the line hides its text.
      ranges.push(
        Decoration.mark({
          class: 'cm-ySelection',
          attributes: { style: `--folio-ysel-bg: ${sel.colorLight}` },
        }).range(from, to),
      );
    }
    const caretAt = clamp(outsideAtomic(view, head));
    ranges.push(
      Decoration.widget({
        // Outside the selection, as upstream: after it when the head is first.
        side: head - anchor > 0 ? -1 : 1,
        widget: new RemoteCaretWidget(sel.color, sel.name),
      }).range(caretAt),
    );
  }
  return Decoration.set(ranges, true);
}

/**
 * Y.Text index -> editor position. Equal unless the Y.Text holds "\r" (the
 * editor never does): then every "\r\n" before the index is one character
 * fewer in the editor. Only computed when the lengths disagree.
 */
function yIndexMapper(ytext: Y.Text, state: EditorState): (index: number) => number {
  if (ytext.length === state.doc.length) return (index) => index;
  const raw = ytext.toString();
  if (!raw.includes('\r')) return (index) => index;
  return (index) => {
    let removed = 0;
    const end = Math.min(index, raw.length);
    for (let i = 0; i < end; i++) if (raw.charCodeAt(i) === 13 && raw.charCodeAt(i + 1) === 10) removed++;
    return index - removed;
  };
}

interface AwarenessLike {
  doc: Y.Doc;
  getLocalState(): Record<string, unknown> | null;
  setLocalStateField(field: string, value: unknown): void;
  getStates(): Map<number, Record<string, unknown>>;
  on(event: 'change', cb: (change: { added: number[]; updated: number[]; removed: number[] }) => void): void;
  off(event: 'change', cb: (change: { added: number[]; updated: number[]; removed: number[] }) => void): void;
}

interface CursorJson {
  anchor?: unknown;
  head?: unknown;
}

function warn(what: string, error: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(`[editor] remote selections: ${what} failed, kept going:`, error);
}

class RemoteSelectionsPluginValue {
  decorations: DecorationSet = Decoration.none;
  private readonly conf: YSyncConfig;
  private readonly awareness: AwarenessLike;
  private readonly listener: (change: { added: number[]; updated: number[]; removed: number[] }) => void;
  private destroyed = false;
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly view: EditorView) {
    this.conf = view.state.facet(ySyncFacet);
    this.awareness = this.conf.awareness as unknown as AwarenessLike;
    this.listener = ({ added, updated, removed }) => {
      const local = this.awareness.doc.clientID;
      if ([...added, ...updated, ...removed].some((id) => id !== local)) this.requestRedraw();
    };
    this.awareness.on('change', this.listener);
    this.decorations = this.build(view.state);
  }

  /** A redraw transaction — deferred when the view is in the middle of an update. */
  private requestRedraw(): void {
    if (this.destroyed) return;
    try {
      this.view.dispatch({ annotations: [remoteSelectionsRefresh.of(true)] });
    } catch {
      if (this.retry) return;
      this.retry = setTimeout(() => {
        this.retry = undefined;
        this.requestRedraw();
      }, 0);
    }
  }

  update(update: ViewUpdate): void {
    try {
      this.publishLocalSelection(update);
    } catch (error) {
      warn('publishing the local selection', error);
    }
    this.decorations = this.build(update.state, update);
  }

  /** Our own selection into awareness — the same rules as upstream. */
  private publishLocalSelection(update: ViewUpdate): void {
    const local = this.awareness.getLocalState();
    if (local == null) return;
    const ytext = this.conf.ytext;
    const hasFocus = update.view.hasFocus && update.view.dom.ownerDocument.hasFocus();
    const current = local.cursor as CursorJson | null | undefined;
    if (hasFocus) {
      const sel = update.state.selection.main;
      // Editor -> Y.Text index is the identity unless the Y.Text holds "\r";
      // clamping keeps a lagging Y.Text from throwing.
      const anchor = Y.createRelativePositionFromTypeIndex(ytext, Math.min(sel.anchor, ytext.length));
      const head = Y.createRelativePositionFromTypeIndex(ytext, Math.min(sel.head, ytext.length));
      const same =
        current?.anchor != null &&
        current.head != null &&
        Y.compareRelativePositions(Y.createRelativePositionFromJSON(current.anchor), anchor) &&
        Y.compareRelativePositions(Y.createRelativePositionFromJSON(current.head), head);
      if (!same) this.awareness.setLocalStateField('cursor', { anchor, head });
    }
  }

  private build(state: EditorState, update?: ViewUpdate): DecorationSet {
    try {
      const ytext = this.conf.ytext;
      const ydoc = ytext.doc;
      if (!ydoc) return Decoration.none;
      const toEditor = yIndexMapper(ytext, state);
      const selections: RemoteSelection[] = [];
      this.awareness.getStates().forEach((peer, clientId) => {
        if (clientId === this.awareness.doc.clientID) return;
        const cursor = peer?.cursor as CursorJson | null | undefined;
        if (cursor?.anchor == null || cursor.head == null) return;
        try {
          const anchor = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.anchor), ydoc);
          const head = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.head), ydoc);
          if (!anchor || !head || anchor.type !== ytext || head.type !== ytext) return;
          const user = (peer.user ?? {}) as { color?: unknown; colorLight?: unknown; name?: unknown };
          const color = safeColor(user.color, DEFAULT_COLOR);
          selections.push({
            clientId,
            anchor: toEditor(anchor.index),
            head: toEditor(head.index),
            color,
            colorLight: safeColor(user.colorLight, color.startsWith('#') && color.length === 7 ? `${color}33` : 'rgba(48, 188, 237, 0.2)'),
            name: typeof user.name === 'string' && user.name ? user.name : 'Anonymous',
          });
        } catch (error) {
          warn(`reading the cursor of client ${clientId}`, error);
        }
      });
      return remoteSelectionDecorations(state, selections, this.view);
    } catch (error) {
      warn('drawing', error);
      // Whatever was drawn before, moved along with the text — or nothing.
      try {
        return update?.docChanged ? this.decorations.map(update.changes) : this.decorations;
      } catch {
        return Decoration.none;
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.retry) clearTimeout(this.retry);
    this.awareness.off('change', this.listener);
  }
}

export const folioRemoteSelections: Extension = ViewPlugin.fromClass(RemoteSelectionsPluginValue, {
  decorations: (value) => value.decorations,
});
