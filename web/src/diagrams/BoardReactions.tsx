import { useCallback, useEffect, useReducer, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type * as Y from 'yjs';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { SmilePlus } from 'lucide-react';
import {
  REACTION_EMOJIS,
  elementSceneBounds,
  indexReactions,
  isReactable,
  reactionTarget,
  sceneToContainerPoint,
  toggleReaction,
} from './reactionsModel';
import { BOARD_LOCAL_ORIGIN } from './boardYdoc';
import './i18n/register';

/**
 * The button centre sits this far outside the bottom-right corner of the element's bounds
 * (on both axes), which puts it clear of Excalidraw's corner resize handle.
 */
const BUTTON_OFFSET_PX = 26;
/** Chips hang this far below the bottom edge — below the selection frame and its bottom handles too. */
const CHIPS_GAP_PX = 18;
/** Excalidraw's selection colour, so the button reads as part of the selected shape's frame. */
const SELECTION_COLOR = '#6965db';

export interface BoardReactionsProps {
  api: ExcalidrawImperativeAPI | null;
  containerRef: RefObject<HTMLElement | null>;
  /** The board room's Y.Doc and its `reactions` map (reactionsModel.ts); null until the session opens. */
  doc: Y.Doc | null;
  reactions: Y.Map<unknown> | null;
  /** May this tab add/remove reactions right now (write permission AND the Edit mode)? Otherwise chips are shown but inert. */
  canReact: boolean;
  /** Stable id stored in `customData.reactions` for this viewer. */
  userId: string;
  /** Display names known on this client (self + online peers), by user id — used for chip tooltips. */
  names: Readonly<Record<string, string>>;
}

/**
 * "Add reaction" button (next to the selected shape), picker popup and reaction
 * chips, drawn as an HTML layer over the Excalidraw canvas. Positions are
 * recomputed from `appState` (scroll/zoom/offset) on every Excalidraw change,
 * so everything follows pan, zoom, resize and element moves. The button shows
 * only for exactly one selected element in the editor (see `reactionTarget`);
 * chips are always visible but clickable only when `canReact`.
 */
export function BoardReactions({ api, containerRef, doc, reactions, canReact, userId, names }: BoardReactionsProps) {
  const { t } = useTranslation('diagrams');
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);

  // Live updates: any change to the shared reactions map (local or from a peer) re-renders the chips.
  useEffect(() => {
    if (!reactions) return;
    const onChange = () => rerender();
    reactions.observe(onChange);
    return () => reactions.unobserve(onChange);
  }, [reactions]);

  // Re-render (coalesced to one per frame) on any scene/appState change.
  useEffect(() => {
    if (!api || typeof api.onChange !== 'function') return;
    const schedule = () => {
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        rerender();
      });
    };
    const unsubscribe = api.onChange(schedule);
    schedule();
    return () => {
      unsubscribe();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [api]);

  // The popup belongs to the selected element: close it as soon as the selection moves elsewhere or goes away.
  // No deps on purpose: it re-checks on every render, and renders follow every Excalidraw change.
  useEffect(() => {
    if (!pickerFor || !api || typeof api.getAppState !== 'function') return;
    if (reactionTarget(api.getSceneElements(), api.getAppState())?.id !== pickerFor) setPickerFor(null);
  });

  // Popup: close on outside press or Escape.
  useEffect(() => {
    if (!pickerFor) return;
    const onDown = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest('[data-board-reactions-popup]')) setPickerFor(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPickerFor(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerFor]);

  const toggle = useCallback(
    (elementId: string, emoji: string) => {
      if (!doc || !reactions || !canReact) return;
      toggleReaction(doc, reactions, elementId, emoji, userId, BOARD_LOCAL_ORIGIN);
    },
    [doc, reactions, canReact, userId],
  );

  if (!api || typeof api.onChange !== 'function' || typeof api.getAppState !== 'function') return null;
  const container = containerRef.current;
  if (!container) return null;

  const appState = api.getAppState();
  const origin = container.getBoundingClientRect();
  const zoom = appState.zoom.value || 1;
  const elements = api.getSceneElements();

  const index = reactions ? indexReactions(reactions) : null;
  const withChips = index ? elements.filter((el) => isReactable(el) && index.has(el.id)) : [];
  const target = canReact ? reactionTarget(elements, appState) : null;
  const picker = target && pickerFor === target.id ? target : undefined;

  const anchorOf = (el: ExcalidrawElement) => {
    const b = elementSceneBounds(el);
    const bottomLeft = sceneToContainerPoint({ x: b.left, y: b.bottom }, appState, origin);
    const bottomRight = sceneToContainerPoint({ x: b.right, y: b.bottom }, appState, origin);
    return { bottomLeft, bottomRight };
  };
  const inView = (x: number, y: number) =>
    x > -200 && y > -100 && x < appState.width + 200 && y < appState.height + 100 && zoom > 0;

  const nameList = (ids: string[]): string => {
    const known = ids.map((id) => (id === userId ? t('board.reactions.you') : names[id])).filter((n): n is string => !!n);
    const unknown = ids.length - known.length;
    return unknown > 0 ? `${known.join(', ')}${known.length ? ' ' : ''}+${unknown}` : known.join(', ');
  };

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-[3] overflow-hidden" data-board-reactions-layer>
      {withChips.map((el) => {
        const { bottomLeft } = anchorOf(el);
        if (!inView(bottomLeft.x, bottomLeft.y)) return null;
        const byEmoji = index?.get(el.id) ?? new Map<string, string[]>();
        return (
          <div
            key={el.id}
            data-board-reactions
            className="pointer-events-auto absolute flex max-w-[60vw] flex-wrap gap-1"
            style={{ left: bottomLeft.x, top: bottomLeft.y + CHIPS_GAP_PX }}
          >
            {[...byEmoji.entries()].map(([emoji, ids]) => {
              const mine = ids.includes(userId);
              const label = `${emoji} ${ids.length}`;
              const cls = `inline-flex select-none items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs leading-none shadow-sm ${
                mine
                  ? 'border-blue-400 bg-blue-50 text-blue-800 dark:border-blue-500 dark:bg-blue-950 dark:text-blue-200'
                  : 'border-neutral-300 bg-white text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200'
              }`;
              const body = (
                <>
                  <span>{emoji}</span>
                  <span className="tabular-nums">{ids.length}</span>
                </>
              );
              return canReact ? (
                <button
                  key={emoji}
                  type="button"
                  title={nameList(ids)}
                  aria-label={label}
                  aria-pressed={mine}
                  data-reaction-chip={emoji}
                  onClick={() => toggle(el.id, emoji)}
                  className={`${cls} cursor-pointer hover:brightness-95`}
                >
                  {body}
                </button>
              ) : (
                <span key={emoji} title={nameList(ids)} aria-label={label} data-reaction-chip={emoji} className={cls}>
                  {body}
                </span>
              );
            })}
          </div>
        );
      })}

      {target && (() => {
        const { bottomRight } = anchorOf(target);
        if (!inView(bottomRight.x, bottomRight.y)) return null;
        return (
          <button
            type="button"
            data-board-reactions
            data-reaction-add
            aria-label={t('board.reactions.add')}
            title={t('board.reactions.add')}
            onClick={() => setPickerFor((prev) => (prev === target.id ? null : target.id))}
            className="pointer-events-auto absolute flex h-[22px] w-[22px] items-center justify-center rounded-full border bg-white text-neutral-600 shadow-sm hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
            style={{
              left: bottomRight.x + BUTTON_OFFSET_PX - 11,
              top: bottomRight.y + BUTTON_OFFSET_PX - 11,
              borderColor: SELECTION_COLOR,
            }}
          >
            <SmilePlus size={14} />
          </button>
        );
      })()}

      {picker && (() => {
        const { bottomRight } = anchorOf(picker);
        const mineSet = new Set([...(index?.get(picker.id) ?? [])].filter(([, ids]) => ids.includes(userId)).map(([e]) => e));
        return (
          <div
            role="menu"
            aria-label={t('board.reactions.pick')}
            data-board-reactions
            data-board-reactions-popup
            className="pointer-events-auto absolute flex gap-0.5 rounded-lg border border-neutral-300 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
            style={{ left: bottomRight.x + BUTTON_OFFSET_PX - 11, top: bottomRight.y + BUTTON_OFFSET_PX + 14 }}
          >
            {REACTION_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                role="menuitem"
                aria-label={emoji}
                data-reaction-pick={emoji}
                onClick={() => {
                  toggle(picker.id, emoji);
                  setPickerFor(null);
                }}
                className={`flex h-7 w-7 items-center justify-center rounded text-base hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                  mineSet.has(emoji) ? 'bg-blue-50 dark:bg-blue-950' : ''
                }`}
              >
                {emoji}
              </button>
            ))}
          </div>
        );
      })()}
    </div>
  );
}
