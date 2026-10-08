/**
 * The pinned command toolbar (round 25).
 *
 * A strip docked to the top of the editor carrying the same commands the «/»
 * menu offers plus inline formatting, for authors who would rather point at a
 * button than remember a trigger. Both halves are borrowed, not re-implemented:
 * the blocks come from block-commands.ts (the «/» menu's own list and its own
 * insertion), the formatting from format-toolbar.ts's `buildFormatBar`, and the
 * overflow list from popup-menu.ts.
 *
 * It is a CodeMirror top panel rather than a React element in index.tsx: panels
 * already sit above the scroller (where the search bar docks), the view is
 * right there for the commands to run against, and both source and live mode
 * get it from one extension without touching the component tree.
 *
 * Unpinning is remembered per browser (`folio.editor.toolbar`). Hiding it never
 * hides the way back — round 25 shipped with only a hotkey and a one-off toast,
 * and an owner who unpinned the strip had no visible way back at all. Round 26
 * answered that with a reveal tab standing where the strip had been; round 27
 * replaced the tab with a button in the chrome row above the editor, beside the
 * mode switch (index.tsx's `PanelToggle`). The visible affordance is always
 * there either way; what changed is that it no longer eats a full-width strip
 * of the document to say so.
 *
 * That button is React and lives outside the view, so it cannot read
 * `pinnedField` and the field cannot re-render it. See «shared state» below for
 * the channel between the two.
 */
import { StateEffect, StateField, Prec, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, showPanel, type Command, type Panel } from '@codemirror/view';
import { runBlockCommand, toolbarOverflowItems, toolbarPrimaryItems, type BlockItem } from './block-commands';
import {
  buildFormatBar,
  formatCommand,
  highlightColorCommand,
  highlightColorOf,
  isFormatActive,
  linkCommand,
  quoteCommand,
} from './format-toolbar';
import { createIcon } from './icons';
import { t } from './i18n';
import { currentLanguage, languageChangedEffect } from './i18n-reload';
import { listDedent, listIndent, listIndentAvailable } from './list-indent';
import { openMenu, type MenuEntry } from './popup-menu';
import { insertStatus } from './status-widget';
import { showToast } from './toast';

const PINNED_KEY = 'folio.editor.toolbar';
const HINTED_KEY = 'folio.editor.toolbar.hinted';

/**
 * Show/hide binding. Deliberately an Alt combination: every Mod+Shift+letter
 * that reads as "panel" is already taken by a browser (⌘⇧P is Firefox's
 * private window, ⌘⇧B the bookmarks bar, ⌘⇧T reopens a closed tab), and those
 * cannot be intercepted from a page at all.
 *
 * Kept as the name of the binding for tooltips and tests; the matching itself
 * is `matchesToolbarHotkey` below, NOT a `keymap.of` entry — see the comment
 * there for why a keymap cannot see this combination on a Mac.
 */
export const TOOLBAR_HOTKEY = 'Alt-Shift-p';

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent || '');
}

/**
 * Whether a keydown is ⌥⇧P, matched on the *key* rather than on the character
 * the OS produced from it.
 *
 * This is the whole reason the hotkey is not a `keymap.of([{ key:
 * 'Alt-Shift-p' }])` binding. CodeMirror resolves a binding through
 * `keyName(event)`, which is `event.key` — on macOS Alt+Shift+P types «∏», so
 * the lookup is for `Shift-Alt-∏` and misses. CodeMirror does keep a fallback
 * to the physical key (`base[event.keyCode]`), but it explicitly refuses to use
 * it for plain Alt combinations on macOS, because there they are ordinary typed
 * characters: see `runHandlers` in @codemirror/view, guard `!(browser.mac &&
 * event.altKey && !(event.ctrlKey || event.metaKey))`. Net effect: the binding
 * fired on Windows and Linux and was dead on every Mac — including the owner's,
 * which is how the toolbar became unreachable.
 *
 * `code` is the physical key and is what a Mac still reports correctly ('KeyP');
 * `keyCode` covers synthetic events that carry no `code`; `key` covers layouts
 * where P sits somewhere else physically (Dvorak). Any of the three agreeing is
 * enough — Alt+Shift with neither Ctrl nor Meta is a narrow enough gate that a
 * false positive is not a real risk.
 */
export function matchesToolbarHotkey(event: KeyboardEvent): boolean {
  if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return false;
  if (event.code === 'KeyP') return true;
  if (event.keyCode === 80) return true;
  return typeof event.key === 'string' && event.key.toLowerCase() === 'p';
}

/** The hotkey as a human would write it, for tooltips and the toast. */
export function toolbarHotkeyLabel(): string {
  return isMac() ? '⌥⇧P' : 'Alt+Shift+P';
}

/* --------------------------------------------------------------- storage -- */

function readPinned(): boolean {
  try {
    // Absent means pinned: the toolbar is the discoverable default, and only an
    // explicit unpin turns it off.
    return localStorage.getItem(PINNED_KEY) !== 'off';
  } catch {
    return true;
  }
}

