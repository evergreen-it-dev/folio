/**
 * Round 24 tests. The converter is a pure function, so the bulk of this file
 * runs offline against a SYNTHETIC whiteboard document written here — one
 * that deliberately contains every node type the prototype handles
 * (sticky / shape / text / connector+association / pathLabel / section /
 * smartLink / stamp), plus the two shapes that caused real bugs: a section
 * with ZEROED `geometry` whose real box lives in `legacyGeometry`, and a
 * connector whose endpoints must be recomputed from its anchors rather than
 * taken from the stale start/end in the export.
 *
 * No real board data lives in this repo: the real exports are not published
 * company content. The port itself was validated against them out-of-tree
 * (the produced scene is element-for-element identical to the Python
 * prototype's, same order, same appState) — what is pinned HERE is behaviour,
 * not one company's board.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as authStore from './auth/store.js';
import {
  adfText,
  anchorSide,
  boundTextMaxHeight,
  boundTextMaxWidth,
  convertWhiteboardDocument,
  elbowRoute,
  elbowRouteVia,
  decodeScenePayload,
  extractScenePayload,
  fetchWhiteboard,
  looksLikeWhiteboardUrl,
  parseWhiteboardUrl,
  selfcheckWhiteboardSvg,
  textMetrics,
  whiteboardDocumentToSvg,
  wrapText,
  type ExcalidrawElement,
  type ExcalidrawScene,
} from './confluenceWhiteboard.js';
import { getJob, resolveImportTarget, resolveOrCreateTargetSpace, startImportJob } from './confluenceImport.js';

/** Confluence stores node text as an embedded ADF document, JSON-encoded. */
function adf(...paragraphs: string[]): string {
  return JSON.stringify({
    version: 1,
    type: 'doc',
    content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
  });
}

const LONG_STICKY_TEXT = 'A sticky note with a fairly long text that surely does not fit one line';

/**
 * The synthetic board.
 *
 * EVERY `position` here is the node's CENTRE, because that is what
 * WHITEBOARD_DOC_FORMAT stores — see the geom() comment in the module and the
 * three independent proofs behind it. The comment blocks below give each
 * node's resulting top-left so the expectations stay readable.
 *
 * `sec-1` also carries the attachment edges that pin the relation down:
 * `child.position === host.position - host.size/2 + offset`. `sec-2` carries
 * NONE, deliberately — a section with no attachments used to be read a
 * completely different way from one with them, which is how a real board ended
 * up with two coordinate systems on the same canvas.
 */
