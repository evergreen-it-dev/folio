import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import * as collab from '../collab.js';
import * as storage from '../storage.js';

/**
 * Builds a portable snapshot of one space's content root. Git internals are
 * deliberately excluded; markdown, boards, tables, templates and assets are
 * preserved with their relative paths.
 */
export async function buildSpaceZip(space: string): Promise<Buffer> {
  const entries = await storage.listEntries(space);
  await Promise.all(entries.map((entry) => collab.flushDoc(entry.id)));

  const root = storage.getSpaceDir(space);
  const zip = new JSZip();

  async function addDirectory(absDir: string, relDir: string): Promise<void> {
    const names = (await fs.readdir(absDir)).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      if (name === '.git') continue;
      const abs = path.join(absDir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      const stat = await fs.lstat(abs);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) await addDirectory(abs, rel);
      else if (stat.isFile()) zip.file(rel, await fs.readFile(abs), { date: stat.mtime });
    }
  }

  await addDirectory(root, '');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
