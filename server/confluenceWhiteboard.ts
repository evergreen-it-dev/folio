/**
 * Round 24: Confluence Cloud whiteboards -> Folio boards (.excalidraw.svg).
 *
 * A 1:1 TypeScript port of a Python prototype that was verified against
 * three real boards, plus the network half of its export script. Every
 * non-obvious constant below (the Helvetica advance table, BASE_FONT=15.8, the
 * attachment-offset median for sections, the 34px legacyGeometry stub) is
 * carried over verbatim because each one was calibrated against real board
 * data, not derived.
 *
 * WHY THE LAYOUT WORK IS DONE HERE AND NOT LEFT TO EXCALIDRAW: loadFromBlob
 * calls restore() with refreshDimensions:false, so excalidraw does NOT
 * re-wrap or re-measure text when the scene opens. The scene has to arrive
 * already laid out — otherwise every label renders as one long ribbon,
 * clipped by its shape, until someone double-clicks it (which finally runs
 * redrawTextBoundingBox). So this module wraps text itself and computes
 * bound-text size/position with excalidraw's own formulas
 * (BOUND_TEXT_PADDING, getBoundTextMaxWidth/Height, computeBoundTextPosition),
 * growing the container under the text the way Confluence does.
 *
 * Split in three, deliberately:
 *  - pure conversion (WHITEBOARD_DOC_FORMAT -> scene -> .excalidraw.svg
 *    string), no network, no fs — this is what the tests cover;
 *  - `selfcheckWhiteboardSvg`, the prototype's own assert pass, kept as a
 *    runtime guard on every import (it catches dangling bindings and text
 *    that overflows its container for the price of one inflate);
 *  - the Cloud fetch (REST metadata + GraphQL gateway), which is the only
 *    part that needs credentials.
 */
import * as zlib from 'node:zlib';
import { badRequest } from './errors.js';
import { ADV_TABLE } from './confluenceWhiteboardMetrics.js';

// ---------------------------------------------------------------------------
// Palette / fonts / constants (ported verbatim from the prototype)
// ---------------------------------------------------------------------------

/** Atlassian Design Tokens palette (approximation of the official values). */
const PALETTE: Record<string, string> = {
  'palette.dark.gray.300': '#44546F', 'palette.dark.gray.200': '#626F86',
  // Seen on the owner's real boards and previously missing: a gray sticky/
  // section (light.gray.100) silently came out bright YELLOW, and a green
  // shape outline (dark.green.300) came out neutral, because colorOf fell back
  // without a trace. Any token still missing now raises a job warning.
  'palette.light.gray.100': '#F1F2F4', 'palette.dark.green.300': '#216E4E',
  'palette.light.red.200': '#FFD5D2', 'palette.light.red.300': '#FD9891',
  'palette.light.green.200': '#BAF3DB', 'palette.light.green.300': '#7EE2B8',
  'palette.light.yellow.200': '#FFF7D6', 'palette.light.yellow.300': '#F8E6A0',
  'palette.light.purple.200': '#DFD8FD', 'palette.light.purple.300': '#B8ACF6',
  'palette.light.teal.200': '#C6EDFB', 'palette.light.teal.300': '#9DD9EE',
  'palette.light.magenta.200': '#FDD0EC', 'palette.light.magenta.300': '#F797D2',
  'palette.light.lime.200': '#D3F1A7', 'palette.light.lime.300': '#B3DF72',
  'palette.light.orange.200': '#FEDEC8', 'palette.light.orange.300': '#FEC195',
  'palette.light.blue.200': '#CCE0FF', 'palette.light.blue.300': '#85B8FF',
  'palette.light.gray.200': '#DCDFE4', 'palette.light.gray.300': '#B3B9C4',
};
const DEFAULT_STROKE = '#1e1e1e';

/**
 * excalidraw fontFamily=2 -> "Helvetica, Segoe UI Emoji" (a local font;
 * Windows substitutes the metrically compatible Arial). The table below is
 * real Helvetica advance widths in 1/1000 em, grouped by value.
 */
const FONT_FAMILY = 2;
const LINE_HEIGHT = 1.25;
/** Helvetica ascender/descender (unitsPerEm 2048) — for the SVG baseline. */
const ASCENT_EM = 1577 / 2048;
const DESCENT_EM = -471 / 2048;
const BOUND_TEXT_PADDING = 5; // excalidraw BOUND_TEXT_PADDING
const TEXT_NODE_PADDING = 7.7; // Confluence text node side padding
const ARROW_LABEL_WIDTH_FRACTION = 0.7;
const ARROW_LABEL_MIN_WIDTH_RATIO = 11;

/**
 * Confluence's base text size in our (Helvetica) units. Calibrated against
 * real boards: for nodes with allowFlexibleWidth the stored legacyGeometry
 * width = measure(text) * BASE_FONT + 2*padding; solving that system over a
 * set of nodes gives ~15.8-16.0. A node's final size is BASE_FONT * fontScale.
 */
const BASE_FONT = 15.8;
const MIN_FONT = 7.0;
/** How far a shape may grow to fit its text before the font shrinks instead. */
const MAX_CONTAINER_GROWTH = 3.0;

const ADV = new Map<string, number>();
for (const [width, chars] of Object.entries(ADV_TABLE)) {
  for (const ch of chars) ADV.set(ch, Number(width));
}

/**
 * Confluence whiteboard stamps -> emoji. An id with no entry here still gets
 * DRAWN — as a neutral ⬤ placeholder plus a job warning — because a stamp is a
 * teammate's reaction on a specific sticky: dropping it loses a vote, and the
 * board silently disagrees with the original.
 *
 * The second block is everything the owner's real boards actually use that the
 * first block was missing (15 reactions were being thrown away).
 */
const UNKNOWN_STAMP = '⬤';
const STAMPS: Record<string, string> = {
  '100': '💯', megaphone: '📣', 'ok-face': '🙂', 'question-mark': '❓',
  shocked: '😱', artist: '🎨', spicy: '🌶️', success: '✅', error: '❌',
  win: '🏆', trophy: '🏆', tool: '🔧', tools: '🛠️', wrench: '🔧',
  note: '🗒️', notes: '🗒️', memo: '📝', pin: '📌', clip: '📎',
  cool: '😎', smile: '🙂', grin: '😀', sad: '🙁', cry: '😢',
  idea: '💡', bulb: '💡', brain: '🧠', magic: '✨', sparkles: '✨',
  like: '👍', thumbsup: '👍', 'thumbs-up': '👍', 'plus-one': '👍',
  dislike: '👎', thumbsdown: '👎', 'thumbs-down': '👎',
  heart: '❤️', love: '😍', star: '⭐', fire: '🔥', rocket: '🚀',
  question: '❓', check: '✅', tick: '✅', cross: '❌', no: '⛔',
  warning: '⚠️', alert: '⚠️', flag: '🚩', target: '🎯', bomb: '💣',
  clock: '⏰', time: '⏰', calendar: '📅', money: '💰', chart: '📈',
  lock: '🔒', key: '🔑', bug: '🐞', gear: '⚙️', settings: '⚙️',
  celebration: '🎉', party: '🎉', eyes: '👀', hand: '✋', wave: '👋',
  people: '👥', person: '👤', chat: '💬', mail: '✉️', phone: '📞',
  link: '🔗', book: '📖', folder: '📁', search: '🔍', lightning: '⚡',
};

// ---------------------------------------------------------------------------
// Font metrics + wrapping
// ---------------------------------------------------------------------------

function charAdvance(ch: string): number {
  const known = ADV.get(ch);
  if (known !== undefined) return known;
  const o = ch.codePointAt(0) ?? 0;
  if (o < 0x20) return 0;
  if (o >= 0x1f000 || (o >= 0x2190 && o <= 0x27bf) || (o >= 0xfe00 && o <= 0xfe0f)) return 1100; // emoji/symbol fallback, generous on purpose
  if ((o >= 0x4e00 && o <= 0x9fff) || (o >= 0x3040 && o <= 0x30ff)) return 1000; // CJK
  return 600;
}

/**
 * Width of one line in px. Deliberately biased slightly high: underestimating
 * gets the text clipped by its container, overestimating only wraps a touch
 * earlier.
 */
export function textWidth(s: string, fontSize: number): number {
  let total = 0;
  for (const ch of s) total += charAdvance(ch);
  return (total * fontSize) / 1000;
}

const BREAK_AFTER = '/\\-–—';

/**
 * Splits a line at every legal break point (after a space and after a
 * slash/hyphen) — the same way Confluence breaks "Incident/Problem/" and
 * "SLA-project" at the separator instead of mid-word.
 */
function chunksOf(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    cur += ch;
    if (ch === ' ' || BREAK_AFTER.includes(ch)) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out;
}

function rstrip(s: string): string {
  return s.replace(/\s+$/u, '');
}

/** Greedy wrap at maxWidth. A chunk longer than the line is split per character. */
export function wrapText(text: string, fontSize: number, maxWidth: number): string[] {
  if (maxWidth <= 0) return text.split('\n');
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let cur = '';
    const chunks = chunksOf(para);
    for (const chunk of chunks.length ? chunks : ['']) {
      const cand = cur + chunk;
      if (textWidth(rstrip(cand), fontSize) <= maxWidth || !cur.trim()) {
        if (textWidth(rstrip(cand), fontSize) <= maxWidth) {
          cur = cand;
          continue;
        }
        if (cur.trim()) {
          lines.push(rstrip(cur));
          cur = '';
        }
        // the chunk alone is wider than the line — split it per character
        let piece = Array.from(chunk);
        while (piece.length) {
          let take = '';
          let taken = 0;
          for (const ch of piece) {
            if (textWidth(take + ch, fontSize) > maxWidth && take) break;
            take += ch;
            taken += 1;
          }
          piece = piece.slice(taken);
          if (piece.length) lines.push(rstrip(take));
          else cur = take;
        }
      } else {
        lines.push(rstrip(cur));
        cur = chunk === ' ' ? '' : chunk;
      }
    }
    lines.push(rstrip(cur));
  }
  return lines.length ? lines : [''];
}

