/**
 * Round 23 (EXPORT), R23 addendum 3 ("do not lose the whiteboards"), follow-up
 * ("an agent needs STRUCTURE, not a heap of lines").
 *
 * THE TRAP the spec names: a `kind:'board'` page has NO markdown body — its
 * content is the `.excalidraw.svg` file. A naive subtree collation inserts an
 * empty section and loses the drawing entirely.
 *
 * For MD (and the agent's `/share/<token>.md`) the spec wants BOTH halves:
 *  (a) the picture, as an absolute URL to the `.excalidraw.svg`;
 *  (b) — "and this is the main thing for an agent" — the STRUCTURE of the embedded scene,
 *      not a flat bullet list. The owner's complaint about the original flat
 *      list ("Board text (reading order)"): an agent reading a bag of
 *      captions in y/x order cannot tell "queue" and "api gateway" are two
 *      ends of the same arrow, or that both live inside the "Backend"
 *      section. A graph can.
 *
 * SCHEMA (fixed here, mirrored by boardText.test.ts — see that file for the
 * full contract):
 *
 * ```yaml
 * frames:                  # excalidraw frames/sections, in reading order
 *   - name: Backend         # frame.name, or "Frame N" when the author left it blank
 *     nodes:
 *       - id: n1             # SHORT id minted for this export, reading order —
 *         type: rectangle    #   NOT excalidraw's own random element id, which
 *         text: api gateway  #   carries no meaning to a reader and is not
 *                             #   stable across edits anyway.
 * nodes:                    # elements that belong to no frame
 *   - id: n5
 *     type: text
 *     text: standalone note
 * edges:                    # arrows, by the short node ids above
 *   - from: n1
 *     to: n2
 *     text: "on failure"     # the arrow's own label, when it has one
 * ```
 *
 * Any of the three top-level keys is omitted entirely when it would be an
 * empty list — a board with no arrows has no `edges:` key, not `edges: []`.
 *
 * NODE SELECTION, the part that makes this a graph rather than a re-spelled
 * bullet list: a shape becomes a node when it has a label OF ITS OWN (a
 * free-floating text element) or a label BOUND to it (excalidraw writes a
 * shape's caption as a separate text element with `containerId` pointing at
 * the shape — see confluenceWhiteboard.ts's own writer for the same
 * convention), OR when at least one arrow's `startBinding`/`endBinding`
 * names it — an unlabelled box that two arrows connect is still part of the
 * diagram's shape and must resolve to something, even if that something has
 * no `text` field. A bound label's text element does NOT get its own node
 * (it folds into its container's `text`) — otherwise every shape would
 * appear twice.
 *
 * `from`/`to` are `null`, never omitted or dangling, when an arrow's binding
 * is absent or points at something that didn't qualify as a node (frame,
 * deleted element) — a reader must be able to tell "this end is unattached"
 * from "this field doesn't exist in the schema".
 *
 * The scene decodes the way excalidraw's own SVG export encodes it:
 * base64 -> JSON wrapper -> inflate -> `{elements: [...]}`. That codec already
 * exists in this codebase (server/confluenceWhiteboard.ts writes boards with
 * it), so it is REUSED here rather than respelled — with one deliberate
 * addition: `decodeScenePayload` throws on anything that isn't the
 * compressed-bstring wrapper, and an export must never fail because someone
 * pasted in an older/plain payload. Hence `decodeSceneTolerant` below, which
 * falls back to the uncompressed shape and then gives up QUIETLY: a board
 * whose scene cannot be read still exports as its picture (a) — it just
 * contributes no structure (b). An empty scene is not an error either.
 */
import * as yamlModule from 'js-yaml';
/**
 * js-yaml is a CJS package, and in ESM its named exports are determined by
 * cjs-module-lexer, whose behavior depends on the Node version. Because of
 * that `import * as yaml from 'js-yaml'` worked locally (Node 20) and gave an
 * object WITHOUT functions in the production image (Node 22) — the public
 * Markdown link to a whiteboard failed with a 500, and YAML export of tables
 * was broken the same way. Take `.default` when it is there, as
 * server/index.ts already does for
 * @fastify/* («this project has no esModuleInterop»).
 */
const yaml = (yamlModule as unknown as { default?: typeof yamlModule }).default ?? yamlModule;
import { decodeScenePayload, extractScenePayload } from '../confluenceWhiteboard.js';

/**
 * Structurally minimal, deliberately looser than
 * confluenceWhiteboard.ts's ExcalidrawElement: this module reads scenes
 * written by the real excalidraw editor (any version, any future element
 * type), not only ones this server produced.
 */
