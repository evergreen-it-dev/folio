/**
 * Inline comment anchors (docs/spec.md §4.4) — the pure half.
 *
 * A thread is pinned to the page's Y.Text by two Y.RelativePosition (base64 of
 * Y.encodeRelativePosition), which survive concurrent edits. Everything here
 * speaks EDITOR coordinates — the positions CodeMirror uses — and converts at
 * the edge: the Y.Text may still hold a "\r" that the editor never has
 * (collab-sync.ts), and from that character on the two numberings differ by
 * one per "\r\n". The conversion reuses collab-sync's own `normalizedToRaw`.
 *
 * Resolution order for a thread: its anchors; failing that (the text was
 * deleted, or the doc was reseeded from the file and the anchors name items
 * this Y.Doc has never seen) the quoted text, searched for in the document;
 * failing that the thread is `detached` — still listed, never highlighted.
 */
import * as Y from 'yjs';
import { COMMENT_QUOTE_MAX } from '@shared/comments';
import { normalizeEol, normalizedToRaw } from './collab-sync';

/** What the resolver needs of a thread (a CommentThread has all of it). */
export interface AnchoredThread {
  id: string;
  anchorFrom: string;
  anchorTo: string;
  quotedText: string;
}

/** `anchor`: the Y positions resolved. `quote`: they did not, the quoted text was found. `detached`: neither. */
export type AnchorState = 'anchor' | 'quote' | 'detached';

export interface ResolvedAnchor {
  id: string;
  state: AnchorState;
  /** Editor coordinates, from < to. 0/0 when detached. */
  from: number;
  to: number;
}

/** Y.Text index <-> editor position. Identity unless the text holds a "\r". */
export interface EolMap {
  toEditor(rawIndex: number): number;
  toRaw(editorPos: number): number;
}

const IDENTITY: EolMap = { toEditor: (i) => i, toRaw: (p) => p };

export function eolMap(raw: string): EolMap {
  if (!raw.includes('\r')) return IDENTITY;
  // Entry k = where editor position k starts in `raw`; strictly increasing.
  const starts = normalizedToRaw(raw);
  const last = starts.length - 1;
  return {
    toRaw: (pos) => starts[Math.max(0, Math.min(last, pos))],
    toEditor(rawIndex) {
      // The largest editor position that starts at or before `rawIndex`.
      let lo = 0;
      let hi = last;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= rawIndex) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Anchors for the editor range [from, to). The start sticks to the character
 * AFTER it (assoc 0), the end to the character BEFORE it (assoc -1): text typed
 * at either edge lands outside the range, so a comment never swallows what is
 * typed next to it.
 */
export function createAnchors(ytext: Y.Text, from: number, to: number): { anchorFrom: string; anchorTo: string } {
  const map = eolMap(ytext.toString());
  return {
    anchorFrom: toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, map.toRaw(from), 0))),
    anchorTo: toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, map.toRaw(to), -1))),
  };
}

/** The selected text as the thread's quote — clipped to what the server accepts. */
export function quoteOf(text: string, from: number, to: number): string {
  return text.slice(from, Math.min(to, from + COMMENT_QUOTE_MAX));
}

/** Y.Text index an encoded anchor points at, or null when it cannot be resolved against this doc. */
function rawIndexOf(encoded: string, doc: Y.Doc, ytext: Y.Text): number | null {
  try {
    const abs = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(encoded)), doc);
    return abs && abs.type === ytext ? abs.index : null;
  } catch {
    return null;
  }
}

/** Where `quote` sits in the (normalized) text, or null. A quote that was trimmed on its way in still counts. */
function findQuote(text: string, quote: string): { from: number; to: number } | null {
  for (const candidate of [quote, quote.trim()]) {
    if (!candidate) continue;
    const at = text.indexOf(candidate);
    if (at >= 0) return { from: at, to: at + candidate.length };
  }
  return null;
}

/** Resolve every thread against the live document. */
export function resolveThreads(doc: Y.Doc, ytext: Y.Text, threads: readonly AnchoredThread[]): ResolvedAnchor[] {
  const raw = ytext.toString();
  const text = normalizeEol(raw);
  const map = eolMap(raw);
  return threads.map((thread) => {
    const a = rawIndexOf(thread.anchorFrom, doc, ytext);
    const b = rawIndexOf(thread.anchorTo, doc, ytext);
    if (a !== null && b !== null) {
      const from = map.toEditor(a);
      const to = map.toEditor(b);
      // A collapsed range is a deleted one: the items between the two ends are gone.
      if (to > from) return { id: thread.id, state: 'anchor', from, to };
    }
    const found = findQuote(text, thread.quotedText);
    if (found) return { id: thread.id, state: 'quote', ...found };
    return { id: thread.id, state: 'detached', from: 0, to: 0 };
  });
}

/** True when two resolutions put every thread in the same place (a re-render guard). */
export function sameResolution(a: readonly ResolvedAnchor[], b: readonly ResolvedAnchor[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i].id && x.state === b[i].state && x.from === b[i].from && x.to === b[i].to);
}

/** Document order for anchored threads; detached ones go last, in the order given. */
export function sortByPosition<T extends { id: string }>(items: readonly T[], resolved: ReadonlyMap<string, ResolvedAnchor>): T[] {
  const place = (item: T) => {
    const r = resolved.get(item.id);
    return r && r.state !== 'detached' ? r.from : Number.POSITIVE_INFINITY;
  };
  return items
    .map((item, index) => ({ item, index, at: place(item) }))
    .sort((x, y) => (x.at === y.at ? x.index - y.index : x.at < y.at ? -1 : 1))
    .map((x) => x.item);
}
