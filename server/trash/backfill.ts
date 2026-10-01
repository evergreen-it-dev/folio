/**
 * Trash round, spec item 3: best-effort backfill of a PRE-EXISTING
 * data/.trash/** into `trash_items` at boot. Every deletion before this
 * round moved files into data/.trash without recording anything, so the
 * owner's already-deleted pages must show up in the new trash UI too.
 *
 * Everything here is reconstruction from the on-disk layout deletePage has
 * always produced (`<stamp>/<space>/<path-inside-space>`):
 *   - deleted_at — parsed back out of the stamp directory's name (an ISO
 *     timestamp with ':' and '.' replaced by '-'), falling back to the
 *     directory's mtime;
 *   - page_id — frontmatter `id:` for docs/tables, the leading
 *     `<!-- folio-id: … -->` comment for boards (storage.extractBoardId,
 *     the same reader scanSpace uses);
 *   - title — first H1, else the filename;
 *   - deleted_by — always null (nobody recorded who);
 *   - payload — always null: there is no membership snapshot to
 *     reconstruct for a pre-round space deletion, so restoring one brings
 *     the files back but memberships must be re-granted by hand.
 *
 * Which node inside `<stamp>/<space>/` was THE deleted target is inferred:
 * deletePage mkdir's only the parent chain of the target, so a single-page
 * deletion is a strict single-child chain down to one file, while a
 * directory deletion ends at a directory holding several entries (or an
 * index.md). Genuinely ambiguous layouts (a deleted directory whose entire
 * content was one file) are recorded as the deeper node — restoring it
 * recreates the identical files either way. A whole-space deletion is
 * recognized by content sitting directly under `<stamp>/<space>/` (its
 * index.md, or multiple top-level entries).
 *
 * Best-effort by spec: any unparseable/garbage stamp directory is logged
 * and skipped, never fatal. Idempotent across restarts via the UNIQUE
 * trash_path + ON CONFLICT DO NOTHING.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';
import * as matterNS from 'gray-matter';
import { extractBoardId, extractH1 } from '../storage.js';
import { officeFormat } from '../../shared/contracts.js';
import { query } from '../db/pool.js';
import { getTrashRoot } from './paths.js';

// Same CJS interop fallback storage.ts documents for gray-matter.
const matter = (typeof matterNS === 'function' ? matterNS : (matterNS as unknown as { default: typeof matterNS }).default) as typeof matterNS;

const STAMP_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

function parseStamp(name: string): Date | null {
  const m = STAMP_RE.exec(name);
  if (!m) return null;
  const date = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function humanizeSlug(slug: string): string {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

async function listVisible(dir: string): Promise<Dirent[]> {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  // Dotfiles (.DS_Store and friends) were never pages and must not skew the
  // single-child-chain detection below.
  return dirents.filter((d) => !d.name.startsWith('.'));
}

/** Counts page FILES (md incl. .table.md, .excalidraw.svg) in a subtree — same skip rules as scanSpace (assets/, dotfiles). */
async function countPageFiles(absDir: string): Promise<number> {
  let count = 0;
  let dirents: Dirent[];
  try {
    dirents = await listVisible(absDir);
  } catch {
    return 0;
  }
  for (const d of dirents) {
    if (d.name === 'assets') continue;
    const abs = path.join(absDir, d.name);
    if (d.isDirectory()) {
      count += await countPageFiles(abs);
    } else if (d.isFile()) {
      const lower = d.name.toLowerCase();
      if (lower.endsWith('.md') || lower.endsWith('.excalidraw.svg') || lower.endsWith('.pdf') || officeFormat(lower)) count++;
    }
  }
  return count;
}

interface DetectedTarget {
  /** '' when the space dir itself is the target (kind space). */
  relInside: string;
  shape: 'space' | 'folder' | 'file';
}