export interface TextMetrics {
  text: string;
  width: number;
  height: number;
}

/** -> wrapped text + width/height exactly as excalidraw computes them. */
export function textMetrics(text: string, fontSize: number, maxWidth?: number | null): TextMetrics {
  const lines = maxWidth ? wrapText(text, fontSize, maxWidth) : text.split('\n');
  let width = 0;
  for (const line of lines) width = Math.max(width, textWidth(line, fontSize));
  return { text: lines.join('\n'), width, height: lines.length * fontSize * LINE_HEIGHT };
}

// ---------------------------------------------------------------------------
// Scene element shapes
// ---------------------------------------------------------------------------

export interface ExcalidrawBinding {
  elementId: string;
  focus: number;
  gap: number;
  /**
   * REQUIRED on both ends of an elbow arrow: excalidraw's own restore() calls
   * repairBinding, which returns null for any binding on an `elbowed` arrow
   * that has no fixedPoint — i.e. setting elbowed without this would have
   * thrown the bindings away on load. Confluence hands us exactly this: the
   * connector's sourceAnchor/targetAnchor are {left, top} fractions of the
   * bound element's box.
   */
  fixedPoint?: [number, number];
}

export interface ExcalidrawElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: string;
  strokeWidth: number;
  strokeStyle: string;
  roughness: number;
  opacity: number;
  groupIds: string[];
  frameId: string | null;
  index: string | null;
  roundness: { type: number } | null;
  seed: number;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  boundElements: { id: string; type: string }[] | null;
  updated: number;
  link: string | null;
  locked: boolean;
  /** frame-only: the label excalidraw draws above the frame. */
  name?: string | null;
  // text-only
  text?: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: string;
  verticalAlign?: string;
  containerId?: string | null;
  originalText?: string;
  autoResize?: boolean;
  lineHeight?: number;
  // arrow-only
  points?: [number, number][];
  lastCommittedPoint?: null;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
  startBinding?: ExcalidrawBinding | null;
  endBinding?: ExcalidrawBinding | null;
  elbowed?: boolean;
  // elbow-arrow-only, mirroring excalidraw's newArrowElement defaults
  fixedSegments?: { start: [number, number]; end: [number, number]; index: number }[];
  startIsSpecial?: boolean;
  endIsSpecial?: boolean;
}

export interface ExcalidrawScene {
  type: 'excalidraw';
  version: number;
  source: string;
  elements: ExcalidrawElement[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

/**
 * The prototype seeds Python's `random.Random(42)`; excalidraw only uses
 * `seed`/`versionNonce` to randomize the hand-drawn roughness (which is 0
 * here), so the exact numbers are irrelevant — determinism is not: the same
 * board must convert to byte-identical output on every run, or re-importing
 * a board would churn the git history. mulberry32(42) gives that.
 */
function makeSeeder(): () => number {
  let state = 42 >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % 0x7fffffff) + 1;
  };
}

/** Exported for server/boardSketch.ts (the AI assistant's board builder) — same element skeleton, no behavior change. */
export function baseEl(seed: () => number, id: string, type: string, x: number, y: number, w: number, h: number, angle = 0): ExcalidrawElement {
  return {
    id, type, x, y, width: w, height: h,
    angle, strokeColor: DEFAULT_STROKE, backgroundColor: 'transparent',
    fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 0,
    opacity: 100, groupIds: [], frameId: null, index: null,
    roundness: null, seed: seed(), version: 1, versionNonce: seed(),
    isDeleted: false, boundElements: null, updated: 1, link: null, locked: false,
  };
}

interface TextElOptions {
  align?: string;
  valign?: string;
  container?: string | null;
  angle?: number;
  original?: string;
}

/** Exported for server/boardSketch.ts — see baseEl's export note. */
export function textEl(
  seed: () => number,
  id: string,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
  fontSize: number,
  color: string,
  opts: TextElOptions = {},
): ExcalidrawElement {
  const el = baseEl(seed, id, 'text', x, y, w, h, opts.angle ?? 0);
  el.strokeColor = color;
  el.text = text;
  el.fontSize = fontSize;
  el.fontFamily = FONT_FAMILY;
  el.textAlign = opts.align ?? 'left';
  el.verticalAlign = opts.valign ?? 'top';
  el.containerId = opts.container ?? null;
  el.originalText = opts.original !== undefined ? opts.original : text;
  el.autoResize = true;
  el.lineHeight = LINE_HEIGHT;
  return el;
}

// ---------------------------------------------------------------------------
// Bound-text geometry (excalidraw's own formulas)
// ---------------------------------------------------------------------------

export function boundTextMaxWidth(container: ExcalidrawElement, fontSize = BASE_FONT): number {
  const w = container.width;
  if (container.type === 'arrow') return Math.max(ARROW_LABEL_WIDTH_FRACTION * w, ARROW_LABEL_MIN_WIDTH_RATIO * fontSize);
  if (container.type === 'ellipse') return Math.round((w / 2) * Math.SQRT2) - BOUND_TEXT_PADDING * 2;
  if (container.type === 'diamond') return Math.round(w / 2) - BOUND_TEXT_PADDING * 2;
  return w - BOUND_TEXT_PADDING * 2;
}

export function boundTextMaxHeight(container: ExcalidrawElement): number {
  if (container.type === 'arrow') return container.height;
  return container.height - BOUND_TEXT_PADDING * 2;
}

function containerCoords(container: ExcalidrawElement): [number, number] {
  let ox = BOUND_TEXT_PADDING;
  let oy = BOUND_TEXT_PADDING;
  if (container.type === 'ellipse') {
    ox += (container.width / 2) * (1 - Math.SQRT2 / 2);
    oy += (container.height / 2) * (1 - Math.SQRT2 / 2);
  } else if (container.type === 'diamond') {
    ox += container.width / 4;
    oy += container.height / 4;
  }
  return [container.x + ox, container.y + oy];
}

/** Inverse of boundTextMaxHeight: how tall the container must be for this text. */
function containerHeightForText(textHeight: number, containerType: string): number {
  const need = textHeight + BOUND_TEXT_PADDING * 2;
  if (containerType === 'ellipse') return need * Math.SQRT2;
  if (containerType === 'diamond') return need * 2;
  return need;
}

/** The point halfway along the polyline — where excalidraw draws an arrow's label. */
function arrowMidpoint(arrow: ExcalidrawElement): [number, number] {
  const pts: [number, number][] = (arrow.points ?? []).map((p) => [arrow.x + p[0], arrow.y + p[1]]);
  if (pts.length < 2) return pts[0] ?? [arrow.x, arrow.y];
  const segs: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) segs.push(Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]));
  let half = segs.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < segs.length; i++) {
    const len = segs[i];
    if (half <= len || i === segs.length - 1) {
      const k = len ? half / len : 0;
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k];
    }
    half -= len;
  }
  return pts[pts.length - 1];
}

/** Places a bound text inside its container per computeBoundTextPosition. Exported for server/boardSketch.ts — see baseEl's export note. */
export function placeBoundText(container: ExcalidrawElement, tel: ExcalidrawElement): void {
  if (container.type === 'arrow') {
    const [mx, my] = arrowMidpoint(container);
    tel.x = mx - tel.width / 2;
    tel.y = my - tel.height / 2;
    return;
  }
  const [cx, cy] = containerCoords(container);
  const maxW = boundTextMaxWidth(container, tel.fontSize ?? BASE_FONT);
  const maxH = boundTextMaxHeight(container);
  if (tel.verticalAlign === 'top') tel.y = cy;
  else if (tel.verticalAlign === 'bottom') tel.y = cy + (maxH - tel.height);
  else tel.y = cy + (maxH / 2 - tel.height / 2);
  if (tel.textAlign === 'left') tel.x = cx;
  else if (tel.textAlign === 'right') tel.x = cx + (maxW - tel.width);
  else tel.x = cx + (maxW / 2 - tel.width / 2);
}

// ---------------------------------------------------------------------------
// WHITEBOARD_DOC_FORMAT reading helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function asRecord(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/**
 * `missing` collects tokens that fell back, so an unknown palette entry
 * surfaces as a job warning instead of silently painting the wrong colour.
 */
function colorOf(token: unknown, fallback = DEFAULT_STROKE, missing?: Set<string>): string {
  const key = str(token);
  if (!key) return fallback;
  const hit = PALETTE[key];
  if (hit === undefined) {
    if (key.startsWith('palette.')) missing?.add(key);
    return fallback;
  }
  return hit;
}

function parseAdf(value: unknown): unknown | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Flattens embedded ADF (a JSON string or an object) into plain text.
 *
 * Lists carry their marker: `bulletList`/`orderedList` were unknown types, so
 * their items lost every "•"/"1." and the reader could not tell a list from a
 * run of sentences. `listItem` also used to emit a newline of its own ON TOP OF
 * the one its inner `paragraph` emits, blank-lining every list.
 */
