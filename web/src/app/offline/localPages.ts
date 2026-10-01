/**
 * Pages and boards created while the server could not be reached.
 *
 * A local page is a real page as far as this browser is concerned: it has
 * its final id (a ULID minted here — the server adopts it on sync, see
 * shared/contracts.ts `createPageBodySchema.id`), a row in the sidebar, a
 * URL, and an editor writing into a Y.Doc that y-indexeddb keeps on disk
 * (ydocPersistence.ts). What it does not have yet is a file on the server;
 * `syncEngine.ts` gives it one the moment the network is back.
 *
 * The registry is an in-memory mirror of the `pages` store, so the questions
 * the UI asks on every render ("is this id local?") are synchronous; the
 * store is only read once, at startup (`localPagesReady`).
 *
 * Only `doc` and `board` can be born offline. A table or a form needs the
 * server to mint more than one file, and an upload needs the bytes to land
 * somewhere — those stay online-only and say so.
 */
import { useSyncExternalStore } from 'react';
import { ulid } from 'ulidx';
import type { PageDoc, PageKind, PageMeta } from '@shared/contracts';
import { openStore, type KeyValueStore } from './db';

export type LocalPageKind = 'doc' | 'board';
export type LocalPageState = 'pending' | 'syncing' | 'failed';

export interface LocalPage {
  id: string;
  space: string;
  kind: LocalPageKind;
  title: string;
  /** Server directory the page is created in ('' = space root). Provisional while `parentId` is set. */
  parentPath: string;
  /** The parent page, when that parent is itself local: its real directory is only known once IT has synced. */
  parentId?: string;
  /** What the UI shows and nests by until the server assigns the real one. */
  path: string;
  createdAt: string;
  state: LocalPageState;
  /** Why the last sync attempt failed — a server refusal (403, space gone), never a plain network error. */
  error?: string;
  attempts: number;
}

export interface CreateLocalPageInput {
  space: string;
  parentPath: string;
  title: string;
  kind: LocalPageKind;
}

const EXTENSION: Record<LocalPageKind, string> = { doc: '.md', board: '.excalidraw.svg' };

export function offlineCreatableKind(kind: PageKind): kind is LocalPageKind {
  return kind === 'doc' || kind === 'board';
}

let store: KeyValueStore<LocalPage> = openStore<LocalPage>('pages', (page) => page.id);
const pages = new Map<string, LocalPage>();
const listeners = new Set<() => void>();
let snapshot: readonly LocalPage[] = [];
let ready: Promise<void> | null = null;

function publish(): void {
  snapshot = [...pages.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const listener of [...listeners]) listener();
}

/** Resolves once the registry has been read from storage. Safe to call any number of times. */
export function localPagesReady(): Promise<void> {
  ready ??= store
    .getAll()
    .then((stored) => {
      for (const page of stored) {
        // A tab that died mid-sync left this behind; the attempt is over either way.
        pages.set(page.id, page.state === 'syncing' ? { ...page, state: 'pending' } : page);
      }
      publish();
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.warn('[offline] could not read local pages:', error);
    });
  return ready;
}

export function isLocalPageId(id: string | undefined): boolean {
  return id !== undefined && pages.has(id);
}

export function getLocalPage(id: string): LocalPage | undefined {
  return pages.get(id);
}

export function listLocalPages(space?: string): readonly LocalPage[] {
  return space === undefined ? snapshot : snapshot.filter((page) => page.space === space);
}

