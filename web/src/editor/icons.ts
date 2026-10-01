/**
 * Tiny stroke icons in the lucide visual language (24px grid, 2px round strokes).
 *
 * Written as raw path data on purpose: these are built inside CodeMirror widgets
 * and completion rows, which are plain DOM. Mounting a React root per icon —
 * the completion list rebuilds on every keystroke — would be far more expensive
 * than a few `createElementNS` calls.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

/** The pushpin body, shared by `pin` and its struck-through twin. */
const PIN = [
  'M12 17v5',
  'M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
];

const PATHS = {
  heading: ['M6 12h12', 'M6 20V4', 'M18 20V4'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3.5 6h.01', 'M3.5 12h.01', 'M3.5 18h.01'],
  listOrdered: ['M10 6h11', 'M10 12h11', 'M10 18h11', 'M4 5.5h1V10', 'M3.5 10h2.5', 'M3.5 15.5h2.5V18H3.5v2H6'],
  listTree: ['M21 6h-9', 'M21 12h-7', 'M21 18h-7', 'M4 4v13a1 1 0 0 0 1 1h2', 'M4 11h3'],
  checklist: ['M3.5 6.5 5 8l3-3', 'M3.5 16.5 5 18l3-3', 'M12 6.5h9', 'M12 17h9'],
  table: ['M3 5h18v14H3z', 'M3 10h18', 'M10 5v14'],
  code: ['M16 18l6-6-6-6', 'M8 6l-6 6 6 6'],
  diagram: ['M4 3h6v5H4z', 'M14 16h6v5h-6z', 'M7 8v5a2 2 0 0 0 2 2h8'],
  image: ['M3 5h18v14H3z', 'M9 11a1.6 1.6 0 1 0 0-3.2A1.6 1.6 0 0 0 9 11', 'M21 15l-5-5L5 21'],
  quote: ['M6 17h3l2-4V7H5v6h3z', 'M15 17h3l2-4V7h-6v6h3z'],
  info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20', 'M12 16v-4', 'M12 8h.01'],
  smile: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20', 'M8 14s1.5 2 4 2 4-2 4-2', 'M9 9h.01', 'M15 9h.01'],
  bulb: ['M9.5 18h5', 'M10.5 21.5h3', 'M12 2.5a6.5 6.5 0 0 0-3.8 11.8V16h7.6v-1.7A6.5 6.5 0 0 0 12 2.5'],
  alert: ['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0', 'M12 9v4', 'M12 17h.01'],
  divider: ['M4 12h16'],
  text: ['M17 6H3', 'M21 12H3', 'M15 18H3'],
  pencil: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
  plus: ['M12 5v14', 'M5 12h14'],
  // The diagram zoom in live mode (mermaid-widgets.tsx): a magnifier with "+" /
  // "−" and a "fit" frame, drawn with the same stroke as the rest of the set.
  zoomIn: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16', 'm21 21-4.3-4.3', 'M11 8v6', 'M8 11h6'],
  zoomOut: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16', 'm21 21-4.3-4.3', 'M8 11h6'],
  fit: ['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5'],
  close: ['M18 6 6 18', 'M6 6l12 12'],
  alignLeft: ['M4 6h16', 'M4 12h10', 'M4 18h13'],
  alignCenter: ['M4 6h16', 'M7 12h10', 'M5 18h14'],
  alignRight: ['M4 6h16', 'M10 12h10', 'M7 18h13'],
  page: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5', 'M9 13h6', 'M9 17h4'],
  board: ['M3 4h18v13H3z', 'M8 4v13', 'M3 10h5', 'M12 8h5', 'M12 13h5'],
  link: ['M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1 1', 'M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1-1'],
  user: ['M20 21a8 8 0 0 0-16 0', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8'],
  // A summary line with the disclosure chevron under it: a block that opens.
  expand: ['M4 5h16', 'm7 11 5 5 5-5'],
  // Round 21 — the floating formatting toolbar and the table handles.
  bold: ['M7 5h5.5a3.5 3.5 0 0 1 0 7H7z', 'M7 12h6.5a3.5 3.5 0 0 1 0 7H7z'],
  italic: ['M19 5h-7', 'M12 19H5', 'M15 5 10 19'],
  underline: ['M6 4v6a6 6 0 0 0 12 0V4', 'M4 20h16'],
  strike: ['M4 12h16', 'M17 7a4 4 0 0 0-5-2c-2.6 0-4.3 1.3-4.3 3 0 1.4 1.1 2.3 2.8 3', 'M7 17a4.2 4.2 0 0 0 5 2c2.6 0 4.3-1.3 4.3-3'],
  highlight: ['m9 11-5 5v3h5l3-3', 'm21 11-4.5 4.5a1.8 1.8 0 0 1-2.6 0l-4.4-4.4a1.8 1.8 0 0 1 0-2.6L14 4z'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  // Round 25 — the pinned command toolbar and the button that unpins it.
  pin: PIN,
  pinOff: [...PIN, 'm3 3 18 18'],
  // The bare chevron — "there is more this way", where `expand` carries a
  // summary line above it and reads as a block widget instead. Round 26's
  // toolbar reveal tab used it; round 27 replaced that with a chrome-row
  // button, and the phone mode switch's caret inlines the same path in JSX
  // (index.tsx) because it is React rather than plain DOM.
  chevronDown: ['m6 9 6 6 6-6'],
  // Round 17 — table cell merges: arrows closing on a seam, and opening from it.
  merge: ['M12 3v18', 'M3 12h6', 'm7 8 4 4-4 4', 'M21 12h-6', 'm17 8-4 4 4 4'],
  split: ['M12 3v18', 'M9 12H3', 'm6 8-4 4 4 4', 'M15 12h6', 'm18 8 4 4-4 4'],
  // Toolbar list nesting (Tab/Shift+Tab, list-indent.ts) — lucide's
  // indent-increase / indent-decrease, verbatim.
  indentIncrease: ['M21 5H11', 'M21 12H11', 'M21 19H11', 'm3 8 4 4-4 4'],
  indentDecrease: ['M21 5H11', 'M21 12H11', 'M21 19H11', 'm7 8-4 4 4 4'],
} as const;

export type IconName = keyof typeof PATHS;

export function createIcon(name: IconName, badge?: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  for (const d of PATHS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }

  if (badge) {
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', '22');
    text.setAttribute('y', '21');
    text.setAttribute('text-anchor', 'end');
    text.setAttribute('font-size', '11');
    text.setAttribute('font-weight', '700');
    text.setAttribute('stroke', 'none');
    text.setAttribute('fill', 'currentColor');
    text.textContent = badge;
    svg.appendChild(text);
  }

  return svg;
}

/** Small square icon button used by the block widgets. */
export function iconButton(name: IconName, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'folio-iconbtn';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.appendChild(createIcon(name));
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}