interface SceneElement {
  id?: string;
  type?: string;
  x?: number;
  y?: number;
  text?: string;
  originalText?: string;
  label?: { text?: string } | null;
  name?: string | null;
  frameId?: string | null;
  containerId?: string | null;
  startBinding?: { elementId?: string | null } | null;
  endBinding?: { elementId?: string | null } | null;
  isDeleted?: boolean;
}

interface Scene {
  elements?: SceneElement[];
}

function decodeSceneTolerant(base64: string): Scene | null {
  try {
    return decodeScenePayload(base64) as unknown as Scene;
  } catch {
    // Older/plain payloads (`compressed: false`, or a bare JSON scene) — still
    // readable, just not through the compressed-bstring path above.
    try {
      const raw = Buffer.from(base64, 'base64').toString('utf8');
      const parsed = JSON.parse(raw) as { encoded?: string; elements?: unknown };
      if (Array.isArray(parsed.elements)) return parsed as Scene;
      if (typeof parsed.encoded === 'string') return JSON.parse(parsed.encoded) as Scene;
      return null;
    } catch {
      return null;
    }
  }
}

/** The scene embedded in a `.excalidraw.svg`, or null when there is none / it is unreadable. */
export function decodeBoardScene(svg: string): Scene | null {
  const payload = extractScenePayload(svg);
  if (!payload || payload.trim().length === 0) return null;
  return decodeSceneTolerant(payload.trim());
}

