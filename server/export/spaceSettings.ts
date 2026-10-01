/**
 * R23 tail (headers and footers) — reading and writing the space-level PDF
 * header/footer templates stored in the `export` section of `<slug>.folio`
 * at the space's REPO ROOT (the same section css.ts's readSpaceExportAssets
 * reads at render time; storage.ts's docblock at its .folio helpers explains
 * why repo root rather than content root).
 *
 * WHY THIS MODULE OWNS ITS OWN READ-MODIFY-WRITE instead of calling
 * storage.ts: storage's writeFolioMeta serializes exactly `{v, name}` — it
 * would DROP the export section (and any other key) on every write, and that
 * file belongs to another agent's zone this round, so it cannot be taught to
 * merge. The write here therefore goes the other way around: parse whatever
 * the file holds, change ONLY `export`, keep every other key (v, name,
 * unknown future ones) byte-for-byte in JSON terms, and serialize in the
 * same `JSON.stringify(..., null, 2) + '\n'` shape writeFolioMeta uses so
 * the two writers produce the same formatting.
 *
 * KNOWN HAZARD, flagged for the orchestrator rather than fixed here (the fix
 * lives in storage.ts): renaming the space's root page triggers
 * storage.noteSpaceNameChange -> writeFolioMeta, which rewrites the file as
 * `{v, name}` and loses the export section. One-line fix there: merge into
 * the existing JSON the way this module does.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spaceExportSettingsSchema } from '../../shared/contracts.js';
import { badRequest, conflict } from '../errors.js';
import { parseBody } from '../validate.js';
import * as storage from '../storage.js';
import { MAX_HEADER_FOOTER_STORED_BYTES } from './css.js';
import { inlineExternalImages } from './headerFooterImages.js';

/**
 * Per-template byte cap, mirroring sanitizeHeaderFooterHtml's own 8192 slice
 * (css.ts): anything longer would be silently cut at render time anyway, so
 * the PUT refuses it up front with a message instead.
 */
export const MAX_HEADER_FOOTER_BYTES = 8192;

export interface SpaceExportSettingsPayload {
  headerHtml?: string;
  footerHtml?: string;
}

function folioFilePath(space: string): string {
  return path.join(storage.getRepoDir(space), `${space}.folio`);
}

async function readRawFolioFile(space: string): Promise<string | undefined> {
  try {
    return await fs.readFile(folioFilePath(space), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * The RAW stored templates (for the editor dialog) — deliberately not the
 * sanitized form: sanitization is a render-time concern (css.ts), and an
 * admin editing their own template should see exactly what they saved.
 * Missing/corrupt/foreign file reads as "no settings", same tolerance as
 * storage's readFolioMeta and css.ts's readSpaceExportAssets.
 */
export async function readSpaceExportSettings(space: string): Promise<SpaceExportSettingsPayload> {
  const raw = await readRawFolioFile(space);
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as { export?: { headerHtml?: unknown; footerHtml?: unknown } };
    const out: SpaceExportSettingsPayload = {};
    if (typeof parsed.export?.headerHtml === 'string') out.headerHtml = parsed.export.headerHtml;
    if (typeof parsed.export?.footerHtml === 'string') out.footerHtml = parsed.export.footerHtml;
    return out;
  } catch {
    return {};
  }
}

/** Schema first (shape/garbage → 400 via parseBody), byte cap second (the schema itself carries no max). */
export function validateExportSettingsBody(body: unknown): SpaceExportSettingsPayload {
  const parsed = parseBody(spaceExportSettingsSchema, body) ?? {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > MAX_HEADER_FOOTER_BYTES) {
      throw badRequest(`${key} exceeds ${MAX_HEADER_FOOTER_BYTES} bytes`);
    }
  }
  return parsed;
}

/**
 * Owner follow-up ("the picture in the header is not rendered"): downloads and
 * inlines every external `<img src="http(s)://…">` in the submitted
 * templates as `data:` URIs — see headerFooterImages.ts for the full SSRF
 * gateway this runs through. Called AFTER `validateExportSettingsBody` (that
 * function's `MAX_HEADER_FOOTER_BYTES` cap bounds the RAW markup an author
 * may submit) and BEFORE `writeSpaceExportSettings` (so only fully-inlined,
 * already-`data:` templates ever reach disk — css.ts's render-time
 * sanitizer then has nothing external left to strip).
 *
 * The inlined result is checked again here against
 * `MAX_HEADER_FOOTER_STORED_BYTES`: embedded image bytes can make a
 * template far bigger than the raw-markup cap ever allowed, and that is
 * expected — but not unbounded.
 */
export async function inlineTemplateImages(settings: SpaceExportSettingsPayload): Promise<SpaceExportSettingsPayload> {
  const out: SpaceExportSettingsPayload = { ...settings };
  if (out.headerHtml) out.headerHtml = await inlineExternalImages(out.headerHtml);
  if (out.footerHtml) out.footerHtml = await inlineExternalImages(out.footerHtml);

  for (const [key, value] of Object.entries(out)) {
    if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > MAX_HEADER_FOOTER_STORED_BYTES) {
      throw badRequest(`${key} exceeds ${MAX_HEADER_FOOTER_STORED_BYTES} bytes after inlining its embedded image(s)`);
    }
  }
  return out;
}

/**
 * Read-modify-write of `<slug>.folio`, changing ONLY the `export` section.
 * Blank/absent templates are REMOVED (an empty string is not a meaningful
 * header, and a file without an `export` section round-trips as "defaults"),
 * and an emptied section is dropped entirely so a space that never used the
 * feature keeps its minimal `{v, name}` file.
 *
 * A file that exists but is not JSON is refused (409) rather than clobbered:
 * whatever is in it, this endpoint must not be the thing that destroys it —
 * that is a repo-side problem for a human with git access.
 */
export async function writeSpaceExportSettings(space: string, settings: SpaceExportSettingsPayload): Promise<void> {
  const raw = await readRawFolioFile(space);
  let parsed: Record<string, unknown>;
  if (raw === undefined) {
    // No file yet (spaces predating round 22, or one whose file was removed
    // in the repo) — create the canonical minimal shape writeFolioMeta would.
    const info = await storage.getSpaceInfo(space);
    parsed = { v: 1, name: info?.name ?? space };
  } else {
    try {
      const value = JSON.parse(raw) as unknown;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      parsed = value as Record<string, unknown>;
    } catch {
      throw conflict(`${space}.folio exists but is not valid JSON — fix it in the repo before editing export settings`);
    }
  }

  const section: Record<string, string> = {};
  if (settings.headerHtml?.trim()) section.headerHtml = settings.headerHtml;
  if (settings.footerHtml?.trim()) section.footerHtml = settings.footerHtml;

  const existingExport = parsed.export;
  if (Object.keys(section).length === 0) {
    delete parsed.export;
  } else if (existingExport !== null && typeof existingExport === 'object' && !Array.isArray(existingExport)) {
    // Keep unknown keys inside the section too (a future `coverHtml`, say).
    parsed.export = { ...(existingExport as Record<string, unknown>), headerHtml: undefined, footerHtml: undefined, ...section };
    // JSON.stringify drops explicit undefineds — this removes a template the
    // admin just blanked while keeping the section's other keys.
  } else {
    parsed.export = section;
  }

  await fs.writeFile(folioFilePath(space), `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}
