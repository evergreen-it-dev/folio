/**
 * Round 22.09.2026 owner report (screenshot): a pasted link to a SPACE HOME
 * (`/s/<slug>`, no root index/README page) rendered as a naked URL forever
 * — `/api/resolve?space&path=` 404s in that case and the ref got stuck in
 * the `failed` set. Fixed by resolving `kind: 'space'` refs from
 * `GET /api/spaces` (the space's own `name`) instead. These two cases are
 * the ones that actually change behaviour; `kind: 'page'`/`'dir'` resolution
 * is untouched and already covered by rehypeFolioLinks.test.ts exercising
 * this module's real (non-injected) resolve/ensureResolve functions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpaceInfo } from '@shared/contracts';
import { clearFolioLinkIndex, ensureFolioLinkResolved, folioLinkFailed, onFolioLinkSettled, resolvedFolioLink } from './folioLinkIndex';
import type { FolioLinkRef } from './folioLinks';

function stubSpacesFetch(spaces: SpaceInfo[]) {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ spaces }),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Waits for the ref to settle (resolved or failed) via onFolioLinkSettled. */
function waitSettled(ref: FolioLinkRef): Promise<void> {
  return new Promise((resolve) => {
    const stop = onFolioLinkSettled(() => {
      if (resolvedFolioLink(ref) || folioLinkFailed(ref)) {
        stop();
        resolve();
      }
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearFolioLinkIndex();
});

describe('folioLinkIndex — kind: space', () => {
  it('resolves a space link to the SPACE name (not a root page title), via GET /api/spaces', async () => {
    stubSpacesFetch([{ slug: 'client-offers', name: 'Client Offers', pageCount: 3 }]);
    const ref: FolioLinkRef = { space: 'client-offers', kind: 'space' };

    ensureFolioLinkResolved(ref);
    await waitSettled(ref);

    expect(resolvedFolioLink(ref)).toEqual({ title: 'Client Offers', navPath: '/s/client-offers' });
    expect(folioLinkFailed(ref)).toBe(false);
  });

  it('degrades to the plain URL (failed, no throw) when the space is missing from /api/spaces — not a member, or gone', async () => {
    stubSpacesFetch([{ slug: 'other-space', name: 'Other', pageCount: 1 }]);
    const ref: FolioLinkRef = { space: 'client-offers', kind: 'space' };

    ensureFolioLinkResolved(ref);
    await waitSettled(ref);

    expect(folioLinkFailed(ref)).toBe(true);
    expect(resolvedFolioLink(ref)).toBeUndefined();
  });
});