async function detectTarget(spaceDirAbs: string): Promise<DetectedTarget | null> {
  const top = await listVisible(spaceDirAbs);
  if (top.length === 0) return null;
  if (top.some((d) => d.isFile() && (d.name === 'index.md' || d.name === 'README.md')) || top.length > 1) {
    return { relInside: '', shape: 'space' }; // content sits directly at the space level -> the whole content root moved here
  }
  const only = top[0];
  if (only.isFile()) return { relInside: only.name, shape: 'file' };

  // Single-directory chain: descend until the deleted node reveals itself.
  let rel = only.name;
  let cur = path.join(spaceDirAbs, only.name);
  for (;;) {
    const entries = await listVisible(cur);
    if (entries.length === 0) return { relInside: rel, shape: 'folder' }; // empty dir was the target
    if (entries.some((d) => d.isFile() && (d.name === 'index.md' || d.name === 'README.md')) || entries.length > 1) {
      return { relInside: rel, shape: 'folder' };
    }
    const child = entries[0];
    if (child.isFile()) return { relInside: `${rel}/${child.name}`, shape: 'file' };
    rel = `${rel}/${child.name}`;
    cur = path.join(cur, child.name);
  }
}

interface BackfillFields {
  pageId: string | null;
  kind: 'doc' | 'board' | 'table' | 'pdf' | 'office' | 'form' | 'folder' | 'space';
  title: string;
  childrenCount: number;
}

/** id + title of a doc/table file, tolerant of broken YAML/garbage (null id / filename title, never a throw). */
async function readDocIdTitle(absFile: string, stem: string): Promise<{ id: string | null; title: string }> {
  let raw: string;
  try {
    raw = await fs.readFile(absFile, 'utf8');
  } catch {
    return { id: null, title: stem };
  }
  try {
    const parsed = matter(raw);
    const id = typeof parsed.data.id === 'string' && parsed.data.id ? parsed.data.id : null;
    return { id, title: extractH1(parsed.content) ?? stem };
  } catch {
    return { id: null, title: extractH1(raw) ?? stem };
  }
}

async function fieldsForFile(absFile: string, relInside: string): Promise<BackfillFields | null> {
  const base = path.basename(relInside);
  const lower = base.toLowerCase();
  if (lower.endsWith('.excalidraw.svg')) {
    let id: string | null = null;
    try {
      id = extractBoardId(await fs.readFile(absFile, 'utf8'));
    } catch {
      id = null;
    }
    return { pageId: id, kind: 'board', title: base.slice(0, -'.excalidraw.svg'.length), childrenCount: 0 };
  }
  if (lower.endsWith('.table.md')) {
    const { id, title } = await readDocIdTitle(absFile, base.slice(0, -'.table.md'.length));
    return { pageId: id, kind: 'table', title, childrenCount: 0 };
  }
  if (lower.endsWith('.form.md')) {
    // readDocIdTitle's extractH1 fallback won't find a form's title (it lives
    // in frontmatter `title:`, not an H1) — degrades to the filename stem,
    // acceptable for this rare boot-recovery path (the id, the part that
    // actually matters for restore, is still read correctly).
    const { id, title } = await readDocIdTitle(absFile, base.slice(0, -'.form.md'.length));
    return { pageId: id, kind: 'form', title, childrenCount: 0 };
  }
  if (lower.endsWith('.md')) {
    const { id, title } = await readDocIdTitle(absFile, base.slice(0, -'.md'.length));
    return { pageId: id, kind: 'doc', title, childrenCount: 0 };
  }
  if (lower.endsWith('.pdf')) {
    // A PDF carries no id in its bytes (storage.ts "Binary page files") — nothing to recover from the file.
    return { pageId: null, kind: 'pdf', title: base.slice(0, -'.pdf'.length), childrenCount: 0 };
  }
  const office = officeFormat(lower);
  if (office) {
    // Same story as a PDF — a docx/xlsx/pptx carries no id in its bytes either.
    return { pageId: null, kind: 'office', title: base.slice(0, -(office.length + 1)), childrenCount: 0 };
  }
  return null; // not a page file — nothing to record
}

