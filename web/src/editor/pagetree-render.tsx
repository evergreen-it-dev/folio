/**
 * Adapter for the shared page-tree renderer.
 *
 * SHELL owns the real component in `web/src/markdown/` (reading mode renders the
 * same tree, fetching `GET /api/pages/:id/subtree?depth=N` itself), and
 * `web/src/markdown/index.tsx` re-exports it for exactly this import.
 *
 * The SWAP POINT this file documented is taken: until round 27 it rendered a
 * placeholder plaque, so live mode showed "⌸ Page tree" with no children
 * and no links while reading mode showed the real tree — the same directive
 * rendering two different things in two modes. This module stays as the seam
 * (the widget imports `PageTree` from here, not from another zone's index) but
 * carries no markup of its own any more.
 *
 * `pagetree.placeholder` is left in this zone's bundles: nothing reads it any
 * more, and deleting a string is churn this change does not need.
 */
export { PageTree } from '../markdown';
export type { PageTreeProps } from '../markdown';
