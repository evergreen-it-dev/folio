import { AGENT_FOLDER, officeFormat, type TreeNode } from '@shared/contracts';
import type { TreeResponse } from '../api';

/** Directory containing a node's file (space-root files -> ""). Duplicated from markdown/resolvePath's dirOf to keep app/ and markdown/ independent modules. */
export function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function filenameStem(node: TreeNode): string {
  const base = node.path.split('/').pop() ?? '';
  if (node.kind === 'board' && base.endsWith('.excalidraw.svg')) return base.slice(0, -'.excalidraw.svg'.length);
  if (node.kind === 'table' && base.endsWith('.table.md')) return base.slice(0, -'.table.md'.length);
  if (node.kind === 'form' && base.endsWith('.form.md')) return base.slice(0, -'.form.md'.length);
  if (node.kind === 'pdf' && base.endsWith('.pdf')) return base.slice(0, -'.pdf'.length);
  if (node.kind === 'office') {
    const fmt = officeFormat(base);
    if (fmt) return base.slice(0, -(fmt.length + 1));
  }
  return base.replace(/\.md$/i, '');
}

/** Uses filenames only when sibling files would otherwise have identical visible H1 titles. */
export function treeNodeDisplayTitle(node: TreeNode, siblings: TreeNode[]): string {
  const normalized = node.title.trim().toLocaleLowerCase();
  const duplicate = siblings.some((other) => other.id !== node.id && other.title.trim().toLocaleLowerCase() === normalized);
  if (!duplicate) return node.title;
  const stem = filenameStem(node);
  return stem && stem.toLocaleLowerCase() !== 'index' && stem.toLocaleLowerCase() !== 'readme' ? stem : node.title;
}

/**
 * Normalizes the tree endpoint's two documented shapes (see DEV-PLAN: "index.md
 * of root maps to the space itself, expose as first node or as home") into one
 * flat list of top-level nodes:
 * - the whole space nested under a single `tree[0]` root-index node -> unwrap to its children;
 * - the root index as a separate `home` field, or omitted -> `tree` as-is, minus
 *   a stray literal "index.md" entry (the sidebar always shows its own
 *   explicit "space home" row above the tree, so it never needs to appear twice).
 */
export function getTopLevelNodes({ tree }: TreeResponse): TreeNode[] {
  if (tree.length === 1 && tree[0].kind === 'folder' && tree[0].path === '') {
    return tree[0].children;
  }
  if (tree.length === 1 && tree[0].path === 'index.md' && tree[0].children.length > 0) {
    return tree[0].children;
  }
  return tree.filter((n) => n.path !== 'index.md');
}

/**
 * The directory whose contents are this node's CHILDREN — the answer to
 * "where does a page created from this row's + button belong?".
 *
 * Mirrors server/storage.ts's own `childDirOf`/`relPathStem` (getSubtree),
 * which is the model `::pagetree`, exports and the folder listing all read:
 *
 *  - a directory index (`index.md`, or `README.md` where there is no
 *    index.md) IS its directory's page, so its children are that directory's
 *    other entries -> the containing directory;
 *  - a folder pseudo-node is its own directory;
 *  - any other page `<dir>/X.md` has `<dir>/X/` for its children — the
 *    "file next to a same-named directory" shape the server calls form (b).
 *
 * QA-3 P2 #6: TreeRow's create action was passing `dirname(node.path)` for
 * EVERY row, so "+ Add a page" on a leaf page created a SIBLING (at the
 * space root, for a root-level leaf) while the code around it — the mutation
 * literally named `createChild`, and an onSuccess that expanded the row as
 * if a child had appeared under it — claimed otherwise. There was no way to
 * give a leaf page a child through the UI at all.
 *
 * The `.excalidraw.svg` / `.table.md` / plain `.md` split mirrors the
 * server's `relPathStem` verbatim. Matching it is what makes a page and its
 * child directory resolve to the same tree node.
 */
export function childDirOf(node: TreeNode): string {
  if (node.kind === 'folder') return node.path;
  const dir = dirname(node.path);
  const base = dir ? node.path.slice(dir.length + 1) : node.path;
  if (base === 'index.md' || base === 'README.md') return dir;
  const officeFmt = node.kind === 'office' ? officeFormat(base) : undefined;
  const stem =
    node.kind === 'board' && base.endsWith('.excalidraw.svg')
      ? base.slice(0, -'.excalidraw.svg'.length)
      : node.kind === 'table' && base.endsWith('.table.md')
        ? base.slice(0, -'.table.md'.length)
        : node.kind === 'form' && base.endsWith('.form.md')
          ? base.slice(0, -'.form.md'.length)
          : node.kind === 'pdf' && base.endsWith('.pdf')
            ? base.slice(0, -'.pdf'.length)
            : officeFmt
              ? base.slice(0, -(officeFmt.length + 1))
              : base.replace(/\.md$/, '');
  return dir ? `${dir}/${stem}` : stem;
}