export function adfText(value: unknown): string {
  const parsed = parseAdf(value);
  if (parsed === null) return typeof value === 'string' ? value.split(/\s+/).filter(Boolean).join(' ') : '';
  const out: string[] = [];
  function walk(n: unknown, indent: string, marker: string): void {
    if (Array.isArray(n)) {
      for (const c of n) walk(c, indent, marker);
      return;
    }
    const rec = asRecord(n);
    if (!rec) return;
    const t = rec.type;
    if (t === 'text' && typeof rec.text === 'string') {
      out.push(rec.text);
      return;
    }
    if (t === 'hardBreak') {
      out.push('\n');
      return;
    }
    if (t === 'bulletList' || t === 'orderedList') {
      const items = Array.isArray(rec.content) ? rec.content : [];
      const first = Math.max(1, Math.round(num(asRecord(rec.attrs)?.order, 1)));
      items.forEach((item, i) => walk(item, indent, t === 'bulletList' ? '• ' : `${first + i}. `));
      return;
    }
    if (t === 'listItem') {
      out.push(indent + marker);
      // the inner paragraph supplies the trailing newline — emitting one here
      // too is what produced a blank line after every bullet. A list nested
      // INSIDE this item indents one level further.
      if (Array.isArray(rec.content)) for (const c of rec.content) walk(c, `${indent}  `, '');
      return;
    }
    if (Array.isArray(rec.content)) for (const c of rec.content) walk(c, indent, marker);
    if (t === 'paragraph' || t === 'heading') out.push('\n');
  }
  walk(parsed, '', '');
  const lines = out
    .join('')
    .split(/\r\n|[\n\r]/)
    // collapse runs of whitespace but KEEP the leading indent of a nested item
    .map((l) => `${/^ */.exec(l)![0]}${l.split(/\s+/).filter(Boolean).join(' ')}`.replace(/\s+$/u, ''));
  return lines.join('\n').trim();
}

/**
 * The href of the first ADF `link` mark in a node's text. excalidraw has no
 * per-run links inside bound text, so the URL used to be dropped outright;
 * hoisted onto the element it at least stays clickable (and resolvable back
 * into Folio) instead of vanishing.
 */
export function adfFirstLink(value: unknown): string | null {
  const parsed = parseAdf(value);
  if (parsed === null) return null;
  let found: string | null = null;
  (function walk(n: unknown): void {
    if (found !== null) return;
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    const rec = asRecord(n);
    if (!rec) return;
    if (Array.isArray(rec.marks)) {
      for (const mk of rec.marks) {
        const m = asRecord(mk);
        if (m?.type === 'link') {
          const href = str(asRecord(m.attrs)?.href);
          if (href) {
            found = href;
            return;
          }
        }
      }
    }
    if (Array.isArray(rec.content)) for (const c of rec.content) walk(c);
  })(parsed);
  return found;
}

function prettyUrl(url: unknown): string {
  return str(url).replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');
}

interface Geometry {
  position?: { x?: unknown; y?: unknown };
  size?: { x?: unknown; y?: unknown };
}

function geomSrc(n: Json): Geometry {
  for (const key of ['geometry', 'legacyGeometry'] as const) {
    const g = (asRecord(n[key]) ?? {}) as Geometry;
    const s = asRecord(g.size) ?? {};
    if (num(s.x) > 1 && num(s.y) > 1) return g;
  }
  return ((asRecord(n.geometry) ?? asRecord(n.legacyGeometry)) ?? {}) as Geometry;
}

function hasGeom(n: Json): boolean {
  const s = asRecord(geomSrc(n).size) ?? {};
  return num(s.x) > 1 && num(s.y) > 1;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * THE coordinate system of WHITEBOARD_DOC_FORMAT: `position` is the element's
 * CENTRE, not its top-left corner. excalidraw's x/y are the top-left, so every
 * box is shifted by (-w/2, -h/2) on the way in.
 *
 * Proved three independent ways against the owner's real boards (the
 * measurements live in .qa/qa3-wbfix-*.mts):
 *  - attachment edges carry `offset`, and `child.position = host.position -
 *    host.size/2 + offset` holds to 0.000 px on 73 of 84 parent/child pairs
 *    (all 47 section->child pairs exact; the 11 misses are stale offsets on
 *    stamps whose sticky was moved afterwards). Under a top-left reading the
 *    median error is 657 px;
 *  - a connector's stored absolute `start`/`end` vs the point its own anchor
 *    fraction names on the bound shape: 136 of 312 endpoints agree to <2 px
 *    under the centre reading (the rest sit at the connector's ~11 px gap),
 *    ZERO agree under top-left;
 *  - a text node's `geometry` (h=38) and `legacyGeometry` (h=48) boxes share
 *    the same TOP edge under the centre reading and nothing at all under
 *    top-left.
 *
 * Reading it as top-left was the single cause of the "everything is offset"
 * complaints: stickies are all 144x144 so they stayed consistent WITH EACH
 * OTHER, while a 1314x1680 section moved +585/+768 px relative to them, a
 * 1252x38 column heading +554/-53, and a 60x60 stamp -42/-42.
 */
function geom(n: Json): Box {
  const g = geomSrc(n);
  const p = asRecord(g.position) ?? {};
  const s = asRecord(g.size) ?? {};
  const w = Math.max(s.x === undefined ? 10 : num(s.x, 10), 4);
  const h = Math.max(s.y === undefined ? 10 : num(s.y, 10), 4);
  return { x: num(p.x, 0) - w / 2, y: num(p.y, 0) - h / 2, w, h };
}

/**
 * An allowFlexibleWidth text node's `geometry` is a 34px stub — the real
 * laid-out box lives in legacyGeometry. Same centre-based `position`.
 */
function textGeom(n: Json): Box {
  if (n.allowFlexibleWidth) {
    const lg = (asRecord(n.legacyGeometry) ?? {}) as Geometry;
    const p = asRecord(lg.position) ?? {};
    const s = asRecord(lg.size) ?? {};
    if (num(s.x) > 1) {
      const w = num(s.x);
      const h = Math.max(num(s.y, 10) || 10, 4);
      return { x: num(p.x, 0) - w / 2, y: num(p.y, 0) - h / 2, w, h };
    }
  }
  return geom(n);
}

function deg2rad(d: unknown): number {
  return (num(d, 0) * Math.PI) / 180;
}

// ---------------------------------------------------------------------------
// Elbow (orthogonal) connector routing
// ---------------------------------------------------------------------------

type AnchorSide = 'left' | 'right' | 'top' | 'bottom' | null;

/**
 * Which EDGE of the shape a connector leaves from. Confluence stores the
 * anchor as {left, top} fractions of the box, and every real anchor pins one
 * of the two to 0 or 1 — that pinned axis is the side. A free-floating anchor
 * (neither pinned) returns null and the router picks the longer axis.
 */
export function anchorSide(anchor: unknown): AnchorSide {
  const a = asRecord(anchor);
  if (!a) return null;
  const left = num(a.left, 0.5);
  const top = num(a.top, 0.5);
  if (left <= 1e-3) return 'left';
  if (left >= 1 - 1e-3) return 'right';
  if (top <= 1e-3) return 'top';
  if (top >= 1 - 1e-3) return 'bottom';
  return null;
}

/**
 * Drops points that repeat, and mid-points that sit on a straight run.
 *
 * "Straight run" means the line keeps GOING the same way through b — if it
 * doubles back there, b is a real corner (an author's waypoint the route was
 * told to reach) and removing it would quietly move the line off that point.
 */
function simplifyRoute(pts: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 0.01 && Math.abs(last[1] - p[1]) < 0.01) continue;
    out.push(p);
  }
  for (let i = 1; i < out.length - 1; ) {
    const [a, b, c] = [out[i - 1], out[i], out[i + 1]];
    const sameX = Math.abs(a[0] - b[0]) < 0.01 && Math.abs(b[0] - c[0]) < 0.01;
    const sameY = Math.abs(a[1] - b[1]) < 0.01 && Math.abs(b[1] - c[1]) < 0.01;
    const onward = sameX ? (b[1] - a[1]) * (c[1] - b[1]) >= 0 : sameY ? (b[0] - a[0]) * (c[0] - b[0]) >= 0 : false;
    if ((sameX || sameY) && onward) out.splice(i, 1);
    else i++;
  }
  return out.length >= 2 ? out : pts.slice(0, 2);
}

/**
 * An orthogonal route between two anchored points: leave each end
 * perpendicular to its own edge, turn at right angles in between. Same three
 * cases excalidraw's own elbow router uses — two Z-turns when both ends face
 * along the same axis, one L-turn when they face across.
 */
export function elbowRoute(s: [number, number], sSide: AnchorSide, e: [number, number], eSide: AnchorSide): [number, number][] {
  const sh = sSide === 'left' || sSide === 'right';
  const sv = sSide === 'top' || sSide === 'bottom';
  const eh = eSide === 'left' || eSide === 'right';
  const ev = eSide === 'top' || eSide === 'bottom';
  let mid: [number, number][];
  if (sh && eh) {
    const mx = (s[0] + e[0]) / 2;
    mid = [[mx, s[1]], [mx, e[1]]];
  } else if (sv && ev) {
    const my = (s[1] + e[1]) / 2;
    mid = [[s[0], my], [e[0], my]];
  } else if (sh && ev) {
    mid = [[e[0], s[1]]];
  } else if (sv && eh) {
    mid = [[s[0], e[1]]];
  } else if (sh || ev) {
    mid = [[e[0], s[1]]];
  } else if (sv || eh) {
    mid = [[s[0], e[1]]];
  } else {
    mid = Math.abs(e[0] - s[0]) >= Math.abs(e[1] - s[1]) ? [[e[0], s[1]]] : [[s[0], e[1]]];
  }
  return simplifyRoute([s, ...mid, e]);
}