function makeDoc(): unknown {
  return {
    version: 1,
    type: 'whiteboard',
    nodes: {
      'sec-1': {
        id: 'sec-1',
        type: 'section',
        zIndex: 0,
        title: 'Zone A',
        // The shape that broke the naive reader: geometry present but zeroed,
        // the only real size in legacyGeometry. centre (200,150) -> top-left (0,0)
        geometry: { position: { x: 0, y: 0 }, size: { x: 0, y: 0 } },
        legacyGeometry: { position: { x: 200, y: 150 }, size: { x: 400, y: 300 } },
        color: 'palette.light.blue.200',
      },
      'sec-2': {
        id: 'sec-2',
        type: 'section',
        zIndex: 0,
        title: 'Zone B',
        // No attachment edges at all. centre (1000,1000) -> top-left (900,950).
        legacyGeometry: { position: { x: 1000, y: 1000 }, size: { x: 200, y: 100 } },
        color: 'palette.light.gray.100',
      },
      'sticky-1': {
        id: 'sticky-1',
        type: 'sticky',
        zIndex: 1,
        geometry: { position: { x: 100, y: 100 }, size: { x: 160, y: 120 } }, // -> (20,40)
        text: adf(LONG_STICKY_TEXT),
        color: 'palette.light.yellow.300',
        fontScale: 1,
      },
      'shape-rect': {
        id: 'shape-rect',
        type: 'shape',
        zIndex: 2,
        geometry: { position: { x: 180, y: 110 }, size: { x: 240, y: 60 } }, // -> (60,80)
        text: adf('Rectangle'),
        shape: 'rectangle',
        fillEnabled: true,
        color: 'palette.light.yellow.300',
        strokeColor: 'palette.dark.gray.200',
        fontScale: 1,
        alignment: 'center',
        verticalAlignment: 'middle',
      },
      'shape-ellipse': {
        id: 'shape-ellipse',
        type: 'shape',
        zIndex: 3,
        geometry: { position: { x: 600, y: 140 }, size: { x: 200, y: 120 } }, // -> (500,80)
        text: adf('Oval'),
        shape: 'ellipse',
        fillEnabled: true,
        color: 'palette.light.green.200',
        fontScale: 1,
      },
      'shape-diamond': {
        id: 'shape-diamond',
        type: 'shape',
        zIndex: 4,
        geometry: { position: { x: 610, y: 380 }, size: { x: 220, y: 160 } }, // -> (500,300)
        text: adf('Decision?'),
        shape: 'diamond',
        fillEnabled: false,
        fontScale: 1,
      },
      'text-fixed': {
        id: 'text-fixed',
        type: 'text',
        zIndex: 5,
        geometry: { position: { x: 120, y: 420 }, size: { x: 200, y: 40 } }, // -> (20,400)
        text: adf('A heading with a fixed width that wraps around'),
        color: 'palette.dark.gray.300',
        fontScale: 1.5,
        alignment: 'left',
        allowFlexibleWidth: false,
      },
      'text-flex': {
        id: 'text-flex',
        type: 'text',
        zIndex: 6,
        // allowFlexibleWidth -> `geometry` is the 34px stub; the real laid-out
        // box is the one in legacyGeometry. centre (260,150.5) -> top-left (100,120)
        geometry: { position: { x: 117, y: 137 }, size: { x: 34, y: 34 } },
        legacyGeometry: { position: { x: 260, y: 150.5 }, size: { x: 320, y: 61 } },
        text: adf('Flexible text'),
        color: 'palette.dark.gray.300',
        fontScale: 1,
        allowFlexibleWidth: true,
      },
      'conn-1': {
        id: 'conn-1',
        type: 'connector',
        zIndex: 7,
        // Stale start/end on purpose: an associated connector must ignore
        // these and recompute from the anchors + the FINAL shape geometry.
        start: { x: -5000, y: -5000 },
        end: { x: -4000, y: -4000 },
        sourceAnchor: { left: 1, top: 0.5 },
        targetAnchor: { left: 0, top: 0.5 },
        presentation: 'dynamic',
        startCap: 'none',
        endCap: 'arrow',
        color: 'palette.dark.gray.200',
        stroke: 'medium',
        strokeStyle: 'dashed',
      },
      'conn-1-waypoint-1': {
        id: 'conn-1-waypoint-1',
        type: 'pathWaypoint',
        zIndex: 8,
        order: 1,
        // a 1x1..6x6 marker; its CENTRE is the point routed through
        geometry: { position: { x: 420, y: 30 }, size: { x: 6, y: 6 } },
      },
      // How the REAL export ships a waypoint: no '-waypoint' suffix, bound to
      // its connector by an attachment edge instead.
      'path-waypoint-conn-3-abc': {
        id: 'path-waypoint-conn-3-abc',
        type: 'pathWaypoint',
        zIndex: 8,
        order: 1000446,
        legacyGeometry: { position: { x: 250, y: 900 }, size: { x: 1, y: 1 } },
      },
      'conn-1-path-label': {
        id: 'conn-1-path-label',
        type: 'pathLabel',
        zIndex: 9,
        text: adf('leads to'),
        color: 'palette.dark.gray.300',
        fontScale: 1,
      },
      // A second connector with NO association: raw start/end are used as-is,
      // and its label is bound through an explicit attachment edge rather
      // than the '-path-label' naming convention.
      'conn-2': {
        id: 'conn-2',
        type: 'connector',
        zIndex: 10,
        start: { x: 100, y: 600 },
        end: { x: 400, y: 700 },
        startCap: 'arrow',
        endCap: 'arrow',
        stroke: 'small',
      },
      'label-for-conn-2': {
        id: 'label-for-conn-2',
        type: 'pathLabel',
        zIndex: 11,
        text: adf('via edge'),
        fontScale: 1,
      },
      // Round 24b point 4: dynamic == an ELBOW connector. No waypoints, so the
      // route is ours to compute: right edge of shape-rect -> top edge of
      // shape-diamond.
      'conn-elbow': {
        id: 'conn-elbow',
        type: 'connector',
        zIndex: 10,
        start: { x: 0, y: 0 },
        end: { x: 0, y: 0 },
        sourceAnchor: { left: 1, top: 0.5 },
        targetAnchor: { left: 0.5, top: 0 },
        presentation: 'dynamic',
        endCap: 'arrow',
      },
      // A dynamic connector whose waypoint arrives the way the real export
      // ships one (attachment edge, `path-waypoint-…` id).
      'conn-3': {
        id: 'conn-3',
        type: 'connector',
        zIndex: 10,
        start: { x: 100, y: 800 },
        end: { x: 400, y: 1000 },
        presentation: 'dynamic',
        endCap: 'arrow',
      },
      // `path`: the same geometry as a connector, minus the association. Used
      // to be dropped on the floor without a word.
      'path-1': {
        id: 'path-1',
        type: 'path',
        zIndex: 11,
        start: { x: -100, y: -100 },
        end: { x: 300, y: -100 },
        presentation: 'straight',
        startCap: 'none',
        endCap: 'arrow',
        color: 'palette.dark.gray.200',
        stroke: 'small',
        strokeStyle: 'solid',
      },
      // An image needs a Media API round trip we cannot make offline; a sticker
      // is a Confluence-hosted asset. Both used to disappear silently.
      'img-1': {
        id: 'img-1',
        type: 'image',
        zIndex: 12,
        legacyGeometry: { position: { x: 1500, y: 300 }, size: { x: 400, y: 200 } }, // -> (1300,200)
        fileId: '163fa55b-7c0a-45b8-85fe-c3d3166f0684',
        mimeType: 'image/png',
      },
      'sticker-1': {
        id: 'sticker-1',
        type: 'sticker',
        zIndex: 12,
        legacyGeometry: { position: { x: 1500, y: 600 }, size: { x: 85, y: 85 } },
        stickerId: 'Race-Car',
      },
      // A sticky whose text cannot possibly fit: Confluence shrinks the writing
      // and keeps the 144x144 tile, it does not grow the tile.
      'sticky-crowded': {
        id: 'sticky-crowded',
        type: 'sticky',
        zIndex: 1,
        geometry: { position: { x: 1000, y: 1500 }, size: { x: 144, y: 144 } },
        text: adf(`${LONG_STICKY_TEXT} ${LONG_STICKY_TEXT} ${LONG_STICKY_TEXT}`),
        color: 'palette.light.gray.100',
        fontScale: 1,
      },
      // Lists and an inline link — the ADF shapes that used to be flattened
      // into markerless, double-spaced prose with the URL thrown away.
      'sticky-list': {
        id: 'sticky-list',
        type: 'sticky',
        zIndex: 1,
        geometry: { position: { x: 1400, y: 1500 }, size: { x: 240, y: 144 } },
        text: JSON.stringify({
          version: 1,
          type: 'doc',
          content: [
            {
              type: 'orderedList',
              attrs: { order: 1 },
              content: [
                { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] },
                { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }] },
              ],
            },
            {
              type: 'bulletList',
              content: [
                {
                  type: 'listItem',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'report', marks: [{ type: 'link', attrs: { href: 'https://docs.example.com/report' } }] }],
                    },
                  ],
                },
              ],
            },
          ],
        }),
        fontScale: 1,
      },
      'sl-1': {
        id: 'sl-1',
        type: 'smartLink',
        zIndex: 12,
        geometry: { position: { x: 830, y: 530 }, size: { x: 260, y: 60 } }, // -> (700,500)
        url: 'https://example.atlassian.net/wiki/spaces/DOCS/pages/777/Target',
        fontScale: 1,
      },
      'sl-2': {
        id: 'sl-2',
        type: 'smartLink',
        zIndex: 13,
        // No geometry at all -> goes into the "links from the board" column.
        url: 'https://example.atlassian.net/wiki/spaces/DOCS/pages/888/Other',
        text: adf('Another page'),
      },
      'stamp-1': {
        id: 'stamp-1',
        type: 'stamp',
        zIndex: 14,
        geometry: { position: { x: 324, y: 524 }, size: { x: 48, y: 48 } }, // -> (300,500)
        stampId: 'rocket',
      },
      'stamp-2': {
        id: 'stamp-2',
        type: 'stamp',
        zIndex: 15,
        geometry: { position: { x: 384, y: 524 }, size: { x: 48, y: 48 } },
        stampId: 'unicorn-xyz',
      },
      'comment-1': {
        id: 'comment-1',
        type: 'comment',
        zIndex: 16,
        geometry: { position: { x: 950, y: 950 }, size: { x: 100, y: 100 } },
        text: adf('a comment is not carried over'),
      },
    },
    edges: {
      'e-assoc-1': { id: 'e-assoc-1', type: 'association', sourceNode: 'shape-rect', targetNode: 'shape-ellipse' },
      // The association edge's id IS the connector node's id -- that is how the
      // export binds a connector to the pair it joins.
      'conn-1': { id: 'conn-1', type: 'association', sourceNode: 'shape-rect', targetNode: 'shape-ellipse' },
      'conn-elbow': { id: 'conn-elbow', type: 'association', sourceNode: 'shape-rect', targetNode: 'shape-diamond' },
      /**
       * THE relation that fixes the coordinate system, verbatim from the
       * export: `child.position === host.position - host.size/2 + offset`.
       * sec-1's centre is (200,150) and its size 400x300, so its top-left is
       * (0,0) and `offset` is measured from there:
       *   sticky-1   centre (100,100)   = (0,0) + (100,100)
       *   shape-rect centre (180,110)   = (0,0) + (180,110)
       *   text-flex  centre (260,150.5) = (0,0) + (260,150.5)
       * The previous fixture asserted the opposite ("offset is the child's
       * position relative to the section"), which is why the test stayed green
       * while every board came out shifted by half its own size.
       */
      'sticky-1': { id: 'sticky-1', type: 'attachment', source: 'sec-1', offset: { x: 100, y: 100 } },
      'shape-rect': { id: 'shape-rect', type: 'attachment', source: 'sec-1', offset: { x: 180, y: 110 } },
      'text-flex': { id: 'text-flex', type: 'attachment', source: 'sec-1', offset: { x: 260, y: 150.5 } },
      'label-for-conn-2': { id: 'label-for-conn-2', type: 'attachment', source: 'conn-2' },
      'path-waypoint-conn-3-abc': { id: 'path-waypoint-conn-3-abc', type: 'attachment', source: 'conn-3' },
    },
  };
}

/** `child.position === host.position - host.size/2 + offset`, the export's own rule. */
function expectedChildTopLeft(
  host: { position: { x: number; y: number }; size: { x: number; y: number } },
  offset: { x: number; y: number },
  childSize: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: host.position.x - host.size.x / 2 + offset.x - childSize.x / 2,
    y: host.position.y - host.size.y / 2 + offset.y - childSize.y / 2,
  };
}

function byId(scene: ExcalidrawScene): Map<string, ExcalidrawElement> {
  return new Map(scene.elements.map((e) => [e.id, e]));
}

