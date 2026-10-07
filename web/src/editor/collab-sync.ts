/**
 * The CodeMirror <-> Y.Text binding, hardened (06.10.2026, content-loss fix).
 *
 * y-codemirror.next's own `ySync` plugin applies each editor change to the
 * Y.Text inside `doc.transact`. Yjs runs the doc's 'update' handlers at the
 * end of that transaction, and an exception from ANY of them — y-indexeddb
 * writing to a connection another tab had just closed by deleting the page's
 * database was the one seen in production — leaves `transact` and the
 * plugin's `update`. CodeMirror treats that as "plugin crashed" and switches
 * the plugin off for good. From then on the editor looks and types exactly as
 * before, but nothing reaches the Y.Text: not the server, not the local copy,
 * not the history. Switching to Reading (which renders the Y.Text) showed the
 * page without anything typed since, and the editor view holding the text was
 * gone.
 *
 * This plugin replaces `ySync` inside `yCollab` (same facet, same annotation,
 * same transaction origin — the undo manager and remote cursors keep working
 * unchanged) and adds three guarantees:
 *  1. It never throws. A failure is logged and repaired, never fatal.
 *  2. It checks after every change that the editor and the Y.Text hold the same
 *     text, and repairs any difference right away. The editor is what the user
 *     sees and typed into, so a local failure is repaired editor -> Y.Text; a
 *     remote change that could not be shown is repaired Y.Text -> editor.
 *  3. When the view goes away (switching to Reading, leaving the page) it does a
 *     last check and puts anything only the editor had into the Y.Text, so the
 *     surface that comes next can never show less than the editor did.
 */
import type { Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView, type PluginValue, type ViewUpdate } from '@codemirror/view';
import { yCollab, ySync, ySyncAnnotation, ySyncFacet, type YSyncConfig } from 'y-codemirror.next';
import type * as Y from 'yjs';

/** How long after the last change the full-text comparison runs (a length check runs on every change). */
export const FULL_CHECK_DELAY_MS = 1_000;

export type CollabSyncFailure = 'local' | 'remote' | 'diverged';

/** Fired on `window` whenever the binding had to repair something — for diagnostics and tests. */
export const COLLAB_SYNC_EVENT = 'folio:collab-sync-repair';