function writePinned(pinned: boolean): void {
  try {
    localStorage.setItem(PINNED_KEY, pinned ? 'on' : 'off');
  } catch {
    /* storage unavailable — the choice just won't persist */
  }
}

/** True the first time only; the hint is a nudge, not a recurring notice. */
function claimHint(): boolean {
  try {
    if (localStorage.getItem(HINTED_KEY) === 'yes') return false;
    localStorage.setItem(HINTED_KEY, 'yes');
    return true;
  } catch {
    return true;
  }
}

/* ---------------------------------------------------------- shared state -- */

/**
 * Round 27. The show/hide control moved out of the editor and into the chrome
 * row (index.tsx), which is React and sits outside the CodeMirror view — so the
 * two halves of this feature can no longer see each other's state at all.
 *
 * `localStorage` is the value both already agree on; this is the change
 * notification layered over it. Every writer goes through `setToolbarPinned`,
 * the button subscribes here (via `useSyncExternalStore`), and `pinnedSync`
 * below carries the change into whatever view is mounted. Nothing is cached:
 * `toolbarPinnedNow` re-reads storage, so a state built by `readPinned` and a
 * button rendered from here can never disagree.
 */
const listeners = new Set<(pinned: boolean) => void>();

/** The current state, for a caller with no `EditorState` in hand. */
export function toolbarPinnedNow(): boolean {
  return readPinned();
}

/** Listen for toggles from anywhere: the strip, the hotkey, the chrome button. */
export function subscribeToolbarPinned(listener: (pinned: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/* ----------------------------------------------------------------- state -- */

const setPinned = StateEffect.define<boolean>();

const pinnedField = StateField.define<boolean>({
  create: readPinned,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setPinned)) return effect.value;
    return value;
  },
  // Hidden means no panel at all now: round 26's reveal tab spanned the whole
  // top edge of the editor to offer one chevron, and the chrome-row button says
  // the same thing without spending a strip of the document on it.
  provide: (field) => showPanel.from(field, (pinned) => (pinned ? toolbarPanel : null)),
});

export function isToolbarPinned(state: EditorState): boolean {
  return state.field(pinnedField, false) ?? false;
}

/**
 * The single writer. `view` is optional because the chrome-row button has none
 * to hand — in reading mode there is no editor mounted at all — and the panel
 * picks the change up through `pinnedSync` rather than through this call.
 */
export function setToolbarPinned(pinned: boolean, view?: EditorView): void {
  writePinned(pinned);
  // A copy: a listener that unsubscribes itself must not disturb the walk.
  for (const listener of [...listeners]) listener(pinned);
  if (!pinned && view && claimHint()) {
    showToast(view, t('toolbar.hint', { key: toolbarHotkeyLabel() }));
  }
}

export const toggleToolbar: Command = (view) => {
  setToolbarPinned(!isToolbarPinned(view.state), view);
  return true;
};

/** What the chrome-row button calls: the same toggle, without a view. */
export function toggleToolbarPinned(): void {
  setToolbarPinned(!readPinned());
}

/**
 * Carries a toggle that happened elsewhere — the chrome button, a second editor
 * on screen — into this view's field, which is what actually shows or hides the
 * panel. Guarded on the current value, so the toggle that started *here* (the
 * hotkey, the strip's own unpin button) finds nothing left to do and the panel
 * is never reconfigured twice for one press.
 */
const pinnedSync = ViewPlugin.define((view) => {
  const unsubscribe = subscribeToolbarPinned((pinned) => {
    if (isToolbarPinned(view.state) === pinned) return;
    view.dispatch({ effects: setPinned.of(pinned) });
  });
  return { destroy: unsubscribe };
});

/* ----------------------------------------------------------------- panel -- */

function iconButton(item: BlockItem, run: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cm-folio-toolbar__btn';
  button.dataset.command = item.id;
  const label = t(`slash.${item.id}.name`);
  button.title = label;
  button.setAttribute('aria-label', label);
  button.appendChild(createIcon(item.icon, item.badge));
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    run();
  });
  return button;
}

/**
 * Indent / outdent a list item — the same `listIndent`/`listDedent` Tab and
 * Shift+Tab already run (list-indent.ts); the button is just a second way to
 * reach them. Owner: "there are no indent buttons in the toolbar" — Tab worked but nobody
 * could see that the action existed.
 *
 * Disabled, not hidden, off a list line: `button.disabled` already blocks the
 * click, so `command(view)` never runs against a non-list line — the visible
 * affordance is the whole point (the owner needs to *see* the action exists).
 */
function listNudgeButton(kind: 'indent' | 'dedent', view: EditorView): HTMLButtonElement {
  const command = kind === 'indent' ? listIndent : listDedent;
  const shortcut = kind === 'indent' ? 'Tab' : 'Shift+Tab';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cm-folio-toolbar__btn';
  button.dataset.command = kind === 'indent' ? 'listIndent' : 'listDedent';
  const label = t(`toolbar.${kind}`);
  button.title = `${label} (${shortcut})`;
  button.setAttribute('aria-label', label);
  button.appendChild(createIcon(kind === 'indent' ? 'indentIncrease' : 'indentDecrease'));
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    command(view);
    view.focus();
  });
  return button;
}