describe('confluenceWhiteboard.ts: the pure converter (no network, synthetic fixtures)', () => {
  const { scene, warnings } = convertWhiteboardDocument(makeDoc());
  const els = byId(scene);

  it('emits one excalidraw element per convertible node and skips the ones with no visual form', () => {
    for (const id of [
      'sec-1', 'sec-2', 'sticky-1', 'shape-rect', 'shape-ellipse', 'shape-diamond', 'text-fixed', 'text-flex',
      'conn-1', 'conn-2', 'conn-3', 'conn-elbow', 'path-1', 'img-1', 'sticker-1', 'sl-1', 'stamp-1', 'stamp-2',
    ]) {
      expect(els.has(id), `expected element ${id}`).toBe(true);
    }
    // Only three types legitimately produce nothing: a comment is a discussion
    // thread, and waypoints/pathLabels are folded into their connector.
    expect(els.has('comment-1')).toBe(false);
    expect(els.has('conn-1-waypoint-1')).toBe(false);
    expect(els.has('path-waypoint-conn-3-abc')).toBe(false);
  });

  it('never drops a node type in silence — image/sticker hold their space and say so', () => {
    // The regression this exists for: 27 nodes across the owner's five boards
    // vanished with `warnings: []`, so nobody learned a picture had gone.
    const img = els.get('img-1')!;
    expect(img.type).toBe('rectangle');
    expect(img.strokeStyle).toBe('dashed'); // reads as a placeholder, not as content
    expect({ x: img.x, y: img.y, w: img.width, h: img.height }).toEqual({ x: 1300, y: 200, w: 400, h: 200 });
    expect(els.get(`t-img-1`)!.originalText).toContain('image/png');
    expect(els.get(`t-sticker-1`)!.originalText).toContain('Race-Car');
    expect(warnings.join(' ')).toContain('image ×1');
    expect(warnings.join(' ')).toContain('sticker ×1');
  });

  it('draws an unknown stampId as a neutral placeholder AND warns, rather than losing the reaction', () => {
    expect(warnings.join(' ')).toContain('unicorn-xyz');
    expect(els.get('stamp-2')!.text).toBe('⬤');
    // the ids the owner's boards actually use, all of which used to be dropped
    const known = convertWhiteboardDocument({
      nodes: ['100', 'megaphone', 'ok-face', 'question-mark', 'shocked', 'artist', 'spicy', 'success', 'error'].map((sid, i) => ({
        id: `s${i}`, type: 'stamp', stampId: sid, geometry: { position: { x: i * 60, y: 0 }, size: { x: 48, y: 48 } },
      })),
      edges: [],
    });
    expect(known.warnings).toEqual([]);
    expect(known.scene.elements.map((e) => e.text)).toEqual(['💯', '📣', '🙂', '❓', '😱', '🎨', '🌶️', '✅', '❌']);
  });

  it('warns when a palette token is unknown instead of silently painting the wrong colour', () => {
    // palette.light.gray.100 (a GRAY sticky) used to come out bright yellow.
    expect(els.get('sticky-crowded')!.backgroundColor).toBe('#F1F2F4');
    const miss = convertWhiteboardDocument({
      nodes: [{ id: 'x', type: 'sticky', color: 'palette.light.chartreuse.999', geometry: { position: { x: 0, y: 0 }, size: { x: 100, y: 100 } } }],
      edges: [],
    });
    expect(miss.warnings.join(' ')).toContain('palette.light.chartreuse.999');
  });

  describe('`position` is the element CENTRE, not its top-left corner', () => {
    /**
     * The bug behind every "the import is offset" complaint. Reading `position`
     * as a top-left shifts each element by (+w/2, +h/2): stickies are all the
     * same size so they stayed consistent WITH EACH OTHER, while sections,
     * headings and stamps drifted relative to them.
     */
    it('shifts every box by (-w/2,-h/2): a 160x120 sticky centred at (100,100) starts at (20,40)', () => {
      const sticky = els.get('sticky-1')!;
      expect({ x: sticky.x, y: sticky.y }).toEqual({ x: 20, y: 40 });
      expect({ w: sticky.width, h: sticky.height }).toEqual({ w: 160, h: 120 });
      // a 48x48 stamp centred at (324,524)
      expect(els.get('stamp-1')!.x + els.get('stamp-1')!.width / 2).toBeCloseTo(324, 3);
    });

    it('honours the export\'s own rule: child.position = host.position - host.size/2 + offset', () => {
      const host = { position: { x: 200, y: 150 }, size: { x: 400, y: 300 } }; // sec-1
      expect({ x: els.get('sticky-1')!.x, y: els.get('sticky-1')!.y })
        .toEqual(expectedChildTopLeft(host, { x: 100, y: 100 }, { x: 160, y: 120 }));
      expect({ x: els.get('shape-rect')!.x, y: els.get('shape-rect')!.y })
        .toEqual(expectedChildTopLeft(host, { x: 180, y: 110 }, { x: 240, y: 60 }));
      expect({ x: els.get('text-flex')!.x, y: els.get('text-flex')!.y })
        .toEqual(expectedChildTopLeft(host, { x: 260, y: 150.5 }, { x: 320, y: 61 }));
    });

    it('reads a section with NO attachment children exactly the same way', () => {
      // The old attachment-offset median only fired for sections that happened
      // to have children, so one real board carried two coordinate systems at
      // once. centre (1000,1000), size 200x100 -> top-left (900,950).
      const sec2 = els.get('sec-2')!;
      expect({ x: sec2.x, y: sec2.y, w: sec2.width, h: sec2.height }).toEqual({ x: 900, y: 950, w: 200, h: 100 });
    });

    it('puts the section under its own content, which is what "offset" was always describing', () => {
      const sec = els.get('sec-1')!;
      for (const id of ['sticky-1', 'shape-rect', 'text-flex']) {
        const child = els.get(id)!;
        const cx = child.x + child.width / 2;
        const cy = child.y + child.height / 2;
        expect(cx >= sec.x && cx <= sec.x + sec.width, `${id} centre x inside sec-1`).toBe(true);
        expect(cy >= sec.y && cy <= sec.y + sec.height, `${id} centre y inside sec-1`).toBe(true);
      }
    });
  });

  describe('section: an excalidraw FRAME, not a decorative rectangle', () => {
    it('uses legacyGeometry for the box when `geometry` is a zeroed stub', () => {
      const sec = els.get('sec-1')!;
      expect({ x: sec.x, y: sec.y }).toEqual({ x: 0, y: 0 }); // centre (200,150) - size/2
      expect({ w: sec.width, h: sec.height }).toEqual({ w: 400, h: 300 });
      expect(sec.opacity).toBe(45); // tinted panel, so content stays readable on top
    });

    it('is a frame carrying the section title as its name', () => {
      const sec = els.get('sec-1')!;
      expect(sec.type).toBe('frame');
      expect(sec.name).toBe('Zone A');
      expect(sec.roundness).toBeNull(); // frames are never rounded
      expect(els.get('sec-2')!.name).toBe('Zone B');
      // and the preview draws that name, since our .excalidraw.svg is what
      // actually lands in the repo
      expect(whiteboardDocumentToSvg(makeDoc()).svg).toContain('Zone A');
    });

    it('leaves an untitled section unlabelled instead of captioning it "Frame"', () => {
      // excalidraw's getFrameLikeTitle turns a null name into the literal word
      // "Frame". Most real sections carry no title of their own (their column
      // headings are separate text nodes), so null produced a board covered in
      // captions saying "Frame" that the source never had. '' renders nothing.
      const doc = makeDoc() as { nodes: Record<string, { title?: unknown }> };
      delete doc.nodes['sec-1'].title;
      const frame = byId(convertWhiteboardDocument(doc).scene).get('sec-1')!;
      expect(frame.type).toBe('frame');
      expect(frame.name).toBe('');
      expect(frame.name).not.toBeNull(); // null is what excalidraw renders as "Frame"
      expect(whiteboardDocumentToSvg(doc).svg).not.toContain('>Frame<');
    });

    it('adopts the elements that sit INSIDE it, so the whole column moves as one', () => {
      // The complaint this answers: frameId and groupIds were empty on every
      // board, so a retro column was only a picture of a column.
      for (const id of ['sticky-1', 'shape-rect', 'text-flex']) {
        expect(els.get(id)!.frameId, `${id} should belong to sec-1`).toBe('sec-1');
      }
      expect(els.get('t-sticky-1')!.frameId).toBe('sec-1'); // bound text follows its container
      expect(els.get('shape-ellipse')!.frameId).toBeNull(); // sits outside the section
      expect(els.get('sec-1')!.frameId).toBeNull(); // a frame never joins a frame
    });

    it('never adopts an element that would be clipped by the frame edge', () => {
      // excalidraw clips frame members; half a sticky is worse than a loose one.
      const straddling = convertWhiteboardDocument({
        nodes: {
          f: { id: 'f', type: 'section', legacyGeometry: { position: { x: 100, y: 100 }, size: { x: 200, y: 200 } } },
          inside: { id: 'inside', type: 'sticky', geometry: { position: { x: 100, y: 100 }, size: { x: 50, y: 50 } } },
          over: { id: 'over', type: 'sticky', geometry: { position: { x: 200, y: 100 }, size: { x: 50, y: 50 } } },
        },
        edges: {},
      });
      const map = byId(straddling.scene);
      expect(map.get('inside')!.frameId).toBe('f');
      expect(map.get('over')!.frameId).toBeNull(); // crosses the right edge
    });

    it('places the section before any content element so it never covers the board', () => {
      const ids = scene.elements.map((e) => e.id);
      expect(ids.indexOf('sec-1')).toBeLessThan(ids.indexOf('sticky-1'));
    });
  });

  describe('sticky / shape text: laid out HERE, because loadFromBlob restores with refreshDimensions:false', () => {
    it('wraps a long sticky label onto several lines and binds it to the sticky', () => {
      const sticky = els.get('sticky-1')!;
      const label = els.get('t-sticky-1')!;
      expect(sticky.type).toBe('rectangle');
      expect(sticky.backgroundColor).toBe('#F8E6A0'); // palette.light.yellow.300 -> hex
      expect(label.containerId).toBe('sticky-1');
      expect(sticky.boundElements).toEqual([{ id: 't-sticky-1', type: 'text' }]);
      // THE regression this whole layout pass exists to prevent: one long ribbon.
      expect(label.text!.split('\n').length).toBeGreaterThan(1);
      expect(label.originalText).toBe(LONG_STICKY_TEXT); // unwrapped source kept for re-editing
    });

    it('keeps every bound label inside its container (what excalidraw would otherwise clip)', () => {
      for (const el of scene.elements) {
        if (!el.containerId) continue;
        const container = els.get(el.containerId)!;
        if (container.type === 'arrow') continue;
        expect(el.width, `${el.id} width in ${container.id}`).toBeLessThanOrEqual(boundTextMaxWidth(container) + 1);
        expect(el.height, `${el.id} height in ${container.id}`).toBeLessThanOrEqual(boundTextMaxHeight(container) + 1);
      }
    });

    it('grows a SHAPE under its text rather than letting the text spill, keeping the anchor centre put', () => {
      const rect = els.get('shape-rect')!;
      // 240x60 in the source; the label fits, so the height is untouched here...
      expect(rect.width).toBe(240);
      // ...but the growth path is symmetric about the centre wherever it fires:
      // the centre of a grown shape stays exactly where the source put it.
      const grown = convertWhiteboardDocument({
        nodes: {
          tiny: {
            id: 'tiny',
            type: 'shape',
            shape: 'rectangle',
            geometry: { position: { x: 0, y: 100 }, size: { x: 120, y: 24 } },
            text: adf('A very long caption that in no way fits into a tiny shape twenty-four pixels high'),
            fontScale: 1,
          },
        },
        edges: {},
      });
      const g = byId(grown.scene).get('tiny')!;
      expect(g.height).toBeGreaterThan(24);
      expect(g.y + g.height / 2).toBeCloseTo(100, 6);
    });

    it('a STICKY shrinks its font instead of growing: the tile is a fixed cell in a hand-laid grid', () => {
      // 37 of 284 real stickies used to grow (worst 144 -> 405 px, +181%) and
      // land on top of their neighbours. Confluence keeps every sticky 144x144.
      const sticky = els.get('sticky-crowded')!;
      const label = els.get('t-sticky-crowded')!;
      expect({ w: sticky.width, h: sticky.height }).toEqual({ w: 144, h: 144 });
      expect(sticky.y).toBe(1500 - 72); // and it did not drift upward either
      expect(label.fontSize!).toBeLessThan(15.8); // the writing shrank instead
      expect(label.fontSize!).toBeGreaterThanOrEqual(7);
      expect(label.height).toBeLessThanOrEqual(boundTextMaxHeight(sticky) + 1);
      // the ordinary sticky, whose text does fit, keeps the full size
      expect(els.get('t-sticky-1')!.fontSize).toBeCloseTo(15.8, 6);
    });

    it('maps Confluence shape names onto excalidraw types', () => {
      expect(els.get('shape-ellipse')!.type).toBe('ellipse');
      expect(els.get('shape-diamond')!.type).toBe('diamond');
      expect(els.get('shape-diamond')!.backgroundColor).toBe('transparent'); // fillEnabled:false
    });
  });

  describe('text nodes', () => {
    it('takes an allowFlexibleWidth node\'s real box from legacyGeometry, not the 34px stub in geometry', () => {
      const flex = els.get('text-flex')!;
      expect({ x: flex.x, y: flex.y }).toEqual({ x: 100, y: 120 });
      expect(flex.width).toBeGreaterThan(34); // the stub would have clipped this to nothing
      expect(flex.autoResize).toBe(true);
    });

    it('treats a fixed-width text as fixed: fontScale-multiplied width, autoResize off, wrapped to fit', () => {
      const fixed = els.get('text-fixed')!;
      expect(fixed.autoResize).toBe(false);
      expect(fixed.fontSize).toBeCloseTo(15.8 * 1.5, 6);
      // 200px stored at scale 1 -> 300px at fontScale 1.5
      expect(fixed.width).toBeGreaterThanOrEqual(300 - 7.7 * 2);
      expect(fixed.text!.split('\n').length).toBeGreaterThan(1);
    });
  });

  describe('connectors', () => {
    it('recomputes an associated connector\'s endpoints from its anchors, ignoring the stale start/end', () => {
      const arrow = els.get('conn-1')!;
      const src = els.get('shape-rect')!;
      const dst = els.get('shape-ellipse')!;
      expect(arrow.type).toBe('arrow');
      // sourceAnchor {left:1, top:0.5} -> the source's right edge, vertical middle
      expect(arrow.x).toBeCloseTo(src.x + src.width, 6);
      expect(arrow.y).toBeCloseTo(src.y + src.height * 0.5, 6);
      // targetAnchor {left:0, top:0.5} -> the target's left edge
      const last = arrow.points!.at(-1)!;
      expect(arrow.x + last[0]).toBeCloseTo(dst.x, 6);
      expect(arrow.y + last[1]).toBeCloseTo(dst.y + dst.height * 0.5, 6);
      expect(arrow.x).not.toBe(-5000);
    });

    it('threads waypoints through the polyline, between the two endpoints', () => {
      const arrow = els.get('conn-1')!;
      expect(arrow.points![0]).toEqual([0, 0]);
      // the author's waypoint is a real corner of the route — the orthogonal
      // router may add turns around it, but never routes past it
      const hits = arrow.points!.filter((p) => Math.abs(arrow.x + p[0] - 420) < 1e-6 && Math.abs(arrow.y + p[1] - 30) < 1e-6);
      expect(hits.length, 'waypoint (420,30) is on the route').toBe(1);
    });

    it('binds both ends to the shapes, and records the reverse reference on each shape', () => {
      const arrow = els.get('conn-1')!;
      expect(arrow.startBinding).toEqual({ elementId: 'shape-rect', focus: 0, gap: 4 });
      expect(arrow.endBinding).toEqual({ elementId: 'shape-ellipse', focus: 0, gap: 4 });
      expect(els.get('shape-rect')!.boundElements).toContainEqual({ id: 'conn-1', type: 'arrow' });
      expect(els.get('shape-ellipse')!.boundElements).toContainEqual({ id: 'conn-1', type: 'arrow' });
    });

    it('carries stroke style across (dashed, medium -> width 2, arrowheads per cap)', () => {
      const arrow = els.get('conn-1')!;
      expect(arrow.strokeStyle).toBe('dashed');
      expect(arrow.strokeWidth).toBe(2);
      expect(arrow.startArrowhead).toBeNull();
      expect(arrow.endArrowhead).toBe('arrow');
      const plain = els.get('conn-2')!;
      expect(plain.strokeStyle).toBe('solid');
      expect(plain.strokeWidth).toBe(1);
      expect(plain.startArrowhead).toBe('arrow');
    });

    it('uses raw start/end (and no bindings) for a connector with no association', () => {
      const arrow = els.get('conn-2')!;
      expect({ x: arrow.x, y: arrow.y }).toEqual({ x: 100, y: 600 });
      expect(arrow.startBinding).toBeNull();
      expect(arrow.endBinding).toBeNull();
    });

    describe('presentation: "dynamic" is an ELBOW connector (round 24b point 4)', () => {
      /**
       * 149 of the 156 connectors on the owner's real boards are `dynamic`,
       * and every one of them used to arrive as a bare diagonal: the field was
       * never read and `elbowed` was hard-coded to false.
       */
      it('routes a dynamic connector orthogonally, leaving each shape perpendicular to its anchor', () => {
        const arrow = els.get('conn-elbow')!;
        const src = els.get('shape-rect')!;
        const dst = els.get('shape-diamond')!;
        expect(arrow.elbowed).toBe(true);
        const pts = arrow.points!;
        expect(pts.length).toBeGreaterThan(2); // it turns instead of cutting across
        for (let i = 0; i < pts.length - 1; i++) {
          const dx = Math.abs(pts[i + 1][0] - pts[i][0]);
          const dy = Math.abs(pts[i + 1][1] - pts[i][1]);
          expect(dx < 0.01 || dy < 0.01, `segment ${i} is diagonal`).toBe(true);
        }
        // ends still land exactly on the anchors: right edge -> top edge
        expect(arrow.x).toBeCloseTo(src.x + src.width, 6);
        expect(arrow.y).toBeCloseTo(src.y + src.height / 2, 6);
        expect(arrow.x + pts.at(-1)![0]).toBeCloseTo(dst.x + dst.width / 2, 6);
        expect(arrow.y + pts.at(-1)![1]).toBeCloseTo(dst.y, 6);
      });

      it('gives an elbow arrow the fixedPoint bindings excalidraw demands, or restore() drops them', () => {
        // repairBinding() in @excalidraw/excalidraw returns null for a binding
        // on an elbowed arrow that has no fixedPoint — elbowed without this
        // would have UNBOUND every arrow on load.
        const arrow = els.get('conn-elbow')!;
        expect(arrow.startBinding).toEqual({ elementId: 'shape-rect', focus: 0, gap: 4, fixedPoint: [1, 0.5] });
        expect(arrow.endBinding).toEqual({ elementId: 'shape-diamond', focus: 0, gap: 4, fixedPoint: [0.5, 0] });
        expect(arrow.fixedSegments).toEqual([]);
        expect(arrow.startIsSpecial).toBe(false);
        expect(arrow.endIsSpecial).toBe(false);
        // a NON-elbow arrow must not carry a fixedPoint (excalidraw would then
        // treat the binding as an elbow one)
        expect(els.get('conn-1')!.startBinding!.fixedPoint).toBeUndefined();
      });

      it('leaves a "straight" connector straight, and defers to author-placed waypoints', () => {
        expect(els.get('conn-2')!.elbowed).toBe(false); // no presentation at all
        expect(els.get('path-1')!.elbowed).toBe(false); // presentation: "straight"
        // conn-1 and conn-3 are dynamic but carry waypoints the author placed
        // by hand — their route is not ours to invent.
        expect(els.get('conn-1')!.elbowed).toBe(false);
        expect(els.get('conn-3')!.elbowed).toBe(false);
      });

      it('picks up a waypoint attached the way the real export ships it (no "-waypoint" suffix)', () => {
        // Every waypoint on the owner's boards has an id like
        // `path-waypoint-<connId>-<wpId>` bound by an attachment edge, so the
        // suffix-only lookup found none of them.
        const arrow = els.get('conn-3')!;
        const on = arrow.points!.slice(0, -1).some((p, i) => {
          const [ax, ay] = [arrow.x + p[0], arrow.y + p[1]];
          const [bx, by] = [arrow.x + arrow.points![i + 1][0], arrow.y + arrow.points![i + 1][1]];
          return 250 >= Math.min(ax, bx) - 1e-6 && 250 <= Math.max(ax, bx) + 1e-6
            && 900 >= Math.min(ay, by) - 1e-6 && 900 <= Math.max(ay, by) + 1e-6;
        });
        expect(on, 'the route passes through the author-placed waypoint (250,900)').toBe(true);
      });

      it('draws a hand-routed dynamic connector orthogonally too, keeping its waypoints', () => {
        // Without this the 11 waypointed connectors stayed long diagonals
        // cutting across the whole board.
        const arrow = els.get('conn-3')!;
        const pts = arrow.points!;
        for (let i = 0; i < pts.length - 1; i++) {
          const dx = Math.abs(pts[i + 1][0] - pts[i][0]);
          const dy = Math.abs(pts[i + 1][1] - pts[i][1]);
          expect(dx < 0.01 || dy < 0.01, `segment ${i} is diagonal`).toBe(true);
        }
        // leaves the source downward, arrives at the target from above, and the
        // waypoint (50,50) sits on the middle segment (a redundant vertex on a
        // straight run is dropped; one the line doubles back at is not)
        expect(elbowRouteVia([0, 0], 'bottom', [[50, 50]], [100, 100], 'top'))
          .toEqual([[0, 0], [0, 50], [100, 50], [100, 100]]);
        expect(elbowRouteVia([0, 0], 'right', [[60, -80]], [100, 0], 'left'))
          .toEqual([[0, 0], [60, 0], [60, -80], [60, 0], [100, 0]]);
      });
    });

    it('converts a `path` node — a connector without an association — instead of dropping it', () => {
      const p = els.get('path-1')!;
      expect(p.type).toBe('arrow');
      expect({ x: p.x, y: p.y }).toEqual({ x: -100, y: -100 });
      expect(p.x + p.points!.at(-1)![0]).toBeCloseTo(300, 6);
      expect(p.endArrowhead).toBe('arrow');
      expect(p.startArrowhead).toBeNull();
      expect(p.startBinding).toBeNull();
    });

    describe('pathLabel', () => {
      it('binds a label found by the "<connectorId>-path-label" naming convention', () => {
        const label = els.get('t-conn-1')!;
        expect(label.text).toBe('leads to');
        expect(label.containerId).toBe('conn-1');
        expect(els.get('conn-1')!.boundElements).toContainEqual({ id: 't-conn-1', type: 'text' });
      });

      it('binds a label found through an explicit attachment edge', () => {
        const label = els.get('t-conn-2')!;
        expect(label.text).toBe('via edge');
        expect(label.containerId).toBe('conn-2');
      });

      it('puts the label at the midpoint of the polyline and never shrinks it to an unreadable size', () => {
        const arrow = els.get('conn-2')!;
        const label = els.get('t-conn-2')!;
        expect(label.x + label.width / 2).toBeCloseTo((100 + 400) / 2, 3);
        expect(label.y + label.height / 2).toBeCloseTo((600 + 700) / 2, 3);
        expect(label.fontSize).toBeGreaterThanOrEqual(7);
      });
    });
  });

  describe('smartLink and stamp', () => {
    it('renders a positioned smartLink as a plain link-carrying text (no card, no icon)', () => {
      const link = els.get('sl-1')!;
      expect(link.type).toBe('text');
      expect(link.link).toBe('https://example.atlassian.net/wiki/spaces/DOCS/pages/777/Target');
      expect(link.strokeColor).toBe('#0B66E4');
      // No url text, so the label falls back to the prettified URL.
      expect(link.text).toContain('example.atlassian.net');
    });

    it('collects geometry-less smartLinks into a link column under the content', () => {
      const header = els.get('legend-hdr')!;
      const entry = els.get('legend-0')!;
      expect(header.text).toBe('Links from the board:');
      expect(entry.text).toContain('Another page');
      expect(entry.link).toBe('https://example.atlassian.net/wiki/spaces/DOCS/pages/888/Other');
      const contentBottom = Math.max(...scene.elements.filter((e) => !e.containerId && !e.id.startsWith('legend-')).map((e) => e.y + e.height));
      expect(header.y).toBeGreaterThan(contentBottom);
    });

    it('rewrites a smartLink URL through resolveLink (round 24 point 4: links back into imported pages)', () => {
      const rewritten = convertWhiteboardDocument(makeDoc(), {
        resolveLink: (url) => (url.includes('/pages/777/') ? './target.md' : undefined),
      });
      const map = byId(rewritten.scene);
      expect(map.get('sl-1')!.link).toBe('./target.md');
      // An unresolved (external) link keeps its original URL rather than being dropped.
      expect(map.get('legend-0')!.link).toBe('https://example.atlassian.net/wiki/spaces/DOCS/pages/888/Other');
    });

    it('renders a known stamp as its emoji, centred in the stamp\'s own box', () => {
      const stamp = els.get('stamp-1')!;
      expect(stamp.text).toBe('🚀');
      expect(stamp.x + stamp.width / 2).toBeCloseTo(300 + 48 / 2, 3);
    });
  });

  it('opens zoomed to fit the content instead of at 100% somewhere off-canvas', () => {
    const zoom = (scene.appState.zoom as { value: number }).value;
    expect(zoom).toBeGreaterThan(0.05);
    expect(zoom).toBeLessThanOrEqual(1);
    expect(typeof scene.appState.scrollX).toBe('number');
    expect(scene.appState.viewBackgroundColor).toBe('#ffffff');
  });

  describe('an empty / unrecognised document degrades instead of throwing', () => {
    it('accepts a document with no nodes at all', () => {
      const empty = whiteboardDocumentToSvg({ nodes: {}, edges: {} });
      expect(empty.elementCount).toBe(0);
      expect(empty.svg).toContain('<svg');
    });

    it('accepts nodes/edges given as ARRAYS as well as as maps', () => {
      const asArrays = convertWhiteboardDocument({
        nodes: [{ id: 'a', type: 'sticky', geometry: { position: { x: 0, y: 0 }, size: { x: 100, y: 100 } }, text: adf('hello') }],
        edges: [],
      });
      expect(byId(asArrays.scene).has('a')).toBe(true);
    });
  });

  describe('pure helpers', () => {
    it('adfText flattens paragraphs and hardBreaks, and survives a non-JSON string', () => {
      expect(adfText(adf('first', 'second'))).toBe('first\nsecond');
      expect(adfText('  plain   text ')).toBe('plain text');
      expect(adfText(null)).toBe('');
    });

    it('adfText keeps list markers and does not blank-line every item', () => {
      // bulletList/orderedList were unknown types, so items lost their marker;
      // listItem AND its inner paragraph each emitted a newline.
      const label = els.get('t-sticky-list')!;
      expect(label.originalText).toBe('1. first\n2. second\n• report');
      const nested = adfText({
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  { type: 'paragraph', content: [{ type: 'text', text: 'top' }] },
                  { type: 'orderedList', attrs: { order: 3 }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bottom' }] }] }] },
                ],
              },
            ],
          },
        ],
      });
      expect(nested).toBe('• top\n  3. bottom'); // nesting shows as indentation
    });

    it('adfFirstLink hoists an inline link onto the element (excalidraw has no per-run links)', () => {
      expect(els.get('sticky-list')!.link).toBe('https://docs.example.com/report');
      expect(els.get('sticky-1')!.link).toBeNull();
      // and it goes through resolveLink, exactly like a smartLink does
      const rewritten = convertWhiteboardDocument(makeDoc(), {
        resolveLink: (url) => (url.includes('docs.example.com') ? '/s/space/p/01Z' : undefined),
      });
      expect(byId(rewritten.scene).get('sticky-list')!.link).toBe('/s/space/p/01Z');
    });

    it('elbowRoute turns at right angles and collapses to a straight line when it can', () => {
      // both ends face along the same axis -> a Z with two turns
      expect(elbowRoute([0, 0], 'right', [100, 50], 'left')).toEqual([[0, 0], [50, 0], [50, 50], [100, 50]]);
      // across axes -> a single L
      expect(elbowRoute([0, 0], 'right', [100, 50], 'top')).toEqual([[0, 0], [100, 0], [100, 50]]);
      // already aligned -> no pointless midpoints
      expect(elbowRoute([0, 0], 'right', [100, 0], 'left')).toEqual([[0, 0], [100, 0]]);
      expect(anchorSide({ left: 1, top: 0.5 })).toBe('right');
      expect(anchorSide({ left: 0.5, top: 0 })).toBe('top');
      expect(anchorSide({ left: 0.45, top: 0.6 })).toBeNull();
    });

    it('wrapText breaks after slashes and hyphens, the way Confluence does', () => {
      const lines = wrapText('Incident/Problem/Request', 15.8, 90);
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines.slice(0, -1)) expect(line.endsWith('/') || line.endsWith('-')).toBe(true);
    });

    it('wrapText splits a single word that is wider than the whole line', () => {
      const lines = wrapText('AAAAAAAAAAAAAAAAAAAAAAAAAAA', 15.8, 40);
      expect(lines.length).toBeGreaterThan(1);
    });

    it('textMetrics reports height as lines * fontSize * lineHeight', () => {
      const m = textMetrics('a\nb\nc', 20);
      expect(m.height).toBeCloseTo(3 * 20 * 1.25, 6);
    });
  });
});

