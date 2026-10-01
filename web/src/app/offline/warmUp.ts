/**
 * Getting the board editor onto the device BEFORE it is needed.
 *
 * Excalidraw is large, so it is not part of the application's own bundle:
 * its code is fetched the first time a board is opened, and pieces of it
 * (the interface language, fonts, the image tools) only when each is first
 * used. Online that is invisible. Offline it means a board cannot be
 * opened — or opens and then fails on the first thing it has to fetch (the
 * owner, 29.09.2026: creating a board offline took the app down).
 *
 * So a few seconds after the app has settled, while the connection is good,
 * every file the board editor may ask for is fetched once. The files are
 * content-hashed and served as immutable (server/index.ts), so they stay in
 * the browser's cache across reloads and are there when the network is not.
 * Which files those are comes from the build's own manifest
 * (`build.manifest` in vite.config.ts) — never from a hand-kept list.
 */
import { quietImport } from '../stale-chunk';

interface ManifestChunk {
  file: string;
  isEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
  assets?: string[];
}
export type BuildManifest = Record<string, ManifestChunk>;

const MANIFEST_URL = '/assets/manifest.json';
const BOARD_ENTRY = /(^|\/)diagrams\/BoardCanvas\.tsx$/;
/** Excalidraw's interface languages: `uk-UA-QMV73CPH-<hash>.js`. Folio itself speaks three. */
const LOCALE_FILE = /^(?:[a-z]{2,3}(?:-[A-Z][A-Za-z]{1,3})?)-[A-Z0-9]{8}-[\w-]+\.js$/;
const KEPT_LOCALE = /^(?:en|uk-UA|ru-RU)-/;
const CONCURRENCY = 4;

/**
 * Every file the board editor can load that the application has not
 * already loaded for itself. Chunks of the app's own entry graph are
 * skipped, and — the part that matters — not followed: the entry chunk's
 * dynamic imports are the whole rest of the application (office viewers,
 * mermaid, tables), which is not what this is fetching.
 */
export function boardEditorFiles(manifest: BuildManifest): string[] {
  const keys = Object.keys(manifest);
  const entry = keys.find((key) => manifest[key].isEntry);
  const board = keys.find((key) => BOARD_ENTRY.test(key));
  if (!board) return [];

  const loadedWithApp = new Set<string>();
  const walkEntry = (key: string): void => {
    if (loadedWithApp.has(key) || !manifest[key]) return;
    loadedWithApp.add(key);
    for (const next of manifest[key].imports ?? []) walkEntry(next);
  };
  if (entry) walkEntry(entry);

  const files = new Set<string>();
  const seen = new Set<string>();
  const walkBoard = (key: string): void => {
    if (seen.has(key) || loadedWithApp.has(key) || !manifest[key]) return;
    seen.add(key);
    const chunk = manifest[key];
    for (const file of [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]) files.add(file);
    for (const next of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) walkBoard(next);
  };
  walkBoard(board);

  return [...files].filter((file) => {
    const name = file.split('/').pop() ?? file;
    return !LOCALE_FILE.test(name) || KEPT_LOCALE.test(name);
  });
}

async function fetchAll(urls: readonly string[]): Promise<boolean> {
  let ok = true;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < urls.length) {
      const url = urls[next++];
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) ok = false;
        // Read to the end: a response that is dropped half-way is not cached.
        else await res.arrayBuffer();
      } catch {
        ok = false;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  return ok;
}

/**
 * `true` when everything is on the device. `false` means "try again
 * later" — no manifest (the dev server has none), a file that did not
 * arrive, a connection that dropped in the middle.
 */
export async function warmUpBoardEditor(): Promise<boolean> {
  let files: string[] = [];
  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-cache', credentials: 'same-origin' });
    if (res.ok && (res.headers.get('content-type') ?? '').includes('json')) {
      files = boardEditorFiles((await res.json()) as BuildManifest);
    }
  } catch {
    return false;
  }
  const cached = files.length === 0 ? true : await fetchAll(files.map((file) => `/${file}`));
  // The editor itself is also put in memory: a module that is already
  // loaded needs neither the network nor the cache. The on-demand pieces
  // cannot be loaded this way — only the editor decides when to ask for them.
  const loaded = await quietImport(() => import('../../diagrams/BoardCanvas'));
  return cached && loaded !== undefined;
}
