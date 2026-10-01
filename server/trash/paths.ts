/**
 * Trash round: the one place server/trash/* resolves `trash_items.trash_path`
 * against a filesystem root. In production this is always storage.TRASH_DIR
 * (data/.trash — the exact directory deletePage has always moved targets
 * into); the test override exists so the BACKFILL suite can point the
 * scanner/restore at a scratch directory instead of the real data/.trash,
 * which on a dev machine contains genuine leftovers this repo's rules forbid
 * touching. Same test-only escape-hatch pattern as
 * session.__resetLoginRateLimitForTests.
 */
import { TRASH_DIR } from '../storage.js';

let trashRoot = TRASH_DIR;

export function getTrashRoot(): string {
  return trashRoot;
}

/** Test-only. Pass null to restore the real data/.trash root. */
export function __setTrashRootForTests(dir: string | null): void {
  trashRoot = dir ?? TRASH_DIR;
}