describe('confluenceWhiteboard.ts: the .excalidraw.svg envelope', () => {
  const { svg, elementCount } = whiteboardDocumentToSvg(makeDoc());

  it('is a real SVG with the canonical excalidraw payload markers', () => {
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg).toContain('<!-- svg-source:excalidraw -->');
    expect(svg).toContain('<!-- payload-type:application/vnd.excalidraw+json -->');
    expect(svg).toContain('<!-- payload-start -->');
    expect(svg).toContain('<!-- payload-end -->');
    expect(svg.endsWith('</svg>')).toBe(true);
  });

  it('round-trips: base64 -> latin1 bstring wrapper -> inflate -> the very same scene', () => {
    const payload = extractScenePayload(svg)!;
    const wrapper = JSON.parse(Buffer.from(payload, 'base64').toString('latin1')) as Record<string, unknown>;
    expect(wrapper.version).toBe('1');
    expect(wrapper.encoding).toBe('bstring');
    expect(wrapper.compressed).toBe(true);

    const scene = decodeScenePayload(payload);
    expect(scene.type).toBe('excalidraw');
    expect(scene.source).toBe('folio-confluence-import');
    expect(scene.elements.length).toBe(elementCount);
    // The decoded scene must equal the in-memory one exactly -- this is the
    // step that has to stay byte-compatible with loadFromBlob.
    expect(scene).toEqual(convertWhiteboardDocument(makeDoc()).scene);
  });

  it('selfcheck: every boundElements / containerId / startBinding / endBinding id resolves', () => {
    const scene = decodeScenePayload(extractScenePayload(svg)!);
    const ids = new Set(scene.elements.map((e) => e.id));
    let checked = 0;
    for (const el of scene.elements) {
      for (const b of el.boundElements ?? []) {
        expect(ids.has(b.id), `dangling boundElement ${b.id} on ${el.id}`).toBe(true);
        checked++;
      }
      if (el.containerId) {
        expect(ids.has(el.containerId), `dangling containerId ${el.containerId}`).toBe(true);
        checked++;
      }
      for (const key of ['startBinding', 'endBinding'] as const) {
        const binding = el[key];
        if (binding) {
          expect(ids.has(binding.elementId), `dangling ${key} ${binding.elementId}`).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0); // the fixture really does exercise bindings
    expect(selfcheckWhiteboardSvg(svg)).toBe(elementCount);
  });

  it('selfcheck actually fails on a broken scene (it is a guard, not decoration)', () => {
    const scene = decodeScenePayload(extractScenePayload(svg)!);
    scene.elements = scene.elements.filter((e) => e.id !== 't-sticky-1'); // orphan the sticky's boundElements entry
    const broken = svg.replace(
      /<!-- payload-start -->[\s\S]+?<!-- payload-end -->/,
      `<!-- payload-start -->${encodeSceneForTest(scene)}<!-- payload-end -->`,
    );
    expect(() => selfcheckWhiteboardSvg(broken)).toThrow(/dangling boundElement/);
  });

  it('selfcheck catches the two new ways a board can open wrong', () => {
    const rewrap = (mutate: (s: ExcalidrawScene) => void): string => {
      const scene = decodeScenePayload(extractScenePayload(svg)!);
      mutate(scene);
      return svg.replace(/<!-- payload-start -->[\s\S]+?<!-- payload-end -->/, `<!-- payload-start -->${encodeSceneForTest(scene)}<!-- payload-end -->`);
    };
    // 1) an elbow arrow whose binding lost its fixedPoint: excalidraw's own
    //    restore() would silently unbind it
    expect(() =>
      selfcheckWhiteboardSvg(rewrap((s) => {
        const a = s.elements.find((e) => e.id === 'conn-elbow')!;
        delete a.startBinding!.fixedPoint;
      })),
    ).toThrow(/no fixedPoint/);
    // 2) a frame member that pokes out of its frame would be clipped in half
    expect(() =>
      selfcheckWhiteboardSvg(rewrap((s) => {
        s.elements.find((e) => e.id === 'sticky-1')!.x -= 500;
      })),
    ).toThrow(/does not fit inside its frame/);
  });

  it('is deterministic: the same document converts to byte-identical output every time', () => {
    expect(whiteboardDocumentToSvg(makeDoc()).svg).toBe(svg);
  });

  it('draws a visible preview, not just an empty frame around the payload', () => {
    expect(svg).toContain('<rect'); // stickies/shapes/sections
    expect(svg).toContain('<ellipse');
    expect(svg).toContain('<polygon'); // the diamond
    expect(svg).toContain('<polyline'); // connectors
    expect(svg).toContain('<tspan'); // laid-out text lines
  });
});

/** Re-encodes a (deliberately corrupted) scene the same way the module does. */
function encodeSceneForTest(scene: ExcalidrawScene): string {
  const deflated = zlib.deflateSync(Buffer.from(JSON.stringify(scene), 'utf8'));
  const wrapper = JSON.stringify({ version: '1', encoding: 'bstring', compressed: true, encoded: deflated.toString('latin1') });
  return Buffer.from(wrapper, 'latin1').toString('base64');
}

describe('confluenceWhiteboard.ts: URL detection (Cloud-only feature)', () => {
  it('recognises a Cloud whiteboard URL and pulls out the site + numeric id', () => {
    const target = parseWhiteboardUrl('https://example-team.atlassian.net/wiki/spaces/DOCS/whiteboard/1000000006');
    expect(target).toEqual({
      siteBase: 'https://example-team.atlassian.net',
      hostname: 'example-team.atlassian.net',
      whiteboardId: '1000000006',
      sourceUrl: 'https://example-team.atlassian.net/wiki/spaces/DOCS/whiteboard/1000000006',
    });
  });

  it('recognises the short /wiki/whiteboard/<id> form, and one with a trailing query', () => {
    expect(parseWhiteboardUrl('https://example-team.atlassian.net/wiki/whiteboard/1234')!.whiteboardId).toBe('1234');
    expect(parseWhiteboardUrl('https://example-team.atlassian.net/wiki/spaces/DOCS/whiteboard/1234?atlOrigin=x')!.whiteboardId).toBe('1234');
  });

  it('an ordinary page URL is not a whiteboard at all (the normal page import path)', () => {
    expect(looksLikeWhiteboardUrl('https://example-team.atlassian.net/wiki/spaces/DOCS/pages/123/Title')).toBe(false);
    expect(parseWhiteboardUrl('https://example-team.atlassian.net/wiki/spaces/DOCS/pages/123/Title')).toBeNull();
    expect(resolveImportTarget('https://wiki.example.org/wiki/spaces/ENG/pages/1/X', { kind: 'pat', token: 't' })).toEqual({ kind: 'page' });
  });

  it('an ON-PREM whiteboard URL gets an explicit "Cloud only" error, not a silent fallback to the page importer', () => {
    expect(() => parseWhiteboardUrl('https://wiki.example.org/wiki/spaces/ENG/whiteboard/999')).toThrow(/Cloud/);
    expect(() => parseWhiteboardUrl('https://wiki.example.org/wiki/spaces/ENG/whiteboard/999')).toThrow(/wiki\.example\.org/);
  });

  it('a Cloud whiteboard with a PAT is rejected up front — Cloud wants email + API token', () => {
    const url = 'https://example-team.atlassian.net/wiki/spaces/DOCS/whiteboard/1000000006';
    expect(() => resolveImportTarget(url, { kind: 'pat', token: 't' })).toThrow(/email \+ API token/);
    expect(resolveImportTarget(url, { kind: 'basic', token: 't', email: 'a@b.c' })).toEqual({
      kind: 'whiteboard',
      target: expect.objectContaining({ whiteboardId: '1000000006' }),
    });
  });
});

// ---------------------------------------------------------------------------
// Network path -- a real local mock server, same pattern as the page
// importer's own happy-path test in confluenceImport.test.ts.
// ---------------------------------------------------------------------------

interface MockWhiteboardServer {
  base: string;
  server: http.Server;
  authHeaders: string[];
  graphqlOperations: string[];
}

function startMockWhiteboardSite(boardId: string, title: string, doc: unknown, opts: { representation?: string } = {}): Promise<MockWhiteboardServer> {
  return new Promise((resolve) => {
    const authHeaders: string[] = [];
    const graphqlOperations: string[] = [];
    const server = http.createServer((req, res) => {
      authHeaders.push(req.headers.authorization ?? '');
      const url = new URL(req.url ?? '/', 'http://internal');
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === `/wiki/api/v2/whiteboards/${boardId}`) {
        res.end(JSON.stringify({ id: boardId, title, parentId: '555', parentType: 'page', spaceId: '77', position: 3 }));
        return;
      }
      if (url.pathname === '/gateway/api/graphql') {
        let raw = '';
        req.on('data', (c) => {
          raw += c;
        });
        req.on('end', () => {
          const body = JSON.parse(raw || '{}') as { query?: string; variables?: Record<string, unknown> };
          graphqlOperations.push(body.query ?? '');
          if ((body.query ?? '').includes('tenantContexts')) {
            res.end(JSON.stringify({ data: { tenantContexts: [{ cloudId: 'cloud-id-abc' }] } }));
            return;
          }
          res.end(
            JSON.stringify({
              data: {
                confluence: {
                  whiteboard: {
                    title,
                    body: { whiteboardDocFormat: { representation: opts.representation ?? 'WHITEBOARD_DOC_FORMAT', value: JSON.stringify(doc) } },
                  },
                },
              },
            }),
          );
        });
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ message: `mock: no handler for ${url.pathname}` }));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, server, authHeaders, graphqlOperations });
    });
  });
}

