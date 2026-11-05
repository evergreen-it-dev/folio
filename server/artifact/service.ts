/**
 * Artifacts: the operations behind the routes and the MCP tool — publish (a new
 * artifact, or a replacement of an existing one's content), the per-reader
 * PageDoc payload, the title / icon written into the manifest, and the read
 * model MCP read_page returns. Authorization is the caller's job.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactManifest, ArtifactPayload, ArtifactPublishBody, ArtifactPublishResult, PageMeta } from '../../shared/contracts.js';
import { recordAudit } from '../audit.js';
import { badRequest } from '../errors.js';
import * as gitSync from '../gitSync.js';
import * as storage from '../storage.js';
import type { PageIndexEntry } from '../storage.js';
import { translitSlug } from '../translit.js';
import { readBundleInfo, readManifestText, resolveBundleFile, writeBundleDir, writeManifestFile, type BundleInfo } from './bundle.js';
import { ArtifactImportError } from './errors.js';
import { prepareArtifactBundle, type UploadedFile } from './import.js';
import { isReservedArtifactKey, parseArtifactManifest, writeArtifactManifest } from './manifest.js';
import { artifactFileUrl, signArtifactToken } from './token.js';

export interface ArtifactActor {
  id: string;
  name: string;
  email: string;
}

function assertProperties(properties: Record<string, unknown> | undefined): void {
  if (!properties) return;
  const reserved = Object.keys(properties).find((k) => isReservedArtifactKey(k));
  if (reserved !== undefined) throw new ArtifactImportError('badPath', `${JSON.stringify(reserved)} is reserved in artifact.yaml and cannot be a property.`);
}

/** A new artifact page under `body.parentPath` of `space`. */
export async function createArtifact(space: string, body: ArtifactPublishBody, actor: ArtifactActor, upload?: UploadedFile, audit: Record<string, unknown> = {}): Promise<ArtifactPublishResult> {
  assertProperties(body.properties);
  const prepared = await prepareArtifactBundle(body, upload);
  const title = (body.title ?? prepared.derivedTitle ?? 'Artifact').trim().slice(0, 200) || 'Artifact';
  const manifest: ArtifactManifest = { folio: 'artifact', version: 1, ...prepared.manifest, title };
  assertProperties(prepared.properties);
  const manifestText = writeArtifactManifest(null, manifest, prepared.properties ?? {});
  gitSync.recordEditor(space, { name: actor.name, email: actor.email });
  const meta = await storage.createArtifactPage(space, body.parentPath ?? '', translitSlug(title) || 'artifact', (dirAbs) => writeBundleDir(dirAbs, prepared.files, manifestText));
  gitSync.noteActivity(space);
  recordAudit(actor.id, 'page.created', meta.id, { kind: 'artifact', type: manifest.type, ...audit });
  return { page: meta, warnings: prepared.warnings };
}

/**
 * Replaces the content of artifact `id` (spec §4): every file of the bundle but
 * artifact.yaml is replaced; the id, the path, the properties and title/icon are
 * kept unless the body sends new ones; the manifest's other lines stay as written.
 */
export async function replaceArtifact(id: string, body: ArtifactPublishBody, actor: ArtifactActor, upload?: UploadedFile, audit: Record<string, unknown> = {}): Promise<ArtifactPublishResult> {
  assertProperties(body.properties);
  const entry = await storage.requireEntry(id);
  if (entry.kind !== 'artifact') throw badRequest('page is not an artifact');
  const prepared = await prepareArtifactBundle(body, upload);
  assertProperties(prepared.properties);
  gitSync.recordEditor(entry.space, { name: actor.name, email: actor.email });
  const { meta } = await storage.rewriteArtifactPage(id, async (dirAbs) => {
    const previousText = await readManifestText(dirAbs);
    const previous = parseArtifactManifest(previousText, path.basename(dirAbs));
    const manifest: ArtifactManifest = {
      folio: 'artifact',
      version: 1,
      ...prepared.manifest,
      title: body.title ?? (previous.present ? previous.manifest.title : undefined) ?? prepared.derivedTitle ?? previous.manifest.title,
      icon: body.icon ?? previous.manifest.icon,
    };
    if (manifest.icon === undefined) delete manifest.icon;
    // Properties: the ones sent (or that came in a zip's manifest) replace the page's; none sent keeps them.
    const text = writeArtifactManifest(previous.parseable ? previousText : null, manifest, body.properties ?? prepared.properties);
    await writeBundleDir(dirAbs, prepared.files, text);
  });
  gitSync.noteActivity(entry.space);
  recordAudit(actor.id, 'page.artifact-replaced', id, { type: prepared.manifest.type, ...audit });
  return { page: meta, warnings: prepared.warnings };
}