/**
 * The same orthogonal treatment for a connector the author routed by hand: keep
 * every waypoint, but join them with right angles instead of diagonals. The
 * first leg leaves along the source's own axis, the last arrives along the
 * target's, and the legs in between alternate.
 */
export function elbowRouteVia(
  s: [number, number],
  sSide: AnchorSide,
  via: [number, number][],
  e: [number, number],
  eSide: AnchorSide,
): [number, number][] {
  const stops = [...via, e];
  const out: [number, number][] = [s];
  let horizontal = sSide === 'left' || sSide === 'right';
  if (sSide === null) horizontal = Math.abs(stops[0][0] - s[0]) >= Math.abs(stops[0][1] - s[1]);
  let cur = s;
  stops.forEach((q, i) => {
    const last = i === stops.length - 1;
    // the final leg must arrive perpendicular to the target's own edge
    const goHorizontalFirst = last && eSide !== null ? !(eSide === 'left' || eSide === 'right') : horizontal;
    out.push(goHorizontalFirst ? [q[0], cur[1]] : [cur[0], q[1]]);
    out.push(q);
    cur = q;
    horizontal = !goHorizontalFirst;
  });
  return simplifyRoute(out);
}

/** The `fixedPoint` half of an elbow arrow's binding (see ExcalidrawBinding). Exported for server/boardSketch.ts — see baseEl's export note. */
export function fixedPointOf(elbow: boolean, anchor: unknown): { fixedPoint?: [number, number] } {
  if (!elbow) return {};
  const a = asRecord(anchor) ?? {};
  return { fixedPoint: [num(a.left, 0.5), num(a.top, 0.5)] };
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

export interface WhiteboardConvertOptions {
  /**
   * Round 24 point 4: a smartLink node pointing at a page that is ALSO being
   * imported gets rewritten to the relative Folio path, exactly like an
   * in-body link in an imported markdown page. Returning undefined leaves the
   * raw Confluence URL in place (the correct answer for an external link).
   */
  resolveLink?: (url: string) => string | undefined;
  /**
   * Optional companion to resolveLink: a human title for a RESOLVED url, used
   * as the visible label when the smartLink node has no text of its own
   * (otherwise the label stays the raw URL — misleading once the link itself
   * points inside Folio). Only consulted when resolveLink returned a value;
   * label layout is computed at conversion time, so changing it here is safe.
   */
  resolveLinkLabel?: (url: string) => string | undefined;
  /** Heading above the column of geometry-less smartLinks. */
  linkLegendHeading?: string;
}

export interface WhiteboardConversion {
  scene: ExcalidrawScene;
  /** Non-fatal notes for the import job's summary (unknown stamps, skipped nodes). */
  warnings: string[];
}

/** WHITEBOARD_DOC_FORMAT ({nodes, edges}) -> an excalidraw scene. Pure. */
export function convertWhiteboardDocument(doc: unknown, options: WhiteboardConvertOptions = {}): WhiteboardConversion {
  const document = asRecord(doc) ?? {};
  const seed = makeSeeder();
  const warnings: string[] = [];
  const unknownStamps = new Set<string>();
  const missingTokens = new Set<string>();
  const droppedTypes = new Map<string, number>();

  const nodesRaw = document.nodes;
  const nodes = new Map<string, Json>();
  if (Array.isArray(nodesRaw)) {
    for (const n of nodesRaw) {
      const rec = asRecord(n);
      if (rec) nodes.set(str(rec.id), rec);
    }
  } else {
    const rec = asRecord(nodesRaw) ?? {};
    for (const [k, v] of Object.entries(rec)) {
      const node = asRecord(v);
      if (node) nodes.set(String(k), node);
    }
  }

  const edgesRaw = document.edges;
  const edges: Json[] = [];
  if (Array.isArray(edgesRaw)) {
    for (const e of edgesRaw) {
      const rec = asRecord(e);
      if (rec) edges.push(rec);
    }
  } else {
    for (const v of Object.values(asRecord(edgesRaw) ?? {})) {
      const rec = asRecord(v);
      if (rec) edges.push(rec);
    }
  }

  // connectorNodeId -> [sourceNode, targetNode]
  const assoc = new Map<string, [string, string]>();
  for (const e of edges) {
    if (e.type === 'association') assoc.set(str(e.id), [str(e.sourceNode), str(e.targetNode)]);
  }
  // pathLabel binding: an attachment edge whose source is the connector id and
  // whose own id is the label node's id; plus the conventional
  // '<connId>-path-label' suffix.
  const connLabel = new Map<string, string>();
  for (const e of edges) {
    if (e.type === 'attachment' && e.source !== undefined && e.source !== null) {
      const lblId = str(e.id);
      const child = nodes.get(lblId);
      // A connector's waypoints hang off the very same kind of edge; taking one
      // as the label used to shadow the real pathLabel.
      if (child && child.type !== 'pathWaypoint') connLabel.set(str(e.source), lblId);
    }
  }
  for (const nid of nodes.keys()) {
    if (nid.endsWith('-path-label')) {
      const key = nid.slice(0, -'-path-label'.length);
      if (!connLabel.has(key)) connLabel.set(key, nid);
    }
  }

  const elements: ExcalidrawElement[] = [];
  const outBySrc = new Map<string, ExcalidrawElement>();
  const linkLegend: { label: string; url: string }[] = [];

  /**
   * Lays `txt` out inside `container` as bound text: wraps it to the
   * container's width, computes size/position, and makes the text fit.
   *
   * `shrinkFirst` picks WHICH of the two knobs moves. A shape is drawn around
   * its label and Confluence really does grow it, so a shape grows first and
   * only shrinks the font when it has run out of room. A STICKY NOTE is the
   * other way round: it is a fixed 144x144 (240x144) tile in a hand-laid grid,
   * and Confluence keeps that tile and shrinks the writing — growing it
   * instead pushed 37 of 284 stickies out of their row (worst: 144 -> 405 px,
   * +181%) and made them overlap their neighbours.
   */
  function attachLabel(
    container: ExcalidrawElement,
    nid: string,
    txt: string,
    fontSize: number,
    color: string,
    align: string,
    valign: string,
    shrinkFirst = false,
  ): ExcalidrawElement | null {
    if (!txt) return null;
    let fs = Math.max(MIN_FONT, fontSize);
    let maxW = boundTextMaxWidth(container, fs);
    let m = textMetrics(txt, fs, maxW);
    let limit = boundTextMaxHeight(container);
    if (container.type === 'arrow') limit = m.height; // an arrow label's height is unconstrained
    if (m.height > limit && shrinkFirst) {
      // Keep the tile, shrink the writing — down to MIN_FONT, which is where
      // the text stops being readable at all.
      while (m.height > limit && fs > MIN_FONT) {
        fs = Math.max(MIN_FONT, fs - 0.5);
        maxW = boundTextMaxWidth(container, fs);
        m = textMetrics(txt, fs, maxW);
      }
    }
    if (m.height > limit) {
      let grown = containerHeightForText(m.height, container.type);
      if (grown <= container.height * MAX_CONTAINER_GROWTH) {
        // grow symmetrically about the centre so connector anchors (top: 0.5) stay put
        container.y -= (grown - container.height) / 2;
        container.height = grown;
      } else {
        while (fs > MIN_FONT) {
          fs = Math.max(MIN_FONT, fs - 0.5);
          maxW = boundTextMaxWidth(container, fs);
          m = textMetrics(txt, fs, maxW);
          if (m.height <= container.height * MAX_CONTAINER_GROWTH - BOUND_TEXT_PADDING * 2) break;
        }
        grown = containerHeightForText(m.height, container.type);
        if (grown > container.height) {
          container.y -= (grown - container.height) / 2;
          container.height = grown;
        }
      }
    }
    const tel = textEl(seed, `t-${nid}`, m.text, 0, 0, Math.min(m.width, maxW), m.height, fs, color, {
      align, valign, container: container.id, original: txt,
    });
    placeBoundText(container, tel);
    container.boundElements = [...(container.boundElements ?? []), { id: tel.id, type: 'text' }];
    elements.push(tel);
    return tel;
  }

  const zsorted = [...nodes.entries()].sort((a, b) => num(a[1].zIndex, 0) - num(b[1].zIndex, 0));

  // 1) sections -> excalidraw FRAMES (first, so they sit UNDER the content)
  //
  // A Confluence section is a named zone that owns whatever sits in it: the
  // owner's retro boards are four columns, and dragging a column has to drag
  // its stickies. As a plain tinted rectangle (which is what this used to
  // emit) frameId and groupIds stayed empty on every board, so the column was
  // only a picture of a column. A frame carries its members for real.
  const frames: ExcalidrawElement[] = [];
  for (const [nid, n] of zsorted) {
    if (n.type !== 'section') continue;
    if (!hasGeom(n)) continue;
    // No attachment-offset median here any more: `offset` IS measured from the
    // section's top-left, so the old "median of (child.position - offset)"
    // reconstructed exactly what geom() now returns — running both would
    // subtract w/2,h/2 twice. It is also why board 3037134849 used to mix two
    // coordinate systems: sections that happened to have attachment children
    // came out right, sections without them did not.
    const { x, y, w, h } = geom(n);
    const el = baseEl(seed, nid, 'frame', x, y, w, h);
    // excalidraw paints a frame with the canvas colour and ignores this, but
    // OUR .excalidraw.svg preview — the file that actually lands in the repo
    // and is what the reader sees — keeps the section's Confluence tint.
    el.backgroundColor = colorOf(n.color, '#E9F2FF', missingTokens);
    el.strokeColor = '#A0AEC0';
    el.roundness = null; // frames are never rounded
    el.opacity = 45;
    // Drawn above the frame, by excalidraw and by renderSceneSvg. An UNTITLED
    // section must be '' and not null: excalidraw's getFrameLikeTitle turns null
    // into the literal word "Frame", and most of the owner's sections carry no
    // title of their own (their column headings are separate text nodes), so
    // null gave four boards' worth of captions saying "Frame" that the source
    // never had. '' renders nothing.
    el.name = str(n.title);
    elements.push(el);
    outBySrc.set(nid, el);
    frames.push(el);
  }

  // 2) shapes / stickies / texts / smartLinks / stamps / images / stickers
  // `pathLabel` and `pathWaypoint` are folded into their connector, a `comment`
  // is a discussion thread rather than board content — those three are the only
  // types that legitimately produce nothing. Anything else that falls through
  // now says so (see the `else` at the bottom of the chain).
  const SKIP_TYPES = new Set(['section', 'connector', 'pathLabel', 'pathWaypoint', 'comment']);
  for (const [nid, n] of zsorted) {
    const t = str(n.type);
    if (SKIP_TYPES.has(t)) continue;
    const box = geom(n);
    const angle = deg2rad(n.rotation);
    const txt = adfText(n.text);
    const scale = num(n.fontScale, 1) || 1;
    // A node whose whole text is one ADF link keeps that link on the element:
    // excalidraw has no per-run links inside bound text, but it does draw a
    // badge on any element carrying `link` — and resolveLink can point it back
    // into Folio, exactly like a smartLink.
    const inlineHref = adfFirstLink(n.text);
    const nodeLink = inlineHref ? (options.resolveLink?.(inlineHref) ?? inlineHref) : null;

    if (t === 'shape') {
      const shp = str(n.shape) || 'rectangle';
      const exType = shp.includes('ellipse') ? 'ellipse' : shp.includes('diamond') ? 'diamond' : 'rectangle';
      const el = baseEl(seed, nid, exType, box.x, box.y, box.w, box.h, angle);
      el.backgroundColor = n.fillEnabled ? colorOf(n.color, '#F8E6A0', missingTokens) : 'transparent';
      el.strokeColor = colorOf(n.strokeColor, '#7A869A', missingTokens);
      el.roundness = exType === 'rectangle' ? { type: 3 } : null;
      el.link = nodeLink;
      elements.push(el);
      outBySrc.set(nid, el);
      attachLabel(el, nid, txt, BASE_FONT * scale, '#1e1e1e', str(n.alignment) || 'center', str(n.verticalAlignment) || 'middle');
    } else if (t === 'sticky') {
      const el = baseEl(seed, nid, 'rectangle', box.x, box.y, box.w, box.h, angle);
      el.backgroundColor = colorOf(n.color, '#F8E6A0', missingTokens);
      el.strokeColor = 'transparent';
      el.roundness = { type: 3 };
      el.link = nodeLink;
      elements.push(el);
      outBySrc.set(nid, el);
      // shrinkFirst: a sticky is a fixed tile in a grid — see attachLabel.
      attachLabel(el, nid, txt, BASE_FONT * scale, '#1e1e1e', 'center', 'middle', true);
    } else if (t === 'text') {
      const tb = textGeom(n);
      const fs = BASE_FONT * scale;
      // allowFlexibleWidth=false -> the width is fixed; the export stores it AT
      // SCALE 1, hence the fontScale multiplication.
      const fixed = !n.allowFlexibleWidth;
      const maxW = fixed ? tb.w * scale - TEXT_NODE_PADDING * 2 : null;
      const m = textMetrics(txt || ' ', fs, maxW);
      const tel = textEl(seed, nid, m.text, tb.x, tb.y, m.width, m.height, fs, colorOf(n.color, '#1e1e1e', missingTokens), {
        align: str(n.alignment) || 'left', valign: 'top', angle, original: txt || ' ',
      });
      if (fixed) {
        tel.autoResize = false;
        tel.width = Math.max(m.width, maxW ?? 0);
      }
      tel.link = nodeLink;
      elements.push(tel);
      outBySrc.set(nid, tel);
    } else if (t === 'smartLink') {
      const rawUrl = str(n.url);
      const resolved = options.resolveLink?.(rawUrl);
      const url = resolved ?? rawUrl;
      const label = txt || (resolved !== undefined ? options.resolveLinkLabel?.(rawUrl) : undefined) || prettyUrl(rawUrl) || 'link';
      if (!hasGeom(n)) {
        linkLegend.push({ label, url });
        continue;
      }
      // Just a text link: no card, no icon — excalidraw draws its own badge
      // for any element carrying a `link`.
      const fs = BASE_FONT * scale;
      const m = textMetrics(label, fs, Math.max(box.w - BOUND_TEXT_PADDING * 2, 40));
      const tel = textEl(seed, nid, m.text, box.x, box.y, m.width, m.height, fs, '#0B66E4', {
        align: 'left', valign: 'top', angle, original: label,
      });
      tel.link = url || null;
      tel.autoResize = false;
      elements.push(tel);
      outBySrc.set(nid, tel);
    } else if (t === 'stamp') {
      if (!hasGeom(n)) continue;
      const sid = str(n.stampId).toLowerCase();
      let glyph = STAMPS[sid];
      if (!glyph) {
        // Draw it anyway: a stamp is somebody's reaction on a specific sticky,
        // and a missing one silently changes what the board says.
        unknownStamps.add(sid || 'stamp');
        glyph = UNKNOWN_STAMP;
      }
      const fs = Math.max(14, Math.min(box.w, box.h) * 0.7);
      const m = textMetrics(glyph, fs);
      elements.push(
        textEl(seed, nid, glyph, box.x + (box.w - m.width) / 2, box.y + (box.h - m.height) / 2, m.width, m.height, fs, '#1e1e1e', {
          align: 'center', valign: 'middle', angle,
        }),
      );
      outBySrc.set(nid, elements[elements.length - 1]);
    } else if (t === 'image' || t === 'sticker') {
      // Neither can be rendered offline: an `image` needs a Media API round
      // trip for its fileId, a `sticker` is a Confluence-hosted asset. Holding
      // the space with a labelled placeholder keeps the rest of the layout
      // honest (and tells the reader something used to be here) instead of
      // leaving a hole nobody can explain.
      if (!hasGeom(n)) {
        droppedTypes.set(t, (droppedTypes.get(t) ?? 0) + 1);
        continue;
      }
      const el = baseEl(seed, nid, 'rectangle', box.x, box.y, box.w, box.h, angle);
      el.backgroundColor = '#F1F2F4';
      el.strokeColor = '#B3B9C4';
      el.strokeStyle = 'dashed';
      el.roundness = { type: 3 };
      elements.push(el);
      outBySrc.set(nid, el);
      const caption = t === 'image' ? `🖼 ${str(n.mimeType) || 'image'}` : `🖼 ${str(n.stickerId) || 'sticker'}`;
      attachLabel(el, nid, caption, Math.min(BASE_FONT, box.h / 3), '#626F86', 'center', 'middle', true);
      droppedTypes.set(t, (droppedTypes.get(t) ?? 0) + 1);
    } else if (t === 'path') {
      // A `path` is a connector without an association: same fields
      // (start/end/caps/presentation), no bound shapes. Emitted with the
      // connectors below so it shares their routing.
      continue;
    } else {
      // The point of this branch: a whole node type used to vanish with
      // `warnings: []`, so nobody ever learned a picture had gone missing.
      droppedTypes.set(t || 'unknown', (droppedTypes.get(t || 'unknown') ?? 0) + 1);
    }
  }

  // 3) connectors and paths -> arrows (+ waypoints, labels, bindings)
  const waypoints = new Map<string, { order: number; x: number; y: number }[]>();
  const addWaypoint = (key: string, n: Json): void => {
    const box = geom(n);
    const list = waypoints.get(key) ?? [];
    // a waypoint is a 1x1 marker: its CENTRE is the point being routed through
    list.push({ order: num(n.order, 0), x: box.x + box.w / 2, y: box.y + box.h / 2 });
    waypoints.set(key, list);
  };
  for (const [nid, n] of nodes) {
    if (n.type !== 'pathWaypoint') continue;
    const m = /^(.*)-waypoint(?:-\d+)?$/.exec(nid);
    if (m) addWaypoint(m[1], n);
  }
  // The real export does NOT use that suffix convention: a waypoint hangs off
  // its connector by an attachment edge, under an id shaped
  // `path-waypoint-<connectorId>-<waypointId>`. Every author-placed waypoint on
  // the owner's boards was being silently ignored because of that.
  for (const e of edges) {
    if (e.type !== 'attachment') continue;
    const child = nodes.get(str(e.id));
    const key = str(e.source);
    if (child && child.type === 'pathWaypoint' && nodes.has(key) && !str(e.id).match(/-waypoint(?:-\d+)?$/)) {
      addWaypoint(key, child);
    }
  }

  function anchorPoint(nodeId: string, anchor: unknown, fallback: [number, number]): [number, number] {
    const el = outBySrc.get(nodeId);
    if (!el || el.type === 'text') return fallback;
    const a = asRecord(anchor) ?? {};
    return [el.x + el.width * num(a.left, 0.5), el.y + el.height * num(a.top, 0.5)];
  }

  for (const [nid, n] of zsorted) {
    const kind = str(n.type);
    if (kind !== 'connector' && kind !== 'path') continue;
    const start = asRecord(n.start) ?? {};
    const end = asRecord(n.end) ?? {};
    let sx = num(start.x, 0);
    let sy = num(start.y, 0);
    let ex = num(end.x, 0);
    let ey = num(end.y, 0);
    const pair = assoc.get(nid);
    if (pair) {
      // dynamic connectors are bound to shapes by anchor; the raw start/end in
      // the export can be stale — recompute from the FINAL geometry (a shape
      // may have grown under its text).
      [sx, sy] = anchorPoint(pair[0], n.sourceAnchor, [sx, sy]);
      [ex, ey] = anchorPoint(pair[1], n.targetAnchor, [ex, ey]);
    }
    const wps = [...(waypoints.get(nid) ?? [])].sort((a, b) => a.order - b.order || a.x - b.x || a.y - b.y);

    /**
     * Round 24b point 4. `presentation: "dynamic"` is Confluence's ELBOW
     * connector — it leaves a shape perpendicular to the anchored side and
     * turns at right angles; 149 of the 156 connectors on the owner's boards
     * are dynamic, and every one of them arrived as a bare diagonal because
     * this field was never read and `elbowed` was hard-coded false.
     *
     * The route has to be computed HERE and not left to excalidraw: restore()
     * keeps `points` verbatim, so an elbow arrow whose points are a diagonal
     * simply renders as a diagonal (in the editor and in the .svg preview
     * alike) until somebody drags it.
     */
    const dynamic = str(n.presentation) === 'dynamic';
    // `elbowed` is excalidraw's own managed elbow arrow, which re-routes itself
    // from the bindings — so it is only claimed when there is nothing of the
    // author's to preserve. A hand-routed connector keeps its waypoints and is
    // merely drawn orthogonally.
    const elbow = dynamic && wps.length === 0;
    const sSide = anchorSide(n.sourceAnchor);
    const eSide = anchorSide(n.targetAnchor);
    let abs: [number, number][];
    if (elbow) {
      abs = elbowRoute([sx, sy], sSide, [ex, ey], eSide);
    } else if (dynamic) {
      abs = elbowRouteVia([sx, sy], sSide, wps.map((wp) => [wp.x, wp.y] as [number, number]), [ex, ey], eSide);
    } else {
      abs = [[sx, sy], ...wps.map((wp) => [wp.x, wp.y] as [number, number]), [ex, ey]];
    }
    const pts: [number, number][] = abs.map(([px, py]) => [px - sx, py - sy]);

    // width/height from the point cloud, the way excalidraw's own
    // getSizeFromPoints does — an elbow route's box is wider than |end-start|.
    const bw = Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]));
    const bh = Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]));
    const el = baseEl(seed, nid, 'arrow', sx, sy, bw, bh);
    el.points = pts;
    el.lastCommittedPoint = null;
    el.startArrowhead = n.startCap === 'arrow' ? 'arrow' : null;
    el.endArrowhead = n.endCap === 'arrow' ? 'arrow' : null;
    el.strokeColor = colorOf(n.color, '#495057', missingTokens);
    el.strokeWidth = n.stroke === 'medium' || n.stroke === 'large' ? 2 : 1;
    el.strokeStyle = n.strokeStyle === 'dashed' ? 'dashed' : 'solid';
    el.startBinding = null;
    el.endBinding = null;
    el.elbowed = elbow;
    if (elbow) {
      // excalidraw's newArrowElement defaults for an elbow arrow
      el.fixedSegments = [];
      el.startIsSpecial = false;
      el.endIsSpecial = false;
    }

    if (pair) {
      const sEl = outBySrc.get(pair[0]);
      const tEl = outBySrc.get(pair[1]);
      if (sEl && sEl.type !== 'frame' && sEl.type !== 'text') {
        el.startBinding = { elementId: sEl.id, focus: 0, gap: 4, ...fixedPointOf(elbow, n.sourceAnchor) };
        sEl.boundElements = [...(sEl.boundElements ?? []), { id: nid, type: 'arrow' }];
      }
      if (tEl && tEl.type !== 'frame' && tEl.type !== 'text') {
        el.endBinding = { elementId: tEl.id, focus: 0, gap: 4, ...fixedPointOf(elbow, n.targetAnchor) };
        tEl.boundElements = [...(tEl.boundElements ?? []), { id: nid, type: 'arrow' }];
      }
    }
    elements.push(el);

    const lblId = connLabel.get(nid);
    const lnode = lblId ? nodes.get(lblId) : undefined;
    if (lnode) {
      const ltxt = adfText(lnode.text);
      if (ltxt) {
        attachLabel(el, nid, ltxt, BASE_FONT * (num(lnode.fontScale, 1) || 1), colorOf(lnode.color, '#44546F', missingTokens), 'center', 'middle');
      }
    }
  }

  /**
   * Frame membership, computed LAST because shapes may have grown under their
   * text along the way. Only an element that fits ENTIRELY inside a frame joins
   * it: excalidraw clips a frame's members, so adopting a sticky that straddles
   * the edge would visibly cut it in half. Overlapping sections (one pair on
   * one real board) resolve to the smallest frame that still contains the
   * element.
   */
  if (frames.length) {
    const byIdNow = new Map(elements.map((e) => [e.id, e]));
    for (const e of elements) {
      if (e.type === 'frame' || e.containerId) continue;
      let best: ExcalidrawElement | null = null;
      for (const f of frames) {
        if (e.x >= f.x && e.y >= f.y && e.x + e.width <= f.x + f.width && e.y + e.height <= f.y + f.height) {
          if (!best || f.width * f.height < best.width * best.height) best = f;
        }
      }
      e.frameId = best ? best.id : null;
    }
    // bound text belongs to whatever its container belongs to
    for (const e of elements) {
      if (e.containerId) e.frameId = byIdNow.get(e.containerId)?.frameId ?? null;
    }
  }

  // A column of links (smartLinks with no coordinates in the export), under the content.
  if (linkLegend.length) {
    const real = elements.filter((e) => !e.containerId);
    let lx = 0;
    let ly = 0;
    if (real.length) {
      lx = Math.min(...real.map((e) => e.x));
      ly = Math.max(...real.map((e) => e.y + e.height)) + 60;
    }
    const heading = options.linkLegendHeading ?? 'Links from the board:';
    const hm = textMetrics(heading, 18);
    elements.push(textEl(seed, 'legend-hdr', heading, lx, ly, hm.width, hm.height, 18, '#44546F'));
    let cy = ly + hm.height + 12;
    linkLegend.forEach((entry, i) => {
      const line = entry.label === entry.url ? entry.label : entry.url ? `${entry.label} — ${prettyUrl(entry.url)}` : entry.label;
      const lm = textMetrics(line, 13);
      const tl = textEl(seed, `legend-${i}`, line, lx, cy, lm.width, lm.height, 13, '#0B66E4');
      tl.link = entry.url || null;
      elements.push(tl);
      cy += lm.height + 6;
    });
  }

  // Opening view: fit the whole board.
  const vis = elements.filter((e) => !e.containerId);
  let appState: Record<string, unknown>;
  if (vis.length) {
    const minx = Math.min(...vis.map((e) => e.x));
    const miny = Math.min(...vis.map((e) => e.y));
    const maxx = Math.max(...vis.map((e) => e.x + e.width));
    const maxy = Math.max(...vis.map((e) => e.y + e.height));
    const bw = maxx - minx;
    const bh = maxy - miny;
    const zoom = Math.max(0.05, Math.min(1, 1500 / Math.max(bw, 1), 850 / Math.max(bh, 1)));
    appState = { viewBackgroundColor: '#ffffff', gridSize: null, scrollX: -minx + 40, scrollY: -miny + 40, zoom: { value: round3(zoom) } };
  } else {
    appState = { viewBackgroundColor: '#ffffff', gridSize: null };
  }

  if (unknownStamps.size) {
    warnings.push(`unknown stampId (drawn as «${UNKNOWN_STAMP}»): ${[...unknownStamps].sort().join(', ')}`);
  }
  if (missingTokens.size) {
    warnings.push(`unknown palette tokens (a fallback color was used): ${[...missingTokens].sort().join(', ')}`);
  }
  if (droppedTypes.size) {
    const parts = [...droppedTypes.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([t, c]) => `${t} ×${c}`);
    warnings.push(`nodes that are not carried over completely: ${parts.join(', ')}`);
  }

  const scene: ExcalidrawScene = {
    type: 'excalidraw',
    version: 2,
    source: 'folio-confluence-import',
    elements,
    appState,
    files: {},
  };
  return { scene, warnings };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// SVG (visual render + the canonical embedded payload)