function elementText(el: SceneElement): string | undefined {
  const raw = el.originalText ?? el.text ?? el.label?.text;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.replace(/\s+$/g, '').replace(/^\s+/g, '');
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Top-to-bottom, then left-to-right — the same "reading order" the flat list used to promise. */
function readingOrder(a: SceneElement, b: SceneElement): number {
  const ay = a.y ?? 0;
  const by = b.y ?? 0;
  if (ay !== by) return ay - by;
  return (a.x ?? 0) - (b.x ?? 0);
}

const FRAME_TYPES = new Set(['frame', 'magicframe']);
const ARROW_TYPE = 'arrow';

// ---------------------------------------------------------------------------
// structured extraction
// ---------------------------------------------------------------------------

export interface BoardStructureNode {
  /** Short id minted for THIS export, reading order (`n1`, `n2`, …) — see the module doc for why not excalidraw's own id. */
  id: string;
  /** excalidraw element type: rectangle, ellipse, diamond, text, image, … */
  type: string;
  /** The element's own text, or its bound label's text. Absent for an unlabelled shape kept only because an edge touches it. */
  text?: string;
}

export interface BoardStructureFrame {
  name: string;
  nodes: BoardStructureNode[];
}

export interface BoardStructureEdge {
  /** Short node id, or null when the arrow's start/end isn't bound to a qualifying element. */
  from: string | null;
  to: string | null;
  /** The arrow's own bound label (e.g. "yes"/"no" on a decision branch), when it has one. */
  text?: string;
}

export interface BoardStructure {
  frames: BoardStructureFrame[];
  /** Nodes belonging to no frame. */
  nodes: BoardStructureNode[];
  edges: BoardStructureEdge[];
}

/** The text bound to `el` (a separate text element whose `containerId` is `el.id`), or `el`'s own text for a free-floating text element. */
function labelFor(el: SceneElement, all: SceneElement[]): string | undefined {
  const own = elementText(el);
  if (own !== undefined) return own;
  if (!el.id) return undefined;
  for (const cand of all) {
    if (cand.containerId === el.id) {
      const bound = elementText(cand);
      if (bound !== undefined) return bound;
    }
  }
  return undefined;
}

/**
 * The scene as a graph: frames/sections as parent nodes, elements inside
 * them as children (with their labels), arrows as edges naming the short ids
 * of the elements they connect. See the module doc for the exact schema and
 * the node-selection rule. Returns all-empty for an empty/unreadable scene —
 * never throws.
 */
export function extractBoardStructure(svg: string): BoardStructure {
  const scene = decodeBoardScene(svg);
  const all = (scene?.elements ?? []).filter((e) => e && !e.isDeleted);
  if (all.length === 0) return { frames: [], nodes: [], edges: [] };

  const frames = all.filter((e) => FRAME_TYPES.has(e.type ?? '')).sort(readingOrder);
  const frameNameById = new Map<string, string>();
  frames.forEach((f, i) => {
    if (f.id) frameNameById.set(f.id, (f.name ?? '').trim() || `Frame ${i + 1}`);
  });

  const arrows = all.filter((e) => e.type === ARROW_TYPE);

  // A shape's own caption is written as a SEPARATE text element with
  // `containerId` pointing at the shape (see confluenceWhiteboard.ts's own
  // writer) — it folds into that shape's `text` above and must not also
  // become its own node, or every labelled shape would appear twice.
  const boundTextIds = new Set<string>();
  for (const e of all) {
    if (e.containerId && e.id) boundTextIds.add(e.id);
  }

  // An arrow endpoint must resolve to SOMETHING, even an unlabelled shape.
  const referencedByEdge = new Set<string>();
  for (const a of arrows) {
    if (a.startBinding?.elementId) referencedByEdge.add(a.startBinding.elementId);
    if (a.endBinding?.elementId) referencedByEdge.add(a.endBinding.elementId);
  }

  // Deliberately NOT gated on `e.id` existing: a free-floating text element
  // with no id (schema-legal, and how the DOCX/PDF-era test fixtures write
  // one) still deserves a node — it just cannot be an arrow endpoint, since
  // nothing could bind to an id it doesn't have.
  const candidates = all.filter((e) => {
    if (FRAME_TYPES.has(e.type ?? '')) return false;
    if (e.type === ARROW_TYPE) return false;
    if (e.id && boundTextIds.has(e.id)) return false;
    return labelFor(e, all) !== undefined || (e.id ? referencedByEdge.has(e.id) : false);
  });

  const ordered = [...candidates].sort(readingOrder);
  // Two maps, deliberately: `shortIdByNode` (keyed by element identity) is
  // what builds the node list below and works even for an id-less element;
  // `shortIdByElementId` (keyed by excalidraw's own id string) is what an
  // edge's `startBinding.elementId`/`endBinding.elementId` can look up —
  // those inherently reference ids, so an id-less element is simply never
  // reachable as an edge endpoint, which is correct (nothing could have
  // bound to it).
  const shortIdByNode = new Map<SceneElement, string>();
  const shortIdByElementId = new Map<string, string>();
  ordered.forEach((e, i) => {
    const shortId = `n${i + 1}`;
    shortIdByNode.set(e, shortId);
    if (e.id) shortIdByElementId.set(e.id, shortId);
  });

  function toNode(e: SceneElement): BoardStructureNode {
    const text = labelFor(e, all);
    return { id: shortIdByNode.get(e)!, type: e.type ?? 'unknown', ...(text !== undefined ? { text } : {}) };
  }

  const nodesByFrame = new Map<string, BoardStructureNode[]>();
  const ungrouped: BoardStructureNode[] = [];
  for (const e of ordered) {
    const node = toNode(e);
    const frameName = e.frameId ? frameNameById.get(e.frameId) : undefined;
    if (frameName) {
      if (!nodesByFrame.has(frameName)) nodesByFrame.set(frameName, []);
      nodesByFrame.get(frameName)!.push(node);
    } else {
      ungrouped.push(node);
    }
  }

  // Frame order follows the frames' OWN reading order (already sorted
  // above); a frame that ended up with zero qualifying nodes is dropped —
  // an empty section carries no structure to report.
  const frameList: BoardStructureFrame[] = [];
  for (const f of frames) {
    if (!f.id) continue;
    const name = frameNameById.get(f.id)!;
    const nodes = nodesByFrame.get(name);
    if (nodes && nodes.length > 0) frameList.push({ name, nodes });
  }

  const edges: BoardStructureEdge[] = [...arrows].sort(readingOrder).map((a) => {
    const fromId = a.startBinding?.elementId;
    const toId = a.endBinding?.elementId;
    const text = labelFor(a, all);
    return {
      from: fromId ? (shortIdByElementId.get(fromId) ?? null) : null,
      to: toId ? (shortIdByElementId.get(toId) ?? null) : null,
      ...(text !== undefined ? { text } : {}),
    };
  });

  return { frames: frameList, nodes: ungrouped, edges };
}

/**
 * `extractBoardStructure`, serialized as YAML (see the module doc for the
 * exact shape). `null` when the scene has nothing to report — the caller
 * then emits the picture alone, which is exactly what an empty board should
 * produce. Each of `frames`/`nodes`/`edges` is included only when non-empty,
 * so a board with no arrows has no `edges:` key at all rather than `edges: []`.
 */
export function boardStructureYaml(svg: string): string | null {
  const structure = extractBoardStructure(svg);
  if (structure.frames.length === 0 && structure.nodes.length === 0 && structure.edges.length === 0) return null;

  const doc: Record<string, unknown> = {};
  if (structure.frames.length > 0) doc.frames = structure.frames;
  if (structure.nodes.length > 0) doc.nodes = structure.nodes;
  if (structure.edges.length > 0) doc.edges = structure.edges;

  // No line-wrapping (long labels must round-trip on one scalar), insertion
  // order kept (frames before nodes before edges — reading order top to
  // bottom, not alphabetical).
  return yaml.dump(doc, { lineWidth: -1, sortKeys: false, noRefs: true }).trimEnd();
}