/**
 * The page that IS the space's front door, if there is one: `index.md` at the
 * space root, or — for a space made from an ordinary git repository —
 * `README.md`, which server/storage.ts treats as a directory's index whenever
 * that directory has no index.md of its own (see its getTree docblock).
 *
 * QA-3 P1 #2: `/s/<slug>` asks the server to resolve the literal path
 * `index.md`, and the server's own README fallback is built as
 * `${path}/README.md` — i.e. for `index.md` it looks for `index.md/README.md`
 * and 404s. Every space created from a real docs repo therefore rendered a
 * "space not found" screen while its tree sat right there in the sidebar.
 * The tree already knows the answer, so SpaceHome asks it instead of guessing.
 *
 * Deliberately root-only and deliberately not recursive: a README.md nested
 * somewhere deeper is that directory's index, not the space's.
 */
export function findSpaceRootPage({ tree, home }: TreeResponse): TreeNode | undefined {
  if (home && home.kind !== 'folder') return home;
  return tree.find((node) => node.kind !== 'folder' && (node.path === 'index.md' || node.path === 'README.md'));
}

/** Recursively finds a node by id. */
export function findNode(nodes: TreeNode[], id: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return undefined;
}

/**
 * Recursively finds a node by its space-relative path — used for folder
 * nodes (kind 'folder'), which have server-synthesized ids (e.g. "dir:...")
 * rather than real page ids, so the /s/:space/d/* route resolves them by
 * path instead. Walks the raw top-level array as given (not
 * getTopLevelNodes' UI-unwrapped view), so it finds a match regardless of
 * whether the server nests the whole tree under one root index node.
 */
export function findNodeByPath(nodes: TreeNode[], path: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    const found = findNodeByPath(node.children, path);
    if (found) return found;
  }
  return undefined;
}

/** The space-root folder name used as the source for "create from template" (round 5). Not a user-facing page — hidden from the tree, see excludeTemplatesFolder. */
export const TEMPLATES_FOLDER = '_templates';

/**
 * Drops the `_templates` top-level node (if any) from the tree the sidebar
 * renders — DEV-PLAN Round 5: "the _templates folder is hidden from the
 * normal tree". Takes the already-unwrapped `getTopLevelNodes()` view so it only
 * ever matches a *space-root* `_templates` folder, not a same-named page
 * nested somewhere deeper. SERVER may also filter this server-side
 * eventually (its own Round 5 item), but doesn't yet — this is the only
 * thing hiding it from the tree today.
 */
export function excludeTemplatesFolder(nodes: TreeNode[]): TreeNode[] {
  return nodes.filter((n) => n.path !== TEMPLATES_FOLDER);
}

/**
 * Drops the `.agent` top-level node (if any) from the normal tree — it gets
 * its own distinct section instead (Sidebar.tsx's AgentSection), admin-only
 * and never mixed in with ordinary pages (owner spec, 21.09.2026). A
 * non-admin's tree never has this node in the first place (server-side
 * filtering, auth/session.ts's readablePageIds); this is only needed so an
 * ADMIN doesn't see it twice.
 */
export function excludeAgentFolder(nodes: TreeNode[]): TreeNode[] {
  return nodes.filter((n) => n.path !== AGENT_FOLDER);
}

/** The space-root `.agent` folder node, if the tree has one (admin only — see excludeAgentFolder). Takes the raw top-level array, same as findNodeByPath. */
export function findAgentFolderNode(nodes: TreeNode[]): TreeNode | undefined {
  return findNodeByPath(nodes, AGENT_FOLDER);
}

/**
 * Candidate template pages: the direct doc-kind children of the space-root
 * `_templates` folder (also takes the unwrapped top-level view — same
 * reasoning as excludeTemplatesFolder). Not recursive: a template picker
 * showing a nested sub-tree is more than DEV-PLAN asks for ("pages from the
 * space's _templates/ folder"). Board/folder children are skipped — neither
 * is a text template {{...}} substitution can apply to.
 */
export function getTemplatePages(nodes: TreeNode[]): TreeNode[] {
  const folder = nodes.find((n) => n.path === TEMPLATES_FOLDER);
  if (!folder) return [];
  return folder.children.filter((n) => n.kind === 'doc');
}