// ---------------------------------------------------------------------------

function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function f1(v: number): string {
  return v.toFixed(1);
}

function textSvg(e: ExcalidrawElement, dx: number, dy: number): string {
  const fs = e.fontSize ?? 14;
  const lines = str(e.text).split('\n');
  const x = e.x - dx;
  const y = e.y - dy;
  const align = e.textAlign ?? 'left';
  let tx: number;
  let anchor: string;
  if (align === 'center') {
    tx = x + e.width / 2;
    anchor = 'middle';
  } else if (align === 'right') {
    tx = x + e.width;
    anchor = 'end';
  } else {
    tx = x;
    anchor = 'start';
  }
  const linePx = fs * LINE_HEIGHT;
  // first baseline — as excalidraw does it: ascender + half the line gap
  const first = fs * ASCENT_EM + (linePx - fs * ASCENT_EM + fs * DESCENT_EM) / 2;
  const spans = lines.map((l, i) => `<tspan x="${f1(tx)}" y="${f1(y + first + i * linePx)}">${esc(l)}</tspan>`).join('');
  const deco = e.link ? ' text-decoration="underline"' : '';
  return (
    `<text font-family="Helvetica,Arial,sans-serif" font-size="${f1(fs)}" ` +
    `fill="${e.strokeColor || '#1e1e1e'}" text-anchor="${anchor}"${deco}>${spans}</text>`
  );
}

