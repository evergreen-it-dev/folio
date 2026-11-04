/**
 * Keeps one CodeMirror view in step with the comments panel: the bridge, the
 * highlighted ranges, and "scroll to this thread". A hook so CodeMirrorHost
 * (index.tsx) only has to hand over its view ref.
 */
import { useEffect, useRef, type MutableRefObject } from 'react';
import type { EditorView } from '@codemirror/view';
import { bridgeExtension, commentsBridgeSlot, scrollToComment, setCommentMarks, type CommentMark, type CommentsBridge } from './comment-highlights';

export interface EditorComments {
  /** Stable between renders (the view is reconfigured when it changes). */
  bridge: CommentsBridge | null;
  marks: readonly CommentMark[];
  activeId: string | null;
  /** A new object each time a card asked to be shown in the text. */
  reveal: { id: string } | null;
}

export function useCommentsInView(viewRef: MutableRefObject<EditorView | null>, session: unknown, comments: EditorComments | undefined): void {
  const bridge = comments?.bridge ?? null;
  const marks = comments?.marks;
  const activeId = comments?.activeId ?? null;
  const reveal = comments?.reveal ?? null;
  // `session` is a dependency because a fresh view starts with nothing.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: commentsBridgeSlot.reconfigure(bridgeExtension(bridge)) });
  }, [viewRef, session, bridge]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setCommentMarks.of({ marks: marks ?? [], activeId }) });
  }, [viewRef, session, marks, activeId]);
  // A reveal asked for before this view existed (the panel was used in Reading mode) is not this view's to replay.
  const handled = useRef(reveal);
  useEffect(() => {
    if (!reveal || reveal === handled.current || !viewRef.current) return;
    handled.current = reveal;
    scrollToComment(viewRef.current, reveal.id);
  }, [viewRef, reveal]);
}
