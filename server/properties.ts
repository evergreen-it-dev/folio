/**
 * Page properties (Obsidian brief, wave 3): a document's front matter, read and
 * edited OUTSIDE the collaborative body. The collab room holds the body only
 * (storage.ts readFreshDocBody strips the block before a room is seeded), so a
 * properties save rewrites the block in the FILE, byte-preserving the body and
 * everything it does not change (frontmatter.ts writeFrontmatterKeys), under
 * the same per-page file lock as the room's write-back
 * (storage.ts rewriteDocFrontmatter / withDocFileLock).
 *
 *   GET /api/pages/:id/properties  (viewer+)  -> PagePropertiesResponse
 *   PUT /api/pages/:id/properties  (editor+, cookie or write-scope PAT) body UpdatePagePropertiesBody
 *       -> PagePropertiesResponse; 409 + the current response on an etag mismatch
 *
 * Read: the block as it is in the file now (the index row's jsonb when the file
 * cannot be read). Values go out JSON-shaped: a YAML date as `YYYY-MM-DD`, a
 * timestamp as `YYYY-MM-DDTHH:MM:SS` (UTC, as YAML reads one without a zone).
 * `foreign` lists Folio's own keys whose value Folio would not write itself
 * (owner's decision 4: `status: deprecated`, a non-numeric `order`, an empty
 * `icon`, an `id` that is not this page's); `readOnly` is `id`; `etag` is the
 * sha1 of the block's bytes (null without a block). `canEdit` is false for a
 * reader, a read-only token, a folder and a block YAML refuses.
 *
 * Not only documents (15.10.2026, owner's decision): a data table / form keeps
 * its properties in its own front matter NEXT TO the keys that define it
 * (reservedPropertyKeys.ts — never shown, never edited, never removed; a
 * reserved key sent is a 400), and a board / PDF / Office page in a sidecar
 * `.folio/<path>.props.yaml` (propsSidecar.ts; one commit per save through
 * spaceAppearance.writeFolioFile, created by the first property, deleted with
 * the last). Both are edited with the same rules as below, minus Folio's own
 * keys (`id`, `order`, … are plain keys there), and feed the same index
 * (pages_index.frontmatter, page_tags). See propertiesStoreOf.
 *
 * `status` in a light-footprint space (16.10.2026, owner's decision): an
 * Obsidian vault or a repository with files of its own uses `status:` for its
 * own workflow (`todo`, `doing`, …). There it is an ORDINARY property — any
 * value, editable, typed by `.folio/properties.json` / `.obsidian/types.json`
 * like every other key, never "foreign". Folio's own page status still reads
 * the same key the way it always did (storage.ts validStatus): exactly
 * `draft` / `published` / `archived` keep their meaning, anything else counts
 * as `published`. `folioKeys` in the response tells the client which of
 * Folio's keys are validated on the page. Native spaces keep `status` as
 * Folio's key (draft | published | archived).
 *
 * Write rules (PUT replaces the editable keys with `properties`):
 *  - `id` can never change: a different value (or one the file does not have) is a 400;
 *    leaving it out keeps it.
 *  - Folio's keys (`order`, `status`, `icon`, `cover`) are validated as Folio
 *    reads them (status draft/published/archived, a finite number, a non-empty
 *    string; a numeric string is taken as a number for `order`); sending the
 *    value the file has keeps it as is, foreign or not; `null` removes the key;
 *    leaving one out removes it — EXCEPT a foreign value, which stays unless the
 *    client sends the key (owner's decision 4: never rewrite another tool's value
 *    by omission).
 *  - `tags` / `labels:` (its Obsidian synonym): new tags are written as `tags:`;
 *    an existing `labels:` is never removed or migrated by Folio — left out it
 *    stays as it is (only an explicit `labels: null` removes it), a changed one
 *    is written in place under `labels:`, and on a page whose only list is
 *    `labels:` a `tags` sent alone (the panel's tags row, built from `labels:`)
 *    is written in place under `labels:` too. A `labels` the file does not have
 *    is written as `tags:`. Tags lose a leading `#`, empty ones and duplicates.
 *  - every other key: sent and different -> set (in place; a new key is appended
 *    to the block in the order of `properties`); sent and equal -> untouched,
 *    the file's own spelling kept; not sent -> removed. `null` writes `key:`, an
 *    empty property as Obsidian writes it. With the key's type (space types,
 *    else inferred) a numeric string becomes a number (`number`), `true`/`false`
 *    a boolean (`checkbox`), a string a one-item list (`list`/`aliases`), and a
 *    date/datetime is written unquoted (`due: 2024-05-01`) when YAML reads it
 *    back as that same value.
 *  - key order of untouched keys never changes; renaming is remove + add.
 * Nothing to change: no write, no commit, no audit row. A write: the index row
 * follows (Folio's keys, title, tags, frontmatter jsonb), the debounced
 * auto-commit is nudged like any page save, and the route records
 * `page.properties` with the changed keys.
 */