/** All directories that currently contain at least one page, for the move dialog's parent picker (always includes "" for the space root). */
export function collectDirectories(nodes: TreeNode[]): string[] {
  const dirs = new Set<string>(['']);
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      dirs.add(dirname(node.path));
      walk(node.children);
    }
  };
  walk(nodes);
  return Array.from(dirs).sort((a, b) => a.localeCompare(b));
}

/**
 * Whether `node` is a "container" for the top-level «+» — owner spec
 * Whether `node` is a "container" for the top-level "+" — owner spec
 * (22.09.2026): "let it create the new entity at the end of the current list —
 * if I am at the root, the root's; if I am inside something, that something's". A container
 * is a synthetic folder node (always — even empty, since dropping/creating
 * into it just makes the directory, same reasoning as reorderPages.ts's own
 * `canContain`) or a directory index page (`index.md`/`README.md` — an
 * index page in an otherwise-empty directory still counts: it already IS
 * that directory, the same way `childDirOf` treats it below).
 *
 * `childDirOf(node) === dirname(node.path)` is true precisely for a folder
 * node (whose own path IS the directory) or an index page (whose filename
 * strips away to its own directory) — see childDirOf's doc comment — so
 * this reuses that existing check rather than re-deriving the index.md/
 * README.md filename rule a second time. (A plain leaf page's children.length
 * is irrelevant here on purpose: `dirname(leaf.path)` already equals
 * `childDirOf(leaf)`'s target for an index page either way, so gating on
 * "has children yet" would only ever be a no-op for the one node kind it
 * could apply to.)
 */
export function isContainerNode(node: TreeNode): boolean {
  return node.kind === 'folder' || childDirOf(node) === dirname(node.path);
}

/**
 * The directory the top-level «+» should create into, given a single node
 * (or none, at the space root/home). Pure so it's testable without the
 * tree's async fetch — see `resolvePlusTargetDir` below for the version that
 * also finds that node from the active page/folder.
 */
export function plusTargetDirFor(node: TreeNode | undefined): string {
  if (!node) return '';
  return isContainerNode(node) ? childDirOf(node) : dirname(node.path);
}

/**
 * Which directory the sidebar's top «+» (next to the space name, Sidebar.tsx)
 * targets, given what's currently open:
 *  - `activeFolderPath` set (viewing `/s/:space/d/*`) -> that folder IS the
 *    list being looked at, so it (or rather its OWN childDirOf, in case it's
 *    itself indexed by a page) is the target;
 *  - else `activeId` set (viewing `/s/:space/p/:id`) -> `plusTargetDirFor`
 *    of that page;
 *  - neither (space home/root) -> the space root, `""`.
 *
 * `tree` is the raw (possibly wrapped, see getTopLevelNodes) tree as the
 * `['tree', space]` query returns it — both `findNode`/`findNodeByPath`
 * already recurse into it regardless of wrapping.
 *
 * TreeRow's OWN row-level «+» deliberately does not call this — it always
 * creates into `childDirOf(node)` unconditionally, a different, narrower
 * question ("a child of THIS row") the owner asked to leave alone. Both
 * still go through the same `childDirOf`/`isContainerNode` primitives, so
 * the two can never quietly disagree about what a given node's own child
 * directory is.
 */
export function resolvePlusTargetDir(
  tree: TreeNode[],
  activeId: string | undefined,
  activeFolderPath: string | undefined,
): string {
  if (activeFolderPath !== undefined) {
    const node = findNodeByPath(tree, activeFolderPath);
    // A folder path with no matching node (shouldn't happen for a real,
    // still-open route) degrades to itself rather than silently falling
    // back to the root.
    return node ? plusTargetDirFor(node) : activeFolderPath;
  }
  if (activeId !== undefined) {
    const node = findNode(tree, activeId);
    return plusTargetDirFor(node);
  }
  return '';
}

/**
 * Finds, anywhere in `tree`, the node whose own children ARE directory
 * `dirPath` (a folder node, or a directory index page) — i.e. the sibling
 * array a page newly created in `dirPath` lands in. Falls back to
 * `getTopLevelNodes` for the space root, which (per that function's own doc
 * comment) may be wrapped under a single synthetic node instead of having
 * one of its own. Used by Sidebar.tsx to append a freshly-created page
 * LAST in its list, the same "into" semantics reorderPages.ts's
 * `computeDropPlan` already gives a drag-drop.
 */
export function siblingsAtDir(data: TreeResponse, dirPath: string): TreeNode[] {
  function find(nodes: TreeNode[]): TreeNode[] | undefined {
    for (const node of nodes) {
      if (childDirOf(node) === dirPath) return node.children;
      const found = find(node.children);
      if (found) return found;
    }
    return undefined;
  }
  return find(data.tree) ?? (dirPath === '' ? getTopLevelNodes(data) : []);
}