/** Title and/or icon (null removes the icon) written into the manifest; the folder keeps its name. */
export async function setArtifactTitleIcon(id: string, change: { title?: string; icon?: string | null }, actor: ArtifactActor): Promise<PageMeta> {
  const entry = await storage.requireEntry(id);
  if (entry.kind !== 'artifact') throw badRequest('page is not an artifact');
  gitSync.recordEditor(entry.space, { name: actor.name, email: actor.email });
  const { meta } = await storage.rewriteArtifactPage(id, async (dirAbs) => {
    const text = await readManifestText(dirAbs);
    const parsed = parseArtifactManifest(text, path.basename(dirAbs));
    if (!parsed.parseable) throw badRequest('artifact.yaml of this page cannot be parsed as a YAML mapping; fix it in the file first');
    const manifest: ArtifactManifest = { ...parsed.manifest };
    if (change.title !== undefined) {
      const t = change.title.trim();
      if (!t) throw badRequest('title must not be empty');
      manifest.title = t.slice(0, 200);
    }
    if (change.icon === null) delete manifest.icon;
    else if (change.icon !== undefined) manifest.icon = change.icon;
    // A bundle without a manifest stays light: a title equal to its folder name is not written down.
    const next = writeArtifactManifest(text, manifest);
    if (next !== text) await writeManifestFile(dirAbs, next);
  });
  gitSync.noteActivity(entry.space);
  return meta;
}

/** Who reads a page: a signed-in user (state on the server) or a share link / public site reader. */
export type ArtifactReader = { kind: 'user'; userId: string } | { kind: 'anonymous' };

/** PageDoc.artifact for this reader: the manifest, the bundle's files and signed URLs minted for them. */
export async function buildArtifactPayload(entry: PageIndexEntry, reader: ArtifactReader): Promise<ArtifactPayload> {
  const info = await readBundleInfo(entry.absPath);
  return payloadFrom(entry, info, reader);
}

function payloadFrom(entry: PageIndexEntry, info: BundleInfo, reader: ArtifactReader): ArtifactPayload {
  const m = info.manifest;
  const token = signArtifactToken(entry.id, reader.kind === 'user' ? reader.userId : null);
  const payload: ArtifactPayload = {
    type: m.type,
    entry: m.type === 'embed' ? '' : (m.entry ?? ''),
    capabilities: m.capabilities ?? [],
    files: info.files,
    warnings: info.warnings,
    stateServer: reader.kind === 'user',
  };
  if (m.type === 'embed') {
    if (m.embed) {
      payload.embedUrl = m.embed.url;
      if (m.embed.height !== undefined) payload.embedHeight = m.embed.height;
    }
  } else if (m.entry && info.files.some((f) => f.path === m.entry)) {
    payload.src = artifactFileUrl(token, m.entry);
  }
  // Where the page came from (origin, original URL) is the owner's business: guests (share links, public site) don't get it.
  if (m.source && reader.kind === 'user') payload.source = m.source;
  if (m.source?.file && info.files.some((f) => f.path === m.source!.file)) payload.sourceSrc = artifactFileUrl(token, m.source.file);
  return payload;
}

/** Entry HTML returned by MCP read_page is cut at this many characters. */
export const READ_ENTRY_MAX_CHARS = 60_000;

/** What MCP read_page / fetch say about an artifact: the manifest, the files and the entry's HTML (truncated). */
export async function artifactReadModel(entry: PageIndexEntry): Promise<{
  manifest: ArtifactManifest;
  properties: Record<string, unknown>;
  files: Array<{ path: string; size: number }>;
  warnings: string[];
  entryHtml?: string;
  entryTruncated?: boolean;
}> {
  const info = await readBundleInfo(entry.absPath);
  const out: Awaited<ReturnType<typeof artifactReadModel>> = { manifest: info.manifest, properties: info.properties, files: info.files, warnings: info.warnings };
  if (info.manifest.type !== 'embed' && info.manifest.entry) {
    const abs = await resolveBundleFile(entry.absPath, info.manifest.entry);
    if (abs) {
      const html = await fs.readFile(abs, 'utf8').catch(() => '');
      out.entryTruncated = html.length > READ_ENTRY_MAX_CHARS;
      out.entryHtml = out.entryTruncated ? html.slice(0, READ_ENTRY_MAX_CHARS) : html;
    }
  }
  return out;
}
