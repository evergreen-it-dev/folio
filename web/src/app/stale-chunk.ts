import { getConnectivity } from './offline/connectivity';

/**
 * A deploy replaces every hashed chunk under /assets/ — a tab left open
 * across that deploy can ask for a chunk (a mermaid diagram type, TableGrid,
 * BoardCanvas, ...) that's simply gone. The browsers word the resulting
 * failure differently, but it's always the same situation: the loaded
 * bundle is stale, and a reload fetches the new one. Vite fires its own
 * `vite:preloadError` window event for exactly this case (see main.tsx),
 * but the same failure can also surface as a plain rejected `import()` —
 * e.g. inside mermaid's own lazy diagram-type loading (diagrams/MermaidBlock)
 * or a `lazy()` component's error boundary (editor/mermaid-visual.tsx) — so
 * detection lives here as a standalone check, not tied to that one event.
 *
 * server/spaFallback.ts's companion fix (an `/assets/*` miss now answers 404
 * instead of index.html+200) is what makes the browser word it this way at
 * all, rather than trying to execute HTML as a module and producing some
 * third, even less legible error.
 */

const STALE_CHUNK_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /unable to preload css/i,
];

/** True for any of the known "the bundle on disk moved on without us" browser messages. */
export function isStaleChunkError(error: unknown): boolean {
  return STALE_CHUNK_PATTERNS.some((pattern) => pattern.test(messageOf(error)));
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  // vite:preloadError's `event.payload` is itself typically an Error, but
  // guard the general CustomEvent/unknown shape too.
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return '';
}

const RELOAD_FLAG = 'folio:stale-chunk-reload';

function isOffline(): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  return getConnectivity() === 'offline';
}

let quiet = 0;

/**
 * A dynamic import made ahead of need (offline mode warms up the board
 * editor while there still is a network). Its failure is nobody's problem:
 * no reload, no rejection — `undefined`, and the real import, when someone
 * actually needs the module, gets its own attempt and its own error.
 */
export async function quietImport<T>(load: () => Promise<T>): Promise<T | undefined> {
  quiet += 1;
  try {
    return await load();
  } catch {
    return undefined;
  } finally {
    quiet -= 1;
  }
}

function alreadyReloaded(): boolean {
  try {
    return sessionStorage.getItem(RELOAD_FLAG) === '1';
  } catch {
    // sessionStorage unavailable (private mode, disabled storage) — treat as
    // "not yet reloaded"; worst case a genuinely broken deploy reloads on
    // every stale-chunk error instead of stopping after one, which is still
    // better than the dead red banner this replaces.
    return false;
  }
}

function markReloaded(): void {
  try {
    sessionStorage.setItem(RELOAD_FLAG, '1');
  } catch {
    // ignore — see alreadyReloaded()
  }
}

/** Call once the app has actually rendered — a real load means the reload (if any) worked. */
export function clearStaleChunkReloadFlag(): void {
  try {
    sessionStorage.removeItem(RELOAD_FLAG);
  } catch {
    // ignore — see alreadyReloaded()
  }
}

/**
 * If `error` looks like a stale-chunk failure and this tab hasn't already
 * tried reloading for one, reloads the page (once) and returns `true` — the
 * caller should stop, the page is on its way out. Returns `false` either
 * because `error` isn't a stale-chunk error, or because a reload already
 * happened and didn't help (a real outage, not a stale tab) — the caller
 * should show its own error text instead of looping forever.
 */
export function tryReloadForStaleChunk(error: unknown): boolean {
  if (!isStaleChunkError(error)) return false;
  // Offline, the very same browser message means something else entirely:
  // the chunk is not stale, it is unreachable. A reload then does not fetch a
  // newer bundle — it replaces a working application with the browser's
  // "no internet" page, taking the author's offline work off the screen with
  // it (the owner, 29.09.2026: "an attempt to create a board offline led to
  // everything disappearing"). Same for an import made in the background
  // (`quietImport`): nobody asked for it, so nobody's page reloads over it.
  if (quiet > 0 || isOffline()) return false;
  if (alreadyReloaded()) return false;
  markReloaded();
  window.location.reload();
  return true;
}

/** Vite's own signal for a failed/aborted dynamic import or CSS preload — see the module doc comment. */
export function installStaleChunkListener(): void {
  // Vite types this event itself (VitePreloadErrorEvent): `payload` is the
  // rejected import()'s error, which is what the detector wants.
  window.addEventListener('vite:preloadError', (event) => {
    tryReloadForStaleChunk(event.payload ?? event);
  });
}