async function fieldsForDir(absDir: string, fallbackTitle: string, shape: 'folder' | 'space'): Promise<BackfillFields> {
  let indexId: string | null = null;
  let title = fallbackTitle;
  let hasIndex = false;
  for (const name of ['index.md', 'README.md']) {
    try {
      await fs.access(path.join(absDir, name));
    } catch {
      continue;
    }
    hasIndex = true;
    const read = await readDocIdTitle(path.join(absDir, name), fallbackTitle);
    indexId = read.id;
    title = read.title;
    break;
  }
  const pages = await countPageFiles(absDir);
  return { pageId: indexId, kind: shape, title, childrenCount: Math.max(0, pages - (hasIndex ? 1 : 0)) };
}

/**
 * Scans `rootDir` (default: the real data/.trash) and records every
 * not-yet-known deletion. Returns counts for logging/tests. Never throws
 * for content-level garbage; only a totally unreadable root surfaces as 0s.
 */
export async function backfillTrashFromDisk(rootDir = getTrashRoot()): Promise<{ scanned: number; recorded: number }> {
  let stampDirs: Dirent[];
  try {
    stampDirs = (await fs.readdir(rootDir, { withFileTypes: true })).filter((d) => d.isDirectory());
  } catch {
    return { scanned: 0, recorded: 0 }; // no data/.trash at all — nothing ever deleted
  }

  let scanned = 0;
  let recorded = 0;
  for (const stampDir of stampDirs) {
    const stampAbs = path.join(rootDir, stampDir.name);
    let deletedAt = parseStamp(stampDir.name);
    try {
      if (!deletedAt) deletedAt = (await fs.stat(stampAbs)).mtime;
      const spaceDirs = (await listVisible(stampAbs)).filter((d) => d.isDirectory());
      for (const spaceDir of spaceDirs) {
        scanned++;
        try {
          const spaceAbs = path.join(stampAbs, spaceDir.name);
          const target = await detectTarget(spaceAbs);
          if (!target) continue;

          const targetAbs = target.relInside ? path.join(spaceAbs, target.relInside) : spaceAbs;
          let fields: BackfillFields | null;
          if (target.shape === 'file') {
            fields = await fieldsForFile(targetAbs, target.relInside);
          } else if (target.shape === 'folder') {
            fields = await fieldsForDir(targetAbs, humanizeSlug(path.basename(target.relInside)), 'folder');
          } else {
            fields = await fieldsForDir(targetAbs, humanizeSlug(spaceDir.name), 'space');
          }
          if (!fields) continue;

          const trashPath = target.relInside ? `${stampDir.name}/${spaceDir.name}/${target.relInside}` : `${stampDir.name}/${spaceDir.name}`;
          // For kind='space' the contract's pageId is the slug; a file/folder
          // with no recoverable id gets a synthetic one — it only serves as a
          // stable reference until restore, when scanSpace re-reads the real
          // ids from the files themselves.
          const pageId = fields.kind === 'space' ? spaceDir.name : (fields.pageId ?? `trash-${stampDir.name}-${spaceDir.name}`.slice(0, 60));
          const inserted = await query<{ id: string }>(
            `INSERT INTO trash_items (space_slug, page_id, kind, orig_path, title, deleted_by, deleted_at, trash_path, children_count, payload)
             VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,NULL)
             ON CONFLICT (trash_path) DO NOTHING
             RETURNING id`,
            [spaceDir.name, pageId, fields.kind, target.relInside, fields.title, deletedAt, trashPath, fields.childrenCount],
          );
          recorded += inserted.length;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[trash] backfill: skipping ${stampDir.name}/${spaceDir.name}:`, err);
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[trash] backfill: skipping stamp dir ${stampDir.name}:`, err);
    }
  }
  if (recorded > 0) {
    // eslint-disable-next-line no-console
    console.log(`[trash] backfill: recorded ${recorded} pre-existing deletion(s) from ${rootDir}`);
  }
  return { scanned, recorded };
}