function report(kind: CollabSyncFailure, error: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[editor] collab sync ${kind} failure — repaired, nothing lost:`, error);
  try {
    window.dispatchEvent(new CustomEvent(COLLAB_SYNC_EVENT, { detail: { kind, message: error instanceof Error ? error.message : String(error) } }));
  } catch {
    /* no window (tests without DOM) */
  }
}

/** The single span where `a` and `b` differ: a[start, endA) became b[start, endB). */
export function differingSpan(a: string, b: string): { start: number; endA: number; endB: number } {
  const max = Math.min(a.length, b.length);
  let start = 0;
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return { start, endA, endB };
}

/** How an editor reads text: CodeMirror turns "\r\n" and a lone "\r" into "\n". */
export function normalizeEol(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

/**
 * For each position of `normalizeEol(raw)` (0..length), where its source starts
 * in `raw`. The "\n" that came from "\r\n" starts at the "\r", so a span cut by
 * these positions never splits a "\r\n" pair.
 */
export function normalizedToRaw(raw: string): number[] {
  const map: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    map.push(i);
    if (raw[i] === '\r' && raw[i + 1] === '\n') i++;
  }
  map.push(raw.length);
  return map;
}

class FolioSyncPluginValue implements PluginValue {
  private readonly conf: YSyncConfig;
  private readonly ytext: Y.Text;
  /** A remote change reached the Y.Text but not the editor: the Y.Text is the superset until repaired. */
  private remoteBehind = false;
  private checkTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly observer: (event: Y.YTextEvent, tr: Y.Transaction) => void;
  /**
   * The Y.Text holds a "\r" (written before the server normalized line ends,
   * or by an old client). The editor never does, so from that character on
   * Y.Text and editor positions differ by one per "\r\n": position-by-position
   * mapping would put edits in the wrong place. While this is set, both
   * directions go through a comparison of the editor with the NORMALIZED
   * Y.Text instead, which touches only the span that really differs.
   */
  private hasCr = false;

  constructor(private readonly view: EditorView) {
    this.conf = view.state.facet(ySyncFacet);
    this.ytext = this.conf.ytext;
    this.hasCr = this.ytext.toString().includes('\r');
    this.observer = (event, tr) => {
      if (tr.origin === this.conf) return;
      if (this.hasCr || event.delta.some((d) => typeof d.insert === 'string' && d.insert.includes('\r'))) {
        this.hasCr = this.ytext.toString().includes('\r');
        this.showYText();
        return;
      }
      const changes: { from: number; to: number; insert: string }[] = [];
      let pos = 0;
      for (const d of event.delta) {
        if (d.insert != null) {
          changes.push({ from: pos, to: pos, insert: typeof d.insert === 'string' ? d.insert : '' });
        } else if (d.delete != null) {
          changes.push({ from: pos, to: pos + d.delete, insert: '' });
          pos += d.delete;
        } else if (d.retain != null) {
          pos += d.retain;
        }
      }
      try {
        this.view.dispatch({ changes, annotations: [ySyncAnnotation.of(this.conf)] });
      } catch (error) {
        // Typically "an update is in progress": the change is in the Y.Text,
        // the editor just could not take it at this instant.
        this.remoteBehind = true;
        report('remote', error);
        setTimeout(() => this.repair(), 0);
      }
    };
    this.ytext.observe(this.observer);
  }

  /** Remote change with "\r" around: bring the editor to the normalized Y.Text, touching only the span that differs. */
  private showYText(): void {
    try {
      const target = normalizeEol(this.ytext.toString());
      const editorText = this.view.state.doc.toString();
      if (target === editorText) return;
      const { start, endA, endB } = differingSpan(editorText, target);
      this.view.dispatch({ changes: { from: start, to: endA, insert: target.slice(start, endB) }, annotations: [ySyncAnnotation.of(this.conf)] });
    } catch (error) {
      this.remoteBehind = true;
      report('remote', error);
      setTimeout(() => this.repair(), 0);
    }
  }

  update(update: ViewUpdate): void {
    if (!update.docChanged) return;
    const local = update.transactions.filter((tr) => tr.annotation(ySyncAnnotation) !== this.conf);
    if (local.length === 0) return;
    if (this.hasCr) {
      // Positions do not line up (see hasCr): put the local change across by comparison.
      this.repair();
      return;
    }
    if (local.length === update.transactions.length) {
      try {
        this.ytext.doc!.transact(() => {
          let adj = 0;
          update.changes.iterChanges((fromA, toA, _fromB, _toB, insert) => {
            const insertText = insert.sliceString(0, insert.length, '\n');
            if (fromA !== toA) this.ytext.delete(fromA + adj, toA - fromA);
            if (insertText.length > 0) this.ytext.insert(fromA + adj, insertText);
            adj += insertText.length - (toA - fromA);
          });
        }, this.conf);
      } catch (error) {
        // Usually thrown by someone else's 'update' handler AFTER the change
        // was applied — the comparison below tells whether anything is missing.
        report('local', error);
      }
    }
    // A batch mixing remote and local transactions cannot be split into
    // per-transaction changes; the remote part is already in the Y.Text, so
    // comparing the results puts exactly the local part across.
    if (this.ytext.length !== update.state.doc.length || local.length !== update.transactions.length) {
      this.repair();
    } else {
      this.scheduleFullCheck();
    }
  }

  private scheduleFullCheck(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => {
      this.checkTimer = undefined;
      this.repair();
    }, FULL_CHECK_DELAY_MS);
  }

  /** Makes the editor and the Y.Text equal again, in the direction that loses nothing. Never throws. */
  private repair(final = false): void {
    try {
      const editorText = this.view.state.doc.toString();
      const rawY = this.ytext.toString();
      this.hasCr = rawY.includes('\r');
      // Compared as the editor reads it: a "\r" is never a difference worth a
      // rewrite (rewriting the span between two of them doubled text when two
      // clients did it at once — review of 54d4e76).
      const yText = normalizeEol(rawY);
      if (editorText === yText) {
        this.remoteBehind = false;
        return;
      }
      const { start, endA: endY, endB: endEditor } = differingSpan(yText, editorText);
      // Normalized positions -> Y.Text positions (identity without "\r").
      const toRaw = this.hasCr ? normalizedToRaw(rawY) : null;
      const rawStart = toRaw ? toRaw[start] : start;
      const rawEndY = toRaw ? toRaw[endY] : endY;
      if (this.remoteBehind && !final) {
        // The Y.Text has a remote change the editor never showed (and every
        // local edit since went into the Y.Text too): show the Y.Text.
        this.view.dispatch({
          changes: { from: start, to: endEditor, insert: yText.slice(start, endY) },
          annotations: [ySyncAnnotation.of(this.conf)],
        });
        this.remoteBehind = false;
        report('diverged', new Error('editor was missing a remote change'));
        return;
      }
      const insert = editorText.slice(start, endEditor);
      // On the way out with a remote change still unshown, keep BOTH: nothing
      // the Y.Text holds is deleted, the editor's text is added next to it.
      const deleteLength = this.remoteBehind ? 0 : rawEndY - rawStart;
      try {
        this.ytext.doc!.transact(() => {
          if (deleteLength > 0) this.ytext.delete(rawStart, deleteLength);
          if (insert.length > 0) this.ytext.insert(rawStart, insert);
        }, this.conf);
      } catch (error) {
        report('local', error);
      }
      // With "\r" in the text this is how every local edit travels — not a failure.
      if (!toRaw) report('diverged', new Error(`editor text was not in the shared document (${insert.length} chars put back)`));
      // The repair itself may not have landed: look again shortly (on the way
      // out there is no "shortly" — destroy() was the last chance).
      if (!final && normalizeEol(this.ytext.toString()) !== this.view.state.doc.toString()) this.scheduleFullCheck();
    } catch (error) {
      report('diverged', error);
    }
  }

  destroy(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.repair(true);
    this.ytext.unobserve(this.observer);
  }
}

const folioSync = ViewPlugin.fromClass(FolioSyncPluginValue);

/** `yCollab` with its sync plugin replaced by the hardened one above. Same arguments. */
export function folioCollab(...args: Parameters<typeof yCollab>): Extension {
  const extensions = yCollab(...args) as unknown as Extension[];
  return extensions.map((ext) => (ext === (ySync as unknown as Extension) ? folioSync : ext));
}