import { createHash } from 'node:crypto';
import { VERIFICATION_KEYS } from '../shared/verification.js';
import fs from 'node:fs/promises';
import type { PageKind, PagePropertiesResponse, PropertyType, UpdatePagePropertiesBody, User } from '../shared/contracts.js';
import { recordAudit } from './audit.js';
import { query, queryOne } from './db/pool.js';
import { badRequest, HttpError } from './errors.js';
import {
  folioCouldHaveWritten,
  parsedEntry,
  readFrontmatterBlock,
  renderFrontmatterEntry,
  UnparseableFrontmatterError,
  writeFrontmatterKeys,
  type FolioKey,
  type FrontmatterKeyEdit,
} from './frontmatter.js';
import type { GitIdentity } from './git.js';
import * as gitSync from './gitSync.js';
import * as pageIndex from './indexV2/store.js';
import { inferPropertyType, readDeclaredTypes } from './propertyTypes.js';
import { editSidecarText, parseSidecar, readSidecarText, sidecarRelPath, SIDECAR_SUFFIX, usesSidecar } from './propsSidecar.js';
import { ownProperties, reservedKeysOf } from './reservedPropertyKeys.js';
import { writeFolioFile } from './spaceAppearance.js';
import { readManifestText, writeManifestFile } from './artifact/bundle.js';
import { artifactOwnProperties, isReservedArtifactKey, parseArtifactManifest, writeArtifactManifest } from './artifact/manifest.js';
import path from 'node:path';
import * as storage from './storage.js';
import type { PageIndexEntry } from './storage.js';

/** Folio's keys other than `id`, which has its own rule. */
const FOLIO_VALUE_KEYS = ['order', 'status', 'icon', 'cover'] as const satisfies readonly FolioKey[];
export const READ_ONLY_PROPERTIES = ['id'] as const;
const MAX_VALUE_DEPTH = 6;

/** 409 of a save whose etag no longer matches; carries the current state for the response body. */
export class PropertiesConflictError extends HttpError {
  constructor(public current: PagePropertiesResponse) {
    super(409, 'the front matter changed since it was read');
  }
}

export function frontmatterEtag(blockText: string): string | null {
  return blockText ? createHash('sha1').update(blockText, 'utf8').digest('hex') : null;
}

// ---------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------

/** A YAML timestamp as the client sees it: `YYYY-MM-DD` at midnight UTC, else `YYYY-MM-DDTHH:MM:SS[.mmm]` (UTC). */
function dateText(d: Date): string {
  if (Number.isNaN(d.getTime())) return '';
  const iso = d.toISOString();
  if (iso.endsWith('T00:00:00.000Z')) return iso.slice(0, 10);
  return iso.replace(/\.000Z$/, '').replace(/Z$/, '');
}

/** Parsed front matter -> what the client gets (dates as text, recursively). */
export function toClientValue(value: unknown): unknown {
  if (value instanceof Date) return dateText(value);
  if (Array.isArray(value)) return value.map(toClientValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toClientValue(v)]));
  }
  return value;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, (v as Record<string, unknown>)[k]]));
    }
    return v;
  });
}

function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function hasOwn(o: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/** A key name the block can hold on one line. */
function assertKey(key: string): void {
  if (key.trim() !== key || /[\u0000-\u001f\u007f]/.test(key)) throw badRequest(`invalid property name: ${JSON.stringify(key)}`);
}

/** null, strings, finite numbers, booleans, and lists/maps of them. */
function assertValue(key: string, value: unknown, depth = 0): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
  } else if (depth < MAX_VALUE_DEPTH && Array.isArray(value)) {
    for (const item of value) assertValue(key, item, depth + 1);
    return;
  } else if (depth < MAX_VALUE_DEPTH && value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertKey(k);
      assertValue(key, v, depth + 1);
    }
    return;
  }
  throw badRequest(`invalid value for property ${JSON.stringify(key)}`);
}