/**
 * Packs the scene the way excalidraw's own SVG export does — deflate ->
 * latin1 byte-string -> JSON wrapper -> base64 in <metadata> — which is
 * exactly what loadFromBlob reads back. This encoding is load-bearing: change
 * a step and the board opens blank in the editor.
 */
export function encodeScenePayload(scene: ExcalidrawScene): string {
  const payloadText = JSON.stringify(scene);
  const deflated = zlib.deflateSync(Buffer.from(payloadText, 'utf8'));
  const wrapper = JSON.stringify({ version: '1', encoding: 'bstring', compressed: true, encoded: deflated.toString('latin1') });
  return Buffer.from(wrapper, 'latin1').toString('base64');
}

/** Inverse of encodeScenePayload — used by the selfcheck and by the tests. */
export function decodeScenePayload(base64: string): ExcalidrawScene {
  const wrapper = JSON.parse(Buffer.from(base64, 'base64').toString('latin1')) as {
    version?: string;
    encoding?: string;
    compressed?: boolean;
    encoded?: string;
  };
  if (!wrapper.compressed || wrapper.encoding !== 'bstring') throw new Error('unexpected excalidraw payload wrapper');
  const inflated = zlib.inflateSync(Buffer.from(wrapper.encoded ?? '', 'latin1'));
  return JSON.parse(inflated.toString('utf8')) as ExcalidrawScene;
}