export function subscribeLocalPages(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every local page, oldest first. Stable identity between changes — safe as a `useMemo`/effect dependency. */
export function useLocalPages(): readonly LocalPage[] {
  return useSyncExternalStore(
    subscribeLocalPages,
    () => snapshot,
    () => snapshot,
  );
}

export function useIsLocalPage(id: string | undefined): boolean {
  return useSyncExternalStore(
    subscribeLocalPages,
    () => isLocalPageId(id),
    () => false,
  );
}

/** `notes/plan.md` -> `notes/plan`: the directory a leaf page's children live in (the server's "X.md + X/" convention). */
export function childDirOfPath(path: string, kind: LocalPageKind): string {
  const ext = EXTENSION[kind];
  return path.endsWith(ext) ? path.slice(0, -ext.length) : path;
}

/**
 * A file-name-safe stand-in for the server's transliterating slug. It only
 * has to be stable and unique among local pages — the server mints the real
 * name on sync and the provisional one is never written anywhere.
 */
function provisionalSlug(title: string, taken: ReadonlySet<string>, dir: string, ext: string): string {
  const base =
    title
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'page';
  const at = (slug: string) => `${dir ? `${dir}/` : ''}${slug}${ext}`;
  if (!taken.has(at(base))) return at(base);
  for (let n = 2; ; n++) if (!taken.has(at(`${base}-${n}`))) return at(`${base}-${n}`);
}

export async function createLocalPage(input: CreateLocalPageInput, takenPaths: Iterable<string> = []): Promise<LocalPage> {
  await localPagesReady();
  const taken = new Set<string>([...takenPaths, ...[...pages.values()].map((page) => page.path)]);
  const parent = [...pages.values()].find(
    (page) => page.space === input.space && childDirOfPath(page.path, page.kind) === input.parentPath,
  );
  const page: LocalPage = {
    id: ulid(),
    space: input.space,
    kind: input.kind,
    title: input.title.trim() || 'Untitled',
    parentPath: input.parentPath,
    ...(parent ? { parentId: parent.id } : {}),
    path: provisionalSlug(input.title, taken, input.parentPath, EXTENSION[input.kind]),
    createdAt: new Date().toISOString(),
    state: 'pending',
    attempts: 0,
  };
  pages.set(page.id, page);
  publish();
  await store.put(page);
  return page;
}

export async function updateLocalPage(id: string, patch: Partial<Omit<LocalPage, 'id'>>): Promise<LocalPage | undefined> {
  const current = pages.get(id);
  if (!current) return undefined;
  const next: LocalPage = { ...current, ...patch };
  if (patch.error === undefined && 'error' in patch) delete next.error;
  if (patch.parentId === undefined && 'parentId' in patch) delete next.parentId;
  pages.set(id, next);
  publish();
  await store.put(next);
  return next;
}

export async function removeLocalPage(id: string): Promise<void> {
  if (!pages.delete(id)) return;
  publish();
  await store.delete(id);
}

/**
 * The author threw a local page away. Its local children go with it — they
 * were only ever reachable through it, and syncing them later would create
 * a directory on the server for a parent that never existed. Returns the
 * ids removed, so the caller can delete their Yjs copies too.
 */
export async function discardLocalPage(id: string): Promise<string[]> {
  const removed: string[] = [];
  const walk = async (pageId: string) => {
    for (const child of [...pages.values()]) if (child.parentId === pageId) await walk(child.id);
    if (pages.has(pageId)) {
      removed.push(pageId);
      await removeLocalPage(pageId);
    }
  };
  await walk(id);
  return removed;
}

export function localPageMeta(page: LocalPage): PageMeta {
  return {
    id: page.id,
    space: page.space,
    path: page.path,
    kind: page.kind,
    title: page.title,
    // Past every real sibling: a page made just now goes last (the owner's
    // own rule for «+», 22.09.2026), and no real order is this large.
    order: Number.MAX_SAFE_INTEGER,
    status: 'draft',
    updatedAt: page.createdAt,
  };
}

/** What `GET /api/pages/:id` would have answered. The body itself is in the Y.Doc, as for any live page. */
export function localPageDoc(page: LocalPage): PageDoc {
  return page.kind === 'doc' ? { ...localPageMeta(page), markdown: `# ${page.title}\n\n` } : { ...localPageMeta(page) };
}

/** Tests only: swap the store and forget everything in memory. */
export function resetLocalPagesForTests(next?: KeyValueStore<LocalPage>): void {
  store = next ?? openStore<LocalPage>('pages', (page) => page.id);
  pages.clear();
  ready = null;
  publish();
}
