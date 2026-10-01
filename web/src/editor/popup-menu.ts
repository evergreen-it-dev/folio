/**
 * One small plain-DOM dropdown, shared by everything in the table grid that
 * needs one (round 21): the column and row `…` handles, and the mini-slash a
 * cell opens on `/`.
 *
 * It renders into `<body>` with fixed positioning for the same reason the emoji
 * popover does — the grid lives inside an `overflow-x: auto` scroller, and a
 * menu positioned inside that box would be clipped the moment it reached past
 * an edge. Widths are clamped against `--folio-ed-popmax` in editor.css.
 */
import { createIcon, type IconName } from './icons';

export interface MenuItem {
  label: string;
  icon?: IconName;
  /** Right-hand marker for a state item (the current column alignment). */
  selected?: boolean;
  /** Renders in the danger colour — deletions. */
  danger?: boolean;
  onSelect(): void;
}

/** One colour in a swatch row. `className` is what paints it. */
export interface MenuSwatch {
  label: string;
  className: string;
  selected?: boolean;
  onSelect(): void;
}

/**
 * A labelled strip of colour swatches inside the menu (round 17: the cell
 * background palette). It exists so eight colours cost one menu row instead of
 * eight — a column menu already carries alignment, insertion and deletion, and
 * a submenu would have been a new kind of thing to build and maintain.
 */
export interface MenuSwatchRow {
  kind: 'swatches';
  label: string;
  items: readonly MenuSwatch[];
}

export type MenuEntry = MenuItem | MenuSwatchRow | 'separator';

export interface MenuOptions {
  /** Viewport coordinates the menu should hang off. */
  x: number;
  y: number;
  ariaLabel: string;
  items: readonly MenuEntry[];
  /**
   * Whether the menu takes focus. The cell mini-slash must not: taking focus
   * would blur the cell's textarea, which commits and re-renders the grid out
   * from under the menu. That one drives itself from the field's own keys.
   */
  takeFocus?: boolean;
  onClose?(): void;
}

/** Remote control for a menu that does not hold focus itself. */
export interface MenuHandle {
  close(): void;
  /** Step the highlight; wraps around. */
  move(delta: number): void;
  /** Run the highlighted item (and close). */
  choose(): void;
}

/** Keep a fixed-position panel inside the viewport. */
function place(dom: HTMLElement, x: number, y: number): void {
  dom.style.left = '0px';
  dom.style.top = '0px';
  const rect = dom.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const below = y + rect.height + 8 <= window.innerHeight;
  dom.style.left = `${Math.round(left)}px`;
  dom.style.top = `${Math.round(below ? y : Math.max(8, y - rect.height - 8))}px`;
}

/** Open the menu. Closing happens on Escape, an outside click, scroll or resize. */
export function openMenu({
  x,
  y,
  ariaLabel,
  items,
  takeFocus = true,
  onClose,
}: MenuOptions): MenuHandle {
  const dom = document.createElement('div');
  dom.className = 'folio-tablemenu';
  dom.setAttribute('role', 'menu');
  dom.setAttribute('aria-label', ariaLabel);
  dom.style.position = 'fixed';
  dom.style.zIndex = '1200';

  const buttons: HTMLButtonElement[] = [];
  /** Parallel to `buttons` — what each one does, swatches included. */
  const actions: (() => void)[] = [];
  let active = 0;

  const highlight = () => {
    buttons.forEach((button, index) => {
      button.dataset.active = index === active ? 'true' : 'false';
    });
    if (takeFocus) buttons[active]?.focus({ preventScroll: true });
  };

  /** Close before acting: the action usually rewrites the document, which
      throws this menu's anchor away. */
  const run = (onSelect: () => void) => {
    dispose();
    onSelect();
  };

  const wire = (button: HTMLButtonElement, onSelect: () => void) => {
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      run(onSelect);
    });
    buttons.push(button);
    actions.push(onSelect);
  };

  for (const entry of items) {
    if (entry === 'separator') {
      const rule = document.createElement('div');
      rule.className = 'folio-tablemenu__sep';
      dom.appendChild(rule);
      continue;
    }

    if ('kind' in entry) {
      const row = document.createElement('div');
      row.className = 'folio-tablemenu__swatches';
      const caption = document.createElement('span');
      caption.className = 'folio-tablemenu__caption';
      caption.textContent = entry.label;
      row.appendChild(caption);

      const strip = document.createElement('div');
      strip.className = 'folio-tablemenu__strip';
      for (const swatch of entry.items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `folio-tablemenu__swatch ${swatch.className}`;
        button.setAttribute('role', 'menuitem');
        button.title = swatch.label;
        button.setAttribute('aria-label', swatch.label);
        if (swatch.selected) button.dataset.selected = 'true';
        wire(button, swatch.onSelect);
        strip.appendChild(button);
      }
      row.appendChild(strip);
      dom.appendChild(row);
      continue;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'folio-tablemenu__item';
    button.setAttribute('role', 'menuitem');
    if (entry.danger) button.dataset.danger = 'true';
    if (entry.selected) button.dataset.selected = 'true';
    if (entry.icon) button.appendChild(createIcon(entry.icon));
    const label = document.createElement('span');
    label.className = 'folio-tablemenu__label';
    label.textContent = entry.label;
    button.appendChild(label);
    wire(button, entry.onSelect);
    dom.appendChild(button);
  }

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener('mousedown', onOutside, true);
    window.removeEventListener('resize', dispose);
    window.removeEventListener('scroll', dispose, true);
    dom.remove();
    onClose?.();
  };

  function onOutside(event: MouseEvent): void {
    if (!dom.contains(event.target as Node)) dispose();
  }

  dom.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dispose();
      return;
    }
    if (buttons.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      move(event.key === 'ArrowDown' ? 1 : -1);
    }
  });

  const move = (delta: number) => {
    if (buttons.length === 0) return;
    active = (active + delta + buttons.length) % buttons.length;
    highlight();
  };

  document.addEventListener('mousedown', onOutside, true);
  window.addEventListener('resize', dispose);
  // Capture phase: the editor's own scroller doesn't bubble scroll events.
  window.addEventListener('scroll', dispose, true);

  document.body.appendChild(dom);
  place(dom, x, y);
  highlight();

  return {
    close: dispose,
    move,
    choose() {
      const action = actions[active];
      if (action) run(action);
    },
  };
}
