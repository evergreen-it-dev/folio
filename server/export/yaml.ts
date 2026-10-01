/**
 * Round 23 tail follow-up (owner): YAML as a first-class export format,
 * alongside MD/PDF/DOCX in the Export menu (`web/src/app/export/ExportMenu.tsx`).
 *
 * SCOPING DECISION, recorded here because the owner explicitly left it open
 * ("for ordinary pages decide what makes sense"): this module is KIND-AWARE
 * only for the single-page, no-`includeChildren` case — the common one a
 * reader picking "YAML" from a single page's menu actually hits:
 *
 *  - `board` -> `{ title, image, scene }`, where `scene` is EXACTLY
 *    boardText.ts's structured extraction (frames/nodes/edges) — reused via
 *    `extractBoardStructure`, not respelled. A board's whole point in this
 *    format is the graph, so it gets one.
 *  - `table` -> delegates to `server/tables/service.ts`'s own `exportTable`
 *    (`format: 'yaml'`), VERBATIM, unwrapped. Tables already have a
 *    canonical, round-trip YAML shape (`{meta, columns, views, rows}`) —
 *    respelling it here would just be a second, subtly different table YAML
 *    format for no reason. This is the reuse the owner pointed at directly.
 *  - `doc` -> a small envelope, `{ title, url, body }`, where `body` is
 *    the EXACT markdown `export.md` would return for the same page
 *    (absolute links, no frontmatter) — YAML metadata wrapped around the
 *    canonical markdown source, not a re-parse of it into some other shape
 *    invented for this format alone.
 *
 * `includeChildren` (any root kind, or a mix of kinds down the subtree) is
 * deliberately NOT given the same per-kind treatment: reproducing
 * `assembleMarkdown`'s link-rewriting/anchor-dedup/byte-cap machinery a
 * second time, per page, per kind, to build a tree of typed YAML nodes would
 * be a large amount of code for a collation whose own point is being ONE
 * document. Instead the whole collation becomes ONE envelope —
 * `{ title, pageCount, truncated, body }` — wrapping the exact markdown
 * `export.md?children=1` already produces. Still strictly more useful to a
 * script than raw markdown alone: `pageCount`/`truncated` are queryable
 * without scanning for the truncation-marker comment.
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
import * as storage from '../storage.js';
import { exportTable } from '../tables/service.js';
import { extractBoardStructure } from './boardText.js';
import type { CollectedSubtree } from './collect.js';
import type { ExportTruncation } from './limits.js';
import { assembleMarkdown, type AssembleOptions } from './markdown.js';

export interface YamlAssembleOptions extends AssembleOptions {
  tableViewId?: string;
  currentUser?: string;
}

export interface AssembledYaml {
  yaml: string;
  pageCount: number;
  truncation: ExportTruncation | null;
}

function dump(doc: Record<string, unknown>): string {
  // No line-wrapping (a long markdown `body` must round-trip on one block
  // scalar), insertion order kept (title/url first, body last — reading
  // order, not alphabetical).
  return `${yaml.dump(doc, { lineWidth: -1, sortKeys: false, noRefs: true }).trimEnd()}\n`;
}

async function boardYaml(entry: storage.PageIndexEntry, baseUrl: string): Promise<AssembledYaml> {
  const svg = await storage.readBoardSvg(entry.id);
  const structure = extractBoardStructure(svg);

  const doc: Record<string, unknown> = {
    title: entry.title,
    image: `${baseUrl}/files/${entry.space}/${entry.relPath}`,
  };
  const scene: Record<string, unknown> = {};
  if (structure.frames.length > 0) scene.frames = structure.frames;
  if (structure.nodes.length > 0) scene.nodes = structure.nodes;
  if (structure.edges.length > 0) scene.edges = structure.edges;
  if (Object.keys(scene).length > 0) doc.scene = scene;

  return { yaml: dump(doc), pageCount: 1, truncation: null };
}

async function tableYaml(entry: storage.PageIndexEntry, opts: YamlAssembleOptions): Promise<AssembledYaml> {
  const result = await exportTable(entry.id, {
    format: 'yaml',
    view: opts.tableViewId,
    scope: opts.tableViewId ? 'view' : 'all',
    ctx: opts.currentUser ? { currentUser: opts.currentUser } : undefined,
  });
  // exportTable's own dump already IS the canonical, round-trip table YAML —
  // returned verbatim, not re-wrapped in an envelope that would break that
  // round-trip contract for anyone piping this straight into a YAML import.
  return { yaml: result.data.endsWith('\n') ? result.data : `${result.data}\n`, pageCount: 1, truncation: null };
}

async function envelopeYaml(collected: CollectedSubtree, opts: YamlAssembleOptions): Promise<AssembledYaml> {
  const assembled = await assembleMarkdown(collected, opts);
  const root = collected.pages[0].entry;

  const doc: Record<string, unknown> = {
    title: root.title,
    url: `${opts.baseUrl}/s/${root.space}/p/${root.id}`,
  };
  if (collected.pages.length > 1) doc.pageCount = assembled.pageCount;
  if (assembled.truncation) doc.truncated = assembled.truncation.reason;
  doc.body = assembled.markdown;

  return { yaml: dump(doc), pageCount: assembled.pageCount, truncation: assembled.truncation };
}

/** See the module doc for the exact per-kind shapes and the `includeChildren` scoping decision. */
export async function assembleYaml(collected: CollectedSubtree, opts: YamlAssembleOptions): Promise<AssembledYaml> {
  const root = collected.pages[0].entry;
  if (collected.pages.length === 1) {
    if (root.kind === 'board') return boardYaml(root, opts.baseUrl);
    if (root.kind === 'table') return tableYaml(root, opts);
  }
  return envelopeYaml(collected, opts);
}
