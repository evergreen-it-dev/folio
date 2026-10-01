/**
 * Boot-time page indexing, in the BACKGROUND, one space at a time, with each
 * space isolated from the next.
 *
 * The incident this exists for (prod, 15.09): startup awaited
 * storage.scanAllSpaces() BEFORE app.listen, and scanned every space in one
 * unguarded loop. After a sync finally managed to merge a large backlog of
 * remote changes into the working copies, re-indexing got heavy — and a single
 * space's scan throwing rejected main() outright. The process died about a
 * minute into every start, never having opened its port: health was 503 on
 * every image, the known-good one included, because the trigger lived in the
 * data volume rather than in the code. Nothing on the host could be read (no
 * logs through the Coolify API, no shell access), so the failure was invisible
 * as well as fatal.
 *
 * Three changes, all here or at the call site in index.ts:
 *  - the server opens its port first; indexing happens after, so the app is
 *    reachable (and health answers) while it catches up;
 *  - a space whose scan fails is recorded and skipped, never the end of the
 *    boot;
 *  - the per-space outcome is kept in memory and exposed to instance admins
 *    (GET /api/admin/boot-scan), so the next failure can be read over HTTP.
 */
import * as storage from './storage.js';

export interface BootScanSpaceResult {
  slug: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface BootScanStatus {
  startedAt: string | null;
  finishedAt: string | null;
  /** The space being indexed right now, if any. */
  current: string | null;
  total: number;
  results: BootScanSpaceResult[];
}

const status: BootScanStatus = { startedAt: null, finishedAt: null, current: null, total: 0, results: [] };

export function getBootScanStatus(): BootScanStatus {
  return { ...status, results: [...status.results] };
}

/**
 * Indexes every given space, never throwing. `scanOne` is injectable so the
 * isolation rule can be tested without a database.
 */
export async function runBootScan(
  slugs: readonly string[],
  scanOne: (slug: string) => Promise<unknown> = storage.scanSpaceForBoot,
): Promise<BootScanStatus> {
  status.startedAt = new Date().toISOString();
  status.finishedAt = null;
  status.total = slugs.length;
  status.results = [];

  for (const slug of slugs) {
    status.current = slug;
    const started = Date.now();
    try {
      await scanOne(slug);
      status.results.push({ slug, ok: true, ms: Date.now() - started });
    } catch (err) {
      const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
      status.results.push({ slug, ok: false, ms: Date.now() - started, error: message });
      // eslint-disable-next-line no-console
      console.error(`[boot-scan] ${slug}: failed, skipping — ${message}`);
    }
  }

  status.current = null;
  status.finishedAt = new Date().toISOString();
  const failed = status.results.filter((r) => !r.ok).length;
  // eslint-disable-next-line no-console
  console.log(`[boot-scan] done: ${status.results.length - failed}/${status.results.length} spaces indexed${failed ? `, ${failed} failed` : ''}`);
  return getBootScanStatus();
}
