/**
 * Picks which REST endpoints a board talks to: the authenticated per-page
 * routes normally, or the public per-token share routes when a share link is
 * in play. Pure and dependency-free so it's trivial to unit test in
 * isolation from the fetch/Excalidraw/React plumbing that consumes it.
 *
 * Share routes (round 8, shared/contracts.ts): GET /api/share/:token returns
 * a SharedPagePayload (not a bare PageDoc) and PUT writes to
 * /api/share/:token/board — a different path from GET, unlike the
 * authenticated pair which both hang off /api/pages/:id.
 */
export interface BoardEndpointsInput {
  pageId: string;
  shareToken?: string;
}

export interface BoardEndpoints {
  /** GET this to load the board. */
  loadUrl: string;
  /** PUT { svg } here to save. Only ever called when the board is editable. */
  saveUrl: string;
}

export function getBoardEndpoints({ pageId, shareToken }: BoardEndpointsInput): BoardEndpoints {
  if (shareToken) {
    const token = encodeURIComponent(shareToken);
    return { loadUrl: `/api/share/${token}`, saveUrl: `/api/share/${token}/board` };
  }
  const id = encodeURIComponent(pageId);
  return { loadUrl: `/api/pages/${id}`, saveUrl: `/api/pages/${id}` };
}