function toolbarPanel(view: EditorView): Panel {
  const dom = document.createElement('div');
  dom.className = 'cm-folio-toolbar';
  dom.setAttribute('role', 'toolbar');
  // Keeps the selection (and the editor's focus) exactly where it is: a toolbar
  // that clears what you selected is a toolbar that cannot work.
  dom.addEventListener('mousedown', (event) => event.preventDefault());

  /** Rebuilt on selection changes for the pressed states; the rest is static. */
  const formatSlot = document.createElement('div');
  formatSlot.className = 'cm-folio-toolbar__group';

  const blockSlot = document.createElement('div');
  blockSlot.className = 'cm-folio-toolbar__group cm-folio-toolbar__group--blocks';

  const tail = document.createElement('div');
  tail.className = 'cm-folio-toolbar__tail';

  let language = currentLanguage();

  const renderFormat = (): void => {
    formatSlot.replaceChildren(
      buildFormatBar({
        quote: true,
        isActive: (kind) => isFormatActive(view.state, kind),
        onFormat: (kind) => formatCommand(kind)(view),
        onQuote: () => quoteCommand(view),
        onLink: () => linkCommand(view),
        onStatus: () => void insertStatus(view),
        onHighlightColor: (pick) => highlightColorCommand(pick)(view),
        highlightColor: () => highlightColorOf(view.state),
      }),
    );
  };

  let indentBtn: HTMLButtonElement | null = null;
  let dedentBtn: HTMLButtonElement | null = null;

  /** Cheap: two buttons, run on every selection change so the enabled state
   *  tracks the caret without rebuilding the whole block group. */
  const updateListButtons = (): void => {
    const enabled = listIndentAvailable(view.state);
    if (indentBtn) indentBtn.disabled = !enabled;
    if (dedentBtn) dedentBtn.disabled = !enabled;
  };

  const renderBlocks = (): void => {
    const primary = toolbarPrimaryItems();
    const rest = toolbarOverflowItems();

    const buttons = primary.map((item) => iconButton(item, () => runBlockCommand(view, item)));
    // Next to the three list kinds (list/ordered/task), right before table.
    indentBtn = listNudgeButton('indent', view);
    dedentBtn = listNudgeButton('dedent', view);
    const afterTask = primary.findIndex((item) => item.id === 'task') + 1;
    buttons.splice(afterTask, 0, indentBtn, dedentBtn);
    updateListButtons();

    blockSlot.replaceChildren(...buttons);

    if (rest.length > 0) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'cm-folio-toolbar__btn';
      more.title = t('toolbar.more');
      more.setAttribute('aria-label', t('toolbar.more'));
      more.appendChild(createIcon('more'));
      more.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = more.getBoundingClientRect();
        const items: MenuEntry[] = rest.map((item) => ({
          label: t(`slash.${item.id}.name`),
          icon: item.icon,
          onSelect: () => runBlockCommand(view, item),
        }));
        openMenu({ x: rect.left, y: rect.bottom + 4, ariaLabel: t('toolbar.more'), items });
      });
      blockSlot.appendChild(more);
    }
  };

  const renderTail = (): void => {
    const unpin = document.createElement('button');
    unpin.type = 'button';
    unpin.className = 'cm-folio-toolbar__unpin';
    const label = t('toolbar.unpin', { key: toolbarHotkeyLabel() });
    unpin.title = label;
    unpin.setAttribute('aria-label', label);
    unpin.appendChild(createIcon('pinOff'));
    unpin.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleToolbar(view);
    });
    tail.replaceChildren(unpin);
  };

  const renderAll = (): void => {
    dom.setAttribute('aria-label', t('toolbar.aria'));
    renderFormat();
    renderBlocks();
    renderTail();
  };

  renderAll();
  dom.append(formatSlot, blockSlot, tail);

  return {
    dom,
    top: true,
    update(update) {
      if (update.transactions.some((tr) => tr.effects.some((effect) => effect.is(languageChangedEffect)))) {
        language = currentLanguage();
        renderAll();
        return;
      }
      // Cheap: seven buttons, and the pressed states are wrong the moment the
      // caret moves out of a bold run.
      if (update.docChanged || update.selectionSet) {
        renderFormat();
        updateListButtons();
      }
      // A late bundle registration can change the labels without an effect.
      if (currentLanguage() !== language) {
        language = currentLanguage();
        renderAll();
      }
    },
  };
}

/**
 * The hotkey, as a DOM handler rather than a keymap entry.
 *
 * `Prec.highest` so it is consulted before CodeMirror's own `handleKeyEvents`
 * (which sits at `Prec.default`); returning true makes CodeMirror call
 * `preventDefault` and stop, so nothing else sees the event and the strip
 * cannot be toggled twice by one press.
 */
const toolbarHotkey = Prec.highest(
  EditorView.domEventHandlers({
    keydown(event, view) {
      if (!matchesToolbarHotkey(event)) return false;
      return toggleToolbar(view);
    },
  }),
);

/** The panel, its state and its hotkey — one extension for both editor modes. */
export const pinToolbar: Extension = [pinnedField, pinnedSync, toolbarHotkey];