describe('confluenceWhiteboard.ts: the Cloud fetch, against a real local mock server', () => {
  it('does REST metadata -> tenantContexts -> confluence.whiteboard(ARI), with the @optIn directive', async () => {
    const mock = await startMockWhiteboardSite('42', 'Where do tasks go?', makeDoc());
    try {
      const target = parseWhiteboardUrl(`${mock.base}/wiki/spaces/DOCS/whiteboard/42`)!;
      const { metadata, document } = await fetchWhiteboard(target, 'Basic dGVzdDp0b2tlbg==');
      expect(metadata).toEqual({ id: '42', title: 'Where do tasks go?', parentId: '555', parentType: 'page', spaceId: '77', position: 3 });
      expect(Object.keys((document as { nodes: Record<string, unknown> }).nodes)).toContain('sticky-1');

      expect(mock.graphqlOperations.length).toBe(2);
      expect(mock.graphqlOperations[0]).toContain('tenantContexts');
      // Without @optIn the `whiteboard` field does not resolve at all.
      expect(mock.graphqlOperations[1]).toContain('@optIn(to: "ConfluenceWhiteboardsRelease")');
      expect(mock.authHeaders.every((h) => h.startsWith('Basic '))).toBe(true);
    } finally {
      await new Promise((r) => mock.server.close(r));
    }
  });

  it('rejects an unexpected representation instead of feeding garbage to the converter', async () => {
    const mock = await startMockWhiteboardSite('42', 'X', makeDoc(), { representation: 'ATLAS_DOC_FORMAT' });
    try {
      const target = parseWhiteboardUrl(`${mock.base}/wiki/spaces/DOCS/whiteboard/42`)!;
      await expect(fetchWhiteboard(target, 'Basic x')).rejects.toThrow(/unexpected whiteboard representation/);
    } finally {
      await new Promise((r) => mock.server.close(r));
    }
  });

  it('surfaces a GraphQL errors[] payload as a real error', async () => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://internal');
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/wiki/api/v2/whiteboards/42') {
        res.end(JSON.stringify({ id: '42', title: 'X' }));
        return;
      }
      res.end(JSON.stringify({ errors: [{ message: 'Whiteboard not found or no permission' }] }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      const target = parseWhiteboardUrl(`http://127.0.0.1:${port}/wiki/whiteboard/42`)!;
      await expect(fetchWhiteboard(target, 'Basic x')).rejects.toThrow(/Whiteboard not found or no permission/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('confluenceWhiteboard: end-to-end through the normal import job (real PG, real git, mock Confluence)', () => {
  let teardownSchema: () => Promise<void>;
  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  /** Polls `check` until it returns true or `timeoutMs` elapses. */
  async function pollUntil(check: () => boolean, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`pollUntil: condition not met within ${timeoutMs}ms`);
  }

  it('a whiteboard URL lands as a kind=board .excalidraw.svg page, and re-importing reuses the same page id', async () => {
    const user = await authStore.createUser({ email: `wb-e2e-${Date.now()}@folio-test.local`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    const mock = await startMockWhiteboardSite('42', 'Where do tasks go?', makeDoc());
    let slug: string | undefined;
    try {
      const resolved = await resolveOrCreateTargetSpace(`Whiteboard Import ${Date.now()}`, user.id);
      slug = resolved.slug;

      const source = {
        pageUrl: `${mock.base}/wiki/spaces/DOCS/whiteboard/42`,
        auth: { kind: 'basic' as const, token: 'mock-token', email: 'someone@example.com' },
        targetPath: '',
        includeChildren: true,
        targetSpace: resolved.slug,
      };
      const job = startImportJob(source, user.id, { name: user.name, email: user.email });
      await pollUntil(() => getJob(job.id)?.status === 'done' || getJob(job.id)?.status === 'error');
      expect(getJob(job.id)?.error).toBeNull();
      expect(getJob(job.id)?.total).toBe(1);
      expect(getJob(job.id)?.done).toBe(1);
      // pending contract additions -- see the round-24 report
      expect((getJob(job.id) as unknown as { boards: number }).boards).toBe(1);
      expect((getJob(job.id) as unknown as { warnings: string[] }).warnings.join(' ')).toContain('unicorn-xyz');

      const boards = (await storage.listEntries(resolved.slug)).filter((e) => e.kind === 'board');
      expect(boards.length).toBe(1);
      const board = boards[0];
      // translit-slug filename, same naming scheme every other Folio board uses
      expect(board.relPath).toBe('where-do-tasks-go.excalidraw.svg');

      const svg = await storage.readBoardSvg(board.id);
      expect(svg.startsWith(`<!-- folio-id: ${board.id} -->`)).toBe(true); // the id we chose, not a fresh one minted by the scan
      const scene = decodeScenePayload(extractScenePayload(svg)!);
      expect(scene.elements.some((e) => e.id === 'sticky-1')).toBe(true);

      // Re-import the same board: the path is already indexed, so the id must
      // be REUSED -- a fresh ulid here is a unique-constraint violation on the
      // next scan, exactly the bug the page importer already guards against.
      const job2 = startImportJob(source, user.id, { name: user.name, email: user.email });
      await pollUntil(() => getJob(job2.id)?.status === 'done' || getJob(job2.id)?.status === 'error');
      expect(getJob(job2.id)?.error).toBeNull();
      const boardsAfter = (await storage.listEntries(resolved.slug)).filter((e) => e.kind === 'board');
      expect(boardsAfter.length).toBe(1);
      expect(boardsAfter[0].id).toBe(board.id);
    } finally {
      await new Promise((r) => mock.server.close(r));
      if (slug) await deleteTestSpace(slug);
    }
  }, 40_000);

  it('honours targetPath, dropping the board next to the pages under that subdirectory', async () => {
    const user = await authStore.createUser({ email: `wb-path-${Date.now()}@folio-test.local`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    const mock = await startMockWhiteboardSite('7', 'Process diagram', { nodes: {}, edges: {} });
    let slug: string | undefined;
    try {
      const resolved = await resolveOrCreateTargetSpace(`Whiteboard Subdir ${Date.now()}`, user.id);
      slug = resolved.slug;
      const job = startImportJob(
        {
          pageUrl: `${mock.base}/wiki/whiteboard/7`,
          auth: { kind: 'basic', token: 'mock-token', email: 'someone@example.com' },
          targetPath: 'docs/boards',
          includeChildren: true,
          targetSpace: resolved.slug,
        },
        user.id,
        { name: user.name, email: user.email },
      );
      await pollUntil(() => getJob(job.id)?.status === 'done' || getJob(job.id)?.status === 'error');
      expect(getJob(job.id)?.error).toBeNull();
      const boards = (await storage.listEntries(resolved.slug)).filter((e) => e.kind === 'board');
      expect(boards.map((b) => b.relPath)).toEqual(['docs/boards/process-diagram.excalidraw.svg']);
    } finally {
      await new Promise((r) => mock.server.close(r));
      if (slug) await deleteTestSpace(slug);
    }
  }, 40_000);

  it('a failing board fetch fails the job with a readable message and never leaks the token', async () => {
    const user = await authStore.createUser({ email: `wb-fail-${Date.now()}@folio-test.local`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    const server = http.createServer((_req, res) => {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ message: 'Current user not permitted to use Confluence' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    let slug: string | undefined;
    try {
      const resolved = await resolveOrCreateTargetSpace(`Whiteboard Fail ${Date.now()}`, user.id);
      slug = resolved.slug;
      const job = startImportJob(
        {
          pageUrl: `http://127.0.0.1:${port}/wiki/whiteboard/9`,
          auth: { kind: 'basic', token: 'super-secret-token', email: 'someone@example.com' },
          targetPath: '',
          includeChildren: true,
          targetSpace: resolved.slug,
        },
        user.id,
        { name: user.name, email: user.email },
      );
      await pollUntil(() => getJob(job.id)?.status === 'error');
      const error = getJob(job.id)?.error ?? '';
      expect(error).toContain('403');
      expect(error).not.toContain('super-secret-token');
    } finally {
      await new Promise((r) => server.close(r));
      if (slug) await deleteTestSpace(slug);
    }
  }, 40_000);
});

describe('resolveLinkLabel (companion to resolveLink)', () => {
  it('uses the resolved title as the label when the smartLink has no text of its own', () => {
    const rewritten = convertWhiteboardDocument(makeDoc(), {
      resolveLink: (url) => (url.includes('/pages/777/') ? '/s/space/p/01X' : undefined),
      resolveLinkLabel: (url) => (url.includes('/pages/777/') ? 'Target page' : undefined),
    });
    const map = byId(rewritten.scene);
    expect(map.get('sl-1')!.link).toBe('/s/space/p/01X');
    expect(map.get('sl-1')!.text).toContain('Target page');
    // sl-2 has its OWN text — the label must stay the author's text even if resolved.
    expect(map.get('legend-0')!.text).toContain('Another page');
  });

  it('never consults resolveLinkLabel for an unresolved link (label stays the pretty URL)', () => {
    const rewritten = convertWhiteboardDocument(makeDoc(), {
      resolveLink: () => undefined,
      resolveLinkLabel: () => 'GARBAGE',
    });
    const map = byId(rewritten.scene);
    expect(map.get('sl-1')!.text).toContain('example.atlassian.net');
  });
});