export function extractScenePayload(svg: string): string | null {
  const m = /<!-- payload-start -->([\s\S]+?)<!-- payload-end -->/.exec(svg);
  return m ? m[1] : null;
}

/** Renders the scene as a self-contained .excalidraw.svg (preview + payload). */
export function renderSceneSvg(scene: ExcalidrawScene): string {
  const els = scene.elements.filter((e) => !e.isDeleted);
  const byId = new Map(els.map((e) => [e.id, e]));
  const bg = (scene.appState?.viewBackgroundColor as string) || '#ffffff';
  const FRAME_NAME_GAP = 24; // a frame's label is drawn ABOVE its box
  const xs = [...els.map((e) => e.x), ...els.map((e) => e.x + e.width)];
  const ys = [...els.map((e) => (e.type === 'frame' && e.name ? e.y - FRAME_NAME_GAP : e.y)), ...els.map((e) => e.y + e.height)];
  const pad = 40;
  const minx = (xs.length ? Math.min(...xs) : 0) - pad;
  const miny = (ys.length ? Math.min(...ys) : 0) - pad;
  const w = (xs.length ? Math.max(...xs) - Math.min(...xs) : 0) + 2 * pad;
  const h = (ys.length ? Math.max(...ys) - Math.min(...ys) : 0) + 2 * pad;

  const body: string[] = [];
  for (const e of els) {
    const x = e.x - minx;
    const y = e.y - miny;
    const op = e.opacity !== 100 ? ` opacity="${(e.opacity / 100).toFixed(2)}"` : '';
    const fill = e.backgroundColor && e.backgroundColor !== 'transparent' ? e.backgroundColor : 'none';
    const stroke = e.strokeColor && e.strokeColor !== 'transparent' ? e.strokeColor : 'none';
    if (e.type === 'rectangle' || e.type === 'frame') {
      const dash = e.type === 'frame' ? ' stroke-dasharray="6 4"' : '';
      body.push(`<rect x="${f1(x)}" y="${f1(y)}" width="${f1(e.width)}" height="${f1(e.height)}" rx="6" fill="${fill}" stroke="${stroke}"${dash}${op}/>`);
      // the frame's name, where excalidraw itself draws it
      if (e.type === 'frame' && e.name) {
        body.push(
          `<text font-family="Helvetica,Arial,sans-serif" font-size="16.0" fill="#44546F" text-anchor="start">` +
            `<tspan x="${f1(x)}" y="${f1(y - 8)}">${esc(e.name)}</tspan></text>`,
        );
      }
    } else if (e.type === 'ellipse') {
      body.push(
        `<ellipse cx="${f1(x + e.width / 2)}" cy="${f1(y + e.height / 2)}" rx="${f1(e.width / 2)}" ry="${f1(e.height / 2)}" fill="${fill}" stroke="${stroke}"${op}/>`,
      );
    } else if (e.type === 'diamond') {
      const pts = `${f1(x + e.width / 2)},${f1(y)} ${f1(x + e.width)},${f1(y + e.height / 2)} ${f1(x + e.width / 2)},${f1(y + e.height)} ${f1(x)},${f1(y + e.height / 2)}`;
      body.push(`<polygon points="${pts}" fill="${fill}" stroke="${stroke}"${op}/>`);
    } else if (e.type === 'arrow') {
      const pts = (e.points ?? []).map((p) => `${f1(x + p[0])},${f1(y + p[1])}`).join(' ');
      let marker = e.endArrowhead ? ' marker-end="url(#arr)"' : '';
      if (e.startArrowhead) marker += ' marker-start="url(#arr-start)"';
      body.push(`<polyline points="${pts}" fill="none" stroke="${e.strokeColor || '#495057'}" stroke-width="${e.strokeWidth}"${marker}/>`);
    } else if (e.type === 'text') {
      const holder = e.containerId ? byId.get(e.containerId) : undefined;
      if (holder && holder.type === 'arrow') {
        // excalidraw breaks the line under a label — mirror that with a patch of background
        body.push(`<rect x="${f1(x - 4)}" y="${f1(y - 2)}" width="${f1(e.width + 8)}" height="${f1(e.height + 4)}" fill="${bg}"/>`);
      }
      body.push(textSvg(e, minx, miny));
    }
  }

  const b64 = encodeScenePayload(scene);
  return (
    `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(0)} ${h.toFixed(0)}" width="${w.toFixed(0)}" height="${h.toFixed(0)}">` +
    `<!-- svg-source:excalidraw --><metadata><!-- payload-type:application/vnd.excalidraw+json -->` +
    `<!-- payload-version:2 --><!-- payload-start -->${b64}<!-- payload-end --></metadata>` +
    `<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
    `<path d="M 0 0 L 10 5 L 0 10 z" fill="#495057"/></marker>` +
    `<marker id="arr-start" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">` +
    `<path d="M 0 0 L 10 5 L 0 10 z" fill="#495057"/></marker></defs>` +
    `<rect x="0" y="0" width="${w.toFixed(0)}" height="${h.toFixed(0)}" fill="#ffffff"/>` +
    body.join('') +
    `</svg>`
  );
}

/**
 * The prototype's own assert pass, kept as a runtime guard (it runs on every
 * imported board, not just in tests): every boundElements/containerId/
 * start-endBinding reference must resolve, and bound text must actually fit
 * its container — otherwise excalidraw clips it on open. Returns the element
 * count. Throws on a violation.
 */
export function selfcheckWhiteboardSvg(svg: string): number {
  const payload = extractScenePayload(svg);
  if (!payload) throw new Error('whiteboard selfcheck: no embedded excalidraw payload');
  const scene = decodeScenePayload(payload);
  const byId = new Map(scene.elements.map((e) => [e.id, e]));
  for (const e of scene.elements) {
    for (const b of e.boundElements ?? []) {
      if (!byId.has(b.id)) throw new Error(`whiteboard selfcheck: dangling boundElement ${b.id} on ${e.id}`);
    }
    if (e.containerId) {
      const c = byId.get(e.containerId);
      if (!c) throw new Error(`whiteboard selfcheck: dangling containerId ${e.containerId} on ${e.id}`);
      if (c.type !== 'arrow') {
        if (e.width > boundTextMaxWidth(c) + 1) throw new Error(`whiteboard selfcheck: bound text overflows ${c.id}`);
        if (e.height > boundTextMaxHeight(c) + 1) throw new Error(`whiteboard selfcheck: bound text too tall in ${c.id}`);
      }
    }
    for (const k of ['startBinding', 'endBinding'] as const) {
      const b = e[k];
      if (b && !byId.has(b.elementId)) throw new Error(`whiteboard selfcheck: dangling ${k} ${b.elementId} on ${e.id}`);
      // an elbow arrow whose binding has no fixedPoint loses that binding in
      // excalidraw's own restore() — catch it here instead of on the board
      if (b && e.elbowed && !b.fixedPoint) throw new Error(`whiteboard selfcheck: elbow arrow ${e.id} has a ${k} with no fixedPoint`);
    }
    if (e.frameId) {
      const f = byId.get(e.frameId);
      if (!f) throw new Error(`whiteboard selfcheck: dangling frameId ${e.frameId} on ${e.id}`);
      if (f.type !== 'frame') throw new Error(`whiteboard selfcheck: frameId ${e.frameId} on ${e.id} is not a frame`);
      // a frame CLIPS its members: anything sticking out would be cut in half
      if (e.x < f.x - 0.5 || e.y < f.y - 0.5 || e.x + e.width > f.x + f.width + 0.5 || e.y + e.height > f.y + f.height + 0.5) {
        throw new Error(`whiteboard selfcheck: ${e.id} does not fit inside its frame ${f.id}`);
      }
    }
  }
  return scene.elements.length;
}

export interface WhiteboardSvgResult {
  svg: string;
  warnings: string[];
  elementCount: number;
}

