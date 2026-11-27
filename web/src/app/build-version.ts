/**
 * Which build this tab is running, and which one the server has now.
 *
 * Every deploy renames the app's entry script and every lazy chunk
 * (`assets/index-<hash>.js`), and the old files are gone from the new image.
 * A tab left open across a deploy keeps running the old entry; the first time
 * it needs a chunk it does not have, it fails (app/stale-chunk.ts). Comparing
 * the entry it was loaded from with the one the server's build manifest names
 * now tells a tab it is stale BEFORE that happens, so it can offer a reload
 * instead of failing later (app/ui/NewVersionNotice.tsx).
 *
 * The offline reader does not cache the app shell. index.html and the
 * manifest go out `no-cache` (server/spaFallback.ts spaCacheControl) and only
 * content-hashed files are immutable, so a reload always gets a consistent
 * set — an index.html that names chunks the server lacks cannot be cached.
 */

const ENTRY_NAME = /(?:^|\/)assets\/(index-[A-Za-z0-9_-]+\.js)(?:[?#].*)?$/;

/** `index-<hash>.js` from a script address or manifest file path; null for anything else (the dev server's /src/main.tsx). */
export function entryNameOf(path: string): string | null {
  return ENTRY_NAME.exec(path)?.[1] ?? null;
}

/** The entry script this document was loaded with, e.g. `index-5T0Qpva8.js`; null in development. */
export function loadedBundleId(doc: Document = document): string | null {
  for (const script of Array.from(doc.querySelectorAll('script[type="module"][src]'))) {
    const name = entryNameOf(script.getAttribute('src') ?? '');
    if (name) return name;
  }
  return null;
}

/** The entry the server's current build manifest names; null when it cannot be told (offline, no manifest, development). */
export async function fetchLatestBundleId(): Promise<string | null> {
  try {
    const res = await fetch('/assets/manifest.json', { cache: 'no-cache', credentials: 'same-origin' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    const manifest = (await res.json()) as Record<string, { file?: string; isEntry?: boolean }>;
    const entry = manifest['index.html'];
    return entry?.file ? entryNameOf(entry.file) : null;
  } catch {
    return null;
  }
}

/** True when both builds are known and differ. */
export function isStaleBuild(loaded: string | null, latest: string | null): boolean {
  return Boolean(loaded && latest && loaded !== latest);
}
