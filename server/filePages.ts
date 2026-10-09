/**
 * File pages (pdf / docx / xlsx / pptx): upload validation shared by "upload a
 * file as a new page" and "replace the file of an existing page", and the
 * replace / restore-a-version operations.
 *
 * Replacing keeps the page: id, position in the tree, icon, access rules,
 * shares and stars all hang off the id, which never changes. What changes is
 * the file's bytes and, when the new file has a different extension, the last
 * part of its path (deck.pptx -> deck.pdf).
 *
 * WHY A DIFFERENT EXTENSION IS ALLOWED. Pages are addressed by id everywhere
 * the product stores a reference (access rules, share links, stars, recents,
 * the URL `/s/<space>/p/<id>`). The only references by PATH are relative
 * links inside documents — and a path change already exists as an operation
 * ("Change slug"), which rewrites every incoming link across the space. The
 * extension change reuses exactly that machinery (collab.rewriteLinksAfterMove),
 * so no link is left pointing at the old name.
 *
 * VERSIONS. Every replace is its own git commit, preceded by a commit of
 * whatever was still waiting for the quiet-period auto-commit, so the version
 * being replaced is always in the history and "Restore this version" has
 * something to restore. An extension change is two commits — a pure rename
 * (git follows it, so the history of the page continues across the rename),
 * then the new content.
 */
import path from 'node:path';
import type { PageMeta } from '../shared/contracts.js';
import { officeFormat } from '../shared/contracts.js';
import { badRequest } from './errors.js';
import * as storage from './storage.js';
import * as collab from './collab.js';
import * as gitSync from './gitSync.js';
import type { GitIdentity } from './git.js';

/**
 * Validates an uploaded file the way every file-page upload does and returns
 * its lowercase extension with the dot. Throws 400 for an unsupported name or
 * bytes that do not look like the claimed format (magic bytes: `%PDF-` for a
 * pdf, the ZIP signature for the OOXML formats).
 */
export function inspectFilePageUpload(filename: string, buffer: Buffer): string {
  const isPdfName = /\.pdf$/i.test(filename);
  const office = officeFormat(filename);
  if (!isPdfName && !office) throw badRequest('expected a .pdf, .docx, .xlsx or .pptx file');
  if (isPdfName) {
    // Magic-byte check (spec: "extension .pdf and magic bytes %PDF-") —
    // catches a mislabeled non-pdf before it's ever written to disk.
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw badRequest('not a valid pdf file (missing %PDF- header)');
    return '.pdf';
  }
  // Every OOXML format (docx/xlsx/pptx) is a ZIP archive — its magic
  // bytes are the ZIP local-file-header signature "PK\x03\x04".
  if (buffer.subarray(0, 4).toString('latin1') !== 'PK\x03\x04') throw badRequest('not a valid office file (missing PK zip header)');
  return `.${office}`;
}

export interface ReplaceFileResult {
  meta: PageMeta;
  /** The path the page had before; differs from meta.path when the extension changed. */
  previousPath: string;
  pathChanged: boolean;
  /** Commit that holds the version just replaced (what "Undo" restores); null when nothing changed or the page had no history. */
  previousSha: string | null;
}

/**
 * Any of the four file types is accepted for any file page (pdf <-> pptx is a
 * legitimate "the deck is now a PDF"); a different extension renames the file.
 */
export async function replaceFilePage(
  id: string,
  ext: string,
  bytes: Buffer,
  author: GitIdentity,
  commitMessage?: (meta: PageMeta) => string,
): Promise<ReplaceFileResult> {
  const entry = await storage.requireEntry(id);
  if (entry.kind !== 'pdf' && entry.kind !== 'office') throw badRequest('page is not a pdf/office file');
  const space = entry.space;
  const previousPath = entry.relPath;

  // What was waiting for the quiet-period auto-commit goes into its own commit
  // first (authored as before — it is not this user's change), so the version
  // being replaced is in git no matter how soon the next replace comes.
  await gitSync.commitNow(space, 'folio:update', gitSync.authorFor(space));
  gitSync.recordEditor(space, author);
  // The newest commit touching this file now holds the version about to be replaced.
  const previousSha = (await gitSync.getPageHistory(id, 1))[0]?.sha ?? null;

  if (ext.toLowerCase() !== path.posix.extname(previousPath).toLowerCase()) {
    const { moved } = await storage.changeFilePageExtension(id, ext);
    if (moved.length > 0) {
      await collab.rewriteLinksAfterMove(moved);
      await gitSync.commitNow(space, `docs: rename ${moved[0].oldRelPath} -> ${moved[0].newRelPath}`, author);
    }
  }

  const meta = await storage.writeFilePageBytes(id, bytes);
  const committed = await gitSync.commitNow(space, commitMessage ? commitMessage(meta) : `files: replace ${meta.path}`, author);
  gitSync.noteActivity(space); // the push follows the usual quiet period
  return { meta, previousPath, pathChanged: previousPath !== meta.path, previousSha: committed ? previousSha : null };
}

/** Puts a file page back to the content (and extension) it had at `sha`, as one more commit — the history keeps everything, nothing is rewritten. */
export async function restoreFilePageVersion(id: string, sha: string, author: GitIdentity): Promise<ReplaceFileResult> {
  const revision = await gitSync.getFilePageRevisionBytes(id, sha);
  const short = sha.slice(0, 7);
  return replaceFilePage(id, revision.ext, revision.bytes, author, (meta) => `files: restore ${meta.path} to ${short}`);
}