/**
 * The whole pure pipeline: WHITEBOARD_DOC_FORMAT -> .excalidraw.svg string,
 * selfchecked. No network, no filesystem — this is the function the tests
 * exercise and the one the import job calls once it has the document.
 */
export function whiteboardDocumentToSvg(doc: unknown, options: WhiteboardConvertOptions = {}): WhiteboardSvgResult {
  const { scene, warnings } = convertWhiteboardDocument(doc, options);
  const svg = renderSceneSvg(scene);
  const elementCount = selfcheckWhiteboardSvg(svg);
  return { svg, warnings, elementCount };
}

// ---------------------------------------------------------------------------
// URL detection (Cloud only) + the Cloud fetch
// ---------------------------------------------------------------------------

const ATLASSIAN_CLOUD_SUFFIX = '.atlassian.net';
const WHITEBOARD_PATH_RE = /\/whiteboard\/(\d+)(?:[/?#]|$)/;
/**
 * A loopback host is the one non-Cloud host this module will talk to: it is
 * the address of the machine the server is already running on, so neither of
 * the guard's two jobs applies (a token cannot leave the box, and it is not
 * somebody's on-prem Confluence being told about whiteboards it doesn't
 * have). This is what lets the importer's own end-to-end tests drive the real
 * network path against a local mock server — exactly how the PAGE importer's
 * happy-path test already works, since parseConfluenceUrl has no host
 * restriction at all.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface WhiteboardTarget {
  /** https://<host> — no path; both /wiki/... and /gateway/... hang off it. */
  siteBase: string;
  hostname: string;
  whiteboardId: string;
  sourceUrl: string;
}

/**
 * Is this URL a whiteboard link at all? Deliberately host-agnostic (a
 * wiki.example.org/wiki/.../whiteboard/1 URL answers true) so the
 * caller can tell "not a whiteboard, run the normal page import" apart from
 * "a whiteboard we cannot serve", which deserves a real error rather than a
 * silent fallback to the page importer (which would 404 on the id).
 */
export function looksLikeWhiteboardUrl(pageUrl: string): boolean {
  return WHITEBOARD_PATH_RE.test(pageUrl);
}

/**
 * Whiteboards are a Confluence CLOUD-only feature: there is no
 * WHITEBOARD_DOC_FORMAT (and no GraphQL gateway) on Server/Data Center, so an
 * on-prem whiteboard URL can only ever fail — it gets a clear message here
 * instead of an opaque 404 from a REST call that was never going to work.
 * Restricting to *.atlassian.net also keeps a Cloud API token from being sent
 * to a third-party host that merely mimics the URL shape.
 */
export function parseWhiteboardUrl(pageUrl: string): WhiteboardTarget | null {
  const match = WHITEBOARD_PATH_RE.exec(pageUrl);
  if (!match) return null;
  let parsed: URL;
  try {
    parsed = new URL(pageUrl.includes('://') ? pageUrl : `https://${pageUrl}`);
  } catch {
    throw badRequest('this does not look like a valid Confluence whiteboard URL');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname.endsWith(ATLASSIAN_CLOUD_SUFFIX) && !LOOPBACK_HOSTS.has(hostname)) {
    throw badRequest(
      `Confluence whiteboards exist only on Confluence Cloud (*.atlassian.net); "${hostname}" is a Server/Data Center site, which has no whiteboards to import`,
    );
  }
  const siteBase = `${parsed.protocol}//${parsed.host}`;
  return { siteBase, hostname, whiteboardId: match[1], sourceUrl: pageUrl };
}

const TENANT_QUERY = `query TenantContext($hostNames: [String!]!) {
  tenantContexts(hostNames: $hostNames) { cloudId }
}`;

const WHITEBOARD_QUERY = `query GetWhiteboardContent($id: ID!) {
  confluence {
    whiteboard(id: $id) @optIn(to: "ConfluenceWhiteboardsRelease") {
      title
      body {
        whiteboardDocFormat {
          representation
          value
        }
      }
    }
  }
}`;

export interface WhiteboardMetadata {
  id: string;
  title: string;
  parentId?: string;
  parentType?: string;
  spaceId?: string;
  /** Sibling position among the parent's children, when Confluence reports one. */
  position?: number;
}

export interface FetchedWhiteboard {
  metadata: WhiteboardMetadata;
  /** The parsed WHITEBOARD_DOC_FORMAT document ({nodes, edges, ...}). */
  document: unknown;
}

async function jsonRequest(
  method: 'GET' | 'POST',
  url: string,
  authHeader: string,
  label: string,
  payload?: unknown,
): Promise<Json> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      redirect: 'manual', // never re-send Authorization to another host
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new Error(`${label}: network error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`${label}: unexpected HTTP redirect ${res.status} (refused, so the Authorization header is never forwarded to another host)`);
  }
  if (res.status >= 400) {
    const preview = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`${label}: HTTP ${res.status}. ${preview}`);
  }
  const parsed: unknown = await res.json().catch(() => null);
  const rec = asRecord(parsed);
  if (!rec) throw new Error(`${label}: expected a JSON object`);
  return rec;
}

function throwGraphqlErrors(payload: Json, label: string): void {
  const errors = payload.errors;
  if (!Array.isArray(errors) || errors.length === 0) return;
  const messages = errors.slice(0, 5).map((e) => str(asRecord(e)?.message ?? e));
  throw new Error(`${label}: GraphQL error: ${messages.join(' | ')}`);
}

/**
 * Fetches one Cloud whiteboard: REST v2 metadata, then the Atlassian GraphQL
 * gateway for the document itself (the doc format is NOT available over plain
 * REST). Three calls, in this order, because the gateway addresses the board
 * by ARI and the ARI needs the site's cloudId:
 *   GET  /wiki/api/v2/whiteboards/{id}            -> title/parent/space/position
 *   POST /gateway/api/graphql  tenantContexts     -> cloudId
 *   POST /gateway/api/graphql  confluence.whiteboard(ari) -> whiteboardDocFormat
 * The @optIn directive on that last query is mandatory — without it the
 * `whiteboard` field does not resolve at all.
 *
 * `authHeader` is a complete Authorization header value and is never logged
 * and never put on the job; neither is the ARI (it embeds the site's cloudId).
 */
export async function fetchWhiteboard(target: WhiteboardTarget, authHeader: string): Promise<FetchedWhiteboard> {
  const metaRaw = await jsonRequest('GET', `${target.siteBase}/wiki/api/v2/whiteboards/${target.whiteboardId}`, authHeader, 'Confluence whiteboard metadata');
  const metadata: WhiteboardMetadata = {
    id: str(metaRaw.id) || target.whiteboardId,
    title: str(metaRaw.title) || `Whiteboard ${target.whiteboardId}`,
    parentId: metaRaw.parentId === undefined || metaRaw.parentId === null ? undefined : str(metaRaw.parentId),
    parentType: metaRaw.parentType === undefined || metaRaw.parentType === null ? undefined : str(metaRaw.parentType),
    spaceId: metaRaw.spaceId === undefined || metaRaw.spaceId === null ? undefined : str(metaRaw.spaceId),
    position: typeof metaRaw.position === 'number' ? metaRaw.position : undefined,
  };

  const endpoint = `${target.siteBase}/gateway/api/graphql`;
  const tenant = await jsonRequest('POST', endpoint, authHeader, 'Confluence GraphQL tenantContexts', {
    query: TENANT_QUERY,
    variables: { hostNames: [target.hostname] },
  });
  throwGraphqlErrors(tenant, 'Confluence GraphQL tenantContexts');
  const contexts = (asRecord(tenant.data)?.tenantContexts ?? []) as unknown;
  let cloudId = '';
  if (Array.isArray(contexts)) {
    for (const item of contexts) {
      const id = str(asRecord(item)?.cloudId);
      if (id) {
        cloudId = id;
        break;
      }
    }
  }
  if (!cloudId) throw new Error('Confluence GraphQL tenantContexts returned no cloudId');

  const ari = `ari:cloud:confluence:${cloudId}:whiteboard/${target.whiteboardId}`;
  const gql = await jsonRequest('POST', endpoint, authHeader, 'Confluence GraphQL whiteboard', { query: WHITEBOARD_QUERY, variables: { id: ari } });
  throwGraphqlErrors(gql, 'Confluence GraphQL whiteboard');
  const whiteboard = asRecord(asRecord(asRecord(gql.data)?.confluence)?.whiteboard);
  if (!whiteboard) throw new Error('Confluence GraphQL returned no whiteboard (check the id and your permission to view the board)');
  const docFormat = asRecord(asRecord(whiteboard.body)?.whiteboardDocFormat);
  if (!docFormat) throw new Error('Confluence GraphQL returned no body.whiteboardDocFormat');
  if (docFormat.representation !== 'WHITEBOARD_DOC_FORMAT') {
    throw new Error(`unexpected whiteboard representation: ${str(docFormat.representation) || 'none'}`);
  }
  const rawValue = docFormat.value;
  if (typeof rawValue !== 'string' || !rawValue.trim()) throw new Error('whiteboardDocFormat.value is empty or not a JSON string');
  let document: unknown;
  try {
    document = JSON.parse(rawValue);
  } catch {
    throw new Error('whiteboardDocFormat.value is not valid JSON');
  }
  if (!asRecord(document)) throw new Error('the root of the whiteboard document format is not an object');

  const gqlTitle = str(whiteboard.title);
  if (gqlTitle && !str(metaRaw.title)) metadata.title = gqlTitle;

  return { metadata, document };
}
