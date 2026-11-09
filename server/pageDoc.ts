/**
 * The ONE place that turns an indexed page into the `PageDoc` the read routes
 * send: `GET /api/pages/:id` (session), `GET /api/share/:token` (share link)
 * and `GET /api/public/spaces/:slug/pages/:id` (public site) all call this, so
 * the three can never drift apart. Authorization is the caller's job; this
 * only reads content.
 */
import type { PageDoc } from '../shared/contracts.js';
import * as storage from './storage.js';
import type { PageIndexEntry } from './storage.js';
import * as collab from './collab.js';
import * as tables from './tables/service.js';
import { buildFormChoices } from './forms/service.js';
import { buildCanvasPayload, type CanvasReader } from './canvasView.js';
import { buildArtifactPayload } from './artifact/service.js';

/** No reader named: a canvas's file cards open nothing (the safe default; every route names its reader). */
const NOBODY: CanvasReader = { kind: 'share', pageIds: new Set() };

/** `reader` decides what a canvas's file cards show (server/canvasView.ts); every other kind ignores it. */
export async function buildPageDoc(entry: PageIndexEntry, reader: CanvasReader = NOBODY): Promise<PageDoc> {
  const meta = storage.toPageMeta(entry);
  if (entry.kind === 'doc') {
    // A live collaboration room is authoritative over the file (the debounced write may be behind).
    const markdown = collab.isDocLive(entry.id) ? (collab.getLiveText(entry.id) ?? entry.body ?? '') : await storage.readFreshDocBody(entry.id);
    const revision = collab.bodyRevision(markdown);
    return storage.isLightFootprintSpace(entry.space) ? { ...meta, markdown, bodyRevision: revision, lightFootprint: true } : { ...meta, markdown, bodyRevision: revision };
  }
  // Round 26: a table's content rides these routes as `markdown` (the whole
  // .table.md, schema included) — PageDoc is deliberately NOT extended for tables.
  if (entry.kind === 'table') return { ...meta, markdown: await tables.readTableMarkdown(entry.id) };
  // Round FORMS: same "rides as `markdown`" shape as a table; a form has no
  // collab room, so this is always the fresh file.
  // The field choices (select options, members) are resolved for THIS reader: members only for a signed-in user.
  if (entry.kind === 'form') {
    const [markdown, formChoices] = await Promise.all([storage.readFreshFormRaw(entry.id), buildFormChoices(entry, reader.kind === 'user')]);
    return { ...meta, markdown, formChoices };
  }
  // A pdf/office page's bytes ride GET /api/pages/:id/file instead — plain
  // metadata here (no markdown/svg field).
  if (entry.kind === 'pdf' || entry.kind === 'office') return { ...meta };
  // A canvas: the parsed file, its file cards resolved for this reader. Never written.
  if (entry.kind === 'canvas') return { ...meta, canvas: await buildCanvasPayload(entry, reader) };
  // A base's YAML rides GET /api/pages/:id/base/source, its rows GET /api/pages/:id/base.
  if (entry.kind === 'base') return { ...meta };
  // An artifact: its manifest and files, with signed /art URLs minted for THIS reader (state on the server only for a signed-in one).
  if (entry.kind === 'artifact') {
    return { ...meta, artifact: await buildArtifactPayload(entry, reader.kind === 'user' ? { kind: 'user', userId: reader.userId } : { kind: 'anonymous' }) };
  }
  return { ...meta, svg: await storage.readBoardSvg(entry.id) };
}
