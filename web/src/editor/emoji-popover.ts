/**
 * Emoji UI that lives outside CodeMirror's completion system: the dropdown for
 * the table cell's own text field and the grid picker the slash menu opens.
 *
 * Both render into `<body>` with fixed positioning for the same reason the
 * completion tooltip does — an editor-relative popover gets clipped by the
 * scroll container.
 */
import { closingColonExpansion, findEmojiTrigger, rankEmoji, rememberEmoji } from './emoji-complete';
import type { RankedEmoji } from './emoji-complete';
import { t } from './i18n';

const MAX_ROWS = 8;

function panel(className: string): HTMLElement {
  const dom = document.createElement('div');
  dom.className = className;
  dom.style.position = 'fixed';
  dom.style.zIndex = '1200';
  return dom;
}

/** Keep a fixed-position panel inside the viewport. */
function place(dom: HTMLElement, x: number, y: number): void {
  dom.style.left = '0px';
  dom.style.top = '0px';
  const rect = dom.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const below = y + rect.height + 8 <= window.innerHeight;
  dom.style.left = `${Math.round(left)}px`;
  dom.style.top = `${Math.round(below ? y : Math.max(8, y - rect.height - 20))}px`;
}

/* ----------------------------------------------------- table cell input -- */

export interface EmojiInputHandle {
  destroy(): void;
}

/**
 * Adds `:name` / `((` emoji input to a plain text field. Attach this *before*
 * the field's own key handling: while the dropdown is open it consumes the
 * navigation keys with `stopImmediatePropagation`, so the grid never sees them.
 *
 * `<textarea>` as well as `<input>` since round 21 — table cells are multi-line
 * now, and the two share every API used below (`value`, `selectionStart`,
 * `setSelectionRange`).
 */
export function attachEmojiInput(
  input: HTMLInputElement | HTMLTextAreaElement,
  favourites: readonly string[] = [],
): EmojiInputHandle {
  let dom: HTMLElement | null = null;
  let rows: RankedEmoji[] = [];
  let active = 0;
  let trigger: ReturnType<typeof findEmojiTrigger> = null;

  const close = () => {
    dom?.remove();
    dom = null;
    rows = [];
    trigger = null;
  };

  const draw = () => {
    if (!dom) {
      dom = panel('folio-emoji-pop');
      document.body.appendChild(dom);
    }
    dom.replaceChildren();
    rows.forEach((entry, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'folio-emoji-pop__row';
      if (index === active) row.dataset.active = 'true';
      const glyph = document.createElement('span');
      glyph.className = 'folio-emoji-pop__glyph';
      glyph.textContent = entry.emoji;
      const name = document.createElement('span');
      name.className = 'folio-emoji-pop__name';
      name.textContent = entry.name;
      row.append(glyph, name);
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        insert(index);
      });
      dom!.appendChild(row);
    });
    const rect = input.getBoundingClientRect();
    place(dom, rect.left, rect.bottom + 4);
  };

  const insert = (index: number) => {
    const entry = rows[index];
    if (!entry || !trigger) return;
    const caret = input.selectionStart ?? input.value.length;
    const start = trigger.from - trigger.triggerLength;
    input.value = input.value.slice(0, start) + entry.emoji + input.value.slice(caret);
    const at = start + entry.emoji.length;
    input.setSelectionRange(at, at);
    rememberEmoji(entry.emoji);
    close();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const refresh = () => {
    const caret = input.selectionStart ?? input.value.length;
    trigger = findEmojiTrigger(input.value.slice(0, caret));
    if (!trigger) return close();
    rows = rankEmoji(trigger.query, favourites, MAX_ROWS);
    if (rows.length === 0) return close();
    active = 0;
    draw();
  };

  const onInput = () => refresh();

  const onBeforeInput = (event: InputEvent) => {
    if (event.data !== ':') return;
    const caret = input.selectionStart ?? input.value.length;
    const expansion = closingColonExpansion(input.value.slice(0, caret));
    if (!expansion) return;
    event.preventDefault();
    input.value = input.value.slice(0, expansion.from) + expansion.emoji + input.value.slice(caret);
    const at = expansion.from + expansion.emoji.length;
    input.setSelectionRange(at, at);
    rememberEmoji(expansion.emoji);
    close();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!dom) return;
    const consume = () => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    if (event.key === 'ArrowDown') {
      active = (active + 1) % rows.length;
      draw();
      return consume();
    }
    if (event.key === 'ArrowUp') {
      active = (active - 1 + rows.length) % rows.length;
      draw();
      return consume();
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      insert(active);
      return consume();
    }
    if (event.key === 'Escape') {
      close();
      return consume();
    }
  };

  input.addEventListener('input', onInput);
  input.addEventListener('beforeinput', onBeforeInput as EventListener);
  input.addEventListener('keydown', onKeyDown as EventListener);
  input.addEventListener('blur', close);

  return {
    destroy() {
      input.removeEventListener('input', onInput);
      input.removeEventListener('beforeinput', onBeforeInput as EventListener);
      input.removeEventListener('keydown', onKeyDown as EventListener);
      input.removeEventListener('blur', close);
      close();
    },
  };
}

/* ------------------------------------------------------------- grid picker -- */

export interface EmojiPickerOptions {
  x: number;
  y: number;
  favourites?: readonly string[];
  onPick(emoji: string): void;
  onClose(): void;
}

/**
 * Plain-DOM emoji grid anchored at the caret.
 *
 * Deliberately not the shared `<EmojiPicker>`: that component calls
 * `useEmojiFavorites()`, which needs react-query's provider, and this popover is
 * opened from a CodeMirror completion `apply` — outside the React tree. Mounting
 * a detached root there would need its own QueryClient and would fetch twice.
 * Favourites still come from the shared hook, handed in by `PageEditor`.
 */
export function openEmojiPicker({ x, y, favourites = [], onPick, onClose }: EmojiPickerOptions): () => void {
  const dom = panel('folio-emoji-picker');

  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'folio-emoji-picker__search';
  search.placeholder = t('emoji.searchPlaceholder');
  dom.appendChild(search);

  const grid = document.createElement('div');
  grid.className = 'folio-emoji-picker__grid';
  dom.appendChild(grid);

  const render = () => {
    grid.replaceChildren();
    for (const entry of rankEmoji(search.value.trim(), favourites, 64)) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'folio-emoji-picker__cell';
      cell.title = entry.name;
      cell.textContent = entry.emoji;
      cell.addEventListener('mousedown', (event) => {
        event.preventDefault();
        rememberEmoji(entry.emoji);
        onPick(entry.emoji);
        dispose();
      });
      grid.appendChild(cell);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      dispose();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const first = grid.querySelector<HTMLButtonElement>('.folio-emoji-picker__cell');
      first?.dispatchEvent(new MouseEvent('mousedown'));
    }
  };

  const onOutside = (event: MouseEvent) => {
    if (!dom.contains(event.target as Node)) dispose();
  };

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener('mousedown', onOutside, true);
    dom.remove();
    onClose();
  };

  search.addEventListener('input', render);
  search.addEventListener('keydown', onKeyDown);
  document.addEventListener('mousedown', onOutside, true);

  document.body.appendChild(dom);
  render();
  place(dom, x, y);
  search.focus();

  return dispose;
}