/** A sent value with the key's type applied (see the module comment). */
function coerce(value: unknown, type: PropertyType): unknown {
  if (type === 'number' && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  if (type === 'checkbox' && (value === 'true' || value === 'false')) return value === 'true';
  if ((type === 'list' || type === 'aliases') && typeof value === 'string') return value === '' ? [] : [value];
  return value;
}

/** Tags as written: no leading `#`, no empty ones, no duplicates. A string is split on commas and whitespace. */
function normalizeTags(value: unknown): unknown {
  if (value === null) return null;
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : null;
  if (items === null) throw badRequest('tags must be a list of strings');
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string' && typeof item !== 'number') throw badRequest('tags must be a list of strings');
    const tag = String(item).trim().replace(/^#+/, '').trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** A Folio key's new value, validated the way Folio reads it back (storage.ts numericOrder / validStatus / validStringField). */
function folioValue(key: (typeof FOLIO_VALUE_KEYS)[number], value: unknown): unknown {
  switch (key) {
    case 'order': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n === 'number' && Number.isFinite(n)) return n;
      throw badRequest('order must be a number');
    }
    case 'status':
      if (value === 'draft' || value === 'published' || value === 'archived') return value;
      throw badRequest('status must be draft, published or archived');
    case 'icon':
    case 'cover':
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
      throw badRequest(`${key} must be a non-empty string`);
  }
}

const DATE_VALUE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

/** `key: 2024-05-01` unquoted, when YAML reads that line back as the value sent (a date, or the same string); else js-yaml's own rendering. */
function dateLines(key: string, value: unknown, type: PropertyType): string[] | undefined {
  if ((type !== 'date' && type !== 'datetime') || typeof value !== 'string' || !DATE_VALUE_RE.test(value)) return undefined;
  const [keyLine] = renderFrontmatterEntry(key, null); // `key:` with the key quoted as YAML needs
  const line = `${keyLine} ${value}`;
  try {
    const parsed = parsedEntry(key, [line]);
    if (parsed instanceof Date ? dateText(parsed) === value : parsed === value) return [line];
  } catch {
    /* js-yaml's rendering below */
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

/** Folio's keys whose current value Folio would not write itself. */
export function foreignFolioKeys(data: Record<string, unknown>, pageId: string, options: { plainStatus?: boolean } = {}): string[] {
  const out: string[] = [];
  if (hasOwn(data, 'id') && data.id !== pageId) out.push('id');
  for (const key of folioValueKeys(options.plainStatus === true)) if (hasOwn(data, key) && !folioCouldHaveWritten(key, data[key])) out.push(key);
  return out;
}

/** Folio's value keys a document's properties validate: all four, or without `status` where it is an ordinary property. */
function folioValueKeys(plainStatus: boolean): readonly (typeof FOLIO_VALUE_KEYS)[number][] {
  return plainStatus ? FOLIO_VALUE_KEYS.filter((key) => key !== 'status') : FOLIO_VALUE_KEYS;
}

/** A light-footprint space (a vault, a repository with files of its own): `status` is an ordinary property there. */
export function statusIsPlain(entry: Pick<PageIndexEntry, 'space'>): boolean {
  return storage.isLightFootprintSpace(entry.space);
}

/** `folioKeys` of the response: which of Folio's own keys are validated on this page (the module comment). */
export function folioKeysOf(entry: Pick<PageIndexEntry, 'space' | 'kind'>): string[] {
  if (propertiesStoreOf(entry.kind) !== 'frontmatter') return [];
  return ['id', ...folioValueKeys(statusIsPlain(entry))];
}

/** Effective types: the space's declared types, plus the inferred type of every key the page has that is not declared. */
function effectiveTypes(declared: Record<string, PropertyType>, properties: Record<string, unknown>): Record<string, PropertyType> {
  const types: Record<string, PropertyType> = { ...declared };
  for (const [key, value] of Object.entries(properties)) if (!types[key]) types[key] = inferPropertyType(key, value);
  return types;
}

/**
 * Where a page's properties live (15.10.2026):
 *  - 'frontmatter' — a document's own front matter (all of it, Folio's keys included);
 *  - 'embedded'    — a data table's / form's front matter, NEXT TO the keys that ARE the
 *                    table or form (RESERVED_KEYS): those are never shown, never edited and
 *                    never removed — a save edits only the page's own keys, byte-preserving;
 *  - 'sidecar'     — a board / PDF / Office page: `.folio/<path>.props.yaml` (propsSidecar.ts);
 *  - 'manifest'    — an artifact (21.10.2026): the non-reserved top-level keys of its
 *                    `artifact.yaml`, edited byte-preserving like a sidecar (artifact/manifest.ts);
 *  - 'none'        — a folder.
 */
export type PropertiesStore = 'frontmatter' | 'embedded' | 'sidecar' | 'manifest' | 'none';

export { FORM_RESERVED_KEYS, ownProperties, reservedKeysOf, TABLE_RESERVED_KEYS } from './reservedPropertyKeys.js';

export function propertiesStoreOf(kind: PageKind): PropertiesStore {
  if (kind === 'doc') return 'frontmatter';
  if (kind === 'table' || kind === 'form') return 'embedded';
  if (usesSidecar(kind)) return 'sidecar';
  if (kind === 'artifact') return 'manifest';
  return 'none';
}

/** The etag of a table's / form's own properties: their canonical JSON (a table edit that changes the schema does not touch it). */
function ownEtag(properties: Record<string, unknown>): string {
  return createHash('sha1').update(canonical(properties), 'utf8').digest('hex');
}

function sidecarEtag(text: string | null): string | null {
  return text === null ? null : createHash('sha1').update(text, 'utf8').digest('hex');
}

const NO_PROPERTIES = (readOnly: string[]): PagePropertiesResponse => ({ properties: {}, types: {}, foreign: [], readOnly, canEdit: false, etag: null });

/** What the index last saw, read-only (the file cannot be read right now). */
async function indexedResponse(entry: PageIndexEntry, declared: Record<string, PropertyType>, readOnly: string[]): Promise<PagePropertiesResponse> {
  const row = await queryOne<{ frontmatter: Record<string, unknown> | null }>('SELECT frontmatter FROM pages_index WHERE id = $1', [entry.id]);
  const properties = row?.frontmatter && typeof row.frontmatter === 'object' ? row.frontmatter : {};
  const foreign = entry.kind === 'doc' ? foreignFolioKeys(properties, entry.id, { plainStatus: statusIsPlain(entry) }) : [];
  return { properties, types: effectiveTypes(declared, properties), foreign, readOnly, canEdit: false, etag: null, folioKeys: folioKeysOf(entry) };
}

/** The file a page's properties are read from right now: the page file (doc, table, form) or its sidecar. */
interface PropertiesSource {
  /** The page file's text (doc/table/form); undefined when it cannot be read. */
  raw?: string;
  /** The sidecar's text (board/pdf/office); null when there is none. */
  sidecar?: string | null;
  /** An artifact's artifact.yaml text; null when the bundle has none. */
  manifest?: string | null;
}

async function readSource(entry: PageIndexEntry): Promise<PropertiesSource> {
  const store = propertiesStoreOf(entry.kind);
  if (store === 'frontmatter' || store === 'embedded') return { raw: await fs.readFile(entry.absPath, 'utf8').catch(() => undefined) };
  if (store === 'sidecar') return { sidecar: await readSidecarText(storage.getSpaceDir(entry.space), entry.relPath) };
  if (store === 'manifest') return { manifest: await readManifestText(entry.absPath) };
  return {};
}

async function responseFor(entry: PageIndexEntry, source: PropertiesSource, roleCanEdit: boolean): Promise<PagePropertiesResponse> {
  const store = propertiesStoreOf(entry.kind);
  if (store === 'none') return { ...NO_PROPERTIES([...READ_ONLY_PROPERTIES]), folioKeys: [] };
  const declared = (await readDeclaredTypes(entry.space)).types;

  if (store === 'sidecar') {
    const text = source.sidecar ?? null;
    const parsed = parseSidecar(text);
    const properties = toClientValue(parsed.data) as Record<string, unknown>;
    return {
      properties,
      types: effectiveTypes(declared, properties),
      foreign: [],
      readOnly: [],
      canEdit: roleCanEdit && parsed.parseable,
      etag: sidecarEtag(text),
      sidecar: sidecarRelPath(entry.relPath),
      folioKeys: [],
    };
  }

  if (store === 'manifest') {
    const parsed = parseSidecar(source.manifest ?? null);
    const properties = toClientValue(artifactOwnProperties(parsed.data)) as Record<string, unknown>;
    return { properties, types: effectiveTypes(declared, properties), foreign: [], readOnly: [], canEdit: roleCanEdit && parsed.parseable, etag: ownEtag(properties), folioKeys: [] };
  }

  const readOnly = store === 'frontmatter' ? [...READ_ONLY_PROPERTIES] : [];
  if (source.raw === undefined) return indexedResponse(entry, declared, readOnly);
  const block = readFrontmatterBlock(source.raw);
  if (store === 'embedded') {
    const own = ownProperties(entry.kind, block.data);
    const properties = toClientValue(own) as Record<string, unknown>;
    return { properties, types: effectiveTypes(declared, properties), foreign: [], readOnly, canEdit: roleCanEdit && block.parseable, etag: ownEtag(properties), folioKeys: [] };
  }
  const properties = toClientValue(block.data) as Record<string, unknown>;
  return {
    properties,
    types: effectiveTypes(declared, properties),
    foreign: foreignFolioKeys(block.data, entry.id, { plainStatus: statusIsPlain(entry) }),
    readOnly,
    canEdit: roleCanEdit && block.parseable,
    etag: frontmatterEtag(block.text),
    folioKeys: folioKeysOf(entry),
  };
}

/** GET /api/pages/:id/properties for a page the caller may read; `roleCanEdit` = editor+ with a token that may write. */
export async function readPageProperties(entry: PageIndexEntry, roleCanEdit: boolean): Promise<PagePropertiesResponse> {
  return responseFor(entry, await readSource(entry), roleCanEdit);
}

/**
 * A page's own properties as the index stores them (`pages_index.frontmatter`, page_tags): a document's whole
 * front matter, a table's / form's block without the reserved keys, a sidecar's mapping. Read from disk.
 */
export async function indexablePropertiesOf(entry: PageIndexEntry): Promise<Record<string, unknown>> {
  const source = await readSource(entry);
  const store = propertiesStoreOf(entry.kind);
  if (store === 'sidecar') return parseSidecar(source.sidecar ?? null).data;
  if (store === 'manifest') return artifactOwnProperties(parseSidecar(source.manifest ?? null).data);
  if (source.raw === undefined) return {};
  return ownProperties(entry.kind, readFrontmatterBlock(source.raw).data);
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

/**
 * The key edits that turn the block `current` (as parsed) into `sent` under
 * the write rules of the module comment. Only keys that actually change.
 */
export function planPropertyEdits(
  current: Record<string, unknown>,
  sent: Record<string, unknown>,
  declared: Record<string, PropertyType>,
  options: { folioKeys?: boolean; plainStatus?: boolean } = {},
): Map<string, FrontmatterKeyEdit> {
  // A table's / form's / sidecar's properties have no Folio keys of their own: `id`, `order`, … are plain keys there.
  const folioKeys = options.folioKeys !== false;
  // A light-footprint space's document: `status` is one of them too (the module comment).
  const valueKeys = folioKeys ? folioValueKeys(options.plainStatus === true) : [];
  const valueKeySet: ReadonlySet<string> = new Set(valueKeys);
  const client = toClientValue(current) as Record<string, unknown>;
  const present = (key: string) => hasOwn(current, key);
  const sentHas = (key: string) => hasOwn(sent, key) && sent[key] !== undefined;
  const edits = new Map<string, FrontmatterKeyEdit>();
  const remove = (key: string) => {
    if (present(key)) edits.set(key, { remove: true });
  };
  const setUnlessSame = (key: string, value: unknown, lines?: string[]) => {
    if (present(key) && same(client[key], value)) return;
    edits.set(key, lines ? { set: value, lines } : { set: value });
  };

  for (const key of Object.keys(sent)) {
    assertKey(key);
    if (sent[key] !== undefined) assertValue(key, sent[key]);
  }

  // id: immutable.
  if (folioKeys && sentHas('id') && !same(client.id, sent.id)) throw badRequest('id cannot be changed');

  // Folio's own keys.
  for (const key of valueKeys) {
    if (sentHas(key)) {
      const value = sent[key];
      if (value === null) remove(key);
      else if (!(present(key) && same(client[key], value))) setUnlessSame(key, folioValue(key, value));
    } else if (present(key) && folioCouldHaveWritten(key, current[key])) {
      remove(key); // a foreign value stays unless the client names the key
    }
  }

  // tags and its synonym `labels:` (owner's rule: Folio writes `tags:` for new tags,
  // never deletes or migrates an existing `labels:`).
  const changed = (key: string, value: unknown) => !(present(key) && same(client[key], value));
  if (sentHas('tags')) {
    // A page whose only list is `labels:` shows it as its tags row (web toDisplayProperties),
    // so an edited row comes back as `tags` alone: it is written in place under `labels:`.
    const target = !present('tags') && present('labels') && !sentHas('labels') ? 'labels' : 'tags';
    const value = normalizeTags(sent.tags);
    if (changed(target, sent.tags)) setUnlessSame(target, value);
  } else if (!(sentHas('labels') && !present('labels'))) {
    remove('tags');
  }
  if (sentHas('labels')) {
    if (sent.labels === null && present('labels')) remove('labels');
    else if (present('labels')) {
      if (changed('labels', sent.labels)) setUnlessSame('labels', normalizeTags(sent.labels));
    } else if (sent.labels !== null) {
      // No `labels:` in the file: new tags are written as `tags:` (joined to the sent tags, if any).
      const extra = normalizeTags(sent.labels) as string[];
      const base = sentHas('tags') ? ((normalizeTags(sent.tags) as string[] | null) ?? []) : [];
      const merged = normalizeTags([...base, ...extra]);
      if (changed('tags', merged)) edits.set('tags', { set: merged });
    }
  }
  // `labels` not sent: kept as the file has it (never removed by omission).

  // Everything else: the file's keys first (kept or removed), then the new ones in the order they were sent.
  const special = (key: string) => key === 'tags' || key === 'labels' || (folioKeys && (key === 'id' || valueKeySet.has(key)));
  const keys = [...Object.keys(current), ...Object.keys(sent).filter((k) => !present(k))];
  for (const key of keys) {
    if (special(key)) continue;
    if (!sentHas(key)) {
      remove(key);
      continue;
    }
    const raw = sent[key];
    if (present(key) && same(client[key], raw)) continue;
    const type = declared[key] ?? inferPropertyType(key, present(key) ? client[key] : raw);
    const value = coerce(raw, type);
    setUnlessSame(key, value, dateLines(key, value, type));
  }
  // New keys are appended in the order the client sent them (tags included); in-place edits and removals do not
  // depend on the order.
  const sentOrder = Object.keys(sent);
  const rank = (key: string) => {
    const i = sentOrder.indexOf(key === 'labels' && !sentOrder.includes('labels') ? 'tags' : key);
    return i === -1 ? sentOrder.length : i;
  };
  return new Map([...edits].sort(([a], [b]) => rank(a) - rank(b)));
}

export interface PropertiesWriteResult {
  response: PagePropertiesResponse;
  written: boolean;
  /** Keys set or removed by this save. */
  keys: string[];
}

/** A key of the table's / form's own definition sent as a property: refused, never written. */
export function assertNoReservedKey(kind: PageKind, sent: Record<string, unknown>): void {
  const reserved = reservedKeysOf(kind);
  if (!reserved) return;
  const key = Object.keys(sent).find((k) => reserved.has(k));
  if (key !== undefined) throw badRequest(`${JSON.stringify(key)} is reserved by Folio on a ${kind === 'table' ? 'data table' : kind === 'form' ? 'form' : 'artifact (artifact.yaml)'}`);
}

/**
 * PUT /api/pages/:id/properties for a page the caller may edit (the route checks the role and the token scope).
 * `actor` is who a sidecar's commit is attributed to (a document's / table's / form's file rides the debounced
 * auto-commit like any page save).
 */
export async function updatePageProperties(pageId: string, body: UpdatePagePropertiesBody, roleCanEdit: boolean, actor?: GitIdentity): Promise<PropertiesWriteResult> {
  const entry = await storage.requireEntry(pageId);
  const store = propertiesStoreOf(entry.kind);
  if (store === 'none') throw badRequest('this page has no properties');
  if (store === 'embedded') return updateEmbeddedProperties(entry, body, roleCanEdit);
  if (store === 'sidecar') return updateSidecarProperties(entry, body, roleCanEdit, actor ?? { name: 'Folio', email: 'folio@localhost' });
  if (store === 'manifest') return updateManifestProperties(entry, body, roleCanEdit);

  let keys: string[] = [];
  const { entry: written_entry, written } = await storage.rewriteDocFrontmatter(pageId, async (raw, current) => {
    const block = readFrontmatterBlock(raw);
    if (!block.parseable) throw badRequest('the front matter of this page cannot be parsed; fix it in the file first');
    if (body.etag !== undefined && body.etag !== frontmatterEtag(block.text)) {
      throw new PropertiesConflictError(await responseFor(current, { raw }, roleCanEdit));
    }
    const declared = (await readDeclaredTypes(current.space)).types;
    const edits = planPropertyEdits(block.data, body.properties, declared, { plainStatus: statusIsPlain(current) });
    keys = [...edits.keys()];
    if (edits.size === 0) return null;
    try {
      return writeFrontmatterKeys(raw, edits);
    } catch (err) {
      if (err instanceof UnparseableFrontmatterError) throw badRequest('the front matter of this page cannot be parsed; fix it in the file first');
      throw err;
    }
  });
  return { response: await readPageProperties(written_entry, roleCanEdit), written, keys: written ? keys : [] };
}

/** A table / form: the page's own keys of its block, the reserved ones untouched byte for byte. */
async function updateEmbeddedProperties(entry: PageIndexEntry, body: UpdatePagePropertiesBody, roleCanEdit: boolean): Promise<PropertiesWriteResult> {
  assertNoReservedKey(entry.kind, body.properties);
  let keys: string[] = [];
  let own: Record<string, unknown> = {};
  const { entry: current, written } = await storage.rewriteTableFormFrontmatter(entry.id, async (raw, fresh) => {
    const block = readFrontmatterBlock(raw);
    if (!block.parseable) throw badRequest('the front matter of this page cannot be parsed; fix it in the file first');
    const data = ownProperties(fresh.kind, block.data);
    if (body.etag !== undefined && body.etag !== ownEtag(toClientValue(data) as Record<string, unknown>)) {
      throw new PropertiesConflictError(await responseFor(fresh, { raw }, roleCanEdit));
    }
    const declared = (await readDeclaredTypes(fresh.space)).types;
    const edits = planPropertyEdits(data, body.properties, declared, { folioKeys: false });
    keys = [...edits.keys()];
    if (edits.size === 0) return null;
    try {
      const next = writeFrontmatterKeys(raw, edits);
      own = ownProperties(fresh.kind, readFrontmatterBlock(next).data);
      return next;
    } catch (err) {
      if (err instanceof UnparseableFrontmatterError) throw badRequest('the front matter of this page cannot be parsed; fix it in the file first');
      throw err;
    }
  });
  if (written) await pageIndex.reindexSavedPage({ id: current.id, space: current.space, relPath: current.relPath }, '', own);
  return { response: await readPageProperties(current, roleCanEdit), written, keys: written ? keys : [] };
}

/** A board / PDF / Office page: its `.folio/<path>.props.yaml`, one commit of that file. */
async function updateSidecarProperties(entry: PageIndexEntry, body: UpdatePagePropertiesBody, roleCanEdit: boolean, actor: GitIdentity): Promise<PropertiesWriteResult> {
  let keys: string[] = [];
  let data: Record<string, unknown> = {};
  const written = await writeFolioFile(entry.space, actor, `${entry.relPath}${SIDECAR_SUFFIX}`, async (current) => {
    // The page may have moved while the lock was awaited: re-read where it is now.
    const fresh = await storage.requireEntry(entry.id);
    if (fresh.relPath !== entry.relPath) throw new PropertiesConflictError(await readPageProperties(fresh, roleCanEdit));
    const text = current?.content ?? null;
    const parsed = parseSidecar(text);
    if (!parsed.parseable) throw badRequest(`${sidecarRelPath(entry.relPath)} cannot be parsed as a YAML mapping; fix it in the file first`);
    if (body.etag !== undefined && body.etag !== sidecarEtag(text)) {
      throw new PropertiesConflictError(await responseFor(fresh, { sidecar: text }, roleCanEdit));
    }
    const declared = (await readDeclaredTypes(entry.space)).types;
    const edits = planPropertyEdits(parsed.data, body.properties, declared, { folioKeys: false });
    keys = [...edits.keys()];
    if (edits.size === 0) return null;
    const next = editSidecarText(text, edits);
    data = parseSidecar(next).data;
    return next;
  });
  if (written) {
    await query('UPDATE pages_index SET updated_at = $2 WHERE id = $1', [entry.id, new Date().toISOString()]);
    await storage.reindexSidecarProperties(entry, data);
  }
  return { response: await readPageProperties(entry, roleCanEdit), written, keys: written ? keys : [] };
}

/** An artifact: the non-reserved keys of its artifact.yaml (made when the bundle has none), every other byte kept. */
async function updateManifestProperties(entry: PageIndexEntry, body: UpdatePagePropertiesBody, roleCanEdit: boolean): Promise<PropertiesWriteResult> {
  const reserved = Object.keys(body.properties).find((k) => isReservedArtifactKey(k));
  if (reserved !== undefined) throw badRequest(`${JSON.stringify(reserved)} is reserved by Folio in artifact.yaml`);
  let keys: string[] = [];
  const { meta, result: written } = await storage.rewriteArtifactPage(entry.id, async (dirAbs, fresh) => {
    const text = await readManifestText(dirAbs);
    const parsed = parseSidecar(text);
    if (!parsed.parseable) throw badRequest('artifact.yaml of this page cannot be parsed as a YAML mapping; fix it in the file first');
    const own = artifactOwnProperties(parsed.data);
    if (body.etag !== undefined && body.etag !== ownEtag(toClientValue(own) as Record<string, unknown>)) {
      throw new PropertiesConflictError(await responseFor(fresh, { manifest: text }, roleCanEdit));
    }
    const declared = (await readDeclaredTypes(fresh.space)).types;
    const edits = planPropertyEdits(own, body.properties, declared, { folioKeys: false });
    keys = [...edits.keys()];
    if (edits.size === 0) return false;
    // No manifest yet: the one Folio would write for this bundle as it is, then the properties on top.
    const base = text ?? writeArtifactManifest(null, parseArtifactManifest(null, path.basename(dirAbs)).manifest);
    await writeManifestFile(dirAbs, editSidecarText(base, edits));
    return true;
  });
  const current = await storage.requireEntry(meta.id);
  return { response: await readPageProperties(current, roleCanEdit), written, keys: written ? keys : [] };
}

interface PageStamp {
  updatedAt: string;
  mtime: Date | null;
}

/** updated_at (from the index) and, for a file-backed front matter, the file's mtime - as they are right now. */
async function stampOf(entry: PageIndexEntry): Promise<PageStamp | null> {
  const row = await queryOne<{ updated_at: string }>('SELECT updated_at FROM pages_index WHERE id = $1', [entry.id]);
  if (!row) return null;
  let mtime: Date | null = null;
  if (propertiesStoreOf(entry.kind) === 'frontmatter' || propertiesStoreOf(entry.kind) === 'embedded') {
    mtime = await fs.stat(entry.absPath).then((st) => st.mtime, () => null);
  }
  return { updatedAt: new Date(row.updated_at).toISOString(), mtime };
}

/**
 * Puts updated_at - and the file's mtime, which the next scan turns into updated_at again - back. A failure only
 * costs the "verified" badge a flip to "changed", so it is logged and never thrown.
 */
async function restoreStamp(entry: PageIndexEntry, stamp: PageStamp): Promise<void> {
  try {
    await query('UPDATE pages_index SET updated_at = $2 WHERE id = $1', [entry.id, stamp.updatedAt]);
    if (stamp.mtime) await fs.utimes(entry.absPath, stamp.mtime, stamp.mtime);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[properties] could not restore updated_at of ${entry.id}:`, err);
  }
}

/**
 * PUT /api/pages/:id/properties and MCP set_page_properties for a page the caller may edit (the caller has checked the
 * role and the token scope): records the editor, writes, nudges the debounced auto-commit and audits the changed keys.
 * Throws PropertiesConflictError (409) on an etag mismatch and a 400 HttpError for a refused value or key.
 */
export async function savePageProperties(entry: PageIndexEntry, user: Pick<User, 'id' | 'name' | 'email'>, body: UpdatePagePropertiesBody, audit: Record<string, unknown> = {}): Promise<PropertiesWriteResult> {
  if (propertiesStoreOf(entry.kind) === 'none') throw badRequest('this page has no properties');
  gitSync.recordEditor(entry.space, { name: user.name, email: user.email });
  // A board's / file's sidecar is committed by the write itself (attributed to the caller); a document's,
  // table's or form's file rides the debounced auto-commit like any page save.
  const before = await stampOf(entry);
  const result = await updatePageProperties(entry.id, body, true, { name: user.name, email: user.email });
  // Confirming a page (or changing its owner / deadline) is not an edit of its text: keep updated_at where it was,
  // or the page would show "changed after verification" the moment it was verified.
  if (result.written && before && result.keys.length > 0 && result.keys.every((k) => (VERIFICATION_KEYS as readonly string[]).includes(k))) {
    await restoreStamp(entry, before);
  }
  if (result.written) {
    gitSync.noteActivity(entry.space);
    recordAudit(user.id, 'page.properties', entry.id, { keys: result.keys, ...audit });
  }
  return result;
}

/**
 * A PATCH of a page's properties as the whole map PUT wants it: `current` (what the page has) with the keys of
 * `patch` set, and a `null` in `patch` removing the key. Everything the patch does not name is sent back as it is, so
 * a foreign value, a `labels:` list or a key's own spelling stays untouched.
 *
 * `tags` on a page whose only list is `labels:` replaces that list in place (the panel's rule): `labels` is then left
 * out of the map instead of being sent next to a new `tags`.
 */
export function mergePropertyPatch(kind: PageKind, current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const store = propertiesStoreOf(kind);
  if (store === 'frontmatter' && hasOwn(patch, 'id') && !same(patch.id, current.id)) throw badRequest('id cannot be changed');
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  if (hasOwn(patch, 'tags') && patch.tags !== null && !hasOwn(patch, 'labels') && !hasOwn(current, 'tags') && hasOwn(current, 'labels')) delete merged.labels;
  return merged;
}
